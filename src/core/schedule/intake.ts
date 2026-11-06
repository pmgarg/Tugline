/**
 * Event intake (EAG S16). Every trigger source (cron tick, file change, webhook,
 * GitHub event, parked-wait timer) is normalised to a TriggerEvent and passes
 * the same door, in this order:
 *
 *   1. per-source rate limit, BEFORE anything is persisted or any model is
 *      called (a flood costs nothing; refusals are recorded);
 *   2. dedupe on `source/id`, written down before any decision (a re-delivered
 *      webhook runs once);
 *   3. self-trigger refusal: events whose actor is the runtime itself;
 *   4. parked waits: an event a waiting run asked for resumes that run;
 *   5. gate 1, deterministic matching against the human-written schedules;
 *   6. the window governor (runs per day, daily budget), which the agent cannot
 *      reach. Each run's cost ceiling shrinks to what the window has left.
 *
 * Every step leaves a line in the activity log, which the morning report reads.
 *
 * v1.1:
 *  - R3: a parked wait is resumed only after the same checks a new run gets:
 *    the schedule must still exist (else the wait is cancelled), be enabled
 *    (else the event is stored on the wait and it stays dormant until the
 *    schedule is enabled again), accept the event (it must be addressed to
 *    this schedule, not from an ignored actor) and have budget (else deferred
 *    too). Only then is the wait claimed, with a lease that becomes permanent
 *    once the resumed run is durable; `retryDeferred` (every daemon tick)
 *    delivers deferred events and recovers claims whose run never started.
 *  - R4: admission RESERVES budget in the day's window under a file lock
 *    (USD, tokens and/or GPU-seconds); execution re-checks it and refuses with
 *    a typed `budget` outcome when nothing is left; the end of the run
 *    reconciles the reservation with what was really spent.
 *  - R9: a run holds the workspace lease; a second writer waits for it, or
 *    runs in its own git worktree (`isolation: worktree`).
 */
import crypto from 'node:crypto';
import picomatch from 'picomatch';
import { deepMerge, type HarnessConfig } from '../config.js';
import { createWorktree, finishWorktree } from '../context/worktree.js';
import { acquireWorkspaceLease, describeHolder, keepAlive, leaseConfig, newLeaseToken, releaseWorkspaceLease } from '../workspace/lease.js';
import { cancelWait, claim, clearPending, confirmClaim, deferredWaits, deferWait, findWaitingFor, loadParked, releaseClaim, renewClaim, staleClaims, type ParkedWait } from './parked.js';
import { runScheduled, type ScheduledRunOptions } from './run.js';
import { loadSchedules, markSeen, readWindow, recordActivity, withWindowLock, writeWindow, type Reservation, type ScheduledRunRecord, type WindowCounters } from './store.js';
import { scheduleConfig, type Schedule, type TriggerEvent } from './types.js';

export type RefusalReason = 'rate_limited' | 'duplicate' | 'self_trigger' | 'governor_runs' | 'governor_budget';

export type IntakeOutcome =
  | { status: 'refused'; reason: RefusalReason; detail?: string }
  | { status: 'ignored'; reason: 'no_match' | 'ignored_actor' | 'disabled'; detail?: string }
  /** v1.1 R3: the event matched parked waits that are dormant (paused schedule, or no budget); it is kept on them. */
  | { status: 'deferred'; handles: string[]; reason: 'paused' | 'budget' }
  | { status: 'resumed'; handles: string[]; done: Promise<ScheduledRunRecord[]> }
  | { status: 'accepted'; scheduleIds: string[]; done: Promise<ScheduledRunRecord[]> };

/** What admission reserved for one run (v1.1 R4); undefined fields = no limit in that unit. */
export interface Admission {
  reservationId?: string;
  ceiling?: number;
  tokens?: number;
  gpuSeconds?: number;
}

type Dim = 'usd' | 'tokens' | 'gpuSeconds';
const spentOf = (w: WindowCounters, d: Dim) => (d === 'usd' ? w.costUsd : d === 'tokens' ? w.tokens ?? 0 : w.gpuSeconds ?? 0);
const limitOf = (s: Schedule, d: Dim) => (d === 'usd' ? s.dailyBudgetUsd : d === 'tokens' ? s.dailyTokens : s.dailyGpuSeconds) ?? 0;
const runCapOf = (s: Schedule, d: Dim) => (d === 'usd' ? s.runBudgetUsd : d === 'tokens' ? s.runTokens : s.runGpuSeconds) ?? 0;
const DIMS: Dim[] = ['usd', 'tokens', 'gpuSeconds'];
const fmt = (d: Dim, v: number) => (d === 'usd' ? `$${v.toFixed(4)}` : d === 'tokens' ? `${Math.round(v)} tokens` : `${v.toFixed(1)} GPU-s`);
const reservedOf = (w: WindowCounters, d: Dim, except?: string) => Object.entries(w.reservations ?? {}).reduce((a, [id, r]) => a + (id === except ? 0 : (d === 'usd' ? r.usd : d === 'tokens' ? r.tokens : r.gpuSeconds) ?? 0), 0);
const tidy = (w: WindowCounters): WindowCounters => {
  if (w.reservations && !Object.keys(w.reservations).length) delete w.reservations;
  return w;
};

/** Sliding one-minute window per source. In memory on purpose: it guards the door before anything touches disk. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perMinute: number) {}
  allow(key: string, now = Date.now()): boolean {
    if (this.perMinute <= 0) return true;
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMinute) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

/** GitHub event filter: "pull_request.opened", "issues.*", "push" (also matches "push.<anything>"). */
export function githubEventMatches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === type || p === '*' || (p.endsWith('.*') ? type.startsWith(p.slice(0, -1)) : type.startsWith(`${p}.`)));
}

export function scheduleMatches(s: Schedule, ev: TriggerEvent): boolean {
  if (ev.scheduleId && ev.scheduleId !== s.id) return false;
  switch (s.trigger.type) {
    case 'cron':
      return ev.source === 'cron' && ev.scheduleId === s.id;
    case 'watch':
      return ev.source === 'watch' && ev.scheduleId === s.id && (!ev.subject || picomatch(s.trigger.glob, { dot: true })(ev.subject));
    case 'webhook':
      return ev.scheduleId === s.id && ev.source.startsWith('webhook');
    case 'github':
      return ev.scheduleId === s.id && ev.source.startsWith('github') && githubEventMatches(s.trigger.events, ev.type);
  }
}

export interface IntakeOptions {
  config: HarnessConfig;
  /** Extra self-attribution (the daemon marks files its own runs wrote). */
  isSelfCaused?: (ev: TriggerEvent) => boolean;
  /** Run options passed through to every run (progress output). */
  runOptions?: Partial<ScheduledRunOptions>;
  /** Tests and embedders may replace the run function. Default: a real headless agent run. */
  run?: (o: ScheduledRunOptions) => Promise<ScheduledRunRecord>;
  /** Around every run (the daemon uses these to attribute workspace changes to its own runs). */
  onRunStart?: (s: Schedule) => void;
  onRunEnd?: (s: Schedule) => void;
}

export class Intake {
  readonly limiter: RateLimiter;
  private chains = new Map<string, Promise<unknown>>();
  private inflight = new Set<Promise<unknown>>();
  constructor(private o: IntakeOptions) {
    this.limiter = new RateLimiter(scheduleConfig(o.config).ratePerMinute);
  }

  private get home(): string {
    return this.o.config.homeDir;
  }

  /** Wait for every run started so far (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  isSelf(ev: TriggerEvent): boolean {
    const self = scheduleConfig(this.o.config).selfActors.map((a) => a.toLowerCase());
    if (ev.actor && self.includes(ev.actor.toLowerCase())) return true;
    return !!this.o.isSelfCaused?.(ev);
  }

  handle(ev: TriggerEvent): IntakeOutcome {
    const key = `${ev.source}/${ev.id}`;
    const refuse = (reason: RefusalReason, detail?: string): IntakeOutcome => {
      recordActivity(this.home, { kind: 'refused', key, scheduleId: ev.scheduleId, reason, detail });
      return { status: 'refused', reason, detail };
    };
    // 1. rate limit before persistence
    if (!this.limiter.allow(ev.scheduleId ? `${ev.source}#${ev.scheduleId}` : ev.source)) return refuse('rate_limited', `more than ${scheduleConfig(this.o.config).ratePerMinute}/min from ${ev.source}`);
    // 2. dedupe, written down before deciding anything
    if (!markSeen(this.home, key, { type: ev.type, scheduleId: ev.scheduleId })) return refuse('duplicate');
    recordActivity(this.home, { kind: 'arrived', key, scheduleId: ev.scheduleId, detail: `${ev.type}${ev.actor ? ` by ${ev.actor}` : ''}` });
    // 3. the runtime does not answer itself
    if (this.isSelf(ev)) return refuse('self_trigger', ev.actor ? `actor ${ev.actor}` : 'caused by a scheduled run');
    // 4. parked waits: the same gates as a new run, BEFORE anything is claimed (v1.1 R3)
    // Time waits are addressed by handle; event waits by type/source/subject.
    const waits =
      ev.source === 'time' && ev.subject
        ? [loadParked(this.home, ev.subject)].filter((w): w is ParkedWait => !!w && !!w.waitFor.time && !w.cancelled)
        : findWaitingFor(this.home, ev).waits;
    if (waits.length) {
      const gated = this.gateWaits(waits, ev, key);
      if (gated.resumed.length) return { status: 'resumed', handles: gated.resumed.map((g) => g.w.handle), done: this.track(Promise.all(gated.resumed.map((g) => this.startResume(g.w, g.s, ev, g.adm)))) };
      if (gated.deferred.length) return { status: 'deferred', handles: gated.deferred, reason: gated.deferReason! };
      // Waits that were cancelled or did not accept this event: it continues as an ordinary event.
    }
    // 5. gate 1: deterministic match against human-written schedules
    const all = loadSchedules(this.home).filter((s) => scheduleMatches(s, ev));
    if (!all.length) {
      recordActivity(this.home, { kind: 'ignored', key, scheduleId: ev.scheduleId, reason: 'no_match', detail: ev.type });
      return { status: 'ignored', reason: 'no_match' };
    }
    const enabled = all.filter((s) => s.enabled);
    if (!enabled.length) {
      recordActivity(this.home, { kind: 'ignored', key, scheduleId: all[0].id, reason: 'disabled' });
      return { status: 'ignored', reason: 'disabled' };
    }
    const wanted = enabled.filter((s) => !(ev.actor && (s.ignoreActors ?? []).some((a) => a.toLowerCase() === ev.actor!.toLowerCase())));
    if (!wanted.length) {
      recordActivity(this.home, { kind: 'ignored', key, scheduleId: enabled[0].id, reason: 'ignored_actor', detail: ev.actor });
      return { status: 'ignored', reason: 'ignored_actor' };
    }
    // 6. window governor (admission is synchronous and reserves under a file lock, so two events cannot both take the last slot or the same budget)
    const admitted: { s: Schedule; adm: Admission }[] = [];
    let lastRefusal: IntakeOutcome | undefined;
    for (const s of wanted) {
      const gate = this.admit(s, { for: key });
      if ('reason' in gate) lastRefusal = refuse(gate.reason, `${s.id}: ${gate.detail}`);
      else admitted.push({ s, adm: gate });
    }
    if (!admitted.length) return lastRefusal!;
    const done = Promise.all(admitted.map(({ s, adm }) => this.bracket(s, () => this.serial(s.id, () => this.execute(s, ev, adm)))));
    return { status: 'accepted', scheduleIds: admitted.map((a) => a.s.id), done: this.track(done) };
  }

  /**
   * Window governor: take a run slot (unless `resume`) and reserve budget, or refuse.
   * Each budgeted unit reserves min(runCap, what is neither spent nor reserved);
   * nothing left in any budgeted unit refuses the run.
   */
  admit(s: Schedule, o: { resume?: boolean; for?: string } = {}): Admission | { reason: RefusalReason; detail: string } {
    const sc = scheduleConfig(this.o.config);
    const max = s.maxRunsPerDay && s.maxRunsPerDay > 0 ? s.maxRunsPerDay : sc.defaultMaxRunsPerDay;
    return withWindowLock(this.home, s.id, () => {
      const w = readWindow(this.home, s.id);
      if (!o.resume && max > 0 && w.runs >= max) return { reason: 'governor_runs' as const, detail: `${w.runs}/${max} runs today (UTC)` };
      const res: Reservation = { at: new Date().toISOString(), for: o.for, pid: process.pid };
      const adm: Admission = {};
      for (const d of DIMS) {
        const limit = limitOf(s, d);
        if (!(limit > 0)) continue;
        const spent = spentOf(w, d);
        const reserved = reservedOf(w, d);
        const free = limit - spent - reserved;
        if (free <= 0)
          return { reason: 'governor_budget' as const, detail: `${fmt(d, spent)} spent${reserved > 0 ? ` and ${fmt(d, reserved)} reserved by runs in flight` : ''} of ${fmt(d, limit)} today (UTC)` };
        const cap = runCapOf(s, d);
        const take = cap > 0 ? Math.min(cap, free) : free;
        if (d === 'usd') res.usd = adm.ceiling = take;
        else if (d === 'tokens') res.tokens = adm.tokens = Math.floor(take);
        else res.gpuSeconds = adm.gpuSeconds = take;
      }
      const next: WindowCounters = { ...w, runs: o.resume ? w.runs : w.runs + 1 };
      if (res.usd !== undefined || res.tokens !== undefined || res.gpuSeconds !== undefined) {
        adm.reservationId = `res_${crypto.randomBytes(5).toString('hex')}`;
        next.reservations = { ...(w.reservations ?? {}), [adm.reservationId]: res };
      }
      writeWindow(this.home, s.id, tidy(next));
      return adm;
    });
  }

  /**
   * Execution-time re-check (R4): what this run may use now = min(its reservation,
   * the limit minus spend minus OTHER runs' reservations). The window may have
   * changed while the run queued (the budget was lowered, another process overspent).
   */
  recheck(s: Schedule, adm: Admission): Admission | { detail: string } {
    if (!adm.reservationId) return adm;
    return withWindowLock(this.home, s.id, () => {
      const w = readWindow(this.home, s.id);
      const mine = w.reservations?.[adm.reservationId!];
      const out: Admission = { reservationId: adm.reservationId };
      for (const d of DIMS) {
        const limit = limitOf(s, d);
        if (!(limit > 0)) continue;
        const want = (d === 'usd' ? mine?.usd ?? adm.ceiling : d === 'tokens' ? mine?.tokens ?? adm.tokens : mine?.gpuSeconds ?? adm.gpuSeconds) ?? limit;
        const free = limit - spentOf(w, d) - reservedOf(w, d, adm.reservationId);
        const v = Math.min(want, free);
        if (v <= 0) return { detail: `${fmt(d, spentOf(w, d))} of ${fmt(d, limit)} already used today (UTC) when the run was due to start` };
        if (d === 'usd') out.ceiling = v;
        else if (d === 'tokens') out.tokens = Math.floor(v);
        else out.gpuSeconds = v;
      }
      return out;
    });
  }

  /** Reconcile: drop the reservation and add what the run really used. */
  reconcile(s: Schedule, adm: Admission | undefined, rec: Pick<ScheduledRunRecord, 'costUsd' | 'tokens' | 'gpuSeconds'> | undefined): void {
    withWindowLock(this.home, s.id, () => {
      const w = readWindow(this.home, s.id);
      const next: WindowCounters = { ...w, reservations: { ...(w.reservations ?? {}) } };
      if (adm?.reservationId) delete next.reservations![adm.reservationId];
      next.costUsd = w.costUsd + (rec?.costUsd || 0);
      if (rec?.tokens) next.tokens = (w.tokens ?? 0) + rec.tokens;
      if (rec?.gpuSeconds) next.gpuSeconds = Math.round(((w.gpuSeconds ?? 0) + rec.gpuSeconds) * 1000) / 1000;
      writeWindow(this.home, s.id, tidy(next));
    });
  }

  /**
   * Gate the waits an event matched (v1.1 R3), then claim the ones that pass.
   * Order per wait: schedule exists → event accepted by it → enabled → budget → claim.
   */
  private gateWaits(waits: ParkedWait[], ev: TriggerEvent, key: string): { resumed: { w: ParkedWait; s: Schedule; adm: Admission }[]; deferred: string[]; deferReason?: 'paused' | 'budget' } {
    const schedules = loadSchedules(this.home);
    const sc = scheduleConfig(this.o.config);
    const resumed: { w: ParkedWait; s: Schedule; adm: Admission }[] = [];
    const deferred: string[] = [];
    let deferReason: 'paused' | 'budget' | undefined;
    for (const w of waits) {
      const s = schedules.find((x) => x.id === w.scheduleId);
      if (!s) {
        if (cancelWait(this.home, w.handle, 'schedule removed')) recordActivity(this.home, { kind: 'cancelled', key, scheduleId: w.scheduleId, runId: w.runId, handle: w.handle, reason: 'schedule_removed', detail: 'the schedule no longer exists; the parked run will not resume' });
        continue;
      }
      // Authorisation: an event routed to another schedule (its webhook, its secret) cannot resume this one; ignored actors are ignored here too.
      if (ev.scheduleId && ev.scheduleId !== s.id) continue;
      if (ev.actor && (s.ignoreActors ?? []).some((a) => a.toLowerCase() === ev.actor!.toLowerCase())) {
        recordActivity(this.home, { kind: 'ignored', key, scheduleId: s.id, handle: w.handle, reason: 'ignored_actor', detail: ev.actor });
        continue;
      }
      if (!s.enabled) {
        deferWait(this.home, w, ev, key, 'paused');
        recordActivity(this.home, { kind: 'deferred', key, scheduleId: s.id, runId: w.runId, handle: w.handle, reason: 'paused', detail: 'the schedule is disabled; the wait stays dormant and resumes when it is enabled' });
        deferred.push(w.handle);
        deferReason ??= 'paused';
        continue;
      }
      const adm = this.admit(s, { resume: true, for: `resume:${w.handle}` });
      if ('reason' in adm) {
        deferWait(this.home, w, ev, key, 'budget');
        recordActivity(this.home, { kind: 'deferred', key, scheduleId: s.id, runId: w.runId, handle: w.handle, reason: 'governor_budget', detail: adm.detail });
        deferred.push(w.handle);
        deferReason ??= 'budget';
        continue;
      }
      if (!claim(this.home, w.handle, key, { leaseMs: sc.claimLeaseMs, event: ev })) {
        this.reconcile(s, adm, undefined); // someone else resumed it: give the reservation back
        continue;
      }
      clearPending(this.home, w.handle);
      resumed.push({ w, s, adm });
    }
    return { resumed, deferred, deferReason };
  }

  /**
   * Deliver deferred events whose schedule is enabled again, and recover claims
   * whose resumed run never became durable (a crash after claiming). The daemon
   * calls this every tick; it is safe to call from several processes (claims are O_EXCL).
   */
  retryDeferred(now = new Date()): string[] {
    const handles: string[] = [];
    const runs: Promise<ScheduledRunRecord>[] = [];
    for (const w of deferredWaits(this.home)) {
      const s = loadSchedules(this.home).find((x) => x.id === w.scheduleId);
      if (s && !s.enabled) continue; // still paused
      const p = w.pending!;
      const g = this.gateWaits([w], p.event, p.key);
      for (const r of g.resumed) {
        recordActivity(this.home, { kind: 'reactivated', key: p.key, scheduleId: r.s.id, runId: w.runId, handle: w.handle, reason: p.reason, detail: `delivering the event kept since ${p.at}` });
        handles.push(w.handle);
        runs.push(this.startResume(r.w, r.s, p.event, r.adm));
      }
    }
    for (const { wait: w, claim: c } of staleClaims(this.home, now.getTime())) {
      const ev: TriggerEvent = c.event ?? { id: w.handle, source: 'time', type: 'time.reached', subject: w.handle, receivedAt: now.toISOString() };
      const s = loadSchedules(this.home).find((x) => x.id === w.scheduleId);
      if (s && !s.enabled) continue;
      recordActivity(this.home, { kind: 'reactivated', key: `${ev.source}/${ev.id}`, scheduleId: w.scheduleId, runId: w.runId, handle: w.handle, reason: 'claim_expired', detail: `claimed by ${c.by} at ${c.at}, but the resumed run never became durable; resuming again` });
      const g = this.gateWaits([w], ev, `${ev.source}/${ev.id}`);
      for (const r of g.resumed) {
        handles.push(w.handle);
        runs.push(this.startResume(r.w, r.s, ev, r.adm));
      }
    }
    if (runs.length) this.track(Promise.all(runs)).catch(() => undefined);
    return handles;
  }

  /** onRunStart fires at admission (synchronously), so the daemon knows the workspace is busy before the run starts. */
  private bracket<T>(s: Schedule, fn: () => Promise<T>): Promise<T> {
    this.o.onRunStart?.(s);
    return fn().finally(() => this.o.onRunEnd?.(s));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /** One run at a time per schedule (they share a workspace). */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(id, next);
    return next;
  }

  private runFn(): (o: ScheduledRunOptions) => Promise<ScheduledRunRecord> {
    return this.o.run ?? runScheduled;
  }

  /** A refused-at-execution record: nothing ran (typed `budget` outcome, v1.1 R4). */
  private budgetRecord(s: Schedule, ev: TriggerEvent, detail: string, runId?: string): ScheduledRunRecord {
    const now = new Date().toISOString();
    recordActivity(this.home, { kind: 'refused', key: `${ev.source}/${ev.id}`, scheduleId: s.id, runId, reason: 'governor_budget', detail: `at execution: ${detail}` });
    return { runId: runId ?? `sr_budget_${crypto.randomBytes(4).toString('hex')}`, scheduleId: s.id, eventKey: `${ev.source}/${ev.id}`, sessionId: '', mode: s.mode ?? 'ask', startedAt: now, endedAt: now, status: 'budget', stopReason: 'budget', costUsd: 0, refusals: [], finalText: detail };
  }

  /**
   * Run `fn` owning the schedule's workspace (v1.1 R9). Another writer holds it:
   * `isolation: worktree` runs in a fresh worktree instead; otherwise wait for it
   * (up to workspaceWaitMs), then give up with an error record.
   */
  private async withWorkspace(s: Schedule, ev: TriggerEvent, runLabel: string, fn: (s: Schedule, cfg: HarnessConfig) => Promise<ScheduledRunRecord>): Promise<ScheduledRunRecord> {
    const lc = leaseConfig(this.o.config);
    const token = newLeaseToken();
    const holder = { kind: 'schedule' as const, id: runLabel, token, label: `schedule ${s.name ?? s.id}` };
    const waitMs = s.isolation === 'worktree' ? 0 : s.workspaceWaitMs ?? lc.waitMs;
    const got = await acquireWorkspaceLease(this.home, s.workspace, holder, {
      waitMs,
      staleMs: lc.staleMs,
      onWait: (l) => recordActivity(this.home, { kind: 'skipped', key: `${ev.source}/${ev.id}`, scheduleId: s.id, reason: 'workspace_busy', detail: `waiting: ${describeHolder(l)} is writing in ${s.workspace}` }),
    });
    if (got.ok) {
      const stop = keepAlive(this.home, s.workspace, token, lc.heartbeatMs);
      try {
        return await fn(s, deepMerge(this.o.config, { workspaceLease: { token } }) as HarnessConfig);
      } finally {
        stop();
        if (!got.reentered) releaseWorkspaceLease(this.home, s.workspace, token);
      }
    }
    if (s.isolation !== 'worktree') {
      const detail = `workspace still held by ${describeHolder(got.heldBy)} after ${Math.round(waitMs / 1000)}s`;
      recordActivity(this.home, { kind: 'error', key: `${ev.source}/${ev.id}`, scheduleId: s.id, reason: 'workspace_busy', detail });
      const now = new Date().toISOString();
      return { runId: `sr_busy_${crypto.randomBytes(4).toString('hex')}`, scheduleId: s.id, eventKey: `${ev.source}/${ev.id}`, sessionId: '', mode: s.mode ?? 'ask', startedAt: now, endedAt: now, status: 'error', stopReason: 'workspace_busy', costUsd: 0, refusals: [], finalText: detail };
    }
    // Second writer, worktree isolation: its own checkout of HEAD on branch oh/sched-<label>.
    const wt = await createWorktree(s.workspace, `sched-${runLabel.replace(/[^A-Za-z0-9._-]/g, '-')}`);
    recordActivity(this.home, { kind: 'skipped', key: `${ev.source}/${ev.id}`, scheduleId: s.id, reason: 'workspace_busy', detail: `${describeHolder(got.heldBy)} holds ${s.workspace}; running in worktree ${wt.branch}` });
    const inWt = { ...s, workspace: wt.path };
    // The worktree is new and ours; its lease tells other tools who is writing there.
    const t2 = newLeaseToken();
    await acquireWorkspaceLease(this.home, wt.path, { ...holder, token: t2 });
    let rec: ScheduledRunRecord | undefined;
    try {
      rec = await fn(inWt, deepMerge(this.o.config, { workspaceLease: { token: t2 } }) as HarnessConfig);
      return rec;
    } finally {
      releaseWorkspaceLease(this.home, wt.path, t2);
      const r = await finishWorktree(wt, `Tugline scheduled run ${runLabel} (${s.name ?? s.id})`).catch(() => undefined);
      if (rec) {
        rec.worktreeBranch = r?.committed ? r.branch : undefined;
        recordActivity(this.home, { kind: 'acted', key: `${ev.source}/${ev.id}`, scheduleId: s.id, runId: rec.runId, detail: r?.committed ? `worktree changes committed on ${r.branch}` : 'worktree run made no changes' });
      }
    }
  }

  private async execute(s: Schedule, ev: TriggerEvent, adm: Admission = {}): Promise<ScheduledRunRecord> {
    const now = this.recheck(s, adm);
    if ('detail' in now) {
      this.reconcile(s, adm, undefined);
      return this.budgetRecord(s, ev, now.detail);
    }
    let rec: ScheduledRunRecord | undefined;
    try {
      rec = await this.withWorkspace(s, ev, `${s.id}-${crypto.randomBytes(3).toString('hex')}`, (sw, cfg) =>
        this.runFn()({ ...(this.o.runOptions ?? {}), config: cfg, schedule: sw, event: ev, costCeilingUsd: now.ceiling, tokenCeiling: now.tokens, gpuSecondsCeiling: now.gpuSeconds, gpuShare: s.gpuShare ?? scheduleConfig(this.o.config).gpuShare }),
      );
    } finally {
      this.reconcile(s, adm, rec);
    }
    recordActivity(this.home, { kind: 'acted', key: `${ev.source}/${ev.id}`, scheduleId: s.id, runId: rec.runId, costUsd: rec.costUsd, stopReason: rec.stopReason, detail: rec.status });
    return rec;
  }

  /** Keep the claim's lease alive while the resume waits its turn and starts; it ends once the run is durable. */
  private startResume(w: ParkedWait, s: Schedule, ev: TriggerEvent, adm: Admission): Promise<ScheduledRunRecord> {
    const leaseMs = scheduleConfig(this.o.config).claimLeaseMs;
    const t = setInterval(() => renewClaim(this.home, w.handle, leaseMs), Math.max(1000, Math.floor(leaseMs / 3)));
    t.unref?.();
    return this.bracket(s, () => this.resume(w, s, ev, adm)).finally(() => clearInterval(t));
  }

  private async resume(w: ParkedWait, s0: Schedule, ev: TriggerEvent, adm: Admission): Promise<ScheduledRunRecord> {
    // A resumed run is the same run continuing: it spends from the window but does not take a new run slot.
    return this.serial(s0.id, async () => {
      // Re-check at execution time: the schedule may have been disabled or removed while this queued.
      const s = loadSchedules(this.home).find((x) => x.id === s0.id);
      if (!s || !s.enabled) {
        this.reconcile(s0, adm, undefined);
        if (!s) {
          cancelWait(this.home, w.handle, 'schedule removed');
          recordActivity(this.home, { kind: 'cancelled', scheduleId: s0.id, runId: w.runId, handle: w.handle, reason: 'schedule_removed' });
        } else {
          releaseClaim(this.home, w.handle);
          deferWait(this.home, w, ev, `${ev.source}/${ev.id}`, 'paused');
          recordActivity(this.home, { kind: 'deferred', scheduleId: s.id, runId: w.runId, handle: w.handle, reason: 'paused', detail: 'disabled before the resume started' });
        }
        const now = new Date().toISOString();
        return { runId: w.runId, scheduleId: s0.id, sessionId: '', mode: s0.mode ?? 'ask', startedAt: now, endedAt: now, status: s ? 'parked' : 'error', stopReason: s ? 'paused' : 'schedule_removed', costUsd: 0, refusals: [], handle: w.handle } as ScheduledRunRecord;
      }
      const now = this.recheck(s, adm);
      if ('detail' in now) {
        this.reconcile(s, adm, undefined);
        releaseClaim(this.home, w.handle);
        deferWait(this.home, w, ev, `${ev.source}/${ev.id}`, 'budget');
        return this.budgetRecord(s, ev, now.detail, w.runId);
      }
      recordActivity(this.home, { kind: 'resumed', key: `${ev.source}/${ev.id}`, scheduleId: s.id, runId: w.runId, handle: w.handle });
      let rec: ScheduledRunRecord | undefined;
      try {
        rec = await this.withWorkspace(s, ev, w.runId, (sw, cfg) =>
          this.runFn()({
            ...(this.o.runOptions ?? {}),
            config: cfg,
            schedule: { ...sw, workspace: s.isolation === 'worktree' ? sw.workspace : w.workspace },
            event: ev,
            resume: w,
            costCeilingUsd: now.ceiling,
            tokenCeiling: now.tokens,
            gpuSecondsCeiling: now.gpuSeconds,
            gpuShare: s.gpuShare ?? scheduleConfig(this.o.config).gpuShare,
            onDurable: () => confirmClaim(this.home, w.handle),
          }),
        );
      } finally {
        this.reconcile(s, adm, rec);
      }
      // A run function that never reported durability (test doubles, a run that ended before saving): it finished, so the claim is final.
      if (rec.status !== 'error' || rec.journal) confirmClaim(this.home, w.handle);
      recordActivity(this.home, { kind: 'acted', key: `${ev.source}/${ev.id}`, scheduleId: s.id, runId: rec.runId, costUsd: rec.costUsd, stopReason: rec.stopReason, detail: `resumed ${w.handle}: ${rec.status}` });
      return rec;
    });
  }
}
