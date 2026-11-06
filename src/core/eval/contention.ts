/**
 * Shared-server contention runs (v1.1 R18). A pilot measures every arm twice:
 * on a quiet endpoint, and on a shared one. This load generator plays the
 * "other users": N concurrent clients that keep sending chat completions to
 * the same endpoint for as long as the benchmark runs. Each run's manifest
 * records the condition (name, clients, requests and errors so far), so the
 * paired report compares arms within one condition and shows how much each
 * arm degrades under load.
 */
export interface LoadOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  clients: number;
  /** Prompt size per request (approximate tokens; default 1500) and generation cap (default 256). */
  promptTokens?: number;
  maxTokens?: number;
  fetchFn?: typeof fetch;
}

export interface LoadGenerator {
  stats: { requests: number; errors: number; clients: number };
  stop: () => Promise<void>;
}

const FILLER = 'The quick brown fox jumps over the lazy dog while the build server compiles the release branch. ';

export function startLoad(o: LoadOptions): LoadGenerator {
  const stats = { requests: 0, errors: 0, clients: o.clients };
  let stopped = false;
  const ctl = new AbortController();
  const f = o.fetchFn ?? fetch;
  // ~4 characters per token: a realistic, cache-unfriendly prompt per client.
  const body = (i: number, n: number) =>
    JSON.stringify({
      model: o.model,
      max_tokens: o.maxTokens ?? 256,
      stream: false,
      messages: [
        { role: 'system', content: `You are load client ${i}. Request ${n}.` },
        { role: 'user', content: `${FILLER.repeat(Math.max(1, Math.round(((o.promptTokens ?? 1500) * 4) / FILLER.length)))}\nSummarise the text above in three sentences.` },
      ],
    });
  const url = `${o.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const loops = Array.from({ length: Math.max(0, o.clients) }, async (_x, i) => {
    for (let n = 0; !stopped; n++) {
      try {
        const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) }, body: body(i, n), signal: ctl.signal });
        await r.text();
        if (r.ok) stats.requests++;
        else stats.errors++;
      } catch {
        if (stopped) break;
        stats.errors++;
        await new Promise((res) => setTimeout(res, 500));
      }
    }
  });
  return {
    stats,
    stop: async () => {
      stopped = true;
      ctl.abort();
      await Promise.allSettled(loops);
    },
  };
}
