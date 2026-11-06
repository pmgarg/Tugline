/**
 * Per-model prompt overlays and capability profiles (SPEC D4).
 *
 * Open models differ in ways that a single prompt cannot absorb (SOTA §8.16):
 * Qwen3-Coder is XML-native and wants temperature 0.7 / top_p 0.8, gpt-oss is
 * trained on apply_patch and Harmony, GLM/Kimi interleave thinking with tool
 * calls, Mistral's templates reject tool-call ids that are not 9 alphanumerics.
 * An overlay is matched by model-id regex and contributes (a) a short note in
 * the system prompt and (b) request defaults that apply only when the profile
 * did not set the field itself.
 *
 * Capabilities found by the probe (`tug setup` / `tug doctor`) are cached in
 * ~/.tugline/capabilities.json keyed by endpoint + model, so the agent can
 * start in the right tool-calling dialect without re-detecting every session.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ModelProfile } from '../types.js';
import { probeEndpoint, type ProbeReport } from './probe.js';
import type { OllamaCached } from './ollama.js';

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';

export interface ModelOverlay {
  id: string;
  family: string;
  match: RegExp;
  /** Appended to the system prompt under "# Model notes" */
  note: string;
  /** Request defaults (only fill fields the profile left unset) */
  request?: { temperature?: number; top_p?: number; top_k?: number };
  /** Preferred edit format family (A7 may consult it) */
  editFormat?: 'replace' | 'apply_patch';
  /** Tool-call ids must be exactly 9 alphanumerics (Mistral templates) */
  strictToolIds?: boolean;
  /** The template expects reasoning_content of earlier assistant turns back (interleaved thinking) */
  passReasoningBack?: boolean;
  /** How a reasoning-effort setting is expressed in the request body */
  reasoning?: 'reasoning_effort' | 'enable_thinking' | 'thinking';
}

/** Order matters: the first match wins (qwen3-coder before qwen3). */
export const OVERLAYS: ModelOverlay[] = [
  {
    id: 'qwen3-coder',
    family: 'qwen',
    match: /qwen[-_.]?3(\.\d+)?[-_.:]?coder|qwen3-coder/i,
    note: 'You are Qwen3-Coder. Tool calls are native for you; when tools are described in text, emit them in the XML <tool_call> form exactly as documented, one call per block, and put code verbatim in parameters (never JSON-escape it). Keep replies short between tool calls.',
    request: { temperature: 0.7, top_p: 0.8, top_k: 20 },
    reasoning: 'enable_thinking',
  },
  {
    id: 'qwen3',
    family: 'qwen',
    match: /qwen[-_.]?3(\.\d+)?|qwq/i,
    note: 'Think briefly before acting; long hidden reasoning can exhaust the output budget before a tool call is emitted. Prefer one focused tool call per step and copy edit anchors exactly from read_file output.',
    request: { temperature: 0.7, top_p: 0.8, top_k: 20 },
    reasoning: 'enable_thinking',
  },
  {
    id: 'gpt-oss',
    family: 'gpt-oss',
    match: /gpt-oss/i,
    note: 'You were trained on the apply_patch format; when an apply_patch tool is available prefer it for multi-hunk edits. Keep analysis concise and always finish with either a tool call or a final answer.',
    editFormat: 'apply_patch',
    reasoning: 'reasoning_effort',
  },
  {
    id: 'glm',
    family: 'glm',
    match: /\bglm[-_.]?\d|chatglm|zai-org|z-ai/i,
    note: 'You may think between tool calls (interleaved thinking). Keep each thought short and act with a tool call; do not restate earlier reasoning.',
    passReasoningBack: true,
    reasoning: 'thinking',
  },
  {
    id: 'kimi',
    family: 'kimi',
    match: /kimi|moonshot/i,
    note: 'You may think between tool calls (interleaved thinking). Act with one tool call at a time and keep the final answer brief.',
    passReasoningBack: true,
    reasoning: 'thinking',
  },
  {
    id: 'deepseek',
    family: 'deepseek',
    match: /deepseek/i,
    note: 'In thinking mode, keep reasoning short and never put tool calls inside the reasoning; emit them as real tool calls after it.',
    reasoning: 'thinking',
  },
  {
    id: 'llama',
    family: 'llama',
    match: /llama|hermes/i,
    note: 'Call exactly one tool per reply and use only the parameter names in the schema. If unsure which file to change, search first with grep.',
    request: { temperature: 0.2 },
    strictToolIds: true,
  },
  {
    id: 'mistral',
    family: 'mistral',
    match: /mistral|mixtral|codestral|devstral|magistral|ministral/i,
    note: 'Use the tools exactly as specified; one tool call per reply is safest. Copy edit anchors exactly, including indentation.',
    request: { temperature: 0.15 },
    strictToolIds: true,
  },
  {
    id: 'gemma',
    family: 'gemma',
    match: /gemma/i,
    note: 'Use the tools for every file and command action; do not describe an action instead of calling the tool. Keep replies short.',
    request: { temperature: 0.3 },
  },
];

export function selectOverlay(model: string): ModelOverlay | undefined {
  // Strip provider prefixes ("openrouter/qwen/…", "accounts/fireworks/models/…") implicitly: the regexes are unanchored.
  return OVERLAYS.find((o) => o.match.test(model));
}

/**
 * Apply an overlay's request defaults to a resolved profile. `raw` is the
 * profile as the user configured it (before built-in defaults), so a value the
 * user set always wins.
 */
export function applyOverlayDefaults(profile: ModelProfile, raw: Partial<ModelProfile> | undefined, overlay: ModelOverlay | undefined): ModelProfile {
  if (!overlay?.request) return profile;
  const out: ModelProfile = { ...profile, extraBody: { ...(profile.extraBody ?? {}) } };
  const r = overlay.request;
  if (r.temperature !== undefined && raw?.temperature === undefined) out.temperature = r.temperature;
  if (r.top_p !== undefined && out.extraBody!.top_p === undefined) out.extraBody!.top_p = r.top_p;
  if (r.top_k !== undefined && out.extraBody!.top_k === undefined) out.extraBody!.top_k = r.top_k;
  return out;
}

/** Map a reasoning-effort choice to the request fields this family understands (B8 uses it). */
export function reasoningBody(overlay: ModelOverlay | undefined, effort: ReasoningEffort): Record<string, unknown> {
  switch (overlay?.reasoning) {
    case 'enable_thinking':
      return { chat_template_kwargs: { enable_thinking: effort !== 'off' } };
    case 'thinking':
      return { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } };
    case 'reasoning_effort':
    default:
      return { reasoning_effort: effort === 'off' ? 'low' : effort };
  }
}

// ------------------------------------------------------------ capability cache

export interface CachedCapabilities {
  baseUrl: string;
  model: string;
  probedAt: string;
  report: ProbeReport;
  /** WS9: what the Ollama API said about this model (context, capabilities); see llm/ollama.ts. */
  ollama?: OllamaCached;
}

export function capabilitiesFile(homeDir: string): string {
  return path.join(homeDir, 'capabilities.json');
}

const keyOf = (p: Pick<ModelProfile, 'baseUrl' | 'model'>) => `${p.baseUrl.replace(/\/+$/, '')}|${p.model}`;

function readAll(homeDir: string): Record<string, CachedCapabilities> {
  try {
    return JSON.parse(fs.readFileSync(capabilitiesFile(homeDir), 'utf8'));
  } catch {
    return {};
  }
}

export function readCapabilities(homeDir: string, profile: Pick<ModelProfile, 'baseUrl' | 'model'>, maxAgeMs = 30 * 86_400_000): CachedCapabilities | undefined {
  const c = readAll(homeDir)[keyOf(profile)];
  if (!c?.report) return undefined; // an entry may hold only Ollama data
  if (Date.now() - Date.parse(c.probedAt) > maxAgeMs) return undefined;
  return c;
}

export function writeCapabilities(homeDir: string, profile: Pick<ModelProfile, 'baseUrl' | 'model'>, report: ProbeReport): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    const all = readAll(homeDir);
    all[keyOf(profile)] = { ...all[keyOf(profile)], baseUrl: profile.baseUrl, model: profile.model, probedAt: new Date().toISOString(), report };
    fs.writeFileSync(capabilitiesFile(homeDir), JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    /* the cache is an optimisation */
  }
}

/** WS9: the Ollama part of a cache entry (independent of the probe report and its age). */
export function readOllamaCache(homeDir: string, profile: Pick<ModelProfile, 'baseUrl' | 'model'>): OllamaCached | undefined {
  return readAll(homeDir)[keyOf(profile)]?.ollama;
}

export function writeOllamaCache(homeDir: string, profile: Pick<ModelProfile, 'baseUrl' | 'model'>, ollama: OllamaCached): void {
  try {
    fs.mkdirSync(homeDir, { recursive: true });
    const all = readAll(homeDir);
    const k = keyOf(profile);
    all[k] = { ...(all[k] ?? { baseUrl: profile.baseUrl, model: profile.model }), ollama } as CachedCapabilities;
    fs.writeFileSync(capabilitiesFile(homeDir), JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    /* the cache is an optimisation */
  }
}

/** Probe once and cache; later calls reuse the cached report unless `force`. */
export async function cachedProbe(profile: ModelProfile, homeDir: string, opts: { force?: boolean; maxAgeMs?: number; probe?: (p: ModelProfile) => Promise<ProbeReport>; signal?: AbortSignal } = {}): Promise<{ report: ProbeReport; cached: boolean }> {
  if (!opts.force) {
    const c = readCapabilities(homeDir, profile, opts.maxAgeMs);
    if (c) return { report: c.report, cached: true };
  }
  const report = await (opts.probe ?? ((p) => probeEndpoint(p, opts.signal)))(profile);
  // Only a probe that reached the model says anything about its capabilities.
  if (report.chatOk) writeCapabilities(homeDir, profile, report);
  return { report, cached: false };
}

/**
 * A profile with toolMode 'auto' starts in the dialect the probe recommended,
 * skipping per-session auto-detection. Explicit native/text always wins.
 */
export function profileWithCapabilities(profile: ModelProfile, homeDir: string): ModelProfile {
  const c = readCapabilities(homeDir, profile);
  if (!c?.report.chatOk) return profile;
  let p = profile;
  if (p.toolMode === 'auto') p = { ...p, toolMode: c.report.recommendedToolMode };
  // N10: the probe's server kind and llama.cpp slot count (explicit profile keys win)
  if (c.report.server && !p.server) p = { ...p, server: c.report.server };
  if (c.report.slots && p.llamacpp?.slots === undefined) p = { ...p, llamacpp: { ...(p.llamacpp ?? {}), slots: c.report.slots } };
  return p;
}
