/**
 * R15 file-localisation eval on real repositories: given an issue, which files
 * does the agent need? Instances come from SWE-bench-style rows (repo,
 * base_commit, problem_statement, gold patch); the expected files are the files
 * the gold patch changes. Each method ranks files from the issue text alone:
 *
 *   repomap  D7 repo map personalised to the issue (its full file ranking)
 *   nav      N3 navigation without a server: identifiers in the issue resolved
 *            to their definitions by tree-sitter/regex name matching
 *   bm25     N2 keyword search over definition chunks
 *   hybrid   N2 BM25 + embeddings (only with an embedder)
 *   fused    reciprocal-rank fusion of repomap + bm25 (+ nav)
 *
 * Scores: hit@k (any expected file in the top k) and recall@k (share of the
 * expected files in the top k), k = 1, 5, 10. Repositories are cloned once
 * (blob-less) into a cache and checked out at each instance's base commit; the
 * repo-map cache and the code index are incremental, so a checkout only
 * reparses the files that differ.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../../config.js';
import { buildRepoMap } from '../repomap.js';
import { embedderSpec, type EmbedderSpec } from './config.js';
import { CodeIndex } from './codeIndex.js';
import { indexDir } from './key.js';
import { visibility } from './files.js';
import { rankDefinitions, symbolTable } from '../../nav/fallback.js';

export interface RepoInstance {
  id: string;
  repo: string;
  baseCommit: string;
  problem: string;
  /** files changed by the gold patch */
  files: string[];
}

export type Method = 'repomap' | 'nav' | 'bm25' | 'hybrid' | 'fused';
export const KS = [1, 5, 10] as const;

export interface InstanceResult {
  id: string;
  repo: string;
  expect: string[];
  ranked: Partial<Record<Method, string[]>>;
  seconds: Partial<Record<Method | 'checkout' | 'index', number>>;
  files: number;
  reparsed: number;
}

export interface RepoEvalReport {
  dataset: string;
  instances: number;
  repos: Record<string, { instances: number; files: number }>;
  embedder?: string;
  methods: Method[];
  /** method → k → value */
  hit: Partial<Record<Method, Record<number, number>>>;
  recall: Partial<Record<Method, Record<number, number>>>;
  results: InstanceResult[];
  errors: { id: string; error: string }[];
}

/** Files a unified diff changes (`diff --git a/x b/x`). */
export function patchFiles(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2]);
  return [...out];
}

export function instancesFromRows(rows: any[]): RepoInstance[] {
  return rows
    .map((r) => ({ id: r.instance_id, repo: r.repo, baseCommit: r.base_commit, problem: String(r.problem_statement ?? ''), files: patchFiles(String(r.patch ?? '')) }))
    .filter((r) => r.id && r.repo && r.baseCommit && r.files.length);
}

/** Rows from the Hugging Face datasets server (network). */
export async function fetchRows(dataset: string, max: number, fetchFn: typeof fetch = fetch): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; rows.length < max; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=test&offset=${offset}&length=${Math.min(100, max - rows.length)}`;
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const j: any = await r.json();
    const got = (j.rows ?? []).map((x: any) => x.row);
    rows.push(...got);
    if (got.length < 100) break;
  }
  return rows;
}

/** Pick up to `perRepo` instances of each wanted repo (in dataset order). */
export function selectInstances(all: RepoInstance[], repos: string[] | undefined, perRepo: number): RepoInstance[] {
  const count = new Map<string, number>();
  return all.filter((i) => {
    if (repos?.length && !repos.includes(i.repo)) return false;
    const n = count.get(i.repo) ?? 0;
    if (n >= perRepo) return false;
    count.set(i.repo, n + 1);
    return true;
  });
}

const git = (cwd: string, args: string[], timeout = 600_000) => execFileSync('git', ['-c', 'advice.detachedHead=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();

/** The repository at `commit` (cloned once into `cacheRoot`, blob-less). `source` overrides the clone URL (tests: a local path). */
export function checkout(cacheRoot: string, repo: string, commit: string, source?: string): string {
  const dir = path.join(cacheRoot, repo.replace('/', '__'));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const url = source ?? `https://github.com/${repo}.git`;
    execFileSync('git', ['clone', '--quiet', '--no-checkout', ...(source ? [] : ['--filter=blob:none']), url, dir], { timeout: 1_800_000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  try {
    git(dir, ['checkout', '--quiet', '--force', commit]);
  } catch {
    git(dir, ['fetch', '--quiet', 'origin', commit]);
    git(dir, ['checkout', '--quiet', '--force', commit]);
  }
  git(dir, ['clean', '-qfdx']);
  return dir;
}

const STOP = new Set('this that with from have when then they what which there their would should could about into after before other some such than only also more most self none true false null class def return import none error value type list dict name file line test case none code issue bug'.split(' '));

/** Identifiers an issue mentions: `backticked`, CamelCase, snake_case, dotted.paths (each part). */
export function issueIdentifiers(text: string): string[] {
  const out = new Map<string, number>();
  const add = (w: string, weight: number) => {
    if (w.length < 4 || STOP.has(w.toLowerCase()) || /^\d/.test(w)) return;
    out.set(w, Math.max(out.get(w) ?? 0, weight));
  };
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) for (const w of m[1].matchAll(/[A-Za-z_][\w]*/g)) add(w[0], 3);
  for (const m of text.matchAll(/\b[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+\b/g)) for (const w of m[0].split('.')) add(w, 2);
  for (const m of text.matchAll(/\b(?:[a-z]+_[a-z_\d]+|[A-Z][a-z\d]+(?:[A-Z][a-z\d]*)+|[a-z]+(?:[A-Z][a-z\d]*)+)\b/g)) add(m[0], 2);
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

/** Paths an issue names literally (`django/db/models/query.py`, `query.py`). */
function mentionedPaths(text: string, files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (text.includes(f)) out.push(f);
  }
  return out;
}

/** N3 navigation ranking: issue identifiers → their definitions (rarer names weigh more). */
async function navRank(ws: string, problem: string, visible: (abs: string) => boolean): Promise<string[]> {
  const table = await symbolTable(ws, visible, 0);
  const score = new Map<string, number>();
  const ids = issueIdentifiers(problem).slice(0, 40);
  for (const id of ids) {
    const defs = rankDefinitions(table, id);
    if (!defs.length || defs.length > 25) continue;
    const files = [...new Set(defs.map((d) => d.file.rel))];
    for (const f of files) score.set(f, (score.get(f) ?? 0) + 1 / files.length);
  }
  for (const f of mentionedPaths(problem, table.map((t) => t.rel))) score.set(f, (score.get(f) ?? 0) + 5);
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
}

function rrf(lists: string[][], k = 60): string[] {
  const s = new Map<string, number>();
  for (const l of lists) l.forEach((f, i) => s.set(f, (s.get(f) ?? 0) + 1 / (k + i + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
}

export interface RepoEvalOptions {
  /** clone cache (default <homeDir>/eval-repos) */
  cacheRoot?: string;
  /** repo → clone source (tests: local paths) */
  sources?: Record<string, string>;
  embedder?: EmbedderSpec;
  onProgress?: (m: string) => void;
  dataset?: string;
}

export async function runRepoEval(cfg: HarnessConfig, instances: RepoInstance[], o: RepoEvalOptions = {}): Promise<RepoEvalReport> {
  const cacheRoot = o.cacheRoot ?? path.join(cfg.homeDir, 'eval-repos');
  const emb = o.embedder ?? embedderSpec(cfg);
  const methods: Method[] = ['repomap', 'nav', 'bm25', ...(emb ? (['hybrid'] as Method[]) : []), 'fused'];
  const results: InstanceResult[] = [];
  const errors: { id: string; error: string }[] = [];
  const repos: RepoEvalReport['repos'] = {};
  for (const inst of instances) {
    try {
      const t0 = Date.now();
      o.onProgress?.(`${inst.id}: checkout ${inst.repo}@${inst.baseCommit.slice(0, 10)}`);
      const ws = checkout(cacheRoot, inst.repo, inst.baseCommit, o.sources?.[inst.repo]);
      const seconds: InstanceResult['seconds'] = { checkout: (Date.now() - t0) / 1000 };
      const visible = visibility(ws);
      const ranked: InstanceResult['ranked'] = {};
      let t = Date.now();
      const map = await buildRepoMap(ws, { tokens: 2000, focusText: inst.problem, cacheDir: indexDir(cfg.homeDir, ws), exclude: [] });
      ranked.repomap = map.ranked ?? map.files;
      seconds.repomap = (Date.now() - t) / 1000;
      t = Date.now();
      ranked.nav = await navRank(ws, inst.problem, visible);
      seconds.nav = (Date.now() - t) / 1000;
      t = Date.now();
      const idx = new CodeIndex(ws, indexDir(cfg.homeDir, ws));
      const st = await idx.update({ visible, embedder: emb, maxFiles: 0 });
      seconds.index = (Date.now() - t) / 1000;
      t = Date.now();
      const files = async (e?: EmbedderSpec) => (await idx.search(inst.problem, { k: 10, perFile: 1, embedder: e })).hits.map((h) => h.chunk.rel);
      ranked.bm25 = await files(undefined);
      seconds.bm25 = (Date.now() - t) / 1000;
      if (emb) ranked.hybrid = await files(emb);
      ranked.fused = rrf([ranked.repomap.slice(0, 50), ranked.bm25, ranked.nav.slice(0, 50)]);
      // keep the report small: the top 20 per method is all any metric reads
      for (const m of Object.keys(ranked) as Method[]) ranked[m] = ranked[m]!.slice(0, 20);
      results.push({ id: inst.id, repo: inst.repo, expect: inst.files, ranked, seconds, files: map.scan?.files ?? map.totalFiles, reparsed: map.scan?.reparsed ?? 0 });
      repos[inst.repo] = { instances: (repos[inst.repo]?.instances ?? 0) + 1, files: Math.max(repos[inst.repo]?.files ?? 0, st.files) };
      o.onProgress?.(`${inst.id}: ${inst.files.join(', ')} → repomap ${rankOf(ranked.repomap, inst.files)}, nav ${rankOf(ranked.nav, inst.files)}, bm25 ${rankOf(ranked.bm25, inst.files)} (index: ${st.files} files, ${st.changedFiles} re-chunked; repo map: ${map.scan?.files ?? '?'} source files, ${map.scan?.reparsed ?? '?'} reparsed)`);
    } catch (e) {
      errors.push({ id: inst.id, error: (e as Error).message.split('\n')[0] });
      o.onProgress?.(`${inst.id}: error ${(e as Error).message.split('\n')[0]}`);
    }
  }
  const hit: RepoEvalReport['hit'] = {};
  const recall: RepoEvalReport['recall'] = {};
  for (const m of methods) {
    hit[m] = {};
    recall[m] = {};
    for (const k of KS) {
      const rs = results.filter((r) => r.ranked[m]);
      hit[m]![k] = rs.length ? rs.filter((r) => r.ranked[m]!.slice(0, k).some((f) => r.expect.includes(f))).length / rs.length : 0;
      recall[m]![k] = rs.length ? rs.reduce((a, r) => a + r.expect.filter((f) => r.ranked[m]!.slice(0, k).includes(f)).length / r.expect.length, 0) / rs.length : 0;
    }
  }
  return { dataset: o.dataset ?? 'custom', instances: results.length, repos, embedder: emb ? `${emb.model} @ ${emb.baseUrl}` : undefined, methods, hit, recall, results, errors };
}

function rankOf(list: string[], expect: string[]): string {
  const i = list.findIndex((f) => expect.includes(f));
  return i < 0 ? '–' : `#${i + 1}`;
}

const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(0)} %`);

export function formatRepoEval(r: RepoEvalReport): string {
  const label: Record<Method, string> = { repomap: 'repo map (D7, personalised)', nav: 'navigation (N3 name matching)', bm25: 'BM25 (N2)', hybrid: 'hybrid BM25 + embeddings (N2)', fused: 'fused: repo map + BM25 + navigation (RRF)' };
  return [
    `# File localisation on real repositories (R15): ${r.instances} issues, ${Object.keys(r.repos).length} repos`,
    '',
    `Dataset: ${r.dataset}. Embedder: ${r.embedder ?? 'none (hybrid not run)'}.`,
    '',
    '| method | hit@1 | hit@5 | hit@10 | recall@5 | recall@10 |',
    '|---|---|---|---|---|---|',
    ...r.methods.map((m) => `| ${label[m]} | ${pct(r.hit[m]?.[1])} | ${pct(r.hit[m]?.[5])} | ${pct(r.hit[m]?.[10])} | ${pct(r.recall[m]?.[5])} | ${pct(r.recall[m]?.[10])} |`),
    '',
    'hit@k: any file of the gold patch in the top k; recall@k: share of the gold patch files in the top k.',
    '',
    '| repo | issues | files indexed |',
    '|---|---|---|',
    ...Object.entries(r.repos).map(([n, v]) => `| ${n} | ${v.instances} | ${v.files} |`),
    ...(r.errors.length ? ['', 'Errors:', ...r.errors.map((e) => `- ${e.id}: ${e.error}`)] : []),
    '',
  ].join('\n');
}
