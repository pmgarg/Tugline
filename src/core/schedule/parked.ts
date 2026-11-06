/**
 * Parked waits (EAG S16 "parking nodes"). A scheduled run that has to wait for
 * something (a CI result, a reviewer, a time) calls `wait_until`. The run ends
 * with a handle, the worker is released and the run lives on disk: its journal
 * plus a parked record. When the event (or the time) arrives, the same logical
 * run resumes from its journal.
 *
 *   parked/<handle>.json       the record
 *   parked/<handle>.claimed    O_EXCL marker: exactly one resumer wins
 *   parked/index.json          event type → handles, plus time waits
 *
 * An index miss falls back to scanning the directory: a stale index must never
 * look like "nothing is waiting".
 *
 * Lifecycle (v1.1 R3):
 *  - a claim is a LEASE until the resumed run is durable (its run record is
 *    written, `confirmClaim`). A claim whose run never got that far (the
 *    process crashed) expires after `claimLeaseMs`; the daemon then re-claims
 *    it and resumes with the event stored in the claim;
 *  - pause (`tug schedule disable`): matching events do not claim the wait, they
 *    are stored on it as `pending` and the wait stays dormant. Resume (`enable`)
 *    reactivates it: the next daemon tick delivers the pending event, and time
 *    waits that came due while paused resume then;
 *  - an exhausted budget defers the same way (pending, reason "budget");
 *  - remove or cancel (`tug schedule remove`, `tug schedule cancel <handle>`)
 *    invalidates waits: they are closed with a permanent claim and never resume.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../tools/types.js';
import { readJson, scheduleDir, writeJsonAtomic } from './store.js';
import type { TriggerEvent } from './types.js';

export interface WaitFor {
  /** Resume when an event of this type arrives (optionally from this source / about this subject). */
  event?: { type: string; source?: string; subject?: string };
  /** Resume at this time (ISO). */
  time?: string;
}

export interface ParkedWait {
  handle: string;
  runId: string;
  scheduleId: string;
  workspace: string;
  /** Journals of the run so far, oldest first (each resume writes a new journal file). */
  journals: string[];
  waitFor: WaitFor;
  reason: string;
  createdAt: string;
  /** Give up waiting after this (ISO); the morning report lists expired waits. */
  expiresAt?: string;
  /** v1.1 R3: an event that arrived while the schedule was paused (or out of budget), delivered on reactivation. */
  pending?: { event: TriggerEvent; key: string; at: string; reason: 'paused' | 'budget' };
  /** Set when the wait was invalidated (schedule removed, wait cancelled). */
  cancelled?: { at: string; reason: string };
}

/** The claim marker: a lease until the resumed run is durable. */
export interface ClaimRecord {
  by: string;
  at: string;
  /** Re-claimable after this unless `durable`. Absent (old markers) = permanent. */
  leaseUntil?: string;
  durable?: boolean;
  /** The event the claim resumes with (re-delivered if the claim is recovered). */
  event?: TriggerEvent;
}

const dir = (home: string) => path.join(scheduleDir(home), 'parked');
const fileOf = (home: string, handle: string) => path.join(dir(home), `${handle.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

interface ParkIndex {
  byType: Record<string, string[]>;
  times: string[];
}

function readIndex(home: string): ParkIndex {
  return readJson<ParkIndex>(path.join(dir(home), 'index.json'), { byType: {}, times: [] });
}

export function newHandle(): string {
  return `wait_${crypto.randomBytes(6).toString('hex')}`;
}

export function park(home: string, w: ParkedWait): void {
  writeJsonAtomic(fileOf(home, w.handle), w);
  const idx = readIndex(home);
  if (w.waitFor.event) (idx.byType[w.waitFor.event.type] ??= []).push(w.handle);
  if (w.waitFor.time) idx.times.push(w.handle);
  writeJsonAtomic(path.join(dir(home), 'index.json'), idx);
}

const claimFile = (home: string, handle: string) => fileOf(home, handle).replace(/\.json$/, '.claimed');

export function readClaim(home: string, handle: string): ClaimRecord | undefined {
  return readJson<ClaimRecord | undefined>(claimFile(home, handle), undefined);
}

function claimLive(c: ClaimRecord | undefined, now = Date.now()): boolean {
  if (!c) return false;
  if (c.durable || !c.leaseUntil) return true;
  return Date.parse(c.leaseUntil) > now;
}

function isClaimed(home: string, handle: string, now = Date.now()): boolean {
  if (!fs.existsSync(claimFile(home, handle))) return false;
  // A marker that cannot be read is being written: treat it as live.
  const c = readClaim(home, handle);
  return c ? claimLive(c, now) : true;
}

export function loadParked(home: string, handle: string): ParkedWait | undefined {
  return readJson<ParkedWait | undefined>(fileOf(home, handle), undefined);
}

/** All waits that have not been resumed yet. */
export function listWaiting(home: string): ParkedWait[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir(home)).filter((f) => f.endsWith('.json') && f !== 'index.json');
  } catch {
    return [];
  }
  return names
    .map((f) => readJson<ParkedWait | undefined>(path.join(dir(home), f), undefined))
    .filter((w): w is ParkedWait => !!w && !w.cancelled && !isClaimed(home, w.handle));
}

function eventMatches(w: ParkedWait, ev: TriggerEvent): boolean {
  const want = w.waitFor.event;
  if (!want) return false;
  if (want.type !== ev.type && !(want.type.endsWith('.*') && ev.type.startsWith(want.type.slice(0, -1)))) return false;
  if (want.source && want.source !== ev.source && !ev.source.startsWith(`${want.source}:`)) return false;
  if (want.subject && want.subject !== ev.subject) return false;
  return true;
}

/** Waits this event satisfies: index first, then a full scan if the index has nothing. */
export function findWaitingFor(home: string, ev: TriggerEvent): { waits: ParkedWait[]; via: 'index' | 'scan' } {
  const idx = readIndex(home);
  const candidates = [...(idx.byType[ev.type] ?? []), ...Object.entries(idx.byType).filter(([t]) => t.endsWith('.*') && ev.type.startsWith(t.slice(0, -1))).flatMap(([, h]) => h)];
  const hits = candidates
    .map((h) => loadParked(home, h))
    .filter((w): w is ParkedWait => !!w && !w.cancelled && !isClaimed(home, w.handle) && eventMatches(w, ev));
  if (hits.length) return { waits: hits, via: 'index' };
  // An index miss is never evidence of absence (S16).
  return { waits: listWaiting(home).filter((w) => eventMatches(w, ev)), via: 'scan' };
}

export function dueTimeWaits(home: string, now = new Date()): ParkedWait[] {
  return listWaiting(home).filter((w) => w.waitFor.time && new Date(w.waitFor.time) <= now);
}

export function expiredWaits(home: string, now = new Date()): ParkedWait[] {
  return listWaiting(home).filter((w) => w.expiresAt && new Date(w.expiresAt) <= now);
}

/**
 * Claim a wait for resumption. Exactly one caller gets true (O_EXCL), even
 * across processes. With `leaseMs`, the claim is a lease (see the header): an
 * expired, non-durable claim is taken over (renamed away first, so only one
 * taker wins). Without it, the claim is permanent (expiry, cancellation).
 */
export function claim(home: string, handle: string, by: string, opts: { leaseMs?: number; event?: TriggerEvent; durable?: boolean } = {}): boolean {
  const f = claimFile(home, handle);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const rec: ClaimRecord = { by, at: new Date(now).toISOString(), ...(opts.leaseMs ? { leaseUntil: new Date(now + opts.leaseMs).toISOString() } : {}), durable: opts.durable ?? !opts.leaseMs, ...(opts.event ? { event: opts.event } : {}) };
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(f, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(rec));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    const cur = readClaim(home, handle);
    if (!cur || claimLive(cur, now)) return false;
    try {
      fs.renameSync(f, `${f}.expired-${crypto.randomBytes(3).toString('hex')}`);
    } catch {
      return false; // another recoverer won
    }
  }
  return false;
}

/** The resumed run is durable (its record and journal exist): the claim becomes permanent. */
export function confirmClaim(home: string, handle: string): void {
  const cur = readClaim(home, handle);
  if (!cur) return;
  writeJsonAtomic(claimFile(home, handle), { ...cur, durable: true, confirmedAt: new Date().toISOString() });
}

/** Extend a non-durable claim's lease (the resume is queued or starting in this process). */
export function renewClaim(home: string, handle: string, leaseMs: number): void {
  const cur = readClaim(home, handle);
  if (!cur || cur.durable) return;
  writeJsonAtomic(claimFile(home, handle), { ...cur, leaseUntil: new Date(Date.now() + leaseMs).toISOString() });
}

/** Give a claim back (the resume was refused at execution time): the wait is waiting again. */
export function releaseClaim(home: string, handle: string): void {
  const f = claimFile(home, handle);
  try {
    fs.renameSync(f, `${f}.released-${crypto.randomBytes(3).toString('hex')}`);
  } catch {
    /* already gone */
  }
}

/** Claims whose lease expired before their run became durable (a crash): the daemon recovers these. */
export function staleClaims(home: string, now = Date.now()): { wait: ParkedWait; claim: ClaimRecord }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir(home)).filter((f) => f.endsWith('.claimed'));
  } catch {
    return [];
  }
  const out: { wait: ParkedWait; claim: ClaimRecord }[] = [];
  for (const n of names) {
    const c = readJson<ClaimRecord | undefined>(path.join(dir(home), n), undefined);
    if (!c || claimLive(c, now)) continue;
    const w = readJson<ParkedWait | undefined>(path.join(dir(home), n.replace(/\.claimed$/, '.json')), undefined);
    if (w && !w.cancelled) out.push({ wait: w, claim: c });
  }
  return out;
}

/** Store an event on a dormant wait (paused schedule or exhausted budget); the latest one wins. */
export function deferWait(home: string, w: ParkedWait, event: TriggerEvent, key: string, reason: 'paused' | 'budget'): void {
  const cur = loadParked(home, w.handle) ?? w;
  writeJsonAtomic(fileOf(home, w.handle), { ...cur, pending: { event, key, at: new Date().toISOString(), reason } });
}

export function clearPending(home: string, handle: string): void {
  const cur = loadParked(home, handle);
  if (cur?.pending) {
    const { pending: _p, ...rest } = cur;
    writeJsonAtomic(fileOf(home, handle), rest);
  }
}

/** Invalidate a wait for good (schedule removed, `tug schedule cancel`). Returns false if it was already resumed or closed. */
export function cancelWait(home: string, handle: string, reason: string): boolean {
  const w = loadParked(home, handle);
  if (!w || w.cancelled) return false;
  if (!claim(home, handle, `cancelled: ${reason}`)) return false;
  writeJsonAtomic(fileOf(home, handle), { ...w, cancelled: { at: new Date().toISOString(), reason } });
  return true;
}

/** Waits that hold a pending (deferred) event. */
export function deferredWaits(home: string): ParkedWait[] {
  return listWaiting(home).filter((w) => !!w.pending);
}

/** Parse "30m", "2h", "1d" or an ISO time into an ISO time. */
export function resolveTime(spec: string, now = new Date()): string {
  const rel = spec.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const mult = { s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[rel[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return new Date(now.getTime() + Number(rel[1]) * mult).toISOString();
  }
  const d = new Date(spec);
  if (Number.isNaN(d.getTime())) throw new Error(`"${spec}" is not a time (use ISO 8601 or 30m / 2h / 1d)`);
  return d.toISOString();
}

/**
 * The `wait_until` tool, given only to scheduled runs. It does not wait in
 * process: it asks the run to park. The schedule runner's extension sees the
 * request and ends the run with a handle.
 */
export function waitUntilTool(onPark: (w: { waitFor: WaitFor; reason: string; expiresAt?: string }) => string): ToolDef<{ event_type?: string; source?: string; subject?: string; time?: string; reason: string; expires?: string }> {
  return {
    name: 'wait_until',
    kind: 'meta',
    description:
      'Park this scheduled run until an event arrives or a time passes, then continue from here. Use it when the next step depends on something that has not happened yet (CI finishing, a review, a later time). ' +
      'Give event_type (e.g. "check_suite.completed", "pull_request.closed", "file.changed") and optionally source/subject, OR time (ISO 8601, or 30m / 2h / 1d). After calling it, end your turn: the run is resumed with the event as new input.',
    parameters: {
      type: 'object',
      properties: {
        event_type: { type: 'string', description: 'Event type to wait for' },
        source: { type: 'string', description: 'Only events from this source (e.g. "github")' },
        subject: { type: 'string', description: 'Only events about this subject (e.g. a PR number)' },
        time: { type: 'string', description: 'Resume at this time instead: ISO 8601 or a delay like 30m, 2h, 1d' },
        reason: { type: 'string', description: 'What you are waiting for and why (shown in the morning report)' },
        expires: { type: 'string', description: 'Give up after this long (e.g. 2d). Default 7d.' },
      },
      required: ['reason'],
    },
    title: (a) => `Wait until ${a.event_type ?? a.time ?? '?'}`,
    validate(a) {
      if (!a.event_type && !a.time) throw new Error('give event_type or time');
    },
    async run(a) {
      const waitFor: WaitFor = {};
      if (a.event_type) waitFor.event = { type: a.event_type, source: a.source, subject: a.subject };
      if (a.time) waitFor.time = resolveTime(a.time);
      const handle = onPark({ waitFor, reason: a.reason, expiresAt: resolveTime(a.expires ?? '7d') });
      return { output: `Parked as ${handle}. End your turn now; this run resumes when ${a.event_type ? `a "${a.event_type}" event arrives` : `it is ${waitFor.time}`}.`, meta: { handle } };
    },
  };
}
