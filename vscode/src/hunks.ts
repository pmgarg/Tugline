/**
 * Hunk computation and per-hunk keep/revert for write-then-review (SPEC B2)
 * and inline edits (B3). Pure: no `vscode` import, unit-tested in
 * test/vscode-units.test.ts.
 *
 * Lines keep their terminators ("a\n", "b\r\n", last line maybe without one),
 * so reverting a hunk reproduces the baseline bytes exactly, line endings and
 * final newline included.
 */
import { diffLines } from '../../src/core/edit/diff.js';

export interface ReviewHunk {
  /** 0-based line in the baseline and number of baseline lines replaced */
  oldStart: number;
  oldLines: number;
  /** 0-based line in the current text and number of current lines */
  newStart: number;
  newLines: number;
}

/** Split keeping each line's terminator; '' → []. */
export function splitKeep(text: string): string[] {
  if (!text) return [];
  const out = text.split(/(?<=\n)/);
  return out;
}

export function computeHunks(base: string, cur: string): ReviewHunk[] {
  return diffLines(splitKeep(base), splitKeep(cur)).map((h) => ({ ...h }));
}

/** Same hunk (by position and size), used to re-find a hunk a CodeLens pointed at. */
export function sameHunk(a: ReviewHunk, b: ReviewHunk): boolean {
  return a.oldStart === b.oldStart && a.oldLines === b.oldLines && a.newStart === b.newStart && a.newLines === b.newLines;
}

/** Undo one hunk: the current text with that hunk's lines put back to the baseline's. */
export function revertHunk(base: string, cur: string, h: ReviewHunk): string {
  const b = splitKeep(base);
  const c = splitKeep(cur);
  return [...c.slice(0, h.newStart), ...b.slice(h.oldStart, h.oldStart + h.oldLines), ...c.slice(h.newStart + h.newLines)].join('');
}

/** Keep one hunk: the baseline advanced by that hunk (the hunk disappears from the review). */
export function keepHunk(base: string, cur: string, h: ReviewHunk): string {
  const b = splitKeep(base);
  const c = splitKeep(cur);
  return [...b.slice(0, h.oldStart), ...c.slice(h.newStart, h.newStart + h.newLines), ...b.slice(h.oldStart + h.oldLines)].join('');
}

export interface ChangeCounts {
  added: number;
  removed: number;
  hunks: number;
}

export function countChanges(base: string, cur: string): ChangeCounts {
  const hs = computeHunks(base, cur);
  return { added: hs.reduce((n, h) => n + h.newLines, 0), removed: hs.reduce((n, h) => n + h.oldLines, 0), hunks: hs.length };
}

/** Character offsets of a hunk's current lines [start, end) in `cur` (for a minimal editor range). */
export function hunkOffsets(cur: string, h: ReviewHunk): { start: number; end: number } {
  const c = splitKeep(cur);
  let start = 0;
  for (let i = 0; i < h.newStart; i++) start += c[i].length;
  let end = start;
  for (let i = h.newStart; i < h.newStart + h.newLines; i++) end += c[i].length;
  return { start, end };
}

/** Text the baseline has for a hunk (what an undo puts back). */
export function hunkBaseText(base: string, h: ReviewHunk): string {
  return splitKeep(base).slice(h.oldStart, h.oldStart + h.oldLines).join('');
}

/**
 * Minimal replacements turning `from` into `to`: one per hunk, as character
 * offsets into `from`. Used by the buffer host so an agent write touches only
 * the changed lines (cursors, folding and the user's other edits stay put).
 */
export function minimalEdits(from: string, to: string): { start: number; end: number; text: string }[] {
  const a = splitKeep(from);
  const b = splitKeep(to);
  const hs = diffLines(a, b);
  const offs: number[] = [0];
  for (const l of a) offs.push(offs[offs.length - 1] + l.length);
  return hs.map((h) => ({ start: offs[h.oldStart], end: offs[h.oldStart + h.oldLines], text: b.slice(h.newStart, h.newStart + h.newLines).join('') }));
}

/** Apply minimal edits (offsets into the original) — the inverse check for minimalEdits. */
export function applyEdits(from: string, edits: { start: number; end: number; text: string }[]): string {
  let out = '';
  let pos = 0;
  for (const e of [...edits].sort((x, y) => x.start - y.start)) {
    out += from.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + from.slice(pos);
}

export interface TextChange {
  /** offset and length in the text BEFORE the change */
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * A user typed in a document under review: changes that fall entirely inside
 * lines the agent did not touch are applied to the baseline too, so "Undo"
 * reverts only the agent's hunks and never the user's later typing. Changes
 * that touch an agent hunk merge into that hunk (the baseline is unchanged).
 */
export function rebaseUserChanges(base: string, prevCur: string, changes: TextChange[]): string {
  const b = splitKeep(base);
  const c = splitKeep(prevCur);
  const hs = diffLines(b, c);
  const bStart: number[] = [0];
  for (const l of b) bStart.push(bStart[bStart.length - 1] + l.length);
  const cStart: number[] = [0];
  for (const l of c) cStart.push(cStart[cStart.length - 1] + l.length);
  const lineAt = (off: number): number => {
    let lo = 0;
    let hi = c.length; // line index whose start <= off
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cStart[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // current line → baseline line, for lines outside hunks
  const map = new Map<number, number>();
  let ci = 0;
  let bi = 0;
  for (const h of [...hs, { oldStart: b.length, oldLines: 0, newStart: c.length, newLines: 0 }]) {
    while (ci < h.newStart && bi < h.oldStart) map.set(ci++, bi++);
    ci = h.newStart + h.newLines;
    bi = h.oldStart + h.oldLines;
  }
  // The position just past the last line maps too (appending at EOF of an unchanged tail).
  if (!hs.length || (hs[hs.length - 1].newStart + hs[hs.length - 1].newLines < c.length)) map.set(c.length, b.length);
  let out = base;
  for (const ch of [...changes].sort((x, y) => y.rangeOffset - x.rangeOffset)) {
    const l1 = lineAt(ch.rangeOffset);
    const endOff = ch.rangeOffset + ch.rangeLength;
    const l2 = ch.rangeLength ? lineAt(Math.max(ch.rangeOffset, endOff - 1)) : l1;
    let ok = true;
    for (let l = l1; l <= l2; l++) if (!map.has(l) || map.get(l)! - map.get(l1)! !== l - l1) ok = false;
    if (!ok) continue;
    const bo = bStart[map.get(l1)!] + (ch.rangeOffset - cStart[l1]);
    out = out.slice(0, bo) + ch.text + out.slice(bo + ch.rangeLength);
  }
  return out;
}
