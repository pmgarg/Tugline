/**
 * The permission engine: deterministic code that decides, never the model.
 *
 * EAG lessons encoded here:
 *  - S11/S12: safety rules cannot live in the prompt (compaction erases them);
 *    the thing that grants permission is never reachable by the thing permitted.
 *  - S17: the agent may change the code but never the judge (protected paths),
 *    it may change the repo but not publish it (git push needs a human).
 *  - S16/S12: every refusal is recorded (the agent emits a 'refusal' event).
 *
 * Decision order:
 *   hard denies (protected paths, workspace jail, plan mode)
 *   → user deny rules
 *   → user ask rules (N43: never settled by the auto-mode classifier)
 *   → always-ask (dangerous commands, agent-control files, screen capture)
 *   → secret files
 *   → user allow rules (segment-aware for compound shell commands)
 *   → mode default.
 *
 * Honesty note (S8/S12): pattern checks on shell commands are a seatbelt, not a
 * sandbox. A determined attacker who controls the model can obfuscate commands.
 * The real boundaries are: ask mode for commands, the allowlist runner, and the
 * Docker sandbox (shell.sandbox = "docker").
 */
import { readOnlyCommand } from '../approver/readonly.js';
import { prefilter } from '../approver/prefilter.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import type { PermissionMode, ToolKind } from '../types.js';
import { ignoreIndexFor, type IgnoreIndex } from './ignore.js';
import { shellWriteTargets, type ShellWrite } from './shellWrites.js';
import { firstGuardedUnder, protectedSet, TOO_MANY } from './protectFs.js';
import { isDangerousAllowRule } from '../approver/dangerousRules.js';
import { shellOps } from '../approver/shellOps.js';
import { selfModificationPath } from '../approver/selfmod.js';

export type Decision = { decision: 'allow' | 'deny' | 'ask'; reason: string; hard?: boolean };

/** N43: the reason prefix of an 'ask' that only exists because the mode is auto (the auto pipeline may settle it). */
export const AUTO_MODE_REASON = 'auto mode:';

export interface CheckInput {
  tool: string;
  kind: ToolKind;
  /** Absolute paths read or written */
  paths?: { path: string; write: boolean }[];
  /** Shell command line */
  command?: string;
  /** Directory the command runs in (default: the workspace); relative write targets resolve against it (R1). */
  cwd?: string;
  /** URL host for network tools */
  domain?: string;
  /** MCP server trusted flag */
  trusted?: boolean;
  /** Ask in every mode except yolo, regardless of kind (e.g. desktop screen capture) */
  forceAsk?: string;
}

export interface PolicyOptions {
  workspace: string;
  mode: PermissionMode;
  allow: string[];
  deny: string[];
  /** N43: rules that always ask a human, in every mode; in auto mode the classifier never settles them. */
  ask?: string[];
  /** N43 (`autoMode.classifyAllShell`): in auto mode no allow rule settles a shell command; the classifier sees every one. */
  autoClassifyAllShell?: boolean;
  protectedPaths: string[];
  additionalDirectories: string[];
  /** Directories readable without asking (skills, bundled assets) */
  readOnlyRoots?: string[];
  /**
   * WS12 (N9): when set, writes are limited to these workspace-relative globs
   * (e.g. the doc-sync agent: ["docs/**", "README.md"]). A hard deny: no rule
   * or mode lifts it.
   */
  writeOnly?: string[];
  /**
   * SPEC C5: what a read of a `.tuglineignore`-d path does: 'ask' (default,
   * in every mode, because the user hid it on purpose) or 'deny'.
   */
  ignoreMode?: 'ask' | 'deny';
  /** Reads of `.gitignore`-d paths: 'allow' (default) or 'ask'. */
  gitignoreReads?: 'allow' | 'ask';
  /** Hide `.gitignore`-d paths from glob/grep/list_dir too (default true). */
  hideGitignored?: boolean;
  /**
   * v1.2 N45 (review F1): the VS Code "Run read-only commands" auto-approve category. A shell command that would
   * ask only because of the mode runs when N43's read-only fast path (`approver/readonly.ts`, WS23's reader list
   * and rules) accepts it. Checked after every other rule, so secret files, reads outside the roots, dangerous
   * commands, agent-control writes and deny rules still decide first. Honoured from the user config only.
   */
  readOnlyCommands?: boolean;
  /**
   * N36 (first layer, before the OS sandbox): credential stores (absolute or ~/…; default sandbox.denyRead's list).
   * Reading one, through a file tool or a shell command that names it, asks in every mode, auto included.
   */
  credentialPaths?: string[];
  /** N36 review finding 1: default stores the user lets commands read (sandbox.allowRead, user scope). */
  credentialAllowRead?: string[];
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const SECRET_FILE = picomatch(['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/.aws/**', '**/.ssh/**', '**/.gnupg/**', '**/.docker/config.json', '**/.kube/config'], { dot: true, nocase: true });

/**
 * Files that control the agent itself (its config, MCP servers, hooks, memory,
 * editor settings) or the CI. Writing them can plant persistent code execution
 * or loosen policy for the next session, so they ALWAYS ask — even in auto mode.
 */
export const AGENT_CONTROL_FILES = ['.mcp.json', '.vscode/**', '.tugline/**', '.claude/**', '.agents/**', '.cursor/**', 'AGENTS.md', 'CLAUDE.md', '**/AGENTS.md', '**/CLAUDE.md', '.github/**', '.gitlab-ci.yml', '.git/**', '.gitmodules', '.envrc', '.npmrc', '.pre-commit-config.yaml', '.husky/**'];
const AGENT_CONTROL = picomatch(AGENT_CONTROL_FILES, { dot: true, nocase: true });

// ------------------------------------------------------------ shell analysis

/** Split a command line into simple commands at ; && || | & and newlines (quote-aware). */
export function splitCommandSegments(cmd: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (cur.trim()) segs.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) segs.push(cur.trim());
  return segs;
}

/** Tokens of one simple command, quotes removed, leading env assignments and wrappers skipped. */
function tokens(seg: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) out.push(m[1] ?? m[2] ?? m[3]);
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
  while (out.length && ['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'xargs'].includes(out[0])) out.shift();
  return out;
}

const SHELLS = /^(.*\/)?(ba|z|da|k|fi|c|tc)?sh$/;
const DANGEROUS_RM_TARGET = /^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\.\.?\/?|\.\.\/\.\.\/?|\*|\.\/\*|\/(etc|usr|bin|var|home|Users|System|opt)(\/.*)?)$/;

/** Why this command needs a human even in auto mode, or null. Tokenized, not a single regex. */
export function dangerousReason(command: string): string | null {
  const c = command.trim();
  if (/\$\(\s*(curl|wget)|<\(\s*(curl|wget)|`\s*(curl|wget)/.test(c)) return 'executes downloaded code';
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c)) return 'fork bomb';
  if (/>\s*\/dev\/(sd|disk|nvme|hd)/.test(c)) return 'writes to a raw device';
  const segs = splitCommandSegments(c);
  // download piped into an interpreter: curl … | sh / python / node
  const raw = c.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  if (/(curl|wget)\b[^;&]*\|\s*(sudo\s+)?\S*(ba|z|da)?sh\b|(curl|wget)\b[^;&]*\|\s*\S*(python\d*|node|perl|ruby)\b/.test(raw)) return 'pipes a download into an interpreter';
  for (const seg of segs) {
    const t = tokens(seg);
    if (!t.length) continue;
    const prog = path.basename(t[0]);
    if (prog === 'sudo' || prog === 'doas' || prog === 'su') return 'privilege escalation';
    // N36 review finding 17: trusting a workspace lets its project config change the harness (and, with
    // trustProjectConfig, loosen the sandbox): only the user decides that, never the model
    if (t.some((x, k) => x === 'trust-project' && t[k - 1] === 'sandbox') || (/^(tug|tugline|oh)$/.test(prog) && t.some((x) => x === '--trust' || x.startsWith('--trust=')))) return 'changes which workspaces the harness trusts';
    if (['mkfs', 'fdisk', 'shutdown', 'reboot', 'halt', 'poweroff'].some((p) => prog === p || prog.startsWith(p + '.'))) return 'system-level destructive command';
    if (prog === 'diskutil' && t.includes('erase')) return 'erases a disk';
    if (prog === 'dd' && t.some((x) => x.startsWith('of=/dev/'))) return 'raw disk write';
    if (SHELLS.test(prog) && t.some((x) => x === '-c') ) {
      const inner = t[t.indexOf('-c') + 1] ?? '';
      const r = dangerousReason(inner);
      if (r) return r;
    }
    if (prog === 'rm') {
      const flags = t.slice(1).filter((x) => x.startsWith('-'));
      const recursive = flags.some((f) => f === '--recursive' || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
      const targets = t.slice(1).filter((x) => !x.startsWith('-'));
      if (recursive && targets.some((x) => DANGEROUS_RM_TARGET.test(x))) return 'recursive delete of a root, system, home or parent directory';
    }
    if (prog === 'chmod' && t.includes('-R') && t.some((x) => x === '/' || x === '~')) return 'recursive permission change on root/home';
    if (prog === 'git') {
      const args = t.slice(1);
      // find the subcommand, skipping global options (and their values)
      let i = 0;
      while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
      const sub = args[i] ?? '';
      const rest = args.slice(i + 1);
      if (sub === 'push') return 'publishes the change (the agent may change the repo, not publish it)';
      if (sub === 'reset' && rest.includes('--hard')) return 'discards uncommitted work';
      if (sub === 'clean' && rest.some((x) => /^-[a-z]*f/.test(x) || x === '--force')) return 'deletes untracked files';
      if ((sub === 'checkout' || sub === 'restore') && rest.some((x) => x === '.' || x === '--' && rest[rest.indexOf('--') + 1] === '.')) return 'discards uncommitted work';
      if (sub === 'branch' && rest.some((x) => x === '-D')) return 'force-deletes a branch';
    }
    if ((prog === 'npm' || prog === 'pnpm' || prog === 'yarn') && t[1] === 'publish') return 'publishes a package';
    if ((prog === 'twine' && t[1] === 'upload') || (prog === 'cargo' && t[1] === 'publish') || (prog === 'docker' && t[1] === 'push') || (prog === 'gh' && ['release', 'pr', 'repo'].includes(t[1]) && ['create', 'merge', 'delete'].includes(t[2]))) return 'publishes or changes a remote';
  }
  return null;
}

// ------------------------------------------------------------ paths

/**
 * Resolve a path the way the OS will when writing it: symlinks are followed even
 * when the final link is dangling, so links cannot escape the workspace or reach
 * a protected file.
 */
export function realResolve(p: string, depth = 0): string {
  const abs = path.resolve(p);
  if (depth > 16) return abs;
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(abs);
  } catch {
    st = undefined;
  }
  if (st?.isSymbolicLink()) {
    let link: string;
    try {
      link = fs.readlinkSync(abs);
    } catch {
      return abs;
    }
    // Relative link targets are relative to the link's (real) directory.
    return realResolve(path.resolve(realResolve(path.dirname(abs), depth + 1), link), depth + 1);
  }
  if (st) {
    try {
      return fs.realpathSync(abs);
    } catch {
      return abs;
    }
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(realResolve(parent, depth + 1), path.basename(abs));
}

export function isInside(child: string, parent: string): boolean {
  const a = CASE_INSENSITIVE_FS ? child.toLowerCase() : child;
  const b = CASE_INSENSITIVE_FS ? parent.toLowerCase() : parent;
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Match "tool" / "tool(spec)" rules. `*` is a wildcard in tool names and specs. */
function wildcard(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 's');
}

/** Commands containing substitution or redirection are never auto-allowed by a prefix rule. */
const UNSAFE_FOR_RULES = /\$\(|`|<\(|>\(|>|<|\n/;

export function ruleMatches(rule: string, input: CheckInput, workspace: string): boolean {
  const m = rule.match(/^([\w*.-]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const [, toolPat, spec] = m;
  const kindAlias: Record<string, ToolKind> = { Read: 'read', Edit: 'edit', Write: 'edit', Bash: 'execute' };
  // N43 (capability from Qwen Code rule-parser TOOL_NAME_ALIASES): Claude-Code / Qwen tool names name our tools
  const nameAlias: Record<string, string[]> = { WebFetch: ['web_fetch'], WebSearch: ['web_search'], Grep: ['grep'], Glob: ['glob'], LS: ['list_dir'], ReadFile: ['read_file'], WriteFile: ['write_file'], Task: ['task'], 'Agent': ['task'], TodoWrite: ['todo_write'], NotebookEdit: ['notebook_edit'], MultiEdit: ['multi_edit'] };
  const toolOk = wildcard(toolPat).test(input.tool) || kindAlias[toolPat] === input.kind || toolPat === input.kind || (nameAlias[toolPat]?.includes(input.tool) ?? false);
  if (!toolOk) return false;
  if (spec === undefined || spec === '' || spec === '*') return true;
  if (spec.startsWith('domain:')) return !!input.domain && wildcard(spec.slice(7)).test(input.domain);
  if (input.command !== undefined) {
    // "npm test:*" (Claude Code style prefix) or "npm test*"
    const s = spec.endsWith(':*') ? spec.slice(0, -2) + '*' : spec;
    const re = wildcard(s);
    const cmd = input.command.trim();
    if (re.test(cmd) && !UNSAFE_FOR_RULES.test(cmd) && splitCommandSegments(cmd).length <= 1) return true;
    // Compound command: EVERY segment must match the rule on its own.
    const segs = splitCommandSegments(cmd);
    if (segs.length > 1 && !UNSAFE_FOR_RULES.test(cmd)) return segs.every((x) => re.test(x));
    return false;
  }
  if (input.paths?.length) {
    // `~/…` in a path rule is the home directory (N43, as Qwen's path patterns)
    const pspec = /^~(?=\/)/.test(spec) ? os.homedir() + spec.slice(1) : spec;
    const isMatch = picomatch(pspec, { dot: true, nocase: CASE_INSENSITIVE_FS });
    return input.paths.every((p) => {
      const rel = path.relative(workspace, p.path).split(path.sep).join('/');
      return isMatch(rel) || isMatch(p.path);
    });
  }
  return false;
}

/** R1: a check every shell command must pass (the dynamic guard refuses when it cannot vouch for the protected set). */
let shellGate: ((workspace: string) => string | null) | undefined;
export function setShellGate(g: ((workspace: string) => string | null) | undefined): void {
  shellGate = g;
}

/** N43: the auto-mode floor (the approver's prefilter), registered by src/core/approver so policy.ts has no import cycle. */
let autoFloor: ((input: CheckInput, workspace: string) => string | null) | undefined;
export function setAutoFloor(f: ((input: CheckInput, workspace: string) => string | null) | undefined): void {
  autoFloor = f;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** N36: credential stores a read or a command reaches (credentials.ts; first layer, every mode). */
export { credentialReference } from './credentials.js';
import { credentialReference } from './credentials.js';

/** Writes to scratch locations and devices need no approval even though they are outside the workspace. */
function scratchWrite(p: string): boolean {
  if (/^\/dev\//.test(p)) return true;
  const real = realResolve(p);
  return ['/tmp', '/private/tmp', '/var/tmp', os.tmpdir()].some((r) => isInside(real, realResolve(r)));
}

/**
 * A glob write target (`rm tests/*`, `rm -rf *`) expanded the way the shell would
 * (no dotfiles for a bare `*`). An unmatched glob is returned as is, so a literal
 * name still matches protected patterns.
 */
export function expandGlobTarget(abs: string): string[] {
  if (!/[*?[]/.test(abs)) return [abs];
  const parts = abs.split('/');
  const first = parts.findIndex((x) => /[*?[]/.test(x));
  let bases = [parts.slice(0, first).join('/') || '/'];
  for (const seg of parts.slice(first)) {
    if (!/[*?[]/.test(seg)) {
      bases = bases.map((b) => path.join(b, seg));
      continue;
    }
    const m = picomatch(seg, { dot: seg.startsWith('.') });
    const next: string[] = [];
    for (const b of bases) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(b);
      } catch {
        /* not a directory */
      }
      for (const n of names) if (m(n)) next.push(path.join(b, n));
      if (next.length > 5000) break;
    }
    bases = next;
  }
  return bases.length ? bases : [abs];
}

const INTERPRETERS = /^(python\d*(\.\d+)?|node|deno|bun|bash|sh|zsh|perl|ruby|php|npx|pnpx|bunx|uvx|eval|exec|env|xargs|powershell|pwsh|cmd)$/;

export class PermissionPolicy {
  private sessionAllow: string[] = [];
  private wsReal: string;
  private ignore: IgnoreIndex;

  constructor(public opts: PolicyOptions) {
    this.wsReal = realResolve(opts.workspace);
    this.ignore = ignoreIndexFor(this.wsReal);
  }

  /**
   * SPEC C5: whether search/listing tools (glob, grep, list_dir, @-mentions)
   * should hide this path. True for `.tuglineignore`-d paths and, unless
   * `hideGitignored` is false, `.gitignore`-d ones. Paths outside the workspace
   * are never hidden by workspace ignore files.
   */
  isHidden(abs: string): boolean {
    const rel = this.rel(abs);
    if (rel === null || rel === '') return false;
    if (this.ignore.harnessIgnored(rel)) return true;
    return this.opts.hideGitignored !== false && this.ignore.gitIgnored(rel);
  }

  /** Which ignore layer (if any) hides this path from the agent's reads. */
  ignoredBy(abs: string): 'tuglineignore' | 'gitignore' | null {
    const rel = this.rel(abs);
    if (rel === null || rel === '') return null;
    if (this.ignore.harnessIgnored(rel)) return 'tuglineignore';
    if (this.ignore.gitIgnored(rel)) return 'gitignore';
    return null;
  }

  get mode(): PermissionMode {
    return this.opts.mode;
  }
  set mode(m: PermissionMode) {
    this.opts.mode = m;
  }

  /** Session "always allow" rules (for `/permissions`). */
  sessionRules(): string[] {
    return [...this.sessionAllow];
  }

  removeSessionRule(rule: string): boolean {
    const i = this.sessionAllow.indexOf(rule);
    if (i >= 0) this.sessionAllow.splice(i, 1);
    return i >= 0;
  }

  addSessionRule(rule: string): void {
    if (!this.sessionAllow.includes(rule)) this.sessionAllow.push(rule);
  }

  private rel(abs: string): string | null {
    const real = realResolve(abs);
    if (!isInside(real, this.wsReal)) return null;
    return path.relative(this.wsReal, real).split(path.sep).join('/');
  }

  /** Which protected pattern (if any) covers this absolute path (after symlink resolution). */
  protectedPattern(abs: string): string | null {
    const rel = this.rel(abs);
    if (rel === null) return null;
    for (const pat of this.opts.protectedPaths) if (picomatch(pat, { dot: true, nocase: true })(rel)) return pat;
    return null;
  }

  private inAllowedRoots(abs: string, write: boolean): boolean {
    const real = realResolve(abs);
    if (isInside(real, this.wsReal)) return true;
    for (const d of this.opts.additionalDirectories) if (isInside(real, realResolve(d))) return true;
    if (!write) for (const d of this.opts.readOnlyRoots ?? []) if (isInside(real, realResolve(d))) return true;
    return false;
  }

  private shellWrites(input: CheckInput): ShellWrite[] {
    try {
      return shellWriteTargets(input.command!, input.cwd ?? this.opts.workspace);
    } catch {
      return [];
    }
  }

  /** Why a shell write target is a hard deny (protected path or agent-control file), or null. */
  private shellWriteDenied(w: ShellWrite): string | null {
    const targets = expandGlobTarget(w.path);
    for (const t of targets) {
      const rel = this.rel(t);
      if (rel === null) continue;
      const shown = rel || '.';
      const pat = this.protectedPattern(t);
      if (pat) return `refusing to run: the command writes ${shown} (${w.by}), which matches protected pattern '${pat}'. Protected files are the judge (tests, CI, config) — change the code, not the judge.`;
      if (rel && AGENT_CONTROL(rel)) return `refusing to run: the command writes ${shown} (${w.by}), which controls the agent, its tools or CI. Use the file tools, which ask the user.`;
      // Removing or replacing a directory removes everything under it.
      if (w.op === 'remove' && isDir(t)) {
        const under = firstGuardedUnder(this.wsReal, protectedSet([...this.opts.protectedPaths, ...AGENT_CONTROL_FILES]), rel);
        if (under === TOO_MANY) continue; // too big to check statically; the dynamic guard still watches the protected set
        if (under) return `refusing to run: the command removes or replaces ${shown} (${w.by}), which contains protected or agent-control path ${under}. Protected files are the judge — change the code, not the judge.`;
      }
    }
    return null;
  }

  /**
   * N43 (ported idea: Qwen Code dangerousRules.ts): in auto mode a broad allow rule for an interpreter, a shell or
   * a script runner (`bash(python*)`, `bash`, `bash(npm run*)`) would let any code run without the classifier ever
   * seeing it, so such rules are ignored while the mode is auto (never deleted; they apply again in other modes).
   */
  activeAllowRules(): string[] {
    const all = [...this.opts.allow, ...this.sessionAllow];
    if (this.opts.mode !== 'auto') return all;
    return all.filter((r) => !isDangerousAllowRule(r) && !(this.opts.autoClassifyAllShell && /^(?:bash|Bash|execute|shell|job_\w*|monitor|[\w-]*\*[\w*-]*)(?:\(|$)/.test(r.trim())));
  }

  /** The allow rules auto mode is currently ignoring (for /auto status and the session notice). */
  suspendedAllowRules(): string[] {
    return this.opts.mode === 'auto' ? [...this.opts.allow, ...this.sessionAllow].filter((r) => isDangerousAllowRule(r)) : [];
  }

  /**
   * N43 (capability from Qwen Code shell-semantics.ts): a deny or ask rule on a file or web tool with a path or
   * domain (`read_file(secrets/**)`, `Write(docs/**)`, `web_fetch(domain:x.com)`) also covers a shell command that
   * performs the same operation (`cat secrets/k`, `echo > docs/x`, `curl https://x.com`). Escalation only.
   */
  private virtualRuleHit(input: CheckInput, rules: string[]): { rule: string; what: string } | null {
    if (input.kind !== 'execute' || typeof input.command !== 'string') return null;
    const fileRules = rules.filter((r) => /\(.+\)$/s.test(r) && !/^(?:bash|Bash|execute|shell|\*)\(/.test(r));
    if (!fileRules.length) return null;
    const ops = shellOps(input.command, input.cwd ?? this.opts.workspace);
    const show = (p: string) => path.relative(this.opts.workspace, p) || p;
    for (const r of fileRules) {
      for (const p of ops.reads) for (const tool of ['read_file']) if (ruleMatches(r, { tool, kind: 'read', paths: [{ path: p, write: false }] }, this.opts.workspace)) return { rule: r, what: `reads ${show(p)}` };
      for (const p of ops.writes) for (const tool of ['write_file', 'edit_file']) if (ruleMatches(r, { tool, kind: 'edit', paths: [{ path: p, write: true }] }, this.opts.workspace)) return { rule: r, what: `writes ${show(p)}` };
      for (const d of ops.domains) if (ruleMatches(r, { tool: 'web_fetch', kind: 'network', domain: d }, this.opts.workspace)) return { rule: r, what: `contacts ${d}` };
    }
    return null;
  }

  private allowedByRule(input: CheckInput): string | undefined {
    return this.activeAllowRules().find((r) => ruleMatches(r, input, this.opts.workspace));
  }

  check(input: CheckInput): Decision {
    const mode = this.opts.mode;
    // ---- hard denies: no rule or mode can lift these ----
    for (const p of input.paths ?? []) {
      if (p.write) {
        const pat = this.protectedPattern(p.path);
        if (pat) return { decision: 'deny', hard: true, reason: `refusing to modify ${path.relative(this.opts.workspace, p.path)}: it matches protected pattern '${pat}'. Protected files are the judge (tests, CI, config) — change the code, not the judge.` };
        if (!this.inAllowedRoots(p.path, true)) return { decision: 'deny', hard: true, reason: `refusing to write outside the workspace: ${p.path}${realResolve(p.path) !== path.resolve(p.path) ? ` (resolves to ${realResolve(p.path)})` : ''}` };
        if (this.opts.writeOnly) {
          const rel = this.rel(p.path);
          if (rel === null || !picomatch(this.opts.writeOnly, { dot: true, nocase: CASE_INSENSITIVE_FS })(rel)) return { decision: 'deny', hard: true, reason: `refusing to modify ${rel ?? p.path}: this agent may only write ${this.opts.writeOnly.join(', ')} (permissions.writeOnly)` };
        }
      }
    }
    // R1: a shell command's own write targets get the same hard denies as file-tool writes.
    const shellWrites = input.kind === 'execute' && typeof input.command === 'string' ? this.shellWrites(input) : [];
    for (const w of shellWrites) {
      const denied = this.shellWriteDenied(w);
      if (denied) return { decision: 'deny', hard: true, reason: denied };
    }
    if (input.kind === 'execute' && typeof input.command === 'string' && shellGate) {
      const gate = shellGate(this.opts.workspace);
      if (gate) return { decision: 'deny', hard: true, reason: gate };
    }
    if (mode === 'plan' && (input.kind === 'edit' || input.kind === 'execute')) {
      return { decision: 'deny', hard: true, reason: 'plan mode is read-only: research and present a plan, then call exit_plan_mode.' };
    }
    // ---- user deny rules ----
    for (const r of this.opts.deny) if (ruleMatches(r, input, this.opts.workspace)) return { decision: 'deny', reason: `denied by rule '${r}'` };
    const vDeny = this.virtualRuleHit(input, this.opts.deny);
    if (vDeny) return { decision: 'deny', reason: `denied by rule '${vDeny.rule}' (the command ${vDeny.what})` };
    // ---- user ask rules (N43): a human decides, whatever the mode or allow rules say ----
    for (const r of this.opts.ask ?? []) if (ruleMatches(r, input, this.opts.workspace)) return { decision: 'ask', reason: `ask rule '${r}' always needs a human` };
    const vAsk = this.virtualRuleHit(input, this.opts.ask ?? []);
    if (vAsk) return { decision: 'ask', reason: `ask rule '${vAsk.rule}' always needs a human (the command ${vAsk.what})` };
    // ---- ignore files (SPEC C5): reads of paths the user hid from the agent ----
    for (const p of input.paths ?? []) {
      if (p.write) continue;
      const by = this.ignoredBy(p.path);
      if (!by) continue;
      const specific = this.activeAllowRules().find((r) => /\([^*]+\)$/.test(r) && ruleMatches(r, input, this.opts.workspace));
      if (by === 'tuglineignore') {
        if ((this.opts.ignoreMode ?? 'ask') === 'deny') return { decision: 'deny', reason: `${path.relative(this.opts.workspace, p.path)} is listed in .tuglineignore (permissions.ignoreMode = deny)` };
        if (!specific) return { decision: 'ask', reason: `${path.relative(this.opts.workspace, p.path)} is listed in .tuglineignore` };
      } else if (this.opts.gitignoreReads === 'ask' && !specific) return { decision: 'ask', reason: `${path.relative(this.opts.workspace, p.path)} is git-ignored` };
    }
    // ---- N36: credential stores ask in every mode, auto included (the OS sandbox hides them as well) ----
    const cred = credentialReference({ command: input.kind === 'execute' ? input.command : undefined, paths: (input.paths ?? []).filter((p) => !p.write).map((p) => p.path), cwd: input.cwd ?? this.opts.workspace, workspace: this.opts.workspace, credentialPaths: this.opts.credentialPaths, allowRead: this.opts.credentialAllowRead });
    if (cred) {
      // only an explicit, wildcard-free rule naming this exact call can skip the prompt
      const rule = [...this.opts.allow, ...this.sessionAllow].find((r) => /\([^*]+\)$/.test(r) && ruleMatches(r, input, this.opts.workspace));
      if (!rule) return { decision: 'ask', reason: `${cred}; ${/daemon/.test(cred) ? 'this' : 'credential stores'} need${/daemon/.test(cred) ? 's' : ''} your approval in every mode` };
    }
    // ---- always ask (even in auto): dangerous commands and agent-control files ----
    const danger = input.command ? dangerousReason(input.command) : null;
    if (danger) return { decision: 'ask', reason: `potentially dangerous: ${danger}` };
    for (const w of shellWrites) {
      if (this.inAllowedRoots(w.path, true) || scratchWrite(w.path)) continue;
      const rule = this.activeAllowRules().find((r) => /\([^*]+\)$/.test(r) && ruleMatches(r, input, this.opts.workspace));
      if (!rule) return { decision: 'ask', reason: `the command writes outside the workspace: ${w.path} (${w.by})` };
    }
    for (const p of input.paths ?? []) {
      if (!p.write) continue;
      const rel = this.rel(p.path);
      if (rel !== null && AGENT_CONTROL(rel)) {
        // Only an explicit, wildcard-free rule naming this file can skip the prompt.
        const rule = this.activeAllowRules().find((r) => /\([^*]+\)$/.test(r) && ruleMatches(r, input, this.opts.workspace));
        if (!rule) return { decision: 'ask', reason: `${rel} controls the agent, its tools or CI; changes always need approval` };
      }
    }
    // N43 (review finding 8): acceptEdits auto-approves edits, but not of files that change the agent or run code
    // later (package.json scripts, Makefile, CI, rc files …); those ask, as they are on auto mode's floor
    if (mode === 'acceptEdits' && input.kind === 'edit') {
      for (const p of input.paths ?? []) {
        if (!p.write) continue;
        const sm = selfModificationPath(p.path, this.opts.workspace);
        const rule = this.activeAllowRules().find((r) => /\([^*]+\)$/.test(r) && ruleMatches(r, input, this.opts.workspace));
        if (sm && !rule) return { decision: 'ask', reason: `${sm} changes the agent, its hooks or CI, or runs code later; changes always need approval` };
      }
    }
    if (input.forceAsk && mode !== 'yolo' && !this.allowedByRule(input)) return { decision: 'ask', reason: input.forceAsk };
    // ---- secret files (checked on the resolved path too) ----
    for (const p of input.paths ?? []) {
      if (p.write) continue;
      const candidates = [p.path, realResolve(p.path)].map((x) => x.split(path.sep).join('/'));
      if (candidates.some((x) => SECRET_FILE(x)) && mode !== 'yolo') {
        const specific = this.activeAllowRules().find((r) => r.includes('(') && ruleMatches(r, input, this.opts.workspace));
        if (!specific) return { decision: 'ask', reason: 'file may contain secrets' };
      }
      if (!this.inAllowedRoots(p.path, false) && !this.allowedByRule(input)) return { decision: 'ask', reason: 'reads a file outside the workspace' };
    }
    // ---- user allow rules ----
    const rule = this.allowedByRule(input);
    if (rule) {
      // N43: in auto mode the deterministic prefilter is a floor that an allow rule does not lift either.
      const floor = mode === 'auto' && autoFloor ? autoFloor(input, this.opts.workspace) : null;
      if (floor) return { decision: 'ask', reason: `auto mode floor (${floor}); allow rule '${rule}' does not lift it` };
      return { decision: 'allow', reason: `allowed by rule '${rule}'` };
    }
    // ---- mode defaults ----
    // N43: in auto mode everything that is not read-only is left as 'ask' with an `AUTO_MODE_REASON` reason, so the
    // auto-mode pipeline (src/core/approver/automode.ts) decides it: prefilter floor → fast paths → classifier.
    // Without that pipeline loaded the call simply reaches the human (fail closed).
    switch (input.kind) {
      case 'read':
      case 'meta':
        return { decision: 'allow', reason: 'read-only' };
      case 'network':
        if (mode === 'auto') return { decision: 'ask', reason: `${AUTO_MODE_REASON} network access` };
        return { decision: mode === 'ask' ? 'ask' : 'allow', reason: `network access in ${mode} mode` };
      case 'edit':
        if (mode === 'auto') return { decision: 'ask', reason: `${AUTO_MODE_REASON} edit` };
        return { decision: mode === 'ask' ? 'ask' : 'allow', reason: `edit in ${mode} mode` };
      case 'execute':
        if (mode === 'auto') return { decision: 'ask', reason: `${AUTO_MODE_REASON} command` };
        // WS24 N45: "Run read-only commands" (user scope) → N43's read-only fast path, after the deterministic floor
        // (secret files such as .env, credential stores, env dumps …)
        if (mode !== 'yolo' && this.opts.readOnlyCommands && typeof input.command === 'string' && !prefilter({ tool: input.tool, input, args: { command: input.command }, reason: `command in ${mode} mode` }, this.opts.workspace) && readOnlyCommand(input.command, input.cwd ?? this.opts.workspace, this.opts.workspace)) return { decision: 'allow', reason: 'read-only command inside the workspace (auto-approve: read-only commands)' };
        return { decision: mode === 'yolo' ? 'allow' : 'ask', reason: `command in ${mode} mode` };
      case 'mcp':
        if (input.trusted) return { decision: 'allow', reason: 'trusted MCP server' };
        if (mode === 'auto') return { decision: 'ask', reason: `${AUTO_MODE_REASON} MCP tool` };
        return { decision: mode === 'yolo' ? 'allow' : 'ask', reason: `MCP tool in ${mode} mode` };
    }
  }

  /**
   * A narrow "always allow" rule to offer for this call. Never a blanket rule for
   * interpreters, compound commands, secret files or agent-control files.
   */
  static suggestRule(input: CheckInput, workspace?: string): string | undefined {
    if (input.command !== undefined) {
      const cmd = input.command.trim();
      if (UNSAFE_FOR_RULES.test(cmd) || splitCommandSegments(cmd).length > 1) return undefined;
      const t = tokens(cmd);
      if (!t.length) return undefined;
      if (INTERPRETERS.test(path.basename(t[0])) && !(t[1] === '-m' && t[2])) return `${input.tool}(${cmd})`;
      const words = t.slice(0, t[1] && !t[1].startsWith('-') ? 2 : 1).join(' ');
      return `${input.tool}(${words}*)`;
    }
    if (input.domain) return `${input.tool}(domain:${input.domain})`;
    if (input.paths?.length && workspace) {
      const rels = input.paths.map((p) => path.relative(workspace, p.path).split(path.sep).join('/'));
      if (input.kind === 'read') return rels.length === 1 ? `${input.tool}(${rels[0]})` : undefined;
      if (rels.some((r) => AGENT_CONTROL(r) || r.startsWith('..'))) return rels.length === 1 ? `${input.tool}(${rels[0]})` : undefined;
      const dir = path.posix.dirname(rels[0]);
      return `${input.tool}(${dir === '.' ? '*' : `${dir}/**`})`;
    }
    if (input.kind === 'mcp' || input.kind === 'network') return input.tool;
    return undefined;
  }
}
