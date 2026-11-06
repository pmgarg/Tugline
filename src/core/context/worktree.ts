/**
 * Git worktree isolation for subagents (SPEC D2).
 *
 * `task {isolation:"worktree"}` runs the child in `git worktree add <tmp> -b
 * oh/<id>` (based on HEAD), so parallel children can edit the same files
 * without stepping on each other or on the user's working tree. When the child
 * finishes, its changes are committed on its branch (hooks disabled: the
 * user's hooks are not the agent's to run), the worktree directory is removed
 * and the branch is kept. `worktree_merge {branch}` (asks permission like a
 * command) merges one branch into the current branch and deletes it.
 *
 * Only branches under oh/ can be merged by the tool, and the harness's git
 * invocations never read the model's input as options.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { registerToolProvider } from '../tools/registry.js';
import { ToolError, type ToolDef } from '../tools/types.js';
import { commandWrapperFor, scrubbedEnv, type CommandWrap } from '../tools/shell.js';
import { noExecConfigEnv } from './worktreeGit.js';
import { noteHarnessWrite } from '../permissions/harnessWrites.js';

/** F18 (v1.2): git metadata the harness itself changes when it collects or removes a worktree; the R1 guard adopts it. */
function noteGitMetadata(repoRoot: string): void {
  for (const f of ['config', 'packed-refs', 'HEAD']) noteHarnessWrite(path.join(repoRoot, '.git', f));
}

const pexec = promisify(execFile);

/** Identity for harness-made commits; avoids failing on machines without user.name. */
const IDENT = ['-c', 'user.name=Tugline', '-c', 'user.email=tugline@localhost', '-c', 'commit.gpgsign=false'];

/**
 * Harness git calls never run the user's hooks (they are not the agent's to run,
 * and must not see the harness's environment): hooks are disabled for the call,
 * and the env is scrubbed of credentials like any command the agent starts.
 */
const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'protocol.file.allow=never'];

async function git(cwd: string, args: string[], timeout = 60_000, wrap?: CommandWrap, scrub: string[] = []): Promise<string> {
  try {
    let spec = { file: 'git', args: [...NO_HOOKS, ...args], cwd, env: { ...scrubbedEnv(scrub), GIT_TERMINAL_PROMPT: '0', ...noExecConfigEnv() } as NodeJS.ProcessEnv };
    if (wrap) spec = wrap(spec);
    const { stdout } = await pexec(spec.file, spec.args, { cwd: spec.cwd, timeout, maxBuffer: 32 * 1024 * 1024, env: spec.env });
    return stdout.toString();
  } catch (e: any) {
    const msg = `${e.stderr?.toString?.() ?? ''}${e.stdout?.toString?.() ?? ''}`.trim() || e.message;
    throw new ToolError(`git ${args.filter((a) => !a.startsWith('user.')).join(' ')} failed: ${msg}`);
  }
}

export interface Worktree {
  id: string;
  /** worktree root */
  root: string;
  /** the child's workspace inside the worktree (same relative subdir as the parent) */
  path: string;
  branch: string;
  base: string;
  repoRoot: string;
  /** v1.2 F1: the worktree's git dir in the main repository, and the `.git` file git wrote (the child must not own them) */
  gitDir?: string;
  gitFile?: string;
}

export async function repoRootOf(workspace: string): Promise<string> {
  try {
    return (await git(workspace, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new ToolError('isolation "worktree" needs a git repository, and this workspace is not one. Run the task without isolation.');
  }
}

export async function createWorktree(workspace: string, id: string): Promise<Worktree> {
  const repoRoot = fs.realpathSync(await repoRootOf(workspace));
  let base: string;
  try {
    base = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  } catch {
    throw new ToolError('isolation "worktree" needs at least one commit in the repository');
  }
  const branch = `oh/${id}`;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-wt-')));
  fs.rmdirSync(root); // git creates it
  await git(repoRoot, ['worktree', 'add', '-b', branch, root, base]);
  const rel = path.relative(repoRoot, fs.realpathSync(workspace));
  // F1: remember the git metadata git wrote; harness git on this worktree uses it explicitly, never the child's copy
  const gitFile = fs.readFileSync(path.join(root, '.git'), 'utf8');
  const gitDir = path.resolve(root, gitFile.replace(/^gitdir:\s*/, '').trim());
  return { id, root, path: rel ? path.join(root, rel) : root, branch, base, repoRoot, gitDir, gitFile };
}

/** F1: is the worktree's `.git` still the plain file git wrote (not a link, a directory or other content)? */
export function worktreeMetadataIntact(wt: Pick<Worktree, 'root' | 'gitFile'>): boolean {
  if (wt.gitFile === undefined) return true;
  try {
    const st = fs.lstatSync(path.join(wt.root, '.git'));
    return st.isFile() && fs.readFileSync(path.join(wt.root, '.git'), 'utf8') === wt.gitFile;
  } catch {
    return false;
  }
}

export interface WorktreeResult {
  branch: string;
  committed: boolean;
  diffStat: string;
}

/** Commit the child's work on its branch, then remove the worktree directory (the branch stays). */
export async function finishWorktree(wt: Worktree, message: string): Promise<WorktreeResult> {
  let committed = false;
  // F1: a child that replaced its git metadata (a `.git` with core.fsmonitor, a symlink …) is never run by git on
  // the host: its work is not collected, the directory is deleted.
  if (!worktreeMetadataIntact(wt)) {
    fs.rmSync(wt.root, { recursive: true, force: true });
    await git(wt.repoRoot, ['worktree', 'prune']).catch(() => undefined);
    await git(wt.repoRoot, ['branch', '-D', wt.branch]).catch(() => undefined);
    throw new ToolError(`the child changed its worktree's git metadata (${path.join(wt.root, '.git')}); its changes were not collected and the worktree was deleted`);
  }
  // pinned git dir and work tree: the child's files are data to git, never configuration
  const pin = wt.gitDir ? [`--git-dir=${wt.gitDir}`, `--work-tree=${wt.root}`] : [];
  try {
    await git(wt.root, [...pin, 'add', '-A']);
    const staged = (await git(wt.root, [...pin, 'diff', '--cached', '--name-only'])).trim();
    if (staged) {
      await git(wt.root, [...pin, ...IDENT, 'commit', '--no-verify', '-q', '-m', message.slice(0, 200) || 'Tugline subagent work']);
      committed = true;
    }
  } finally {
    await removeWorktree(wt);
  }
  const diffStat = committed ? (await git(wt.repoRoot, ['diff', '--stat', `${wt.base}..${wt.branch}`])).trim() : '(no changes)';
  if (!committed) await git(wt.repoRoot, ['branch', '-D', wt.branch]).catch(() => undefined);
  noteGitMetadata(wt.repoRoot);
  return { branch: wt.branch, committed, diffStat };
}

export async function removeWorktree(wt: Pick<Worktree, 'root' | 'repoRoot'> & { gitFile?: string }): Promise<void> {
  // F1: with tampered metadata git must not look inside: delete the directory and prune
  if (worktreeMetadataIntact(wt)) await git(wt.repoRoot, ['worktree', 'remove', '--force', wt.root]).catch(() => undefined);
  if (fs.existsSync(wt.root)) fs.rmSync(wt.root, { recursive: true, force: true });
  await git(wt.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  noteGitMetadata(wt.repoRoot);
}

export function validBranch(b: string): boolean {
  return /^oh\/[A-Za-z0-9._-]+$/.test(b) && !b.includes('..');
}

/** Merge an oh/* branch into the current branch; aborts cleanly on conflicts. */
export async function mergeWorktreeBranch(workspace: string, branch: string, opts: { deleteBranch?: boolean; wrap?: CommandWrap; scrub?: string[] } = {}): Promise<{ merged: boolean; output: string }> {
  if (!validBranch(branch)) throw new ToolError(`only harness branches (oh/<id>) can be merged with this tool; got "${branch}"`);
  const repoRoot = await repoRootOf(workspace);
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    throw new ToolError(`no branch ${branch}`);
  }
  try {
    // The merge is the model's action on the user's tree: it runs through the command wrappers (OS sandbox seam).
    const out = await git(repoRoot, [...IDENT, 'merge', '--no-ff', '--no-verify', '--no-edit', '-m', `Merge ${branch} (Tugline subagent)`, branch], 60_000, opts.wrap, opts.scrub);
    if (opts.deleteBranch !== false) await git(repoRoot, ['branch', '-d', branch], 60_000, opts.wrap, opts.scrub).catch(() => undefined);
    return { merged: true, output: out.trim() };
  } catch (e) {
    await git(repoRoot, ['merge', '--abort'], 60_000, opts.wrap, opts.scrub).catch(() => undefined);
    return { merged: false, output: `Merge of ${branch} failed and was aborted (your working tree is unchanged): ${(e as Error).message}` };
  }
}

export const worktreeMergeTool: ToolDef<{ branch: string; delete_branch?: boolean }> = {
  name: 'worktree_merge',
  kind: 'execute',
  description: 'Merge the branch produced by a task that ran with isolation "worktree" (oh/<id>) into the current branch. Review the diff stat first. Conflicts abort the merge and leave the working tree unchanged.',
  parameters: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'oh/<id> branch from the task result' },
      delete_branch: { type: 'boolean', description: 'Delete the branch after a successful merge (default true)' },
    },
    required: ['branch'],
  },
  title: (a) => `Merge ${a.branch}`,
  // Described to the policy as the command it is, so it asks like any git command.
  permissionInput: (a) => ({ command: `git merge --no-ff ${String(a.branch ?? '')}` }),
  validate(a) {
    if (!validBranch(String(a.branch ?? ''))) throw new ToolError(`only harness branches (oh/<id>) can be merged with this tool; got "${a.branch}"`);
  },
  async run(a, ctx) {
    const r = await mergeWorktreeBranch(ctx.workspace, String(a.branch), { deleteBranch: a.delete_branch, wrap: commandWrapperFor(ctx.config), scrub: ctx.config.shell.scrubEnv });
    return { output: r.output || `Merged ${a.branch}.`, isError: !r.merged };
  },
};

registerToolProvider({ id: 'ws4-worktree', tools: (_cfg, env) => (env.depth === 0 ? [worktreeMergeTool] : []) });
