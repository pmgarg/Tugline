/**
 * Tool search and deferred schemas (SPEC D3).
 *
 * With many tools (MCP servers, browser/desktop automation) the schemas alone
 * can eat a small model's window and every added schema shifts the prompt
 * prefix. When tool search is active the agent sends only the core tools plus
 * `tool_search`; other tools are listed by name in the system prompt and their
 * schemas are loaded on demand. Activated tools are appended at the END of the
 * tool list so the cached prefix (system prompt + earlier tools) stays valid.
 *
 * Ranking is BM25 over the tool name (split on _ . - and camelCase) and
 * description. `select:a,b` loads exact names, like Claude Code's ToolSearch.
 */
import type { ToolDef } from './types.js';
import { ToolError } from './types.js';

/** Tools that are always sent in full when tool search is active. */
export const CORE_TOOL_NAMES = ['read_file', 'list_dir', 'glob', 'grep', 'edit_file', 'multi_edit', 'apply_patch', 'write_file', 'bash', 'todo_write', 'load_skill', 'task', 'ask_user', 'exit_plan_mode', 'web_search', 'web_fetch'];

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export interface SearchDoc {
  name: string;
  description: string;
}

/** BM25 (k1 = 1.2, b = 0.75). The name is counted twice: it is the strongest signal. */
export function bm25Rank<T extends SearchDoc>(docs: T[], query: string, limit = 5): { doc: T; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => {
    const nameToks = tokenize(d.name);
    return [...nameToks, ...nameToks, ...tokenize(d.description)];
  });
  const avg = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  const scored = docs.map((doc, i) => {
    const tf = new Map<string, number>();
    for (const w of toks[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      // prefix match (weath → weather) earns a fraction of a hit
      const pf = f || (w.length >= 4 ? [...tf.keys()].filter((k) => k.startsWith(w)).reduce((a, k) => a + (tf.get(k) ?? 0), 0) * 0.5 : 0);
      if (!pf) continue;
      const n = df.get(w) ?? 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * pf * 2.2) / (pf + 1.2 * (1 - 0.75 + (0.75 * toks[i].length) / avg));
    }
    // exact name hit wins outright
    if (doc.name.toLowerCase() === query.trim().toLowerCase()) score += 100;
    return { doc, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

export interface ToolSearchHost {
  /** Deferred tools that are not active yet. */
  deferred(): ToolDef[];
  /** Activate tools (appended at the end of the tool list, persists for the session). */
  activate(names: string[]): void;
}

/** The model-facing `tool_search` tool, bound to one agent. */
export function makeToolSearchTool(host: ToolSearchHost): ToolDef<{ query: string; limit?: number }> {
  return {
    name: 'tool_search',
    kind: 'meta',
    readOnly: false,
    description:
      'Load tools that are listed under "Deferred tools" in your instructions. Their schemas are not loaded until you search. ' +
      'Pass keywords (e.g. "weather forecast", "browser click") or "select:name1,name2" for exact names. ' +
      'Matching tools are returned with their parameters and become callable immediately for the rest of the session.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, or select:<tool_name>[,<tool_name>…]' },
        limit: { type: 'integer', description: 'Max tools to load (default 5)' },
      },
      required: ['query'],
    },
    title: (a) => `Search tools: ${a.query}`,
    async run(a) {
      const query = String(a.query ?? '').trim();
      if (!query) throw new ToolError('query is required');
      const pool = host.deferred();
      let hits: ToolDef[];
      if (query.startsWith('select:')) {
        const names = query.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
        const same = (t: ToolDef, n: string) => t.name.toLowerCase() === n.toLowerCase() || t.name.toLowerCase().endsWith(`__${n.toLowerCase()}`);
        hits = names.map((n) => pool.find((t) => same(t, n))).filter((t): t is ToolDef => !!t);
        const missing = names.filter((n) => !hits.some((t) => same(t, n)));
        if (!hits.length) throw new ToolError(`no deferred tool named ${missing.join(', ')}. ${pool.length ? `Deferred tools: ${pool.map((t) => t.name).slice(0, 60).join(', ')}` : 'All tools are already loaded.'}`);
      } else {
        hits = bm25Rank(pool, query, Math.max(1, Math.min(Number(a.limit) || 5, 15))).map((r) => r.doc);
        if (!hits.length) return { output: `No deferred tool matches "${query}". ${pool.length ? `Deferred tools: ${pool.map((t) => t.name).slice(0, 60).join(', ')}` : 'All tools are already loaded.'}` };
      }
      host.activate(hits.map((t) => t.name));
      const body = hits.map((t) => `## ${t.name}\n${t.description}\nparameters: ${JSON.stringify(t.parameters)}`).join('\n\n');
      return { output: `Loaded ${hits.length} tool(s); you can call them now:\n\n${body}`, meta: { activated: hits.map((t) => t.name) } };
    },
  };
}
