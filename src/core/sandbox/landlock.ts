/**
 * N36: the Landlock runner, the Linux fallback when bubblewrap is missing or user namespaces are off
 * (kernel >= 5.13; network rules on ABI >= 4). Chain for `auto`: bwrap → landlock → policy-only.
 *
 * What a command gets (the same policy as bwrap, within what Landlock can express):
 *  - read + execute: the whole filesystem EXCEPT the credential stores (sandbox.denyRead, ~/.ssh …) and the
 *    harness home. Landlock only allows, so "/ minus X" is granted as the siblings of X, recursively.
 *  - write: the workspace (unless sandbox.filesystem is read-only), the writable cache dirs, a private scratch
 *    dir (TMPDIR points there) and /dev/null-like devices. Nothing else, so a write outside fails with EACCES.
 *  - network: with a proxy, TCP connect only to the proxy's port (ABI >= 4) and no UDP/raw sockets (seccomp);
 *    with network "none", no IP sockets at all (seccomp, any ABI). Below ABI 4 a proxied run is reported as
 *    "network not restricted by Landlock" and refused under sandbox.require.
 *  - lifetime: the helper is a child subreaper; whatever the command leaves behind is killed when it ends, when
 *    the run is stopped and when the harness dies (parent-death signal). On ABI >= 6 the command cannot signal
 *    the helper or any process outside its domain.
 *
 * Limitation (documented in USER_GUIDE): Landlock cannot make a path read-only beneath a writable directory, so
 * protected paths inside the workspace are guarded by the policy's static check and the R1 restore guard, not by
 * the kernel, under this runner. bwrap and Seatbelt keep them read-only in the kernel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSpec } from '../tools/shell.js';
import { LANDLOCK_HELPER_PY } from './landlockHelper.js';
import { within } from './settings.js';

export interface LandlockProbe {
  ok: boolean;
  abi: number;
  python?: string;
  reason?: string;
}

let probeCache: LandlockProbe | undefined;

function findPython(): string | undefined {
  for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3']) if (fs.existsSync(p)) return p;
  const r = spawnSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf8' });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v || undefined;
}

/** Can Landlock confine a process here, and at which ABI? (cached; runs the helper's --probe once) */
export function landlockProbe(refresh = false): LandlockProbe {
  if (probeCache && !refresh) return probeCache;
  if (process.platform !== 'linux') return (probeCache = { ok: false, abi: 0, reason: `Landlock is Linux-only (this is ${process.platform})` });
  const python = findPython();
  if (!python) return (probeCache = { ok: false, abi: 0, reason: 'the Landlock helper needs python3, which is not installed' });
  const r = spawnSync(python, ['-I', '-S', '-c', LANDLOCK_HELPER_PY, '--probe'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0) {
    try {
      const abi = Number(JSON.parse(r.stdout.trim()).abi);
      if (abi >= LANDLOCK_MIN_ABI) return (probeCache = { ok: true, abi, python });
      if (abi >= 1) return (probeCache = { ok: false, abi, python, reason: `Landlock ABI ${abi} is below ${LANDLOCK_MIN_ABI} (truncate(2) is not controlled before ABI 3; Linux 6.2+)` });
    } catch {
      /* fall through */
    }
  }
  const why = (r.stderr || r.error?.message || `exit ${r.status}`).replace(/^Tugline sandbox \(landlock\): /, '').trim();
  return (probeCache = { ok: false, abi: 0, python, reason: why || 'the Landlock probe failed' });
}

/** Tests: forget the cached probe. */
export function resetLandlockProbe(): void {
  probeCache = undefined;
}

export interface LandlockPolicy {
  workspace: string;
  /** writable directories besides the workspace (existing ones are granted) */
  writable: string[];
  /** paths hidden from reads (already split around the workspace, see splitAround) */
  denyRead: string[];
  filesystem: 'workspace-write' | 'read-only';
  network: 'none' | 'proxy' | 'host';
  proxyPort?: number;
  /** a private scratch dir for TMPDIR */
  scratch: string;
  /** cap the ABI (sandbox.landlock.maxAbi: test older kernels) */
  maxAbi?: number;
  /** refuse instead of running with unrestricted network below ABI 4 */
  requireNetwork: boolean;
  /**
   * WS17 review F2: Landlock does not govern connect() to a pathname unix socket, so a host daemon socket (Docker:
   * host root) cannot be hidden by a path rule. "deny" (default): seccomp refuses socket(AF_UNIX); socketpair(2),
   * pipes and abstract-socket scoping are unaffected.
   */
  unixSockets?: 'deny' | 'allow';
  /** N36 (Qwen parity, sandboxed PTY execution): run the command on a pseudo-terminal the helper allocates before it confines */
  pty?: boolean;
}

/**
 * Devices a command may write. Review finding 14: not /dev/pts (the host's terminals: a command could print a fake
 * prompt into the user's terminal) and not /dev/shm (shared memory that outlives the command); /dev/ptmx is useless
 * without /dev/pts. A pseudo-terminal for `bash` with `tty: true` is allocated by the helper before it confines.
 */
const DEV_RW = ['/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom', '/dev/tty'];

/** Qwen's floor (qwen-landlock-run.c MIN_ABI 3): below ABI 3 Landlock does not handle truncate(2) (review finding 11). */
export const LANDLOCK_MIN_ABI = 3;

function listDir(d: string): string[] {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read grants for "/ minus `deny`": a directory containing a denied path is replaced by its other children.
 * Symlinks are skipped (a rule on a link would grant its target).
 */
export function readGrants(deny: string[], root = '/', list = listDir, dir = isDir, depth = 0): string[] {
  const inside = deny.filter((d) => within(d, root));
  if (!inside.length) return [root];
  if (inside.some((d) => d === root) || depth > 16 || !dir(root)) return [];
  const out: string[] = [];
  for (const name of list(root)) {
    const c = path.join(root, name);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(c);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink()) {
      // a link to somewhere else is reachable through its target's own grant; a link INTO a denied path stays denied
      continue;
    }
    out.push(...readGrants(inside, c, list, dir, depth + 1));
  }
  return out;
}

/** The helper invocation for a command. */
export function landlockSpec(spec: SpawnSpec, pol: LandlockPolicy, probe: LandlockProbe = landlockProbe()): SpawnSpec {
  // review finding 5: Landlock only adds rights, so a writable root that CONTAINS a credential store (the home
  // directory as workspace, ~/.config in allowWrite) is split around it exactly like the read grants: its other
  // children are granted, the store gets nothing
  const rw = [...(pol.filesystem === 'read-only' ? [] : [pol.workspace]), ...pol.writable, pol.scratch, ...DEV_RW]
    .filter((p) => fs.existsSync(p) && !pol.denyRead.some((d) => within(p, d)))
    .flatMap((p) => readGrants(pol.denyRead, p));
  const ro = readGrants(pol.denyRead);
  const helperSpec = {
    ro,
    rw,
    net: pol.network === 'host' ? null : { connect: pol.network === 'proxy' && pol.proxyPort ? [pol.proxyPort] : [] },
    ip: pol.network === 'host' ? 'all' : pol.network === 'none' ? 'none' : 'tcp',
    unix: pol.unixSockets ?? 'deny',
    max_abi: pol.maxAbi,
    min_abi: LANDLOCK_MIN_ABI,
    ppid: process.pid,
    pty: pol.pty === true,
    // only a proxied run needs the network; "none" is closed by seccomp on any ABI
    require_net: pol.requireNetwork && pol.network === 'proxy',
  };
  const env = { ...spec.env, TMPDIR: pol.scratch, TMP: pol.scratch, TEMP: pol.scratch };
  // The grant list can be long (a split home or temp dir), past the 128 KiB argument limit: it goes in a private
  // file the helper reads and deletes before it confines anything (the scratch dir is the harness's, mode 0700).
  const specFile = path.join(path.dirname(pol.scratch), `${path.basename(pol.scratch)}.spec-${process.pid}-${++seq}.json`);
  fs.writeFileSync(specFile, JSON.stringify(helperSpec), { mode: 0o600 });
  return { ...spec, file: probe.python ?? 'python3', args: ['-I', '-S', '-c', LANDLOCK_HELPER_PY, `@${specFile}`, '--', spec.file, ...spec.args], env };
}

let seq = 0;
const scratchDirs = new Set<string>();
/** A private scratch directory for one config's commands (removed at exit). */
export function makeScratch(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ll-'));
  if (!scratchDirs.size) process.once('exit', () => scratchDirs.forEach((s) => fs.rmSync(s, { recursive: true, force: true })));
  scratchDirs.add(d);
  return fs.realpathSync(d);
}

/** One line for `tug sandbox status`. */
export function landlockSummary(p: LandlockProbe, network: 'none' | 'proxy' | 'host', maxAbi?: number, unixSockets: 'deny' | 'allow' = 'deny'): string {
  if (!p.ok) return `Landlock unavailable: ${p.reason}`;
  const abi = Math.min(p.abi, maxAbi ?? 99);
  if (abi < LANDLOCK_MIN_ABI) return `Landlock ABI ${abi} (capped from ${p.abi}) is below ${LANDLOCK_MIN_ABI}: truncate(2) is not controlled, so commands are refused`;
  const net =
    network === 'host'
      ? 'network unrestricted (sandbox.network: host)'
      : abi >= 4
        ? network === 'proxy'
          ? 'TCP only to the allowlist proxy (Landlock ABI >= 4), no UDP, raw, MPTCP or SCTP sockets (seccomp)'
          : 'no IP sockets (seccomp)'
        : network === 'none'
          ? 'network not restricted by Landlock (ABI < 4); seccomp blocks all IP sockets'
          : 'network not restricted by Landlock (ABI < 4)';
  return `Landlock ABI ${abi}${abi < p.abi ? ` (capped from ${p.abi})` : ''}: credential stores unreadable, writes only to the workspace, caches and a private TMPDIR; ${net}; ${unixSockets === 'deny' ? 'no unix-socket connections, so no host daemon (Docker, Podman, containerd) is reachable (seccomp)' : 'UNIX SOCKETS ALLOWED (sandbox.unixSockets: allow): host daemons such as Docker are reachable'}${abi >= 6 ? '; signals scoped to the sandbox' : ''}`;
}
