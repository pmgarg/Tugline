/**
 * `search` config section (N2 local semantic code search), declaration-merged.
 *
 *   "profiles": { "embed": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" } },
 *   "search": { "embeddings": { "profile": "embed" } }
 *
 * `code_search` is exposed only when an embedder is configured (hybrid BM25 +
 * embeddings), or when `search.mode` is "bm25" (keyword-only, opt-in; N2 AC5).
 * A configured embedder that is unreachable degrades to BM25 with a note.
 */
import type { HarnessConfig } from '../../config.js';
import type { ModelProfile } from '../../types.js';

export interface EmbeddingsConfig {
  /** Profile (in `profiles`) with the /embeddings endpoint: baseUrl, apiKey, model, headers, timeoutMs */
  profile?: string;
  /** Or inline: */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** chunks per /embeddings request */
  batchSize: number;
  timeoutMs: number;
  /** prefixes some models expect (e.g. nomic: "search_query: " / "search_document: ") */
  queryPrefix?: string;
  documentPrefix?: string;
}

export interface SearchConfig {
  /** auto: exposed when an embedder is configured; bm25: keyword-only (opt-in); off: never */
  mode: 'auto' | 'bm25' | 'off';
  embeddings: EmbeddingsConfig;
  /** max files indexed; 0 = no limit */
  maxFiles: number;
  /** glob exclusions (workspace-relative); .tuglineignore, secret files and the read policy always apply */
  exclude: string[];
  /** results returned by default (k) */
  k: number;
}

export const DEFAULT_SEARCH: SearchConfig = {
  mode: 'auto',
  embeddings: { batchSize: 32, timeoutMs: 60_000 },
  maxFiles: 20_000,
  exclude: ['**/evals/**/tasks/**', '**/evals/**/fixture/**', 'docs/evidence/**', '**/package-lock.json', '**/*.lock'],
  k: 8,
};

declare module '../../config.js' {
  interface HarnessConfigExtensions {
    search?: Partial<Omit<SearchConfig, 'embeddings'>> & { embeddings?: Partial<EmbeddingsConfig> };
  }
}

export function searchConfig(cfg: Pick<HarnessConfig, 'search'> | undefined): SearchConfig {
  const s = cfg?.search ?? {};
  return { ...DEFAULT_SEARCH, ...s, embeddings: { ...DEFAULT_SEARCH.embeddings, ...(s.embeddings ?? {}) }, exclude: s.exclude ?? DEFAULT_SEARCH.exclude };
}

export interface EmbedderSpec {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  batchSize: number;
  queryPrefix: string;
  documentPrefix: string;
}

/** The embedder, or undefined when none is configured. */
export function embedderSpec(cfg: HarnessConfig): EmbedderSpec | undefined {
  const e = searchConfig(cfg).embeddings;
  const prof: Partial<ModelProfile> | undefined = e.profile ? cfg.profiles?.[e.profile] : undefined;
  if (e.profile && !prof) return undefined;
  const baseUrl = e.baseUrl ?? prof?.baseUrl;
  const model = e.model ?? prof?.model;
  if (!baseUrl || !model) return undefined;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: e.apiKey ?? prof?.apiKey,
    headers: prof?.headers,
    timeoutMs: e.timeoutMs ?? prof?.timeoutMs ?? 60_000,
    batchSize: Math.max(1, Math.min(256, e.batchSize || 32)),
    queryPrefix: e.queryPrefix ?? (/nomic-embed/i.test(model) ? 'search_query: ' : ''),
    documentPrefix: e.documentPrefix ?? (/nomic-embed/i.test(model) ? 'search_document: ' : ''),
  };
}

/** Is `code_search` exposed for this config (N2 AC5)? */
export function searchEnabled(cfg: HarnessConfig): 'hybrid' | 'bm25' | undefined {
  const s = searchConfig(cfg);
  if (s.mode === 'off') return undefined;
  if (embedderSpec(cfg)) return 'hybrid';
  return s.mode === 'bm25' ? 'bm25' : undefined;
}
