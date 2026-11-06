/**
 * WS12: the model the docs features use, and what fits in its context.
 *
 * Plain chat completions, no tools: works with any OpenAI-compatible server,
 * including small Ollama models in text mode. The context budget follows WS9:
 * for an Ollama endpoint the context Ollama really runs (cache or /api) caps
 * the configured `contextWindow`, so map-reduce chunks never get truncated.
 */
import type { HarnessConfig } from '../config.js';
import { resolveProfile } from '../config.js';
import { LLMClient } from '../llm/client.js';
import { effectiveContext, looksLikeOllamaUrl, ollamaModelInfo } from '../llm/ollama.js';
import { readOllamaCache, writeOllamaCache } from '../llm/overlays.js';
import type { ModelProfile, Usage } from '../types.js';
import { docsConfig } from './config.js';

export interface DocsModel {
  client: LLMClient;
  profile: ModelProfile;
  /** usable context in tokens (after Ollama detection) */
  context: number;
  usage: { calls: number; promptTokens: number; completionTokens: number };
  /** one plain completion; returns the visible text */
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

/** Profile for docs work: `docs.profile`, else `routing.explore`, else the main profile. */
export function docsProfileName(cfg: HarnessConfig): string {
  const d = docsConfig(cfg).profile;
  const explore = (cfg as { routing?: { explore?: string } }).routing?.explore;
  return d && cfg.profiles[d] ? d : explore && cfg.profiles[explore] ? explore : cfg.profile;
}

async function contextFor(p: ModelProfile, homeDir: string): Promise<number> {
  let info = readOllamaCache(homeDir, p);
  if (!info && looksLikeOllamaUrl(p.baseUrl)) {
    info = await ollamaModelInfo(p.baseUrl, p.model, { timeoutMs: 3000 }).catch(() => undefined);
    if (info?.isOllama) writeOllamaCache(homeDir, p, info);
  }
  const eff = info?.isOllama ? effectiveContext(info) : undefined;
  return eff && eff < p.contextWindow ? eff : p.contextWindow;
}

export async function docsModel(cfg: HarnessConfig, o: { client?: LLMClient; log?: (m: string) => void } = {}): Promise<DocsModel> {
  const profile = o.client?.profile ?? resolveProfile(cfg, docsProfileName(cfg));
  const client = o.client ?? new LLMClient(profile, (_l, m) => o.log?.(m));
  const context = await contextFor(profile, cfg.homeDir);
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  const add = (u: Usage) => {
    usage.calls++;
    usage.promptTokens += u.promptTokens;
    usage.completionTokens += u.completionTokens;
  };
  return {
    client,
    profile,
    context,
    usage,
    async complete(system, user, maxTokens = 1200) {
      const res = await client.complete({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, temperature: 0.1, noStream: false });
      add(res.usage);
      return res.text.trim();
    },
  };
}

/** Characters of source that fit one map call: ~40 % of the context (prompt, outline and answer take the rest). */
export function chunkChars(context: number): number {
  return Math.max(2000, Math.floor(context * 0.4 * 3.5));
}
