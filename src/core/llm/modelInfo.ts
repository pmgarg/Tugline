/**
 * What a server says about its models in GET /models, beyond the id: the context window, the output limit, and
 * whether the model takes tools or images. OpenAI-compatible servers put these in different fields:
 *   vLLM / SGLang     max_model_len
 *   OpenRouter        context_length, top_provider.{context_length,max_completion_tokens},
 *                     supported_parameters ["tools"], architecture.input_modalities ["image"]
 *   Together          context_length
 *   Groq              context_window, max_completion_tokens
 *   Mistral           max_context_length, capabilities.{function_calling,vision}
 *   LM Studio (v0)    max_context_length, type "vlm"
 *   llama.cpp server  meta.n_ctx_train (the trained maximum; the server's own n_ctx may be smaller)
 *   Ollama            nothing here: /api/show has it (see ollama.ts)
 * Anything missing stays undefined: the UI then offers the usual sizes and the user picks.
 */

export interface ModelInfo {
  id: string;
  /** context window in tokens, as the server reports it */
  contextWindow?: number;
  /** the most tokens one reply may have, as the server reports it */
  maxOutput?: number;
  /** the model takes tool definitions (native tool calling) */
  tools?: boolean;
  /** the model reads images */
  vision?: boolean;
}

const pos = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : typeof v === 'string' && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : undefined);

/** One /models entry (or an Ollama /api/tags entry) to a ModelInfo; undefined when it has no id. */
export function modelInfoOf(d: any): ModelInfo | undefined {
  const id = d?.id ?? d?.name ?? d?.model;
  if (typeof id !== 'string' || !id) return undefined;
  const out: ModelInfo = { id };
  const ctx = pos(d.max_model_len) ?? pos(d.context_length) ?? pos(d.context_window) ?? pos(d.max_context_length) ?? pos(d.top_provider?.context_length) ?? pos(d.meta?.n_ctx_train);
  if (ctx) out.contextWindow = ctx;
  const maxOut = pos(d.top_provider?.max_completion_tokens) ?? pos(d.max_completion_tokens) ?? pos(d.max_output_tokens);
  if (maxOut) out.maxOutput = maxOut;
  if (Array.isArray(d.supported_parameters)) out.tools = d.supported_parameters.includes('tools');
  if (typeof d.capabilities?.function_calling === 'boolean') out.tools = d.capabilities.function_calling;
  if (Array.isArray(d.capabilities)) {
    const caps = d.capabilities.filter((c: unknown) => typeof c === 'string');
    if (caps.length) {
      out.tools = caps.includes('tools');
      out.vision = caps.includes('vision');
    }
  }
  const mods = d.architecture?.input_modalities;
  if (Array.isArray(mods)) out.vision = mods.includes('image');
  if (typeof d.capabilities?.vision === 'boolean') out.vision = d.capabilities.vision;
  if (d.type === 'vlm') out.vision = true;
  return out;
}

/** A /models reply ({data:[…]} or Ollama's {models:[…]}) to ModelInfos, sorted by id, one per id. */
export function parseModelInfos(j: any): ModelInfo[] {
  const list: unknown[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
  const byId = new Map<string, ModelInfo>();
  for (const d of list) {
    const m = modelInfoOf(d);
    if (m && !byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Context window sizes offered as one-click choices (tokens). */
export const CONTEXT_SIZES = [8_192, 16_384, 32_768, 65_536, 131_072, 200_000, 262_144, 1_048_576];
/** Output limits offered as one-click choices (tokens). */
export const OUTPUT_SIZES = [4_096, 8_192, 16_384, 32_768, 65_536];

/** 131072 → "128K", 200000 → "200K", 1048576 → "1M". */
export function tokenLabel(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_048_576).toFixed(n % 1_048_576 ? 1 : 0)}M`;
  if (n >= 1000) return n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`;
  return String(n);
}
