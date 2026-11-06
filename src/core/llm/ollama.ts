/**
 * Ollama-native support (WS9).
 *
 * Ollama serves an OpenAI-compatible API under /v1, but the context it really
 * runs a model with is set elsewhere: the app's "Context length" slider (or
 * OLLAMA_CONTEXT_LENGTH, 4K by default on small machines), a Modelfile
 * `num_ctx`, capped by the model's trained maximum. When our budget is larger
 * than that, Ollama silently drops the start of the prompt (the system prompt
 * and tool schemas first). The native API tells us the real numbers:
 *
 *   GET  <root>/api/version  → is this Ollama?
 *   POST <root>/api/show     → model_info.<arch>.context_length (maximum),
 *                              parameters `num_ctx` (Modelfile override),
 *                              capabilities: completion/tools/vision/thinking/embedding
 *   GET  <root>/api/ps       → context_length of the LOADED model, i.e. what the
 *                              app setting resolved to (known after the first request)
 *
 * `<root>` is the base URL without `/v1`. These endpoints are only called for an
 * Ollama endpoint: the default port 11434, the `fp_ollama` system fingerprint on
 * a chat reply (passive, no extra request), the cache, or `ollama.detect:
 * "always"`. The UI may also look for "Ollama is running" at `GET <root>/`.
 * Everything here is pure or takes an injected fetch, so it is unit-tested
 * against a mock server.
 */
import type { ModelProfile } from '../types.js';

export type FetchFn = typeof fetch;

export interface OllamaModelInfo {
  /** model_info.*.context_length: the model's trained maximum */
  maxContext?: number;
  /** `num_ctx` from the model's parameters (Modelfile), if set */
  numCtx?: number;
  /** /api/show capabilities, e.g. ["completion","tools","vision","thinking"] */
  capabilities?: string[];
}

/** What is cached per baseUrl+model in ~/.tugline/capabilities.json (`ollama` field). */
export interface OllamaCached extends OllamaModelInfo {
  isOllama: boolean;
  version?: string;
  /** /api/ps context_length of the loaded model (the app setting in effect) */
  loadedContext?: number;
  /** ISO time of the last update */
  at: string;
}

export const OLLAMA_PORT = '11434';
export const OLLAMA_FINGERPRINT = 'fp_ollama';
export const OLLAMA_SETTINGS_HINT = 'raise it in Ollama → Settings → Context length';

/** Base URL without `/chat/completions` and `/v1`: where Ollama's native /api lives. */
export function ollamaRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The default Ollama port: a hint that costs no request. */
export function looksLikeOllamaUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).port === OLLAMA_PORT;
  } catch {
    return false;
  }
}

interface ReqOpts {
  fetch?: FetchFn;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

async function request(url: string, init: RequestInit, o: ReqOpts): Promise<Response | undefined> {
  const signals = [AbortSignal.timeout(o.timeoutMs ?? 4000)];
  if (o.signal) signals.push(o.signal);
  try {
    return await (o.fetch ?? fetch)(url, { ...init, headers: { ...(o.headers ?? {}), ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.any(signals) });
  } catch {
    return undefined;
  }
}

async function json(url: string, init: RequestInit, o: ReqOpts): Promise<any> {
  const res = await request(url, init, o);
  if (!res?.ok) return undefined;
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** GET <root>/api/version → the version string, or undefined when this is not Ollama. */
export async function ollamaVersion(baseUrl: string, o: ReqOpts = {}): Promise<string | undefined> {
  const j = await json(`${ollamaRoot(baseUrl)}/api/version`, { method: 'GET' }, o);
  return typeof j?.version === 'string' ? j.version : undefined;
}

/**
 * Is this endpoint Ollama? The default port, or (with `probeRoot`, UI only)
 * "Ollama is running" at GET <root>/, then /api/version must answer.
 * A non-Ollama URL never receives an /api/* request.
 */
export async function detectOllama(baseUrl: string, o: ReqOpts & { probeRoot?: boolean; force?: boolean } = {}): Promise<string | undefined> {
  if (!o.force && !looksLikeOllamaUrl(baseUrl)) {
    if (!o.probeRoot) return undefined;
    const res = await request(`${ollamaRoot(baseUrl)}/`, { method: 'GET' }, { ...o, timeoutMs: o.timeoutMs ?? 1500 });
    const text = res?.ok ? await res.text().catch(() => '') : '';
    if (!/ollama is running/i.test(text)) return undefined;
  }
  return ollamaVersion(baseUrl, o);
}

/** Parse an /api/show reply. */
export function parseShow(j: any): OllamaModelInfo {
  const out: OllamaModelInfo = {};
  const mi = j?.model_info;
  if (mi && typeof mi === 'object') {
    for (const [k, v] of Object.entries(mi)) {
      if (/(^|\.)context_length$/.test(k) && typeof v === 'number' && v > 0) {
        out.maxContext = v;
        break;
      }
    }
  }
  if (typeof j?.parameters === 'string') {
    const m = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(j.parameters);
    if (m) out.numCtx = Number(m[1]);
  }
  if (Array.isArray(j?.capabilities)) out.capabilities = j.capabilities.filter((c: unknown): c is string => typeof c === 'string');
  return out;
}

/** POST <root>/api/show {model} (older servers read `name`). */
export async function ollamaShow(baseUrl: string, model: string, o: ReqOpts = {}): Promise<OllamaModelInfo | undefined> {
  const j = await json(`${ollamaRoot(baseUrl)}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, name: model }) }, o);
  return j ? parseShow(j) : undefined;
}

/** `qwen3` and `qwen3:latest` are the same Ollama model. */
export function sameModel(a: string, b: string): boolean {
  const n = (s: string) => (s.includes(':') ? s : `${s}:latest`).toLowerCase();
  return n(a) === n(b);
}

/** GET <root>/api/ps → context_length of `model` if it is loaded. */
export async function ollamaLoadedContext(baseUrl: string, model: string, o: ReqOpts = {}): Promise<number | undefined> {
  const j = await json(`${ollamaRoot(baseUrl)}/api/ps`, { method: 'GET' }, o);
  const m = (Array.isArray(j?.models) ? j.models : []).find((x: any) => sameModel(String(x?.name ?? ''), model) || sameModel(String(x?.model ?? ''), model));
  const n = m?.context_length;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/** All of the above for one model (detection already done). */
export async function ollamaModelInfo(baseUrl: string, model: string, o: ReqOpts = {}): Promise<OllamaCached> {
  const [version, show, loadedContext] = await Promise.all([ollamaVersion(baseUrl, o), ollamaShow(baseUrl, model, o), ollamaLoadedContext(baseUrl, model, o)]);
  return { isOllama: !!version, version, ...(show ?? {}), loadedContext, at: new Date().toISOString() };
}

/**
 * The context Ollama really gives this model: the loaded context when known
 * (it already includes the app setting and num_ctx), else num_ctx; never more
 * than the model's maximum.
 */
export function effectiveContext(info: Partial<OllamaCached>): number | undefined {
  const runtime = info.loadedContext ?? info.numCtx;
  const c = [runtime, info.maxContext].filter((n): n is number => typeof n === 'number' && n > 0);
  return c.length ? Math.min(...c) : undefined;
}

export function contextNotice(model: string, n: number, info: Partial<OllamaCached>): string {
  if (info.loadedContext === n || (info.loadedContext === undefined && info.numCtx === n)) return `Ollama is running ${model} with a ${n}-token context; using that (${OLLAMA_SETTINGS_HINT})`;
  return `${model} supports at most ${n} tokens of context (Ollama /api/show); using that`;
}

/**
 * Profile changes implied by /api/show capabilities. toolMode is only decided
 * when it is still 'auto' (an explicit native/text wins), and vision is only
 * ever switched on (a profile that says vision:true keeps it).
 */
export function capabilityPatch(profile: Pick<ModelProfile, 'toolMode' | 'vision'>, caps: string[] | undefined): Partial<ModelProfile> {
  if (!caps?.length) return {};
  const patch: Partial<ModelProfile> = {};
  if (profile.toolMode === 'auto') patch.toolMode = caps.includes('tools') ? 'native' : 'text';
  if (!profile.vision && caps.includes('vision')) patch.vision = true;
  return patch;
}

// ------------------------------------------------------------ model choice (onboarding)

export interface ModelChoice {
  id: string;
  capabilities?: string[];
  /** undefined when the server cannot tell (non-Ollama) */
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  coder: boolean;
}

const EMBED_NAME = /(embed|(^|[/:_-])bge([:_-]|$)|(^|[/:_-])(e5|gte)[:_-]|minilm|rerank)/i;
const CODER_NAME = /(coder|codestral|devstral|codellama|starcoder|codegemma|codeqwen|granite-code|deepseek-code)/i;

/** Embedding-only models (nomic-embed-text, bge-m3, mxbai-embed-large, …) cannot chat. */
export function isEmbeddingModel(id: string, caps?: string[]): boolean {
  if (caps?.length) return caps.includes('embedding') && !caps.includes('completion');
  return EMBED_NAME.test(id);
}

export function isCoderModel(id: string): boolean {
  return CODER_NAME.test(id);
}

export function toChoice(id: string, caps?: string[]): ModelChoice {
  return { id, capabilities: caps, tools: caps?.length ? caps.includes('tools') : undefined, vision: caps?.length ? caps.includes('vision') : undefined, thinking: caps?.length ? caps.includes('thinking') : undefined, coder: isCoderModel(id) };
}

/**
 * Chat-capable models, best first: tool-capable coder models, then other
 * tool-capable models, then models whose capabilities are unknown (coder
 * first), then models without tool calling. Embedding-only models are dropped.
 */
export function sortModelChoices(list: ModelChoice[]): ModelChoice[] {
  const rank = (m: ModelChoice) => (m.tools === true ? 0 : m.tools === undefined ? 1 : 2) * 2 + (m.coder ? 0 : 1);
  return list.filter((m) => !isEmbeddingModel(m.id, m.capabilities)).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** /api/show capabilities for every model (Ollama only), a few at a time. */
export async function ollamaCapabilities(baseUrl: string, ids: string[], o: ReqOpts = {}): Promise<Map<string, string[] | undefined>> {
  const out = new Map<string, string[] | undefined>();
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) out.set(id, (await ollamaShow(baseUrl, id, o))?.capabilities);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

// ------------------------------------------------------------ local servers (onboarding)

export interface LocalServer {
  kind: 'ollama' | 'lmstudio' | 'llamacpp';
  label: string;
  baseUrl: string;
  models?: string[];
}

export const LOCAL_SERVERS: LocalServer[] = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { kind: 'llamacpp', label: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1' },
];

/** Parse an OpenAI `/models` (or Ollama `/api/tags`) listing. */
export function modelIds(j: any): string[] | undefined {
  const ids = Array.isArray(j?.data) ? j.data.map((d: any) => d?.id) : Array.isArray(j?.models) ? j.models.map((m: any) => m?.name ?? m?.model) : undefined;
  return ids?.filter((x: unknown): x is string => typeof x === 'string').sort();
}

/** Which local servers answer GET <baseUrl>/models (in parallel, short timeout). Only those are offered. */
export async function detectLocalServers(candidates: LocalServer[] = LOCAL_SERVERS, o: ReqOpts = {}): Promise<LocalServer[]> {
  const found = await Promise.all(
    candidates.map(async (c): Promise<LocalServer | undefined> => {
      const models = modelIds(await json(`${c.baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET' }, { ...o, timeoutMs: o.timeoutMs ?? 1500 }));
      return models ? { ...c, models } : undefined;
    }),
  );
  return found.filter((s): s is LocalServer => s !== undefined);
}
