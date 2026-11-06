/**
 * `tug daemon`: the scheduler process (SPEC H1). It
 *  - ticks cron schedules once per minute, under a lease that belongs to the
 *    schedule (a run still going when the next tick fires is a recorded skip,
 *    and a crashed daemon's lease expires);
 *  - watches files for `watch` schedules (debounced);
 *  - serves the webhook routes on 127.0.0.1 (server mode mounts the same handler);
 *  - resumes parked runs whose time has come and expires stale waits;
 *  - writes a heartbeat, and records ticks it missed while it was down.
 *
 * Changes made in a workspace while one of this daemon's runs is working there
 * are attributed to the runtime itself, so a watch schedule cannot trigger on
 * its own edits (S16 self-trigger refusal).
 */
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { HarnessConfig } from '../config.js';
import { cronMatches, minuteKey, nextRun, parseCron, type CronSpec } from './cron.js';
import { beat, liveness } from './heartbeat.js';
import { Intake } from './intake.js';
import { claim, dueTimeWaits, expiredWaits } from './parked.js';
import type { ScheduledRunOptions } from './run.js';
import { loadSchedules, readJson, recordActivity, scheduleDir, writeJsonAtomic, type ScheduledRunRecord } from './store.js';
import { scheduleConfig, type Schedule, type TriggerEvent } from './types.js';
import { createHookHandler, startHookServer } from './webhook.js';

interface Lease {
  owner: string;
  key: string;
  expiresAt: string;
}

const leaseFile = (home: string, id: string) => path.join(scheduleDir(home), 'leases', `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export interface DaemonOptions {
  config: HarnessConfig;
  log?: (s: string) => void;
  /** Tests: replace the run function. */
  run?: (o: ScheduledRunOptions) => Promise<ScheduledRunRecord>;
  runOptions?: Partial<ScheduledRunOptions>;
}

export class Daemon {
  readonly intake: Intake;
  private timers: NodeJS.Timeout[] = [];
  private watchers: fs.FSWatcher[] = [];
  private server?: { url: string; close: () => Promise<void> };
  private lastMinute = '';
  private crons = new Map<string, CronSpec>();
  /** workspace → number of active runs, and when the last one ended (grace for trailing fs events). */
  private activeIn = new Map<string, { n: number; endedAt: number }>();
  private readonly startedAt = new Date().toISOString();
  private readonly owner = `pid:${process.pid}`;

  constructor(private o: DaemonOptions) {
    this.intake = new Intake({
      config: o.config,
      run: o.run,
      runOptions: o.runOptions,
      isSelfCaused: (ev) => ev.source === 'watch' && this.isBusy(ev),
      onRunStart: (s) => this.markActive(s.workspace, +1),
      onRunEnd: (s) => this.markActive(s.workspace, -1),
    });
  }

  private get home(): string {
    return this.o.config.homeDir;
  }

  private log(s: string): void {
    this.o.log?.(s);
  }

  private markActive(ws: string, d: number): void {
    const key = path.resolve(ws);
    const cur = this.activeIn.get(key) ?? { n: 0, endedAt: 0 };
    cur.n = Math.max(0, cur.n + d);
    if (d < 0) cur.endedAt = Date.now();
    this.activeIn.set(key, cur);
  }

  private isBusy(ev: TriggerEvent): boolean {
    const s = loadSchedules(this.home).find((x) => x.id === ev.scheduleId);
    if (!s) return false;
    const a = this.activeIn.get(path.resolve(s.workspace));
    return !!a && (a.n > 0 || Date.now() - a.endedAt < 3000);
  }

  handle(ev: TriggerEvent) {
    return this.intake.handle(ev);
  }

  private cronOf(s: Schedule): CronSpec | undefined {
    if (s.trigger.type !== 'cron') return undefined;
    let c = this.crons.get(s.id);
    if (!c || c.source !== s.trigger.cron) {
      try {
        c = parseCron(s.trigger.cron);
        this.crons.set(s.id, c);
      } catch (e) {
        recordActivity(this.home, { kind: 'error', scheduleId: s.id, detail: `bad cron "${s.trigger.cron}": ${(e as Error).message}` });
        return undefined;
      }
    }
    return c;
  }

  /** Lease for a cron schedule's run. Returns false (and records a skip) when a live lease exists. */
  acquireLease(s: Schedule, key: string, now = new Date()): boolean {
    const f = leaseFile(this.home, s.id);
    const cur = readJson<Lease | undefined>(f, undefined);
    if (cur && new Date(cur.expiresAt) > now) {
      recordActivity(this.home, { kind: 'skipped', scheduleId: s.id, reason: 'lease_held', detail: `previous run (${cur.key}, ${cur.owner}) still holds the lease until ${cur.expiresAt}` });
      return false;
    }
    writeJsonAtomic(f, { owner: this.owner, key, expiresAt: new Date(now.getTime() + scheduleConfig(this.o.config).leaseMs).toISOString() } satisfies Lease);
    return true;
  }

  releaseLease(s: Schedule, key: string): void {
    const f = leaseFile(this.home, s.id);
    const cur = readJson<Lease | undefined>(f, undefined);
    if (cur && cur.key === key) fs.rmSync(f, { force: true });
  }

  /** Evaluate one minute. Safe to call more often: each minute is handled once (and deduped across processes). */
  tick(now = new Date()): void {
    const mk = minuteKey(now);
    if (mk !== this.lastMinute) {
      this.lastMinute = mk;
      for (const s of loadSchedules(this.home)) {
        const c = this.cronOf(s);
        if (!c || !s.enabled || s.trigger.type !== 'cron') continue;
        if (!cronMatches(c, now, s.trigger.tz ?? 'UTC')) continue;
        const id = `${s.id}@${mk}`;
        if (!this.acquireLease(s, id, now)) continue;
        const out = this.handle({ id, source: 'cron', type: 'cron.tick', scheduleId: s.id, data: { scheduledFor: mk }, receivedAt: now.toISOString() });
        if (out.status === 'accepted') out.done.finally(() => this.releaseLease(s, id)).catch(() => undefined);
        else this.releaseLease(s, id);
        this.log(`[cron] ${s.name ?? s.id} @ ${mk}: ${out.status}${'reason' in out ? ` (${out.reason})` : ''}`);
      }
    }
    const enabled = new Set(loadSchedules(this.home).filter((s) => s.enabled).map((s) => s.id));
    for (const w of dueTimeWaits(this.home, now)) {
      // A time wait resumes through the same door as any event (dedupe on the handle). A paused
      // schedule's time wait stays dormant without spending its one delivery (v1.1 R3): it is
      // delivered on the first tick after the schedule is enabled again.
      if (w.pending || (!enabled.has(w.scheduleId) && loadSchedules(this.home).some((s) => s.id === w.scheduleId))) continue;
      this.handle({ id: w.handle, source: 'time', type: 'time.reached', subject: w.handle, receivedAt: now.toISOString() });
    }
    // v1.1 R3: deferred events of re-enabled schedules, and claims whose resumed run never became durable.
    for (const h of this.intake.retryDeferred(now)) this.log(`[wait] ${h} reactivated`);
    for (const w of expiredWaits(this.home, now)) {
      if (claim(this.home, w.handle, 'expiry')) recordActivity(this.home, { kind: 'error', scheduleId: w.scheduleId, runId: w.runId, handle: w.handle, reason: 'wait_expired', detail: `${w.reason} (waited since ${w.createdAt})` });
    }
  }

  /** Record cron ticks that fell between the last heartbeat and now (missed ticks are lost, but not silently). */
  recordMissedTicks(now = new Date()): number {
    const last = liveness(this.home, Number.MAX_SAFE_INTEGER, now).heartbeat?.beatAt;
    if (!last) return 0;
    let n = 0;
    for (const s of loadSchedules(this.home)) {
      const c = this.cronOf(s);
      if (!c || !s.enabled || s.trigger.type !== 'cron') continue;
      let t: Date | undefined = new Date(last);
      for (let i = 0; i < 20; i++) {
        t = nextRun(c, t, s.trigger.tz ?? 'UTC');
        if (!t || t >= now) break;
        recordActivity(this.home, { kind: 'skipped', scheduleId: s.id, reason: 'daemon_down', detail: `tick ${minuteKey(t)} missed (daemon not running)` });
        n++;
      }
    }
    return n;
  }

  private startWatchers(): void {
    for (const s of loadSchedules(this.home)) {
      if (!s.enabled || s.trigger.type !== 'watch') continue;
      const ws = path.resolve(s.workspace);
      const isMatch = picomatch(s.trigger.glob, { dot: true });
      const debounce = s.trigger.debounceMs ?? 2000;
      const pending = new Map<string, NodeJS.Timeout>();
      try {
        const w = fs.watch(ws, { recursive: true }, (_e, file) => {
          if (!file) return;
          const rel = String(file).split(path.sep).join('/');
          if (rel.startsWith('.git/') || rel.startsWith('.tugline/') || rel.includes('node_modules/') || !isMatch(rel)) return;
          clearTimeout(pending.get(rel));
          pending.set(
            rel,
            setTimeout(() => {
              pending.delete(rel);
              let stamp = Date.now();
              try {
                stamp = Math.floor(fs.statSync(path.join(ws, rel)).mtimeMs);
              } catch {
                /* deleted */
              }
              const out = this.handle({ id: `${rel}@${stamp}`, source: 'watch', type: 'file.changed', subject: rel, scheduleId: s.id, data: { path: rel }, receivedAt: new Date().toISOString() });
              this.log(`[watch] ${s.name ?? s.id} ${rel}: ${out.status}${'reason' in out ? ` (${out.reason})` : ''}`);
            }, debounce),
          );
        });
        this.watchers.push(w);
      } catch (e) {
        recordActivity(this.home, { kind: 'error', scheduleId: s.id, detail: `cannot watch ${ws}: ${(e as Error).message}` });
      }
    }
  }

  async start(opts: { listen?: boolean; port?: number; host?: string } = {}): Promise<{ url?: string }> {
    const sc = scheduleConfig(this.o.config);
    const missed = this.recordMissedTicks();
    if (missed) this.log(`recorded ${missed} cron tick(s) missed while the daemon was down`);
    const hb = () => beat(this.home, { pid: process.pid, startedAt: this.startedAt, url: this.server?.url });
    hb();
    this.timers.push(setInterval(hb, sc.heartbeatMs));
    this.tick();
    this.timers.push(setInterval(() => this.tick(), 15_000));
    this.startWatchers();
    if (opts.listen !== false) {
      this.server = await startHookServer(createHookHandler({ config: this.o.config, intake: this.intake }), opts.port ?? sc.port, opts.host ?? sc.host);
      hb();
    }
    return { url: this.server?.url };
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.watchers) w.close();
    this.watchers = [];
    await this.server?.close();
    this.server = undefined;
    await this.intake.idle();
  }
}
