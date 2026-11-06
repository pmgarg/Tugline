/**
 * OS sandbox for shell commands (SPEC C2, N30, N36).
 *
 * `sandbox.runner` (alias `sandbox.mode`, legacy `shell.sandbox`) selects the runner:
 *   auto     (default) seatbelt on macOS; on Linux bwrap, else Landlock (N36),
 *            else none with a visible warning (refused under sandbox.require)
 *   none     run on the host
 *   docker   throwaway container per command (tools/shell.ts)
 *   podman   the same with Podman (N36)
 *   bwrap    Linux bubblewrap: read-only root, writable workspace + cache dirs,
 *            private /tmp, no network namespace access except the allowlist proxy
 *   landlock Linux Landlock LSM + seccomp (landlock.ts): the fallback without user namespaces
 *   seatbelt macOS sandbox-exec with a generated SBPL profile (same policy)
 *
 * N36: every runner hides the credential stores (sandbox.denyRead: ~/.ssh, ~/.aws,
 * ~/.config/gh …, and the harness home) from reads, not only from writes.
 *
 * `shell.requireSandbox: true` (the default for scheduled, daemon and remote
 * runs, see markUnattended) fails closed when no sandbox is available.
 *
 * It plugs in through the S0.7 command-wrapper seam, so every process the
 * harness spawns for the model through `commandWrapperFor(cfg)` is wrapped.
 * Fail closed: an explicitly requested (or managed-forced) sandbox that is not
 * available makes commands fail with an explanation instead of running
 * unsandboxed.
 *
 * Network: with `sandbox.allowDomains` set, traffic goes through the allowlist
 * proxy (proxy.ts). bwrap gets a fresh network namespace whose only route out is
 * a tiny in-sandbox bridge (127.0.0.1:3128 → unix socket → proxy); Seatbelt may
 * only connect to the proxy's loopback port. Without allowDomains there is no
 * network at all (`sandbox.network: 'host'` opts out of network isolation).
 *
 * Honesty note: outside the credential stores the root stays readable (as in
 * Codex, Claude Code and Qwen Code); secrets elsewhere stay protected by env
 * scrubbing and the permission policy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setEffectiveRunnerHook, type HarnessConfig } from '../config.js';
import { registerCommandWrapper, setContainerReadOnlyHook, setExpectedRunnerHook, type CommandWrap, type SpawnSpec } from '../tools/shell.js';
import { registerAgentExtension } from '../agent/extensions.js';
import { DomainProxy, type ProxyLogEntry } from './proxy.js';
import { protectedSet, readOnlyRoots } from '../permissions/protectFs.js';
import { guardedGlobs, setGitConfigSandboxedHook } from '../permissions/protect.js';
import { recordSecurityEvent } from '../permissions/audit.js';
import { DEFAULT_DENY_READ, RUNNERS, denyReadPaths, requestedRunner, runtimeSocketDirs, sandboxRequired, splitAround, within, type RunnerName, type UnixSocketPolicy } from './settings.js';
import { LANDLOCK_MIN_ABI, landlockProbe, landlockSpec, landlockSummary, makeScratch, type LandlockProbe } from './landlock.js';
export { DEFAULT_DENY_READ, requestedRunner, runtimeSocketDirs, sandboxRequired } from './settings.js';

export interface SandboxConfig {
  /** Hosts reachable through the proxy: "github.com", "*.npmjs.org", "*" (everything, but still via the proxy). */
  allowDomains: string[];
  /** N30: named host lists added to allowDomains (see DOMAIN_PRESETS), so package installs keep working. */
  allowDomainsPreset: string[];
  /** 'auto' = proxy when allowDomains is non-empty, else none. 'host' disables network isolation. */
  network: 'auto' | 'none' | 'proxy' | 'host';
  /** Extra writable directories (absolute or ~/…); missing ones are skipped. */
  allowWrite: string[];
  /** Workspace paths kept read-only inside the sandbox (persistence vectors and agent-control files). */
  readOnlyPaths: string[];
  /** Upstream proxy for allowed traffic: 'env' (the harness's own HTTPS_PROXY), 'none', or a URL. */
  upstreamProxy: string;
  /** Set by managed policy (forceSandbox): never run unsandboxed. */
  required: boolean;
  /** N30 AC3: let `auto` use Seatbelt on macOS before the device check has recorded a pass. */
  macosSeatbelt?: boolean;
  /** N36: the runner (alias of shell.sandbox; `mode` is accepted as a synonym). */
  runner?: RunnerName;
  mode?: RunnerName;
  /** N36: never run a model command unsandboxed (alias of `required` / shell.requireSandbox). */
  require?: boolean;
  /** N36: 'container' runs the whole session in a container (`tug --container`). */
  session?: 'host' | 'container';
  /** N36: 'read-only' keeps the workspace read-only inside the sandbox too (Qwen parity). */
  filesystem: 'workspace-write' | 'read-only';
  /** N36: credential stores hidden from reads in every runner (~ is the home directory), IN ADDITION to the defaults. */
  denyRead: string[];
  /** N36 review finding 1: default credential stores the user lets commands read (user or managed scope only). */
  allowRead?: string[];
  /** N36: Landlock options. maxAbi caps the ABI used (to test the behaviour of older kernels). */
  landlock?: { maxAbi?: number };
  /**
   * WS17 review F2: unix sockets. "deny" (default): runtime socket dirs (/run, /var/run, $XDG_RUNTIME_DIR …) are
   * hidden (bwrap), socket(AF_UNIX) is refused (Landlock: it cannot hide a socket path), daemon sockets are denied
   * (Seatbelt). "allow" keeps the old behaviour (a command can reach host daemons, e.g. the Docker socket: host root).
   */
  unixSockets?: UnixSocketPolicy;
  /** N36: Seatbelt profile style: "permissive" (allow by default, deny writes; the default) or "restrictive" (deny by default). */
  seatbelt?: 'permissive' | 'restrictive';
  /** N36 SAC1: workspaces (absolute paths) whose project config may loosen sandbox and network settings. User scope only. */
  trustProjectConfig?: string[];
}

/** N30: package registries (and GitHub release downloads, which many installers fetch binaries from). */
export const DOMAIN_PRESETS: Record<string, string[]> = {
  npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
  pypi: ['pypi.org', 'files.pythonhosted.org'],
  cargo: ['crates.io', 'index.crates.io', 'static.crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
  maven: ['repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org'],
  'github-releases': ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  apt: ['deb.debian.org', 'security.debian.org', 'archive.ubuntu.com', 'security.ubuntu.com', 'ports.ubuntu.com'],
};
DOMAIN_PRESETS.crates = DOMAIN_PRESETS.cargo!;
DOMAIN_PRESETS.registries = [...new Set(['npm', 'pypi', 'cargo', 'go', 'maven', 'github-releases'].flatMap((k) => DOMAIN_PRESETS[k]!))];

export const DEFAULT_SANDBOX: SandboxConfig = {
  allowDomains: [],
  allowDomainsPreset: ['npm', 'pypi', 'cargo', 'go', 'maven', 'github-releases'],
  network: 'auto',
  allowWrite: ['~/.cache', '~/.npm', '~/.yarn', '~/.pnpm-store', '~/.cargo/registry', '~/go/pkg/mod', '~/.m2', '~/.gradle', '~/.nuget/packages'],
  readOnlyPaths: ['.git/hooks', '.git/config', '.tugline', '.mcp.json', '.vscode', '.claude', '.envrc'],
  upstreamProxy: 'env',
  required: false,
  filesystem: 'workspace-write',
  denyRead: [],
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC C2 (WS3). Runner selection is shell.sandbox. */
    sandbox?: Partial<SandboxConfig>;
    /** Set by markUnattended (scheduled, daemon and remote runs): no human is there to answer, even if a UI is attached. */
    unattended?: boolean;
  }
  interface ShellConfigExtensions {
    /** N30: never run a model command unsandboxed (fail closed). Unset = false, except scheduled, daemon and remote runs (true). */
    requireSandbox?: boolean;
    /**
     * R1 (B): 'session' (default): commands cannot outlive the harness. Where bwrap works, an unsandboxed command runs in
     * its own PID namespace (`bwrap --dev-bind / / --unshare-pid --die-with-parent`, no filesystem or network
     * restriction), so whatever it leaves running dies when it exits; and every background job of a session, including
     * `persist: true`, ends with the session. 'off': no lifetime wrapper, and `persist: true` jobs outlive the session (D5).
     */
    processLifetime?: 'session' | 'off';
  }
}

/** The effective sandbox settings: defaults, then config; presets are expanded into allowDomains. */
export function sandboxConfig(cfg: HarnessConfig): SandboxConfig {
  const sb = { ...DEFAULT_SANDBOX, ...(cfg.sandbox ?? {}) };
  const unknown = sb.allowDomainsPreset.filter((p) => !DOMAIN_PRESETS[p]);
  if (unknown.length) throw new Error(`unknown sandbox.allowDomainsPreset ${unknown.join(', ')} (known: ${Object.keys(DOMAIN_PRESETS).join(', ')})`);
  const preset = sb.allowDomainsPreset.flatMap((p) => DOMAIN_PRESETS[p]!);
  if (sb.filesystem !== 'workspace-write' && sb.filesystem !== 'read-only') throw new Error(`invalid sandbox.filesystem "${String(sb.filesystem)}" (workspace-write | read-only)`);
  const runner = requestedRunner(cfg);
  if (!RUNNERS.includes(runner)) throw new Error(`unknown sandbox runner "${runner}" (known: ${RUNNERS.join(', ')})`);
  return { ...sb, allowDomains: [...new Set([...sb.allowDomains, ...preset])], required: sandboxRequired(cfg) };
}

/** Scheduled, daemon and remote runs have nobody watching: require a sandbox unless the user explicitly said otherwise. */
export function markUnattended(cfg: HarnessConfig): HarnessConfig {
  // a copy: merged configs share nested objects with their base
  return { ...cfg, unattended: true, shell: cfg.shell.requireSandbox === undefined ? { ...cfg.shell, requireSandbox: true } : cfg.shell };
}

/** R1 (B): is the process-lifetime wrapper in force for unsandboxed commands of this config? */
export function processLifetimeEnforced(cfg: HarnessConfig, avail: () => boolean = lifetimeAvailable): boolean {
  return cfg.shell.processLifetime !== 'off' && avail();
}

let lifetimeOk: boolean | undefined;
/** bwrap with a PID namespace and nothing else works on this machine (smoke-tested once; user namespaces may be off). */
export function lifetimeAvailable(): boolean {
  if (lifetimeOk === undefined) lifetimeOk = process.platform === 'linux' && onPath('bwrap') && spawnSync('bwrap', lifetimeArgs({ file: '/bin/true', args: [], cwd: '/', env: {} }), { stdio: 'ignore', timeout: 5000 }).status === 0;
  return lifetimeOk;
}

/**
 * The lifetime wrapper's bwrap arguments: no filesystem or network change, only a PID namespace tied to the harness.
 * No `--chdir`: bwrap keeps the spawn's working directory, so a wrapper that runs later and changes `cwd` still applies.
 */
export function lifetimeArgs(spec: SpawnSpec): string[] {
  return ['--dev-bind', '/', '/', '--unshare-pid', '--die-with-parent', '--', spec.file, ...spec.args];
}

export interface SandboxStatus {
  /** the runner as configured (sandbox.runner / shell.sandbox) */
  requested: string;
  /** what commands actually run under */
  runner: RunnerKind;
  network: 'none' | 'proxy' | 'host';
  /** hosts reachable through the proxy (network 'proxy') */
  allowDomains: string[];
  required: boolean;
  /** true when commands will be refused because a required sandbox is missing */
  refusing: boolean;
  /** why the requested sandbox is not in use */
  unavailable?: string;
  /** one line for banners, `tug doctor` and the VS Code status bar */
  summary: string;
  /** R1 (B): how commands are kept from outliving the harness: the sandbox's own PID namespace or reaper, the lifetime wrapper, or none */
  processLifetime: 'sandbox' | 'bwrap' | 'none';
  /** N36: credential stores hidden from reads (only those that exist are listed) */
  denyRead: string[];
  /** N36: the Landlock probe on Linux */
  landlock?: { ok: boolean; abi: number; reason?: string; summary: string };
  filesystem: 'workspace-write' | 'read-only';
  /** N36: why each fallback was or was not taken, for `tug sandbox status` */
  chain: string[];
}

/** N30: the sandbox state for a config (for `tug doctor`, the CLI banner and the VS Code status). */
export function sandboxStatus(cfg: HarnessConfig, avail: (k: AvailKind) => boolean = runnerAvailable): SandboxStatus {
  const sb = sandboxConfig(cfg);
  const sel = selectRunner(cfg, avail);
  const net = networkMode(sb);
  const requested = requestedRunner(cfg);
  const explicit = EXPLICIT.has(requested);
  const ll = sel.kind === 'landlock' || (process.platform === 'linux' && (requested === 'auto' || requested === 'landlock')) ? landlockProbe() : undefined;
  const llNetRefuse = sel.kind === 'landlock' && net === 'proxy' && sb.required && Math.min(ll?.abi ?? 0, sb.landlock?.maxAbi ?? 99) < 4;
  // review finding 11: below ABI 3 truncate(2) is not controlled: the helper refuses (Qwen's floor)
  const llFloor = sel.kind === 'landlock' && Math.min(ll?.abi ?? 0, sb.landlock?.maxAbi ?? 99) < LANDLOCK_MIN_ABI;
  const refusing = (sel.kind === 'none' && (sb.required || (explicit && !!sel.unavailable))) || llNetRefuse || llFloor;
  const ro = sb.filesystem === 'read-only' ? 'workspace READ-ONLY' : 'workspace writable';
  let summary: string;
  if (sel.kind === 'docker' || sel.kind === 'podman') summary = `sandbox: ${sel.kind} container per command (${ro}, protected paths read-only, network ${cfg.shell.dockerNetwork === 'bridge' ? 'bridge' : 'off'}, host home not mounted)`;
  else if (llFloor) summary = `sandbox: landlock REFUSED: ABI ${Math.min(ll?.abi ?? 0, sb.landlock?.maxAbi ?? 99)} < ${LANDLOCK_MIN_ABI} (truncate(2) is not controlled): commands are refused`;
  else if (llNetRefuse) summary = `sandbox: landlock, but network not restricted by Landlock (ABI ${Math.min(ll?.abi ?? 0, sb.landlock?.maxAbi ?? 99)} < 4) and sandbox.require is set: network-needing commands are refused`;
  else if (sel.kind === 'landlock') summary = `sandbox: landlock (${ro}; ${landlockSummary(ll!, net, sb.landlock?.maxAbi, sb.unixSockets ?? 'deny')})`;
  else if (sel.kind !== 'none') summary = `sandbox: ${sel.kind} (${ro}, protected paths read-only; network ${net === 'proxy' ? `via proxy to ${sb.allowDomains.length} allowed hosts` : net === 'none' ? 'off' : 'unrestricted'}; credential stores unreadable)`;
  else if (refusing) summary = `sandbox: REQUIRED but unavailable (${sel.unavailable ?? 'the runner is none'}): commands are refused`;
  else summary = `sandbox: off: commands run UNSANDBOXED${sel.unavailable ? ` (${sel.unavailable})` : ''}`;
  const processLifetime = sel.kind === 'bwrap' || sel.kind === 'landlock' ? 'sandbox' : sel.kind === 'none' && !refusing && processLifetimeEnforced(cfg) ? 'bwrap' : 'none';
  if (processLifetime === 'bwrap') summary += '; commands cannot outlive the session (bwrap PID namespace)';
  const denyRead = denyReadPaths({ homeDir: cfg.homeDir, sandbox: sb }).filter((p) => fs.existsSync(p));
  return {
    requested,
    runner: sel.kind,
    network: net,
    allowDomains: sb.allowDomains,
    required: sb.required,
    refusing,
    unavailable: sel.unavailable,
    summary,
    processLifetime,
    denyRead: sel.kind === 'none' || sel.kind === 'docker' || sel.kind === 'podman' ? [] : denyRead,
    landlock: ll ? { ok: ll.ok, abi: ll.abi, reason: ll.reason, summary: landlockSummary(ll, net, sb.landlock?.maxAbi, sb.unixSockets ?? 'deny') } : undefined,
    filesystem: sb.filesystem,
    chain: sel.chain ?? [],
  };
}

export type RunnerKind = 'none' | 'docker' | 'podman' | 'seatbelt' | 'bwrap' | 'landlock';
export type AvailKind = 'seatbelt' | 'bwrap' | 'landlock' | 'docker' | 'podman';
/** Runners that are asked for by name: unavailable means refuse (fail closed), never a silent fallback. */
const EXPLICIT = new Set<string>(['bwrap', 'seatbelt', 'landlock', 'docker', 'podman']);

function onPath(bin: string): boolean {
  if (process.platform === 'win32') return false;
  const r = spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
  return r.status === 0;
}

const availCache = new Map<string, boolean>();
/** Is this runner usable on this machine? (cached; bwrap and Landlock are smoke-tested because user namespaces or the LSM may be off) */
export function runnerAvailable(kind: AvailKind): boolean {
  if (availCache.has(kind)) return availCache.get(kind)!;
  let ok = false;
  if (kind === 'seatbelt') ok = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
  else if (kind === 'landlock') ok = landlockProbe().ok;
  else if (kind === 'docker' || kind === 'podman') ok = onPath(kind) && spawnSync(kind, ['version'], { stdio: 'ignore', timeout: 10_000 }).status === 0;
  else if (process.platform === 'linux' && onPath('bwrap')) ok = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--die-with-parent', '--', '/bin/true'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  availCache.set(kind, ok);
  return ok;
}

/** Which runner to use for this config, and why not the requested one if it is unavailable. */
/** Where the macOS device check (C2 AC3, scripts/device-checks/sandbox-macos.sh) records a pass. */
export function seatbeltPassMarker(cfg: HarnessConfig): string {
  return path.join(cfg.homeDir, 'device-checks', 'sandbox-macos.pass');
}

/**
 * N30 AC3: `auto` uses Seatbelt only once it is verified on this Mac, by the recorded device-check
 * pass or by `sandbox.macosSeatbelt: true`. An explicit `shell.sandbox: "seatbelt"` is always honoured.
 */
export function seatbeltVerified(cfg: HarnessConfig): boolean {
  if ((cfg.sandbox as { macosSeatbelt?: boolean } | undefined)?.macosSeatbelt === true) return true;
  return fs.existsSync(seatbeltPassMarker(cfg)) || fs.existsSync(path.join(os.homedir(), '.tugline', 'device-checks', 'sandbox-macos.pass'));
}

export function selectRunner(cfg: HarnessConfig, avail: (k: AvailKind) => boolean = runnerAvailable, platform: NodeJS.Platform = process.platform): { kind: RunnerKind; unavailable?: string; chain?: string[] } {
  const want = requestedRunner(cfg);
  if (want === 'none') return { kind: 'none', chain: ['sandbox runner is "none" (the user turned the sandbox off)'] };
  // docker per command was always taken at its word (tools/shell.ts runs it; a missing daemon fails the command)
  if (want === 'docker') return { kind: 'docker' };
  if (want === 'podman') return avail('podman') ? { kind: 'podman' } : { kind: 'none', unavailable: 'podman is not installed or cannot run (podman version failed)' };
  if (want === 'auto') {
    const chain: string[] = [];
    if (platform === 'darwin' && avail('seatbelt')) {
      if (seatbeltVerified(cfg)) return { kind: 'seatbelt', chain: ['seatbelt: available and verified'] };
      const why = `Seatbelt is not yet verified on this Mac (run scripts/device-checks/sandbox-macos.sh, which records a pass in ${seatbeltPassMarker(cfg)}, or set sandbox.macosSeatbelt: true)`;
      return { kind: 'none', unavailable: why, chain: [`seatbelt: ${why}`] };
    }
    if (platform === 'linux') {
      // N36 fallback chain: bwrap → landlock → policy-only
      if (avail('bwrap')) return { kind: 'bwrap', chain: ['bwrap: available'] };
      chain.push(`bwrap: ${onPath('bwrap') ? 'installed but cannot create a sandbox (user namespaces disabled?)' : 'not installed'}`);
      if (avail('landlock')) return { kind: 'landlock', chain: [...chain, `landlock: available (ABI ${landlockProbe().abi})`] };
      chain.push(`landlock: ${landlockProbe().reason ?? 'not available'}`);
      return { kind: 'none', unavailable: `no OS sandbox available on linux (${chain.join('; ')}; install bubblewrap)`, chain };
    }
    return { kind: 'none', unavailable: `no OS sandbox available on ${platform}`, chain: [`no OS sandbox on ${platform}`] };
  }
  if (want === 'bwrap' || want === 'seatbelt') return avail(want) ? { kind: want } : { kind: 'none', unavailable: `${want} is not available on this machine` };
  if (want === 'landlock') {
    if (platform !== 'linux') return { kind: 'none', unavailable: `Landlock is Linux-only (this is ${platform})` };
    return avail('landlock') ? { kind: 'landlock', chain: [`landlock: forced (ABI ${landlockProbe().abi})`] } : { kind: 'none', unavailable: `Landlock is not available here: ${landlockProbe().reason ?? 'probe failed'}` };
  }
  return { kind: 'none', unavailable: `unknown sandbox runner "${String(want)}"` };
}

export function expandHome(p: string): string {
  return p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function realOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function networkMode(sb: SandboxConfig): 'none' | 'proxy' | 'host' {
  if (sb.network === 'auto') return sb.allowDomains.length ? 'proxy' : 'none';
  return sb.network;
}

function writableDirs(cfg: HarnessConfig, sb: SandboxConfig): string[] {
  const dirs = [...sb.allowWrite.map(expandHome), ...cfg.permissions.additionalDirectories];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

// ------------------------------------------------------------ bwrap

export const BRIDGE_PORT = 3128;
/** In-sandbox bridge: 127.0.0.1:PORT → the proxy's unix socket, then exec the command. */
export const BRIDGE_JS = `const net=require('net'),cp=require('child_process');const [sock,port,file,...args]=process.argv.slice(1);
const srv=net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());});
srv.listen(Number(port),'127.0.0.1',()=>{const ch=cp.spawn(file,args,{stdio:'inherit'});
for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>ch.kill(s));
ch.on('error',e=>{process.stderr.write('sandbox: '+e.message+'\\n');process.exit(127);});
ch.on('exit',(code,sig)=>process.exit(code==null?128+((require('os').constants.signals||{})[sig]||9):code));});
srv.on('error',e=>{process.stderr.write('sandbox bridge: '+e.message+'\\n');process.exit(126);});`;

export interface HardenedBaseOptions {
  workspace: string;
  /** extra writable directories (bound if they exist) */
  writable?: string[];
  filesystem?: 'workspace-write' | 'read-only';
  /** credential stores to hide (already split around the workspace; see maskedPaths) */
  denyRead?: string[];
  /** hide the runtime socket directories (default true; false only with sandbox.unixSockets: "allow") */
  hideSockets?: boolean;
  /** keep the host's resolver configuration visible (network "host") */
  keepResolver?: boolean;
}

/** Files under /run that must stay readable when /run is hidden (the resolver configuration /etc/resolv.conf points at). */
function resolverFiles(): string[] {
  const out: string[] = [];
  try {
    const t = fs.realpathSync('/etc/resolv.conf');
    if (runtimeSocketDirs().some((d) => within(t, d))) out.push(t);
  } catch {
    /* none */
  }
  return out;
}

/**
 * The hardened bwrap base every sandbox in the harness shares (S1): the C2/N36 command sandbox, and child sandboxes
 * (WS17's goal verifier and external team members) through `childSandboxArgs`.
 *   - the root read-only, a private /dev, /proc and /tmp;
 *   - the workspace (read-write unless filesystem is read-only) and the writable caches;
 *   - credential stores hidden (empty read-only tmpfs over a directory, /dev/null over a file);
 *   - WS17 review F2: the runtime socket directories (/run, /var/run, $XDG_RUNTIME_DIR, LXD) hidden behind an empty
 *     tmpfs, so no host daemon socket (Docker, containerd, Podman …) can be connected to; only the resolver
 *     configuration is bound back, read-only, when the command has host networking.
 * Network namespace and the command are added by the caller.
 */
export function hardenedBwrapBase(o: HardenedBaseOptions): string[] {
  const a = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  if (o.hideSockets !== false) {
    const hidden: string[] = [];
    for (const d of runtimeSocketDirs()) {
      // $XDG_RUNTIME_DIR is usually /run/user/<uid>: already hidden by the empty /run, and bwrap cannot create
      // its mount point inside the read-only tmpfs (every command failed on desktops and CI: "Can't mkdir
      // parents for /run/user/1001: Read-only file system")
      if (hidden.some((h) => within(d, h))) continue;
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(d);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) continue; // /var/run → /run is covered by /run
      if (within(o.workspace, d)) continue; // never hide the workspace itself
      a.push('--tmpfs', d, '--remount-ro', d);
      hidden.push(d);
    }
    if (o.keepResolver) for (const f of resolverFiles()) a.push('--ro-bind', f, f);
  }
  for (const d of o.writable ?? []) a.push('--bind-try', d, d);
  a.push(o.filesystem === 'read-only' ? '--ro-bind' : '--bind', o.workspace, o.workspace);
  // N36: credential stores are hidden after the workspace and writable binds, so a workspace that contains one (the
  // home directory as workspace) cannot re-expose it; maskedPaths already split any store that contains the workspace.
  for (const d of o.denyRead ?? []) {
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(d);
    } catch {
      continue;
    }
    if (st.isDirectory()) a.push('--tmpfs', d, '--remount-ro', d);
    else a.push('--ro-bind', '/dev/null', d);
  }
  return a;
}

/**
 * S1: the one builder for child sandboxes (a verifier, an external team member, a hook): the hardened base for this
 * config (credential stores from sandbox.denyRead, sockets hidden unless sandbox.unixSockets is "allow"), network
 * off unless asked, a PID namespace that dies with the harness, then the command.
 */
export function childSandboxArgs(cfg: HarnessConfig, o: { workspace: string; argv: string[]; network?: 'none' | 'host'; filesystem?: 'workspace-write' | 'read-only'; writable?: string[]; cwd?: string }): string[] {
  const sb = sandboxConfig(cfg);
  const ws = realOr(o.workspace);
  const writable = (o.writable ?? []).filter((w) => fs.existsSync(w));
  const base = hardenedBwrapBase({ workspace: ws, writable, filesystem: o.filesystem ?? 'read-only', denyRead: maskedPaths(cfg, sb, [ws, ...writable]), hideSockets: sb.unixSockets !== 'allow', keepResolver: o.network === 'host' });
  return [...base, ...(o.network === 'host' ? [] : ['--unshare-net']), '--unshare-pid', '--die-with-parent', '--chdir', o.cwd ?? ws, '--', ...o.argv];
}

export function bwrapArgs(spec: SpawnSpec, opts: { workspace: string; writable: string[]; readOnly: string[]; network: 'none' | 'proxy' | 'host'; proxySocket?: string; nodePath?: string; denyRead?: string[]; filesystem?: 'workspace-write' | 'read-only'; unixSockets?: UnixSocketPolicy }): string[] {
  const a = hardenedBwrapBase({ workspace: opts.workspace, writable: opts.writable, filesystem: opts.filesystem, denyRead: opts.denyRead, hideSockets: opts.unixSockets !== 'allow', keepResolver: opts.network === 'host' });
  // Persistence vectors, protected paths and agent-control files stay read-only even inside the writable workspace.
  for (const r of opts.readOnly) {
    let abs = path.resolve(opts.workspace, r);
    // WS24 (N48): in a linked git worktree `.git` is a FILE (gitdir: …), so `.git/hooks` cannot be bound (bwrap fails
    // with ENOTDIR and no command runs); the hooks live in the common git dir, already read-only (outside the
    // workspace). Bind the `.git` file itself read-only instead, so the agent cannot repoint the worktree's gitdir.
    const parent = path.dirname(abs);
    if (parent !== opts.workspace && fs.existsSync(parent) && !fs.statSync(parent).isDirectory()) abs = parent;
    if (!a.includes(abs)) a.push('--ro-bind-try', abs, abs);
  }
  if (opts.network === 'proxy' && opts.proxySocket) a.push('--bind', path.dirname(opts.proxySocket), path.dirname(opts.proxySocket));
  if (opts.network !== 'host') a.push('--unshare-net');
  a.push('--unshare-pid', '--die-with-parent', '--chdir', spec.cwd, '--');
  if (opts.network === 'proxy' && opts.proxySocket) a.push(opts.nodePath ?? process.execPath, '-e', BRIDGE_JS, opts.proxySocket, String(BRIDGE_PORT), spec.file, ...spec.args);
  else a.push(spec.file, ...spec.args);
  return a;
}

// ------------------------------------------------------------ seatbelt

function sbplString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * SBPL profile: read everywhere, write only to the workspace, temp and cache
 * dirs (persistence paths re-denied), network only to the proxy port (or none).
 * In SBPL the last matching rule wins, so the denies after the allows take effect.
 */
/**
 * N36: the base of the "restrictive" Seatbelt profile (sandbox.seatbelt: "restrictive"): deny by default, then
 * reads, process execution, signals to self and the sysctls ordinary programs read.
 * Ported from Qwen Code packages/cli/src/serve/sandbox-macos-restrictive-proxied.sb (c726d2c), Apache-2.0,
 * Copyright 2025 Google LLC / Qwen Team. Modified by Tugline contributors, 2026-10-31: used per command rather
 * than for the whole CLI; the write list is ours (workspace, temp, caches; protected paths re-denied); credential
 * stores are denied for reads (theirs allows every read); no debugger port; network only to our proxy port.
 */
const RESTRICTIVE_BASE = [
  '(deny default)',
  '(allow file-read*)',
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow signal (target self))',
  '(allow mach-lookup (global-name "com.apple.sysmond"))',
  '(allow file-ioctl (regex #"^/dev/tty.*"))',
  '(allow sysctl-read',
  ...['hw.activecpu', 'hw.busfrequency_compat', 'hw.byteorder', 'hw.cacheconfig', 'hw.cachelinesize_compat', 'hw.cpufamily', 'hw.cpufrequency_compat', 'hw.cputype', 'hw.l1dcachesize_compat', 'hw.l1icachesize_compat', 'hw.l2cachesize_compat', 'hw.l3cachesize_compat', 'hw.logicalcpu_max', 'hw.machine', 'hw.ncpu', 'hw.nperflevels', 'hw.optional.arm.FEAT_BF16', 'hw.optional.arm.FEAT_DotProd', 'hw.optional.arm.FEAT_FCMA', 'hw.optional.arm.FEAT_FHM', 'hw.optional.arm.FEAT_FP16', 'hw.optional.arm.FEAT_I8MM', 'hw.optional.arm.FEAT_JSCVT', 'hw.optional.arm.FEAT_LSE', 'hw.optional.arm.FEAT_RDM', 'hw.optional.arm.FEAT_SHA512', 'hw.optional.armv8_2_sha512', 'hw.packages', 'hw.pagesize_compat', 'hw.physicalcpu_max', 'hw.tbfrequency_compat', 'hw.vectorunit', 'kern.hostname', 'kern.maxfilesperproc', 'kern.osproductversion', 'kern.osrelease', 'kern.ostype', 'kern.osvariant_status', 'kern.osversion', 'kern.secure_kernel', 'kern.usrstack64', 'kern.version', 'sysctl.proc_cputype'].map((n) => `  (sysctl-name "${n}")`),
  '  (sysctl-name-prefix "hw.perflevel"))',
];

export function seatbeltProfile(opts: { workspace: string; writable: string[]; readOnly: string[]; network: 'none' | 'proxy' | 'host'; proxyPort?: number; tmpDirs?: string[]; denyRead?: string[]; filesystem?: 'workspace-write' | 'read-only'; style?: 'permissive' | 'restrictive'; unixSockets?: UnixSocketPolicy }): string {
  const ws = realOr(opts.workspace);
  const tmp = [...new Set(['/private/tmp', '/private/var/folders', ...(opts.tmpDirs ?? []).map(realOr)])];
  const restrictive = opts.style === 'restrictive';
  const lines = [
    '(version 1)',
    `; Tugline sandbox profile (generated, SPEC C2${restrictive ? ', N36 restrictive' : ''})`,
    ...(restrictive ? RESTRICTIVE_BASE : ['(allow default)']),
    '(deny file-write*)',
    '(allow file-write*',
    ...(opts.filesystem === 'read-only' ? [] : [`  (subpath ${sbplString(ws)})`]),
    ...tmp.map((t) => `  (subpath ${sbplString(t)})`),
    ...opts.writable.map((d) => `  (subpath ${sbplString(realOr(d))})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))',
  ];
  if (opts.readOnly.length) lines.push(`(deny file-write*\n${opts.readOnly.map((r) => `  (subpath ${sbplString(path.resolve(ws, r))})`).join('\n')})`);
  // N36: credential stores are unreadable (and unwritable), not just read-only
  if (opts.denyRead?.length) lines.push(`(deny file-read* file-write*\n${opts.denyRead.map((d) => `  (subpath ${sbplString(realOr(d))})`).join('\n')})`);
  if (restrictive && opts.network === 'host') lines.push('(allow network*)');
  if (opts.network !== 'host') {
    lines.push('(deny network*)');
    // local servers started by tests (bind/listen on loopback) keep working
    lines.push('(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))');
    if (opts.network === 'proxy' && opts.proxyPort) lines.push(`(allow network-outbound (remote ip ${sbplString(`localhost:${opts.proxyPort}`)}))`);
  }
  // WS17 review F2: host daemon sockets (Docker Desktop's ~/.docker/run/docker.sock behind /var/run/docker.sock,
  // Podman's machine socket, containerd …) are host root: never connectable, in every network mode, last rule wins.
  // With network none/proxy `(deny network*)` already refuses every unix-socket connect; host networking needs the list.
  if (opts.unixSockets !== 'allow') {
    if (opts.network === 'host') lines.push(
      '(deny network-outbound',
      '  (remote unix-socket (path-regex #"/(docker|dockerd|containerd|podman|buildkitd|cri-dockerd|crio|lxd|incus)(\\.sock(et)?)?$"))',
      '  (remote unix-socket (path-regex #"/(docker|containerd|podman|buildkit|lxd|incus)/[^/]*\\.sock(et)?$"))',
      '  (remote unix-socket (path-regex #"^/(private/)?var/run/")))');
    lines.push(
      `(deny file-read* file-write* (regex #"/\\.docker/run/") (regex #"/\\.local/share/containers/podman/machine/") (literal "/var/run/docker.sock") (literal "/private/var/run/docker.sock"))`,
    );
  }
  return lines.join('\n') + '\n';
}

// ------------------------------------------------------------ proxy lifecycle

interface ProxyHandle {
  proxy: DomainProxy;
  socket: string;
}
const proxies = new Map<string, ProxyHandle>();

function upstreamFor(sb: SandboxConfig): { upstream?: string; noProxy: string[] } {
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').filter(Boolean);
  if (sb.upstreamProxy === 'none') return { noProxy };
  if (sb.upstreamProxy !== 'env') return { upstream: sb.upstreamProxy, noProxy };
  const env = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  return { upstream: env && /^https?:\/\//.test(env) ? env.replace(/^https:/, 'http:') : undefined, noProxy };
}

/** The shared allowlist proxy for this config (started synchronously on first use). */
export function proxyFor(cfg: HarnessConfig): ProxyHandle {
  const sb = sandboxConfig(cfg);
  const key = JSON.stringify([sb.allowDomains, sb.upstreamProxy]);
  let h = proxies.get(key);
  if (!h) {
    const { upstream, noProxy } = upstreamFor(sb);
    const proxy = new DomainProxy({ allowDomains: sb.allowDomains, upstream, noProxy });
    // A short path in the real temp dir: unix socket paths are limited to ~104 bytes.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sbx-'));
    const socket = path.join(dir, 'proxy.sock');
    proxy.listenUnix(socket);
    h = { proxy, socket };
    proxies.set(key, h);
  }
  return h;
}

/** Stop all proxies (tests). */
export function closeSandboxProxies(): void {
  for (const h of proxies.values()) {
    h.proxy.close();
    fs.rmSync(path.dirname(h.socket), { recursive: true, force: true });
  }
  proxies.clear();
}

function proxyEnv(env: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) e[k] = url;
  // Everything must go through the proxy: inherited NO_PROXY lists (localhost, intranets) are dropped.
  for (const k of ['NO_PROXY', 'no_proxy', 'npm_config_noproxy', 'GLOBAL_AGENT_NO_PROXY']) delete e[k];
  e.npm_config_proxy = url;
  e.npm_config_https_proxy = url;
  e.TUGLINE_SANDBOX_PROXY = url;
  return e;
}

/** A spec that fails with an explanation (fail closed). */
export function refusingSpec(spec: SpawnSpec, why: string): SpawnSpec {
  const msg = `Tugline: command not run: ${why}. Sandboxing is required (sandbox.require / managed forceSandbox); run \`tug sandbox status\` to see why.`;
  return { ...spec, file: '/bin/sh', args: ['-c', 'printf "%s\\n" "$1" >&2; exit 126', 'oh-sandbox', msg], runner: 'refused' };
}

/** N36: the credential paths to hide for this workspace: existing, real paths, split so the workspace and writable dirs stay visible. */
export function maskedPaths(cfg: HarnessConfig, sb: SandboxConfig, keep: string[]): string[] {
  const keepReal = keep.map(realOr);
  const list = (d: string) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  };
  const isDir = (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const out = new Set<string>();
  for (const d of denyReadPaths({ homeDir: cfg.homeDir, sandbox: sb })) {
    if (!fs.existsSync(d)) continue;
    for (const m of splitAround(realOr(d), keepReal, list, isDir)) out.add(m);
  }
  return [...out];
}

const scratchOf = new WeakMap<object, string>();

/** Build the wrapper for a config (exported for tests). */
export function sandboxWrapper(cfg: HarnessConfig, workspace?: string, avail: (k: AvailKind) => boolean = runnerAvailable): CommandWrap | undefined {
  const sb = sandboxConfig(cfg);
  const sel = selectRunner(cfg, avail);
  if (sel.kind === 'docker' || sel.kind === 'podman') return undefined; // shell.ts runs the container itself
  if (sel.kind === 'none') {
    const explicit = EXPLICIT.has(requestedRunner(cfg));
    if (sel.unavailable && (explicit || sb.required)) return (spec) => refusingSpec(spec, sel.unavailable!);
    if (sb.required) return (spec) => refusingSpec(spec, 'no sandbox selected (the runner is "none")');
    // R1 (B): no filesystem sandbox, but a command still cannot outlive the harness (or leave processes behind).
    // Not inside an eval container: the command then runs in `docker exec` (which may have no bwrap), and the
    // per-run container already bounds what it leaves behind.
    if (processLifetimeEnforced(cfg) && !(cfg as { evalContainer?: unknown }).evalContainer) return (spec) => ({ ...spec, file: 'bwrap', args: lifetimeArgs(spec) });
    return undefined;
  }
  const net = networkMode(sb);
  const writable = writableDirs(cfg, sb);
  return (spec) => {
    const ws = realOr(workspace ?? workspaceOf.get(cfg) ?? spec.cwd);
    // R1 layer 3: protected paths and agent-control files, expanded now (globs match what exists at spawn time).
    const readOnly = [...new Set([...sb.readOnlyPaths, ...readOnlyRoots(ws, protectedSet(guardedGlobs(cfg.permissions.protectedPaths)))])];
    const denyRead = maskedPaths(cfg, sb, [ws, spec.cwd, ...writable.filter((w) => fs.existsSync(w))]);
    if (sel.kind === 'bwrap') {
      const socket = net === 'proxy' ? proxyFor(cfg).socket : undefined;
      const env = socket ? proxyEnv(spec.env, `http://127.0.0.1:${BRIDGE_PORT}`) : spec.env;
      return { ...spec, file: 'bwrap', args: bwrapArgs(spec, { workspace: ws, writable, readOnly, network: net, proxySocket: socket, denyRead, filesystem: sb.filesystem, unixSockets: sb.unixSockets }), env, runner: 'bwrap' };
    }
    if (sel.kind === 'landlock') {
      const abi = Math.min(landlockProbe().abi, sb.landlock?.maxAbi ?? 99);
      if (abi < LANDLOCK_MIN_ABI) return refusingSpec(spec, `Landlock ABI ${abi} is below ${LANDLOCK_MIN_ABI}: truncate(2) is not controlled (Linux 6.2+ needed)`);
      const port = net === 'proxy' ? proxyFor(cfg).proxy.listenTcpSync() : undefined;
      const env = port ? proxyEnv(spec.env, `http://127.0.0.1:${port}`) : spec.env;
      let scratch = scratchOf.get(cfg);
      if (!scratch || !fs.existsSync(scratch)) scratchOf.set(cfg, (scratch = makeScratch()));
      // a PTY run: the helper allocates the terminal itself before it confines (no /dev/pts grant)
      const inner = spec.ptyInner ? { ...spec, file: spec.ptyInner.file, args: spec.ptyInner.args, ptyInner: undefined } : spec;
      return landlockSpec({ ...inner, env, runner: 'landlock' }, { pty: !!spec.ptyInner, workspace: ws, writable: writable.filter((w) => fs.existsSync(w)), denyRead, filesystem: sb.filesystem, network: net, proxyPort: port, scratch, maxAbi: sb.landlock?.maxAbi, requireNetwork: sb.required, unixSockets: sb.unixSockets ?? 'deny' });
    }
    const port = net === 'proxy' ? proxyFor(cfg).proxy.listenTcpSync() : undefined;
    const env = port ? proxyEnv(spec.env, `http://127.0.0.1:${port}`) : spec.env;
    const profile = seatbeltProfile({ workspace: ws, writable, readOnly, network: net, proxyPort: port, tmpDirs: [os.tmpdir()], denyRead, filesystem: sb.filesystem, style: sb.seatbelt, unixSockets: sb.unixSockets });
    return { ...spec, file: '/usr/bin/sandbox-exec', args: ['-p', profile, spec.file, ...spec.args], env, runner: 'seatbelt' };
  };
}

registerCommandWrapper('ws3-sandbox', (cfg) => sandboxWrapper(cfg));
// re-check RC-2: the project clamp compares with the runner "auto" really selects here
setEffectiveRunnerHook((cfg) => selectRunner(cfg).kind as RunnerName);
// R1 guard (git config tier, review H2): agent commands cannot write .git/config when they run in an OS sandbox that
// mounts it read-only, so an edit seen while nothing runs is the user's own
setGitConfigSandboxedHook((cfg) => {
  try {
    const st = sandboxStatus(cfg);
    // only runners that mount read-only in the kernel: Landlock cannot make a path read-only beneath a writable
    // directory (landlock.ts), and on ABI < 6 a command can kill its helper and leave detached children (review)
    return ['bwrap', 'seatbelt', 'docker', 'podman'].includes(st.runner) && !st.refusing && sandboxConfig(cfg).readOnlyPaths.some((p) => p === '.git/config' || p === '.git');
  } catch {
    return false;
  }
});
// N36 review finding 12: what a config's commands should run under, to compare with what the spawn really used
const expectedCache = new WeakMap<object, { runner: string; refusing: boolean }>();
setExpectedRunnerHook((cfg) => {
  let e = expectedCache.get(cfg);
  if (!e) {
    const st = sandboxStatus(cfg);
    expectedCache.set(cfg, (e = { runner: st.runner, refusing: st.refusing }));
  }
  return e;
});
// N36: per-command containers keep protected paths read-only too
setContainerReadOnlyHook((cfg, root) => {
  const sb = sandboxConfig(cfg);
  const ws = realOr(root);
  const rel = [...sb.readOnlyPaths.map((r) => path.resolve(ws, r)).filter((p) => fs.existsSync(p)), ...readOnlyRoots(ws, protectedSet(guardedGlobs(cfg.permissions.protectedPaths)))];
  return { readOnly: [...new Set(rel)], readOnlyWorkspace: sb.filesystem === 'read-only' };
});

// ------------------------------------------------------------ agent extension

const warned = new WeakSet<object>();
/** The workspace a config's commands run for (the wrapper only sees the spawn spec, whose cwd may be a subdirectory). */
const workspaceOf = new WeakMap<object, string>();
const shellStart = new WeakMap<object, number>();

/** Proxy decisions since `since` for this config (blocked hosts are reported back to the model). */
export function blockedSince(cfg: HarnessConfig, since: number): ProxyLogEntry[] {
  const sb = sandboxConfig(cfg);
  const h = proxies.get(JSON.stringify([sb.allowDomains, sb.upstreamProxy]));
  return h ? h.proxy.log.filter((l) => !l.allowed && l.ts >= since) : [];
}

registerAgentExtension({
  id: 'ws3-sandbox',
  onRunStart(a) {
    // N36 SAC1: project settings that would have loosened the sandbox were ignored; say so on every surface, once per run
    const clamped = a.depth === 0 ? (a.config.trust?.clamped ?? []) : [];
    if (clamped.length) {
      a.notice('warn', `project config ignored (it cannot loosen sandbox, network or approval settings): ${clamped.join('; ')}. To allow it for this workspace, run \`tug sandbox trust-project\` (user scope).`);
      for (const c of clamped) recordSecurityEvent(a, { type: 'policy_violation', category: 'project_config', decision: 'override', by: 'config', reason: c });
    }
    const want = requestedRunner(a.config);
    if (want === 'none' || want === 'docker' || warned.has(a.config)) return;
    const sel = selectRunner(a.config);
    warned.add(a.config);
    if (sel.unavailable) {
      const failClosed = want !== 'auto' || sandboxConfig(a.config).required;
      a.notice('warn', `sandbox: ${sel.unavailable}; ${failClosed ? 'commands will be refused' : 'commands run UNSANDBOXED'}`);
    } else if (a.depth === 0) {
      // N30 first-run notice: what the default sandbox allows, and the opt-out.
      const st = sandboxStatus(a.config);
      a.notice('info', `${st.summary}.${st.network !== 'host' ? ' Set sandbox.network: "host" to give commands unrestricted network access, or add hosts to sandbox.allowDomains.' : ''}`);
    }
  },
  async onSessionEnd(a) {
    // R1 (B): a session's background jobs end with it, `persist: true` included, unless shell.processLifetime is 'off'.
    if (a.depth !== 0 || a.config.shell.processLifetime === 'off') return;
    const { killJob, listJobs } = await import('../jobs/manager.js');
    const left = listJobs(a.sessionId).filter((j) => j.status === 'running');
    await Promise.all(left.map((j) => killJob(j).catch(() => false)));
    if (left.length) a.journal({ type: 'jobs_ended_with_session', jobs: left.map((j) => j.id) });
  },
  beforeShell(a) {
    workspaceOf.set(a.config, a.workspace);
    shellStart.set(a.agent as object, Date.now());
  },
  afterTool(a, call) {
    if (call.tool !== 'bash') return;
    const since = shellStart.get(a.agent as object);
    if (since === undefined) return;
    const blocked = [...new Set(blockedSince(a.config, since).map((b) => `${b.host} (${b.reason})`))];
    if (blocked.length) recordSecurityEvent(a, { type: 'sandbox', category: 'network', decision: 'block', by: 'sandbox', reason: `network access blocked: ${blocked.join(', ')}`, tool: call.tool });
    if (blocked.length) return `[sandbox] network access blocked: ${blocked.join(', ')}. Only sandbox.allowDomains are reachable; ask the user if one of these is needed.`;
  },
});
