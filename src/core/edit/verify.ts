/**
 * Post-edit verification feedback (SPEC A6, ED §2.11).
 *
 * After an edit lands, the model gets — in the same tool result — only the
 * problems its edit INTRODUCED, plus the final text around the change, so it can
 * self-correct without another round trip and chain the next edit without
 * re-reading:
 *
 *  1. IDE diagnostics (`host.diagnostics`, VS Code) diffed against the pre-edit
 *     set; when the host has none,
 *  2. a syntax check: JSON.parse for .json; the real compiler for .py
 *     (`python3 -m py_compile`, when installed) and .js (`node --check`);
 *     tree-sitter ERROR/MISSING nodes for ts/tsx/jsx/go/rs/java/css/html/yaml/
 *     bash (and .py without python3) via the optional, lazy `web-tree-sitter`
 *     (treesitter.ts); a language with neither is skipped.
 *  3. an optional formatter command per glob (`edit.format`), off by default.
 *
 * Errors already present before the edit are not repeated (pre-existing problems
 * cause blame and wasted turns).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import type { Diagnostic, WorkspaceHost } from '../host/workspace.js';
import { diffLines, splitLines } from './diff.js';
import { flag, GRAMMAR_BY_EXT, parseText, treeSitterAvailable, type TsNode } from './treesitter.js';

export interface Problem {
  line: number;
  col?: number;
  severity: 'error' | 'warning';
  message: string;
  source: string;
}

export const MAX_FEEDBACK_CHARS = 1500;

// ------------------------------------------------------------ tree-sitter (optional)

export interface SyntaxTree {
  /** ERROR / MISSING nodes as problems */
  problems(): Problem[];
}
export interface TreeSitterApi {
  parse(lang: string, text: string): Promise<SyntaxTree | undefined>;
}
type Loader = () => Promise<TreeSitterApi | undefined>;

/**
 * Languages checked by tree-sitter (ERROR / MISSING nodes). .json keeps
 * JSON.parse (strict, and tree-sitter-json accepts comments). .py and .js prefer
 * the real compiler when it is there (`python3 -m py_compile`, `node --check`):
 * a compiler catches errors a grammar tolerates and never trips on syntax newer
 * than the grammar; tree-sitter covers Python when python3 is missing.
 */
const TS_LANG: Record<string, string> = Object.fromEntries(Object.entries(GRAMMAR_BY_EXT).filter(([ext]) => ext !== '.json'));

/** First line of a node's text, shortened, for "syntax error near …". */
function near(text: string): string {
  const first = text.trim().split('\n')[0].trim();
  return first.length > 30 ? first.slice(0, 29) + '…' : first;
}

/**
 * Problems from a tree: each ERROR node (where the parser had to skip input) and
 * each MISSING node (a token it had to invent, e.g. an unclosed brace). One
 * problem per line, at most 10. A MISSING closer names the line its block opened.
 */
export function treeProblems(root: TsNode): Problem[] {
  const out: Problem[] = [];
  const lines = new Set<number>();
  const push = (p: Problem) => {
    if (lines.has(p.line) || out.length >= 10) return;
    lines.add(p.line);
    out.push(p);
  };
  const walk = (n: TsNode) => {
    if (out.length >= 10) return;
    if (flag(n.isMissing)) {
      const opened = n.parent && n.parent.startPosition.row < n.startPosition.row ? ` (unclosed from L${n.parent.startPosition.row + 1})` : '';
      push({ line: n.startPosition.row + 1, col: n.startPosition.column + 1, severity: 'error', message: `missing "${n.type}"${opened}`, source: 'tree-sitter' });
      return;
    }
    if (n.type === 'ERROR') {
      const t = near(n.text);
      push({ line: n.startPosition.row + 1, col: n.startPosition.column + 1, severity: 'error', message: t ? `syntax error near "${t}"` : 'syntax error', source: 'tree-sitter' });
      // an ERROR node can still contain a MISSING token deeper in; keep looking
    }
    if (!flag(n.hasError) && n.type !== 'ERROR') return;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return out.sort((a, b) => a.line - b.line);
}

/** Default loader: the shared optional runtime (treesitter.ts). Undefined when it is unavailable. */
async function defaultLoader(): Promise<TreeSitterApi | undefined> {
  if (!(await treeSitterAvailable())) return undefined;
  return {
    async parse(lang, text) {
      const tree = await parseText(lang, text);
      if (!tree) return undefined;
      try {
        const problems = treeProblems(tree.rootNode);
        return { problems: () => problems };
      } finally {
        tree.delete?.();
      }
    },
  };
}

let loader: Loader = defaultLoader;
let loaded: Promise<TreeSitterApi | undefined> | undefined;

/** Replace the tree-sitter loader (tests stub it; the VS Code host can point at bundled wasm). */
export function setTreeSitterLoader(l: Loader | undefined): void {
  loader = l ?? defaultLoader;
  loaded = undefined;
}

async function treeSitter(): Promise<TreeSitterApi | undefined> {
  if (!loaded) loaded = loader().catch(() => undefined);
  return loaded;
}

// ------------------------------------------------------------ fallbacks

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs ?? 10_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: e.message });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

let pythonOk: boolean | undefined;
async function hasPython(): Promise<boolean> {
  if (pythonOk === undefined) pythonOk = (await run('python3', ['--version'], { timeoutMs: 5000 })).code === 0;
  return pythonOk;
}

async function withTempFile<T>(basename: string, text: string, fn: (file: string, dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-verify-'));
  const file = path.join(dir, basename);
  fs.writeFileSync(file, text);
  try {
    return await fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function jsonProblems(text: string): Problem[] {
  if (!text.trim()) return [];
  try {
    JSON.parse(text.replace(/^﻿/, ''));
    return [];
  } catch (e) {
    const msg = (e as Error).message;
    const pos = Number(/position (\d+)/.exec(msg)?.[1]);
    const line = /line (\d+)/.exec(msg)?.[1];
    const ln = line ? Number(line) : Number.isFinite(pos) ? text.slice(0, pos).split('\n').length : 1;
    return [{ line: ln, severity: 'error', message: msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, ''), source: 'json' }];
  }
}

async function pythonProblems(text: string, basename: string): Promise<Problem[]> {
  if (!(await hasPython())) return [];
  return withTempFile(basename.endsWith('.py') ? basename : 'snippet.py', text, async (file, dir) => {
    const r = await run('python3', ['-m', 'py_compile', file], { env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(dir, '__pycache__'), PYTHONDONTWRITEBYTECODE: '1' } });
    if (r.code === 0 || r.code === null) return [];
    const line = Number(/line (\d+)/.exec(r.out)?.[1] ?? 1);
    const m = /^\s*(\w*(?:Error|Exception)): (.*)$/m.exec(r.out.split('\n').reverse().join('\n'));
    return [{ line, severity: 'error', message: m ? `${m[1]}: ${m[2].trim()}` : r.out.trim().split('\n').pop() ?? 'syntax error', source: 'py_compile' }];
  });
}

async function nodeProblems(text: string, basename: string): Promise<Problem[]> {
  return withTempFile(basename, text, async (file) => {
    const r = await run(process.execPath, ['--check', file]);
    if (r.code === 0 || r.code === null) return [];
    const line = Number(new RegExp(`${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(r.out)?.[1] ?? 1);
    const m = /^(\w*Error): (.*)$/m.exec(r.out);
    return [{ line, severity: 'error', message: m ? `${m[1]}: ${m[2]}` : 'syntax error', source: 'node --check' }];
  });
}

/** Syntax problems of `text` as file `abs`. Never throws; unknown languages return []. */
export async function syntaxProblems(abs: string, text: string): Promise<Problem[]> {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  try {
    if (ext === '.json') return jsonProblems(text);
    // a real compiler, when present, is the authority for its language
    if (ext === '.py' && (await hasPython())) return await pythonProblems(text, base);
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return await nodeProblems(text, base);
    const lang = TS_LANG[ext];
    if (lang) {
      const ts = await treeSitter();
      if (ts) {
        const tree = await ts.parse(lang, text).catch(() => undefined);
        if (tree) return tree.problems();
      }
    }
  } catch {
    /* verification must never break an edit */
  }
  return [];
}

// ------------------------------------------------------------ diffing problem sets

function lineText(text: string, line: number): string {
  return (splitLines(text)[line - 1] ?? '').trim();
}

/** Problems in `after` not present before. Matched by message + offending line text, so line shifts do not count as new. */
export function newProblems(before: Problem[], beforeText: string, after: Problem[], afterText: string): Problem[] {
  const seen = new Map<string, number>();
  const key = (p: Problem, t: string) => `${p.message}\u0000${lineText(t, p.line)}`;
  for (const p of before) seen.set(key(p, beforeText), (seen.get(key(p, beforeText)) ?? 0) + 1);
  const out: Problem[] = [];
  for (const p of after) {
    const k = key(p, afterText);
    const n = seen.get(k) ?? 0;
    if (n > 0) seen.set(k, n - 1);
    else out.push(p);
  }
  return out;
}

/** New diagnostics: match by message, severity and source (multiset), ignoring line shifts. */
export function newDiagnostics(pre: Diagnostic[], post: Diagnostic[]): Diagnostic[] {
  const seen = new Map<string, number>();
  const key = (d: Diagnostic) => `${d.severity}\u0000${d.source ?? ''}\u0000${d.message}`;
  for (const d of pre) seen.set(key(d), (seen.get(key(d)) ?? 0) + 1);
  const out: Diagnostic[] = [];
  for (const d of post) {
    const n = seen.get(key(d)) ?? 0;
    if (n > 0) seen.set(key(d), n - 1);
    else out.push(d);
  }
  return out;
}

// ------------------------------------------------------------ snippet

/** Final text around the changed regions, with line numbers (±context lines, at most 2 regions). */
export function changeSnippet(before: string, after: string, context = 3, maxLines = 24): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const hunks = diffLines(a, b);
  if (!hunks.length) return '';
  const ranges: [number, number][] = [];
  for (const h of hunks) {
    const s = Math.max(0, h.newStart - context);
    const e = Math.min(b.length - 1, h.newStart + Math.max(h.newLines, 1) - 1 + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  const out: string[] = [];
  let budget = maxLines;
  for (const [s, e] of ranges.slice(0, 2)) {
    if (budget <= 0) break;
    if (out.length) out.push('   …');
    const end = Math.min(e, s + budget - 1);
    for (let i = s; i <= end; i++) out.push(`${String(i + 1).padStart(6)}\t${b[i].length > 300 ? b[i].slice(0, 300) + '…' : b[i]}`);
    if (end < e) out.push('   …');
    budget -= end - s + 1;
  }
  if (ranges.length > 2) out.push(`   … (${ranges.length - 2} more changed region(s))`);
  return out.join('\n');
}

// ------------------------------------------------------------ formatter

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run the configured formatter for `abs`, if any. Returns a note for the tool result, or ''. */
export async function runFormatter(abs: string, workspace: string, format: Record<string, string>, env?: NodeJS.ProcessEnv): Promise<string> {
  const rel = path.relative(workspace, abs).split(path.sep).join('/');
  for (const [glob, cmd] of Object.entries(format ?? {})) {
    const pat = glob.includes('/') ? glob : `**/${glob}`;
    if (!picomatch(pat, { dot: true })(rel)) continue;
    const command = cmd.includes('{file}') ? cmd.split('{file}').join(shellQuote(abs)) : `${cmd} ${shellQuote(abs)}`;
    const r = await run('bash', ['-c', command], { cwd: workspace, timeoutMs: 30_000, env });
    return r.code === 0 ? `Formatted with \`${cmd}\`.` : `Formatter \`${cmd}\` failed (exit ${r.code}): ${r.out.trim().slice(0, 200)}`;
  }
  return '';
}

// ------------------------------------------------------------ entry point

export interface AfterEditOptions {
  /** Diagnostics captured before the write (host.diagnostics); undefined = host has none */
  preDiagnostics?: Diagnostic[];
  waitMs?: number;
  /** Include the changed-region snippet (default true) */
  snippet?: boolean;
}

/** Capture the pre-edit diagnostic set (no wait). Undefined when the host has no diagnostics. */
export async function snapshotDiagnostics(host: WorkspaceHost, abs: string): Promise<Diagnostic[] | undefined> {
  if (!host.diagnostics) return undefined;
  try {
    return await host.diagnostics(abs);
  } catch {
    return undefined;
  }
}

/**
 * Feedback text to append to an edit's tool result (≤ 1.5k chars):
 * "New problems after this edit: L12: SyntaxError …" plus the final snippet.
 */
export async function afterEdit(abs: string, before: string, after: string, host: WorkspaceHost, opts: AfterEditOptions = {}): Promise<string> {
  const lines: string[] = [];
  let problems: { line: number; message: string; source?: string }[] = [];
  if (host.diagnostics && opts.preDiagnostics) {
    let post: Diagnostic[] = [];
    try {
      post = await host.diagnostics(abs, { waitMs: opts.waitMs ?? 3000 });
    } catch {
      post = [];
    }
    problems = newDiagnostics(opts.preDiagnostics, post).filter((d) => d.severity === 'error' && (!d.path || path.resolve(d.path) === path.resolve(abs)));
  } else {
    const postP = await syntaxProblems(abs, after);
    if (postP.length) {
      const preP = before ? await syntaxProblems(abs, before) : [];
      problems = newProblems(preP, before, postP, after);
    }
  }
  if (problems.length) {
    lines.push('New problems after this edit (fix them before moving on):');
    for (const p of problems.slice(0, 10)) lines.push(`L${p.line}: ${p.message}${p.source ? ` [${p.source}]` : ''}`);
  }
  if (opts.snippet !== false) {
    const snip = changeSnippet(before, after);
    if (snip) lines.push(problems.length ? 'Text around the change now:' : 'Text around the change now (no need to re-read the file):', snip);
  }
  let out = lines.join('\n');
  if (out.length > MAX_FEEDBACK_CHARS) out = out.slice(0, MAX_FEEDBACK_CHARS - 20) + '\n… [truncated]';
  return out;
}
