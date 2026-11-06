/**
 * N2 chunker: split a file into search chunks on definition boundaries
 * (tree-sitter definitions when installed, the D7 regexes otherwise), so a hit
 * is a whole function / method / class header rather than an arbitrary window.
 *
 *  - each definition starts a chunk; the comments, decorators and docstring
 *    lines right above it belong to it;
 *  - the file header (imports, module docs) is its own chunk;
 *  - chunks shorter than MIN_LINES merge into the next one (a class line + its
 *    first method); chunks longer than MAX_LINES are split;
 *  - files without definitions (Markdown, YAML, shell, unknown languages) are
 *    split on Markdown headings or into fixed windows.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { defsForFile, type Def } from '../repomap.js';
import { redactSecrets } from '../../util/text.js';

export interface Chunk {
  rel: string;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  /** "Class.method", "function", or a heading */
  symbol?: string;
  /** redacted source text of the chunk */
  text: string;
  /** hash of what is embedded (path + symbol + text): the embedding cache key */
  hash: string;
}

const MAX_LINES = 80;
const MIN_LINES = 4;
const WINDOW = 50;
const LEAD = /^\s*(\/\/|\/\*|\*|#(?!\[)|@|"""|'''|--|;;)/;

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

/** The text that is embedded and keyword-indexed for a chunk. */
export function chunkDocument(c: Pick<Chunk, 'rel' | 'symbol' | 'text'>): string {
  return `${c.rel}${c.symbol ? ` · ${c.symbol}` : ''}\n${c.text}`;
}

function make(rel: string, lines: string[], start: number, end: number, symbol?: string): Chunk | undefined {
  while (end > start && !lines[end - 1].trim()) end--;
  while (start < end && !lines[start - 1].trim()) start++;
  const text = redactSecrets(lines.slice(start - 1, end).join('\n'));
  if (!text.trim()) return undefined;
  const c = { rel, startLine: start, endLine: end, symbol, text, hash: '' };
  c.hash = sha(chunkDocument(c));
  return c;
}

function windows(rel: string, lines: string[], start: number, end: number, symbol?: string): Chunk[] {
  const out: Chunk[] = [];
  if (end - start + 1 <= MAX_LINES) {
    const c = make(rel, lines, start, end, symbol);
    return c ? [c] : [];
  }
  let part = 1;
  for (let s = start; s <= end; s += WINDOW) {
    const c = make(rel, lines, s, Math.min(end, s + WINDOW - 1), symbol ? `${symbol} (part ${part++})` : undefined);
    if (c) out.push(c);
  }
  return out;
}

function markdown(rel: string, lines: string[]): Chunk[] {
  const starts: { line: number; title: string }[] = [];
  lines.forEach((l, i) => {
    const m = /^(#{1,4})\s+(.+)$/.exec(l);
    if (m) starts.push({ line: i + 1, title: m[2].trim() });
  });
  if (!starts.length) return windows(rel, lines, 1, lines.length);
  const out: Chunk[] = [];
  if (starts[0].line > 1) out.push(...windows(rel, lines, 1, starts[0].line - 1));
  starts.forEach((s, i) => out.push(...windows(rel, lines, s.line, (starts[i + 1]?.line ?? lines.length + 1) - 1, s.title)));
  return out;
}

const label = (d: Def) => (d.parent ? `${d.parent}.${d.name}` : d.name);

export async function chunkFile(rel: string, text: string): Promise<{ chunks: Chunk[]; engine: string }> {
  const lines = text.split('\n');
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.md' || ext === '.mdx') return { chunks: markdown(rel, lines), engine: 'markdown' };
  const { defs, engine } = await defsForFile(rel, text);
  if (!defs.length) return { chunks: windows(rel, lines, 1, lines.length), engine: engine === 'none' ? 'window' : engine };
  // boundaries: each definition line, moved up over its leading comments/decorators
  const marks = [...new Map(defs.map((d) => [d.line, d])).values()].sort((a, b) => a.line - b.line);
  const bounds: { line: number; def: Def }[] = [];
  let prev = 0;
  for (const d of marks) {
    let s = d.line;
    while (s - 1 > prev && LEAD.test(lines[s - 2] ?? '')) s--;
    bounds.push({ line: s, def: d });
    prev = d.line;
  }
  type Seg = { start: number; end: number; symbols: string[] };
  const segs: Seg[] = [];
  if (bounds[0].line > 1) segs.push({ start: 1, end: bounds[0].line - 1, symbols: [] });
  bounds.forEach((b, i) => segs.push({ start: b.line, end: (bounds[i + 1]?.line ?? lines.length + 1) - 1, symbols: [label(b.def)] }));
  // merge short segments forward (a class header line + its first method)
  const merged: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = { ...segs[i], symbols: [...segs[i].symbols] };
    while (s.end - s.start + 1 < MIN_LINES && i + 1 < segs.length && segs[i + 1].end - s.start + 1 <= MAX_LINES) {
      i++;
      s.end = segs[i].end;
      s.symbols.push(...segs[i].symbols);
    }
    merged.push(s);
  }
  const chunks: Chunk[] = [];
  for (const s of merged) chunks.push(...windows(rel, lines, s.start, s.end, s.symbols.length ? s.symbols.slice(0, 3).join(', ') + (s.symbols.length > 3 ? ', …' : '') : undefined));
  return { chunks, engine };
}
