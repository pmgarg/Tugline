/**
 * Prompt-cache hints at the edge of the client (v1.1 N10).
 *
 * On local hardware prompt processing dominates: llama.cpp (`cache_prompt`),
 * vLLM (automatic prefix caching) and SGLang reuse only an exact token prefix,
 * so one miss on a 20K prefix costs minutes at ~10 prompt tok/s. This module
 * does the request side of that:
 *
 *  - **cached tokens.** Servers report reuse differently: OpenAI/vLLM
 *    `usage.prompt_tokens_details.cached_tokens`, Anthropic-style gateways
 *    `cache_read_input_tokens`, llama.cpp `timings.cache_n` (newer builds also
 *    fill `prompt_tokens_details`). `cachedTokensFrom` normalises them;
 *    `undefined` means "the server did not say", which UIs show as "not
 *    reported" rather than 0 %.
 *  - **llama.cpp slots.** llama-server keeps one KV cache per slot
 *    (`--parallel N`). Without `id_slot` a request lands on any idle slot, so a
 *    subagent or a background summary can evict the main agent's 20K prefix.
 *    For the llama.cpp dialect (probe-detected via `/props`, seen passively in
 *    `timings`, or set as `profile.server`) each agent sends a distinct,
 *    stable `id_slot` and `cache_prompt: true`. The assignment is per server
 *    URL and per process: primary agents (depth 0) count up from slot 0,
 *    everything else (subagents, then the shared "aux" key used by summaries
 *    and other helper calls) counts down from the last slot, wrapping when
 *    there are more agents than slots. `id_slot` is only sent when the slot
 *    count is known (an out-of-range id is an error); a server that rejects it
 *    is healed by dropping the field (client.ts).
 *
 * Nothing here sends a request: `detectServer` is called by the probe only.
 */
import type { ModelProfile } from '../types.js';

export type ServerKind = 'llamacpp' | 'vllm' | 'sglang' | 'ollama' | 'other';

export interface LlamaCppOptions {
  /** Send `cache_prompt` (default true). false sends `cache_prompt: false` explicitly (the A/B arm of N10 AC4). */
  cachePrompt?: boolean;
  /** Pin each agent to its own slot with `id_slot` (default true; needs `slots`). */
  pinSlots?: boolean;
  /** Number of server slots (`--parallel`); filled from `/props` `total_slots` by the probe. */
  slots?: number;
}

declare module '../types.js' {
  interface ModelProfileExtensions {
    /** N10: the server software behind `baseUrl` (probe-detected and cached, or set by hand). */
    server?: ServerKind;
    /** N10: llama.cpp prompt-cache options. */
    llamacpp?: LlamaCppOptions;
  }
}

/** Who is calling, for slot pinning. `primary` = a top-level agent (main chat). */
export interface CacheSlotRequest {
  key: string;
  primary?: boolean;
}

/** Key used for requests that carry no slot request (summaries, approver, apply model, probes). */
export const AUX_SLOT_KEY = 'aux';

interface SlotTable {
  slots: number;
  keys: Map<string, number>;
  nextPrimary: number;
  nextOther: number;
}

const tables = new Map<string, SlotTable>();

const urlKey = (baseUrl: string) => baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

/** The slot for this caller on this server, stable for the process. undefined = do not pin. */
export function slotFor(baseUrl: string, slots: number | undefined, req: CacheSlotRequest | undefined): number | undefined {
  const n = Math.floor(Number(slots) || 0);
  if (n < 2) return n === 1 ? 0 : undefined;
  const k = urlKey(baseUrl);
  let t = tables.get(k);
  if (!t || t.slots !== n) tables.set(k, (t = { slots: n, keys: new Map(), nextPrimary: 0, nextOther: n - 1 }));
  const key = req?.key || AUX_SLOT_KEY;
  const known = t.keys.get(key);
  if (known !== undefined) return known;
  let s: number;
  if (req?.primary) {
    s = t.nextPrimary % n;
    t.nextPrimary++;
  } else {
    s = ((t.nextOther % n) + n) % n;
    t.nextOther--;
  }
  t.keys.set(key, s);
  return s;
}

/** Test helper: forget every slot assignment. */
export function resetSlotTables(): void {
  tables.clear();
}

/**
 * Body fields for the prompt cache. Only the llama.cpp dialect gets any:
 * other servers cache automatically (vLLM APC, SGLang radix cache) or not at all.
 */
export function cacheBodyFields(profile: Pick<ModelProfile, 'baseUrl' | 'server' | 'llamacpp'>, detected: ServerKind | undefined, req: CacheSlotRequest | undefined, slotRejected: boolean): Record<string, unknown> {
  const server = profile.server ?? detected;
  if (server !== 'llamacpp') return {};
  const o = profile.llamacpp ?? {};
  const out: Record<string, unknown> = { cache_prompt: o.cachePrompt !== false };
  if (o.cachePrompt !== false && o.pinSlots !== false && !slotRejected) {
    const s = slotFor(profile.baseUrl, o.slots, req);
    if (s !== undefined) out.id_slot = s;
  }
  return out;
}

/** Cached prompt tokens as reported by the server (undefined = not reported). Clamped to the prompt size. */
export function cachedTokensFrom(usage: any, timings: any, promptTokens?: number): number | undefined {
  const raw = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.input_tokens_details?.cached_tokens ?? timings?.cache_n;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return typeof promptTokens === 'number' && promptTokens > 0 ? Math.min(raw, promptTokens) : raw;
}

/** A reply that only llama-server produces (its `timings` block). */
export function looksLikeLlamaCpp(reply: any): boolean {
  const t = reply?.timings;
  return !!t && typeof t === 'object' && (typeof t.prompt_n === 'number' || typeof t.cache_n === 'number');
}

/**
 * Ask the server what it is (probe only): llama-server answers `GET /props`
 * with `total_slots` and its build info. Anything else (404, HTML, timeout)
 * means "not llama.cpp", never an error.
 */
export async function detectServer(baseUrl: string, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<{ server?: ServerKind; slots?: number }> {
  const root = urlKey(baseUrl).replace(/\/v1$/, '');
  try {
    const res = await fetch(`${root}/props`, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) });
    if (!res.ok) return {};
    const j = (await res.json().catch(() => undefined)) as any;
    if (j && typeof j.total_slots === 'number' && (j.default_generation_settings || j.build_info || j.model_path || j.chat_template !== undefined)) return { server: 'llamacpp', slots: j.total_slots };
  } catch {
    /* not llama.cpp, or unreachable: the probe reports reachability itself */
  }
  return {};
}
