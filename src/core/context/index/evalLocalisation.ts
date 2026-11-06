/**
 * N2 file-localisation eval: natural-language queries → the files that answer
 * them, scored as recall@5 (a hit when any expected file is among the top 5
 * distinct files) and MRR, for keyword-only (BM25) and hybrid ranking. The
 * review asked to "introduce embeddings only if they improve those tests":
 * this is the measurement (`tug index eval`).
 *
 * Queries file:
 *   { "repos": { "self": ".", "fixture": "evals/localisation/fixture" },
 *     "queries": [ { "repo": "fixture", "query": "…", "expect": ["billing/invoice.py"] } ] }
 * Repo paths are relative to the queries file's directory's repo root (the cwd).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../../config.js';
import { embedderSpec, searchConfig } from './config.js';
import { CodeIndex, indexDir } from './codeIndex.js';
import { visibility } from './files.js';

export interface LocalisationQuery {
  repo: string;
  query: string;
  expect: string[];
}

export interface QueryResult {
  repo: string;
  query: string;
  expect: string[];
  bm25: string[];
  hybrid?: string[];
  bm25Hit: boolean;
  hybridHit?: boolean;
}

export interface EvalReport {
  queries: number;
  embedder?: string;
  recallAt5: { bm25: number; hybrid?: number };
  mrr: { bm25: number; hybrid?: number };
  perRepo: Record<string, { queries: number; bm25: number; hybrid?: number }>;
  results: QueryResult[];
  indexSeconds: Record<string, number>;
  embedError?: string;
}

const rank = (files: string[], expect: string[]) => {
  const i = files.findIndex((f) => expect.includes(f));
  return i < 0 ? 0 : 1 / (i + 1);
};

export async function runLocalisationEval(cfg: HarnessConfig, queriesFile: string, o: { onProgress?: (m: string) => void; homeDir?: string } = {}): Promise<EvalReport> {
  const spec = JSON.parse(fs.readFileSync(queriesFile, 'utf8')) as { repos: Record<string, string>; queries: LocalisationQuery[] };
  const root = process.cwd();
  const emb = embedderSpec(cfg);
  const s = searchConfig(cfg);
  const home = o.homeDir ?? cfg.homeDir;
  const indexes = new Map<string, CodeIndex>();
  const indexSeconds: Record<string, number> = {};
  let embedError: string | undefined;
  for (const [name, rel] of Object.entries(spec.repos)) {
    const ws = path.resolve(root, rel);
    const idx = new CodeIndex(ws, indexDir(home, ws));
    // the eval's own fixture lives inside this repo: only exclude it when indexing the outer repo
    const exclude = name === 'self' ? s.exclude : s.exclude.filter((g) => !g.includes('fixture'));
    o.onProgress?.(`indexing ${name} (${ws})…`);
    const st = await idx.update({ visible: visibility(ws), embedder: emb, maxFiles: s.maxFiles, exclude });
    if (st.embedError) embedError = st.embedError;
    indexSeconds[name] = st.ms / 1000;
    indexes.set(name, idx);
  }
  const results: QueryResult[] = [];
  for (const q of spec.queries) {
    const idx = indexes.get(q.repo);
    if (!idx) throw new Error(`query "${q.query}": unknown repo ${q.repo}`);
    const files = async (embedder?: typeof emb) => (await idx.search(q.query, { k: 5, perFile: 1, embedder })).hits.map((h) => h.chunk.rel);
    const bm25 = await files(undefined);
    const hybrid = emb ? await files(emb) : undefined;
    results.push({ repo: q.repo, query: q.query, expect: q.expect, bm25, hybrid, bm25Hit: bm25.some((f) => q.expect.includes(f)), hybridHit: hybrid?.some((f) => q.expect.includes(f)) });
  }
  const frac = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : 0);
  const perRepo: EvalReport['perRepo'] = {};
  for (const name of Object.keys(spec.repos)) {
    const rs = results.filter((r) => r.repo === name);
    perRepo[name] = { queries: rs.length, bm25: frac(rs.map((r) => r.bm25Hit)), hybrid: emb ? frac(rs.map((r) => !!r.hybridHit)) : undefined };
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    queries: results.length,
    embedder: emb ? `${emb.model} @ ${emb.baseUrl}` : undefined,
    recallAt5: { bm25: frac(results.map((r) => r.bm25Hit)), hybrid: emb ? frac(results.map((r) => !!r.hybridHit)) : undefined },
    mrr: { bm25: mean(results.map((r) => rank(r.bm25, r.expect))), hybrid: emb ? mean(results.map((r) => rank(r.hybrid ?? [], r.expect))) : undefined },
    perRepo,
    results,
    indexSeconds,
    embedError,
  };
}

const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(0)} %`);

export function formatEvalReport(r: EvalReport): string {
  const lines = [
    `# File localisation (N2): ${r.queries} queries`,
    '',
    `Embedder: ${r.embedder ?? 'none (BM25 only)'}${r.embedError ? ` — error: ${r.embedError}` : ''}`,
    '',
    '| | recall@5 | MRR |',
    '|---|---|---|',
    `| BM25 | ${pct(r.recallAt5.bm25)} | ${r.mrr.bm25.toFixed(2)} |`,
    `| hybrid (BM25 + embeddings, RRF) | ${pct(r.recallAt5.hybrid)} | ${r.mrr.hybrid?.toFixed(2) ?? '—'} |`,
    '',
    '| repo | queries | BM25 recall@5 | hybrid recall@5 | index time |',
    '|---|---|---|---|---|',
    ...Object.entries(r.perRepo).map(([n, v]) => `| ${n} | ${v.queries} | ${pct(v.bm25)} | ${pct(v.hybrid)} | ${(r.indexSeconds[n] ?? 0).toFixed(1)} s |`),
    '',
    'Misses (expected → top 5):',
    ...r.results.filter((x) => !x.bm25Hit || x.hybridHit === false).map((x) => `- [${x.repo}] "${x.query}" → expected ${x.expect.join(' | ')}; BM25 ${x.bm25Hit ? '✓' : '✗'}${x.hybrid ? `; hybrid ${x.hybridHit ? '✓' : '✗'} (${x.hybrid.slice(0, 3).join(', ')})` : ` (${x.bm25.slice(0, 3).join(', ')})`}`),
  ];
  return lines.join('\n') + '\n';
}
