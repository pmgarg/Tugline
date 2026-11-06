/**
 * Client for any OpenAI-compatible `/embeddings` endpoint (Ollama, llama.cpp,
 * vLLM, TEI, LM Studio): POST {model, input: string[]} → data[i].embedding.
 * Vectors are L2-normalised so cosine similarity is a dot product.
 */
import type { EmbedderSpec } from './config.js';

export class EmbedError extends Error {}

export function normalise(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (const x of out) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

const MAX_INPUT_CHARS = 6000;

/** One request; a network-level failure (reset, refused while a model loads) is retried once. HTTP errors are not. */
export async function embedBatch(spec: EmbedderSpec, inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  try {
    return await embedOnce(spec, inputs, signal);
  } catch (e) {
    if (!(e instanceof EmbedError) || !/unreachable/.test(e.message) || signal?.aborted || /timed out/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return embedOnce(spec, inputs, signal);
  }
}

async function embedOnce(spec: EmbedderSpec, inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new EmbedError(`embeddings request timed out after ${spec.timeoutMs} ms`)), spec.timeoutMs);
  const onAbort = () => ctl.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${spec.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}), ...(spec.headers ?? {}) },
      body: JSON.stringify({ model: spec.model, input: inputs.map((s) => s.slice(0, MAX_INPUT_CHARS)) }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new EmbedError(`embeddings endpoint ${spec.baseUrl} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j: any = await res.json();
    const data: any[] = Array.isArray(j?.data) ? j.data : [];
    if (data.length !== inputs.length) throw new EmbedError(`embeddings endpoint returned ${data.length} vectors for ${inputs.length} inputs`);
    return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => normalise(d.embedding));
  } catch (e) {
    if (e instanceof EmbedError) throw e;
    const reason = ctl.signal.reason instanceof EmbedError ? ctl.signal.reason.message : (e as Error).message;
    throw new EmbedError(`embeddings endpoint ${spec.baseUrl} unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Embed many texts in batches; `onProgress(done, total)` after each batch. */
export async function embedAll(spec: EmbedderSpec, inputs: string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < inputs.length; i += spec.batchSize) {
    out.push(...(await embedBatch(spec, inputs.slice(i, i + spec.batchSize), signal)));
    onProgress?.(Math.min(inputs.length, i + spec.batchSize), inputs.length);
  }
  return out;
}
