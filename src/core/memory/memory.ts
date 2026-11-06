/**
 * Durable memory (SPEC D6; EAG S13).
 *
 * Memory is a small curated markdown file loaded into the system prompt:
 *   project: <workspace>/.tugline/MEMORY.md   (an agent-control file: writes always ask)
 *   user:    ~/.tugline/MEMORY.md
 * One line per record, typed with S13's durable kinds and keyed so a
 * correction SUPERSEDES the old record instead of overwriting it:
 *   - [fact] test-command: run `npm test` (2026-10-27)
 *   - ~~[fact] test-command: run `make test` (2026-10-01)~~ (superseded 2026-10-27)
 * Superseded lines stay in the file (audit trail) but are dropped from the
 * prompt. Writes are deliberate (an explicit `remember`), never raw tool output,
 * and anything that looks like a credential is refused. Memory is context, not
 * enforcement: permissions and hooks carry the guarantees (S13).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import type { LLMClient } from '../llm/client.js';
import { contentToText, redactSecrets } from '../util/text.js';
import { parseJsonLenient } from '../util/json.js';
import { noteHarnessWrite } from '../permissions/harnessWrites.js';

export const MEMORY_KINDS = ['fact', 'preference', 'decision', 'procedure', 'pointer'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = 'project' | 'user';

export interface MemoryEntry {
  kind: MemoryKind;
  key: string;
  text: string;
}

export interface ParsedMemoryLine extends MemoryEntry {
  date?: string;
  superseded: boolean;
}

export function memoryFile(scope: MemoryScope, workspace: string, homeDir: string): string {
  return scope === 'user' ? path.join(homeDir, 'MEMORY.md') : path.join(workspace, '.tugline', 'MEMORY.md');
}

const today = () => new Date().toISOString().slice(0, 10);

/** Stable key: explicit, or "<subject>" before a colon, or the first words of the text. */
export function deriveKey(text: string, key?: string): string {
  const src = (key && key.trim()) || (/^[^:]{2,40}:/.test(text) ? text.slice(0, text.indexOf(':')) : text.split(/\s+/).slice(0, 4).join(' '));
  return src
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'note';
}

export function formatMemoryLine(e: MemoryEntry, date = today()): string {
  return `- [${e.kind}] ${e.key}: ${e.text} (${date})`;
}

const LINE = /^- (~~)?\[(fact|preference|decision|procedure|pointer)\] ([a-z0-9-]+): (.*?)(?: \((\d{4}-\d{2}-\d{2})\))?(~~)?( \(superseded [^)]*\))?\s*$/;

export function parseMemoryLine(line: string): ParsedMemoryLine | null {
  const m = line.match(LINE);
  if (!m) return null;
  return { kind: m[2] as MemoryKind, key: m[3], text: m[4], date: m[5], superseded: !!m[1] };
}

/** Normalise model-provided text into one safe line, or throw with the reason. */
export function sanitizeMemoryText(text: string): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) throw new Error('memory text is empty');
  if (one.length > 500) throw new Error('memory text is too long (max 500 chars): store a pointer to a file instead');
  if (redactSecrets(one) !== one) throw new Error('memory text looks like it contains a credential; secrets are never stored in memory');
  return one;
}

/**
 * Append a record; mark older active records with the same key as superseded.
 * Returns the new line and the lines it superseded.
 */
export function addMemory(file: string, entry: MemoryEntry, date = today()): { line: string; superseded: string[] } {
  const e: MemoryEntry = { kind: entry.kind, key: deriveKey(entry.text, entry.key), text: sanitizeMemoryText(entry.text) };
  let body = '';
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch {
    body = `# Memory\n\nDurable notes for Tugline (one per line; superseded lines are kept for history and not loaded).\n\n`;
  }
  const lines = body.split('\n');
  const superseded: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const p = parseMemoryLine(lines[i]);
    if (!p || p.superseded || p.key !== e.key) continue;
    superseded.push(lines[i]);
    lines[i] = `- ~~[${p.kind}] ${p.key}: ${p.text}${p.date ? ` (${p.date})` : ''}~~ (superseded ${date})`;
  }
  const line = formatMemoryLine(e, date);
  let next = lines.join('\n');
  if (!next.endsWith('\n')) next += '\n';
  next += `${line}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  noteHarnessWrite(file); // R1: the protected-path guard adopts this write (MEMORY.md is an agent-control file)
  return { line, superseded };
}

/** The memory file as the prompt should see it: superseded records removed. */
export function activeMemoryText(text: string): string {
  return text
    .split('\n')
    .filter((l) => !parseMemoryLine(l)?.superseded)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function listMemories(file: string): ParsedMemoryLine[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(parseMemoryLine).filter((x): x is ParsedMemoryLine => !!x);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ auto-memory (off by default)

const PROPOSE_PROMPT = `You review an AI coding session and propose at most 3 DURABLE memories worth keeping for future sessions in this project.
Only propose: stable facts about the project (build/test commands, layout), user preferences the user stated, decisions the user made, or procedures that worked repeatedly.
Never propose: raw tool output, temporary paths, guesses, secrets, or things already obvious from the code.
Answer with JSON only: {"memories":[{"kind":"fact|preference|decision|procedure|pointer","key":"short-kebab-key","text":"one sentence"}]} (an empty list is fine).`;

export async function proposeMemories(llm: LLMClient, messages: ChatMessage[], signal?: AbortSignal): Promise<MemoryEntry[]> {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'tool') continue;
    const t = contentToText(m.content).trim();
    if (t) lines.push(`${m.role.toUpperCase()}: ${t.slice(0, 1500)}`);
  }
  if (!lines.length) return [];
  const res = await llm.complete({ messages: [{ role: 'system', content: PROPOSE_PROMPT }, { role: 'user', content: lines.join('\n').slice(-20_000) }], maxTokens: 600, signal });
  const raw = res.text.replace(/^```(?:json)?|```$/gm, '').trim();
  const p = parseJsonLenient<{ memories?: MemoryEntry[] }>(raw);
  if (!p.ok || !Array.isArray(p.value?.memories)) return [];
  const out: MemoryEntry[] = [];
  for (const m of p.value!.memories!) {
    if (!m || !MEMORY_KINDS.includes(m.kind as MemoryKind) || typeof m.text !== 'string') continue;
    try {
      out.push({ kind: m.kind, key: deriveKey(m.text, m.key), text: sanitizeMemoryText(m.text) });
    } catch {
      /* drop unsafe proposals */
    }
    if (out.length >= 3) break;
  }
  return out;
}
