/**
 * N43: auto mode v2, the pipeline that settles what the policy left as "auto mode: …".
 *
 * Order of authority (each step can only make the decision stricter than the next):
 *   1. policy hard denies, deny rules and protected paths (never reach here);
 *      user ask rules (`permissions.ask`) → the human, always;
 *   2. the deterministic floor: the C3 prefilter plus auto-only rules
 *      (self-modification files, amending a commit this session did not make).
 *      A floor hit goes to the human; no classifier verdict, allow rule or other
 *      extension can lift it (policy.ts applies it over allow rules too, and
 *      agent.ts treats an extension's 'ask' as a veto);
 *   3. Rule of Two: after untrusted content entered the session, an
 *      egress-capable call goes to the human without consulting the classifier
 *      (agent.ts already does this; this is the pipeline's own copy);
 *   4. suspended auto mode (the total-block cap) → the human;
 *   5. fast paths: an edit whose every path is inside the workspace and is not a
 *      self-modification file, and a read-only shell command inside the workspace
 *      → allow, no classifier call (read tools are allowed by the policy itself);
 *   6. the two-stage, transcript-aware classifier (classifier.ts);
 *   7. denial tracking (denial.ts): blocks go back to the model with guidance,
 *      the block that reaches the consecutive cap goes to the human, the total
 *      cap suspends auto mode; unavailable → the human (fail closed), with a
 *      circuit breaker.
 * Every decision is an `approval_auto` event and a journal record with the step,
 * the stage latencies and the reason.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveProfile, type HarnessConfig } from '../config.js';
import { LLMClient, costOf } from '../llm/client.js';
import { withScopeOverride } from '../llm/admission.js';
import { reasoningBody, selectOverlay } from '../llm/overlays.js';
import { limitsConfig, recordUsage, rootSession } from '../permissions/limits.js';
import { AUTO_MODE_REASON, expandGlobTarget, setAutoFloor, splitCommandSegments, type CheckInput } from '../permissions/policy.js';
import { shellWriteTargets } from '../permissions/shellWrites.js';
import picomatch from 'picomatch';
import { registerAgentExtension, type AgentApi, type ApprovalDecision, type ApprovalQuery } from '../agent/extensions.js';
import { registerSlashCommand } from '../commands.js';
import { runHooks } from '../agent/hooks.js';
import { taintCategory } from '../context/taint.js';
import type { BriefEntry } from '../context/brief.js';
import type { ChatMessage, ModelProfile, Usage } from '../types.js';
import { contentToText } from '../util/text.js';
import { prefilter, physicalPath, type BlockCategory } from './prefilter.js';
import { selfModificationPath } from './selfmod.js';
import { normalizeCommand } from './normalize.js';
import { rawSelfModWrite } from './rawWrites.js';
import { lexSimple, readOnlyCommand } from './readonly.js';
import { parseOptions, type OptSpec } from './readonlyOptions.js';
import { archiveExtraction } from './extractors.js';
import { classifyTwoStage, type ClassifierHints, type StageFn, type StageRecord } from './classifier.js';
import { DEFAULT_TRANSCRIPT_LIMITS, type TranscriptLimits } from './transcript.js';
import {
  DEFAULT_DENIAL_LIMITS,
  DENIAL_GUIDANCE,
  classifierCoolingDown,
  createDenialState,
  formatDenialState,
  reachedConsecutiveCap,
  recordAllow,
  recordBlock,
  recordHumanReview,
  recordUnavailable,
  wasBlocked,
  type DenialLimits,
  type DenialState,
} from './denial.js';

// ------------------------------------------------------------ config

export interface AutoModeConfig extends DenialLimits {
  /** Model profile for the classifier (default: approver.profile, routing.approver, smallProfile, else the main model). */
  profile?: string;
  /** Local models: stage 1 must answer fast; a timeout is "unavailable" → the human, never an allow. */
  stage1TimeoutMs: number;
  stage2TimeoutMs: number;
  stage1MaxTokens: number;
  stage2MaxTokens: number;
  /** 'off' (default) asks the server to switch the model's thinking off for classifier calls. */
  thinking: 'off' | 'model';
  /** Extra request fields for classifier calls (replace the automatic thinking-off fields). */
  extraBody?: Record<string, unknown>;
  transcript: Partial<TranscriptLimits>;
  hints: ClassifierHints;
  /** Allow verdicts cached per (call, user requests) (default 300). */
  cacheSize: number;
  /** No allow rule settles a shell command in auto mode: the classifier sees every one (default false). */
  classifyAllShell?: boolean;
}

export const DEFAULT_AUTO_MODE: AutoModeConfig = {
  ...DEFAULT_DENIAL_LIMITS,
  stage1TimeoutMs: 20_000,
  stage2TimeoutMs: 60_000,
  stage1MaxTokens: 24,
  stage2MaxTokens: 400,
  thinking: 'off',
  transcript: {},
  hints: {},
  cacheSize: 300,
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** N43 (WS23): auto mode v2. User scope or managed only: project config can never set it (S7). */
    autoMode?: Partial<AutoModeConfig>;
  }
}

export function autoModeConfig(cfg: HarnessConfig): AutoModeConfig {
  const o = { ...DEFAULT_AUTO_MODE, ...(cfg.autoMode ?? {}) };
  if (!o.profile) o.profile = (cfg as { approver?: { profile?: string } }).approver?.profile ?? (cfg as { routing?: { approver?: string } }).routing?.approver ?? cfg.smallProfile;
  for (const k of ['maxConsecutiveBlocks', 'maxTotalBlocks', 'maxConsecutiveUnavailable'] as const) if (!(Number.isFinite(o[k]) && o[k] >= 1)) o[k] = DEFAULT_AUTO_MODE[k];
  // a timeout below 1 s turns every call into "unavailable" (Qwen keeps the same floor)
  for (const k of ['stage1TimeoutMs', 'stage2TimeoutMs'] as const) if (!(Number.isFinite(o[k]) && o[k] >= 1000)) o[k] = DEFAULT_AUTO_MODE[k];
  for (const k of ['stage1MaxTokens', 'stage2MaxTokens'] as const) if (!(Number.isFinite(o[k]) && o[k] >= 1)) o[k] = DEFAULT_AUTO_MODE[k];
  return o;
}

// ------------------------------------------------------------ the deterministic floor

export { SELF_MODIFICATION, selfModificationPath } from './selfmod.js';

// --- shell writes to self-modification files (review finding 2)


/** Writers the policy's write analysis does not model: package managers editing package.json, sponge, line editors. */
export function extraWriteTargets(command: string, cwd: string): { path: string; by: string }[] {
  const out: { path: string; by: string }[] = [];
  let n;
  try {
    n = normalizeCommand(command);
  } catch {
    return out;
  }
  let dir = cwd;
  for (const c of n.commands) {
    const [prog, ...args] = c.argv;
    if (!prog) continue;
    if (prog === 'cd' && args.length <= 1) {
      if (args[0] && !/^[$~-]/.test(args[0])) dir = path.resolve(dir, args[0]);
      continue;
    }
    const pos = args.filter((a) => !a.startsWith('-'));
    const pk = pos.indexOf('pkg');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog) && ((pk >= 0 && ['set', 'delete', 'fix'].includes(pos[pk + 1] ?? '')) || pos.includes('set-script'))) {
      const pref = args.findIndex((a) => a === '--prefix' || a === '-C' || a === '--dir' || a === '--cwd');
      out.push({ path: path.resolve(dir, pref >= 0 && args[pref + 1] ? args[pref + 1]! : '.', 'package.json'), by: `${prog} ${pk >= 0 ? 'pkg' : 'set-script'}` });
    }
    if (prog === 'sponge' && pos.length) out.push({ path: path.resolve(dir, pos[pos.length - 1]!), by: 'sponge' });
    if (['ed', 'red', 'ex', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'micro'].includes(prog)) for (const p of pos) out.push({ path: path.resolve(dir, p), by: prog });
  }
  if (n.shell.length || n.subst.length) for (const inner of [...n.shell, ...n.subst]) out.push(...extraWriteTargets(inner, dir));
  return out;
}

/**
 * Writers whose targets come from the file system: patches (the files named in the patch) and recursive copies (the
 * source tree, mapped both ways it can land). Re-check finding B: archives are not parsed here at all (extractors.ts
 * puts every extraction on the floor), and these writers are parsed with option ALLOWLISTS; any option, wrapper,
 * expansion or form this code does not model makes the target set `unknown` (the floor then asks).
 */
const BULK_SPECS: Record<string, OptSpec> = {
  cp: {
    flags: 'rRafinpuvLPHdTlsxb',
    values: { t: 'any', S: 'any' },
    long: ['--recursive', '--archive', '--force', '--interactive', '--no-clobber', '--verbose', '--no-target-directory', '--dereference', '--no-dereference', '--one-file-system', '--link', '--symbolic-link', '--remove-destination', '--strip-trailing-slashes', '--update'],
    longValues: { '--target-directory': 'any', '--suffix': 'any', '--no-preserve': 'any', '--sparse': /^\w+$/ },
    longOptional: { '--preserve': /^[\w,]+$/, '--backup': /^\w+$/, '--reflink': /^\w+$/ },
  },
  rsync: {
    flags: 'avrlptgoDzhPnucCqiHAXEWSx',
    long: ['--archive', '--recursive', '--verbose', '--delete', '--dry-run', '--progress', '--checksum', '--update', '--links', '--perms', '--times', '--compress', '--human-readable', '--partial', '--itemize-changes', '--quiet', '--ignore-existing', '--existing', '--delete-after', '--delete-excluded', '--stats', '--no-perms', '--no-owner', '--no-group', '--copy-links', '--safe-links', '--hard-links', '--one-file-system'],
    longValues: { '--exclude': 'any', '--include': 'any', '--chmod': 'any' },
  },
  patch: {
    flags: 'RNsufbtEnl',
    values: { p: /^[01]$/, i: 'any', d: 'any', o: 'any', F: /^\d+$/ },
    attached: 'p',
    long: ['--reverse', '--forward', '--silent', '--quiet', '--unified', '--force', '--backup', '--batch', '--remove-empty-files', '--dry-run', '--ignore-whitespace', '--verbose', '--no-backup-if-mismatch', '--posix'],
    longValues: { '--strip': /^[01]$/, '--input': 'any', '--directory': 'any', '--output': 'any', '--fuzz': /^\d+$/ },
  },
  'git apply': {
    flags: 'Rv3',
    values: { p: /^[01]$/ },
    attached: 'p',
    long: ['--check', '--stat', '--numstat', '--summary', '--index', '--cached', '--3way', '--reject', '--reverse', '--verbose', '--recount', '--unidiff-zero', '--allow-empty', '--apply', '--no-add', '--quiet'],
    longValues: { '--whitespace': /^\w+$/, '--exclude': 'any', '--include': 'any', '--directory': 'any' },
  },
  'git am': {
    flags: 'sq3k',
    values: { p: /^[01]$/ },
    attached: 'p',
    long: ['--3way', '--signoff', '--quiet', '--keep', '--keep-cr', '--no-keep-cr', '--scissors', '--no-scissors', '--message-id', '--committer-date-is-author-date', '--ignore-date'],
    longValues: { '--whitespace': /^\w+$/, '--exclude': 'any', '--include': 'any', '--directory': 'any' },
  },
};

const GIT_TREE = new Set(['checkout', 'switch', 'merge', 'cherry-pick', 'rebase', 'revert', 'pull', 'stash']);
const GIT_TREE_SPEC: OptSpec = { flags: 'qfm', values: { b: 'any', B: 'any', c: 'any', C: 'any' }, long: ['--quiet', '--no-edit', '--ff-only', '--ff', '--no-ff', '--no-commit', '--force', '--detach', '--no-track', '--track', '--autostash', '--no-autostash', '--merge', '--guess', '--no-guess'] };

/** Files `git checkout/switch/merge/cherry-pick/rebase/revert/stash pop` would rewrite, or why that is unknown. */
function gitTreeChanges(words: string[], dir: string): { names: string[]; root: string } | string {
  const [, sub, ...rest] = words;
  const git = (...a: string[]) => {
    try {
      return execFileSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 5000, maxBuffer: 4 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  if (sub === 'pull') return 'git pull brings in commits nobody has looked at';
  const p = parseOptions(GIT_TREE_SPEC, rest);
  if (!p) return `git ${sub} with an option this check does not model`;
  // `git checkout <rev> -- <paths>`: the paths are write targets the policy's shell analysis already models
  if (rest.includes('--')) return { names: [], root: git('rev-parse', '--show-toplevel')?.trim() || dir };
  const root = git('rev-parse', '--show-toplevel')?.trim();
  if (!root) return `git ${sub} outside a readable repository`;
  const list = (...a: string[]) => git('diff', '--name-only', '--no-renames', ...a)?.split('\n').filter(Boolean) ?? null;
  const verify = (r: string) => git('rev-parse', '--verify', '--quiet', `${r}^{commit}`)?.trim() || null;
  let names: string[] | null = [];
  const start = p.values.get('-b')?.[0] !== undefined || p.values.get('-c')?.[0] !== undefined || p.values.get('-B')?.[0] !== undefined || p.values.get('-C')?.[0] !== undefined;
  if (sub === 'stash') {
    const [action, ref = 'stash@{0}'] = p.pos;
    if (!['pop', 'apply'].includes(action ?? '')) return { names: [], root };
    if (!verify(ref)) return { names: [], root }; // no such stash: the command fails and writes nothing
    names = list(`${ref}^`, ref);
  } else if (sub === 'checkout' || sub === 'switch') {
    if (!p.pos.length) return { names: [], root };
    if (p.pos.length > 1 && !start) return `git ${sub} with more than one argument`;
    let rev = p.pos[p.pos.length - 1]!;
    if (!verify(rev)) {
      // `git switch main` / `git checkout main` with only origin/main: git creates the branch from the remote one
      const remote = git('for-each-ref', '--format=%(refname)', `refs/remotes/*/${rev}`)?.split('\n').filter(Boolean) ?? [];
      if (remote.length === 1) rev = remote[0]!;
      else if (remote.length === 0) {
        // switch: fails, nothing is written; checkout: a path restore of the named files (checked like any write)
        return { names: sub === 'checkout' ? p.pos.map((x) => path.relative(root, path.resolve(dir, x))) : [], root };
      } else return `git ${sub} ${rev}: an ambiguous branch name (several remotes have it)`;
    }
    names = list('HEAD', rev);
  } else if (sub === 'merge' || sub === 'rebase') {
    if (!p.pos.length) return `git ${sub} without an explicit commit`;
    for (const r of p.pos) {
      if (!verify(r)) return `git ${sub} ${r}: not a commit`;
      const n = list('HEAD', r);
      if (!n) return `git ${sub} ${r}: cannot list its changes`;
      names.push(...n);
    }
  } else {
    // cherry-pick / revert: each commit's own changes (ranges: the whole range)
    if (!p.pos.length) return `git ${sub} without an explicit commit`;
    for (const r of p.pos) {
      const n = r.includes('..') ? list(r) : verify(r) ? list(`${r}^`, r) : null;
      if (!n) return `git ${sub} ${r}: cannot list its changes`;
      names.push(...n);
    }
  }
  return names ? { names, root } : `git ${sub}: cannot list its changes`;
}

function bulkKind(argv: string[]): string | null {
  const [prog, sub] = argv;
  if (prog === 'git' && (sub === 'apply' || sub === 'am')) return `git ${sub}`;
  if (prog === 'git' && GIT_TREE.has(sub ?? '')) return 'git tree';
  if (prog === 'cp') return argv.some((a) => /^-[A-Za-z]*[rRa]/.test(a) || a === '--recursive' || a === '--archive') ? 'cp' : null;
  if (prog === 'rsync' || prog === 'patch') return prog;
  return null;
}

export function bulkWriteTargets(command: string, cwd: string): { paths: { path: string; by: string }[]; unknown?: string } {
  const out: { path: string; by: string }[] = [];
  let n;
  try {
    n = normalizeCommand(command);
  } catch {
    return { paths: out };
  }
  for (const inner of [...n.shell, ...n.subst]) {
    const r = bulkWriteTargets(inner, cwd);
    if (r.unknown) return r;
    out.push(...r.paths);
  }
  const wanted = n.commands.filter((c) => bulkKind(c.argv)).length;
  if (!wanted) return { paths: out };
  // the exact words (normalizeCommand canonicalises options); anything the simple lexer refuses → unknown
  const cmds = lexSimple(command);
  if (!cmds) return { paths: out, unknown: 'a patch or recursive copy in a command this check cannot parse' };
  let dir = cwd;
  let found = 0;
  const patchPaths = (text: string): string[] => {
    const ps = new Set<string>();
    for (const m of text.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?([^\t\n]+)|^diff --git a\/(\S+) b\/(\S+)|^(?:rename|copy) (?:to|from) (\S+)/gm)) for (const g of [m[1], m[2], m[3], m[4]]) if (g && g !== '/dev/null') ps.add(g.trim());
    return [...ps];
  };
  for (const c of cmds) {
    const words = c.words.map((w) => w.value);
    if (words[0] === 'cd' && words.length === 2 && !c.words[1]!.expands) {
      dir = path.resolve(dir, words[1]!);
      continue;
    }
    const kind = bulkKind(words);
    if (!kind) continue;
    found++;
    if (c.words.some((w) => w.expands)) return { paths: out, unknown: `${kind} with a glob or variable in its arguments` };
    if (kind === 'git tree') {
      const t = gitTreeChanges(words, dir);
      if (typeof t === 'string') return { paths: out, unknown: t };
      for (const f of t.names) out.push({ path: path.join(t.root, f), by: `git ${words[1]}` });
      continue;
    }
    const args = words.slice(kind.startsWith('git ') ? 2 : 1);
    const p = parseOptions(BULK_SPECS[kind]!, args);
    if (!p) return { paths: out, unknown: `${kind} with an option this check does not model` };
    const val = (k: string) => p.values.get(k)?.at(-1);
    if (kind === 'git apply' || kind === 'git am' || kind === 'patch') {
      if (kind === 'git apply' && ['--check', '--stat', '--numstat', '--summary'].some((o) => p.seen.has(o)) && !p.seen.has('--apply')) continue;
      if (p.seen.has('--dry-run')) continue;
      const stdin = c.redirs.find((r) => r.op === '<')?.target;
      let files: string[];
      if (kind === 'patch') {
        // patch [options] [originalfile [patchfile]]: the original file is written too
        if (p.pos[0]) out.push({ path: path.resolve(dir, p.pos[0]), by: 'patch (the file named on the command line)' });
        const o = val('-o') ?? val('--output');
        if (o) out.push({ path: path.resolve(dir, o), by: 'patch -o' });
        files = [val('-i') ?? val('--input') ?? p.pos[1] ?? stdin?.value].filter((x): x is string => !!x);
      } else files = p.pos.length ? p.pos : stdin ? [stdin.value] : [];
      if (!files.length) return { paths: out, unknown: `${kind} reads the patch from stdin` };
      const base = path.resolve(dir, val('-d') ?? val('--directory') ?? '.');
      for (const f of files) {
        let text: string;
        try {
          text = fs.readFileSync(path.resolve(dir, f), 'utf8');
        } catch {
          return { paths: out, unknown: `cannot read the patch ${f}` };
        }
        const names = patchPaths(text);
        if (!names.length) return { paths: out, unknown: `no file names found in the patch ${f}` };
        for (const q of names) out.push({ path: path.resolve(base, q), by: `${kind} (from ${f})` }, { path: path.resolve(base, q.split('/').slice(1).join('/') || q), by: `${kind} (from ${f})` });
      }
      continue;
    }
    // recursive copies: every file of the source, under both ways it can land
    if (p.pos.some((x) => /^[^/]*:/.test(x))) return { paths: out, unknown: `${kind} to or from a remote location` };
    const target = val('-t') ?? val('--target-directory');
    if (p.pos.length < (target ? 1 : 2)) continue;
    const dest = path.resolve(dir, target ?? p.pos[p.pos.length - 1]!);
    const srcs = target ? p.pos : p.pos.slice(0, -1);
    for (const src of srcs) {
      const abs = path.resolve(dir, src);
      let count = 0;
      let tooMany = false;
      const walk = (q: string, rel: string) => {
        if (count++ > 5000) return void (tooMany = true);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(q);
        } catch {
          return;
        }
        out.push({ path: path.join(dest, rel), by: `${kind} (from ${src})` }, { path: path.join(dest, path.basename(abs), rel), by: `${kind} (from ${src})` });
        if (st.isDirectory()) for (const e of fs.readdirSync(q)) walk(path.join(q, e), path.join(rel, e));
      };
      walk(abs, '');
      if (tooMany) return { paths: out, unknown: `${kind} copies more than 5000 files` };
    }
  }
  if (found < wanted) return { paths: out, unknown: 'a patch or recursive copy behind a wrapper this check does not model' };
  return { paths: out };
}

/** The first self-modification file a shell command may write, judged on its semantic write targets. */
export function selfModShellWrite(command: string, cwd: string, workspace: string): { target: string; by: string } | null {
  let targets: { path: string; by: string }[] = [];
  try {
    targets = shellWriteTargets(command, cwd).map((w) => ({ path: w.path, by: w.by }));
  } catch {
    /* best effort; the raw detector still runs */
  }
  targets.push(...extraWriteTargets(command, cwd));
  const bulk = bulkWriteTargets(command, cwd);
  if (bulk.unknown) return { target: '(unknown files)', by: bulk.unknown };
  targets.push(...bulk.paths);
  for (const t of targets) {
    for (const p of expandGlobTarget(t.path)) {
      const s = selfModificationPath(p, workspace);
      if (s) return { target: s, by: t.by };
    }
    // a glob that matches nothing yet: could any of its segments name a protected file?
    if (/[*?[]/.test(t.path) && selfModificationPath(t.path, workspace, true)) return { target: t.path, by: `${t.by}, a pattern that can name a protected file` };
  }
  return null;
}

// --- amending commits (ported idea: Qwen Code destructive-commands.ts session-commit registry, c726d2c)

const sessionCommits = new Map<string, Set<string>>();

function gitHead(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Every `git … commit …` segment of a command (normalised), and whether it amends. */
function gitCommits(command: string): { amend: boolean }[] {
  const out: { amend: boolean }[] = [];
  const norm = normalizeCommand(command);
  for (const form of new Set([command, norm.resolved])) {
    for (const seg of splitCommandSegments(form)) {
      const m = seg.match(/(?:^|\s)git\s+(?:-\S+\s+(?:\S+\s+)?)*commit\b(.*)$/);
      if (m) out.push({ amend: /(?:^|\s)--amend\b/.test(m[1]!) });
    }
  }
  return out;
}

/** A commit amend is fine for a commit this session made; any other amend rewrites the user's history. */
export function amendFloor(command: string, session: string, cwd: string): string | null {
  if (!gitCommits(command).some((c) => c.amend)) return null;
  const head = gitHead(cwd);
  if (head && sessionCommits.get(session)?.has(head)) return null;
  return 'git commit --amend rewrites a commit this session did not create';
}

/** Record the commit a successful `git commit` produced (afterTool). Exported for tests. */
export function noteSessionCommit(session: string, cwd: string): void {
  const head = gitHead(cwd);
  if (!head) return;
  let s = sessionCommits.get(session);
  if (!s) sessionCommits.set(session, (s = new Set()));
  s.add(head);
  if (s.size > 500) s.delete(s.values().next().value as string);
}

export interface FloorHit {
  category: BlockCategory | 'self-modification';
  reason: string;
}

/**
 * The deterministic floor for auto mode: the C3 prefilter, self-modification and persistence files, and amending a
 * commit this session did not make. Pure code; a classifier never sees a call this returns a hit for.
 */
export function autoModeFloor(q: Pick<ApprovalQuery, 'tool' | 'input' | 'args' | 'reason'>, workspace: string, session = ''): FloorHit | null {
  const hit = prefilter(q, workspace);
  if (hit) return hit;
  for (const p of q.input.paths ?? []) {
    if (!p.write) continue;
    const s = selfModificationPath(p.path, workspace);
    if (s) return { category: 'self-modification', reason: `writes ${s}, which changes the agent, its hooks or CI, or runs code later` };
  }
  if (typeof q.input.command === 'string') {
    // a command whose working directory is outside the workspace (Qwen's external_directory fallback)
    if (q.input.cwd) {
      const rel = path.relative(physicalPath(workspace), physicalPath(path.resolve(workspace, q.input.cwd)));
      if (rel.startsWith('..') || path.isAbsolute(rel)) return { category: 'outside-workspace-write', reason: `runs in ${q.input.cwd}, outside the workspace` };
    }
    // the semantic write targets (quotes and escapes removed, wrappers resolved, cd followed, globs expanded) and the
    // writers the policy does not model (review finding 2)
    // re-check finding B: unpacking an archive always goes to the human, whatever its options and members
    const ex = archiveExtraction(q.input.command, q.input.cwd ?? workspace, workspace);
    if (ex) return { category: 'self-modification', reason: `${ex}: an archive's members can replace any file (build files, hooks, CI), so you decide` };
    const sw = selfModShellWrite(q.input.command, q.input.cwd ?? workspace, workspace);
    if (sw) return { category: 'self-modification', reason: `the command may write ${sw.target} (${sw.by}), which changes the agent, its hooks or CI, or runs code later` };
    // and the raw text (redirections, cp/tee/sed -i/tar -C/… targets, after cd): the ported Qwen detector
    const w = rawSelfModWrite(q.input.command, q.input.cwd ?? workspace, (abs) => selfModificationPath(abs, workspace) !== null);
    if (w) return { category: 'self-modification', reason: `the command may write ${path.isAbsolute(w.target) ? (selfModificationPath(w.target, workspace) ?? w.target) : w.target} (${w.how}), which changes the agent, its hooks or CI, or runs code later` };
    const a = amendFloor(q.input.command, session, q.input.cwd ?? workspace);
    if (a) return { category: 'destructive', reason: a };
  }
  return null;
}

// the policy applies the floor over allow rules too (no import cycle: registered here)
setAutoFloor((input: CheckInput, workspace: string) => {
  const hit = autoModeFloor({ tool: input.tool, input, args: input.command !== undefined ? { command: input.command } : {}, reason: '' }, workspace);
  return hit ? `${hit.category}: ${hit.reason}` : null;
});

// ------------------------------------------------------------ fast path

/** In-workspace edits that are not self-modification run without a classifier call. */
export function fastPathEdit(input: CheckInput, workspace: string): boolean {
  if (input.kind !== 'edit' || input.command !== undefined) return false;
  const paths = input.paths ?? [];
  if (!paths.length) return false;
  const ws = physicalPath(workspace);
  return paths.every((p) => {
    const phys = physicalPath(path.resolve(workspace, p.path));
    const rel = path.relative(ws, phys);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return !selfModificationPath(p.path, workspace);
  });
}

// ------------------------------------------------------------ the pipeline

export type AutoStep = 'ask-rule' | 'prefilter' | 'policy' | 'taint' | 'suspended' | 'fast-path' | 'cooldown' | 'classifier' | 'denial-tracking' | 'cache';

export interface AutoDecision {
  /** allow = run now; deny = refused back to the model; ask = the human decides (and no extension may allow). */
  decision: 'allow' | 'deny' | 'ask';
  step: AutoStep;
  reason: string;
  category?: string;
  stages?: StageRecord[];
  latencyMs?: number;
}

export interface AutoModeDeps {
  workspace: string;
  session: string;
  state: DenialState;
  setState: (s: DenialState) => void;
  config: AutoModeConfig;
  classify: StageFn;
  brief?: BriefEntry[];
  messages: ChatMessage[];
  /** Why the session is tainted (G2), if it is. */
  taintSource?: string;
  cache?: Map<string, true>;
  signal?: AbortSignal;
  now?: () => number;
}

/** Stable identity of a call (tool + normalised command / paths / domain / args). */
export function fingerprint(tool: string, input: Pick<CheckInput, 'kind' | 'command' | 'paths' | 'domain' | 'cwd'>, args: unknown): string {
  // scoped by working directory, as Qwen's action fingerprint: the same command elsewhere is a different action
  return JSON.stringify([tool, input.kind, input.command?.replace(/\s+/g, ' ').trim(), input.paths?.map((p) => `${p.write ? 'w' : 'r'}:${p.path}`).sort(), input.domain, input.command === undefined ? args : undefined, input.cwd ?? '']);
}

function userEpoch(brief: BriefEntry[] | undefined, messages: ChatMessage[]): string {
  const h = createHash('sha256');
  for (const e of brief ?? []) h.update(e.text + '\0');
  for (const m of messages) if (m.role === 'user' && !m._meta?.synthetic) h.update(contentToText(m.content) + '\0');
  return h.digest('hex').slice(0, 16);
}

/** Decide one call the policy left as 'ask'. Pure apart from the classifier call and the state it is given. */
export async function evaluateAutoMode(q: Pick<ApprovalQuery, 'tool' | 'input' | 'args' | 'reason'>, d: AutoModeDeps): Promise<AutoDecision> {
  const human = (step: AutoStep, reason: string, category?: string): AutoDecision => ({ decision: 'ask', step, reason, category });
  // 1. user ask rules: a human, always
  if (/^ask rule '/.test(q.reason)) return human('ask-rule', q.reason);
  // 2. the floor: no classifier, no fast path
  const floor = autoModeFloor(q, d.workspace, d.session);
  if (floor) return human('prefilter', floor.reason, floor.category);
  // anything the policy asked about for its own reason (not because the mode is auto) stays with the human
  if (!q.reason.startsWith(AUTO_MODE_REASON)) return human('policy', q.reason);
  // 3. Rule of Two: untrusted content was read, so an egress-capable call needs the human, not a model
  if (d.taintSource) {
    const hit = taintCategory({ tool: q.tool, input: q.input, args: q.args, reason: q.reason }, d.workspace);
    if (hit) return human('taint', `untrusted content was read in this session (${d.taintSource}), so ${hit.category.replace(/-/g, ' ')} needs your approval: ${hit.reason}`, hit.category);
  }
  // 4. suspended by the total-block cap
  if (d.state.suspended) return human('suspended', `auto mode is suspended for this session after ${d.state.totalBlock} classifier blocks; every call asks you until you run /auto resume (or select auto mode again)`);
  // 5. fast path
  if (fastPathEdit(q.input, d.workspace)) {
    d.setState(recordAllow(d.state));
    return { decision: 'allow', step: 'fast-path', reason: 'edit inside the workspace' };
  }
  // read-only shell commands (ls, git status, grep …) inside the workspace: the floor already took secrets and outside reads
  if (q.input.kind === 'execute' && typeof q.input.command === 'string' && readOnlyCommand(q.input.command, q.input.cwd ?? d.workspace, d.workspace)) {
    d.setState(recordAllow(d.state));
    return { decision: 'allow', step: 'fast-path', reason: 'read-only command inside the workspace' };
  }
  // 6. the classifier (circuit open → the human at once)
  const now = d.now ?? Date.now;
  if (classifierCoolingDown(d.state, now())) return human('cooldown', `the auto-mode classifier failed ${d.state.consecutiveUnavailable} times in a row; asking you instead until ${new Date(d.state.unavailableUntil).toLocaleTimeString()}`);
  const fp = fingerprint(q.tool, q.input, q.args);
  // the exact call auto mode blocked before: the model is asking for a human review (the idea of Qwen's one-shot
  // manual retry); one prompt, then the fingerprint is consumed
  if (wasBlocked(d.state, fp)) {
    d.setState({ ...d.state, blocked: d.state.blocked.filter((f) => f !== fp) });
    return human('denial-tracking', 'auto mode blocked this exact call before; you decide whether it runs');
  }
  const cacheKey = `${fp}\0${userEpoch(d.brief, d.messages)}`;
  if (d.cache?.has(cacheKey) && !wasBlocked(d.state, fp)) {
    d.setState(recordAllow(d.state));
    return { decision: 'allow', step: 'cache', reason: 'allowed earlier for the same requests' };
  }
  const blockedFps = new Set(d.state.blocked);
  const out = await classifyTwoStage(
    {
      workspace: d.workspace,
      brief: d.brief,
      messages: d.messages,
      pending: { tool: q.tool, kind: q.input.kind, command: q.input.command, paths: q.input.paths, domain: q.input.domain, args: q.args, cwd: q.input.cwd },
      blocked: (tool, args) => {
        const a = args as Record<string, unknown> | undefined;
        const cmd = typeof a?.command === 'string' ? a.command : undefined;
        return [...blockedFps].some((f) => {
          try {
            const [t, , c] = JSON.parse(f) as [string, string, string | undefined];
            return t === tool && (cmd === undefined || c === cmd.replace(/\s+/g, ' ').trim());
          } catch {
            return false;
          }
        });
      },
      limits: { ...DEFAULT_TRANSCRIPT_LIMITS, ...d.config.transcript },
    },
    d.classify,
    { stage1TimeoutMs: d.config.stage1TimeoutMs, stage2TimeoutMs: d.config.stage2TimeoutMs, stage1MaxTokens: d.config.stage1MaxTokens, stage2MaxTokens: d.config.stage2MaxTokens, hints: d.config.hints, signal: d.signal, now: d.now },
  );
  const base = { stages: out.stages, latencyMs: out.latencyMs };
  if (out.verdict === 'allow') {
    d.setState(recordAllow(d.state));
    d.cache?.set(cacheKey, true);
    if (d.cache && d.cache.size > d.config.cacheSize) d.cache.delete(d.cache.keys().next().value as string);
    return { decision: 'allow', step: 'classifier', reason: out.reason, ...base };
  }
  if (out.verdict === 'unavailable') {
    d.setState(recordUnavailable(d.state, d.config, now()));
    return { decision: 'ask', step: 'classifier', reason: `${out.reason}; asking you instead (auto mode never allows what it could not check)`, category: 'unavailable', ...base };
  }
  // 7. a block: denial tracking decides between "back to the model" and "the human"
  const next = recordBlock(d.state, fp, d.config);
  const why = `${out.category ? `${out.category}: ` : ''}${out.reason}`;
  if (next.suspended && !d.state.suspended) {
    d.setState(next);
    return { decision: 'ask', step: 'denial-tracking', reason: `auto mode blocked ${next.totalBlock} calls in this session and is now suspended (${why}); this and every later call ask you until /auto resume`, category: out.category, ...base };
  }
  if (reachedConsecutiveCap(next, d.config)) {
    d.setState(recordHumanReview(next));
    return { decision: 'ask', step: 'denial-tracking', reason: `auto mode blocked ${next.consecutiveBlock} calls in a row (${why}); you decide this one`, category: out.category, ...base };
  }
  d.setState(next);
  return { decision: 'deny', step: 'classifier', reason: `Blocked by auto mode: ${why}. ${DENIAL_GUIDANCE}`, category: out.category, ...base };
}

// ------------------------------------------------------------ per-session state

const states = new Map<string, DenialState>();
const caches = new Map<string, Map<string, true>>();

export function denialStateFor(session: string): DenialState {
  return states.get(rootSession(session)) ?? createDenialState();
}

/** Reset the counters, suspension and cache of a session (mode switch, /auto resume). */
export function resetAutoMode(session: string): void {
  states.delete(rootSession(session));
  caches.delete(rootSession(session));
}

// ------------------------------------------------------------ classifier transport

const injected = new WeakMap<object, StageFn>();
const clients = new WeakMap<object, StageFn>();

/** Tests and embedding apps can inject the auto-mode classifier transport for a config. */
export function setAutoClassifierFor(cfg: HarnessConfig, fn: StageFn | undefined): void {
  if (fn) injected.set(cfg, fn);
  else injected.delete(cfg);
}

/** Request fields that switch thinking off for a classifier call (Ollama: reasoning_effort "none"; llama.cpp/vLLM: chat_template_kwargs). */
export function thinkingOffBody(p: Pick<ModelProfile, 'baseUrl' | 'model'>): Record<string, unknown> {
  if (/:11434\b|ollama/i.test(p.baseUrl ?? '')) return { reasoning_effort: 'none' };
  // OpenRouter's unified reasoning parameter (v1.2 live run, 5 Nov: qwen3.8-27b spent the whole 24-token stage-1 budget
  // thinking, so every call fell through to stage 2; chat_template_kwargs is ignored there)
  if (/openrouter\.ai/i.test(p.baseUrl ?? '')) return { reasoning: { enabled: false } };
  return reasoningBody(selectOverlay(p.model ?? ''), 'off');
}

/** A StageFn over a real endpoint; metered and admitted like every other model call (S1, R4). */
export function llmStageFn(llm: LLMClient, onUsage?: (u: Usage, model: string) => void): StageFn {
  let healed = false;
  return async (messages, o) => {
    const send = () => withScopeOverride({ kind: 'approver', role: 'approver', metered: true }, () => llm.complete({ messages, maxTokens: o.maxTokens, temperature: 0, signal: o.signal, noStream: true }));
    let r;
    try {
      r = await send();
    } catch (e) {
      // an older server that rejects the thinking-off field: drop it once and retry
      const eb = llm.profile.extraBody ?? {};
      if (healed || !/reasoning|think|chat_template_kwargs|unknown field|unrecognized/i.test((e as Error).message) || !('reasoning_effort' in eb || 'chat_template_kwargs' in eb || 'reasoning' in eb)) throw e;
      healed = true;
      const { reasoning_effort: _r, chat_template_kwargs: _c, reasoning: _rs, ...rest } = eb as Record<string, unknown>;
      llm.profile = { ...llm.profile, extraBody: rest };
      r = await send();
    }
    onUsage?.(r.usage, r.model || llm.profile.model);
    return r.text;
  };
}

function stageFnFor(a: AgentApi, conf: AutoModeConfig): StageFn {
  const inj = injected.get(a.config);
  if (inj) return inj;
  const known = clients.get(a.config);
  if (known) return known;
  const base: ModelProfile = conf.profile && a.config.profiles[conf.profile] ? resolveProfile(a.config, conf.profile) : { ...a.smallLlm.profile };
  const extra = conf.extraBody ?? (conf.thinking === 'off' ? thinkingOffBody(base) : {});
  const llm = new LLMClient({ ...base, temperature: 0, extraBody: { ...(base.extraBody ?? {}), ...extra } });
  const fn = llmStageFn(llm, (u, model) => {
    if (!limitsConfig(a.config).ledger) return;
    try {
      recordUsage(a.config.homeDir, { ts: new Date().toISOString(), session: rootSession(a.sessionId), run: a.runId, depth: a.depth, model, promptTokens: u.promptTokens, completionTokens: u.completionTokens, costUsd: costOf(u, llm.profile), kind: 'approver' });
    } catch {
      /* never break approval on ledger errors */
    }
  });
  clients.set(a.config, fn);
  return fn;
}

/**
 * Rules whose tool part names no tool, kind or alias (and no MCP server that is configured but maybe not connected).
 * Wildcard tool parts are never reported.
 */
export function unmatchedRules(rules: string[], toolNames: string[], mcpServers: string[] = []): string[] {
  const known = new Set([...toolNames, 'read', 'edit', 'execute', 'network', 'meta', 'mcp', 'Read', 'Edit', 'Write', 'Bash']);
  return [...new Set(rules)].filter((r) => {
    const tool = r.match(/^([\w*.-]+)/)?.[1];
    if (!tool || tool.includes('*') || known.has(tool)) return false;
    // tools of an MCP server that is configured (it may connect later or have failed): not a typo of ours
    if (tool.startsWith('mcp__') && mcpServers.some((s) => tool.startsWith(`mcp__${s.replace(/[^A-Za-z0-9_-]/g, '_')}__`))) return false;
    return true;
  });
}

// ------------------------------------------------------------ the extension

/** Settle one auto-mode 'ask' for an agent (called by the approver extension in approver/index.ts). */
export async function approveAutoMode(a: AgentApi, q: ApprovalQuery): Promise<ApprovalDecision> {
  const conf = autoModeConfig(a.config);
  const session = rootSession(a.sessionId);
  let cache = caches.get(session);
  if (!cache) caches.set(session, (cache = new Map()));
  const agent = a.agent as { brief?: { entries?: BriefEntry[] }; taintSource?: string } | undefined;
  const dec = await evaluateAutoMode(q, {
    workspace: a.workspace,
    session,
    state: denialStateFor(session),
    setState: (s) => states.set(session, s),
    config: conf,
    classify: stageFnFor(a, conf),
    brief: agent?.brief?.entries,
    messages: a.messages,
    taintSource: agent?.taintSource,
    cache,
    signal: a.signal,
  });
  const st = denialStateFor(session);
  a.emit({ type: 'approval_auto', tool: q.tool, decision: dec.decision, by: dec.step, stage: dec.step, category: dec.category, reason: dec.reason, latencyMs: dec.latencyMs, stages: dec.stages });
  a.journal({
    type: 'approval_auto',
    mode: 'auto',
    tool: q.tool,
    decision: dec.decision,
    by: dec.step,
    stage: dec.step,
    category: dec.category,
    reason: dec.reason,
    latencyMs: dec.latencyMs,
    stages: dec.stages,
    command: q.input.command,
    paths: q.input.paths?.map((p) => p.path),
    denial: { consecutiveBlock: st.consecutiveBlock, totalBlock: st.totalBlock, consecutiveUnavailable: st.consecutiveUnavailable, totalUnavailable: st.totalUnavailable, suspended: st.suspended },
  });
  if (dec.step === 'denial-tracking' && st.suspended) a.notice('warn', `auto mode suspended: ${formatDenialState(st, conf)}`);
  if (dec.decision === 'allow') return { decision: 'allow', by: `auto mode ${dec.step}`, reason: dec.reason };
  if (dec.decision === 'deny') {
    // PermissionDenied hooks (as in Qwen Code): a notification only; a hook cannot turn a block into an allow
    const hooks = a.config.hooks?.PermissionDenied;
    if (hooks?.length) {
      try {
        const r = await runHooks(hooks, 'PermissionDenied', { session_id: a.sessionId, tool: q.tool, args: q.args, command: q.input.command, reason: dec.reason, category: dec.category }, a.workspace);
        a.journal({ type: 'hook', event: 'PermissionDenied', block: r.block, decision: r.decision });
      } catch {
        /* a failing hook never changes the decision */
      }
    }
    return { decision: 'deny', by: 'auto mode', reason: dec.reason };
  }
  return { decision: 'ask', by: `auto mode ${dec.step}`, reason: dec.reason };
}

registerAgentExtension({
  id: 'ws23-automode',
  onModeChange(a, from, to) {
    // a deliberate change of mode invalidates the history the counters are built on (AC4)
    if (from !== to) resetAutoMode(a.sessionId);
    if (to === 'auto') {
      const pol = (a.agent as { policy?: { suspendedAllowRules?: () => string[] } } | undefined)?.policy;
      const stripped = pol?.suspendedAllowRules?.() ?? [];
      if (stripped.length) a.notice('warn', `auto mode ignores these allow rules (they would let code run without the classifier): ${stripped.join(', ')}`);
    }
  },
  onSessionStart(a) {
    // a rule naming no tool (a typo) silently protects nothing: say so (Qwen warns for tools.disabled typos)
    if (a.depth === 0) {
      const ag = a.agent as { toolList?: { name: string }[]; shared?: { allTools?: { name: string }[] } } | undefined;
      const names = [...(ag?.shared?.allTools ?? []), ...(ag?.toolList ?? [])].map((t) => t.name);
      const p = a.config.permissions;
      const bad = unmatchedRules([...p.deny, ...(p.ask ?? []), ...p.allow], names, Object.keys(a.config.mcpServers ?? {}));
      if (names.length && bad.length) a.notice('warn', `permission rules that name no known tool (typo?): ${bad.join(', ')}`);
    }
    if (a.mode !== 'auto') return;
    // migration (v1.2): once per home, say what changed for configs that already said "auto"
    if (a.depth === 0) {
      const marker = path.join(a.config.homeDir, 'automode-v2-notice');
      try {
        if (!fs.existsSync(marker)) {
          a.notice('info', 'auto mode now uses a safety classifier (v1.2): routine commands run, risky ones ask you. The old no-classifier behaviour is called "yolo" (permissionMode: "yolo", --yolo).');
          fs.mkdirSync(a.config.homeDir, { recursive: true });
          fs.writeFileSync(marker, new Date().toISOString() + '\n');
        }
      } catch {
        /* a read-only home: the notice simply repeats */
      }
    }
    const pol = (a.agent as { policy?: { suspendedAllowRules?: () => string[] } } | undefined)?.policy;
    const stripped = pol?.suspendedAllowRules?.() ?? [];
    if (stripped.length) a.notice('warn', `auto mode ignores these allow rules (they would let code run without the classifier): ${stripped.join(', ')}`);
  },
  afterTool(a, call) {
    // remember commits this session made, so amending them is not a floor hit
    if (call.tool !== 'bash' || !call.ok) return;
    const cmd = (call.args as { command?: unknown } | undefined)?.command;
    if (typeof cmd === 'string' && gitCommits(cmd).length) noteSessionCommit(rootSession(a.sessionId), a.workspace);
  },
});

registerSlashCommand({
  name: 'auto',
  description: 'auto mode: show the denial counters, or resume after a suspension',
  usage: '[status|resume]',
  run(args, ctx) {
    const sub = args.trim() || 'status';
    const sid = String(ctx.agent?.sessionId ?? '');
    const conf = autoModeConfig(ctx.config);
    if (sub === 'resume') {
      resetAutoMode(sid);
      if (ctx.agent?.policy?.mode !== 'auto' && typeof ctx.agent?.setMode === 'function') ctx.agent.setMode('auto');
      return void ctx.write('  auto mode resumed: denial counters reset');
    }
    const mode = ctx.agent?.policy?.mode ?? ctx.config.permissionMode;
    const stripped: string[] = ctx.agent?.policy?.suspendedAllowRules?.() ?? [];
    ctx.write(`  mode: ${mode}\n  ${formatDenialState(denialStateFor(sid), conf)}\n  classifier profile: ${conf.profile ?? '(the main model)'}${stripped.length ? `\n  allow rules ignored in auto mode: ${stripped.join(', ')}` : ''}`);
  },
});
