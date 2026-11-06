/**
 * @file / @folder mentions in prompts (SPEC D13, CLI side of B4).
 *
 *   "fix @src/calc.py:10-30 using @docs/"  →  the prompt plus
 *   <attached_context source="@src/calc.py:10-30">…</attached_context>
 *   <attached_context source="@docs/">tree listing</attached_context>
 *
 * Only paths that exist are expanded (so "@user" or an e-mail address stays
 * text). Every path goes through the permission engine as a read: files outside
 * the workspace, secret files (.env, keys) and anything the policy would ask
 * about are NOT attached; the user gets a note instead.
 */
import { attachmentBlock } from '../util/attachments.js';
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionPolicy } from '../permissions/policy.js';

export interface MentionResult {
  text: string;
  attached: { source: string; path: string; kind: 'file' | 'folder'; lines?: number; entries?: number }[];
  skipped: { source: string; reason: string }[];
}

const MENTION = /(^|[\s(["'])@((?:~|\.{1,2})?\/?[\w.\-/@+]+?)(?::(\d+)(?:-(\d+))?)?(?=$|[\s)\]"',;!?]|\.(?:\s|$))/g;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', 'target', '.next']);

function listing(dir: string, max: number): { text: string; entries: number } {
  const out: string[] = [];
  let truncated = false;
  const walk = (d: string, prefix: string, depth: number) => {
    if (depth > 4 || truncated) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
      if (out.length >= max) {
        truncated = true;
        return;
      }
      out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`, depth + 1);
    }
  };
  walk(dir, '', 0);
  return { text: out.join('\n') + (truncated ? `\n… (more than ${max} entries; listing truncated)` : ''), entries: out.length };
}

export function expandMentions(input: string, workspace: string, opts: { policy?: Pick<PermissionPolicy, 'check'>; maxFileChars?: number; maxEntries?: number } = {}): MentionResult {
  const maxChars = opts.maxFileChars ?? 20_000;
  const maxEntries = opts.maxEntries ?? 200;
  const res: MentionResult = { text: input, attached: [], skipped: [] };
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(MENTION)) {
    let rel = m[2];
    // trailing sentence punctuation is not part of the path
    while (/[.,:;]$/.test(rel) && !fs.existsSync(path.resolve(workspace, rel))) rel = rel.slice(0, -1);
    const abs = path.resolve(workspace, rel.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue; // not a path: leave the text alone
    }
    const from = m[3] ? Number(m[3]) : undefined;
    const to = m[4] ? Number(m[4]) : from;
    const source = `@${rel}${from ? `:${from}${to && to !== from ? `-${to}` : ''}` : ''}`;
    if (seen.has(source)) continue;
    seen.add(source);
    if (opts.policy) {
      const d = opts.policy.check({ tool: 'read_file', kind: 'read', paths: [{ path: abs, write: false }] });
      if (d.decision !== 'allow') {
        res.skipped.push({ source, reason: d.reason });
        continue;
      }
    }
    if (st.isDirectory()) {
      const l = listing(abs, maxEntries);
      blocks.push(attachmentBlock('attached_context', { source, kind: 'folder' }, l.text));
      res.attached.push({ source, path: abs, kind: 'folder', entries: l.entries });
      continue;
    }
    if (!st.isFile()) continue;
    let text: string;
    try {
      const buf = fs.readFileSync(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        res.skipped.push({ source, reason: 'binary file' });
        continue;
      }
      text = buf.toString('utf8');
    } catch (e) {
      res.skipped.push({ source, reason: (e as Error).message });
      continue;
    }
    let lines = text.split('\n');
    let start = 1;
    if (from) {
      start = Math.max(1, from);
      lines = lines.slice(start - 1, Math.max(start, to ?? start));
    }
    let body = lines.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
    if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n… [truncated: ${body.length - maxChars} more chars; read the rest with read_file]`;
    blocks.push(attachmentBlock('attached_context', { source, kind: 'file' }, body));
    res.attached.push({ source, path: abs, kind: 'file', lines: lines.length });
  }
  if (blocks.length) res.text = `${input}\n\n${blocks.join('\n\n')}`;
  return res;
}
