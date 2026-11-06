/**
 * Command execution — the most dangerous capability (EAG S17 §6).
 *
 * Two modes, chosen by config.shell.mode:
 *  - 'shell'     : bash -c (cmd.exe on Windows). Full power; every command goes
 *                  through the permission engine (ask / allow rules / dangerous
 *                  pattern detection) before it runs.
 *  - 'allowlist' : S17's runner. No shell at all: the command is split into argv,
 *                  shell metacharacters are refused, argv[0] must be allowlisted,
 *                  git is limited to local subcommands and `-c`/pack overrides,
 *                  `python -c` is refused.
 * Both modes: cwd is the workspace, a wall-clock timeout kills the process
 * group, output is capped head+tail, secrets are scrubbed from the env.
 * Optional sandbox: config.shell.sandbox='docker' runs each command in a
 * throwaway container with the workspace mounted and (by default) no network.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import type { HarnessConfig } from '../config.js';
import path from 'node:path';
import { ToolError, type ToolContext, type ToolDef } from './types.js';
import { capOutput } from '../util/text.js';
import { isInside, realResolve } from '../permissions/policy.js';
import { coreSettings } from '../context/settings.js';
import { JOB_TOOL_NAMES, startJob } from '../jobs/manager.js';
import { platformSpawnArgs } from '../util/procs.js';
import { LANDLOCK_LIMIT_HINT, LANDLOCK_LIMITS, requestedRunner } from '../sandbox/settings.js';

export const SHELL_METACHARACTERS = [';', '&&', '||', '|', '`', '$(', '>', '<', '\n'];
export const GIT_SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'add', 'commit', 'checkout', 'restore', 'branch', 'rev-parse', 'stash', 'switch', 'ls-files', 'blame', 'grep'];

/** Minimal POSIX-ish argv splitter (quotes and backslashes). */
export function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (q) throw new ToolError('unbalanced quote in command');
  if (cur || has) out.push(cur);
  return out;
}

/** Git options that can execute programs, write outside the workspace or retarget the repo. */
const GIT_FORBIDDEN_OPT = /^(-c|-C|-O|--config-env|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix|--upload-pack|--receive-pack|--exec|--output|--open-files-in-pager|--ext-diff|--textconv|--template|--separate-git-dir|-o)(=|$)|^-c.|^-O./;

/**
 * S17 allowlist checks. Throws ToolError with a teaching message on refusal.
 * This bounds accidents and shell injection; it is not a sandbox against an
 * adversarial model (an allowlisted interpreter can run a script the agent
 * wrote). Use shell.sandbox = "docker" for that.
 */
export function checkAllowlisted(command: string, allowlist: string[]): string[] {
  for (const meta of SHELL_METACHARACTERS) {
    if (command.includes(meta)) throw new ToolError(`'${meta === '\n' ? '\\n' : meta}' has no meaning here: commands run without a shell (allowlist mode). Run one program per call.`);
  }
  const argv = splitArgs(command);
  if (!argv.length) throw new ToolError('no command given');
  if (argv[0].includes('/') || argv[0].includes('\\')) throw new ToolError(`run programs by name, not by path ('${argv[0]}'): only allowlisted programs on PATH may run.`);
  const program = argv[0];
  if (!allowlist.includes(program)) throw new ToolError(`'${program}' is not an allowed command. Allowed: ${allowlist.join(', ')}.`);
  const args = argv.slice(1);
  if (/^python\d*(\.\d+)?$/.test(program)) {
    // Options come before the script/module; any short-option cluster containing c (-c, -Ic, -cprint) is inline code.
    for (const a of args) {
      if (a === '-m' || !a.startsWith('-')) break;
      if (/^-[A-Za-z]*c/.test(a) || a === '--command') throw new ToolError('python -c is refused: it is an unbounded shell. Write a script file and run it.');
    }
  }
  if (program === 'node' || program === 'deno' || program === 'bun') {
    for (const a of args) {
      if (!a.startsWith('-')) break;
      if (/^--(eval|print|import|require|loader|experimental-loader)(=|$)/.test(a) || /^-[A-Za-z]*[epr]/.test(a)) throw new ToolError(`${program} ${a} is refused: inline code / preloads are an unbounded shell. Write a script file and run it.`);
    }
  }
  if (['npx', 'pnpx', 'bunx', 'uvx'].includes(program) && args.some((a) => /^(-c|--call)(=|$)/.test(a))) throw new ToolError(`${program} -c is refused: it runs an arbitrary shell command.`);
  if (program === 'git') {
    const bad = args.find((a) => GIT_FORBIDDEN_OPT.test(a));
    if (bad) throw new ToolError(`git option '${bad}' can execute programs or reach outside the workspace; refused`);
    const sub = args.find((a) => !a.startsWith('-')) ?? '';
    if (!GIT_SUBCOMMANDS.includes(sub)) throw new ToolError(`git ${sub || '(none)'} is refused in allowlist mode. Allowed: ${GIT_SUBCOMMANDS.join(', ')}. (The agent may change the repository; it may not publish it.)`);
  }
  return argv;
}

export interface ExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Environment variable names that look like credentials. */
export const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|DATABASE_URL|_DSN$|CONNECTION_STRING|CONN_STR|WEBHOOK)/i;

/** Secret values to strip wherever they appear (set once by the agent from its config). */
const secretValues: string[] = [];
/** v1.2 WS24 (review F15): the secret values known to this process, for redacting headless output like the journal. */
export function knownSecretValues(): string[] {
  return [...secretValues];
}

export function registerSecretValues(vals: (string | undefined)[]): void {
  for (const v of vals) if (v && v.length >= 8 && !secretValues.includes(v)) secretValues.push(v);
}

/** Git config keys passed through the environment that carry credentials (G3). */
const GIT_CRED_KEY = /^http\..*extraheader$|^credential\.|token|password/i;
const GIT_INSTEADOF_KEY = /^url\..*\.(?:push)?insteadof$/i;
const USERINFO = /:\/\/[^/@\s]+@/;
const USERINFO_G = /(:\/\/)[^/@\s]+@/g;

/**
 * G3: `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>` inject git config through the
 * environment (CI runners put `http.<url>.extraheader = AUTHORIZATION: basic …` there). The value is
 * the credential, but its variable name looks harmless, so the name-based scrub misses it. Drop
 * credential-like pairs, renumber the rest densely from 0 and fix the count, so git still works
 * (git fails on a gap or a missing half of a pair). Pairs past the count are inert and dropped too.
 */
export function scrubGitConfigEnv(env: NodeJS.ProcessEnv): void {
  const raw = env.GIT_CONFIG_COUNT;
  const count = raw !== undefined && /^\d+$/.test(raw.trim()) ? Math.min(Number(raw.trim()), 10_000) : 0;
  const kept: [string, string][] = [];
  for (let i = 0; i < count; i++) {
    const k = env[`GIT_CONFIG_KEY_${i}`];
    const v = env[`GIT_CONFIG_VALUE_${i}`];
    if (k === undefined || v === undefined) continue;
    if (GIT_CRED_KEY.test(k)) continue;
    if (GIT_INSTEADOF_KEY.test(k) && (USERINFO.test(v) || USERINFO.test(k))) continue;
    // credentials inside URLs anywhere else (remote.<n>.url=https://user:token@…, http.proxy=http://u:p@…): keep the setting, drop the userinfo
    kept.push([k.replace(USERINFO_G, '$1'), v.replace(USERINFO_G, '$1')]);
  }
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete env[name];
  if (raw === undefined && !kept.length) return;
  if (!kept.length) {
    delete env.GIT_CONFIG_COUNT;
    return;
  }
  kept.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  env.GIT_CONFIG_COUNT = String(kept.length);
}

/** The environment for child processes: credentials removed (by name, by known value, and git-config pairs). `base` is for tests. */
export function scrubbedEnv(scrub: string[], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of scrub) delete env[k];
  // GIT_CONFIG_KEY_<n> holds a config key NAME (paired with GIT_CONFIG_COUNT/VALUE_<n>); removing it alone makes every git call fail.
  for (const k of Object.keys(env)) if (SECRET_ENV_NAME.test(k) && !k.startsWith('npm_config_') && !/^GIT_CONFIG_KEY_\d+$/.test(k)) delete env[k];
  const values = new Set(secretValues.filter((v) => v && v.length >= 8));
  if (values.size) for (const [k, v] of Object.entries(env)) if (v && values.has(v)) delete env[k];
  scrubGitConfigEnv(env);
  env.TUGLINE = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.PAGER = 'cat';
  env.GIT_PAGER = 'cat';
  env.CI = env.CI ?? '1';
  return env;
}

/** A command about to be spawned. Wrappers may rewrite it (e.g. an OS sandbox, SPEC C2). */
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /**
   * N36 review finding 12: the sandbox this spawn actually goes through, set by the wrapper that confines it
   * (bwrap, landlock, seatbelt, docker, podman, refused). Unset = unconfined. Recorded per run in the audit stream.
   */
  runner?: string;
  /** N36 (sandboxed PTY execution): the command before the PTY runner was put around it (a wrapper may run it natively) */
  ptyInner?: { file: string; args: string[] };
  /** N36 review finding 9: the per-command container this spawn starts, killed on timeout or abort */
  container?: { engine: string; name: string };
}
export type CommandWrap = (spec: SpawnSpec) => SpawnSpec;
/** Factories return a wrapper for this config, or undefined to leave commands unchanged (SPEC S0.7). */
export type CommandWrapperFactory = (cfg: HarnessConfig) => CommandWrap | undefined;
const wrapperFactories = new Map<string, CommandWrapperFactory>();
export function registerCommandWrapper(id: string, f: CommandWrapperFactory): void {
  wrapperFactories.set(id, f);
}
export function unregisterCommandWrapper(id: string): void {
  wrapperFactories.delete(id);
}
/** Compose all registered wrappers for a config (registration order). */
export function commandWrapperFor(cfg: HarnessConfig): CommandWrap | undefined {
  const ws = [...wrapperFactories.values()].map((f) => f(cfg)).filter((w): w is CommandWrap => !!w);
  if (!ws.length) return undefined;
  return (spec) => ws.reduce((s, w) => w(s), spec);
}

/** A per-command container (shell.sandbox / sandbox.runner "docker" or "podman"). */
export interface ContainerSandbox {
  image: string;
  network: string;
  mountRoot?: string;
  /** N36: docker (default) or podman */
  engine?: 'docker' | 'podman';
  /** N36: absolute paths under mountRoot mounted read-only over the writable workspace (protected and agent-control paths) */
  readOnly?: string[];
  /** N36: the whole workspace read-only (sandbox.filesystem) */
  readOnlyWorkspace?: boolean;
}

/**
 * N36 review finding 12: the sandbox module says which runner a config's commands should run under (a seam, like
 * the hook below), so a spawn that went through another one (or none) is recorded.
 */
let expectedRunner: ((cfg: HarnessConfig) => { runner: string; refusing: boolean }) | undefined;
export function setExpectedRunnerHook(f: typeof expectedRunner): void {
  expectedRunner = f;
}
/** The runner a config's commands should run under, or undefined when no sandbox module is loaded. */
export function expectedRunnerFor(cfg: HarnessConfig): { runner: string; refusing: boolean } | undefined {
  return expectedRunner?.(cfg);
}

/** N36: the sandbox module supplies the read-only paths for container runs (a seam: shell.ts must not import it). */
let containerReadOnly: ((cfg: HarnessConfig, root: string) => { readOnly: string[]; readOnlyWorkspace: boolean }) | undefined;
export function setContainerReadOnlyHook(f: typeof containerReadOnly): void {
  containerReadOnly = f;
}

/** The per-command container settings for a config, or null when commands do not run in a container. */
export function containerSandboxFor(cfg: HarnessConfig, workspace: string): ContainerSandbox | null {
  const runner = requestedRunner(cfg);
  if (runner !== 'docker' && runner !== 'podman') return null;
  const ro = containerReadOnly?.(cfg, workspace) ?? { readOnly: [], readOnlyWorkspace: false };
  return { image: cfg.shell.dockerImage, network: cfg.shell.dockerNetwork, mountRoot: workspace, engine: runner, readOnly: ro.readOnly, readOnlyWorkspace: ro.readOnlyWorkspace };
}

/**
 * N36 review finding 9: per-command containers are named and labelled (`tugline.cmd`, `tugline.pid`,
 * `tugline.host`) so the harness can kill one on timeout or abort, a watchdog kills it when the harness dies
 * (even by SIGKILL), and the next start removes any whose harness is gone.
 */
export const CMD_LABEL = 'tugline.cmd';
const liveContainers = new Map<string, string>();
const swept = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** [id, tugline.pid, tugline.host, tugline.session] of every container carrying `label` (Docker and Podman). */
export function containerLabels(engine: string, label: string): string[][] {
  const ids = (spawnSync(engine, ['ps', '-a', '-q', '--filter', `label=${label}`], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) return [];
  const r = spawnSync(engine, ['inspect', '--format', '{{.Id}} {{index .Config.Labels "tugline.pid"}} {{index .Config.Labels "tugline.host"}} {{index .Config.Labels "tugline.session"}}', ...ids], { encoding: 'utf8', timeout: 15_000 });
  return (r.stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x[0]);
}

/** Remove per-command containers of this host whose harness process is gone. Returns the removed ids. */
export function sweepStaleCommandContainers(engine: string): string[] {
  const removed: string[] = [];
  for (const line of containerLabels(engine, CMD_LABEL)) {
    const [id, pid, host] = line;
    if (!id || !pid || host !== os.hostname() || pidAlive(Number(pid))) continue;
    spawnSync(engine, ['rm', '-f', id], { stdio: 'ignore', timeout: 30_000 });
    removed.push(id);
  }
  return removed;
}

/** Kill a per-command container now (timeout, abort, harness exit). */
export function killCommandContainer(engine: string, name: string): void {
  spawnSync(engine, ['rm', '-f', ...(engine === 'podman' ? ['--ignore'] : []), name], { stdio: 'ignore', timeout: 30_000 });
  liveContainers.delete(name);
}

let exitHook = false;
function trackContainer(engine: string, name: string): void {
  liveContainers.set(name, engine);
  if (exitHook) return;
  exitHook = true;
  process.once('exit', () => {
    for (const [n, e] of liveContainers) spawnSync(e, ['rm', '-f', n], { stdio: 'ignore', timeout: 15_000 });
  });
}

/**
 * The client runs under a small watchdog in its own process group: when the harness process disappears (a crash,
 * SIGKILL), the watchdog removes the container instead of leaving it running.
 */
const CONTAINER_WATCHDOG = 'e=$1; n=$2; p=$3; shift 3; "$e" "$@" & c=$!; while kill -0 "$c" 2>/dev/null; do if ! kill -0 "$p" 2>/dev/null; then "$e" rm -f "$n" >/dev/null 2>&1; break; fi; sleep 0.5; done; wait "$c"';

/** `docker run` / `podman run` arguments for one command. Hardened: no new privileges, raw sockets and mknod dropped, limits. */
export function containerRunArgs(sb: ContainerSandbox, cwd: string, inner: string[], o: { name?: string; tty?: boolean } = {}): { file: string; args: string[] } {
  const root = sb.mountRoot ?? cwd;
  const rel = path.relative(root, cwd).split(path.sep).join('/');
  const workdir = rel && !rel.startsWith('..') ? `/workspace/${rel}` : '/workspace';
  const engine = sb.engine ?? 'docker';
  const args = ['run', '--rm', o.tty ? '-t' : '-i', '--init', `--network=${sb.network}`, '--memory=2g', '--cpus=2', '--pids-limit=512', '--security-opt=no-new-privileges', '--cap-drop=NET_RAW', '--cap-drop=MKNOD', '--cap-drop=AUDIT_WRITE', '--cap-drop=SYS_CHROOT'];
  if (o.name) args.push('--name', o.name, '--label', `${CMD_LABEL}=1`, '--label', `tugline.pid=${process.pid}`, '--label', `tugline.host=${os.hostname()}`);
  // rootless podman: the user's files stay the user's (keep-id is refused by rootful podman)
  if (engine === 'podman' && typeof process.getuid === 'function' && process.getuid() !== 0) args.push('--userns=keep-id');
  args.push('-v', `${root}:/workspace${sb.readOnlyWorkspace ? ':ro' : ''}`);
  for (const r of sb.readOnly ?? []) {
    const rr = path.relative(root, r).split(path.sep).join('/');
    if (!rr || rr.startsWith('..') || path.isAbsolute(rr)) continue;
    args.push('-v', `${r}:/workspace/${rr}:ro`);
  }
  args.push('-w', workdir, sb.image, ...inner);
  return { file: engine, args };
}

/** How a command is spawned, after sandbox and wrappers. Shared by foreground and background (D5) runs. */
export function buildSpawnSpec(opts: {
  argv?: string[];
  shellCommand?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  sandbox?: ContainerSandbox | null;
  wrap?: CommandWrap;
  /** N36: run the command on a pseudo-terminal, inside the sandbox */
  pty?: boolean;
}): SpawnSpec {
  let file: string;
  let args: string[];
  if (opts.sandbox) {
    // bash when the image has it (most do), else POSIX sh (alpine, distroless-with-busybox)
    const inner = opts.argv ?? ['sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -c "$0"; else exec sh -c "$0"; fi', opts.shellCommand!];
    const engine = opts.sandbox.engine ?? 'docker';
    if (!swept.has(engine)) {
      swept.add(engine);
      sweepStaleCommandContainers(engine);
    }
    const name = `oh-cmd-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const run = containerRunArgs(opts.sandbox, opts.cwd, inner, { name, tty: opts.pty });
    trackContainer(engine, name);
    return { file: '/bin/sh', args: ['-c', CONTAINER_WATCHDOG, 'oh-container', run.file, name, String(process.pid), ...run.args], cwd: opts.cwd, env: opts.env, runner: engine, container: { engine, name } };
  } else if (opts.argv) {
    [file, ...args] = opts.argv;
  } else if (process.platform === 'win32') {
    file = process.env.ComSpec ?? 'cmd.exe';
    args = ['/d', '/s', '/c', opts.shellCommand!];
  } else {
    file = process.env.SHELL?.endsWith('zsh') ? '/bin/zsh' : '/bin/bash';
    args = ['-c', opts.shellCommand!];
  }
  let spec: SpawnSpec = { file, args, cwd: opts.cwd, env: opts.env };
  if (opts.pty && process.platform !== 'win32') spec = ptySpec(spec);
  return opts.wrap ? opts.wrap(spec) : spec;
}

/**
 * N36 (Qwen parity: sandboxed PTY execution, execute-sandbox.ts usePty): the command runs on a pseudo-terminal for
 * programs that need one (isatty checks, colour, curses prompts). The PTY runner goes INSIDE the sandbox, so the
 * terminal is the sandbox's own (bwrap: a private devpts; Seatbelt: /dev/ttys*); the Landlock wrapper instead lets
 * its helper allocate the terminal before it confines (Landlock gives commands no /dev/pts); containers get `-t`.
 * Input is an immediate end-of-file; output has \r\n turned back into \n.
 */
export const PTY_RUNNER_PY = String.raw`
import os, sys, struct, fcntl, termios, select
argv = sys.argv[1:]
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))
a = termios.tcgetattr(slave); a[1] &= ~termios.ONLCR; termios.tcsetattr(slave, termios.TCSANOW, a)
pid = os.fork()
if pid == 0:
    os.setsid(); fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2): os.dup2(slave, fd)
    os.close(master); os.close(slave)
    try: os.execvp(argv[0], argv)
    except OSError as e: sys.stderr.write('%s: %s\n' % (argv[0], e.strerror)); os._exit(127)
os.close(slave)
os.write(master, b'\x04')
done = None
while True:
    r, _, _ = select.select([master], [], [], 0.2)
    if r:
        try: b = os.read(master, 65536)
        except OSError: b = b''
        if not b: break
        os.write(1, b)
    elif done is None:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p: done = st
if done is None: _, done = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(done) if os.waitstatus_to_exitcode(done) >= 0 else 128 - os.waitstatus_to_exitcode(done))
`;

export function ptySpec(spec: SpawnSpec): SpawnSpec {
  return { ...spec, file: 'python3', args: ['-I', '-S', '-c', PTY_RUNNER_PY, spec.file, ...spec.args], ptyInner: { file: spec.file, args: spec.args } };
}

export { platformSpawnArgs } from '../util/procs.js';

export function execCommand(opts: {
  argv?: string[];
  shellCommand?: string;
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  sandbox?: ContainerSandbox | null;
  wrap?: CommandWrap;
  /** Test seam: the spawn function (default node:child_process spawn). */
  spawnImpl?: typeof spawn;
  /** N36: run on a pseudo-terminal (inside the sandbox) */
  pty?: boolean;
  /** N36 review finding 12: the final spawn spec, after every wrapper (which sandbox it goes through) */
  onSpawn?: (spec: SpawnSpec) => void;
}): Promise<ExecResult> {
  const started = Date.now();
  // A wrapper (OS sandbox, SPEC C2) may rewrite file, args, env and cwd.
  const built = buildSpawnSpec(opts);
  opts.onSpawn?.(built);
  const { file, args, env, cwd } = built;
  if (opts.signal?.aborted) return Promise.resolve({ exitCode: null, output: 'cancelled before start', timedOut: false, durationMs: 0 });
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const sp = platformSpawnArgs(file, args);
    const child = (opts.spawnImpl ?? spawn)(file, sp.args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: sp.windowsVerbatimArguments, windowsHide: true });
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // review finding 9: killing the client does not stop the container
      if (built.container) killCommandContainer(built.container.engine, built.container.name);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const cap = 2_000_000;
    child.stdout.on('data', (d) => {
      if (out.length < cap) out += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (out.length < cap) out += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exitCode: 127, output: `failed to start: ${e.message}`, timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (built.container) liveContainers.delete(built.container.name);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? (sig ? 128 : null), output: out, timedOut, durationMs: Date.now() - started });
    });
  });
}

// ------------------------------------------------------------ session working directory (D5)

/**
 * Per-session cwd. A bare `cd <dir>` changes it for later calls; `cd dir && cmd`
 * runs in a subshell and does not. The cwd never leaves the workspace or the
 * configured additional directories.
 */
const sessionCwds = new Map<string, string>();
export function sessionCwd(sessionId: string): string | undefined {
  return sessionCwds.get(sessionId);
}
export function resetSessionCwd(sessionId: string): void {
  sessionCwds.delete(sessionId);
}

function resolveCwd(dir: string, base: string, ctx: ToolContext): string {
  const abs = realResolve(path.resolve(base, dir.replace(/^~(?=$|\/)/, process.env.HOME ?? '~')));
  const roots = [ctx.workspace, ...ctx.config.permissions.additionalDirectories].map((r) => realResolve(r));
  if (!roots.some((r) => isInside(abs, r))) throw new ToolError(`cwd ${dir} is outside the workspace; commands run inside ${ctx.workspace}${ctx.config.permissions.additionalDirectories.length ? ' or the additional directories' : ''}.`);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(abs);
  } catch {
    st = undefined;
  }
  if (!st?.isDirectory()) throw new ToolError(`cwd ${dir} is not a directory`);
  return abs;
}

const BARE_CD = /^cd(?:\s+("[^"]*"|'[^']*'|[^\s;&|<>`$()]+))?\s*$/;

type BashArgs = { command: string; timeout_ms?: number; description?: string; cwd?: string; run_in_background?: boolean; persist?: boolean; tty?: boolean };

const BASH_PARAMS = {
  command: { type: 'string', description: 'The command line to run' },
  timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (max 600000)' },
  description: { type: 'string', description: '5-10 word summary of what the command does' },
  cwd: { type: 'string', description: 'Directory to run in (relative to the workspace). Optional.' },
  tty: { type: 'boolean', description: 'Run on a pseudo-terminal (inside the sandbox) for programs that need one (isatty checks, colour). Input is end-of-file. Optional.' },
};

export const bashTool: ToolDef<BashArgs> = {
  name: 'bash',
  kind: 'execute',
  description:
    'Run a command in the workspace directory and return its exit code and combined output. Use it to run tests, builds, linters, git (local only) and project scripts. ' +
    'Calls start in the workspace root unless you pass `cwd`; a bare `cd <dir>` changes the directory for later calls ("cd dir && cmd" does not). Long output is truncated. Do not use it to read or search files when read_file/grep/glob can. ' +
    'Never start long-running servers in the foreground; avoid interactive commands (they get no input). Default timeout 120s.',
  parameters: {
    type: 'object',
    properties: BASH_PARAMS,
    required: ['command'],
  },
  title: (a) => `${a.run_in_background ? 'Start in background' : 'Run'}: ${a.command}`,
  // cwd: relative write targets in the command resolve against it (R1 static check in the policy)
  permissionInput: (a, ctx) => ({ command: String(a.command ?? ''), cwd: a.cwd ? path.resolve(sessionCwd(ctx.sessionId) ?? ctx.workspace, String(a.cwd)) : sessionCwd(ctx.sessionId) ?? ctx.workspace }),
  validate(a, ctx) {
    if (a.cwd) resolveCwd(String(a.cwd), sessionCwd(ctx.sessionId) ?? ctx.workspace, ctx);
  },
  async run(a, ctx: ToolContext) {
    const command = String(a.command ?? '').trim();
    if (!command) throw new ToolError('command is required');
    const sh = ctx.config.shell;
    const base = sessionCwd(ctx.sessionId) ?? ctx.workspace;
    const cwd = a.cwd ? resolveCwd(String(a.cwd), base, ctx) : base;
    // Bare `cd`: update the session cwd without spawning anything.
    const cd = command.match(BARE_CD);
    if (cd && !a.run_in_background) {
      const target = cd[1] ? cd[1].replace(/^["']|["']$/g, '') : ctx.workspace;
      const next = resolveCwd(target, cwd, ctx);
      if (next === realResolve(ctx.workspace)) sessionCwds.delete(ctx.sessionId);
      else sessionCwds.set(ctx.sessionId, next);
      const rel = path.relative(ctx.workspace, next) || '.';
      return { output: `$ ${command}\nworking directory is now ${rel} (later bash calls run there)\n[exit code 0, 0.0s]`, meta: { command, exitCode: 0, durationMs: 0 } };
    }
    const timeoutMs = Math.max(1000, Math.min(Number(a.timeout_ms) || sh.timeoutMs, 600_000));
    const env = scrubbedEnv(sh.scrubEnv);
    const sandbox = containerSandboxFor(ctx.config, ctx.workspace);
    const wrap = commandWrapperFor(ctx.config);
    const argv = sh.mode === 'allowlist' ? checkAllowlisted(command, sh.allowlist) : undefined;
    if (a.run_in_background) {
      if (!coreSettings(ctx.config).backgroundJobs) throw new ToolError('background jobs are disabled (agent.backgroundJobs is false). Run the command in the foreground with a timeout instead.');
      const spec = buildSpawnSpec({ argv, shellCommand: argv ? undefined : command, cwd, env, sandbox, wrap });
      const job = startJob({ ...spec, command, sessionId: ctx.sessionId, homeDir: ctx.config.homeDir, persist: !!a.persist });
      ctx.emit({ type: 'job', jobId: job.id, phase: 'start', command });
      job.onEnd.push((j) => ctx.emit({ type: 'job', jobId: j.id, phase: 'end', command: j.command, exitCode: j.exitCode ?? null, text: j.status }));
      return {
        output: `$ ${command}\nStarted background job ${job.id} (pid ${job.pid ?? '?'}). Output is logged to ${job.logFile}.\nUse monitor {"job_id":"${job.id}","pattern":"<regex>"} to wait for readiness, job_output to read output and job_kill to stop it.${job.persist ? ' It keeps running after the session (persist).' : ' It is stopped when the session ends.'}`,
        meta: { backgroundCommand: command, jobId: job.id, activateTools: JOB_TOOL_NAMES },
      };
    }
    let ranUnder = 'none';
    const onSpawn = (spec: SpawnSpec) => (ranUnder = spec.runner ?? 'none');
    const pty = a.tty === true;
    const spawnOpts = argv ? { argv, cwd, timeoutMs, env, signal: ctx.signal, sandbox, wrap, pty, onSpawn } : { shellCommand: command, cwd, timeoutMs, env, signal: ctx.signal, sandbox, wrap, pty, onSpawn };
    // B10: a host may run the (already wrapped) command in a visible terminal; undefined = spawn it here.
    let res: ExecResult | undefined;
    // Only an explicit undefined falls back: a host that failed may already have started the command, so never run it twice.
    if (ctx.host?.runCommand) {
      try {
        const spec = buildSpawnSpec(spawnOpts);
        onSpawn(spec);
        res = await ctx.host.runCommand({ ...spec, command, timeoutMs, signal: ctx.signal });
      } catch (e) {
        throw new ToolError(`the ${ctx.host.kind} host failed to run the command (${(e as Error).message}); it was not run again. Check the result before retrying.`);
      }
    }
    res ??= await execCommand(spawnOpts);
    // re-check RC-3: say why a multiprocessing-style failure happened under Landlock, and what to do
    const hint = ranUnder === 'landlock' && res.exitCode !== 0 && LANDLOCK_LIMIT_HINT.test(res.output) ? `\n[sandbox: Landlock gives commands ${LANDLOCK_LIMITS}]` : '';
    const body = (capOutput(res.output.trimEnd(), sh.maxOutputChars) || '(no output)') + hint;
    const status = res.timedOut ? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s` : `exit code ${res.exitCode}`;
    const where = cwd !== realResolve(ctx.workspace) && cwd !== ctx.workspace ? ` (in ${path.relative(ctx.workspace, cwd) || '.'})` : '';
    return {
      output: `$ ${command}${where}\n${body}\n[${status}, ${(res.durationMs / 1000).toFixed(1)}s]`,
      isError: false, // a failing command is evidence, not a tool error (S17)
      meta: { command, exitCode: res.timedOut ? null : res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, sandbox: ranUnder, sandboxExpected: expectedRunnerFor(ctx.config) },
    };
  },
};

/** bash with run_in_background (used when agent.backgroundJobs is on; the agent swaps it in). */
export const bashBackgroundTool: ToolDef<BashArgs> = {
  ...bashTool,
  description: `${bashTool.description} For dev servers, watchers and other long-running processes set run_in_background: true; you get a job_id immediately.`,
  parameters: {
    type: 'object',
    properties: {
      ...BASH_PARAMS,
      run_in_background: { type: 'boolean', description: 'Start as a background job and return its job_id immediately' },
      persist: { type: 'boolean', description: 'Background only: keep running after the session ends (default false; only honoured when shell.processLifetime is "off")' },
    },
    required: ['command'],
  },
};
