/**
 * Portable process listing and tree killing (v1.1 R7).
 *
 * Linux-only flags broke the suite on macOS: BSD `ps` rejects `--ppid`. The
 * one invocation both procps (Linux) and BSD `ps` (macOS) accept is
 * `ps -A -ww -o pid=,ppid=,stat=,args=` (`-A` every process, `-ww` no width
 * truncation, `=` suppresses the header). Windows has no `ps`: PowerShell's
 * `Get-CimInstance Win32_Process` (and `wmic` on older systems) give the same
 * three fields. Children and descendants are then computed from the snapshot,
 * so no caller needs a platform-specific filter.
 *
 * Killing: a detached child leads its own process group, so one signal to
 * `-pid` reaches what it started; but some helpers leave the group (Chrome's
 * crashpad handler calls `setsid()` and double-forks, so it is reparented to
 * launchd / init). `killProcessTree` therefore also signals every descendant
 * found in a snapshot taken *before* the kill, plus any process an optional
 * matcher recognises (e.g. one whose arguments name the app's private profile
 * directory), and waits until they are really gone (zombies count as gone).
 */
import { execFileSync } from 'node:child_process';

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Command line (BSD/procps `args`, Windows `CommandLine`, or the image name when that is unavailable). */
  args: string;
  /** Process state from `ps` (`S`, `R+`, `Z` …); empty on Windows. */
  stat: string;
}

export type ExecFile = (file: string, args: string[]) => string;

const defaultExec: ExecFile = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

/** The `ps` arguments that work on both procps (Linux) and BSD (macOS). */
export const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,stat=,args='];

/** Parse `ps -A -ww -o pid=,ppid=,stat=,args=` output (procps or BSD: right-aligned numbers, then state, then the command line). */
export function parsePsOutput(out: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s(.*))?$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], args: (m[4] ?? '').trim() });
  }
  return rows;
}

/** Parse `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json`. */
export function parseWindowsJson(out: string): ProcInfo[] {
  const t = out.trim();
  if (!t) return [];
  const j = JSON.parse(t) as unknown;
  const list = (Array.isArray(j) ? j : [j]) as { ProcessId?: number; ParentProcessId?: number; Name?: string; CommandLine?: string | null }[];
  return list.filter((p) => Number.isFinite(p?.ProcessId)).map((p) => ({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId ?? 0), args: p.CommandLine || p.Name || '', stat: '' }));
}

/**
 * Parse `wmic process get ProcessId,ParentProcessId,CommandLine /format:csv`.
 * Columns come out alphabetically (Node,CommandLine,ParentProcessId,ProcessId)
 * and the command line may itself contain commas, so read the numbers from the end.
 */
export function parseWmicCsv(out: string): ProcInfo[] {
  const rows: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim() || /^Node,/i.test(line)) continue;
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const pid = Number(parts[parts.length - 1]);
    const ppid = Number(parts[parts.length - 2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || parts[parts.length - 1].trim() === '') continue;
    rows.push({ pid, ppid, args: parts.slice(1, -2).join(',').trim(), stat: '' });
  }
  return rows;
}

const PS_WIN = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';

/** Every process on the machine (empty when the platform tool is unavailable). Excludes the `ps` that produced the list. */
export function listProcesses(o: { platform?: NodeJS.Platform; exec?: ExecFile } = {}): ProcInfo[] {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? defaultExec;
  if (platform === 'win32') {
    for (const shell of ['powershell.exe', 'pwsh']) {
      try {
        return parseWindowsJson(exec(shell, ['-NoProfile', '-NonInteractive', '-Command', PS_WIN]));
      } catch {
        /* try the next one */
      }
    }
    try {
      return parseWmicCsv(exec('wmic', ['process', 'get', 'ProcessId,ParentProcessId,CommandLine', '/format:csv']));
    } catch {
      return [];
    }
  }
  try {
    // The `ps` itself is a child of this process: drop it so leak checks don't see it.
    return parsePsOutput(exec('ps', PS_ARGS)).filter((p) => !(p.ppid === process.pid && /^(\S*\/)?ps\s+-A\b/.test(p.args)));
  } catch {
    return [];
  }
}

/** A zombie has exited and only waits to be reaped (common in containers whose pid 1 never reaps). */
export function isZombie(p: ProcInfo): boolean {
  return /^Z/.test(p.stat) || /<defunct>/.test(p.args);
}

/** Live (non-zombie) direct children of `pid`. */
export function childProcesses(pid: number, list: ProcInfo[] = listProcesses()): ProcInfo[] {
  return list.filter((p) => p.ppid === pid && p.pid !== pid && !isZombie(p));
}

/** Live descendants of `pid` (children, grandchildren …), breadth first. */
export function descendantProcesses(pid: number, list: ProcInfo[] = listProcesses()): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of list) {
    if (p.pid === p.ppid) continue; // Windows "System Idle Process" is its own parent
    const a = byParent.get(p.ppid) ?? [];
    a.push(p);
    byParent.set(p.ppid, a);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([pid]);
  const queue = [pid];
  while (queue.length) {
    for (const c of byParent.get(queue.shift()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      queue.push(c.pid);
      if (!isZombie(c)) out.push(c);
    }
  }
  return out;
}

/** Parent of `pid` from a snapshot (undefined when unknown). */
export function parentPid(pid: number, list: ProcInfo[] = listProcesses()): number | undefined {
  const p = list.find((x) => x.pid === pid)?.ppid;
  return p && p > 0 ? p : undefined;
}

/** True while `pid` exists and is not a zombie. */
export function isAlive(pid: number, list?: ProcInfo[]): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (process.platform === 'win32') return true;
  // kill(0) succeeds for zombies: ask ps for the state.
  const row = (list ?? listProcesses()).find((p) => p.pid === pid);
  return !!row && !isZombie(row);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until none of `pids` is alive; returns those still alive after `timeoutMs`. */
export async function waitForExit(pids: number[], timeoutMs: number, pollMs = 100): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids;
  for (;;) {
    const snap = process.platform === 'win32' ? undefined : listProcesses();
    alive = alive.filter((p) => isAlive(p, snap));
    if (!alive.length || Date.now() >= deadline) return alive;
    await sleep(pollMs);
  }
}

export interface KillTreeOptions {
  /** The root leads its own process group (spawned with `detached: true`): signal the group too. Default true off Windows. */
  group?: boolean;
  /** Also kill processes this recognises (helpers that left the group and were reparented). */
  match?: (p: ProcInfo) => boolean;
  /** Time between SIGTERM and SIGKILL (0 = SIGKILL at once). Default 2000 ms. */
  graceMs?: number;
  /** How long to wait for everything to be gone after SIGKILL. Default 3000 ms. */
  waitMs?: number;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone or not ours */
  }
}

/**
 * Kill `pid`, its process group, every descendant and every `match`ed process,
 * then wait until they have exited. Returns the processes that survived
 * (empty on success). On Windows, `taskkill /T /F` kills the tree.
 */
export async function killProcessTree(pid: number | undefined, o: KillTreeOptions = {}): Promise<ProcInfo[]> {
  const grace = o.graceMs ?? 2000;
  const waitMs = o.waitMs ?? 3000;
  const targets = (): ProcInfo[] => {
    const snap = listProcesses();
    const set = new Map<number, ProcInfo>();
    if (pid) {
      const self = snap.find((p) => p.pid === pid);
      if (self && !isZombie(self)) set.set(pid, self);
      for (const d of descendantProcesses(pid, snap)) set.set(d.pid, d);
    }
    if (o.match) for (const p of snap) if (p.pid !== process.pid && !isZombie(p) && o.match(p)) set.set(p.pid, p);
    return [...set.values()];
  };
  if (process.platform === 'win32') {
    const all = targets();
    for (const p of all) {
      try {
        execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
      } catch {
        /* already gone */
      }
    }
    const left = await waitForExit(all.map((p) => p.pid), waitMs);
    return all.filter((p) => left.includes(p.pid));
  }
  const group = o.group ?? true;
  const send = (list: ProcInfo[], sig: NodeJS.Signals) => {
    if (group && pid) signal(-pid, sig);
    for (const p of list) signal(p.pid, sig);
  };
  let list = targets();
  if (!list.length && !(group && pid)) return [];
  if (grace > 0) {
    send(list, 'SIGTERM');
    const left = await waitForExit(list.map((p) => p.pid), grace);
    if (!left.length) {
      // Helpers that outlive the main process (they notice its death a moment later) may still be starting to exit.
      list = targets();
      if (!list.length) {
        if (group && pid) signal(-pid, 'SIGKILL'); // group members we could not see (no ps) and that ignored SIGTERM
        return [];
      }
    }
  }
  // Re-snapshot: children started between the snapshot and the signal are killed too.
  const merged = new Map<number, ProcInfo>([...list, ...targets()].map((p) => [p.pid, p]));
  list = [...merged.values()];
  send(list, 'SIGKILL');
  const left = await waitForExit(list.map((p) => p.pid), waitMs);
  return list.filter((p) => left.includes(p.pid));
}

// ------------------------------------------------------------ Windows command spawning

/**
 * Arguments and spawn options for a spec on this platform. A `ComSpec /d /s /c
 * <command>` spec is passed to cmd.exe as `/d /s /c "<command>"` with
 * `windowsVerbatimArguments`, which is what Node's own `shell: true` does:
 * Node's default MSVC quoting would wrap the command in quotes and escape its
 * `"` as `\"`, which cmd.exe does not understand (`echo "a b"` became
 * `echo \"a b\"`). `/s` makes cmd strip exactly the outer pair of quotes.
 * The spec itself keeps the raw command (the VS Code terminal runner, WS2,
 * builds its command line from the same 4-element form).
 */
export function platformSpawnArgs(file: string, args: string[], platform: NodeJS.Platform = process.platform): { args: string[]; windowsVerbatimArguments?: boolean } {
  const isCmd = /(^|[\\/])cmd(\.exe)?$/i.test(file);
  if (platform === 'win32' && isCmd && args.length === 4 && /^\/d$/i.test(args[0]) && /^\/s$/i.test(args[1]) && /^\/c$/i.test(args[2])) return { args: [args[0], args[1], args[2], `"${args[3]}"`], windowsVerbatimArguments: true };
  return { args };
}
