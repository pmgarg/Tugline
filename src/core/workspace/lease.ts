/**
 * Workspace ownership (v1.1 R9). One writer per workspace at a time, across
 * everything that can change it: scheduled runs and the daemon, `tug serve`
 * sessions, VS Code chats, CLI sessions and their background jobs.
 *
 *   <homeDir>/workspaces/<sha256(realpath)>.lease.json
 *
 * The lease names its holder (kind, id, pid, host, session) and carries a
 * heartbeat. It is taken with O_EXCL, so exactly one process wins. A lease
 * whose heartbeat is older than `staleMs`, or whose holder process is gone
 * (same host), can be taken over: the old file is renamed away first, and the
 * rename succeeds for one taker only.
 *
 * Holders re-enter with the same `token` (a scheduled run's agent inherits its
 * schedule's lease). A second writer either waits (`acquireWorkspaceLease`
 * with `waitMs`), works in a worktree (schedules with `isolation: worktree`),
 * or, for interactive sessions, proceeds with a warning: a person is never
 * blocked by a background job, but is told who else is writing.
 *
 * Embedders (tug serve, the VS Code extension) use the same API:
 * `acquireWorkspaceLease`, `heartbeatLease`, `releaseWorkspaceLease`,
 * `workspaceLeaseStatus`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';

export type HolderKind = 'schedule' | 'daemon' | 'serve' | 'vscode' | 'cli' | 'job' | 'session';

export interface LeaseHolder {
  kind: HolderKind;
  /** Run id, session id, schedule id … */
  id: string;
  /** Re-entry key: a caller presenting the same token already owns the lease. */
  token: string;
  pid: number;
  host: string;
  sessionId?: string;
  /** Human-readable, e.g. the schedule name or "VS Code chat". */
  label?: string;
}

export interface WorkspaceLease extends LeaseHolder {
  workspace: string;
  since: string;
  heartbeatAt: string;
}

export interface WorkspaceLeaseConfig {
  /** Off: no lease is taken by agents (schedules still take theirs). Default on. */
  enabled: boolean;
  /** Interactive sessions that find the workspace held: 'warn' (default, proceed with a notice), 'wait', or 'off'. */
  interactive: 'warn' | 'wait' | 'off';
  /** How long a waiting writer waits before giving up (ms). */
  waitMs: number;
  /** A lease whose heartbeat is older than this is stale and can be taken over (ms). */
  staleMs: number;
  heartbeatMs: number;
  /** Who agents in this process are (set by embedders: 'serve', 'vscode', 'cli'). */
  holderKind?: HolderKind;
  /** Internal: the token of a lease already held for this agent's workspace (scheduled runs). */
  token?: string;
}

export const DEFAULT_WORKSPACE_LEASE: WorkspaceLeaseConfig = {
  enabled: true,
  interactive: 'warn',
  waitMs: 30 * 60_000,
  staleMs: 2 * 60_000,
  heartbeatMs: 20_000,
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** v1.1 R9 (WS8): workspace ownership. */
    workspaceLease?: Partial<WorkspaceLeaseConfig>;
  }
}

export function leaseConfig(cfg: Pick<HarnessConfig, 'workspaceLease'>): WorkspaceLeaseConfig {
  return { ...DEFAULT_WORKSPACE_LEASE, ...(cfg.workspaceLease ?? {}) };
}

function realWorkspace(ws: string): string {
  try {
    return fs.realpathSync(ws);
  } catch {
    return path.resolve(ws);
  }
}

export function leaseFile(homeDir: string, workspace: string): string {
  const h = crypto.createHash('sha256').update(realWorkspace(workspace)).digest('hex').slice(0, 32);
  return path.join(homeDir, 'workspaces', `${h}.lease.json`);
}

function read(file: string): WorkspaceLease | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceLease;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Is this lease dead: an old heartbeat, or (same host) a holder process that no longer exists? */
export function isStale(l: WorkspaceLease, staleMs: number, now = Date.now()): boolean {
  if (now - Date.parse(l.heartbeatAt) > staleMs) return true;
  return l.host === os.hostname() && !pidAlive(l.pid);
}

export function newLeaseToken(): string {
  return `lt_${crypto.randomBytes(8).toString('hex')}`;
}

export type AcquireResult = { ok: true; lease: WorkspaceLease; reentered: boolean } | { ok: false; heldBy: WorkspaceLease };

/** One attempt, no waiting. */
export function tryAcquireWorkspaceLease(homeDir: string, workspace: string, holder: Omit<LeaseHolder, 'pid' | 'host'> & Partial<Pick<LeaseHolder, 'pid' | 'host'>>, opts: { staleMs?: number } = {}): AcquireResult {
  const file = leaseFile(homeDir, workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const lease: WorkspaceLease = { pid: process.pid, host: os.hostname(), ...holder, workspace: realWorkspace(workspace), since: now, heartbeatAt: now };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(lease, null, 2));
      fs.closeSync(fd);
      return { ok: true, lease, reentered: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const cur = read(file);
    if (!cur) continue; // being written or just removed: try again
    if (cur.token === holder.token) return { ok: true, lease: cur, reentered: true };
    if (!isStale(cur, opts.staleMs ?? DEFAULT_WORKSPACE_LEASE.staleMs)) return { ok: false, heldBy: cur };
    // Take over a dead lease: only one renamer succeeds; the loser retries and sees the winner's lease.
    try {
      fs.renameSync(file, `${file}.stale-${crypto.randomBytes(4).toString('hex')}`);
    } catch {
      /* someone else took it over first */
    }
  }
  const cur = read(file);
  return cur ? { ok: false, heldBy: cur } : tryAcquireWorkspaceLease(homeDir, workspace, holder, opts);
}

/** Acquire, waiting up to `waitMs` for the current holder to finish. */
export async function acquireWorkspaceLease(
  homeDir: string,
  workspace: string,
  holder: Omit<LeaseHolder, 'pid' | 'host'>,
  opts: { waitMs?: number; staleMs?: number; pollMs?: number; signal?: AbortSignal; onWait?: (heldBy: WorkspaceLease) => void } = {},
): Promise<AcquireResult> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  let told = false;
  for (;;) {
    const r = tryAcquireWorkspaceLease(homeDir, workspace, holder, opts);
    if (r.ok || Date.now() >= deadline || opts.signal?.aborted) return r;
    if (!told) {
      opts.onWait?.(r.heldBy);
      told = true;
    }
    await new Promise((res) => setTimeout(res, Math.min(opts.pollMs ?? 500, Math.max(10, deadline - Date.now()))));
  }
}

/** Refresh the heartbeat. Returns false when the lease is no longer ours (taken over after going stale). */
export function heartbeatLease(homeDir: string, workspace: string, token: string): boolean {
  const file = leaseFile(homeDir, workspace);
  const cur = read(file);
  if (!cur || cur.token !== token) return false;
  const next = { ...cur, heartbeatAt: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

/** Release, only if we hold it. */
export function releaseWorkspaceLease(homeDir: string, workspace: string, token: string): boolean {
  const file = leaseFile(homeDir, workspace);
  const cur = read(file);
  if (!cur || cur.token !== token) return false;
  // Rename first so a concurrent taker never sees a half-deleted lease.
  const gone = `${file}.released-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, gone);
    fs.rmSync(gone, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface LeaseStatus {
  workspace: string;
  held: boolean;
  stale?: boolean;
  lease?: WorkspaceLease;
}

export function workspaceLeaseStatus(homeDir: string, workspace: string, staleMs = DEFAULT_WORKSPACE_LEASE.staleMs): LeaseStatus {
  const lease = read(leaseFile(homeDir, workspace));
  if (!lease) return { workspace: realWorkspace(workspace), held: false };
  return { workspace: realWorkspace(workspace), held: true, stale: isStale(lease, staleMs), lease };
}

/** Every lease file under the home (for `tug lease status`). */
export function listWorkspaceLeases(homeDir: string, staleMs = DEFAULT_WORKSPACE_LEASE.staleMs): LeaseStatus[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(path.join(homeDir, 'workspaces')).filter((f) => f.endsWith('.lease.json'));
  } catch {
    return [];
  }
  return names
    .map((f) => read(path.join(homeDir, 'workspaces', f)))
    .filter((l): l is WorkspaceLease => !!l)
    .map((l) => ({ workspace: l.workspace, held: true, stale: isStale(l, staleMs), lease: l }));
}

export function describeHolder(l: WorkspaceLease): string {
  const age = Math.round((Date.now() - Date.parse(l.since)) / 1000);
  return `${l.label ?? `${l.kind} ${l.id}`} (pid ${l.pid}${l.host !== os.hostname() ? ` on ${l.host}` : ''}, for ${age}s)`;
}

/** Keep a lease alive while `fn` runs, then release it. The timer never keeps the process alive. */
export function keepAlive(homeDir: string, workspace: string, token: string, heartbeatMs = DEFAULT_WORKSPACE_LEASE.heartbeatMs): () => void {
  const t = setInterval(() => {
    try {
      heartbeatLease(homeDir, workspace, token);
    } catch {
      /* best effort */
    }
  }, heartbeatMs);
  t.unref?.();
  return () => clearInterval(t);
}
