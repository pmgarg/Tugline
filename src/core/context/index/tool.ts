/**
 * N2 `code_search` tool and `tug index status|rebuild|eval` (registered from
 * providers.ts). The tool exists only when an embedder is configured, or when
 * keyword-only mode is opted into (`search.mode: "bm25"`), N2 AC5.
 *
 * Each call brings the index up to date first (incremental: unchanged files are
 * only stat-ed), then ranks chunks by BM25 + embedding similarity (RRF).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolDef } from '../../tools/types.js';
import { ToolError } from '../../tools/types.js';
import { registerToolProvider } from '../../tools/registry.js';
import { registerCliCommand } from '../../commands.js';
import type { HarnessConfig } from '../../config.js';
import { coreSettings } from '../settings.js';
import { embedderSpec, searchConfig, searchEnabled } from './config.js';
import { codeIndexFor, type SearchHit, type UpdateStats } from './codeIndex.js';
import { visibility, type PolicyLike } from './files.js';
import { runLocalisationEval, formatEvalReport } from './evalLocalisation.js';
import { fetchRows, formatRepoEval, instancesFromRows, runRepoEval, selectInstances } from './evalRepos.js';

const OUTPUT_CHARS = 6000;
const SNIPPET_LINES = 6;

export function homeOf(cfg: HarnessConfig): string {
  return cfg.homeDir ?? path.join(os.homedir(), '.tugline');
}

/** Update the index of `workspace` under the given policy. */
export async function updateIndex(cfg: HarnessConfig, workspace: string, policy?: PolicyLike, onProgress?: (m: string) => void, signal?: AbortSignal): Promise<UpdateStats> {
  const s = searchConfig(cfg);
  const idx = codeIndexFor(homeOf(cfg), workspace);
  const exclude = [...s.exclude, ...(coreSettings(cfg).repoMapExclude ?? [])];
  return idx.update({ visible: visibility(workspace, { policy, tool: 'code_search' }), embedder: embedderSpec(cfg), maxFiles: s.maxFiles, exclude, onProgress, signal });
}

function render(hits: SearchHit[]): string {
  const out: string[] = [];
  let used = 0;
  hits.forEach((h, n) => {
    const c = h.chunk;
    const lines = c.text.split('\n');
    const snip = lines.slice(0, SNIPPET_LINES).map((l, i) => `${String(c.startLine + i).padStart(6)}│ ${l.length > 160 ? l.slice(0, 159) + '…' : l}`);
    if (lines.length > SNIPPET_LINES) snip.push(`      │ … (${lines.length - SNIPPET_LINES} more lines, to line ${c.endLine})`);
    const s = `${n + 1}. ${c.rel}:${c.startLine}-${c.endLine}${c.symbol ? `  ${c.symbol}` : ''}\n${snip.join('\n')}`;
    if (used + s.length > OUTPUT_CHARS) return;
    out.push(s);
    used += s.length;
  });
  return out.join('\n');
}

export const codeSearchTool: ToolDef<{ query: string; k?: number; path?: string }> = {
  name: 'code_search',
  kind: 'read',
  readOnly: true,
  core: true,
  description:
    'Find code by meaning or keywords across the repository: "where is the retry backoff computed", "parse config file". ' +
    'Returns the best-matching functions/classes/sections as file:lines with a short snippet. Use it before grep when you do not know the exact identifier. ' +
    '`path` limits the search to a directory, file or glob.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language or identifiers' },
      k: { type: 'integer', description: 'Number of results (default 8, max 20)' },
      path: { type: 'string', description: 'Directory, file or glob to search in, e.g. "src/core" or "**/*.py"' },
    },
    required: ['query'],
  },
  title: (a) => `Code search "${a.query}"${a.path ? ` in ${a.path}` : ''}`,
  async run(a, ctx) {
    const query = String(a.query ?? '').trim();
    if (!query) throw new ToolError('code_search needs a query.');
    const cfg = ctx.config;
    let stats: UpdateStats;
    try {
      stats = await updateIndex(cfg, ctx.workspace, ctx.policy as unknown as PolicyLike, (m) => ctx.emit({ type: 'notice', level: 'info', message: `code index: ${m}` } as any), ctx.signal);
    } catch (e) {
      throw new ToolError(`could not build the code index: ${(e as Error).message}`);
    }
    const idx = codeIndexFor(homeOf(cfg), ctx.workspace);
    const res = await idx.search(query, { k: Math.min(Number(a.k) || searchConfig(cfg).k, 20), path: a.path, embedder: embedderSpec(cfg), signal: ctx.signal });
    const spec = embedderSpec(cfg);
    const how = res.engine === 'hybrid' ? `hybrid: BM25 + ${spec?.model} embeddings` : 'keyword (BM25)';
    const notes = [res.note, stats.embedError && `indexing: ${stats.embedError}`].filter(Boolean);
    const head = `code_search (${how}; ${stats.files} files, ${stats.chunks} chunks${stats.changedFiles ? `, ${stats.changedFiles} re-indexed` : ''})${notes.length ? `\n(note: ${notes.join('; ')})` : ''}`;
    if (!res.hits.length) return { output: `${head}\nNo matches. Try other words, an identifier, or grep.`, meta: { engine: res.engine, hits: 0 } };
    return { output: `${head}\n${render(res.hits)}`, meta: { engine: res.engine, hits: res.hits.length, files: [...new Set(res.hits.map((h) => h.chunk.rel))] } };
  },
};

/**
 * `@codebase <question>` mention (N2; the VS Code chat provider is WS2's B4
 * follow-up): the top chunks for the question as a context block, or
 * undefined when code search is not enabled (AC5: no embedder → no mention).
 */
export async function codebaseMention(cfg: HarnessConfig, workspace: string, question: string, opts: { policy?: PolicyLike; k?: number } = {}): Promise<string | undefined> {
  if (!searchEnabled(cfg)) return undefined;
  await updateIndex(cfg, workspace, opts.policy);
  const res = await codeIndexFor(homeOf(cfg), workspace).search(question, { k: opts.k ?? 6, embedder: embedderSpec(cfg) });
  if (!res.hits.length) return `<codebase query="${question.replace(/"/g, "'")}">no matches</codebase>`;
  return `<codebase query="${question.replace(/"/g, "'")}" ranking="${res.engine}">\n${render(res.hits)}\n</codebase>`;
}

registerToolProvider({
  id: 'codeindex',
  tools(cfg) {
    return searchEnabled(cfg) ? [codeSearchTool] : [];
  },
});

// ------------------------------------------------------------ tug index

async function indexCommand(argv: string[], ctx: { config: HarnessConfig; workspace: string; write: (t: string) => void }): Promise<number> {
  const [sub = 'status', ...rest] = argv;
  const cfg = ctx.config;
  const idx = codeIndexFor(homeOf(cfg), ctx.workspace);
  const spec = embedderSpec(cfg);
  if (sub === 'status') {
    const s = idx.size;
    ctx.write(
      [
        `index: ${idx.dir}`,
        `mode: ${searchEnabled(cfg) ?? 'off (configure search.embeddings.profile, or search.mode "bm25")'}${spec ? ` (embedder ${spec.model} at ${spec.baseUrl})` : ''}`,
        `files: ${s.files}  chunks: ${s.chunks}  vectors: ${s.vectors}${s.dim ? ` × ${s.dim}` : ''}  updated: ${s.updatedAt || 'never'}`,
      ].join('\n'),
    );
    return 0;
  }
  if (sub === 'rebuild' || sub === 'update') {
    if (sub === 'rebuild') idx.clear();
    const st = await updateIndex(cfg, ctx.workspace, undefined, (m) => ctx.write(m));
    ctx.write(`indexed ${st.files} files → ${st.chunks} chunks (${st.vectors} vectors) in ${(st.ms / 1000).toFixed(1)} s${st.embedError ? `\nwarning: ${st.embedError}` : ''}`);
    return st.embedError ? 1 : 0;
  }
  if (sub === 'eval') {
    const file = rest.find((a) => !a.startsWith('--')) ?? path.join('evals', 'localisation', 'queries.json');
    const out = rest.includes('--out') ? rest[rest.indexOf('--out') + 1] : undefined;
    const report = await runLocalisationEval(cfg, path.resolve(ctx.workspace, file), { onProgress: (m) => ctx.write(m) });
    const md = formatEvalReport(report);
    ctx.write(md);
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'localisation.md'), md);
      fs.writeFileSync(path.join(out, 'localisation.json'), JSON.stringify(report, null, 2));
    }
    return 0;
  }
  if (sub === 'eval-repos') {
    const flag = (n: string) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
    const ds = flag('--dataset') ?? 'multilingual';
    const dataset = ds === 'lite' ? 'princeton-nlp/SWE-bench_Lite' : ds === 'multilingual' ? 'SWE-bench/SWE-bench_Multilingual' : ds;
    const repos = flag('--repos')?.split(',').filter(Boolean);
    const perRepo = Number(flag('--per-repo') ?? 5);
    const rowsFile = flag('--rows');
    const rows = rowsFile ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : await fetchRows(dataset, 2500);
    const instances = selectInstances(instancesFromRows(rows), repos, perRepo);
    ctx.write(`${instances.length} instance(s) from ${dataset}`);
    const report = await runRepoEval(cfg, instances, { dataset, onProgress: (m) => ctx.write(m), cacheRoot: flag('--cache') });
    const md = formatRepoEval(report);
    ctx.write(md);
    const out = flag('--out');
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'localisation-repos.md'), md);
      fs.writeFileSync(path.join(out, 'localisation-repos.json'), JSON.stringify(report, null, 2));
    }
    return report.errors.length && !report.instances ? 1 : 0;
  }
  ctx.write('usage: tug index status | update | rebuild | eval [queries.json] [--out dir] | eval-repos [--dataset lite|multilingual|<hf id>] [--repos owner/a,owner/b] [--per-repo N] [--rows rows.jsonl] [--cache dir] [--out dir]');
  return 2;
}

registerCliCommand({ name: 'index', description: 'local code search index (N2): status, update, rebuild, eval', usage: 'status | update | rebuild | eval [queries.json] [--out dir] | eval-repos [--dataset …] [--repos …] [--per-repo N] [--out dir]', needsModel: false, run: (argv, ctx) => indexCommand(argv, ctx) });
