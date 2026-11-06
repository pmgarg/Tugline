/**
 * N36: sandbox settings shared by the runners, the shell tool and the config loader.
 * No runtime imports (shell.ts and config.ts import this; the runners import them).
 *
 * Keys (all under `sandbox`, user or managed scope; a project can only tighten them, see config.ts):
 *   runner      auto | bwrap | landlock | seatbelt | docker | podman | none   (alias of shell.sandbox; `mode` is accepted too)
 *   require     true = never run a model command unsandboxed (alias of required / shell.requireSandbox)
 *   session     host | container      (whole-session container mode, `tug --container`)
 *   filesystem  workspace-write | read-only
 *   denyRead    credential paths unreadable inside every runner (~ = the user's home); adds to the defaults at every scope
 *   allowRead   default credential paths the USER lets commands read (user/managed scope only; projects cannot set it)
 */
import os from 'node:os';
import path from 'node:path';

export type RunnerName = 'auto' | 'bwrap' | 'landlock' | 'seatbelt' | 'docker' | 'podman' | 'none';
export const RUNNERS: RunnerName[] = ['auto', 'bwrap', 'landlock', 'seatbelt', 'docker', 'podman', 'none'];

/** Strictness for scope checks: a later (project) layer may only move up this order. `auto` sits with the OS sandboxes. */
export const RUNNER_RANK: Record<RunnerName, number> = { none: 0, auto: 1, landlock: 1, bwrap: 1, seatbelt: 1, docker: 2, podman: 2 };

/**
 * Credential stores denied for READS inside the sandbox (N36 bar 2), relative to the home directory.
 * The sandbox bounds what a command can read here, not only what it can write: a model told by a web page
 * to `cat ~/.ssh/id_ed25519` gets "No such file" (bwrap, Landlock) or "Operation not permitted" (Seatbelt).
 */
export const DEFAULT_DENY_READ = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.config/hub',
  '~/.config/op',
  '~/.config/git/credentials',
  '~/.git-credentials',
  '~/.docker',
  '~/.kube',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.gem/credentials',
  '~/.cargo/credentials',
  '~/.cargo/credentials.toml',
  '~/.terraform.d/credentials.tfrc.json',
  '~/.vault-token',
  '~/.password-store',
  '~/.local/share/keyrings',
  '~/Library/Keychains',
  // the harness's own home: vault, journals, config with endpoint keys
  '~/.tugline',
];

/** The runner the config asks for: sandbox.runner, else sandbox.mode, else shell.sandbox. */
export function requestedRunner(cfg: { shell: { sandbox?: string }; sandbox?: { runner?: string; mode?: string } }): RunnerName {
  const v = cfg.sandbox?.runner ?? cfg.sandbox?.mode ?? cfg.shell.sandbox ?? 'none';
  return v as RunnerName;
}

/** Is a sandbox required for this config (any of the three spellings)? */
export function sandboxRequired(cfg: { shell: { requireSandbox?: boolean }; sandbox?: { require?: boolean; required?: boolean } }): boolean {
  return cfg.sandbox?.require === true || cfg.sandbox?.required === true || cfg.shell.requireSandbox === true;
}

export function expandTilde(p: string, home = os.homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

/**
 * The absolute credential paths for a config: the default list, PLUS sandbox.denyRead (it only ever adds, at every
 * scope; review finding 1: a project list used to replace the defaults), MINUS sandbox.allowRead (user or managed
 * scope only: the config loader drops it from project layers), plus the harness home (never removable).
 */
export function denyReadPaths(cfg: { homeDir: string; sandbox?: { denyRead?: unknown; allowRead?: unknown } }, home = os.homedir()): string[] {
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);
  const abs = (p: string) => path.resolve(expandTilde(p, home));
  const allow = new Set(strs(cfg.sandbox?.allowRead).map(abs));
  const list = [...DEFAULT_DENY_READ, ...strs(cfg.sandbox?.denyRead)].map(abs).filter((p) => !allow.has(p));
  return [...new Set([...list, path.resolve(cfg.homeDir)])];
}

/** Is `child` equal to or inside `parent`? */
export function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The paths to hide so that everything under `denied` is unreadable except the `keep` paths (the workspace, writable
 * dirs) that lie inside it: a denied directory holding the workspace is split into its other children, recursively.
 * `list` and `isDir` are injectable for tests.
 */
export function splitAround(denied: string, keep: string[], list: (d: string) => string[], isDir: (p: string) => boolean, depth = 0): string[] {
  const inside = keep.filter((k) => within(k, denied));
  if (!inside.length) return [denied];
  if (inside.some((k) => k === denied) || depth > 12 || !isDir(denied)) return [];
  const out: string[] = [];
  for (const name of list(denied)) {
    const c = path.join(denied, name);
    out.push(...splitAround(c, inside, list, isDir, depth + 1));
  }
  return out;
}

/**
 * WS17 review F2 (High): unix sockets of container runtimes and system daemons (Docker, containerd, Podman, LXD,
 * buildkit) are host root: a sandboxed command that can connect to one can start a privileged container with the
 * host's network and `/` mounted. Network namespaces and Landlock's filesystem rules do not stop a connect() to a
 * pathname socket, and a read-only bind does not either. These directories hold them; every runner hides them.
 */
export function runtimeSocketDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = ['/run', '/var/run', '/var/snap/lxd/common/lxd', '/var/lib/lxd'];
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR)) out.push(env.XDG_RUNTIME_DIR);
  return [...new Set(out.map((p) => path.resolve(p)))];
}

/** Socket names that are host root (or a daemon with the same power), wherever they live. */
export const DAEMON_SOCKET = /(?:^|\/)(?:docker|dockerd|containerd|podman|buildkitd|cri-dockerd|crio|lxd|incus|snapd)\.sock(?:et)?$|(?:^|\/)(?:docker|containerd|podman|buildkit|lxd|incus|libvirt)\/[^/\s]*\.sock(?:et)?$|(?:^|\/)libvirt-sock(?:-ro)?$|(?:^|\/)lxd\/unix\.socket$/;

/** Clients that drive a container runtime or VM daemon: what they reach is host root (rootful) or the user's whole account. */
export const DAEMON_CLIENT = /^(?:docker|podman|nerdctl|ctr|crictl|lxc|incus|virsh|buildctl|kubectl-debug)$/;

/** Unix-socket policy for runners that cannot hide a path (Landlock): "deny" closes socket(AF_UNIX) (default). */
export type UnixSocketPolicy = 'deny' | 'allow';

/**
 * Re-check RC-3: what commands cannot do under Landlock (no namespaces, so no private /dev/shm can be given, and
 * unix-socket creation stays refused because that is what keeps the Docker socket shut). Shown by `tug sandbox status`
 * and appended to a failing command's output when it looks like one of these.
 */
export const LANDLOCK_LIMITS = 'no /dev/shm and no unix sockets, so Python multiprocessing (Lock, Pool, ProcessPoolExecutor, Manager; pytest-xdist, joblib) and other POSIX shared-memory or semaphore users fail with "Permission denied": run them under bwrap (install bubblewrap) or a docker/podman runner';
export const LANDLOCK_LIMIT_HINT = /\/dev\/shm|SemLock|sem_open|multiprocessing|ProcessPoolExecutor|shm_open/;
