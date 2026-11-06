/**
 * One admission point for every model request (v1.1 R4).
 *
 * v1.0 checked the C7 limits only in the main loop's turn gate, so helper calls
 * (summaries, background compaction, auto-memory, the approver classifier, the
 * apply model, browser-task and arena/review helpers) were metered but never
 * admitted. Now `LLMClient.complete()` asks this module before it sends
 * anything:
 *   1. the caller's scope (who is calling: config, session, run, depth, kind)
 *      comes from AsyncLocalStorage, so an Agent sets it once around a run,
 *      a helper call or a background task and every nested call inherits it;
 *   2. the worst case of the call (estimated prompt + maxTokens/maxOutputTokens)
 *      is checked against the limits PLUS what in-flight calls have reserved,
 *      then reserved;
 *   3. after the call (or its failure) the reservation is released and the
 *      actual usage reconciled through the policy's `settle` (the ledger).
 * A refused call throws LLMError(kind 'budget') without sending a request.
 *
 * Limits use distinct values for unlimited (`undefined`) and exhausted (`0`
 * or less): an exhausted budget refuses every call. The policy itself (which
 * limits, which ledger) is registered by C7 (`permissions/limits.ts`), so this
 * module has no dependency on it.
 *
 * Reservations are atomic within a process (Node runs this synchronously);
 * across processes the ledger is re-read on every admission, which leaves a
 * window of one in-flight call per other process (documented residual risk).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { HarnessConfig } from '../config.js';
import type { ModelProfile, Usage } from '../types.js';
import { estimateMessagesTokens, estimateTokens } from '../util/text.js';

export interface AdmissionScope {
  config: HarnessConfig;
  sessionId: string;
  runId?: string;
  depth: number;
  /** ledger kind: 'agent' (default), 'approver', 'channel', 'arena', … */
  kind?: string;
  /** role tag (main, summarizer, explore, approver, editor, …) */
  role?: string;
  /** per-run budget of the enclosing agent run (agent.maxCostUsd / agent.maxTokens) */
  run?: { maxCostUsd?: number; maxTokens?: number; spent: () => { costUsd: number; tokens: number } };
  /** the caller records usage itself (e.g. through a usage event); settle must not record it again */
  metered?: boolean;
  /**
   * v1.2 N18/N34: shared budgets this call also draws from (a parent run's budget inherited downward, a
   * workflow's total, a per-item cap, a team's total, a per-member cap). Each is checked against the worst
   * case plus what other in-flight calls of the pool hold, reserved, and reconciled with the actual usage.
   */
  pools?: BudgetPool[];
}

/** v1.2 N18/N34: a budget shared by every call whose scope lists it (a subtree of agents). */
export interface BudgetPool {
  /** names the budget in the refusal, e.g. "workflow total (maxTokens 20000)" */
  label: string;
  /** undefined = unlimited; ≤ 0 = exhausted */
  maxTokens?: number;
  maxCostUsd?: number;
  /** actual usage settled so far */
  used: Reserved;
  /** what in-flight calls hold */
  reserved: Reserved;
}

export function newBudgetPool(label: string, limits: { maxTokens?: number; maxCostUsd?: number } = {}): BudgetPool {
  return { label, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd, used: { tokens: 0, costUsd: 0 }, reserved: { tokens: 0, costUsd: 0 } };
}

/** Why `est` does not fit in `pool`, or undefined. */
export function poolRefusal(pool: BudgetPool, est: Pick<CallEstimate, 'tokens' | 'costUsd'>): string | undefined {
  const t = limitState(pool.maxTokens);
  const c = limitState(pool.maxCostUsd);
  if (t === 'exhausted' || c === 'exhausted') return `Stopped before the model call: the ${pool.label} budget is exhausted.`;
  const tokens = pool.used.tokens + pool.reserved.tokens;
  if (t === 'limited' && tokens + est.tokens > pool.maxTokens!) return `Stopped before the model call: it could use up to ${est.tokens} tokens and the ${pool.label} budget has ${Math.max(0, pool.maxTokens! - tokens)} of ${pool.maxTokens} left.`;
  const cost = pool.used.costUsd + pool.reserved.costUsd;
  if (c === 'limited' && est.costUsd > 0 && cost + est.costUsd > pool.maxCostUsd!) return `Stopped before the model call: it could cost up to $${est.costUsd.toFixed(4)} and the ${pool.label} budget has $${Math.max(0, pool.maxCostUsd! - cost).toFixed(4)} of $${pool.maxCostUsd!.toFixed(4)} left.`;
  return undefined;
}

export interface CallEstimate {
  promptTokens: number;
  maxOutputTokens: number;
  tokens: number;
  costUsd: number;
}

export interface Reserved {
  tokens: number;
  costUsd: number;
}

export interface AdmissionPolicy {
  /** A refusal message, or undefined to admit. `reserved` = what other in-flight calls hold (same day / same session). */
  check(scope: AdmissionScope, est: CallEstimate, reserved: { day: Reserved; session: Reserved }): string | undefined;
  /** Reconcile after a call: record the actual usage (not called for refused calls). */
  settle?(scope: AdmissionScope, usage: Usage, model: string, profile: ModelProfile): void;
  /** Rough cost of a usage for this profile (pricing), used for estimates. */
  cost(usage: Usage, profile: ModelProfile): number;
}

const als = new AsyncLocalStorage<AdmissionScope>();
let policy: AdmissionPolicy | undefined;

export function setAdmissionPolicy(p: AdmissionPolicy | undefined): void {
  policy = p;
}

/** Run `fn` with this admission scope (nested calls inherit it). */
export function withAdmissionScope<T>(scope: AdmissionScope, fn: () => T): T {
  return als.run(scope, fn);
}

/** Run `fn` in the current scope with some fields overridden (e.g. kind 'approver'). */
export function withScopeOverride<T>(over: Partial<AdmissionScope>, fn: () => T): T {
  const cur = als.getStore();
  return cur ? als.run({ ...cur, ...over }, fn) : fn();
}

export function currentAdmissionScope(): AdmissionScope | undefined {
  return als.getStore();
}

/** Limit semantics: undefined = unlimited; a number ≤ 0 = exhausted; anything that is not a finite number (null, a string, NaN) fails closed as exhausted. */
export function limitState(v: number | undefined | null): 'unlimited' | 'exhausted' | 'limited' {
  if (v === undefined) return 'unlimited';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'exhausted';
  return v <= 0 ? 'exhausted' : 'limited';
}

// ------------------------------------------------------------ reservations

const byDay = new Map<string, Reserved>();
const bySession = new Map<string, Reserved>();
const rootOf = (id: string) => id.replace(/(?:-sub(?:-\d+)?)+$/, '');
const add = (m: Map<string, Reserved>, k: string, r: Reserved, sign: 1 | -1) => {
  const cur = m.get(k) ?? { tokens: 0, costUsd: 0 };
  const next = { tokens: cur.tokens + sign * r.tokens, costUsd: cur.costUsd + sign * r.costUsd };
  if (next.tokens <= 0 && next.costUsd <= 1e-12) m.delete(k);
  else m.set(k, next);
};

/** What in-flight calls currently hold (tests, /usage). */
export function reservedNow(homeDir: string, sessionId?: string): { day: Reserved; session: Reserved } {
  return { day: byDay.get(homeDir) ?? { tokens: 0, costUsd: 0 }, session: (sessionId && bySession.get(rootOf(sessionId))) || { tokens: 0, costUsd: 0 } };
}

export function estimateCall(profile: ModelProfile, req: { messages: Parameters<typeof estimateMessagesTokens>[0]; tools?: unknown[]; maxTokens?: number }, cost: (u: Usage, p: ModelProfile) => number): CallEstimate {
  const promptTokens = estimateMessagesTokens(req.messages) + (req.tools?.length ? estimateTokens(JSON.stringify(req.tools)) : 0);
  const maxOutputTokens = req.maxTokens ?? profile.maxOutputTokens ?? 0;
  return { promptTokens, maxOutputTokens, tokens: promptTokens + maxOutputTokens, costUsd: cost({ promptTokens, completionTokens: maxOutputTokens }, profile) };
}

export interface Ticket {
  scope: AdmissionScope;
  est: CallEstimate;
  released: boolean;
}

/**
 * Admit one request: returns a ticket (release it with `settleCall`), undefined
 * when there is no scope or no policy (calls outside any agent/helper scope are
 * not governed), or throws the refusal message via `refuse`.
 */
export function admitCall(profile: ModelProfile, req: { messages: Parameters<typeof estimateMessagesTokens>[0]; tools?: unknown[]; maxTokens?: number }, refuse: (message: string) => never): Ticket | undefined {
  const scope = als.getStore();
  if (!scope) return undefined;
  // v1.2 N18/N34: shared budgets (inherited run budget, workflow, team) are checked even without a C7 policy
  const pools = scope.pools ?? [];
  if (!policy && !pools.length) return undefined;
  const est = estimateCall(profile, req, policy?.cost ?? (() => 0));
  const checkPools = () => {
    for (const p of pools) {
      const why = poolRefusal(p, est);
      if (why) refuse(why);
    }
  };
  if (!policy) {
    checkPools();
    for (const p of pools) addTo(p.reserved, est, 1);
    return { scope, est, released: false };
  }
  // the enclosing run's own budget (agent.maxCostUsd / agent.maxTokens)
  if (scope.run) {
    const spent = scope.run.spent();
    const c = limitState(scope.run.maxCostUsd);
    const t = limitState(scope.run.maxTokens);
    if (c === 'exhausted' || t === 'exhausted') refuse('Stopped before the model call: the run budget is exhausted (agent.maxCostUsd / agent.maxTokens is 0).');
    if (c === 'limited' && est.costUsd > 0 && spent.costUsd + est.costUsd > scope.run.maxCostUsd!) refuse(`Stopped before the model call: it could cost up to $${est.costUsd.toFixed(4)} and this run has spent $${spent.costUsd.toFixed(4)} of its $${scope.run.maxCostUsd!.toFixed(4)} budget (agent.maxCostUsd).`);
    if (t === 'limited' && spent.tokens + est.tokens > scope.run.maxTokens!) refuse(`Stopped before the model call: it could use up to ${est.tokens} tokens and this run has used ${spent.tokens} of its ${scope.run.maxTokens} (agent.maxTokens).`);
  }
  const home = scope.config.homeDir;
  const root = rootOf(scope.sessionId);
  const msg = policy.check(scope, est, { day: byDay.get(home) ?? { tokens: 0, costUsd: 0 }, session: bySession.get(root) ?? { tokens: 0, costUsd: 0 } });
  if (msg) refuse(msg);
  // after the run's own limits and the C7 limits, so their refusals keep their wording
  checkPools();
  add(byDay, home, est, 1);
  add(bySession, root, est, 1);
  for (const p of pools) addTo(p.reserved, est, 1);
  return { scope, est, released: false };
}

function addTo(r: Reserved, by: Reserved, sign: 1 | -1): void {
  r.tokens = Math.max(0, r.tokens + sign * by.tokens);
  r.costUsd = Math.max(0, r.costUsd + sign * by.costUsd);
}

/** Release the reservation and reconcile the actual usage (usage undefined = the call failed before any usage). */
export function settleCall(t: Ticket | undefined, usage: Usage | undefined, model: string, profile: ModelProfile): void {
  if (!t || t.released) return;
  t.released = true;
  // v1.2 N18/N34: pools give back the reservation and keep the actual usage
  for (const p of t.scope.pools ?? []) {
    addTo(p.reserved, t.est, -1);
    if (usage) {
      p.used.tokens += usage.promptTokens + usage.completionTokens;
      p.used.costUsd += policy ? policy.cost(usage, profile) : 0;
    }
  }
  if (!policy) return;
  add(byDay, t.scope.config.homeDir, t.est, -1);
  add(bySession, rootOf(t.scope.sessionId), t.est, -1);
  if (usage && !t.scope.metered) {
    try {
      policy?.settle?.(t.scope, usage, model, profile);
    } catch {
      /* the ledger must never break a call */
    }
  }
}

// ------------------------------------------------------------ raw requests (IDE autocomplete, next-edit)

export type RawTicket =
  | {
      ok: true;
      /** the reply arrived: its usage, or an estimate from the text when the server reported none; no arguments = nothing was spent (never sent, refused) */
      done(usage?: { promptTokens: number; completionTokens: number }, completionText?: string): void;
      /** cancelled or timed out after it was sent: the server spent tokens on it, so the prompt estimate is recorded (marked estimated) */
      cancelled(): void;
    }
  | { ok: false; reason: string };
/** Admit one raw /completions request (not made through LLMClient): prompt text, output limit, model. */
export type AdmitHook = (promptText: string, maxTokens: number, model: string) => RawTicket;

/**
 * v1.1 R4 (batch 3): admission for requests that bypass LLMClient (VS Code autocomplete / FIM and
 * next-edit suggestions post to /completions themselves). Same policy, reservation and settle as
 * every other request: one ledger line per request (kind 'fim' / 'nes'), with the server's usage, or
 * an estimate from the text (marked estimated) when the server reports none. Refused → `{ok:false}`;
 * the caller stops quietly. The hook is built by the core module, so it is the core's admission
 * whichever copy of the extension code calls it.
 */
export function rawAdmission(config: HarnessConfig, o: { kind: string; role: string; sessionId?: string; pricing?: ModelProfile['pricing'] }): AdmitHook {
  return (promptText, maxTokens, model) => {
    const profile = { model, maxOutputTokens: maxTokens, pricing: o.pricing } as ModelProfile;
    let ticket: Ticket | undefined;
    try {
      ticket = withAdmissionScope({ config, sessionId: o.sessionId ?? `vscode-${o.kind}`, depth: 0, kind: o.kind, role: o.role }, () =>
        admitCall(profile, { messages: [{ role: 'user', content: promptText }], maxTokens }, (m) => {
          throw new Error(m);
        }),
      );
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    return {
      ok: true,
      done: (usage, text) => {
        const u: Usage | undefined = usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : text !== undefined ? { promptTokens: estimateTokens(promptText), completionTokens: estimateTokens(text), estimated: true } : undefined;
        settleCall(ticket, u, model, profile);
      },
      // batch 4 low: a request cancelled in flight (the common case while typing) still cost the prompt; the unknown partial output is not guessed
      cancelled: () => settleCall(ticket, { promptTokens: estimateTokens(promptText), completionTokens: 0, estimated: true }, model, profile),
    };
  };
}
