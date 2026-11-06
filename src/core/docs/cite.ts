/**
 * WS12: source citations — parse, validate, repair, render.
 *
 * Every claim the docs features write (wiki pages, `tug ask` answers) carries a
 * `path:start-end` citation. A model's citation is accepted only when the file
 * is in the readable inventory and the line span exists. Otherwise it is
 * repaired when that is unambiguous (a unique basename, an end past EOF, a
 * symbol named in the claim) or dropped. A claim left with no valid citation is
 * removed: an unsupported sentence is worse than a missing one.
 */
import path from 'node:path';
import type { Inventory } from './inventory.js';

export interface Citation {
  path: string;
  start: number;
  end: number;
}

export interface CiteStats {
  valid: number;
  repaired: number;
  dropped: number;
  /** claims removed because none of their citations survived (or they had none) */
  droppedClaims: number;
  /** what was dropped, for notes and tests */
  droppedRefs: string[];
}

export const emptyStats = (): CiteStats => ({ valid: 0, repaired: 0, dropped: 0, droppedClaims: 0, droppedRefs: [] });

/**
 * Citation forms models produce: `(src/a.ts:12-20)`, `[src/a.ts:12]`, `src/a.ts#L12-L20`,
 * `` `src/a.ts:12-20` ``, optionally with `@sha`. Paths need an extension.
 */
const EXTS = 'tsx?|mts|cts|jsx?|mjs|cjs|py|pyi|go|rs|java|kts?|cs|scala|swift|dart|rb|c|h|cc|cpp|hpp|cxx|php|md|mdx|markdown|rst|txt|json|jsonc|ya?ml|toml|sh|bash|css|scss|html?|sql|proto|gradle|cfg|ini';
const CITE_RE = new RegExp(String.raw`[([\`]?(?<![\w.@/-])((?:[\w.@-]+\/)*(?:\.[A-Za-z][\w-]*|[\w@-][\w.@-]*\.(?:${EXTS})))(?::(\d+)(?:\s*[-–]\s*(\d+))?|#L(\d+)(?:-L?(\d+))?)(?:@[0-9a-f]{6,40})?[)\]\`]?`, 'g');

export function parseCitations(text: string): { raw: string; cite: Citation; index: number }[] {
  const out: { raw: string; cite: Citation; index: number }[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    const start = Number(m[2] ?? m[4]);
    const end = Number(m[3] ?? m[5] ?? start);
    if (!Number.isFinite(start)) continue;
    out.push({ raw: m[0], cite: { path: m[1].replace(/^\.\//, ''), start, end }, index: m.index ?? 0 });
  }
  return out;
}

/** Validate one citation against the inventory; repair when unambiguous. */
export function validateCitation(c: Citation, inv: Inventory, claim = ''): { cite?: Citation; repaired: boolean; reason?: string } {
  let file = inv.byRel.get(c.path);
  let repaired = false;
  if (!file) {
    const base = path.posix.basename(c.path);
    const cands = inv.files.filter((f) => path.posix.basename(f.rel) === base);
    const suffix = cands.filter((f) => f.rel.endsWith(c.path));
    const pick = suffix.length === 1 ? suffix[0] : cands.length === 1 ? cands[0] : undefined;
    if (!pick) return { repaired: false, reason: `${c.path} is not a readable file in this repository` };
    file = pick;
    repaired = true;
  }
  let { start, end } = c;
  if (end < start) [start, end] = [end, start];
  if (start < 1 || start > file.lines) {
    // a symbol named in the claim that this file defines → cite its definition
    const sym = file.defs.find((d) => new RegExp(`\\b${d.name.replace(/[$]/g, '\\$')}\\b`).test(claim));
    if (!sym) return { repaired: false, reason: `${file.rel} has ${file.lines} lines; line ${start} does not exist` };
    const next = file.defs.filter((d) => d.line > sym.line).map((d) => d.line).sort((a, b) => a - b)[0];
    start = sym.line;
    end = Math.min(file.lines, next ? next - 1 : sym.line + 20, sym.line + 40);
    repaired = true;
  }
  if (end > file.lines) {
    end = file.lines;
    repaired = true;
  }
  return { cite: { path: file.rel, start, end }, repaired: repaired || file.rel !== c.path };
}

export function citeKey(c: Citation): string {
  return c.start === c.end ? `${c.path}:${c.start}` : `${c.path}:${c.start}-${c.end}`;
}

/**
 * Markdown for a citation: `[path:12-20@sha](link#L12-L20)`. `linkBase` is the
 * relative path from the page to the repository root ('' = plain text).
 */
export function renderCitation(c: Citation, sha?: string, linkBase?: string): string {
  const label = `${citeKey(c)}${sha ? `@${sha.slice(0, 7)}` : ''}`;
  if (linkBase === undefined) return `\`${label}\``;
  return `[${label}](${linkBase}${c.path}#L${c.start}${c.end !== c.start ? `-L${c.end}` : ''})`;
}

const NOT_A_CLAIM = /^\s*(#{1,6}\s|>\s*Note:|```|~~~|<!--|\|?\s*[-:| ]+\|?\s*$|>?\s*$|\[[^\]]*\]\([^)]*\)\s*$)/;

/**
 * Validate every citation in a markdown document. Claim lines (prose, bullets,
 * table rows) keep only valid or repaired citations, re-rendered canonically;
 * a claim with none left is removed. Headings, fences, Mermaid blocks, links-only
 * lines and lead-ins ending in ':' pass through.
 */
export function validateDocument(md: string, inv: Inventory, o: { sha?: string; linkBase?: string; stats?: CiteStats; requireCitations?: boolean } = {}): { text: string; stats: CiteStats; cited: Set<string> } {
  const stats = o.stats ?? emptyStats();
  const cited = new Set<string>();
  const out: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence || NOT_A_CLAIM.test(line) || !line.trim()) {
      out.push(line);
      continue;
    }
    // prose: one claim per sentence; bullets and table rows are one claim each
    const claims = /^\s*([-*+]|\d+\.|\|)\s?/.test(line) ? [line] : line.split(/(?<=[.!?][)\]`]?)\s+(?=[A-Z(`\[*])/);
    const kept = claims.map((c) => claim(c)).filter((c): c is string => c !== undefined);
    if (kept.length) out.push(kept.join(' '));
  }

  function claim(line: string): string | undefined {
    const found = parseCitations(line);
    if (!found.length) {
      if (o.requireCitations === false || /:\s*$/.test(line.trim())) return line;
      stats.droppedClaims++;
      stats.droppedRefs.push(`(uncited) ${line.trim().slice(0, 80)}`);
      return undefined;
    }
    let text = line;
    let kept = 0;
    // replace from the end so indices stay valid
    for (const f of [...found].reverse()) {
      const v = validateCitation(f.cite, inv, line);
      let rep = '';
      if (v.cite) {
        kept++;
        if (v.repaired) stats.repaired++;
        else stats.valid++;
        cited.add(v.cite.path);
        rep = renderCitation(v.cite, o.sha, o.linkBase);
        const open = f.raw.startsWith('(');
        const close = f.raw.endsWith(')');
        rep = `${open ? '(' : ''}${rep}${close ? ')' : ''}`;
      } else {
        stats.dropped++;
        stats.droppedRefs.push(`${citeKey(f.cite)}: ${v.reason}`);
      }
      // a dropped "(path:1)" leaves its parentheses behind; tidy below
      text = text.slice(0, f.index) + (rep || (f.raw.startsWith('(') ? '(' : '') + (f.raw.endsWith(')') ? ')' : '')) + text.slice(f.index + f.raw.length);
    }
    if (!kept) {
      stats.droppedClaims++;
      return undefined;
    }
    return text.replace(/\(\s*\)/g, '').replace(/\s+([.,;])/g, '$1').replace(/[ \t]+$/, '');
  }
  return { text: out.join('\n'), stats, cited };
}
