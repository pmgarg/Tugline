/**
 * Prompt-cache hit meter (v1.1 N10 display).
 *
 * The hit rate is cached prompt tokens / prompt tokens, counted only over calls
 * whose server reported caching (`usage.cachedTokens` defined); a server that
 * never reports it shows "not reported", not 0 %. One tally per call and per
 * session: subagent calls count toward the session of the agent that spawned
 * them (their session ids are `<parent>-sub-<n>`).
 *
 * The tally is a pure reducer (UIs and tests feed it synthetic usage), plus a
 * per-session registry filled by an agent extension's `onEvent` (register.ts)
 * that `/cost`, `/cache`, the status line and eval reports read.
 */
import type { Usage } from '../types.js';

export interface CacheCall {
  promptTokens: number;
  /** undefined = the server did not report caching for this call */
  cachedTokens?: number;
  role?: string;
  model?: string;
}

export interface CacheTally {
  calls: number;
  /** calls whose server reported cached tokens */
  reportedCalls: number;
  /** prompt tokens of the reporting calls */
  promptTokens: number;
  cachedTokens: number;
  last?: CacheCall;
  /** cache_break events seen (prefix guard) */
  breaks: number;
  lastBreak?: { turn: number; causes: string[]; detail: string; invalidatedTokens: number };
}

export function emptyTally(): CacheTally {
  return { calls: 0, reportedCalls: 0, promptTokens: 0, cachedTokens: 0, breaks: 0 };
}

export function tallyUsage(t: CacheTally, usage: Usage, extra: { role?: string; model?: string } = {}): CacheTally {
  const reported = typeof usage.cachedTokens === 'number' && !usage.estimated;
  const cached = reported ? Math.min(usage.cachedTokens!, usage.promptTokens) : undefined;
  return {
    ...t,
    calls: t.calls + 1,
    reportedCalls: t.reportedCalls + (reported ? 1 : 0),
    promptTokens: t.promptTokens + (reported ? usage.promptTokens : 0),
    cachedTokens: t.cachedTokens + (cached ?? 0),
    last: { promptTokens: usage.promptTokens, cachedTokens: cached, ...extra },
  };
}

/** Hit percentage (one decimal), or undefined when nothing was reported. */
export function hitPercent(cached: number | undefined, prompt: number): number | undefined {
  if (cached === undefined || !(prompt > 0)) return cached === undefined ? undefined : 0;
  return Math.round((cached / prompt) * 1000) / 10;
}

export function sessionHitPercent(t: CacheTally): number | undefined {
  return t.reportedCalls ? hitPercent(t.cachedTokens, t.promptTokens) : undefined;
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** One line for /cost: "prompt cache: 82.4% this session (12.3k of 15.0k prompt tokens, 9 calls) · last call 91.0%". */
export function formatCacheLine(t: CacheTally | undefined): string {
  if (!t || !t.calls) return 'prompt cache: no calls yet';
  if (!t.reportedCalls) return 'prompt cache: not reported by this server';
  const last = t.last?.cachedTokens !== undefined ? ` · last call ${hitPercent(t.last.cachedTokens, t.last.promptTokens)}% (${k(t.last.cachedTokens)} of ${k(t.last.promptTokens)})` : ' · last call: not reported';
  const partial = t.reportedCalls < t.calls ? `, ${t.calls - t.reportedCalls} call(s) without a report` : '';
  return `prompt cache: ${sessionHitPercent(t)}% this session (${k(t.cachedTokens)} of ${k(t.promptTokens)} prompt tokens, ${t.reportedCalls} call(s)${partial})${last}`;
}

/** The /cost text shared by the CLI and VS Code: tokens, cost and the prompt-cache hit rate per session and last call. */
export function costReport(agent: { sessionId: string; totals: { llmCalls: number; promptTokens: number; completionTokens: number; costUsd: number } }): string {
  const t = agent.totals;
  return `${t.llmCalls} LLM calls · ${t.promptTokens} prompt + ${t.completionTokens} completion tokens · $${t.costUsd.toFixed(4)}\n${formatCacheLine(cacheTallyFor(agent.sessionId))}`;
}

// ------------------------------------------------------------ per-session registry

const sessions = new Map<string, CacheTally>();

/** Subagents (`<id>-sub-<n>`, nested) count toward their root session. */
export function rootSessionId(sessionId: string): string {
  return sessionId.replace(/(-sub-\d+)+$/, '');
}

export function cacheTallyFor(sessionId: string): CacheTally | undefined {
  return sessions.get(rootSessionId(sessionId));
}

export function recordUsage(sessionId: string, usage: Usage, extra: { role?: string; model?: string } = {}): void {
  const id = rootSessionId(sessionId);
  sessions.set(id, tallyUsage(sessions.get(id) ?? emptyTally(), usage, extra));
}

export function recordBreak(sessionId: string, b: NonNullable<CacheTally['lastBreak']>): void {
  const id = rootSessionId(sessionId);
  const t = sessions.get(id) ?? emptyTally();
  sessions.set(id, { ...t, breaks: t.breaks + 1, lastBreak: b });
}

export function forgetSession(sessionId: string): void {
  sessions.delete(rootSessionId(sessionId));
}

/** Cache figures for the status-line JSON and eval reports. */
export function cacheSummary(t: CacheTally | undefined): { hit_percent: number | null; cached_tokens: number; prompt_tokens: number; reported_calls: number; last_call_percent: number | null; breaks: number } {
  return {
    hit_percent: t ? (sessionHitPercent(t) ?? null) : null,
    cached_tokens: t?.cachedTokens ?? 0,
    prompt_tokens: t?.promptTokens ?? 0,
    reported_calls: t?.reportedCalls ?? 0,
    last_call_percent: t?.last ? (hitPercent(t.last.cachedTokens, t.last.promptTokens) ?? null) : null,
    breaks: t?.breaks ?? 0,
  };
}

/** Tally the usage events of a recorded run (eval reports read the events, not the live registry). */
export function tallyEvents(events: { type: string; [k: string]: unknown }[]): CacheTally {
  let t = emptyTally();
  for (const e of events) {
    if (e.type === 'usage' && e.usage && typeof e.usage === 'object') t = tallyUsage(t, e.usage as Usage, { role: e.role as string | undefined });
    else if (e.type === 'cache_break') t = { ...t, breaks: t.breaks + 1 };
  }
  return t;
}
