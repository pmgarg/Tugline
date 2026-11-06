/**
 * V4A `apply_patch` (SPEC A7, ED §2.6): a port of Codex `codex-rs/apply-patch`
 * (Apache-2.0) — the streaming parser's grammar and error messages,
 * `compute_replacements`, and `SourceFile` line-ending handling.
 *
 *   *** Begin Patch
 *   *** Update File: src/app.ts
 *   *** Move to: src/main.ts        (optional)
 *   @@ class App                    (optional context line, seeked first)
 *    context line
 *   -removed line
 *   +added line
 *   *** End of File                 (optional: hunk anchored at EOF)
 *   *** Add File: src/new.ts
 *   +line 1
 *   *** Delete File: old.ts
 *   *** End Patch
 *
 * Deliberate differences from Codex (documented in docs/ws/WS1-NOTES.md):
 *  - all-or-nothing: every hunk of every file is computed before anything is
 *    written (Codex leaves earlier files changed when a later one fails);
 *  - `seek_sequence` uses the A1 tiers: exact, trailing whitespace, Unicode
 *    punctuation, then relative indentation (the hunk's new lines are re-indented
 *    by the same delta), then Codex's trim tier;
 *  - a hunk whose lines match more than one place in its search region (after
 *    the previous hunk and the optional @@ anchor) is refused with the candidate
 *    line numbers; Codex silently applies it at the first match (A1: never edit
 *    the wrong place);
 *  - `@@ -12,7 +12,8 @@` unified-diff headers are accepted as an empty context.
 */
import { findCandidates, normalizeUnicode, renderCandidates } from './match.js';
import { BOM } from './text.js';

export type PatchHunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; movePath?: string; chunks: UpdateChunk[] };

export interface UpdateChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  /** (oldIndex, newIndex) pairs of lines parsed as context (kept with the file's bytes) */
  contextIdx: [number, number][];
  isEndOfFile: boolean;
}

export class PatchError extends Error {}

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CTX = '@@ ';
const EMPTY_CTX = '@@';
const HEADER_HINT = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";
const LINE_HINT = "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";

function invalidHunk(message: string, line: number): PatchError {
  return new PatchError(`invalid hunk at line ${line}, ${message}`);
}

function checkBoundaries(lines: string[]): string[] {
  const strict = (ls: string[]): string | null => {
    const first = ls[0]?.trim();
    const last = ls[ls.length - 1]?.trim();
    if (first === BEGIN && last === END) return null;
    if (first !== BEGIN) return "invalid patch: The first line of the patch must be '*** Begin Patch'";
    return "invalid patch: The last line of the patch must be '*** End Patch'";
  };
  const err = strict(lines);
  if (!err) return lines;
  // Lenient mode (Codex): a heredoc wrapper <<'EOF' … EOF around the patch.
  if (lines.length >= 4 && ['<<EOF', "<<'EOF'", '<<"EOF"'].includes(lines[0]) && lines[lines.length - 1].endsWith('EOF')) {
    const inner = lines.slice(1, -1);
    const e2 = strict(inner);
    if (!e2) return inner;
    throw new PatchError(e2);
  }
  throw new PatchError(err);
}

/** Parse a V4A patch. Throws PatchError with Codex's messages. */
export function parsePatch(patch: string): PatchHunk[] {
  const raw = patch.trim().split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const lines = checkBoundaries(raw);
  const hunks: PatchHunk[] = [];
  let mode: 'not_started' | 'started' | 'add' | 'delete' | 'update' | 'ended' = 'not_started';
  let hunkLine = 0;

  const lastUpdate = () => {
    const h = hunks[hunks.length - 1];
    return h && h.kind === 'update' ? h : undefined;
  };
  const ensureUpdateNotEmpty = (line: string, n: number) => {
    const h = lastUpdate();
    if (!h || mode !== 'update') return;
    if (!h.chunks.length) throw invalidHunk(`Update file hunk for path '${h.path}' is empty`, hunkLine);
    const c = h.chunks[h.chunks.length - 1];
    if (!c.oldLines.length && !c.newLines.length) {
      if (line === END) throw invalidHunk('Update hunk does not contain any lines', n);
      throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, n);
    }
  };
  const headers = (t: string, n: number): boolean => {
    if (t === END) {
      ensureUpdateNotEmpty(t, n);
      mode = 'ended';
      return true;
    }
    if (t.startsWith(ADD)) {
      ensureUpdateNotEmpty(t, n);
      hunks.push({ kind: 'add', path: t.slice(ADD.length), contents: '' });
      mode = 'add';
      return true;
    }
    if (t.startsWith(DELETE)) {
      ensureUpdateNotEmpty(t, n);
      hunks.push({ kind: 'delete', path: t.slice(DELETE.length) });
      mode = 'delete';
      return true;
    }
    if (t.startsWith(UPDATE)) {
      ensureUpdateNotEmpty(t, n);
      hunks.push({ kind: 'update', path: t.slice(UPDATE.length), chunks: [] });
      mode = 'update';
      hunkLine = n;
      return true;
    }
    return false;
  };
  const newChunk = (): UpdateChunk => ({ oldLines: [], newLines: [], contextIdx: [], isEndOfFile: false });

  lines.forEach((line, idx) => {
    const n = idx + 1;
    const t = line.trim();
    switch (mode) {
      case 'not_started':
        if (t === BEGIN) {
          mode = 'started';
          return;
        }
        throw new PatchError("invalid patch: The first line of the patch must be '*** Begin Patch'");
      case 'started':
        if (headers(t, n)) return;
        throw invalidHunk(`'${t}' is not a valid hunk header. ${HEADER_HINT}`, n);
      case 'add': {
        if (headers(t, n)) return;
        const h = hunks[hunks.length - 1];
        if (line.startsWith('+') && h.kind === 'add') {
          h.contents += line.slice(1) + '\n';
          return;
        }
        throw invalidHunk(`'${t}' is not a valid hunk header. ${HEADER_HINT}`, n);
      }
      case 'delete':
        if (headers(t, n)) return;
        throw invalidHunk(`'${t}' is not a valid hunk header. ${HEADER_HINT}`, n);
      case 'update': {
        const u = line.trimEnd();
        if (headers(u.trim() === END ? END : u, n)) return;
        const h = lastUpdate()!;
        const last = h.chunks[h.chunks.length - 1];
        if (last?.isEndOfFile) {
          if (!u) return;
          if (u !== EMPTY_CTX && !u.startsWith(CTX)) throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, n);
        }
        if (!h.chunks.length && h.movePath === undefined && u.startsWith(MOVE)) {
          h.movePath = u.slice(MOVE.length);
          return;
        }
        const isCtxHeader = u === EMPTY_CTX || u.startsWith(CTX);
        if (isCtxHeader && last && !last.oldLines.length && !last.newLines.length) throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, n);
        if (u === EMPTY_CTX || /^@@\s*-\d+(,\d+)?\s+\+\d+(,\d+)?\s*@@\s*$/.test(u)) {
          h.chunks.push(newChunk());
          return;
        }
        if (u.startsWith(CTX)) {
          h.chunks.push({ ...newChunk(), changeContext: u.slice(CTX.length) });
          return;
        }
        if (u === EOF_MARKER) {
          if (last && !last.oldLines.length && !last.newLines.length) throw invalidHunk('Update hunk does not contain any lines', n);
          if (last) last.isEndOfFile = true;
          return;
        }
        const chunk = () => {
          if (!h.chunks.length) h.chunks.push(newChunk());
          return h.chunks[h.chunks.length - 1];
        };
        if (line === '' || line.startsWith(' ')) {
          const c = chunk();
          const text = line === '' ? '' : line.slice(1);
          c.contextIdx.push([c.oldLines.length, c.newLines.length]);
          c.oldLines.push(text);
          c.newLines.push(text);
          return;
        }
        if (line.startsWith('+')) {
          chunk().newLines.push(line.slice(1));
          return;
        }
        if (line.startsWith('-')) {
          chunk().oldLines.push(line.slice(1));
          return;
        }
        if (last && (last.oldLines.length || last.newLines.length)) throw invalidHunk(`Expected update hunk to start with a @@ context marker, got: '${line}'`, n);
        throw invalidHunk(`Unexpected line found in update hunk: '${line}'. ${LINE_HINT}`, n);
      }
      case 'ended':
        if (!t) return;
        throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
    }
  });
  if ((mode as string) !== 'ended') throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
  return hunks;
}

// ------------------------------------------------------------ source file (Codex text_file.rs)

type Ending = '\n' | '\r\n' | '\r';
interface SourceLine {
  text: string;
  ending?: Ending;
}

function parseSource(contents: string): { lines: SourceLine[]; preferred: Ending } {
  const lines: SourceLine[] = [];
  let preferred: Ending | undefined;
  let start = 0;
  let i = 0;
  while (i < contents.length) {
    const c = contents[i];
    let ending: Ending | undefined;
    let len = 0;
    if (c === '\r' && contents[i + 1] === '\n') [ending, len] = ['\r\n', 2];
    else if (c === '\r') [ending, len] = ['\r', 1];
    else if (c === '\n') [ending, len] = ['\n', 1];
    if (!ending) {
      i++;
      continue;
    }
    preferred ??= ending;
    lines.push({ text: contents.slice(start, i), ending });
    i += len;
    start = i;
  }
  if (start < contents.length) lines.push({ text: contents.slice(start) });
  return { lines, preferred: preferred ?? '\n' };
}

type Replacement = [start: number, oldLen: number, newLines: string[]];

function applyReplacements(src: { lines: SourceLine[]; preferred: Ending }, reps: Replacement[]): string {
  const out: SourceLine[] = [];
  let idx = 0;
  for (const [start, oldLen, seg] of reps) {
    while (idx < start) out.push(src.lines[idx++]);
    idx += oldLen;
    for (const text of seg) out.push({ text, ending: src.preferred });
  }
  while (idx < src.lines.length) out.push(src.lines[idx++]);
  return out.map((l) => l.text + (l.ending ?? src.preferred)).join('');
}

// ------------------------------------------------------------ seek_sequence with the A1 tiers

export type SeekTier = 'exact' | 'trailing_ws' | 'unicode' | 'indent' | 'trim';

interface Seek {
  index: number;
  tier: SeekTier;
  /** indentation delta in columns (indent tier) */
  delta: number;
  useTabs: boolean;
  /** every start index that matches at this tier (> 1 = ambiguous) */
  matches: number[];
}

function cols(ws: string): number {
  let c = 0;
  for (const ch of ws) c = ch === '\t' ? c + 4 - (c % 4) : c + 1;
  return c;
}

function relIndentMatch(lines: string[], i: number, pattern: string[]): { delta: number } | null {
  let delta: number | null = null;
  for (let j = 0; j < pattern.length; j++) {
    const a = lines[i + j];
    const b = pattern[j];
    const ra = normalizeUnicode(a.trim());
    const rb = normalizeUnicode(b.trim());
    if (ra !== rb) return null;
    if (!ra) continue;
    const d = cols(/^[ \t]*/.exec(a)![0]) - cols(/^[ \t]*/.exec(b)![0]);
    if (delta === null) delta = d;
    else if (d !== delta) return null;
  }
  return { delta: delta ?? 0 };
}

/**
 * Codex seek_sequence with the A1 tiers. Unlike Codex (first match wins), every
 * start position matching at the winning tier is returned in `matches`, so the
 * caller can refuse an ambiguous hunk instead of editing the wrong place (A1).
 */
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): Seek | null {
  if (!pattern.length) return { index: start, tier: 'exact', delta: 0, useTabs: false, matches: [start] };
  if (pattern.length > lines.length) return null;
  const from = eof && lines.length >= pattern.length ? Math.max(lines.length - pattern.length, start) : start;
  const to = lines.length - pattern.length;
  const scan = (tier: SeekTier, eq: (a: string, b: string) => boolean): Seek | null => {
    const matches: number[] = [];
    for (let i = from; i <= to; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length && ok; j++) ok = eq(lines[i + j], pattern[j]);
      if (ok) matches.push(i);
    }
    return matches.length ? { index: matches[0], tier, delta: 0, useTabs: false, matches } : null;
  };
  const found =
    scan('exact', (a, b) => a === b) ??
    scan('trailing_ws', (a, b) => a.trimEnd() === b.trimEnd()) ??
    scan('unicode', (a, b) => normalizeUnicode(a).trimEnd() === normalizeUnicode(b).trimEnd());
  if (found) return found;
  const indent: { i: number; delta: number }[] = [];
  for (let i = from; i <= to; i++) {
    const m = relIndentMatch(lines, i, pattern);
    if (m) indent.push({ i, delta: m.delta });
  }
  if (indent.length) {
    const { i, delta } = indent[0];
    return { index: i, tier: 'indent', delta, useTabs: lines.slice(i, i + pattern.length).some((l) => l.startsWith('\t')), matches: indent.map((x) => x.i) };
  }
  return scan('trim', (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()));
}

function reindent(line: string, delta: number, useTabs: boolean): string {
  if (!delta && !useTabs) return line;
  const ws = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(ws.length);
  if (!rest) return line;
  const c = Math.max(0, cols(ws) + delta);
  return (useTabs ? '\t'.repeat(Math.floor(c / 4)) + ' '.repeat(c % 4) : ' '.repeat(c)) + rest;
}

/** Codex compute_replacements + derive_new_contents_from_chunks. Returns the new text and tiers used. */
export function applyChunks(original: string, chunks: UpdateChunk[], displayPath: string): { text: string; tiers: SeekTier[] } {
  const bom = original.startsWith(BOM);
  const src = parseSource(bom ? original.slice(1) : original);
  const lines = src.lines.map((l) => l.text);
  const reps: Replacement[] = [];
  const tiers: SeekTier[] = [];
  let lineIndex = 0;
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      const s = seekSequence(lines, [chunk.changeContext], lineIndex, false);
      if (!s) throw new PatchError(`Failed to find context '${chunk.changeContext}' in ${displayPath}${renderCandidates(findCandidates(original, chunk.changeContext))}`);
      lineIndex = s.index + 1;
    }
    if (!chunk.oldLines.length) {
      reps.push([lines.length, 0, [...chunk.newLines]]);
      continue;
    }
    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    if (!found && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') newSlice = newSlice.slice(0, -1);
      found = seekSequence(lines, pattern, lineIndex, chunk.isEndOfFile);
    }
    if (!found) throw new PatchError(`Failed to find expected lines in ${displayPath}:\n${chunk.oldLines.join('\n')}${renderCandidates(findCandidates(original, chunk.oldLines.join('\n')))}`);
    // A1: never edit the wrong place. Codex takes the first match; we refuse when the
    // hunk's lines match more than one place in the search region (after the @@ anchor
    // and the previous hunk).
    if (found.matches.length > 1) {
      const at = found.matches.slice(0, 10).map((i) => i + 1);
      throw new PatchError(
        `The hunk's context/removed lines appear ${found.matches.length} times in ${displayPath} (at lines ${at.join(', ')}${found.matches.length > 10 ? ', …' : ''}${chunk.changeContext !== undefined ? `, after the @@ ${chunk.changeContext} line` : ''}), so the place to change is ambiguous:\n${pattern.join('\n')}\n` +
          'Add more unchanged context lines, or an "@@ <line>" anchor naming the enclosing function/class right before the change, so the hunk matches exactly one place.',
      );
    }
    tiers.push(found.tier);
    const start = found.index;
    const fix = (ls: string[]) => (found!.tier === 'indent' ? ls.map((l) => reindent(l, found!.delta, found!.useTabs)) : ls);
    let oldStart = 0;
    let newStart = 0;
    for (const [oc, nc] of chunk.contextIdx) {
      if (oc >= pattern.length || nc >= newSlice.length) break;
      if (oldStart !== oc || newStart !== nc) reps.push([start + oldStart, oc - oldStart, fix(newSlice.slice(newStart, nc))]);
      oldStart = oc + 1;
      newStart = nc + 1;
    }
    if (oldStart !== pattern.length || newStart !== newSlice.length) reps.push([start + oldStart, pattern.length - oldStart, fix(newSlice.slice(newStart))]);
    lineIndex = start + pattern.length;
  }
  reps.sort((a, b) => a[0] - b[0]);
  const text = applyReplacements(src, reps);
  return { text: bom ? BOM + text : text, tiers };
}

// ------------------------------------------------------------ planning (all-or-nothing)

export interface PatchFs {
  /** File text, or undefined when missing. Throw for unreadable/non-UTF-8 files. */
  read(abs: string): Promise<string | undefined>;
  isDirectory(abs: string): Promise<boolean>;
}

export interface PlannedChange {
  kind: 'add' | 'update' | 'delete';
  /** absolute path written (the move destination for moves) */
  path: string;
  /** absolute source path when the file is moved */
  from?: string;
  before: string | null;
  after: string | null;
  tiers: SeekTier[];
}

/** Compute every file change before writing anything. Throws PatchError on the first failure. */
export async function planPatch(hunks: PatchHunk[], resolve: (p: string) => string, fsx: PatchFs): Promise<PlannedChange[]> {
  if (!hunks.length) throw new PatchError('No files were modified.');
  const out: PlannedChange[] = [];
  // later hunks see earlier hunks' results (e.g. Add then Update of the same file)
  const pending = new Map<string, string | null>();
  const read = async (abs: string) => (pending.has(abs) ? (pending.get(abs) ?? undefined) : fsx.read(abs));
  for (const h of hunks) {
    const abs = resolve(h.path);
    if (h.kind === 'add') {
      if (await fsx.isDirectory(abs)) throw new PatchError(`Failed to write file ${h.path}: it is a directory`);
      const before = (await read(abs)) ?? null;
      out.push({ kind: 'add', path: abs, before, after: h.contents, tiers: [] });
      pending.set(abs, h.contents);
    } else if (h.kind === 'delete') {
      if (await fsx.isDirectory(abs)) throw new PatchError(`Failed to delete file ${h.path}: it is a directory`);
      const before = await read(abs);
      if (before === undefined) throw new PatchError(`Failed to delete file ${h.path}: no such file`);
      out.push({ kind: 'delete', path: abs, before, after: null, tiers: [] });
      pending.set(abs, null);
    } else {
      const before = await read(abs);
      if (before === undefined) throw new PatchError(`Failed to read file to update ${h.path}: no such file`);
      const r = applyChunks(before, h.chunks, h.path);
      if (h.movePath) {
        const dest = resolve(h.movePath);
        const destBefore = (await read(dest)) ?? null;
        out.push({ kind: 'update', path: dest, from: abs, before: destBefore, after: r.text, tiers: r.tiers });
        out.push({ kind: 'delete', path: abs, before, after: null, tiers: [] });
        pending.set(dest, r.text);
        pending.set(abs, null);
      } else {
        out.push({ kind: 'update', path: abs, before, after: r.text, tiers: r.tiers });
        pending.set(abs, r.text);
      }
    }
  }
  return out;
}

/** Paths a patch touches (for permissions), resolved. Unparseable patches yield []. */
export function patchPaths(patch: string, resolve: (p: string) => string): string[] {
  try {
    const out = new Set<string>();
    for (const h of parsePatch(patch)) {
      out.add(resolve(h.path));
      if (h.kind === 'update' && h.movePath) out.add(resolve(h.movePath));
    }
    return [...out];
  } catch {
    return [];
  }
}
