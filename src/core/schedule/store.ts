/**
 * On-disk state for schedules and triggers, under `<homeDir>/schedule/`:
 *
 *   schedules.json        the human-written subscriptions (mode 0600)
 *   seen/<xx>/<sha>.json  dedupe ledger: one file per `source/id`, created with O_EXCL,
 *                         so "first one wins" holds across processes. Names are never
 *                         deleted (S16: a two-week-old retry must not redo the job).
 *   windows/<id>/<day>.json  window governor counters (runs, cost) per UTC day
 *   activity.jsonl        append-only log: arrived / acted / ignored / refused / parked …
 *   runs/<runId>.json     one record per scheduled run
 *   parked/               parked waits (see parked.ts)
 *   leases/<id>.json      cron leases
 *   heartbeat.json        liveness
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActivityRecord, Schedule } from './types.js';

export function scheduleDir(homeDir: string): string {
  return path.join(homeDir, 'schedule');
}

export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------ schedules

export function loadSchedules(homeDir: string): Schedule[] {
  return readJson<{ schedules: Schedule[] }>(path.join(scheduleDir(homeDir), 'schedules.json'), { schedules: [] }).schedules ?? [];
}

export function saveSchedules(homeDir: string, list: Schedule[]): void {
  writeJsonAtomic(path.join(scheduleDir(homeDir), 'schedules.json'), { schedules: list });
}

export function getSchedule(homeDir: string, id: string): Schedule | undefined {
  return loadSchedules(homeDir).find((s) => s.id === id);
}

export function newScheduleId(): string {
  return `s_${crypto.randomBytes(5).toString('hex')}`;
}

export function addSchedule(homeDir: string, s: Schedule): Schedule {
  const list = loadSchedules(homeDir);
  if (list.some((x) => x.id === s.id)) throw new Error(`schedule ${s.id} already exists`);
  list.push(s);
  saveSchedules(homeDir, list);
  return s;
}

export function removeSchedule(homeDir: string, id: string): boolean {
  const list = loadSchedules(homeDir);
  const next = list.filter((s) => s.id !== id && s.name !== id);
  if (next.length === list.length) return false;
  saveSchedules(homeDir, next);
  return true;
}

// ------------------------------------------------------------ dedupe ledger

function seenFile(homeDir: string, key: string): string {
  const h = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(scheduleDir(homeDir), 'seen', h.slice(0, 2), `${h}.json`);
}

/**
 * Record `key` as seen. Returns true for the first sighting, false for a
 * duplicate. Called BEFORE any decision about the event (S16: write it down
 * before you act).
 */
export function markSeen(homeDir: string, key: string, info: Record<string, unknown> = {}): boolean {
  const f = seenFile(homeDir, key);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(f, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ key, firstSeen: new Date().toISOString(), ...info }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export function wasSeen(homeDir: string, key: string): boolean {
  return fs.existsSync(seenFile(homeDir, key));
}

// ------------------------------------------------------------ window governor

export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export interface Reservation {
  usd?: number;
  tokens?: number;
  gpuSeconds?: number;
  at: string;
  /** What it was reserved for (event key, or "resume:<handle>"). */
  for?: string;
  pid?: number;
}

export interface WindowCounters {
  runs: number;
  /** Reconciled spend (finished runs). */
  costUsd: number;
  tokens?: number;
  gpuSeconds?: number;
  /** v1.1 R4: budget reserved by admitted runs that have not finished (reserve-then-reconcile). */
  reservations?: Record<string, Reservation>;
}

function windowFile(homeDir: string, scheduleId: string, day: string): string {
  return path.join(scheduleDir(homeDir), 'windows', scheduleId.replace(/[^A-Za-z0-9_-]/g, '_'), `${day}.json`);
}

export function readWindow(homeDir: string, scheduleId: string, day = utcDay()): WindowCounters {
  return { runs: 0, costUsd: 0, ...readJson<Partial<WindowCounters>>(windowFile(homeDir, scheduleId, day), {}) };
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run `fn` holding the window's file lock (O_EXCL lock file; a lock older than
 * `staleMs` is from a dead process and is broken). Read-modify-write of the
 * counters is then atomic across processes, which the reservation ledger needs.
 * Synchronous on purpose: admission happens in the synchronous part of intake.
 */
export function withWindowLock<T>(homeDir: string, scheduleId: string, fn: () => T, day = utcDay(), staleMs = 30_000): T {
  const lock = `${windowFile(homeDir, scheduleId, day)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let i = 0; ; i++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.renameSync(lock, `${lock}.stale-${crypto.randomBytes(3).toString('hex')}`);
      } catch {
        /* released or broken by someone else meanwhile */
      }
      if (i > 2000) throw new Error(`window lock ${lock} is busy`);
      sleepSync(Math.min(25, 1 + i));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Write the counters; call it inside withWindowLock. */
export function writeWindow(homeDir: string, scheduleId: string, w: WindowCounters, day = utcDay()): void {
  writeJsonAtomic(windowFile(homeDir, scheduleId, day), w);
}

export function updateWindow(homeDir: string, scheduleId: string, fn: (w: WindowCounters) => WindowCounters, day = utcDay()): WindowCounters {
  return withWindowLock(
    homeDir,
    scheduleId,
    () => {
      const next = fn(readWindow(homeDir, scheduleId, day));
      writeJsonAtomic(windowFile(homeDir, scheduleId, day), next);
      return next;
    },
    day,
  );
}

// ------------------------------------------------------------ activity log

export function activityFile(homeDir: string): string {
  return path.join(scheduleDir(homeDir), 'activity.jsonl');
}

export function recordActivity(homeDir: string, rec: Omit<ActivityRecord, 'ts'> & { ts?: string }): void {
  try {
    fs.mkdirSync(scheduleDir(homeDir), { recursive: true, mode: 0o700 });
    fs.appendFileSync(activityFile(homeDir), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', { mode: 0o600 });
  } catch {
    /* the log must never break intake */
  }
}

export function readActivity(homeDir: string, since?: Date): ActivityRecord[] {
  let text = '';
  try {
    text = fs.readFileSync(activityFile(homeDir), 'utf8');
  } catch {
    return [];
  }
  const out: ActivityRecord[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as ActivityRecord;
      if (!since || new Date(r.ts) >= since) out.push(r);
    } catch {
      /* torn line */
    }
  }
  return out;
}

// ------------------------------------------------------------ run records

export interface ScheduledRunRecord {
  runId: string;
  scheduleId: string;
  eventKey?: string;
  sessionId: string;
  journal?: string;
  mode: string;
  startedAt: string;
  endedAt?: string;
  /** 'budget': refused at execution time because the window was exhausted (v1.1 R4), nothing ran. */
  status: 'running' | 'done' | 'parked' | 'error' | 'budget';
  stopReason?: string;
  costUsd: number;
  /** v1.1 R4: tokens used and GPU-seconds (wall time × gpuShare) of the run. */
  tokens?: number;
  gpuSeconds?: number;
  refusals: { tool: string; reason: string }[];
  finalText?: string;
  handle?: string;
  /** Number of resumptions after parked waits. */
  resumes?: number;
  /** v1.1 R9: the run worked in its own worktree; its changes are on this branch. */
  worktreeBranch?: string;
}

export function runFile(homeDir: string, runId: string): string {
  return path.join(scheduleDir(homeDir), 'runs', `${runId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export function saveRun(homeDir: string, r: ScheduledRunRecord): void {
  writeJsonAtomic(runFile(homeDir, r.runId), r);
}

export function loadRun(homeDir: string, runId: string): ScheduledRunRecord | undefined {
  return readJson<ScheduledRunRecord | undefined>(runFile(homeDir, runId), undefined);
}
