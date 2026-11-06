/**
 * Remote and background agents (SPEC H5, moved to WS7).
 *
 * Server side (`remote/run`): clone the repository (URL + branch) into a fresh
 * server-side workspace, run the prompt in an ordinary server session (events,
 * permission requests and questions stream to the calling client), then return
 * the run's changes as a binary git patch against the cloned commit. The clone
 * is deleted afterwards unless `keep` is set.
 *
 * Client side (`tug remote run`): send the local repository's origin URL and
 * branch, answer permission prompts at the terminal, show the diffstat, and
 * apply the patch to the local checkout only after confirmation.
 *
 * Off by default (`server.remote.enabled`, or `tug serve --remote`). Local paths
 * and file:// URLs are refused unless `server.remote.allowLocalRepos`. The clone
 * is untrusted (its .tugline config can only restrict), git runs without
 * hooks, prompts or submodules, and the session's permission engine decides
 * every tool call as usual.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitClone, hardenedGitEnv, HARDENED_GIT_FLAGS } from '../core/plugins/store.js';
import { ERR, RpcError } from './rpc.js';
import type { ClientConn, SessionHost } from './sessions.js';
import type { RemoteResult, RemoteRunParams } from './protocol.js';
import { OhClient, type ClientHandlers } from './client.js';

const execFileP = promisify(execFile);
/** Server-side clones and the client's apply both ignore global/system git config (see hardenedGitEnv). */
const GIT_ENV = hardenedGitEnv();

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  if (input === undefined) {
    const { stdout } = await execFileP('git', [...HARDENED_GIT_FLAGS, ...args], { cwd, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
    return stdout;
  }
  return new Promise<string>((resolve, reject) => {
    const p = execFile('git', [...HARDENED_GIT_FLAGS, ...args], { cwd, env: GIT_ENV, maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
    p.stdin?.end(input);
  });
}

export function isLocalRepo(repo: string): boolean {
  return repo.startsWith('file://') || repo.startsWith('/') || repo.startsWith('.') || /^[A-Za-z]:[\\/]/.test(repo) || (!/^[\w+.-]+:\/\//.test(repo) && !/^[\w.-]+@[\w.-]+:/.test(repo));
}

function checkRepo(repo: unknown, allowLocal: boolean): string {
  if (typeof repo !== 'string' || !repo.trim() || repo.startsWith('-')) throw new RpcError(ERR.INVALID_PARAMS, 'repo (a git URL) is required');
  const r = repo.trim();
  if (isLocalRepo(r)) {
    if (!allowLocal) throw new RpcError(ERR.FORBIDDEN, 'local repositories are not allowed on this server (server.remote.allowLocalRepos)');
    return r;
  }
  if (!/^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(r)) throw new RpcError(ERR.INVALID_PARAMS, `unsupported repository URL scheme: ${r}`);
  return r;
}

/** Harness files and interpreter/build caches never belong in the returned patch. */
const EXCLUDE = [':(exclude).tugline', ':(exclude,glob)**/__pycache__/**', ':(exclude,glob)**/*.pyc', ':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.DS_Store'];

/** Server handler for remote/run. */
export async function remoteRun(host: SessionHost, conn: ClientConn, p: Partial<RemoteRunParams>): Promise<RemoteResult> {
  const rs = host.settings.remote;
  if (!rs?.enabled) throw new RpcError(ERR.FORBIDDEN, 'remote runs are disabled on this server (enable with `tug serve --remote` or server.remote.enabled)');
  const repo = checkRepo(p.repo, !!rs.allowLocalRepos);
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new RpcError(ERR.INVALID_PARAMS, 'prompt is required');
  if (p.branch !== undefined && (typeof p.branch !== 'string' || !/^[\w./-]+$/.test(p.branch) || p.branch.startsWith('-'))) throw new RpcError(ERR.INVALID_PARAMS, 'invalid branch name');
  const root = rs.workRoot ?? path.join(host.opts.config.homeDir, 'remote-workspaces');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const runDir = fs.mkdtempSync(path.join(root, 'run-'));
  const ws = path.join(runDir, 'repo');
  let sessionId: string | undefined;
  try {
    let base: string;
    try {
      base = await gitClone(repo, ws, p.branch);
    } catch (e) {
      throw new RpcError(ERR.INVALID_PARAMS, `could not clone ${repo}${p.branch ? ` (${p.branch})` : ''}: ${(e as Error).message.split('\n').slice(-3).join(' ')}`);
    }
    host.internalOk.add(ws);
    const s = await host.create(conn, { workspace: ws, mode: p.mode ?? rs.mode ?? 'acceptEdits', profile: p.profile, internalWorkspace: true });
    sessionId = s.id;
    const summary = await host.prompt(s, p.prompt);
    await git(ws, ['add', '-A', '--', '.', ...EXCLUDE]);
    const patch = await git(ws, ['diff', '--cached', '--binary', base, '--', '.', ...EXCLUDE]);
    const stat = await git(ws, ['diff', '--cached', '--stat', base, '--', '.', ...EXCLUDE]);
    const files = (await git(ws, ['diff', '--cached', '--name-only', base, '--', '.', ...EXCLUDE])).split('\n').filter(Boolean);
    return { ...summary, sessionId: s.id, repo, branch: p.branch, base, patch, stat, files };
  } finally {
    if (sessionId) await host.remove(sessionId).catch(() => undefined);
    host.internalOk.delete(ws);
    if (!p.keep) fs.rmSync(runDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ client side

export interface RemoteClientOptions {
  server: string;
  token: string;
  prompt: string;
  /** Local checkout the patch is applied to (default cwd). */
  cwd: string;
  repo?: string;
  branch?: string;
  mode?: string;
  /** 'yes' applies without asking, 'no' never applies, 'ask' uses confirm(). */
  apply: 'ask' | 'yes' | 'no';
  confirm?: (question: string) => Promise<boolean>;
  handlers?: ClientHandlers;
  log?: (s: string) => void;
  /** Save the patch here as well. */
  patchFile?: string;
}

export interface RemoteClientResult {
  result: RemoteResult;
  applied: boolean;
  reason?: string;
}

export async function localRepoInfo(cwd: string): Promise<{ repo?: string; branch?: string; head?: string }> {
  const out: { repo?: string; branch?: string; head?: string } = {};
  try {
    out.repo = (await git(cwd, ['remote', 'get-url', 'origin'])).trim() || undefined;
  } catch {
    /* no origin */
  }
  try {
    const b = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (b && b !== 'HEAD') out.branch = b;
    out.head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  } catch {
    /* not a repo */
  }
  return out;
}

export async function runRemoteClient(o: RemoteClientOptions): Promise<RemoteClientResult> {
  const log = o.log ?? (() => undefined);
  const local = await localRepoInfo(o.cwd);
  const repo = o.repo ?? local.repo;
  if (!repo) throw new Error('no repository: pass --repo <git-url> or run inside a checkout with an "origin" remote');
  const client = await OhClient.connect(o.server, o.token, o.handlers ?? {});
  let result: RemoteResult;
  try {
    log(`remote run on ${o.server}: ${repo}${(o.branch ?? local.branch) ? ` (${o.branch ?? local.branch})` : ''}`);
    result = await client.remoteRun({ repo, branch: o.branch ?? local.branch, prompt: o.prompt, mode: o.mode as any });
  } finally {
    client.close();
  }
  log(`remote run finished: ${result.stopReason}${result.finalText ? `\n${result.finalText}` : ''}`);
  if (o.patchFile) fs.writeFileSync(o.patchFile, result.patch);
  if (!result.patch.trim()) return { result, applied: false, reason: 'no changes' };
  log(`changes (base ${result.base.slice(0, 12)}):\n${result.stat.trimEnd()}`);
  if (o.apply === 'no') return { result, applied: false, reason: 'not applied (--no-apply)' };
  if (local.head && local.head !== result.base) log(`note: your checkout is at ${local.head.slice(0, 12)}, the patch was made against ${result.base.slice(0, 12)}`);
  try {
    await git(o.cwd, ['apply', '--check', '--binary', '-'], result.patch);
  } catch (e) {
    return { result, applied: false, reason: `patch does not apply cleanly: ${(e as Error).message.trim()}` };
  }
  const ok = o.apply === 'yes' || (o.confirm ? await o.confirm(`Apply ${result.files.length} changed file(s) to ${o.cwd}?`) : false);
  if (!ok) return { result, applied: false, reason: 'declined' };
  await git(o.cwd, ['apply', '--binary', '-'], result.patch);
  return { result, applied: true };
}
