/**
 * N10 agent extensions (SPEC S0.3): the cache meter, the stable-prefix guard
 * and idle-time compaction. Registered from cache/register.ts.
 *
 * Idle compaction: after a top-level run of an interactive session (a UI that
 * can ask the user) ends, if nothing is queued and the
 * history is past `promptCache.idleCompactAt` of the compaction budget, the
 * agent compacts while the user reads the answer (`agent.compactNow`, the same
 * admitted, metered path as /compact; a D8 background summary is swapped in
 * without another model call when it is still valid). Compaction keeps
 * messages[0] (the system prompt) and the tool list untouched, so the
 * system+tools prefix stays cached; only the history after it is re-read. A
 * prompt that arrives while it is in flight waits for it in `beforeTurn`, so
 * the run never races the swap of the message array.
 */
import type { AgentEvent, ChatMessage, ModelProfile, ToolSpec } from '../types.js';
import type { HarnessConfig } from '../config.js';
import type { AgentApi, AgentExtension } from '../agent/extensions.js';
import { estimateMessagesTokens, estimateTokens } from '../util/text.js';
import { diffSnapshots, takeSnapshot, type PrefixSnapshot } from './prefix.js';
import { forgetSession, recordBreak, recordUsage } from './meter.js';
import { promptCacheSettings } from './settings.js';

/** The parts of Agent this module uses (agent.ts is not imported: no cycle). */
export interface CacheAgent {
  messages: ChatMessage[];
  readonly isRunning: boolean;
  readonly queued: number;
  readonly config: HarnessConfig;
  llm: { profile: ModelProfile };
  toolSpecs(): ToolSpec[];
  compactNow(force?: boolean, instructions?: string): Promise<void>;
  readonly opts?: { ui?: { askUser?: unknown; requestPermission?: unknown } };
}

const asAgent = (a: AgentApi) => a.agent as CacheAgent;

// ------------------------------------------------------------ meter

export const cacheMeterExtension: AgentExtension = {
  id: 'ws10-cache-meter',
  onEvent(a, e) {
    if (e.type === 'usage') recordUsage(a.sessionId, e.usage, { role: e.role, model: e.model });
    else if (e.type === 'cache_break') recordBreak(a.sessionId, { turn: e.turn, causes: e.causes, detail: e.detail, invalidatedTokens: e.invalidatedTokens });
  },
  onSessionEnd(a) {
    if (a.depth === 0) forgetSession(a.sessionId);
  },
};

// ------------------------------------------------------------ prefix guard

interface GuardState {
  snap?: PrefixSnapshot;
  compacted: boolean;
}
const guards = new WeakMap<object, GuardState>();

function guardState(owner: object): GuardState {
  let s = guards.get(owner);
  if (!s) guards.set(owner, (s = { compacted: false }));
  return s;
}

/** Compare this turn's prefix with the previous turn's; returns the event it emitted, if any. */
export function checkPrefix(a: AgentApi, turn: number): Extract<AgentEvent, { type: 'cache_break' }> | undefined {
  const agent = asAgent(a);
  const st = guardState(agent);
  const tools = agent.toolSpecs();
  const snap = takeSnapshot(`${agent.llm.profile.baseUrl}|${agent.llm.profile.model}`, agent.messages, tools);
  const prev = st.snap;
  const compacted = st.compacted;
  st.snap = snap;
  st.compacted = false;
  if (!prev) return undefined;
  const b = diffSnapshots(prev, snap, agent.messages, tools, compacted);
  if (!b) return undefined;
  const e = { type: 'cache_break' as const, turn, ...b };
  a.emit(e);
  return e;
}

export const prefixGuardExtension: AgentExtension = {
  id: 'ws10-prefix-guard',
  async beforeTurn(a, turn) {
    // an idle compaction still in flight finishes first (it replaces the message array)
    await idle.get(a.agent as object)?.inflight;
    if (promptCacheSettings(a.config).guard) checkPrefix(a, turn);
  },
  onEvent(a, e) {
    if (e.type === 'compaction') guardState(a.agent as object).compacted = true;
  },
};

// ------------------------------------------------------------ idle compaction

interface IdleState {
  timer?: ReturnType<typeof setTimeout>;
  inflight?: Promise<void>;
}
const idle = new WeakMap<object, IdleState>();

function idleState(owner: object): IdleState {
  let s = idle.get(owner);
  if (!s) idle.set(owner, (s = {}));
  return s;
}

/** The agent's compaction budget (same formula as Agent.budget). */
export function compactionBudget(agent: CacheAgent): number {
  const p = agent.llm.profile;
  const toolTokens = estimateTokens(JSON.stringify(agent.toolSpecs()));
  return Math.max(2000, Math.floor((p.contextWindow - p.maxOutputTokens - toolTokens) * agent.config.agent.compactAt));
}

/**
 * Compact now if the agent is idle and past the idle threshold. Returns the
 * in-flight promise (undefined when nothing was started).
 */
export function maybeIdleCompact(a: AgentApi): Promise<void> | undefined {
  const agent = asAgent(a);
  const st = idleState(agent);
  if (st.inflight || agent.isRunning || agent.queued > 0) return undefined;
  const s = promptCacheSettings(a.config);
  const tokens = estimateMessagesTokens(agent.messages);
  const budget = compactionBudget(agent);
  if (tokens <= s.idleCompactAt * budget) return undefined;
  a.journal({ type: 'idle_compaction', tokens, budget });
  a.notice('info', `idle: compacting the conversation (~${tokens} of ${budget} budget tokens) while no prompt is pending; the system prompt and tools stay cached`);
  st.inflight = agent
    .compactNow(true)
    .catch((e) => a.notice('warn', `idle compaction failed: ${(e as Error).message}`))
    .finally(() => {
      st.inflight = undefined;
    });
  return st.inflight;
}

function clearIdleTimer(owner: object): void {
  const st = idle.get(owner);
  if (st?.timer) clearTimeout(st.timer);
  if (st) st.timer = undefined;
}

export const idleCompactionExtension: AgentExtension = {
  id: 'ws10-idle-compaction',
  depths: [0],
  onRunStart(a) {
    clearIdleTimer(a.agent as object);
  },
  onRunEnd(a) {
    const s = promptCacheSettings(a.config);
    // Only sessions a person returns to: headless runs (eval, arena, review, schedules, `tug -p`) never get another prompt,
    // and an idle summary there would only cost a model call (and evict a llama.cpp slot of the next task).
    const ui = asAgent(a).opts?.ui;
    if (!s.idleCompaction || !(ui?.askUser || ui?.requestPermission)) return;
    const owner = a.agent as object;
    clearIdleTimer(owner);
    const st = idleState(owner);
    // The run is still "running" while onRunEnd executes; the timer fires after it has ended.
    st.timer = setTimeout(() => {
      st.timer = undefined;
      maybeIdleCompact(a);
    }, s.idleCompactMs);
    st.timer.unref?.();
  },
  async onSessionEnd(a) {
    clearIdleTimer(a.agent as object);
    await idle.get(a.agent as object)?.inflight;
  },
};

/** Test helper: the pending idle compaction of an agent, if any. */
export function idleCompactionInFlight(agent: object): Promise<void> | undefined {
  return idle.get(agent)?.inflight;
}
