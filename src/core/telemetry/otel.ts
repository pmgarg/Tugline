/**
 * OpenTelemetry traces (SPEC H4; EAG S15 "every call becomes a span").
 *
 *   run (invoke_agent)
 *   ├── turn
 *   │   ├── llm.call (chat)          gen_ai.request.model, gen_ai.usage.*, tugline.cost_usd
 *   │   └── tool.call (execute_tool) gen_ai.tool.name, outcome, duration
 *   │       └── run (subagent)       a `task` tool's child agent nests under its tool span
 *   └── …
 *
 * - Off by default. On when `telemetry.enabled` is true, or when an OTLP endpoint
 *   is set in the environment (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT /
 *   OTEL_EXPORTER_OTLP_ENDPOINT) and `telemetry.enabled` is not false.
 * - `@opentelemetry/*` (Apache-2.0) is optional and imported lazily, only when
 *   telemetry is on. Missing packages produce one notice and no spans.
 * - Content is excluded by default: no prompts, completions, tool arguments or
 *   tool output on spans unless `telemetry.includeContent` is true.
 * - Costs come from the same `usage` events the C7 ledger records, at every
 *   depth, so the span cost sum equals the ledger cost for a run. Classifier
 *   approver calls are written straight to the ledger, so they are back-filled
 *   as llm.call spans from the ledger at run end.
 * - Metric-style attributes stay low-cardinality; ids live on spans only.
 */
import type { HarnessConfig } from '../config.js';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import type { AgentEvent } from '../types.js';
import { localDate, readLedger, rootSession } from '../permissions/limits.js';

export interface TelemetryConfig {
  enabled?: boolean;
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces */
  endpoint?: string;
  headers?: Record<string, string>;
  serviceName: string;
  /** Put prompts, final text, tool arguments and results on spans (default false). */
  includeContent: boolean;
}

export const DEFAULT_TELEMETRY: TelemetryConfig = { serviceName: 'tugline', includeContent: false };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC H4 (WS8). */
    telemetry?: Partial<TelemetryConfig>;
  }
}

export function telemetryConfig(cfg: HarnessConfig, env: NodeJS.ProcessEnv = process.env): TelemetryConfig & { active: boolean; url?: string } {
  const t = { ...DEFAULT_TELEMETRY, ...(cfg.telemetry ?? {}) };
  const envUrl = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || (env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces` : undefined);
  const url = t.endpoint ?? envUrl;
  const active = t.enabled === true || (t.enabled !== false && !!envUrl) || (t.enabled !== false && !!injected);
  return { ...t, active, url };
}

// ------------------------------------------------------------ lazy OTel

interface OtelApi {
  trace: any;
  context: any;
  SpanStatusCode: any;
  SpanKind: any;
}
interface Provider {
  getTracer(name: string, version?: string): any;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

let api: OtelApi | undefined;
let injected: Provider | undefined;
const providers = new Map<string, Provider>();
let loadError: string | undefined;

/**
 * Use this tracer provider instead of building an OTLP one (tests use an
 * in-memory exporter; embedding apps can pass their own SDK provider).
 */
export function setTelemetryProvider(p: Provider | undefined): void {
  injected = p;
}

async function loadApi(): Promise<OtelApi> {
  if (api) return api;
  const name = '@opentelemetry/api';
  const m: any = await import(name);
  api = { trace: m.trace, context: m.context, SpanStatusCode: m.SpanStatusCode, SpanKind: m.SpanKind };
  return api;
}

async function providerFor(t: ReturnType<typeof telemetryConfig>): Promise<Provider> {
  if (injected) return injected;
  const key = `${t.url}|${t.serviceName}|${JSON.stringify(t.headers ?? {})}`;
  const cached = providers.get(key);
  if (cached) return cached;
  const [sdk, exp, res]: any[] = await Promise.all([import('@opentelemetry/sdk-trace' as string), import('@opentelemetry/exporter-trace-otlp-http' as string), import('@opentelemetry/resources' as string)]);
  const exporter = new exp.OTLPTraceExporter({ url: t.url, headers: t.headers });
  const provider = new sdk.TracerProvider({
    resource: res.resourceFromAttributes({ 'service.name': t.serviceName }),
    spanProcessors: [new sdk.BatchSpanProcessor({ exporter, scheduledDelayMillis: 1000 })],
  });
  providers.set(key, provider);
  return provider;
}

/** Flush and shut down every provider this process built (CLI exit). */
export async function shutdownTelemetry(): Promise<void> {
  for (const p of providers.values()) await p.shutdown?.().catch(() => undefined);
  providers.clear();
}

// ------------------------------------------------------------ per-agent state

interface OpenTool {
  span: any;
  name: string;
  start: number;
  refused?: boolean;
  /** a `task` tool span already given to a child run */
  claimed?: boolean;
}

interface RunState {
  tracer: any;
  provider: Provider;
  includeContent: boolean;
  run?: any;
  runCtx?: any;
  runId?: string;
  turn?: any;
  turnCtx?: any;
  tools: Map<string, OpenTool>;
  started?: { at: number; prompt: string; model: string; runId: string };
  costUsd: number;
  inTok: number;
  outTok: number;
}

const states = new WeakMap<object, RunState>();
const bySession = new Map<string, RunState>();
let warned = false;

const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return undefined;
  }
};
const clip = (s: unknown, n = 4000) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t && t.length > n ? `${t.slice(0, n)}…` : t;
};

function parentSessionOf(id: string): string | undefined {
  const m = id.match(/^(.*)-sub(?:-\d+)?$/);
  return m ? m[1] : undefined;
}

/** A child run nests under the parent's oldest unclaimed `task` tool span (parallel children each take one), else its turn. */
function parentContextFor(a: AgentApi): any {
  const ps = parentSessionOf(a.sessionId);
  const p = ps ? bySession.get(ps) : undefined;
  if (!p || !api) return undefined;
  const task = [...p.tools.values()].find((t) => t.name === 'task' && !t.claimed);
  if (task) {
    task.claimed = true;
    return api.trace.setSpan(api.context.active(), task.span);
  }
  return p.turnCtx ?? p.runCtx;
}

function endTurn(st: RunState, at = Date.now()): void {
  st.turn?.end(at);
  st.turn = undefined;
  st.turnCtx = undefined;
}

function onEvent(a: AgentApi, e: AgentEvent): void {
  if (e.type === 'run_start') {
    // The run span is created in onRunStart (after the lazy import); remember when it began.
    pendingStarts.set(a.agent as object, { at: Date.now(), prompt: e.prompt, model: e.model, runId: e.runId });
    return;
  }
  const st = states.get(a.agent as object);
  if (!st || !st.run || !api) return;
  const ctxOf = () => st.turnCtx ?? st.runCtx;
  switch (e.type) {
    case 'turn_start': {
      endTurn(st);
      st.turn = st.tracer.startSpan('turn', { attributes: { 'tugline.turn': e.turn } }, st.runCtx);
      st.turnCtx = api.trace.setSpan(st.runCtx, st.turn);
      return;
    }
    case 'usage': {
      const end = Date.now();
      const attrs: Record<string, unknown> = {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openai',
        'gen_ai.request.model': a.llm.profile.model,
        'gen_ai.response.model': e.model,
        'gen_ai.usage.input_tokens': e.usage.promptTokens,
        'gen_ai.usage.output_tokens': e.usage.completionTokens,
        'tugline.cost_usd': e.costUsd,
        'tugline.role': e.role ?? 'main',
        'tugline.latency_ms': e.latencyMs,
      };
      if (e.usage.estimated) attrs['tugline.usage.estimated'] = true;
      if (e.usage.cachedTokens) attrs['gen_ai.usage.cache_read.input_tokens'] = e.usage.cachedTokens;
      const h = host(a.llm.profile.baseUrl);
      if (h) attrs['server.address'] = h;
      const span = st.tracer.startSpan('llm.call', { kind: api.SpanKind.CLIENT, attributes: attrs, startTime: end - Math.max(0, e.latencyMs || 0) }, ctxOf());
      span.end(end);
      st.costUsd += e.costUsd;
      st.inTok += e.usage.promptTokens;
      st.outTok += e.usage.completionTokens;
      return;
    }
    case 'tool_start': {
      const attrs: Record<string, unknown> = { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': e.name, 'gen_ai.tool.call.id': e.id };
      if (st.includeContent) attrs['gen_ai.tool.call.arguments'] = clip(e.args);
      st.tools.set(e.id, { span: st.tracer.startSpan('tool.call', { attributes: attrs }, ctxOf()), name: e.name, start: Date.now() });
      return;
    }
    case 'refusal': {
      const open = [...st.tools.values()].reverse().find((t) => t.name === e.tool);
      if (open) open.refused = true;
      return;
    }
    case 'tool_end': {
      const t = st.tools.get(e.id);
      if (!t) return;
      st.tools.delete(e.id);
      const outcome = t.refused ? 'refused' : e.ok ? 'ok' : 'error';
      t.span.setAttribute('tugline.tool.outcome', outcome);
      t.span.setAttribute('tugline.tool.duration_ms', e.durationMs);
      if (st.includeContent) t.span.setAttribute('gen_ai.tool.call.result', clip(e.output));
      if (outcome !== 'ok') t.span.setStatus({ code: api.SpanStatusCode.ERROR, message: outcome });
      t.span.end();
      return;
    }
    case 'compaction':
      st.run.addEvent('compaction', { 'tugline.compaction.before_tokens': e.beforeTokens, 'tugline.compaction.after_tokens': e.afterTokens, 'tugline.compaction.strategy': e.strategy });
      return;
    default:
      return;
  }
}

const pendingStarts = new WeakMap<object, { at: number; prompt: string; model: string; runId: string }>();

async function onRunStart(a: AgentApi): Promise<void> {
  const t = telemetryConfig(a.config);
  if (!t.active) return;
  let provider: Provider;
  try {
    await loadApi();
    provider = await providerFor(t);
  } catch (e) {
    loadError = (e as Error).message;
    if (!warned) {
      warned = true;
      a.notice('warn', `telemetry is on but OpenTelemetry is not installed (${loadError}). Install: npm i @opentelemetry/api @opentelemetry/sdk-trace @opentelemetry/resources @opentelemetry/exporter-trace-otlp-http`);
    }
    return;
  }
  const start = pendingStarts.get(a.agent as object) ?? { at: Date.now(), prompt: '', model: a.llm.profile.model, runId: a.runId ?? '' };
  const tracer = provider.getTracer('tugline', '1.0');
  const attrs: Record<string, unknown> = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': a.depth === 0 ? 'tugline' : `tugline.subagent`,
    'gen_ai.request.model': start.model,
    'gen_ai.conversation.id': a.sessionId,
    'tugline.run.id': start.runId,
    'tugline.depth': a.depth,
    'tugline.permission_mode': a.mode,
  };
  if (t.includeContent) attrs['tugline.prompt'] = clip(start.prompt);
  const parent = a.depth > 0 ? parentContextFor(a) : undefined;
  const run = tracer.startSpan('run', { attributes: attrs, startTime: start.at }, parent ?? api!.context.active());
  const st: RunState = { tracer, provider, includeContent: t.includeContent, run, runCtx: api!.trace.setSpan(parent ?? api!.context.active(), run), runId: start.runId, tools: new Map(), costUsd: 0, inTok: 0, outTok: 0 };
  states.set(a.agent as object, st);
  bySession.set(a.sessionId, st);
}

async function onRunEnd(a: AgentApi, info: { runId: string; stopReason: string; finalText: string }): Promise<void> {
  const st = states.get(a.agent as object);
  if (!st || !st.run || !api) return;
  // Approver (C3) calls go straight to the ledger, not through usage events: back-fill them.
  try {
    for (const l of readLedger(a.config.homeDir, localDate())) {
      if (l.kind !== 'approver' || l.run !== info.runId || l.session !== rootSession(a.sessionId) || l.depth !== a.depth) continue;
      const at = new Date(l.ts).getTime();
      st.tracer
        .startSpan('llm.call', { kind: api.SpanKind.CLIENT, startTime: at, attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': l.model, 'gen_ai.usage.input_tokens': l.promptTokens, 'gen_ai.usage.output_tokens': l.completionTokens, 'tugline.cost_usd': l.costUsd, 'tugline.role': 'approver' } }, st.runCtx)
        .end(at);
      st.costUsd += l.costUsd;
    }
  } catch {
    /* telemetry never breaks a run */
  }
  for (const t of st.tools.values()) t.span.end();
  st.tools.clear();
  endTurn(st);
  st.run.setAttribute('tugline.stop_reason', info.stopReason);
  st.run.setAttribute('gen_ai.usage.input_tokens', st.inTok);
  st.run.setAttribute('gen_ai.usage.output_tokens', st.outTok);
  st.run.setAttribute('tugline.cost_usd', st.costUsd);
  if (st.includeContent) st.run.setAttribute('tugline.final_text', clip(info.finalText));
  if (info.stopReason !== 'end_turn') st.run.setStatus({ code: api.SpanStatusCode.ERROR, message: info.stopReason });
  st.run.end();
  st.run = undefined;
  bySession.delete(a.sessionId);
  if (a.depth === 0) await st.provider.forceFlush?.().catch(() => undefined);
}

/**
 * N23 (WS3): add a named event (e.g. `oh.safety_event`) to the innermost open span of this agent's run:
 * the open tool span, else the turn, else the run. Attributes must be content-free. False when tracing is off.
 */
export function addTelemetryEvent(a: AgentApi, name: string, attributes: Record<string, string | number | boolean>): boolean {
  const st = states.get(a.agent as object);
  if (!st?.run) return false;
  try {
    const span = [...st.tools.values()].at(-1)?.span ?? st.turn ?? st.run;
    span.addEvent(name, attributes);
    return true;
  } catch {
    return false;
  }
}

registerAgentExtension({
  id: 'ws8-telemetry',
  // No `depths`: subagents trace their own runs, nested under the parent's task span.
  onEvent(a, e) {
    try {
      if (e.type === 'run_start' && !telemetryConfig(a.config).active) return;
      onEvent(a, e);
    } catch {
      /* observers never break the loop */
    }
  },
  onRunStart,
  onRunEnd,
});
