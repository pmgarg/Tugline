/**
 * Byte preservation (SPEC A2). Edits are matched and applied on the decoded
 * text, then re-encoded so that everything the model did not target keeps its
 * exact bytes: BOM, final newline, per-line endings (CRLF, LF, mixed) and the
 * indentation unit.
 *
 * Why this matters: a model writes "\n" in every new_string. Inserting that
 * verbatim into a CRLF file silently produces a mixed-EOL file, which shows up
 * as a whole-file diff in review and breaks some toolchains (ED §2.4).
 */

export type Eol = '\n' | '\r\n';

export interface TextInfo {
  bom: boolean;
  /** 'none' when the text has no line break at all */
  eol: 'lf' | 'crlf' | 'mixed' | 'none';
  dominantEol: Eol;
  finalNewline: boolean;
  /** '\t' for tab-indented text, otherwise the most common space step (2, 4, 8) */
  indentUnit: '\t' | number;
}

export const BOM = '﻿';

export function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

export function detect(text: string): TextInfo {
  const { text: t, bom } = stripBom(text);
  let crlf = 0;
  let lf = 0;
  for (let i = t.indexOf('\n'); i !== -1; i = t.indexOf('\n', i + 1)) {
    if (i > 0 && t[i - 1] === '\r') crlf++;
    else lf++;
  }
  const eol = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  return { bom, eol, dominantEol: crlf > lf ? '\r\n' : '\n', finalNewline: t.endsWith('\n'), indentUnit: detectIndentUnit(t) };
}

export function detectIndentUnit(text: string): '\t' | number {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const ws = /^[ \t]*/.exec(line)![0];
    if (ws.startsWith('\t')) tabs++;
    else if (ws.length) spaces++;
    if (!ws.includes('\t')) {
      const d = ws.length - prev;
      if (d > 0) steps.set(d, (steps.get(d) ?? 0) + 1);
      prev = ws.length;
    }
  }
  if (tabs > spaces) return '\t';
  let best = 4;
  let n = 0;
  for (const [w, c] of steps) if ((w === 2 || w === 4 || w === 8) && c > n) [best, n] = [w, c];
  return best;
}

/** True when the buffer decodes as strict UTF-8 (a UTF-8 BOM is fine). */
export function isValidUtf8(buf: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Line ending of the line that contains offset `at` (falls back to the text's dominant ending). */
export function eolAt(text: string, at: number): Eol {
  const nl = text.indexOf('\n', at);
  if (nl === -1) return detect(text).dominantEol;
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function splitWithEols(s: string): { lines: string[]; eols: Eol[] } {
  const parts = s.split('\n');
  const lines: string[] = [];
  const eols: Eol[] = [];
  parts.forEach((p, i) => {
    const last = i === parts.length - 1;
    if (!last && p.endsWith('\r')) {
      lines.push(p.slice(0, -1));
      eols.push('\r\n');
    } else {
      lines.push(p);
      if (!last) eols.push('\n');
    }
  });
  return { lines, eols };
}

/**
 * Give an LF replacement the line endings of the region it replaces.
 * Lines that align with the original region (common prefix/suffix) inherit that
 * line's own ending; changed or inserted lines take the region's dominant ending
 * (or `fallback`, the ending of the surrounding line, for single-line regions).
 * A replacement that already contains '\r' is taken as deliberate and left alone.
 */
export function withRegionEndings(rawRegion: string, replacement: string, fallback: Eol): string {
  if (!replacement.includes('\n') || replacement.includes('\r')) return replacement;
  const old = splitWithEols(rawRegion);
  if (!old.eols.includes('\r\n') && fallback === '\n') return replacement;
  const crlf = old.eols.filter((e) => e === '\r\n').length;
  const region: Eol = old.eols.length ? (crlf * 2 >= old.eols.length ? '\r\n' : '\n') : fallback;
  const rep = replacement.split('\n');
  const eols: Eol[] = new Array(rep.length - 1).fill(region);
  const max = Math.min(old.lines.length, rep.length);
  let p = 0;
  while (p < max && old.lines[p] === rep[p]) p++;
  for (let j = 0; j < p && j < eols.length && j < old.eols.length; j++) eols[j] = old.eols[j];
  let s = 0;
  while (s < max - p && old.lines[old.lines.length - 1 - s] === rep[rep.length - 1 - s]) s++;
  for (let k = 1; k <= s; k++) {
    const ri = rep.length - 1 - k;
    const oi = old.lines.length - 1 - k;
    if (ri >= 0 && oi >= 0 && ri < eols.length && oi < old.eols.length) eols[ri] = old.eols[oi];
  }
  let out = '';
  rep.forEach((l, i) => (out += l + (i < eols.length ? eols[i] : '')));
  return out;
}

/** Re-encode text that was edited in a BOM-stripped view. */
export function restoreBom(text: string, bom: boolean): string {
  return bom && !text.startsWith(BOM) ? BOM + text : text;
}

// ------------------------------------------------------------ lazy placeholders

/**
 * Elision markers models write instead of real code ("... existing code ...").
 * Writing them into a file deletes the code they stand for (ED §2.9, Continue's
 * LAZY_COMMENT_REGEX, Morph's warning). Patterns are anchored to whole comment
 * lines so ordinary prose ("the rest of the arguments") does not trigger them.
 */
const COMMENT = String.raw`(?:\/\/+|#+|\/\*+|<!--|--|;+|\*)`;
const LAZY_PATTERNS: RegExp[] = [
  new RegExp(String.raw`^\s*${COMMENT}\s*\.{2,}\s*(?:\(?\s*)?(?:existing|rest|remaining|unchanged|previous|other|same|more|original|omitted|keep)\b.*$`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.{2,}\s*)?(?:the\s+)?(?:rest|remainder)\s+of\s+(?:the\s+)?(?:code|file|class|function|method|implementation|module|methods|functions|imports|tests?)\b.*$`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:\.{2,}\s*)?(?:existing|other|remaining|unchanged|previous)\s+(?:code|methods|functions|imports|logic|content|lines|implementation)\b(?:\s+(?:here|unchanged|remains?|goes here|stays?|omitted))?.*$`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*\.{2,}\s*\((?:unchanged|same as before|as before|no changes?)\)\s*(?:\*\/|-->)?\s*$`, 'i'),
  new RegExp(String.raw`^\s*${COMMENT}\s*(?:code|everything)\s+(?:above|below)\s+(?:is\s+)?(?:unchanged|stays the same)\b.*$`, 'i'),
];

/** Bare "..." / "…" lines (Python Ellipsis bodies are legal code, so these count only when absent from the original). */
const BARE_ELLIPSIS = /^\s*(?:\.\.\.|…)\s*$/;

/**
 * Lines of `content` that look like elision placeholders and do not already
 * appear (trimmed) in `original`. Returns at most 3 examples.
 */
export function findLazyPlaceholders(content: string, original = ''): string[] {
  const known = new Set(original.split(/\r?\n/).map((l) => l.trim()));
  const hits: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || known.has(t)) continue;
    if (LAZY_PATTERNS.some((re) => re.test(line)) || (BARE_ELLIPSIS.test(line) && original !== '')) {
      hits.push(t.length > 100 ? t.slice(0, 100) + '…' : t);
      if (hits.length >= 3) break;
    }
  }
  return hits;
}
