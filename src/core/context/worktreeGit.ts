/**
 * @license
 * Portions Copyright 2025 Qwen Team (packages/core/src/utils/gitUtils.ts NO_EXEC_CONFIG,
 * packages/core/src/services/gitWorktreeService.ts NO_EXEC_DIFF_FLAGS, Qwen Code commit c726d2c)
 * SPDX-License-Identifier: Apache-2.0 (those portions); MIT (the rest of this file)
 *
 * Modified by Tugline contributors, 2026-10-31: the program-valued git config list was extended
 * (diff.external, protocol.ext.allow) and is also provided as GIT_CONFIG_COUNT environment config; hooks are
 * disabled (Qwen enables the repository hooks in worktrees); paths are contained in one root.
 */
/**
 * Hardened git for worktrees and the task board (v1.2 N48, absorbs R17).
 *
 * Every git call the harness makes for worktrees, cards and arena contestants
 * goes through `safeGit`:
 *   - **no repository hooks** (`core.hooksPath=/dev/null`), unless the user
 *     trusted them at user scope (`worktree.trustHooks` in ~/.tugline/config.json;
 *     a project config can never turn them on, S7). Qwen Code does the opposite:
 *     it points new worktrees *at* the repo's hooks (`configureHooksPath`).
 *   - **no program-valued config** a repository can plant: `core.fsmonitor=`
 *     and `log.showSignature=false` (ported from Qwen Code's NO_EXEC_CONFIG,
 *     packages/core/src/utils/gitUtils.ts @ c726d2c, Apache-2.0), plus
 *     `--no-ext-diff --no-textconv` on every diff.
 *   - a scrubbed environment (no credentials), no terminal prompts, a timeout.
 *
 * Worktree paths live under one configured root and can never escape it
 * (`containedPath`): ids are sanitised, `..` is refused and symlinks are
 * resolved before every create and every recursive delete (N48 SAC2).
 */
import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarnessConfig } from '../config.js';
import { scrubbedEnv, type CommandWrap } from '../tools/shell.js';

const pexec = promisify(execFile);

/** `worktree` config section (declaration-merged). */
export interface WorktreeSettings {
  /** Where card / arena worktrees live (default ~/.tugline/worktrees). */
  root?: string;
  /** Run the repository's git hooks in harness git calls. USER SCOPE ONLY (S7); default false. */
  trustHooks: boolean;
  /** Gitignored directories symlinked from the main tree into each new worktree (e.g. ["node_modules"]). User scope only. */
  symlinkDirs: string[];
  /** Copy gitignored files listed in `.worktreeinclude` (Cline) into new worktrees. Default true. */
  include: boolean;
  /** Before landing a card, merge it in a scratch worktree and run the harness check there. Default true. */
  verifyBeforeMerge: boolean;
  /** Cards that may run at once. */
  maxParallel: number;
  /** Start linked (dependent) cards automatically when their dependencies are merged. USER SCOPE ONLY (runs unattended, S7). */
  autoStart: boolean;
  /** Offer board_add_card / board_list to the main agent (decompose a goal into cards). Default false. */
  boardTools: boolean;
}

export const DEFAULT_WORKTREE: WorktreeSettings = { trustHooks: false, symlinkDirs: [], include: true, verifyBeforeMerge: true, maxParallel: 3, autoStart: false, boardTools: false };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    worktree?: Partial<WorktreeSettings>;
  }
}

function readUserConfig(homeDir: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Effective settings. The keys that loosen safety or run things unattended
 * (`trustHooks`, `autoStart`, `symlinkDirs`, `root`) are taken from the USER
 * config file only, never from a project `.tugline/config.json`, even a
 * trusted one (S7: project config cannot loosen).
 */
export function worktreeSettings(cfg: Pick<HarnessConfig, 'homeDir'> & { worktree?: Partial<WorktreeSettings> }): WorktreeSettings {
  const merged = { ...DEFAULT_WORKTREE, ...(cfg.worktree ?? {}) };
  const user = (readUserConfig(cfg.homeDir).worktree ?? {}) as Partial<WorktreeSettings>;
  return {
    ...merged,
    trustHooks: user.trustHooks === true,
    autoStart: user.autoStart === true,
    symlinkDirs: Array.isArray(user.symlinkDirs) ? user.symlinkDirs.filter((s) => typeof s === 'string') : [],
    root: typeof user.root === 'string' ? user.root : undefined,
    maxParallel: Math.max(1, Math.min(8, Number(merged.maxParallel) || 3)),
  };
}

/** Program-valued config a repository can point git at, neutralised on every call (Qwen NO_EXEC_CONFIG, extended). */
export const NO_EXEC_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'log.showSignature=false', '-c', 'diff.external=', '-c', 'protocol.ext.allow=never'];

/**
 * The same neutralisation as environment config (GIT_CONFIG_COUNT/KEY/VALUE, git ≥ 2.31), for callers whose
 * argv shape is fixed: runtime env config is read after the repository's config files, so it wins over them.
 */
export function noExecConfigEnv(): Record<string, string> {
  const pairs: [string, string][] = [];
  for (let i = 0; i < NO_EXEC_CONFIG.length; i += 2) {
    const kv = NO_EXEC_CONFIG[i + 1];
    const eq = kv.indexOf('=');
    pairs.push([kv.slice(0, eq), kv.slice(eq + 1)]);
  }
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Repository-local keys that name a program git would run on fetch; a repo carrying one is refused before any network git call. */
export const LOCAL_PROGRAM_KEYS = /^(core\.sshcommand|core\.gitproxy|remote\..*\.(uploadpack|receivepack|proxy)|url\..*\.insteadof|credential\..*|http\..*\.proxy|uploadpack\..*)$/i;

export async function assertNoLocalProgramConfig(repo: string): Promise<void> {
  let out = '';
  try {
    out = await safeGit(repo, ['config', '--local', '--name-only', '--list']);
  } catch {
    return;
  }
  const bad = out.split('\n').map((l) => l.trim()).filter((k) => k && LOCAL_PROGRAM_KEYS.test(k));
  if (bad.length) throw new GitError(`refusing a network git call: the repository's own config sets ${bad.join(', ')} (a repository can point these at programs)`, null, '', '');
}
export const NO_HOOKS = ['-c', `core.hooksPath=${os.devNull}`];
/** Flags for every diff: no external diff drivers, no textconv filters (both run programs). */
export const NO_EXEC_DIFF = ['--no-ext-diff', '--no-textconv'];
/** Identity for harness-made commits (no user.name needed; never signs). */
export const IDENT = ['-c', 'user.name=Tugline', '-c', 'user.email=tugline@localhost', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false'];

export class GitError extends Error {
  constructor(message: string, readonly code: number | null, readonly stdout: string, readonly stderr: string) {
    super(message);
  }
}

export interface GitOptions {
  /** run hooks (only when the user trusted them) */
  hooks?: boolean;
  timeoutMs?: number;
  scrub?: string[];
  /** command wrapper (OS sandbox) for git calls that act on the user's tree on the model's behalf */
  wrap?: CommandWrap;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** The exact argv prefix a harness git call uses (tests assert on it; the reviewer mutates it). */
export function gitPrefix(hooks = false): string[] {
  return [...(hooks ? [] : NO_HOOKS), ...NO_EXEC_CONFIG];
}

/** Program-valued attribute drivers (they run on add, checkout, commit, merge and diff). */
const DRIVER_KEYS = '^(filter|merge|diff)\\..+\\.(clean|smudge|process|driver|command|textconv)$';

/**
 * Review F6: the repository's OWN attribute drivers (`filter.<x>.clean/smudge/process`, `merge.<x>.driver`,
 * `diff.<x>.command/textconv` in `.git/config`, a worktree config or a file it includes) are switched off for the
 * harness's git calls with empty `-c` overrides (git then runs nothing for them: a filter passes content through, a
 * merge driver becomes a conflict). Drivers from the user's global or system config (git-lfs) stay usable.
 * Reading config runs no program.
 */
export function repoDriverOverrides(cwd: string): string[] {
  const r = spawnSync('git', ['config', '--show-scope', '--includes', '--name-only', '--get-regexp', DRIVER_KEYS], { cwd, encoding: 'utf8', timeout: 10_000 });
  const out: string[] = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (!m || !['local', 'worktree'].includes(m[1]!)) continue;
    out.push('-c', `${m[2]}=`);
    if (/^filter\./i.test(m[2]!)) out.push('-c', `${m[2]!.replace(/\.[^.]+$/, '')}.required=false`);
  }
  return out;
}

/** Attributes files outside the repository's own tree are not read by harness git calls (review F6). */
export const NO_ATTR_FILES = ['-c', `core.attributesFile=${os.devNull}`];

export async function safeGit(cwd: string, args: string[], o: GitOptions = {}): Promise<string> {
  let spec = { file: 'git', args: [...gitPrefix(o.hooks), ...NO_ATTR_FILES, ...(fs.existsSync(cwd) ? repoDriverOverrides(cwd) : []), ...args], cwd, env: { ...scrubbedEnv(o.scrub ?? []), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', ...(o.env ?? {}) } as NodeJS.ProcessEnv };
  if (o.wrap) spec = o.wrap(spec);
  try {
    const p = pexec(spec.file, spec.args, { cwd: spec.cwd, timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, env: spec.env });
    if (o.input !== undefined) p.child.stdin?.end(o.input);
    const { stdout } = await p;
    return stdout.toString();
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() ?? '';
    const stdout = e.stdout?.toString?.() ?? '';
    throw new GitError(`git ${args.slice(0, 3).join(' ')} failed: ${(stderr || stdout || e.message).trim().slice(0, 2000)}`, typeof e.code === 'number' ? e.code : null, stdout, stderr);
  }
}

/** git for a config: hooks only if trusted at user scope. */
export function gitFor(cfg: HarnessConfig): (cwd: string, args: string[], o?: GitOptions) => Promise<string> {
  const s = worktreeSettings(cfg);
  return (cwd, args, o = {}) => safeGit(cwd, args, { scrub: cfg.shell?.scrubEnv, ...o, hooks: s.trustHooks && o.hooks !== false });
}

// ------------------------------------------------------------------ containment (SAC2)

export class PathEscapeError extends Error {}

/** Lowercase slug for ids and directory names: [a-z0-9-], 1–48 chars, never `.`/`..`. */
export function safeSlug(s: string, fallback = 'card'): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return v || fallback;
}

/** True when `child` is `parent` or inside it, comparing real paths. */
export function realInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrResolved(p: string): string {
  // resolve the longest existing prefix, so a symlink anywhere above `p` is followed
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return abs;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

/** The worktrees root for a config, created 0700 and resolved. */
export function worktreesRoot(cfg: Pick<HarnessConfig, 'homeDir'> & { worktree?: Partial<WorktreeSettings> }): string {
  const s = worktreeSettings(cfg);
  const root = path.resolve(s.root ?? path.join(cfg.homeDir, 'worktrees'));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.realpathSync(root);
}

/**
 * The directory for `<repoKey>/<name>` under `root`, refusing anything that is
 * not a plain child: `..`, separators, absolute names, and a symlinked repo
 * directory pointing elsewhere.
 */
export function containedPath(root: string, ...parts: string[]): string {
  const realRoot = fs.realpathSync(root);
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || /[\\/]/.test(p) || p.includes('\0') || path.isAbsolute(p)) throw new PathEscapeError(`worktree name "${p}" is not a plain directory name`);
  }
  const target = path.join(realRoot, ...parts);
  const real = realOrResolved(target);
  if (!realInside(real, realRoot)) throw new PathEscapeError(`worktree path ${target} resolves to ${real}, outside the worktrees root ${realRoot}`);
  return target;
}

/** Assert an existing path (e.g. read back from a board file) is inside the root before deleting it. */
export function assertContained(root: string, p: string): string {
  const realRoot = fs.realpathSync(root);
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) throw new PathEscapeError(`worktree path ${p} is not a normalised absolute path`);
  const real = realOrResolved(p);
  if (!realInside(real, realRoot) || real === realRoot) throw new PathEscapeError(`refusing to touch ${p}: it resolves to ${real}, outside the worktrees root ${realRoot}`);
  return real;
}

/** Stable short key for a repository (its real top-level path). */
export function repoKey(repoRoot: string): string {
  const real = fs.realpathSync(repoRoot);
  return `${safeSlug(path.basename(real), 'repo')}-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 10)}`;
}

export async function repoTop(dir: string, cfg?: HarnessConfig): Promise<string> {
  try {
    return fs.realpathSync((await safeGit(dir, ['rev-parse', '--show-toplevel'], { scrub: cfg?.shell?.scrubEnv })).trim());
  } catch {
    throw new GitError(`${dir} is not inside a git repository; worktrees need one (git init and commit first)`, null, '', '');
  }
}

/** Files with uncommitted changes (tracked or untracked), repo-relative. */
export async function dirtyFiles(repo: string, run = safeGit): Promise<string[]> {
  const out = await run(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const st = e.slice(0, 2);
    files.push(e.slice(3));
    if (st[0] === 'R' || st[0] === 'C') i++; // rename: the next entry is the old name
  }
  return files;
}
