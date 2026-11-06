/**
 * Tiered, offset-preserving matcher (SPEC A1, ED §2.3).
 *
 * The model names a place by quoting it (old_string). Small and mid-size models
 * quote with near-lossless drift: CRLF vs LF, copied line-number prefixes,
 * typographic quotes, trailing spaces, shifted or tab/space-swapped indentation,
 * JSON over-escaping, a stray blank line. Each tier below forgives exactly one
 * more kind of drift, *cumulatively*, and every tier must find a UNIQUE match:
 * a tier that finds two places refuses the edit instead of falling through to a
 * looser tier (looser tiers only add ambiguity).
 *
 * Similarity ("fuzzy") matching is never auto-applied. When nothing matches we
 * return up to 3 candidate regions ranked by line-wise similarity, with line
 * numbers, as a "did you mean" for the model.
 *
 * Replacement bytes: lines of new_string that are unchanged from old_string keep
 * the FILE's bytes (so a context line the model retyped with ASCII quotes or
 * different indentation is not rewritten), changed lines are re-indented by the
 * indent tier's delta, and line endings follow the region (text.ts).
 */
import { eolAt, withRegionEndings, type Eol } from './text.js';

export type MatchTier = 'exact' | 'eol' | 'line_numbers' | 'unicode' | 'trailing_ws' | 'indent' | 'escapes' | 'blank_lines';

export const TIER_ORDER: MatchTier[] = ['exact', 'eol', 'line_numbers', 'unicode', 'trailing_ws', 'indent', 'escapes', 'blank_lines'];

/** Human wording for tool results ("old_string matched after …"). */
export const TIER_NOTES: Record<MatchTier, string> = {
  exact: 'matched exactly',
  eol: 'matched after normalising line endings (CRLF/LF)',
  line_numbers: 'matched after stripping line-number prefixes copied from read_file',
  unicode: 'matched after normalising typographic quotes, dashes and special spaces',
  trailing_ws: 'matched after ignoring trailing whitespace',
  indent: 'matched after normalising indentation (new_string was re-indented to the file)',
  escapes: 'matched after un-escaping over-escaped sequences (\\n, \\t, \\")',
  blank_lines: 'matched after ignoring blank lines',
};

export interface EditSpan {
  start: number;
  end: number;
  replacement: string;
  /** 1-based line range of the matched region in the input text */
  startLine: number;
  endLine: number;
}

export interface MatchOk {
  ok: true;
  /** The loosest tier that was needed */
  tier: MatchTier;
  /** Every normalisation applied, in order (e.g. ['line_numbers', 'indent']) */
  tiers: MatchTier[];
  spans: EditSpan[];
}

export interface Candidate {
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

export interface MatchFail {
  ok: false;
  reason: 'not_found' | 'ambiguous' | 'invalid';
  message: string;
  candidates: Candidate[];
  /** For ambiguous matches: 1-based start lines of each occurrence */
  lines?: number[];
  tier?: MatchTier;
}

export interface MatchOptions {
  replaceAll?: boolean;
  /** Column width of a tab for the indent comparison (default: try 4, 2, 8) */
  tabWidth?: number;
  /** Name used in messages */
  file?: string;
}

/** Thrown by applyEdit/applyEdits; carries the structured failure. */
export class EditMatchError extends Error {
  constructor(public readonly fail: MatchFail, message = fail.message) {
    super(message);
  }
}

export const TRUNCATION_MARKER = '… [line truncated';

// ------------------------------------------------------------ helpers

function findAll(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

function spanLines(text: string, start: number, end: number): { startLine: number; endLine: number } {
  const startLine = lineOf(text, start);
  const inner = text.slice(start, Math.max(start, end));
  const trimmed = inner.endsWith('\n') ? inner.slice(0, -1) : inner;
  return { startLine, endLine: startLine + (trimmed.match(/\n/g)?.length ?? 0) };
}

/** LF view of a text with a mapping from view offsets back to original offsets. */
interface LfView {
  text: string;
  toOrig(i: number): number;
}

function lfView(content: string): LfView {
  if (!content.includes('\r\n')) return { text: content, toOrig: (i) => i };
  const removed: number[] = []; // LF-view offsets of the '\n' whose '\r' was removed
  let text = '';
  let last = 0;
  for (let i = content.indexOf('\r\n'); i !== -1; i = content.indexOf('\r\n', i + 2)) {
    text += content.slice(last, i);
    removed.push(text.length);
    last = i + 1; // keep the '\n'
  }
  text += content.slice(last);
  return {
    text,
    toOrig(v: number) {
      // number of removed '\r' strictly before view offset v
      let lo = 0;
      let hi = removed.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (removed[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      return v + lo;
    },
  };
}

const UNICODE_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
};
const UNICODE_RE = /[‘’‚‛′“”„‟″‐-―−  -   　]/g;

/** 1:1 character map, so offsets in the normalised text equal offsets in the original. */
export function normalizeUnicode(s: string): string {
  return s.replace(UNICODE_RE, (c) => UNICODE_MAP[c] ?? c);
}

function hasNonAscii(s: string): boolean {
  UNICODE_RE.lastIndex = 0;
  const r = UNICODE_RE.test(s);
  UNICODE_RE.lastIndex = 0;
  return r;
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function commonSuffix(a: string, b: string, max: number): number {
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

const LINE_PREFIX_FORMS: RegExp[] = [/^\s*(\d+)\t/, /^\s*(\d+)→/, /^\s*L(\d+):\s?/];

/**
 * Strip read_file line-number prefixes ("    12\t"). Every non-empty line must
 * carry one and the numbers must be consecutive, so ordinary code that starts
 * with a number is never touched.
 */
export function stripLineNumberPrefixes(s: string): string | null {
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  for (const re of LINE_PREFIX_FORMS) {
    const nums: number[] = [];
    let ok = true;
    for (const l of lines) {
      if (l === '') continue;
      const m = re.exec(l);
      if (!m) {
        ok = false;
        break;
      }
      nums.push(Number(m[1]));
    }
    if (!ok || !nums.length) continue;
    if (nums.some((n, i) => i > 0 && n !== nums[i - 1] + 1)) continue;
    return lines.map((l) => l.replace(re, '')).join('\n');
  }
  return null;
}

const ESCAPE_RE = /\\(n|t|r|"|'|`|\\)/g;

/** One level of JSON-style unescaping, applied left to right ("\\\\n" stays a literal backslash + n). */
export function unescapeOnce(s: string): string {
  return s.replace(ESCAPE_RE, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', '"': '"', "'": "'", '`': '`', '\\': '\\' })[c] ?? c);
}

function looksOverEscaped(s: string): boolean {
  return /\\[nt"]/.test(s);
}

// ------------------------------------------------------------ line model

interface FileLine {
  /** text without its line ending */
  text: string;
  start: number;
  /** offset just past the text (before the line ending) */
  textEnd: number;
  /** offset just past the line ending */
  end: number;
  eol: '' | Eol;
}

function parseLines(content: string): FileLine[] {
  const out: FileLine[] = [];
  let pos = 0;
  while (pos <= content.length) {
    const nl = content.indexOf('\n', pos);
    if (nl === -1) {
      if (pos < content.length || out.length === 0) out.push({ text: content.slice(pos), start: pos, textEnd: content.length, end: content.length, eol: '' });
      break;
    }
    const cr = nl > pos && content[nl - 1] === '\r';
    out.push({ text: content.slice(pos, cr ? nl - 1 : nl), start: pos, textEnd: cr ? nl - 1 : nl, end: nl + 1, eol: cr ? '\r\n' : '\n' });
    pos = nl + 1;
  }
  return out;
}

interface LineShape {
  blank: boolean;
  cols: number;
  rest: string;
}

function indentCols(ws: string, tabWidth: number): number {
  let c = 0;
  for (const ch of ws) c = ch === '\t' ? c + tabWidth - (c % tabWidth) : c + 1;
  return c;
}

function shape(line: string, tabWidth: number): LineShape {
  const ws = /^[ \t]*/.exec(line)![0];
  const rest = normalizeUnicode(line.slice(ws.length)).trimEnd();
  return { blank: rest === '', cols: indentCols(ws, tabWidth), rest };
}

type Comparator = 'trailing_ws' | 'indent';

/** Mapping of old-line index → file-line index (window-relative); undefined = old line has no counterpart. */
interface LineMatch {
  first: number; // file line index of window start
  last: number; // file line index of window end (inclusive)
  map: (number | undefined)[];
  delta: number;
  tabWidth: number;
  useTabs: boolean;
}

/**
 * Find windows of file lines equal to old lines under a comparator.
 * skipBlank: blank lines on either side are ignored (blank_lines tier).
 */
function findLineWindows(F: FileLine[], O: string[], cmp: Comparator, skipBlank: boolean, tabWidths: number[]): LineMatch[] {
  for (const tw of tabWidths) {
    const fs = F.map((l) => shape(l.text, tw));
    const os = O.map((l) => shape(l, tw));
    const oIdx = skipBlank ? os.map((s, i) => (s.blank ? -1 : i)).filter((i) => i >= 0) : os.map((_, i) => i);
    if (!oIdx.length) return [];
    const eq = (f: LineShape, fr: string, o: LineShape, or: string, delta: number | null): boolean => {
      if (f.blank || o.blank) return f.blank && o.blank;
      if (cmp === 'trailing_ws') return normalizeUnicode(fr).trimEnd() === normalizeUnicode(or).trimEnd();
      return f.rest === o.rest && (delta === null || f.cols - o.cols === delta);
    };
    const out: LineMatch[] = [];
    let i = 0;
    while (i < F.length) {
      // first old line of interest must line up with a candidate start
      const map: (number | undefined)[] = new Array(O.length).fill(undefined);
      let fi = i;
      let delta: number | null = null;
      let ok = true;
      for (let k = 0; k < oIdx.length; k++) {
        const oi = oIdx[k];
        if (skipBlank) {
          if (k === 0) {
            if (fs[fi]?.blank) {
              ok = false;
              break;
            }
          } else while (fi < F.length && fs[fi].blank) fi++;
        }
        if (fi >= F.length) {
          ok = false;
          break;
        }
        const f = fs[fi];
        const o = os[oi];
        if (cmp === 'indent' && delta === null && !f.blank && !o.blank) delta = f.cols - o.cols;
        if (!eq(f, F[fi].text, o, O[oi], cmp === 'indent' ? delta : null)) {
          ok = false;
          break;
        }
        map[oi] = fi - i;
        fi++;
      }
      if (ok) {
        const lastF = fi - 1;
        const window = F.slice(i, lastF + 1);
        out.push({ first: i, last: lastF, map, delta: delta ?? 0, tabWidth: tw, useTabs: window.some((l) => l.text.startsWith('\t')) });
        i = lastF + 1;
      } else i++;
    }
    if (out.length) return out;
    if (cmp !== 'indent') return out;
  }
  return [];
}

function reindent(line: string, delta: number, tabWidth: number, useTabs: boolean): string {
  const ws = /^[ \t]*/.exec(line)![0];
  const rest = line.slice(ws.length);
  if (!rest.trim()) return '';
  const cols = Math.max(0, indentCols(ws, tabWidth) + delta);
  const lead = useTabs ? '\t'.repeat(Math.floor(cols / tabWidth)) + ' '.repeat(cols % tabWidth) : ' '.repeat(cols);
  return lead + rest;
}

/**
 * Build the replacement for a line-window match. Lines of new_string equal to
 * old_string (common prefix/suffix) are emitted as the file's own lines; the
 * changed middle is transformed (re-indented for the indent tier).
 */
function lineReplacement(F: FileLine[], m: LineMatch, O: string[], N: string[], includeEol: boolean, regionEol: Eol, reindentMiddle: boolean): string {
  const W = F.slice(m.first, m.last + 1);
  const max = Math.min(O.length, N.length);
  let p = 0;
  while (p < max && O[p] === N[p]) p++;
  let s = 0;
  while (s < max - p && O[O.length - 1 - s] === N[N.length - 1 - s]) s++;

  let headEnd = 0;
  for (let j = p - 1; j >= 0; j--)
    if (m.map[j] !== undefined) {
      headEnd = m.map[j]! + 1;
      break;
    }
  let tailStart = W.length;
  for (let j = O.length - s; j < O.length; j++)
    if (m.map[j] !== undefined) {
      tailStart = m.map[j]!;
      break;
    }
  // File-only blank lines at the edges of the changed zone are kept when the
  // model's old zone starts/ends with a real (mapped) line.
  const zone = O.slice(p, O.length - s).map((_, k) => m.map[p + k]);
  const firstMapped = zone.findIndex((x) => x !== undefined);
  let keepLead: FileLine[] = [];
  let keepTrail: FileLine[] = [];
  if (firstMapped === 0) {
    keepLead = W.slice(headEnd, zone[0]!);
    let lastMapped = zone.length - 1;
    while (lastMapped >= 0 && zone[lastMapped] === undefined) lastMapped--;
    if (lastMapped === zone.length - 1) keepTrail = W.slice(zone[lastMapped]! + 1, tailStart);
  }
  type Out = { text: string; eol: '' | Eol };
  const out: Out[] = [];
  for (const l of W.slice(0, headEnd)) out.push({ text: l.text, eol: l.eol });
  for (const l of keepLead) out.push({ text: l.text, eol: l.eol });
  for (const l of N.slice(p, N.length - s)) out.push({ text: reindentMiddle ? reindent(l, m.delta, m.tabWidth, m.useTabs) : l, eol: regionEol });
  for (const l of keepTrail) out.push({ text: l.text, eol: l.eol });
  for (const l of W.slice(tailStart)) out.push({ text: l.text, eol: l.eol });
  let text = '';
  out.forEach((o, i) => {
    const last = i === out.length - 1;
    text += o.text + (last ? (includeEol ? o.eol || regionEol : '') : o.eol || regionEol);
  });
  return text;
}

function dominantEol(lines: FileLine[], fallback: Eol): Eol {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\n') lf++;
  }
  return crlf || lf ? (crlf > lf ? '\r\n' : '\n') : fallback;
}

// ------------------------------------------------------------ tiers

type TierResult = { tier: MatchTier; spans: EditSpan[] } | { tier: MatchTier; ambiguous: number[] } | null;

function finalize(content: string, tier: MatchTier, raw: { start: number; end: number; replacement: string }[], replaceAll: boolean): TierResult {
  if (!raw.length) return null;
  if (raw.length > 1 && !replaceAll) return { tier, ambiguous: raw.map((r) => lineOf(content, r.start)) };
  return { tier, spans: raw.map((r) => ({ ...r, ...spanLines(content, r.start, r.end) })) };
}

type CompareTier = 'exact' | 'eol' | 'unicode' | 'trailing_ws' | 'indent' | 'blank_lines';

/** Tiers that compare text. Pre-processing tiers (line_numbers, escapes) re-run these on transformed strings. */
function compareTiers(content: string, oldS: string, newS: string, o: MatchOptions, allowed: Set<CompareTier>): TierResult {
  const replaceAll = !!o.replaceAll;
  const fileEol = (at: number) => eolAt(content, at);

  // 1. exact
  if (allowed.has('exact')) {
    const hits = findAll(content, oldS);
    const r = finalize(content, 'exact', hits.map((s) => ({ start: s, end: s + oldS.length, replacement: withRegionEndings(oldS, newS, fileEol(s)) })), replaceAll);
    if (r) return r;
  }

  // 2. eol: LF view of both sides, offsets mapped back
  const oldLF = oldS.replace(/\r\n/g, '\n');
  const newLF = newS.replace(/\r\n/g, '\n');
  const view = lfView(content);
  if (allowed.has('eol') && (view.text !== content || oldLF !== oldS)) {
    const hits = findAll(view.text, oldLF);
    const r = finalize(
      content,
      'eol',
      hits.map((v) => {
        const start = view.toOrig(v);
        const end = view.toOrig(v + oldLF.length);
        return { start, end, replacement: withRegionEndings(content.slice(start, end), newLF, fileEol(start)) };
      }),
      replaceAll,
    );
    if (r) return r;
  }

  // 4. unicode (character level on the LF view; the 1:1 map keeps offsets)
  if (allowed.has('unicode') && (hasNonAscii(view.text) || hasNonAscii(oldLF))) {
    const normFile = normalizeUnicode(view.text);
    const normOld = normalizeUnicode(oldLF);
    const hits = findAll(normFile, normOld);
    const r = finalize(
      content,
      'unicode',
      hits.map((v) => {
        const start = view.toOrig(v);
        const end = view.toOrig(v + oldLF.length);
        const fileSpan = view.text.slice(v, v + oldLF.length);
        // characters the model left unchanged keep the file's own code points
        const pc = commonPrefix(oldLF, newLF);
        const sc = commonSuffix(oldLF, newLF, Math.min(oldLF.length, newLF.length) - pc);
        const rep = fileSpan.slice(0, pc) + newLF.slice(pc, newLF.length - sc) + fileSpan.slice(fileSpan.length - sc);
        return { start, end, replacement: withRegionEndings(content.slice(start, end), rep, fileEol(start)) };
      }),
      replaceAll,
    );
    if (r) return r;
  }

  // 5, 6, 8. line tiers
  if (!allowed.has('trailing_ws') && !allowed.has('indent') && !allowed.has('blank_lines')) return null;
  const F = parseLines(content);
  const trailing = oldLF.endsWith('\n');
  const O = (trailing ? oldLF.slice(0, -1) : oldLF).split('\n');
  const newTrailing = trailing && newLF.endsWith('\n');
  const N = (newTrailing ? newLF.slice(0, -1) : newLF).split('\n');
  const tabWidths = [...new Set([o.tabWidth ?? 4, 4, 2, 8])];
  const lineTier = (tier: MatchTier, cmp: Comparator, skipBlank: boolean): TierResult => {
    const widths = cmp === 'indent' && (content.includes('\t') || oldLF.includes('\t')) ? tabWidths : [tabWidths[0]];
    const ms = findLineWindows(F, O, cmp, skipBlank, widths);
    return finalize(
      content,
      tier,
      ms.map((m) => {
        const W = F.slice(m.first, m.last + 1);
        const start = F[m.first].start;
        const lastLine = F[m.last];
        // old_string ending in a newline covers the last line's ending too
        const end = trailing ? lastLine.end : lastLine.textEnd;
        const regionEol = dominantEol(W, eolAt(content, start));
        const includeEol = trailing && (newTrailing || lastLine.eol === '');
        return { start, end, replacement: lineReplacement(F, m, O, N, includeEol, regionEol, cmp === 'indent') };
      }),
      replaceAll,
    );
  };
  if (allowed.has('trailing_ws')) {
    const r = lineTier('trailing_ws', 'trailing_ws', false);
    if (r) return r;
  }
  if (allowed.has('indent')) {
    const r = lineTier('indent', 'indent', false);
    if (r) return r;
  }
  if (allowed.has('blank_lines')) {
    for (const cmp of ['trailing_ws', 'indent'] as Comparator[]) {
      const r = lineTier('blank_lines', cmp, true);
      if (r) return r;
    }
  }
  return null;
}

const STRICT: Set<CompareTier> = new Set(['exact', 'eol']);
const LOOSE: Set<CompareTier> = new Set(['unicode', 'trailing_ws', 'indent']);
const ALL_COMPARE: Set<CompareTier> = new Set(['exact', 'eol', 'unicode', 'trailing_ws', 'indent']);
const BLANK: Set<CompareTier> = new Set(['blank_lines']);

/**
 * Locate old_string in content (BOM already stripped) and compute the replacement for each match.
 * Tier order (SPEC A1): exact, eol, line_numbers, unicode, trailing_ws, indent, escapes, blank_lines.
 */
export function findMatch(content: string, oldString: string, newString: string, opts: MatchOptions = {}): MatchOk | MatchFail {
  const file = opts.file ?? 'the file';
  if (!oldString) return { ok: false, reason: 'invalid', message: 'old_string must not be empty; use write_file to create a new file', candidates: [] };
  if (oldString.includes(TRUNCATION_MARKER))
    return { ok: false, reason: 'invalid', message: `old_string contains a line that read_file truncated ("${TRUNCATION_MARKER} …"), so it can never match. Read the exact text with read_file offset/limit or grep, and anchor on a shorter part of the line.`, candidates: [] };

  const settle = (r: TierResult, pre: MatchTier | null): MatchOk | MatchFail | null => {
    if (!r) return null;
    const tier = pre ?? r.tier;
    const tiers: MatchTier[] = pre ? (r.tier === 'exact' ? [pre] : [pre, r.tier]) : [r.tier];
    if ('ambiguous' in r) {
      const lines = r.ambiguous;
      return {
        ok: false,
        reason: 'ambiguous',
        tier,
        lines,
        candidates: [],
        message: `old_string appears ${lines.length} times in ${file} (at lines ${lines.slice(0, 10).join(', ')}${lines.length > 10 ? ', …' : ''}${tier === 'exact' ? '' : `; ${TIER_NOTES[tier]}`}). Include more surrounding lines so it names exactly one place, or set replace_all=true if you mean every occurrence.`,
      };
    }
    return { ok: true, tier, tiers, spans: r.spans };
  };

  const stripped = stripLineNumberPrefixes(oldString);
  const hasPrefixes = stripped !== null && stripped !== oldString.replace(/\r\n/g, '\n');
  const strippedNew = hasPrefixes ? (stripLineNumberPrefixes(newString) ?? newString) : newString;

  // 1-2. exact, eol
  let r = settle(compareTiers(content, oldString, newString, opts, STRICT), null);
  if (r) return r;
  // 3. line_numbers (then 1-6 on the stripped strings)
  if (hasPrefixes) {
    r = settle(compareTiers(content, stripped!, strippedNew, opts, ALL_COMPARE), 'line_numbers');
    if (r) return r;
  }
  // 4-6. unicode, trailing_ws, indent
  r = settle(compareTiers(content, oldString, newString, opts, LOOSE), null);
  if (r) return r;
  // 7. escapes: over-escaped JSON (literal \n, \t, \") unescaped once, then 1-6
  if (looksOverEscaped(oldString)) {
    const o = unescapeOnce(oldString);
    if (o !== oldString) {
      r = settle(compareTiers(content, o, looksOverEscaped(newString) ? unescapeOnce(newString) : newString, opts, ALL_COMPARE), 'escapes');
      if (r) return r;
    }
  }
  // 8. blank_lines: blank lines on either side ignored (incl. leading/trailing blank lines of old_string)
  const base = hasPrefixes ? stripped! : oldString;
  const baseNew = hasPrefixes ? strippedNew : newString;
  const b = compareTiers(content, base, baseNew, opts, BLANK);
  r = settle(b, null);
  if (r) {
    if (hasPrefixes && r.ok) return { ...r, tiers: ['line_numbers', 'blank_lines'] as MatchTier[] };
    return r;
  }

  const candidates = findCandidates(content, base);
  return {
    ok: false,
    reason: 'not_found',
    candidates,
    message: `old_string was not found in ${file}. It must match the file's text: line endings, copied line-number prefixes, typographic quotes, trailing whitespace, uniform indentation shifts, over-escaping and blank lines are tolerated, but the words and line order must be exact.${renderCandidates(candidates)}`,
  };
}

export function renderCandidates(c: Candidate[]): string {
  if (!c.length) return '\nNo similar region was found: re-read the file (read_file, or grep for a distinctive identifier) and copy the text exactly.';
  const parts = c.map((x) => `lines ${x.startLine}-${x.endLine} (${Math.round(x.score * 100)}% similar):\n${x.text}`);
  return `\nDid you mean one of these regions? (actual file text, with line numbers)\n${parts.join('\n---\n')}\nCopy the text exactly from the region you meant (without the line-number prefixes), or re-read the file.`;
}

// ------------------------------------------------------------ candidates ("did you mean")

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen-Dice similarity of character bigrams; cheap and order-tolerant within a line. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.trim() === b.trim() ? 1 : 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

const MAX_LINE_SHOW = 200;

export function findCandidates(content: string, oldString: string, max = 3): Candidate[] {
  const F = content.split('\n').map((l) => l.replace(/\r$/, ''));
  let O = oldString.replace(/\r\n/g, '\n').split('\n');
  while (O.length && !O[0].trim()) O.shift();
  while (O.length && !O[O.length - 1].trim()) O.pop();
  if (!O.length || !F.length) return [];
  const k = Math.min(O.length, F.length);
  const Ft = F.map((l) => normalizeUnicode(l.trim()));
  const Ot = O.map((l) => normalizeUnicode(l.trim()));
  // Cost guard (Gemini CLI uses ~4e8 char ops): fall back to anchoring on the first/last line.
  const full = F.length * k <= 400_000;
  const starts: number[] = [];
  if (full) for (let i = 0; i + k <= F.length; i++) starts.push(i);
  else
    for (let i = 0; i + k <= F.length; i++)
      if (similarity(Ft[i], Ot[0]) >= 0.6 || similarity(Ft[i + k - 1], Ot[k - 1]) >= 0.6) starts.push(i);
  const scored: { i: number; score: number }[] = [];
  for (const i of starts) {
    let sum = 0;
    for (let j = 0; j < k; j++) sum += similarity(Ft[i + j], Ot[j]);
    const score = sum / O.length;
    if (score >= 0.5) scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: { i: number; score: number }[] = [];
  for (const s of scored) {
    if (picked.some((p) => Math.abs(p.i - s.i) < k)) continue;
    picked.push(s);
    if (picked.length >= max) break;
  }
  return picked.map(({ i, score }) => {
    const shown = F.slice(i, i + Math.min(k, 30));
    const text = shown.map((l, j) => `${String(i + j + 1).padStart(6)}\t${l.length > MAX_LINE_SHOW ? l.slice(0, MAX_LINE_SHOW) + '…' : l}`).join('\n') + (k > 30 ? `\n   … (${k - 30} more lines)` : '');
    return { startLine: i + 1, endLine: i + k, text, score };
  });
}

// ------------------------------------------------------------ applying

export function applySpans(content: string, spans: EditSpan[]): string {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = content;
  for (const s of sorted) out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  return out;
}

export interface AppliedEdit {
  updated: string;
  count: number;
  tier: MatchTier;
  tiers: MatchTier[];
  spans: EditSpan[];
}

/** Apply one edit or throw EditMatchError (content is BOM-stripped). */
export function applyEdit(content: string, oldString: string, newString: string, opts: MatchOptions = {}): AppliedEdit {
  if (oldString === newString) throw new EditMatchError({ ok: false, reason: 'invalid', candidates: [], message: 'old_string and new_string are identical; nothing to change' });
  const r = findMatch(content, oldString, newString, opts);
  if (!r.ok) throw new EditMatchError(r);
  const updated = applySpans(content, r.spans);
  return { updated, count: r.spans.length, tier: r.tier, tiers: r.tiers, spans: r.spans };
}

export interface EditInput {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface AppliedEdits {
  updated: string;
  results: { count: number; tier: MatchTier; tiers: MatchTier[]; startLine: number; endLine: number }[];
}

/**
 * multi_edit (SPEC A3): edits apply in order to an in-memory copy, each matched
 * against the result of the previous ones; all-or-nothing.
 */
export function applyEdits(content: string, edits: EditInput[], opts: MatchOptions = {}): AppliedEdits {
  let cur = content;
  const results: AppliedEdits['results'] = [];
  edits.forEach((e, i) => {
    try {
      const r = applyEdit(cur, String(e.old_string ?? ''), String(e.new_string ?? ''), { ...opts, replaceAll: !!e.replace_all });
      cur = r.updated;
      results.push({ count: r.count, tier: r.tier, tiers: r.tiers, startLine: r.spans[0].startLine, endLine: r.spans[r.spans.length - 1].endLine });
    } catch (err) {
      if (err instanceof EditMatchError) {
        const prefix = edits.length > 1 ? `edit #${i + 1} of ${edits.length} failed; no changes were written. ` : '';
        throw new EditMatchError({ ...err.fail, message: prefix + err.fail.message }, prefix + err.message);
      }
      throw err;
    }
  });
  return { updated: cur, results };
}
