/**
 * Capability probe: run once when a company plugs in their endpoint.
 * Answers: reachable? auth ok? model listed? native tool calls? text-protocol
 * tool calls? streaming usage reported? rough latency and tokens/s.
 */
import type { ModelProfile } from '../types.js';
import { LLMClient } from './client.js';
import { detectServer, type ServerKind } from './promptCache.js';

export interface ProbeReport {
  reachable: boolean;
  models?: string[];
  modelListed?: boolean;
  chatOk: boolean;
  nativeTools: boolean;
  textTools: boolean;
  usageReported: boolean;
  reasoningSeen: boolean;
  latencyMs?: number;
  tokensPerSecond?: number;
  recommendedToolMode: 'native' | 'text';
  errors: string[];
  /** N10: server software (llama.cpp answers GET /props) and its slot count. */
  server?: ServerKind;
  slots?: number;
  /** N10: the chat reply reported cached prompt tokens (prefix-cache metering available). */
  cacheReported?: boolean;
}

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

export async function probeEndpoint(profile: ModelProfile, signal?: AbortSignal): Promise<ProbeReport> {
  const r: ProbeReport = { reachable: false, chatOk: false, nativeTools: false, textTools: false, usageReported: false, reasoningSeen: false, recommendedToolMode: 'text', errors: [] };
  const base = new LLMClient({ ...profile, toolMode: 'native' });
  try {
    r.models = await base.listModels(signal);
    r.reachable = true;
    r.modelListed = r.models.includes(profile.model) || r.models.some((m) => m.endsWith(`/${profile.model}`) || m.split(':')[0] === profile.model);
  } catch (e) {
    r.errors.push(`GET /models: ${(e as Error).message}`);
  }
  try {
    const t0 = Date.now();
    const res = await base.complete({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 512, signal });
    r.reachable = true;
    r.chatOk = res.text.trim().length > 0 || res.reasoning.length > 0;
    r.usageReported = !res.usage.estimated;
    r.reasoningSeen = res.reasoning.length > 0;
    r.latencyMs = Date.now() - t0;
    if (res.usage.completionTokens && r.latencyMs) r.tokensPerSecond = Math.round((res.usage.completionTokens / r.latencyMs) * 1000 * 10) / 10;
    r.cacheReported = res.usage.cachedTokens !== undefined;
    if (base.detectedServer) r.server = base.detectedServer;
  } catch (e) {
    r.errors.push(`chat: ${(e as Error).message}`);
    return r;
  }
  // N10: llama.cpp gets a stable slot per agent and cache_prompt (llm/promptCache.ts); /props says how many slots.
  const det = await detectServer(profile.baseUrl, profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}`, ...(profile.headers ?? {}) } : (profile.headers ?? {}), signal);
  if (det.server) r.server = det.server;
  if (det.slots) r.slots = det.slots;
  try {
    const res = await base.complete({ messages: [{ role: 'user', content: 'What is the weather in Dubai? Use the get_weather tool.' }], tools: [WEATHER_TOOL], maxTokens: 1024, signal });
    r.nativeTools = res.toolCalls.some((c) => c.name === 'get_weather' && res.dialect === 'native' && !!c.args);
    if (!r.nativeTools && res.toolCalls.some((c) => c.name === 'get_weather')) r.textTools = true;
  } catch (e) {
    r.errors.push(`native tools: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!r.nativeTools) {
    try {
      const textClient = new LLMClient({ ...profile, toolMode: 'text' });
      const res = await textClient.complete({ messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'What is the weather in Dubai? Use the get_weather tool.' }], tools: [WEATHER_TOOL], maxTokens: 1024, signal });
      r.textTools = r.textTools || res.toolCalls.some((c) => c.name === 'get_weather' && !!c.args);
    } catch (e) {
      r.errors.push(`text tools: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  r.recommendedToolMode = r.nativeTools ? 'native' : 'text';
  return r;
}
