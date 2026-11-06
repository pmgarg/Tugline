/**
 * File tools. The four primitives of every coding agent (EAG S17 §3):
 * read a few files partially, edit by naming a place, run commands, loop.
 *
 *  - read_file is ranged and line-numbered ("reading everything is filling").
 *  - edit_file / multi_edit replace a unique anchor, matched by the tiered
 *    matcher (src/core/edit/match.ts, SPEC A1); they refuse edits to unread files
 *    or files changed since they were read, and never accept a fuzzy match.
 *  - apply_patch takes V4A patches for models trained on them (SPEC A7).
 *  - write_file creates files; overwriting needs a prior read, is capped by
 *    edit.wholeFileMaxLines and refuses "... existing code ..." placeholders (A5).
 *  - glob/grep find the few files that matter without loading their content.
 *
 * Every text read and write goes through ctx.host (SPEC S0.1): DiskHost for the
 * CLI and evals, the VS Code buffer host in the IDE (dirty buffers, undoable
 * WorkspaceEdits). The read ledger stores the host's version token.
 */
import { renderNotebook } from './notebook.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import { ToolError, type ToolContext, type ToolDef } from './types.js';
import { capOutput } from '../util/text.js';
import { diskHost, type HostText, type WorkspaceHost } from '../host/workspace.js';
import { applyEdit, applyEdits, EditMatchError, TIER_NOTES, TRUNCATION_MARKER, type MatchTier } from '../edit/match.js';
import { detect, findLazyPlaceholders, looksBinary, restoreBom, stripBom } from '../edit/text.js';
import { editConfig, type EditConfig } from '../edit/config.js';
import { clearFailures, failureCount, firstTime, noteFailure, recordRead, seenVersion } from '../edit/state.js';
import { afterEdit, runFormatter, snapshotDiagnostics } from '../edit/verify.js';
import { lspVerifies, verifyHost } from '../nav/diagnostics.js';
import { EDIT_FAMILIES, readModelStats, recordEditOutcome, resolveEditFormat, switchAdvice } from '../edit/routing.js';
import { parsePatch, patchPaths, planPatch, PatchError, type PlannedChange } from '../edit/applyPatch.js';
import { runApplyModel } from '../edit/applyModel.js';
import { scrubbedEnv } from './shell.js';
import { isInside, realResolve } from '../permissions/policy.js';

export const DEFAULT_IGNORES = ['node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.next', 'target', '.mypy_cache', '.pytest_cache', '.cache', 'coverage', '.idea', '.gradle'];

/** read_file shows lines in full up to this many characters (SPEC A2). */
export const MAX_LINE_CHARS = 20_000;

export function resolvePath(ctx: Pick<ToolContext, 'workspace'>, p: string): string {
  if (!p || typeof p !== 'string') throw new ToolError('path is required');
  let s = p.trim();
  if (s.startsWith('~/')) s = path.join(process.env.HOME ?? '', s.slice(2));
  return path.resolve(ctx.workspace, s);
}

export function rel(ctx: Pick<ToolContext, 'workspace'>, abs: string): string {
  const r = path.relative(ctx.workspace, abs);
  return r.startsWith('..') ? abs : r.split(path.sep).join('/') || '.';
}

function isBinary(buf: Buffer): boolean {
  return looksBinary(buf);
}

function hostOf(ctx: Partial<Pick<ToolContext, 'host'>>): WorkspaceHost {
  return ctx.host ?? diskHost;
}

/** A6's host for `abs`: the context's host, plus a configured language server's diagnostics in the CLI (N3 AC5). */
function verifyHostOf(ctx: ToolContext, abs: string): WorkspaceHost {
  return ctx.config && lspVerifies(ctx.config, abs, ctx.workspace) ? verifyHost(ctx) : hostOf(ctx);
}

function cfgOf(ctx: ToolContext): EditConfig {
  return editConfig(ctx.config);
}

/** C5 seam: WS3's ignore files hide paths from glob, grep and list_dir. Optional until WS3 merges. */
function hiddenFilter(ctx: ToolContext): ((abs: string) => boolean) | undefined {
  const p = ctx.policy as unknown as { isHidden?: (abs: string) => boolean } | undefined;
  return typeof p?.isHidden === 'function' ? (abs) => !!p.isHidden!(abs) : undefined;
}

const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// ------------------------------------------------------------ loading through the host

interface Loaded {
  /** text as stored (BOM included) */
  raw: string;
  /** BOM-stripped text: what matching and display use */
  text: string;
  bom: boolean;
  version: string;
  host: HostText;
}

async function loadText(ctx: ToolContext, abs: string, display: string): Promise<Loaded | undefined> {
  const h = await hostOf(ctx).readText(abs);
  if (!h) return undefined;
  const { text } = stripBom(h.text);
  // TextDecoder (DiskHost) drops a UTF-8 BOM from the text, so also look at the bytes.
  const b = h.bytes;
  const bom = h.text.startsWith('\uFEFF') || (!!b && b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf);
  return { raw: restoreBom(text, bom), text, bom, version: h.version, host: h };
}

/** A2: refuse to edit what cannot be round-tripped. */
function assertEditable(l: Loaded, display: string): void {
  if (l.host.bytes ? isBinary(Buffer.from(l.host.bytes)) : l.text.includes('\u0000')) throw new ToolError(`${display} is a binary file; it cannot be edited as text.`);
  if (l.host.utf8 === false)
    throw new ToolError(`${display} is not valid UTF-8 (it looks like Latin-1, UTF-16 or another legacy encoding). Editing it as text would corrupt it. Convert it first (e.g. \`iconv -f latin1 -t utf-8\`) or change it with a script that preserves its encoding.`);
}

function syncDisk(ctx: ToolContext): boolean {
  return hostOf(ctx).kind === 'disk';
}

/** Read-before-edit (EAG S17) with the host version token; sync variant for validate() on disk. */
function requireFreshReadSync(ctx: ToolContext, abs: string, display: string): void {
  if (!ctx.ledger.has(abs)) throw new ToolError(`cannot edit ${display} before reading it. Read the file first: editing from memory rewrites code you never saw.`);
  if (!syncDisk(ctx)) return;
  let cur: number;
  try {
    cur = fs.statSync(abs).mtimeMs;
  } catch {
    return;
  }
  const seen = seenVersion(ctx.ledger, abs);
  const stale = seen !== undefined ? seen !== String(cur) : Math.abs(cur - (ctx.ledger.mtime(abs) ?? cur)) > 1;
  if (stale) throw new ToolError(`${display} changed on disk since you read it (edited by the user or another process). Read it again before editing.`);
}

function requireFreshRead(ctx: ToolContext, abs: string, display: string, version: string): void {
  if (!ctx.ledger.has(abs)) throw new ToolError(`cannot edit ${display} before reading it. Read the file first: editing from memory rewrites code you never saw.`);
  const seen = seenVersion(ctx.ledger, abs);
  let stale: boolean;
  if (seen !== undefined) stale = seen !== version;
  else {
    const n = Number(version);
    const m = ctx.ledger.mtime(abs);
    stale = Number.isFinite(n) && m !== undefined && Math.abs(n - m) > 1;
  }
  if (stale) throw new ToolError(`${display} changed ${syncDisk(ctx) ? 'on disk ' : ''}since you read it (edited by the user or another process). Read it again before editing.`);
}

/**
 * N36 (Qwen parity: its file worker writes inside the sandbox): the target is resolved again at write time, so a
 * path that was swapped for a symlink while an approval was pending (or a job ran) cannot carry the write out of
 * the workspace. The permission check saw the path as it was then; this sees it as it is now.
 * Review finding 10: when the path now resolves somewhere else, the full permission check runs again on the
 * resolved target (protected paths, agent-control files, deny rules): an approved `src/pre-commit` whose `src` became
 * a link to `.git/hooks` is refused. On every host: an editor (VS Code, an ACP client's fs/write_text_file) would
 * follow the link too, so the path is checked here before it is handed over.
 */
function confineAtWrite(ctx: ToolContext, abs: string, tool = 'write_file'): void {
  const real = realResolve(abs);
  const roots = [ctx.workspace, ...ctx.config.permissions.additionalDirectories].map((r) => realResolve(r));
  if (!roots.some((r) => isInside(real, r))) throw new ToolError(`refused at write time: ${abs} now resolves to ${real}, outside the workspace (a path component changed after the permission check). Nothing was written.`);
  if (real === path.resolve(abs) || !ctx.policy) return;
  const was = ctx.policy.check({ tool, kind: 'edit', paths: [{ path: abs, write: true }] });
  const now = ctx.policy.check({ tool, kind: 'edit', paths: [{ path: real, write: true }] });
  const worse = now.decision === 'deny' || (now.decision === 'ask' && (was.decision === 'allow' || now.reason !== was.reason));
  if (worse) throw new ToolError(`refused at write time: ${path.relative(ctx.workspace, abs) || abs} now resolves to ${path.relative(ctx.workspace, real) || real}, which ${now.decision === 'deny' ? 'is refused' : 'needs its own approval'} (${now.reason}). A path component changed after the permission check; nothing was written.`);
}

async function commit(ctx: ToolContext, abs: string, text: string, label: string): Promise<string> {
  confineAtWrite(ctx, abs);
  const { version } = await hostOf(ctx).writeText(abs, text, { label });
  recordRead(ctx.ledger, abs, version);
  return version;
}

// ------------------------------------------------------------ read_file

export const readFileTool: ToolDef<{ path: string; offset?: number; limit?: number }> = {
  name: 'read_file',
  kind: 'read',
  readOnly: true,
  description:
    'Read a text file (or image) from the filesystem. Returns lines prefixed with line numbers ("  12\\t..."). ' +
    'By default reads up to 2000 lines from the start; for large files pass offset (1-based line) and limit. ' +
    'Prefer grep/glob to locate code first and read only the relevant range. You must read a file before editing it. ' +
    'The line-number prefix is NOT part of the file content — never include it in edit_file old_string.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute' },
      offset: { type: 'integer', description: '1-based line number to start from' },
      limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000)' },
    },
    required: ['path'],
  },
  title: (a) => `Read ${a.path}${a.offset ? `:${a.offset}` : ''}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path), write: false }] }),
  async run(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    const host = hostOf(ctx);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      /* not on disk: the host may still have it (unsaved buffer) */
    }
    if (isDir) throw new ToolError(`${a.path} is a directory; use list_dir or glob`);
    const ext = path.extname(abs).toLowerCase();
    if (IMAGE_EXT[ext] && fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      recordRead(ctx.ledger, abs, String(st.mtimeMs));
      if (!ctx.vision) return { output: `${a.path} is an image (${st.size} bytes). The current model has no vision support, so its pixels cannot be shown.` };
      return { output: `Image ${a.path} (${st.size} bytes) attached.`, images: [{ mimeType: IMAGE_EXT[ext], base64: fs.readFileSync(abs).toString('base64') }] };
    }
    try {
      if (fs.statSync(abs).size > 20 * 1024 * 1024) throw new ToolError(`${a.path} is ${Math.round(fs.statSync(abs).size / 1e6)} MB; too large. Use grep to find the relevant part.`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    const l = await loadText(ctx, abs, a.path);
    if (!l) {
      const dir = path.dirname(abs);
      const near = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().includes(path.basename(abs).toLowerCase().slice(0, 4))).slice(0, 5) : [];
      throw new ToolError(`file not found: ${a.path}${near.length ? `. Similar files in ${rel(ctx, dir)}: ${near.join(', ')}` : ''}`);
    }
    if (l.host.bytes ? isBinary(Buffer.from(l.host.bytes)) : l.text.includes('\u0000')) throw new ToolError(`${a.path} appears to be a binary file (${l.host.bytes?.length ?? l.text.length} bytes)`);
    // Notebooks (SPEC D11): show cells with indices for notebook_edit, unless a raw line range was asked for.
    if (ext === '.ipynb' && a.offset === undefined && a.limit === undefined) {
      try {
        const rendered = renderNotebook(l.text);
        recordRead(ctx.ledger, abs, l.version);
        return { output: `${rendered}

[notebook rendered by cell; edit cells with notebook_edit (cell_index), or read_file with offset/limit for the raw JSON]`, meta: { notebook: true } };
      } catch {
        /* not valid notebook JSON: fall through to raw text */
      }
    }
    const lines = l.text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const start = Math.max(1, Math.floor(a.offset ?? 1));
    const limit = Math.max(1, Math.floor(a.limit ?? 2000));
    const end = Math.min(lines.length, start + limit - 1);
    recordRead(ctx.ledger, abs, l.version);
    if (lines.length === 0) return { output: `(${a.path} is empty)`, meta: { totalLines: 0 } };
    if (start > lines.length) throw new ToolError(`offset ${start} is past the end of the file (${lines.length} lines)`);
    let truncated = 0;
    const body = lines
      .slice(start - 1, end)
      .map((ln, i) => {
        if (ln.length <= MAX_LINE_CHARS) return `${String(start + i).padStart(6)}\t${ln}`;
        truncated++;
        return `${String(start + i).padStart(6)}\t${ln.slice(0, MAX_LINE_CHARS)}${TRUNCATION_MARKER}: ${ln.length} chars; the rest is not shown and cannot be used as an edit anchor]`;
      })
      .join('\n');
    const notes: string[] = [];
    if (end < lines.length) notes.push(`[showing lines ${start}-${end} of ${lines.length}; pass offset=${end + 1} to read more]`);
    const info = detect(l.text);
    if (info.eol === 'crlf') notes.push('[file uses CRLF line endings; write plain \\n in edits, they are converted]');
    else if (info.eol === 'mixed') notes.push('[file has mixed CRLF/LF line endings; write plain \\n in edits, each region keeps its own]');
    if (truncated) notes.push(`[${truncated} line(s) longer than ${MAX_LINE_CHARS} chars were truncated; anchor edits on another part of the file, or use bash (e.g. cut, sed) to change them]`);
    if (l.host.utf8 === false) notes.push('[file is not valid UTF-8; shown lossily, and edit tools will refuse to modify it]');
    return { output: body + (notes.length ? `\n\n${notes.join('\n')}` : ''), meta: { totalLines: lines.length, start, end } };
  },
};

// ------------------------------------------------------------ anchored edits

/**
 * v0.1 API kept for callers and tests: apply one anchored edit to a string.
 * Throws ToolError ("not found", "appears N times", …). BOM is preserved.
 */
export function applyAnchoredEdit(content: string, oldS: string, newS: string, replaceAll: boolean, file: string): { updated: string; replaced: number; tier: MatchTier } {
  const { text, bom } = stripBom(content);
  try {
    const r = applyEdit(text, oldS, newS, { replaceAll, file });
    return { updated: restoreBom(r.updated, bom), replaced: r.count, tier: r.tier };
  } catch (e) {
    if (e instanceof EditMatchError) throw new ToolError(e.message);
    throw e;
  }
}

function diffStat(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  return `lines ${s + 1}-${eb + 1} (−${Math.max(0, ea - s + 1)} +${Math.max(0, eb - s + 1)})`;
}

interface EditSpec {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function lineCount(text: string): number {
  return text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
}

/** Outcome bookkeeping: stats file (A7) and the one-shot routing notice. */
function recordOutcome(ctx: ToolContext, tool: string, ok: boolean): void {
  const cfg = cfgOf(ctx);
  if (!cfg.recordStats) return;
  const model = ctx.llm?.profile?.model;
  recordEditOutcome(ctx.config?.homeDir, model, tool, ok);
  if (model && ctx.config?.homeDir && ctx.emit && firstTime(ctx.ledger, 'routing-advice')) {
    const advice = switchAdvice(readModelStats(ctx.config.homeDir), model);
    if (advice) ctx.emit({ type: 'notice', level: 'info', message: advice });
  }
}

/** Match failure → message with candidates, plus the A5 whole-file suggestion after 2 failures. */
function failureMessage(ctx: ToolContext, abs: string, display: string, err: EditMatchError, text: string): string {
  let msg = err.message;
  const n = failureCount(ctx.ledger, abs);
  const cfg = cfgOf(ctx);
  const lines = lineCount(text);
  if (n >= 2 && err.fail.reason !== 'invalid' && (cfg.wholeFileMaxLines === 0 || lines <= cfg.wholeFileMaxLines))
    msg += `\nThis is failed anchor #${n} on ${display}, which has ${lines} lines: you may instead rewrite the whole file with write_file (include EVERY line; placeholders such as "... existing code ..." are refused).`;
  return msg;
}

function matchFailure(ctx: ToolContext, tool: string, abs: string, display: string, err: EditMatchError, text: string): ToolError {
  if (err.fail.reason !== 'invalid') {
    noteFailure(ctx.ledger, abs);
    recordOutcome(ctx, tool, false);
  }
  return new ToolError(failureMessage(ctx, abs, display, err, text));
}

function normEdits(a: { edits?: unknown }): EditSpec[] {
  const e = a.edits;
  if (!Array.isArray(e) || !e.length) throw new ToolError('edits must be a non-empty array of {old_string, new_string, replace_all?}');
  return e.map((x, i) => {
    if (!x || typeof x !== 'object') throw new ToolError(`edits[${i}] must be an object with old_string and new_string`);
    const o = x as Record<string, unknown>;
    if (typeof o.old_string !== 'string' || typeof o.new_string !== 'string') throw new ToolError(`edits[${i}] needs string old_string and new_string`);
    return { old_string: o.old_string, new_string: o.new_string, replace_all: o.replace_all === true || o.replace_all === 'true' };
  });
}

function runMatch(text: string, edits: EditSpec[], display: string) {
  if (edits.length === 1) {
    const r = applyEdit(text, edits[0].old_string, edits[0].new_string, { replaceAll: !!edits[0].replace_all, file: display });
    return { updated: r.updated, results: [{ count: r.count, tier: r.tier, tiers: r.tiers, startLine: r.spans[0].startLine, endLine: r.spans[r.spans.length - 1].endLine }] };
  }
  return applyEdits(text, edits, { file: display });
}

/** validate(): cheap synchronous checks before the user is asked (disk host only for content checks). */
function validateEdits(ctx: ToolContext, tool: string, p: string, edits: EditSpec[]): void {
  const abs = resolvePath(ctx, p);
  if (syncDisk(ctx) && !fs.existsSync(abs)) throw new ToolError(`file not found: ${p}. Use write_file to create it.`);
  requireFreshReadSync(ctx, abs, p);
  if (!syncDisk(ctx) || cfgOf(ctx).applyModel) return; // async host or apply-model rescue: run() decides
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) throw new ToolError(`${p} is a binary file; it cannot be edited as text.`);
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new ToolError(`${p} is not valid UTF-8 (it looks like Latin-1, UTF-16 or another legacy encoding). Editing it as text would corrupt it. Convert it first (e.g. \`iconv -f latin1 -t utf-8\`) or change it with a script that preserves its encoding.`);
  }
  const { text } = stripBom(raw);
  try {
    runMatch(text, edits, p);
  } catch (e) {
    if (e instanceof EditMatchError) throw matchFailure(ctx, tool, abs, p, e, text);
    throw e;
  }
}

async function previewEdits(ctx: ToolContext, p: string, edits: EditSpec[]) {
  const abs = resolvePath(ctx, p);
  const l = await loadText(ctx, abs, p);
  if (!l) return undefined;
  try {
    return { path: abs, before: l.raw, after: restoreBom(runMatch(l.text, edits, p).updated, l.bom) };
  } catch {
    return undefined;
  }
}

/** Shared body of edit_file and multi_edit. */
async function runEdits(ctx: ToolContext, tool: 'edit_file' | 'multi_edit', p: string, edits: EditSpec[]) {
  const abs = resolvePath(ctx, p);
  const l = await loadText(ctx, abs, p);
  if (!l) throw new ToolError(`file not found: ${p}. Use write_file to create it.`);
  requireFreshRead(ctx, abs, p, l.version);
  assertEditable(l, p);
  const cfg = cfgOf(ctx);
  let updated: string;
  let summary: string;
  let tiers: MatchTier[] = [];
  let via = '';
  try {
    const r = runMatch(l.text, edits, p);
    updated = r.updated;
    tiers = [...new Set(r.results.flatMap((x) => x.tiers))].filter((t) => t !== 'exact');
    const count = r.results.reduce((s, x) => s + x.count, 0);
    summary = tool === 'edit_file' ? `replaced ${count} occurrence(s), ${diffStat(l.text, updated)}` : `applied ${edits.length} edit(s) (${count} replacement(s)), ${diffStat(l.text, updated)}`;
  } catch (e) {
    if (!(e instanceof EditMatchError)) throw e;
    const err = matchFailure(ctx, tool, abs, p, e, l.text);
    // A8: after two failed anchors on this file, an apply model may merge new_string as a snippet.
    if (!(cfg.applyModel && e.fail.reason === 'not_found' && failureCount(ctx.ledger, abs) >= 2)) throw err;
    const idx = Number(/edit #(\d+)/.exec(e.message)?.[1] ?? 1) - 1;
    const failed = edits[Math.max(0, Math.min(edits.length - 1, idx))];
    const applied = await runApplyModel(ctx.config, cfg.applyModel, { path: abs, original: l.text, snippet: failed.new_string, instruction: `Replace the code that resembles this (it may be slightly misquoted):\n${failed.old_string}\nwith the update.` }, ctx.signal);
    if (!applied.ok) throw new ToolError(`${err.message}\n(The apply model could not rescue it: ${applied.reason}.)`);
    if (edits.length > 1) throw new ToolError(`${err.message}\n(Apply-model rescue only handles single edits; send the remaining edits separately.)`);
    updated = applied.text;
    summary = `old_string did not match, so the apply model (${applied.model}) merged new_string into the file: ${diffStat(l.text, updated)}. Check the result below carefully`;
    via = 'apply_model';
  }
  const pre = cfg.verify ? await snapshotDiagnostics(verifyHostOf(ctx, abs), abs) : undefined;
  await commit(ctx, abs, restoreBom(updated, l.bom), `${tool} ${p}`);
  clearFailures(ctx.ledger, abs);
  if (!via) recordOutcome(ctx, tool, true);
  const finalText = await formatAndReread(ctx, abs, updated);
  const notes: string[] = [];
  if (tiers.length) notes.push(`Note: old_string ${tiers.map((t) => TIER_NOTES[t]).join('; then ')}. Copy anchors exactly next time.`);
  if (finalText.note) notes.push(finalText.note);
  const feedback = cfg.verify ? await afterEdit(abs, l.text, finalText.text, verifyHostOf(ctx, abs), { preDiagnostics: pre, waitMs: cfg.diagnosticsWaitMs }) : '';
  return {
    output: [`Edited ${p}: ${summary}.`, ...notes, feedback].filter(Boolean).join('\n'),
    meta: { changedFile: abs, before: l.raw, after: restoreBom(finalText.text, l.bom), editTier: tiers[tiers.length - 1] ?? (via || 'exact'), editTiers: tiers, editTool: tool },
  };
}

/** A6.3: optional formatter; re-read so the next anchors match what is on disk. */
async function formatAndReread(ctx: ToolContext, abs: string, text: string): Promise<{ text: string; note: string }> {
  const fmt = cfgOf(ctx).format;
  if (!fmt || !Object.keys(fmt).length) return { text, note: '' };
  await hostOf(ctx).flushForShell?.().catch(() => undefined);
  const note = await runFormatter(abs, ctx.workspace, fmt, scrubbedEnv(ctx.config.shell?.scrubEnv ?? []));
  if (!note) return { text, note: '' };
  const l = await loadText(ctx, abs, abs);
  if (!l) return { text, note };
  recordRead(ctx.ledger, abs, l.version);
  return { text: l.text, note };
}

const EDIT_GUIDANCE =
  'old_string must name exactly ONE place (include 2-3 unchanged lines around the change). Prefer replacing whole statements or blocks over single tokens; never include read_file line-number prefixes. ' +
  'Line endings (CRLF), BOM, trailing whitespace, typographic quotes, a uniform indentation shift and over-escaped \\n are tolerated and reported, but the words and line order must match. ' +
  'On success the result shows the edited region with line numbers, so you do not need to re-read the file.';

export const editFileTool: ToolDef<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: 'edit_file',
  kind: 'edit',
  description:
    'Edit a file by replacing an exact string. ' + EDIT_GUIDANCE + ' You must read_file the file in this session before editing it. ' +
    'Use replace_all=true to change every occurrence (e.g. renaming a variable). For several changes to one file use multi_edit. To create a new file use write_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit' },
      old_string: { type: 'string', description: 'Exact existing text to replace (without line-number prefixes)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  title: (a) => `Edit ${a.path}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path), write: true }] }),
  validate(a, ctx) {
    validateEdits(ctx, 'edit_file', a.path, [{ old_string: String(a.old_string ?? ''), new_string: String(a.new_string ?? ''), replace_all: !!a.replace_all }]);
  },
  async preview(a, ctx) {
    return previewEdits(ctx, a.path, [{ old_string: String(a.old_string ?? ''), new_string: String(a.new_string ?? ''), replace_all: !!a.replace_all }]);
  },
  async run(a, ctx) {
    return runEdits(ctx, 'edit_file', a.path, [{ old_string: String(a.old_string ?? ''), new_string: String(a.new_string ?? ''), replace_all: !!a.replace_all }]);
  },
};

export const multiEditTool: ToolDef<{ path: string; edits: EditSpec[]; edit_block_error?: string }> = {
  name: 'multi_edit',
  kind: 'edit',
  description:
    'Make several edits to ONE file in a single call. Edits apply in order, each to the result of the previous ones, and atomically: if any edit fails, nothing is written and the error names the failing edit. ' +
    'Prefer one multi_edit per file (edits in file order) over several edit_file calls. Each edit follows the edit_file rules: ' + EDIT_GUIDANCE,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to edit' },
      edits: {
        type: 'array',
        description: 'Edits to apply in order',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Exact existing text to replace' },
            new_string: { type: 'string', description: 'Replacement text' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path', 'edits'],
  },
  title: (a) => `Edit ${a.path} (${Array.isArray(a.edits) ? a.edits.length : 0} edits)`,
  permissionInput: (a, ctx) => (a.edit_block_error ? {} : { paths: [{ path: resolvePath(ctx, a.path), write: true }] }),
  validate(a, ctx) {
    // A malformed <edit> block (text tool mode) arrives as an error to report, not an edit.
    if (a.edit_block_error) throw new ToolError(a.edit_block_error);
    validateEdits(ctx, 'multi_edit', a.path, normEdits(a));
  },
  async preview(a, ctx) {
    if (a.edit_block_error) return undefined;
    return previewEdits(ctx, a.path, normEdits(a));
  },
  async run(a, ctx) {
    if (a.edit_block_error) throw new ToolError(a.edit_block_error);
    return runEdits(ctx, 'multi_edit', a.path, normEdits(a));
  },
};

// ------------------------------------------------------------ write_file

function placeholderError(display: string, hits: string[]): ToolError {
  return new ToolError(
    `refusing to write ${display}: the content contains placeholder line(s) standing for code you did not write out (${hits.map((h) => `"${h}"`).join(', ')}). ` +
      'Writing them would delete that code. Write the complete content, or change the file with edit_file/multi_edit.',
  );
}

function wholeFileLimit(ctx: ToolContext, display: string, existingText: string): void {
  const max = cfgOf(ctx).wholeFileMaxLines;
  if (!max || resolveEditFormat(ctx.config) === 'whole') return;
  const n = lineCount(existingText);
  if (n > max) throw new ToolError(`${display} has ${n} lines; write_file may only overwrite existing files up to ${max} lines (edit.wholeFileMaxLines). Change it with edit_file/multi_edit instead.`);
}

export const writeFileTool: ToolDef<{ path: string; content: string }> = {
  name: 'write_file',
  kind: 'edit',
  description:
    'Create a new file (parent directories are created) or completely overwrite an existing one. ' +
    'Overwriting an existing file requires that you read it first in this session and is allowed for files up to a size limit (default 400 lines); prefer edit_file/multi_edit for changes to existing files. ' +
    'Always write the COMPLETE content: placeholder lines such as "// ... existing code ..." are refused.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  title: (a) => `Write ${a.path}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path), write: true }] }),
  validate(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    const content = typeof a.content === 'string' ? a.content : JSON.stringify(a.content, null, 2);
    if (syncDisk(ctx) && fs.existsSync(abs)) {
      if (fs.statSync(abs).isDirectory()) throw new ToolError(`${a.path} is a directory`);
      requireFreshReadSync(ctx, abs, a.path);
      let original = '';
      try {
        original = stripBom(fs.readFileSync(abs, 'utf8')).text;
      } catch {
        /* run() reports */
      }
      wholeFileLimit(ctx, a.path, original);
      const hits = findLazyPlaceholders(content, original);
      if (hits.length && !cfgOf(ctx).applyModel) throw placeholderError(a.path, hits);
    } else if (syncDisk(ctx)) {
      const hits = findLazyPlaceholders(content, '');
      if (hits.length) throw placeholderError(a.path, hits);
    }
    // other hosts: existence, freshness and placeholders are checked in run()
  },
  async preview(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    const l = await loadText(ctx, abs, a.path);
    return { path: abs, before: l?.raw ?? '', after: String(a.content ?? '') };
  },
  async run(a, ctx) {
    const abs = resolvePath(ctx, a.path);
    let content = typeof a.content === 'string' ? a.content : JSON.stringify(a.content, null, 2);
    try {
      if (fs.statSync(abs).isDirectory()) throw new ToolError(`${a.path} is a directory`);
    } catch (e) {
      if (e instanceof ToolError) throw e;
    }
    const cfg = cfgOf(ctx);
    const l = await loadText(ctx, abs, a.path);
    const existed = !!l;
    let before = '';
    let note = '';
    if (l) {
      requireFreshRead(ctx, abs, a.path, l.version);
      assertEditable(l, a.path);
      before = l.raw;
      wholeFileLimit(ctx, a.path, l.text);
      if (content.includes('�') && !l.text.includes('�')) throw new ToolError(`refusing to write ${a.path}: the content contains U+FFFD replacement characters (a decoding error), which would corrupt the file.`);
      const hits = findLazyPlaceholders(content, l.text);
      if (hits.length) {
        if (!cfg.applyModel) throw placeholderError(a.path, hits);
        // A8: a lazy whole-file write becomes a snippet for the apply model.
        const r = await runApplyModel(ctx.config, cfg.applyModel, { path: abs, original: l.text, snippet: stripBom(content).text }, ctx.signal);
        if (!r.ok) throw new ToolError(`${placeholderError(a.path, hits).message}\n(The apply model could not merge it: ${r.reason}.)`);
        content = r.text;
        note = `The content had placeholder lines, so the apply model (${r.model}) merged it into the existing file. Check the result.`;
      }
      // Keep the file's encoding conventions (A2): BOM, CRLF and final newline.
      const info = { ...detect(l.raw), bom: l.bom };
      content = stripBom(content).text;
      if (info.eol === 'crlf' && !content.includes('\r')) content = content.replace(/\n/g, '\r\n');
      if (info.finalNewline && content && !content.endsWith('\n')) content += info.eol === 'crlf' ? '\r\n' : '\n';
      else if (!info.finalNewline && l.text && content.endsWith('\n')) content = content.replace(/\r?\n$/, '');
      content = restoreBom(content, info.bom);
    } else {
      const hits = findLazyPlaceholders(content, '');
      if (hits.length) throw placeholderError(a.path, hits);
    }
    const pre = cfg.verify && existed ? await snapshotDiagnostics(verifyHostOf(ctx, abs), abs) : undefined;
    await commit(ctx, abs, content, `write_file ${a.path}`);
    clearFailures(ctx.ledger, abs);
    const final = await formatAndReread(ctx, abs, stripBom(content).text);
    const lines = content.split('\n').length;
    let feedback = '';
    if (cfg.verify) {
      feedback = await afterEdit(abs, stripBom(before).text, final.text, verifyHostOf(ctx, abs), { preDiagnostics: pre, waitMs: cfg.diagnosticsWaitMs, snippet: false });
    }
    return {
      output: [`${existed ? 'Overwrote' : 'Created'} ${a.path} (${lines} lines, ${Buffer.byteLength(content)} bytes).`, note, final.note, feedback].filter(Boolean).join('\n'),
      meta: { changedFile: abs, before, after: content, created: !existed, editTool: 'write_file', editTier: note ? 'apply_model' : 'whole' },
    };
  },
};

// ------------------------------------------------------------ apply_patch (V4A, SPEC A7)

function patchText(a: { input?: string; patch?: string }): string {
  const t = typeof a.input === 'string' ? a.input : typeof a.patch === 'string' ? a.patch : '';
  if (!t.trim()) throw new ToolError('input is required: the full patch text from "*** Begin Patch" to "*** End Patch"');
  return t;
}

export const applyPatchTool: ToolDef<{ input: string; patch?: string }> = {
  name: 'apply_patch',
  kind: 'edit',
  description: [
    'Edit files with a patch. The input is the whole patch, in this format:',
    '*** Begin Patch',
    '*** Update File: path/to/file.py',
    '@@ def existing_function():',
    ' unchanged context line',
    '-line to remove',
    '+line to add',
    '*** Add File: path/to/new.py',
    '+every line of the new file, each prefixed with +',
    '*** Delete File: path/to/old.py',
    '*** End Patch',
    'Rules: no line numbers. Context lines start with a space, removed lines with -, added lines with +. Use @@ <line> to name the class/function a hunk is in when the context is not unique; hunks of one file go in file order. ',
    '"*** Move to: new/path" right after an Update File header renames the file. You must read a file before updating or deleting it. The patch is applied atomically: if any hunk fails nothing is written. ',
    'On success you get the changed regions, so you do not need to re-read files.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: { input: { type: 'string', description: 'The entire patch, from *** Begin Patch to *** End Patch' } },
    required: ['input'],
  },
  title: (a) => {
    const paths = patchPaths(String(a.input ?? a.patch ?? ''), (p) => p);
    return `Patch ${paths.length ? paths.slice(0, 3).join(', ') + (paths.length > 3 ? ', …' : '') : ''}`.trim();
  },
  permissionInput: (a, ctx) => ({ paths: patchPaths(String(a.input ?? a.patch ?? ''), (p) => resolvePath(ctx, p)).map((p) => ({ path: p, write: true })) }),
  validate(a, ctx) {
    let hunks;
    try {
      hunks = parsePatch(patchText(a));
    } catch (e) {
      if (e instanceof PatchError) {
        recordOutcome(ctx, 'apply_patch', false);
        throw new ToolError(e.message);
      }
      throw e;
    }
    if (!hunks.length) throw new ToolError('No files were modified.');
    for (const h of hunks) {
      const abs = resolvePath(ctx, h.path);
      if (h.kind !== 'add' && syncDisk(ctx) && fs.existsSync(abs)) requireFreshReadSync(ctx, abs, h.path);
      if (h.kind === 'add' && syncDisk(ctx) && fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) requireFreshReadSync(ctx, abs, h.path);
    }
  },
  async preview(a, ctx) {
    try {
      const changes = await planPatch(parsePatch(patchText(a)), (p) => resolvePath(ctx, p), patchFs(ctx));
      const c = changes[0];
      return c ? { path: c.path, before: c.before ?? '', after: c.after ?? '' } : undefined;
    } catch {
      return undefined;
    }
  },
  async run(a, ctx) {
    let changes: PlannedChange[];
    const versions = new Map<string, string>();
    try {
      changes = await planPatch(parsePatch(patchText(a)), (p) => resolvePath(ctx, p), patchFs(ctx, versions));
    } catch (e) {
      if (e instanceof PatchError) {
        recordOutcome(ctx, 'apply_patch', false);
        throw new ToolError(`${e.message}\nNo files were changed.`);
      }
      throw e;
    }
    // read-before-edit for every existing file the patch changes or deletes
    for (const c of changes) {
      for (const p of [c.path, c.from].filter(Boolean) as string[]) {
        const v = versions.get(p);
        if (v !== undefined) requireFreshRead(ctx, p, rel(ctx, p), v);
      }
    }
    const host = hostOf(ctx);
    const lines: string[] = [];
    const feedback: string[] = [];
    const cfg = cfgOf(ctx);
    const pre = new Map<string, Awaited<ReturnType<typeof snapshotDiagnostics>>>();
    if (cfg.verify) for (const c of changes) if (c.kind !== 'delete' && c.before !== null) pre.set(c.path, await snapshotDiagnostics(verifyHostOf(ctx, c.path), c.path));
    for (const c of changes) {
      const display = rel(ctx, c.path);
      if (c.kind === 'delete') {
        confineAtWrite(ctx, c.path, 'apply_patch');
        await host.delete(c.path);
        ctx.ledger.forget(c.path);
        lines.push(`D ${display}`);
        continue;
      }
      await commit(ctx, c.path, c.after ?? '', `apply_patch ${display}`);
      lines.push(`${c.from ? `R ${rel(ctx, c.from)} → ` : c.before === null ? 'A ' : 'M '}${display}`);
      if (cfg.verify) {
        const fb = await afterEdit(c.path, stripBom(c.before ?? '').text, stripBom(c.after ?? '').text, verifyHostOf(ctx, c.path), { snippet: c.before !== null, preDiagnostics: pre.get(c.path), waitMs: cfg.diagnosticsWaitMs });
        if (fb) feedback.push(`${display}:\n${fb}`);
      }
    }
    recordOutcome(ctx, 'apply_patch', true);
    const tiers = [...new Set(changes.flatMap((c) => c.tiers))].filter((t) => t !== 'exact');
    const first = changes.find((c) => c.kind !== 'delete') ?? changes[0];
    return {
      output: [`Applied patch:\n${lines.join('\n')}`, tiers.length ? `Note: some context matched only after normalising (${tiers.join(', ')}).` : '', feedback.join('\n').slice(0, 3000)].filter(Boolean).join('\n'),
      meta: { changedFile: first.path, before: first.before ?? '', after: first.after ?? '', created: first.before === null, changedFiles: changes.map((c) => c.path), changes: changes.map((c) => ({ path: c.path, before: c.before, after: c.kind === 'delete' ? null : c.after ?? '' })), editTool: 'apply_patch', editTiers: tiers, editTier: tiers[tiers.length - 1] ?? 'exact' },
    };
  },
};

function patchFs(ctx: ToolContext, versions?: Map<string, string>) {
  return {
    async read(abs: string) {
      const l = await loadText(ctx, abs, rel(ctx, abs));
      if (!l) return undefined;
      assertEditable(l, rel(ctx, abs));
      versions?.set(abs, l.version);
      return l.raw;
    },
    async isDirectory(abs: string) {
      try {
        return fs.statSync(abs).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

// ------------------------------------------------------------ edit-tool family (SPEC A7)

/** The edit tools for this session's model: exactly one family (replace | apply_patch | whole), plus write_file. */
export function editTools(cfg: Parameters<typeof resolveEditFormat>[0]): ToolDef[] {
  const byName: Record<string, ToolDef> = { edit_file: editFileTool, multi_edit: multiEditTool, apply_patch: applyPatchTool, write_file: writeFileTool };
  return EDIT_FAMILIES[resolveEditFormat(cfg)].map((n) => byName[n]);
}

// ---------------------------------------------------------------- walking

function loadGitignore(root: string): (rel: string) => boolean {
  const pats: string[] = [];
  try {
    const raw = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let l of raw.split(/\r?\n/)) {
      l = l.trim();
      if (!l || l.startsWith('#') || l.startsWith('!')) continue;
      const anchored = l.startsWith('/');
      l = l.replace(/^\//, '').replace(/\/$/, '');
      if (anchored || l.includes('/')) pats.push(l, `${l}/**`);
      else pats.push(`**/${l}`, `**/${l}/**`);
    }
  } catch {
    /* no .gitignore */
  }
  return pats.length ? picomatch(pats, { dot: true }) : () => false;
}

export function walkFiles(root: string, opts: { maxFiles?: number; includeDirs?: boolean; signal?: AbortSignal; hidden?: (abs: string) => boolean } = {}): string[] {
  const out: string[] = [];
  const ignored = loadGitignore(root);
  const max = opts.maxFiles ?? 50_000;
  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    if (opts.signal?.aborted) break;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (DEFAULT_IGNORES.includes(e.name) || ignored(r) || opts.hidden?.(abs)) continue;
        if (opts.includeDirs) out.push(abs + path.sep);
        stack.push(abs);
      } else if (e.isFile()) {
        if (ignored(r) || opts.hidden?.(abs)) continue;
        out.push(abs);
      }
    }
  }
  return out;
}

export const listDirTool: ToolDef<{ path?: string }> = {
  name: 'list_dir',
  kind: 'read',
  readOnly: true,
  description: 'List the entries of a directory (non-recursive). Directories end with "/". Ignores node_modules, .git and similar.',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory (default: workspace root)' } } },
  title: (a) => `List ${a.path ?? '.'}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path ?? '.'), write: false }] }),
  async run(a, ctx) {
    const abs = resolvePath(ctx, a.path ?? '.');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new ToolError(`not a directory: ${a.path ?? '.'}`);
    const hidden = hiddenFilter(ctx);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => !(e.isDirectory() && DEFAULT_IGNORES.includes(e.name)))
      .filter((e) => !hidden?.(path.join(abs, e.name)));
    entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
    const lines = entries.slice(0, 500).map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = '';
      try {
        size = ` (${fs.statSync(path.join(abs, e.name)).size} B)`;
      } catch {
        /* ignore */
      }
      return `${e.name}${size}`;
    });
    return { output: lines.length ? lines.join('\n') + (entries.length > 500 ? `\n… ${entries.length - 500} more` : '') : '(empty directory)' };
  },
};

export const globTool: ToolDef<{ pattern: string; path?: string }> = {
  name: 'glob',
  kind: 'read',
  readOnly: true,
  description: 'Find files by glob pattern (e.g. "**/*.ts", "src/**/test_*.py"). Returns paths sorted by most recently modified. Respects .gitignore. Does not return file contents.',
  parameters: {
    type: 'object',
    properties: { pattern: { type: 'string', description: 'Glob pattern' }, path: { type: 'string', description: 'Directory to search (default workspace)' } },
    required: ['pattern'],
  },
  title: (a) => `Glob ${a.pattern}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path ?? '.'), write: false }] }),
  async run(a, ctx) {
    const root = resolvePath(ctx, a.path ?? '.');
    let pattern = String(a.pattern ?? '').trim();
    if (!pattern) throw new ToolError('pattern is required');
    if (!pattern.includes('/') && !pattern.startsWith('**')) pattern = `**/${pattern}`;
    const isMatch = picomatch(pattern, { dot: true });
    const files = walkFiles(root, { signal: ctx.signal, hidden: hiddenFilter(ctx) }).filter((f) => isMatch(path.relative(root, f).split(path.sep).join('/')));
    const withTime = files.map((f) => ({ f, t: safeMtime(f) })).sort((x, y) => y.t - x.t);
    const shown = withTime.slice(0, 200).map((x) => rel(ctx, x.f));
    if (!shown.length) return { output: `No files match ${a.pattern}` };
    return { output: shown.join('\n') + (withTime.length > 200 ? `\n… ${withTime.length - 200} more (narrow the pattern)` : '') };
  },
};

function safeMtime(f: string): number {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

let rgAvailable: boolean | undefined;
async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  rgAvailable = await new Promise<boolean>((resolve) => {
    const p = spawn('rg', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (c) => resolve(c === 0));
  });
  return rgAvailable;
}

/** Test hook: force the JS fallback (or re-detect ripgrep). */
export function setRipgrepAvailable(v: boolean | undefined): void {
  rgAvailable = v;
}

export const grepTool: ToolDef<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean; output_mode?: 'files' | 'content' | 'count'; context?: number }> = {
  name: 'grep',
  kind: 'read',
  readOnly: true,
  description:
    'Search file contents with a regular expression (ripgrep syntax). output_mode: "files" (default; matching file paths), "content" (matching lines with line numbers), "count". ' +
    'Use glob to filter files (e.g. "*.py"). Use this to find where things are defined or used before reading files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or directory to search (default workspace)' },
      glob: { type: 'string', description: 'Filter files by glob, e.g. "*.ts" or "src/**/*.py"' },
      ignore_case: { type: 'boolean' },
      output_mode: { type: 'string', enum: ['files', 'content', 'count'] },
      context: { type: 'integer', description: 'Lines of context around matches (content mode)' },
    },
    required: ['pattern'],
  },
  title: (a) => `Grep "${a.pattern}"${a.glob ? ` in ${a.glob}` : ''}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: resolvePath(ctx, a.path ?? '.'), write: false }] }),
  async run(a, ctx) {
    const root = resolvePath(ctx, a.path ?? '.');
    const mode = a.output_mode ?? 'files';
    const hidden = hiddenFilter(ctx);
    if (await hasRipgrep()) {
      // --null: paths are NUL-terminated, so they can be filtered (C5) and made relative unambiguously
      const args = ['--color=never', '--no-require-git', '--no-heading', '--null', '--max-columns=400', '--max-columns-preview'];
      if (a.ignore_case) args.push('-i');
      if (mode === 'files') args.push('-l');
      else if (mode === 'count') args.push('-c');
      else {
        args.push('-n');
        if (a.context) args.push('-C', String(Math.min(10, a.context)));
      }
      if (a.glob) args.push('--glob', a.glob);
      for (const d of DEFAULT_IGNORES) args.push('--glob', `!${d}/`);
      args.push('-e', a.pattern, root);
      const out = await new Promise<{ code: number; text: string; err: string }>((resolve) => {
        const p = spawn('rg', args, { cwd: ctx.workspace });
        let text = '';
        let err = '';
        p.stdout.on('data', (d) => (text += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('error', (e) => resolve({ code: 2, text: '', err: e.message }));
        p.on('exit', (c) => resolve({ code: c ?? 2, text, err }));
      });
      if (out.code === 1) return { output: `No matches for /${a.pattern}/` };
      if (out.code > 1) throw new ToolError(`grep failed: ${(out.err || out.text).slice(0, 500)}`);
      let lines: string[];
      if (mode === 'files') lines = out.text.split('\0').filter(Boolean).filter((f) => !hidden?.(f)).map((f) => rel(ctx, f));
      else
        lines = out.text
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            const z = l.indexOf('\0');
            if (z === -1) return [l]; // "--" group separator
            const file = l.slice(0, z);
            if (hidden?.(file)) return [];
            const rest = l.slice(z + 1);
            return [`${rel(ctx, file)}${mode === 'count' || /^\d+:/.test(rest) ? ':' : '-'}${rest}`];
          });
      if (!lines.filter((l) => l !== '--').length) return { output: `No matches for /${a.pattern}/` };
      return { output: capOutput(lines.slice(0, 500).join('\n') + (lines.length > 500 ? `\n… ${lines.length - 500} more lines` : ''), ctx.config.agent.maxToolOutputChars) };
    }
    // JS fallback
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.ignore_case ? 'i' : '');
    } catch (e) {
      throw new ToolError(`invalid regex: ${(e as Error).message}`);
    }
    const isMatch = a.glob ? picomatch(a.glob.includes('/') ? a.glob : `**/${a.glob}`, { dot: true }) : () => true;
    const files = fs.existsSync(root) && fs.statSync(root).isFile() ? [root].filter((f) => !hidden?.(f)) : walkFiles(root, { signal: ctx.signal, hidden });
    const results: string[] = [];
    for (const f of files) {
      if (!isMatch(path.relative(root, f).split(path.sep).join('/'))) continue;
      let txt: string;
      try {
        const buf = fs.readFileSync(f);
        if (buf.length > 5_000_000 || isBinary(buf)) continue;
        txt = buf.toString('utf8');
      } catch {
        continue;
      }
      const lines = txt.split('\n');
      const hits = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
      if (!hits.length) continue;
      if (mode === 'files') results.push(rel(ctx, f));
      else if (mode === 'count') results.push(`${rel(ctx, f)}:${hits.length}`);
      else for (const i of hits) results.push(`${rel(ctx, f)}:${i + 1}:${lines[i].slice(0, 400)}`);
      if (results.length > 500) break;
    }
    return { output: results.length ? capOutput(results.join('\n'), ctx.config.agent.maxToolOutputChars) : `No matches for /${a.pattern}/` };
  },
};
