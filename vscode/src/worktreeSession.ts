/**
 * A chat session in its own git worktree (v1.1 N12), on WS4's D2 helpers
 * (`src/core/context/worktree.ts`): `createWorktree` makes `oh/<id>` off HEAD,
 * the session's agent works inside it, and the user ends it from the Agents
 * view with Merge (commit the session's work on its branch, remove the
 * worktree, `mergeWorktreeBranch` into the current branch, which deletes the
 * branch) or Discard (remove the worktree and delete the branch). Either way
 * `git worktree list` is back to the user's own worktrees.
 *
 * No `vscode` import (unit-tested with node). Git runs with hooks disabled and
 * the scrubbed env, like the core's own worktree calls.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorktree, mergeWorktreeBranch, removeWorktree, type Worktree } from '../../src/core/context/worktree.js';
import { scrubbedEnv, type CommandWrap } from '../../src/core/tools/shell.js';
import { gitPrefix } from '../../src/core/context/worktreeGit.js';
import { parseDiffStats, type DiffStats } from './agents.js';

const pexec = promisify(execFile);
const IDENT = ['-c', 'user.name=Tugline', '-c', 'user.email=tugline@localhost', '-c', 'commit.gpgsign=false'];

async function git(cwd: string, args: string[], scrub: string[] = []): Promise<string> {
  const { stdout } = await pexec('git', [...gitPrefix(false), ...args], { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...scrubbedEnv(scrub), GIT_TERMINAL_PROMPT: '0' } });
  return stdout.toString();
}

export type { Worktree };

/** A fresh worktree for a new session; the id becomes the branch `oh/<id>`. */
export function newSessionWorktree(workspace: string, id = `s${Date.now().toString(36)}`): Promise<Worktree> {
  return createWorktree(workspace, id);
}

/** Lines of a new (untracked) text file, for the diff stats; binary or huge files count as 0. */
function lineCount(abs: string): number {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 2_000_000) return 0;
    const b = fs.readFileSync(abs);
    if (b.includes(0)) return 0;
    const s = b.toString('utf8');
    return s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
  } catch {
    return 0;
  }
}

/** Uncommitted and committed work of the session against its base. */
export async function worktreeDiffStats(wt: Pick<Worktree, 'root' | 'base'>, scrub: string[] = []): Promise<DiffStats> {
  const numstat = await git(wt.root, ['diff', '--numstat', wt.base], scrub);
  const others = (await git(wt.root, ['ls-files', '--others', '--exclude-standard', '-z'], scrub)).split('\0').filter(Boolean);
  return parseDiffStats(numstat, others.map((f) => ({ lines: lineCount(path.join(wt.root, f)) })));
}

/** Commit everything the session changed on its branch. Returns whether there was anything. */
export async function commitSession(wt: Pick<Worktree, 'root'>, message: string, scrub: string[] = []): Promise<boolean> {
  await git(wt.root, ['add', '-A'], scrub);
  if (!(await git(wt.root, ['diff', '--cached', '--name-only'], scrub)).trim()) return false;
  await git(wt.root, [...IDENT, 'commit', '--no-verify', '-q', '-m', message.slice(0, 200) || 'Tugline session'], scrub);
  return true;
}

export interface EndResult {
  ok: boolean;
  message: string;
}

/**
 * Merge: commit the session's work, remove its worktree (a branch checked out
 * in a worktree cannot be deleted), then merge `oh/<id>` into the current
 * branch with the core helper (aborts cleanly on conflicts; the branch is kept
 * then, so nothing is lost).
 */
export async function mergeSession(wt: Worktree, o: { message: string; wrap?: CommandWrap; scrub?: string[] }): Promise<EndResult> {
  const committed = await commitSession(wt, o.message, o.scrub);
  await removeWorktree(wt);
  const ahead = (await git(wt.repoRoot, ['rev-list', '--count', `${wt.base}..${wt.branch}`], o.scrub).catch(() => '0')).trim();
  if (!committed && ahead === '0') {
    await git(wt.repoRoot, ['branch', '-D', wt.branch], o.scrub).catch(() => undefined);
    return { ok: true, message: `${wt.branch} had no changes; its worktree was removed.` };
  }
  const r = await mergeWorktreeBranch(wt.repoRoot, wt.branch, { deleteBranch: true, wrap: o.wrap, scrub: o.scrub });
  return { ok: r.merged, message: r.merged ? `Merged ${wt.branch}.` : r.output };
}

/** Discard: remove the worktree and delete the branch with everything on it. */
export async function discardSession(wt: Worktree, scrub: string[] = []): Promise<EndResult> {
  await removeWorktree(wt);
  await git(wt.repoRoot, ['branch', '-D', wt.branch], scrub).catch(() => undefined);
  return { ok: true, message: `Discarded ${wt.branch}.` };
}

/** `git worktree list --porcelain` paths (tests and the view's sanity check). */
export async function worktreePaths(repo: string): Promise<string[]> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}
