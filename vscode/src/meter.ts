/**
 * Context meter and cost (SPEC B9). A pure reducer over agent events plus the
 * core context breakdown, so the numbers are unit-tested from synthetic events.
 *
 * - context: the server-reported prompt+completion tokens of the last main-loop
 *   call (exact), else the estimated breakdown total; the meter turns amber once
 *   the conversation reaches the compaction threshold and red near the window.
 * - cost: per request (last call), per task (run, subagents included: their
 *   usage events are forwarded to the parent UI) and per chat session.
 * - prompt cache (v1.1 N10): cached / prompt tokens of the last call and of the
 *   chat session, over the calls whose server reported caching; absent
 *   (never "0 %") when the server does not report it.
 */
import type { AgentEvent } from '../../src/core/types.js';
import type { ContextBreakdown } from '../../src/core/context/breakdown.js';
import { emptyTally, hitPercent, sessionHitPercent, tallyUsage, type CacheTally } from '../../src/core/cache/meter.js';

export interface MeterState {
  window: number;
  /** usable message budget before compaction */
  compactAt: number;
  /** estimated tokens from the last breakdown */
  estimated: number;
  /** tool schema tokens (not part of the compaction budget) */
  tools: number;
  /** server-reported context of the last main call (prompt + completion), 0 = unknown */
  reported: number;
  lastRequest: { tokens: number; cost: number; model?: string; role?: string };
  task: { tokens: number; cost: number; calls: number; subagentCost: number; subagentCalls: number };
  session: { tokens: number; cost: number; calls: number };
  /** N10: prompt-cache tally of this chat (all roles) */
  cache?: CacheTally;
}

export function emptyMeter(window = 0): MeterState {
  return { window, compactAt: 0, estimated: 0, tools: 0, reported: 0, lastRequest: { tokens: 0, cost: 0 }, task: { tokens: 0, cost: 0, calls: 0, subagentCost: 0, subagentCalls: 0 }, session: { tokens: 0, cost: 0, calls: 0 } };
}

const MAIN_ROLES = new Set([undefined, 'main', 'planner']);

export function meterReduce(s: MeterState, e: AgentEvent): MeterState {
  switch (e.type) {
    case 'run_start':
      return { ...s, task: { tokens: 0, cost: 0, calls: 0, subagentCost: 0, subagentCalls: 0 } };
    case 'usage': {
      const tokens = e.usage.promptTokens + e.usage.completionTokens;
      const sub = !MAIN_ROLES.has(e.role) && e.role !== 'summarizer' && e.role !== 'approver' && e.role !== 'editor';
      return {
        ...s,
        cache: tallyUsage(s.cache ?? emptyTally(), e.usage, { role: e.role, model: e.model }),
        reported: MAIN_ROLES.has(e.role) && !e.usage.estimated ? tokens : s.reported,
        lastRequest: { tokens, cost: e.costUsd, model: e.model, role: e.role },
        task: { tokens: s.task.tokens + tokens, cost: s.task.cost + e.costUsd, calls: s.task.calls + 1, subagentCost: s.task.subagentCost + (sub ? e.costUsd : 0), subagentCalls: s.task.subagentCalls + (sub ? 1 : 0) },
        session: { tokens: s.session.tokens + tokens, cost: s.session.cost + e.costUsd, calls: s.session.calls + 1 },
      };
    }
    case 'compaction':
      // the next call reports the smaller context; until then use the estimate
      return { ...s, reported: 0, estimated: e.afterTokens + s.tools };
    default:
      return s;
  }
}

export function withBreakdown(s: MeterState, b: ContextBreakdown): MeterState {
  return { ...s, window: b.window, compactAt: b.compactAt, estimated: b.total, tools: b.tools };
}

export type MeterLevel = 'ok' | 'amber' | 'red';

export interface MeterView {
  used: number;
  window: number;
  pct: number;
  level: MeterLevel;
  label: string;
  title: string;
  cost: string;
  /** N10: "cache 82% · last 91%", empty when the server does not report caching */
  cache: string;
}

function money(n: number): string {
  if (!n) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function meterView(s: MeterState): MeterView {
  const used = s.reported || s.estimated;
  const pct = s.window ? Math.min(100, (used / s.window) * 100) : 0;
  const messages = Math.max(0, used - s.tools);
  const level: MeterLevel = s.window && used >= s.window * 0.95 ? 'red' : s.compactAt && messages >= s.compactAt ? 'amber' : 'ok';
  const hit = s.cache ? sessionHitPercent(s.cache) : undefined;
  const lastHit = s.cache?.last ? hitPercent(s.cache.last.cachedTokens, s.cache.last.promptTokens) : undefined;
  const cache = hit === undefined ? '' : `cache ${hit}%${lastHit !== undefined ? ` · last ${lastHit}%` : ''}`;
  const money3 = s.session.cost ? `${money(s.lastRequest.cost)} req · ${money(s.task.cost)} task · ${money(s.session.cost)} chat` : '';
  const cost = [money3, cache].filter(Boolean).join(' · ');
  return {
    used,
    window: s.window,
    pct: Math.round(pct * 10) / 10,
    level,
    label: `${k(used)} / ${k(s.window)}`,
    title:
      `Context: ${used} of ${s.window} tokens (${pct.toFixed(1)}%)${s.reported ? '' : ', estimated'}; compaction at ~${s.compactAt} message tokens.` +
      (s.task.calls ? ` This task: ${s.task.calls} call(s), ${s.task.tokens} tokens, ${money(s.task.cost)}${s.task.subagentCalls ? ` (subagents: ${s.task.subagentCalls} call(s), ${money(s.task.subagentCost)})` : ''}.` : '') +
      (hit !== undefined ? ` Prompt cache: ${hit}% of ${s.cache!.promptTokens} prompt tokens this chat were served from the server cache${lastHit !== undefined ? `, ${lastHit}% on the last call` : ''}.` : ''),
    cost,
    cache,
  };
}
