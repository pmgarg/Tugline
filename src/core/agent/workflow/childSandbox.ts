/**
 * v1.2 F2/F10: the bwrap root for child sandboxes (the goal verifier's commands, external agent members), built
 * from an ALLOWLIST instead of `--ro-bind / /`.
 *
 * Only system directories are visible (read-only): /usr, /bin, /sbin, /lib*, /etc, /opt and the Node install the
 * harness runs on, plus what the caller lists. `/run`, `/var/run`, `/var`, `$XDG_RUNTIME_DIR`, `/tmp` and `$HOME`
 * are fresh tmpfs mounts, so host unix sockets (the Docker daemon, ssh-agent, D-Bus, X11) and the user's files
 * (credentials, other repositories, the harness config with its keys) are not there at all: a read-only bind does
 * not stop `connect()` on a socket, absence does. Writable paths are only those the caller passes.
 *
 * S1 note: at merge this builder moves into `src/core/sandbox/index.ts` as the single child-sandbox base (WS18 is
 * fixing the same `--ro-bind / /` base in the main sandbox); callers pass a `ChildSandbox` description, so the
 * switch is one import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ChildSandbox {
  /** directories (or files) visible read-only, besides the system allowlist */
  readOnly?: string[];
  /** directories visible read-write */
  writable?: string[];
  /** paths re-bound read-only after the writable ones (e.g. a worktree's `.git` file) */
  readOnlyOver?: string[];
  /** files replaced by an empty file inside (secrets in a bound directory: `.env`, keys) */
  hide?: string[];
  /** 'none' (default): no network at all; 'bridge': only a unix socket, bridged inside by the caller's command */
  network?: 'none' | 'bridge';
  cwd: string;
  /** program and arguments to run inside */
  argv: string[];
  /** the real home directory (hidden by a tmpfs); default os.homedir() */
  home?: string;
  /** HOME inside the sandbox (default: the empty tmpfs home) */
  envHome?: string;
}

const SYSTEM = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/opt'];

/** The directory tree the running Node lives in (e.g. /opt/node22, ~/.nvm/versions/node/v22): needed to run node inside. */
function nodePrefix(): string {
  return path.dirname(path.dirname(fs.realpathSync(process.execPath)));
}

export function childBwrapArgs(o: ChildSandbox): string[] {
  const home = o.home ?? os.homedir();
  const a: string[] = ['--die-with-parent', '--new-session', '--unshare-all'];
  for (const d of SYSTEM) if (fs.existsSync(d)) a.push(fs.lstatSync(d).isSymbolicLink() ? '--symlink' : '--ro-bind', ...(fs.lstatSync(d).isSymbolicLink() ? [fs.readlinkSync(d), d] : [d, d]));
  a.push('--dev', '/dev', '--proc', '/proc');
  // fresh, empty: no host sockets, no user files
  const runtime = process.env.XDG_RUNTIME_DIR;
  for (const t of ['/tmp', '/run', '/var', ...(runtime ? [runtime] : []), ...(home && home !== '/' ? [home] : [])]) a.push('--tmpfs', t);
  a.push('--dir', '/var/run', '--dir', '/var/tmp');
  const prefix = nodePrefix();
  if (!SYSTEM.some((d) => prefix === d || prefix.startsWith(d + '/'))) a.push('--ro-bind', prefix, prefix);
  for (const r of o.readOnly ?? []) if (fs.existsSync(r)) a.push('--ro-bind', r, r);
  for (const w of o.writable ?? []) if (fs.existsSync(w)) a.push('--bind', w, w);
  for (const r of o.readOnlyOver ?? []) if (fs.existsSync(r)) a.push('--ro-bind', r, r);
  for (const h of o.hide ?? []) if (fs.existsSync(h)) a.push(fs.statSync(h).isDirectory() ? '--tmpfs' : '--ro-bind', ...(fs.statSync(h).isDirectory() ? [h] : ['/dev/null', h]));
  if (o.network === 'bridge') {
    // --unshare-all already removed the network; the caller's argv bridges one socket inside
  }
  a.push('--setenv', 'HOME', o.envHome ?? (home && home !== '/' ? home : '/tmp'), '--chdir', o.cwd, '--', ...o.argv);
  return a;
}
