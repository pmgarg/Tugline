/**
 * R1 (review fix): finding the processes an agent command started, including
 * ones that left its process group or session (`cmd &`, `nohup … &`,
 * `setsid … &`, double forks).
 *
 * Every shell command the guard watches gets `TUG_GUARD_ID=<harness token>-<n>`
 * in its environment (a command wrapper, applied before the OS sandbox wraps the
 * spec). Children inherit it whatever they do with process groups, so after the
 * foreground command exits the guard can find and kill every process that still
 * carries its id. Declared background jobs keep theirs until they exit.
 *
 * Found through `/proc/<pid>/environ` on Linux and `ps eww` on macOS/BSD (both
 * show only the user's own processes, which is all that is needed). Windows has
 * no equivalent; there the job objects of the shell tool are the only boundary.
 *
 * Limit: a process that clears its environment (`env -i setsid …`) and
 * outlives the command is not found. The trusted-baseline comparison in
 * protect.ts still restores what it wrote at the next command or run end, and
 * the OS sandbox (read-only mounts, a pid namespace) closes it fully.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export const GUARD_ENV = 'TUG_GUARD_ID';
/** This harness process's token: every id starts with it. */
export const PROCESS_TOKEN = crypto.randomBytes(6).toString('hex');
let seq = 0;

export function newCommandId(): string {
  return `${PROCESS_TOKEN}-${++seq}`;
}

/** pids of live processes whose environment has TUG_GUARD_ID equal to `id` (or starting with `prefix`). */
export function processesWithGuardId(match: { id?: string; prefix?: string; /** ids to leave out (commands still running) */ except?: ReadonlySet<string> }, platform: NodeJS.Platform = process.platform): number[] {
  const ok = (v: string) => !match.except?.has(v) && (match.id !== undefined ? v === match.id : match.prefix !== undefined && v.startsWith(match.prefix));
  const out: number[] = [];
  if (platform === 'linux') {
    let pids: string[] = [];
    try {
      pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    } catch {
      return [];
    }
    for (const p of pids) {
      if (Number(p) === process.pid) continue;
      let env: string;
      try {
        env = fs.readFileSync(`/proc/${p}/environ`, 'latin1');
      } catch {
        continue;
      }
      const i = env.indexOf(`${GUARD_ENV}=`);
      if (i < 0) continue;
      const end = env.indexOf('\0', i);
      if (ok(env.slice(i + GUARD_ENV.length + 1, end < 0 ? undefined : end))) {
        // zombies have exited already
        try {
          if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${p}/stat`, 'latin1'))) continue;
        } catch {
          continue;
        }
        out.push(Number(p));
      }
    }
    return out;
  }
  if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd' || platform === 'netbsd') {
    const r = spawnSync('ps', ['eww', '-A', '-o', 'pid=,stat=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of (r.stdout ?? '').split('\n')) {
      const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) === process.pid || m[2]!.startsWith('Z')) continue;
      const e = new RegExp(`(?:^|\\s)${GUARD_ENV}=(\\S+)`).exec(m[3]!);
      if (e && ok(e[1]!)) out.push(Number(m[1]));
    }
    return out;
  }
  return out;
}

/** SIGKILL every process carrying the id (repeated until none is left, max ~1 s). Returns how many were killed. */
export async function killProcessesWithGuardId(id: string, except: Set<number> = new Set()): Promise<number> {
  let killed = 0;
  for (let round = 0; round < 10; round++) {
    const pids = processesWithGuardId({ id }).filter((p) => !except.has(p));
    if (!pids.length) break;
    for (const p of pids) {
      try {
        process.kill(p, 'SIGKILL');
        killed++;
      } catch {
        /* already gone */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return killed;
}
