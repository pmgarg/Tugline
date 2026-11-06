/**
 * WS9: the agent side of Ollama-native support (see ollama.ts for the API).
 *
 * An agent extension, so agent.ts is unchanged:
 *  - before the first turn, an endpoint known to be Ollama (default port 11434,
 *    the capabilities cache, or `ollama.detect: "always"`) is asked for the
 *    model's maximum context, num_ctx and capabilities (/api/show) and for the
 *    loaded context (/api/ps, if the model is already loaded);
 *  - after the first chat request, /api/ps gives the context the app setting
 *    resolved to. An endpoint on another port that answered with the
 *    `fp_ollama` fingerprint is detected at this point too;
 *  - the budget becomes min(configured, effective) via LLMClient.retune, with
 *    one notice naming the number and where to raise it; toolMode (when 'auto')
 *    and vision follow /api/show capabilities.
 * Results are cached per baseUrl+model in ~/.tugline/capabilities.json; the
 * loaded context is re-read once per session because the user can change the
 * app setting at any time.
 */
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import type { LLMClient } from './client.js';
import { readOllamaCache, writeOllamaCache } from './overlays.js';
import { capabilityPatch, contextNotice, effectiveContext, looksLikeOllamaUrl, OLLAMA_FINGERPRINT, ollamaLoadedContext, ollamaShow, ollamaVersion, type OllamaCached } from './ollama.js';

export interface OllamaConfig {
  /** auto: port 11434, the cache or the fp_ollama fingerprint; always: ask /api/version for any URL (Ollama behind a proxy); off: never. */
  detect: 'auto' | 'always' | 'off';
}

export const DEFAULT_OLLAMA: OllamaConfig = { detect: 'auto' };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** WS9 Ollama-native support. Defaults: DEFAULT_OLLAMA. */
    ollama?: Partial<OllamaConfig>;
  }
}

/** Cached /api/show data older than this is fetched again. */
const SHOW_MAX_AGE_MS = 7 * 86_400_000;

interface State {
  /** contextWindow before any Ollama adjustment */
  configured: number;
  isOllama?: boolean;
  info?: OllamaCached;
  prepared?: Promise<void>;
  psRead?: Promise<void>;
  capsApplied: boolean;
  noticed: Set<number>;
}

const states = new WeakMap<LLMClient, State>();

function stateOf(client: LLMClient): State {
  let st = states.get(client);
  if (!st) states.set(client, (st = { configured: client.profile.contextWindow, capsApplied: false, noticed: new Set() }));
  return st;
}

/** Same host as the chat endpoint, so the same auth (Ollama behind an authenticating proxy). */
function reqOpts(a: AgentApi, client: LLMClient) {
  const headers: Record<string, string> = { ...(client.profile.headers ?? {}) };
  if (client.profile.apiKey) headers.Authorization = `Bearer ${client.profile.apiKey}`;
  return { signal: a.signal, headers };
}

/** Apply what we know: context = min(configured, effective), capabilities once, one notice per new lower value. */
export function applyOllama(client: LLMClient, st: State, notice: (msg: string) => void): void {
  if (!st.info?.isOllama) return;
  const patch = st.capsApplied ? {} : capabilityPatch(client.profile, st.info.capabilities);
  st.capsApplied = true;
  const eff = effectiveContext(st.info);
  const target = eff && eff < st.configured ? eff : st.configured;
  client.retune({ ...patch, contextWindow: target });
  if (target < st.configured && !st.noticed.has(target)) {
    st.noticed.add(target);
    notice(contextNotice(client.profile.model, target, st.info));
  }
}

async function fullDetect(a: AgentApi, client: LLMClient, st: State): Promise<void> {
  const p = client.profile;
  const o = reqOpts(a, client);
  const version = await ollamaVersion(p.baseUrl, o);
  if (!version) {
    st.isOllama = false;
    return;
  }
  const [show, loadedContext] = await Promise.all([ollamaShow(p.baseUrl, p.model, o), ollamaLoadedContext(p.baseUrl, p.model, o)]);
  st.isOllama = true;
  st.info = { isOllama: true, version, ...(show ?? {}), loadedContext, at: new Date().toISOString() };
  writeOllamaCache(a.config.homeDir, p, st.info);
}

async function prepare(a: AgentApi, client: LLMClient, st: State): Promise<void> {
  const mode = { ...DEFAULT_OLLAMA, ...(a.config.ollama ?? {}) }.detect;
  if (mode === 'off') {
    st.isOllama = false;
    return;
  }
  const p = client.profile;
  const cached = readOllamaCache(a.config.homeDir, p);
  if (cached?.isOllama && Date.now() - Date.parse(cached.at) < SHOW_MAX_AGE_MS) {
    st.isOllama = true;
    st.info = { ...cached };
  } else if (mode === 'always' || looksLikeOllamaUrl(p.baseUrl) || cached?.isOllama) {
    await fullDetect(a, client, st);
  }
  applyOllama(client, st, (m) => a.notice('warn', m));
}

/** After the first chat request: the loaded context (the app setting in effect), or detection by fingerprint. */
async function afterFirstCall(a: AgentApi, client: LLMClient, st: State): Promise<void> {
  if (st.isOllama === undefined && client.systemFingerprint === OLLAMA_FINGERPRINT && { ...DEFAULT_OLLAMA, ...(a.config.ollama ?? {}) }.detect !== 'off') {
    await fullDetect(a, client, st);
  } else if (st.isOllama && st.info) {
    const loaded = await ollamaLoadedContext(client.profile.baseUrl, client.profile.model, reqOpts(a, client));
    if (loaded) {
      st.info = { ...st.info, loadedContext: loaded, at: st.info.at };
      writeOllamaCache(a.config.homeDir, client.profile, st.info);
    }
  }
  applyOllama(client, st, (m) => a.notice('warn', m));
}

async function step(a: AgentApi): Promise<void> {
  const client = a.llm;
  if (!client?.profile) return;
  const st = stateOf(client);
  await (st.prepared ??= prepare(a, client, st).catch(() => undefined));
  const called = a.stats.successfulLlmCalls > 0 || client.systemFingerprint !== undefined;
  if (called && st.isOllama !== false) await (st.psRead ??= afterFirstCall(a, client, st).catch(() => undefined));
}

registerAgentExtension({
  id: 'ws9-ollama',
  beforeTurn: (a) => step(a),
  onRunEnd: (a) => step(a),
});
