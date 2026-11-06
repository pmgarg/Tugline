/**
 * Background jobs (SPEC D5): long-running commands (dev servers, watchers,
 * slow builds) that the agent starts with `bash {run_in_background:true}` and
 * then inspects with job_output / monitor / job_kill.
 *
 * - Output goes straight from the child to ~/.tugline/jobs/<id>.log (the
 *   child holds the file descriptor), so nothing is lost while nobody reads it
 *   and a persisted job keeps logging after the harness exits.
 * - Jobs run in their own process group; kill signals the whole group.
 * - Jobs are killed when the session ends (Agent.dispose) and when the
 *   process exits, unless started with persist:true.
 * - Permission, beforeShell hooks and command wrappers (sandbox) are applied by
 *   the caller exactly as for foreground commands: this module only spawns.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shortId } from '../util/text.js';
import { platformSpawnArgs } from '../util/procs.js';

export interface Job {
  id: string;
  sessionId: string;
  command: string;
  pid?: number;
  cwd: string;
  logFile: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  status: 'running' | 'exited' | 'killed' | 'failed';
  persist: boolean;
  child?: ChildProcess;
  onEnd: ((j: Job) => void)[];
}

/** Tools the agent activates when a background job starts. */
export const JOB_TOOL_NAMES = ['job_output', 'monitor', 'job_kill'];

const jobs = new Map<string, Job>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Synchronous last-chance cleanup: never leave a non-persistent dev server behind.
  process.on('exit', () => {
    for (const j of jobs.values()) if (j.status === 'running' && !j.persist) signalGroup(j, 'SIGKILL');
  });
}

function signalGroup(j: Job, sig: NodeJS.Signals): boolean {
  if (!j.pid) return false;
  try {
    if (process.platform !== 'win32') process.kill(-j.pid, sig);
    else j.child?.kill(sig);
    return true;
  } catch {
    try {
      j.child?.kill(sig);
      return true;
    } catch {
      return false;
    }
  }
}

export interface StartJobOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The command as the model wrote it (for listings) */
  command: string;
  sessionId: string;
  homeDir: string;
  persist?: boolean;
}

export function startJob(o: StartJobOptions): Job {
  installExitHook();
  const id = shortId('job_');
  const dir = path.join(o.homeDir, 'jobs');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${id}.log`);
  const fd = fs.openSync(logFile, 'a', 0o600);
  const job: Job = { id, sessionId: o.sessionId, command: o.command, cwd: o.cwd, logFile, startedAt: Date.now(), status: 'running', persist: !!o.persist, onEnd: [] };
  jobs.set(id, job);
  const finish = (status: Job['status'], code: number | null) => {
    if (job.status !== 'running') return;
    job.status = status;
    job.exitCode = code;
    job.endedAt = Date.now();
    for (const cb of job.onEnd) {
      try {
        cb(job);
      } catch {
        /* observers never break job bookkeeping */
      }
    }
  };
  try {
    // Unbuffered Python so "Serving HTTP on …" reaches the log immediately.
    const sp = platformSpawnArgs(o.file, o.args); // Windows: cmd.exe gets the command verbatim (R7)
    const child = spawn(o.file, sp.args, { cwd: o.cwd, env: { PYTHONUNBUFFERED: '1', ...o.env }, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd], windowsVerbatimArguments: sp.windowsVerbatimArguments, windowsHide: true });
    job.child = child;
    job.pid = child.pid;
    child.on('error', (e) => {
      try {
        fs.appendFileSync(logFile, `\n[failed to start: ${e.message}]\n`);
      } catch {
        /* ignore */
      }
      finish('failed', 127);
    });
    child.on('exit', (code, sig) => finish((job as any)._killed ? 'killed' : 'exited', code ?? (sig ? 128 : null)));
    if (job.persist) child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(sessionPrefix?: string): Job[] {
  return [...jobs.values()].filter((j) => !sessionPrefix || j.sessionId.startsWith(sessionPrefix));
}

/** A job is visible to an agent of the same session (subagents share the session prefix). */
export function jobVisibleTo(j: Job, sessionId: string): boolean {
  const root = (s: string) => s.replace(/-sub(-\d+)?$/, '');
  return root(j.sessionId) === root(sessionId);
}

export function readJobLog(j: Job, opts: { since?: number; tail?: number; maxChars?: number } = {}): { text: string; next: number; size: number } {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(j.logFile);
  } catch {
    return { text: '', next: 0, size: 0 };
  }
  const size = buf.length;
  const since = Math.max(0, Math.min(Number(opts.since) || 0, size));
  let text = buf.subarray(since).toString('utf8');
  if (opts.tail && opts.tail > 0) text = text.split('\n').slice(-(opts.tail + (text.endsWith('\n') ? 1 : 0))).join('\n');
  const max = opts.maxChars ?? 20_000;
  if (text.length > max) text = `…[${text.length - max} earlier chars omitted]…\n${text.slice(-max)}`;
  return { text, next: size, size };
}

export async function killJob(j: Job, graceMs = 1500): Promise<boolean> {
  if (j.status !== 'running') return false;
  (j as any)._killed = true;
  signalGroup(j, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (j.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (j.status === 'running') {
    signalGroup(j, 'SIGKILL');
    const d2 = Date.now() + 1000;
    while (j.status === 'running' && Date.now() < d2) await new Promise((r) => setTimeout(r, 25));
  }
  if (j.status === 'running') {
    j.status = 'killed';
    j.endedAt = Date.now();
  }
  return true;
}

/** Kill every non-persistent job of a session (and its subagents). Returns the ids killed. */
export async function killSessionJobs(sessionId: string): Promise<string[]> {
  const victims = [...jobs.values()].filter((j) => j.status === 'running' && !j.persist && jobVisibleTo(j, sessionId));
  await Promise.all(victims.map((j) => killJob(j)));
  return victims.map((j) => j.id);
}

export interface MonitorResult {
  matched: boolean;
  lines: string[];
  reason: 'matched' | 'timeout' | 'exited' | 'aborted';
  next: number;
}

/** Block until `pattern` appears in the job's output (from offset `since`), the job exits, or the timeout. */
export async function monitorJob(j: Job, pattern: RegExp, opts: { timeoutMs: number; since?: number; signal?: AbortSignal; maxLines?: number }): Promise<MonitorResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let offset = Math.max(0, opts.since ?? 0);
  let partial = '';
  const matches: string[] = [];
  const maxLines = opts.maxLines ?? 20;
  const scan = (): boolean => {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(j.logFile);
    } catch {
      return false;
    }
    if (buf.length <= offset) return false;
    const chunk = partial + buf.subarray(offset).toString('utf8');
    offset = buf.length;
    const lines = chunk.split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) if (pattern.test(l) && matches.length < maxLines) matches.push(l);
    // a prompt-style line without a newline ("Listening on :3000") still counts
    if (!matches.length && partial && pattern.test(partial)) matches.push(partial);
    return matches.length > 0;
  };
  for (;;) {
    if (scan()) return { matched: true, lines: matches, reason: 'matched', next: offset };
    if (opts.signal?.aborted) return { matched: false, lines: [], reason: 'aborted', next: offset };
    if (j.status !== 'running') {
      scan();
      return { matched: matches.length > 0, lines: matches, reason: matches.length ? 'matched' : 'exited', next: offset };
    }
    if (Date.now() >= deadline) return { matched: false, lines: [], reason: 'timeout', next: offset };
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function describeJob(j: Job): string {
  const age = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
  return `${j.id}  ${j.status}${j.status !== 'running' ? ` (exit ${j.exitCode ?? '?'})` : ''}  pid ${j.pid ?? '?'}  ${age}s${j.persist ? '  persist' : ''}  $ ${j.command}`;
}
