/**
 * Keyword ranking for code chunks (N2): BM25 with the D3 parameters (k1 1.2,
 * b 0.75, half-weight prefix hits; src/core/tools/search.ts), but over a
 * prebuilt inverted index, because the corpus is thousands of chunks rather
 * than a few dozen tool descriptions. Identifiers are split like D3's tokenizer
 * (camelCase, snake_case), and the path and symbol of a chunk count twice.
 */
import { tokenize } from '../../tools/search.js';

const STOP = new Set('the and for with this that from into are was were has have not but you your all any can use used uses using get set new return const let var function class def import export public private static void int string bool true false null none self this'.split(' '));

/** Code-aware tokens: D3's split plus light plural folding; common words dropped. */
export function codeTokens(s: string): string[] {
  const out: string[] = [];
  for (let t of tokenize(s)) {
    if (STOP.has(t) || /^\d+$/.test(t)) continue;
    if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

export interface Bm25Doc {
  /** strong field (path, symbol): counted twice */
  head: string;
  body: string;
}

export class Bm25Index {
  private postings = new Map<string, Map<number, number>>();
  private lens: number[] = [];
  private avg = 1;

  constructor(docs: Bm25Doc[]) {
    docs.forEach((d, i) => {
      const toks = [...codeTokens(d.head), ...codeTokens(d.head), ...codeTokens(d.body)];
      this.lens[i] = toks.length;
      for (const t of toks) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = new Map()));
        p.set(i, (p.get(i) ?? 0) + 1);
      }
    });
    this.avg = this.lens.reduce((a, b) => a + b, 0) / (this.lens.length || 1) || 1;
  }

  get size(): number {
    return this.lens.length;
  }

  /** Top `limit` documents as [index, score], best first. */
  search(query: string, limit = 50, allow?: (i: number) => boolean): [number, number][] {
    const q = [...new Set(codeTokens(query))];
    const N = this.lens.length;
    const scores = new Map<number, number>();
    const add = (term: string, weight: number) => {
      const p = this.postings.get(term);
      if (!p) return;
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5));
      for (const [i, f] of p) {
        const s = (idf * f * 2.2) / (f + 1.2 * (1 - 0.75 + (0.75 * this.lens[i]) / this.avg));
        scores.set(i, (scores.get(i) ?? 0) + s * weight);
      }
    };
    for (const w of q) {
      if (this.postings.has(w)) add(w, 1);
      // prefix match (repo → repomap) earns half a hit, as in D3
      else if (w.length >= 4) for (const k of this.postings.keys()) if (k.startsWith(w)) add(k, 0.5);
    }
    return [...scores].filter(([i]) => !allow || allow(i)).sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
}
