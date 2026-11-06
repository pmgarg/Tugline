/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: the per-program read-only rules are ported from Qwen Code
 * packages/core/src/utils/shellAstParser.ts (commit c726d2c): evaluateGitSafety (GIT_EXTERNAL_HELPER_OPTION incl.
 * --open-files-in-pager, `grep -O*`, `%G?` formats, output options, branch/remote actions), evaluateFindSafety,
 * evaluateUniqSafety, the sort/tree output and `--co…` checks, the rg `--pre`/`--hostname-bin`/`-z` checks,
 * `printf -v`, the "expansion in arguments → unknown" and "variable assignment → unknown" rules, and the local git
 * config probe (gitConfigSafety.ts). Qwen parses with tree-sitter; this file uses its own small quote-aware lexer
 * (no new dependency) and is STRICTER: any unquoted glob, brace, tilde or `$` expansion, any leading assignment, any
 * wrapper, subshell, background job, here-document or write redirection, and any argument that resolves outside
 * the workspace (symlinks followed) makes the command "not read-only". Not read-only only means "ask the classifier".
 *
 * Re-check finding A (2026-11-05): option handling is an ALLOWLIST per program and git subcommand
 * (readonlyOptions.ts: exact long names, every letter of a short cluster, attached values only where listed); the
 * Qwen-derived rules in this file remain as a second check, so the fast path is never looser than Qwen's.
 *
 * N43 fast path for read-only shell commands (`ls`, `git status`, `grep -rn TODO src`, `git log | head`). It runs
 * AFTER the deterministic floor, so a command reaching here does not touch secrets the floor knows about; this file
 * decides whether it can run with no model call at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyAwkCommandSafety, classifySedCommandSafety } from './shellSafetyRules.js';
import { getLocalGitConfigRisk } from './gitConfigSafety.js';
import { READ_ONLY_PROGRAMS } from './readers.js';
import { readOnlyOptions } from './readonlyOptions.js';

type Safety = 'read-only' | 'write' | 'unknown';

interface Word {
  value: string;
  /** an unquoted glob, brace, leading tilde, or any `$`/backtick expansion */
  expands: boolean;
}

interface Simple {
  words: Word[];
  /** redirections: operator and target */
  redirs: { op: string; target: Word | undefined }[];
}

/** Split a command line into simple commands; undefined when it uses anything this lexer does not accept. */
export function lexSimple(command: string): Simple[] | undefined {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirs: [] };
  let i = 0;
  const s = command;
  const pushCmd = () => {
    if (cur.words.length || cur.redirs.length) out.push(cur);
    cur = { words: [], redirs: [] };
  };
  const readWord = (): Word | undefined => {
    let value = '';
    let expands = false;
    let started = false;
    while (i < s.length) {
      const c = s[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&' || c === '<' || c === '>') break;
      if (c === '(' || c === ')' || c === '`') return undefined; // subshells, substitutions
      if (c === '\\') {
        if (i + 1 >= s.length) return undefined;
        value += s[i + 1];
        i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) return undefined;
        value += s.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) {
          const d = s[j]!;
          if (d === '$' || d === '`') expands = true;
          if (d === '\\' && j + 1 < s.length) value += s[++j];
          else value += d;
        }
        if (j >= s.length) return undefined;
        i = j + 1;
      } else {
        if (c === '$' || c === '*' || c === '?' || c === '[' || c === '{' || c === '}' || (c === '~' && !started) || c === '!') expands = true;
        value += c;
        i++;
      }
      started = true;
    }
    return started ? { value, expands } : undefined;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '#' && !cur.words.length) return undefined; // comments hide intent; not worth the risk
    if (c === '\n' || c === ';') {
      pushCmd();
      i++;
      continue;
    }
    if (c === '|') {
      pushCmd();
      i += s[i + 1] === '|' ? 2 : s[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (s[i + 1] === '&') {
        pushCmd();
        i += 2;
        continue;
      }
      if (s[i + 1] === '>') {
        const op = s.startsWith('&>>', i) ? '&>>' : '&>';
        i += op.length;
        while (s[i] === ' ' || s[i] === '\t') i++;
        cur.redirs.push({ op, target: readWord() });
        continue;
      }
      return undefined; // background job
    }
    const r = /^(\d*)(>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)/.exec(s.slice(i));
    if (r) {
      i += r[0].length;
      while (s[i] === ' ' || s[i] === '\t') i++;
      cur.redirs.push({ op: r[2]!, target: readWord() });
      continue;
    }
    const w = readWord();
    if (!w) return undefined;
    cur.words.push(w);
  }
  pushCmd();
  return out;
}

// ------------------------------------------------------------ ported per-program rules (Qwen shellAstParser.ts)

const WRITE_ROOT_COMMAND = /^(chgrp|chmod|chown|cp|install|ln|mkdir|mkfifo|mknod|mv|rename|rm|rmdir|shred|touch|truncate|unlink)$/;
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['blame', 'branch', 'cat-file', 'diff', 'grep', 'log', 'ls-files', 'remote', 'rev-parse', 'show', 'status', 'describe']);
const WRITE_GIT_SUBCOMMAND = /^(add|am|checkout|cherry-pick|clean|clone|commit|fetch|gc|init|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch)$/;
const WRITE_GIT_REMOTE_ACTION = /^(add|remove|rm|rename|set-branches|set-head|set-url|update)$/;
const GIT_EXTERNAL_HELPER_OPTION = /^--(?:ext-diff|filters|show-signature|textconv|open-files-in-pager)(?:=|$)/;
const WRITE_GIT_BRANCH_FLAG = /^(?:-[cCdDmMu](?:.|$)|--(?:delete|move|copy|set-upstream(?:-to)?|unset-upstream|create-reflog|edit-description)(?:=|$))/;
const GIT_BRANCH_LIST_FLAG = /^(?:-[alr]|--(?:all|list|remotes|show-current|contains|no-contains|merged|no-merged|points-at))(?:=|$)/;
const BLOCKED_FIND_PREFIXES = ['-fls', '-fprint', '-fprintf'];
const FIND_VALUE_PREDICATE = /^-(?:[ac]?newer|newer[a-z]{2}|[acm](?:min|time)|context|fstype|gid|group|i?(?:lname|name|path|regex)|inum|links|maxdepth|mindepth|path|perm|printf|regextype|samefile|size|type|uid|used|user|wholename|xtype)$/;
const UNIQ_VALUE_OPTIONS = new Set('-f --skip-fields -s --skip-chars -w --check-chars'.split(' '));

function mergeSafety(...r: Safety[]): Safety {
  if (r.includes('write')) return 'write';
  if (r.includes('unknown')) return 'unknown';
  return 'read-only';
}
function beforeTerminator(args: string[]): string[] {
  const end = args.indexOf('--');
  return args.slice(0, end < 0 ? args.length : end);
}
function hasHelp(args: string[], valueOptions: string[] = []): boolean {
  return beforeTerminator(args).some((a, i, o) => /^(?:--help|--version)$/i.test(a) && !valueOptions.includes(o[i - 1]!));
}
function evaluateOutputOption(args: string[], long = true, short = true): Safety | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') break;
    if ((short && a === '-o') || (long && a === '--output')) return args[i + 1] ? 'write' : 'unknown';
    if (short && a.startsWith('-o') && a.length > 2) return 'write';
    if (long && a.startsWith('--output=')) return a.length > 9 ? 'write' : 'unknown';
  }
  return null;
}

function evaluateGitSafety(args: string[]): Safety {
  const first = args[0];
  if (!first) return 'read-only';
  if (first.startsWith('-')) return 'unknown'; // -c, -C, --exec-path, --config-env, --git-dir …
  const sub = first.toLowerCase();
  const rest = args.slice(1);
  const options = beforeTerminator(rest);
  const invokesHelper =
    options.some((a) => GIT_EXTERNAL_HELPER_OPTION.test(a)) || (sub === 'grep' && options.some((a) => a.startsWith('-O'))) || (['log', 'show'].includes(sub) && options.some((a) => /%G[?GKFPST]/.test(a)));
  if (WRITE_GIT_SUBCOMMAND.test(sub)) return 'write';
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return 'unknown';
  // Tugline: `diff --no-index` compares arbitrary files (paths are checked separately), `--output` writes
  if (['diff', 'log', 'show'].includes(sub)) {
    const out = evaluateOutputOption(rest, true, false);
    if (out) return out;
  }
  if (sub === 'blame' && options.some((a) => /^--output(?:=|$)/.test(a))) return 'unknown';
  if (sub !== 'branch' && hasHelp(rest)) return 'unknown';
  if (sub === 'remote') {
    const action = rest.find((a) => !a.startsWith('-'))?.toLowerCase();
    if (!action) return invokesHelper ? 'unknown' : 'read-only';
    if (['show', 'get-url'].includes(action)) return rest.some((a) => /^(?:add|remove|rm|rename|set-branches|set-head|set-url|update|prune)$/i.test(a)) || invokesHelper ? 'unknown' : 'read-only';
    if (WRITE_GIT_REMOTE_ACTION.test(action)) return 'write';
    return 'unknown';
  }
  if (sub === 'branch') {
    if (hasHelp(rest)) return 'unknown';
    if (rest.some((a) => WRITE_GIT_BRANCH_FLAG.test(a))) return options.some((a) => WRITE_GIT_BRANCH_FLAG.test(a)) ? 'write' : 'unknown';
    if (options.some((a) => GIT_BRANCH_LIST_FLAG.test(a))) return invokesHelper ? 'unknown' : 'read-only';
    if (rest.some((a) => !a.startsWith('-'))) return 'write';
    return rest.length === 0 ? 'read-only' : 'unknown';
  }
  return invokesHelper ? 'unknown' : 'read-only';
}

const FIND_WRITE_INVOKED = WRITE_ROOT_COMMAND;
function evaluateFindSafety(args: string[]): Safety {
  let result: Safety = 'read-only';
  for (let i = 0; i < args.length; i++) {
    const lower = args[i]!.toLowerCase();
    if (lower === '--') return mergeSafety(result, 'unknown');
    if (/^--(?:help|version)$/.test(lower)) return 'unknown';
    if (FIND_VALUE_PREDICATE.test(lower)) {
      if (!args[++i]?.match(/^[^-]/)) result = mergeSafety(result, 'unknown');
      continue;
    }
    if (lower === '-delete') return 'write';
    if (BLOCKED_FIND_PREFIXES.some((p) => lower.startsWith(p))) return 'write';
    if (['-exec', '-execdir', '-ok', '-okdir'].includes(lower)) {
      const invoked = args[i + 1]?.toLowerCase();
      return invoked && FIND_WRITE_INVOKED.test(invoked) ? 'write' : 'unknown';
    }
  }
  return result;
}

function evaluateUniqSafety(args: string[]): Safety {
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') return args.length - i + positional > 2 ? 'write' : 'read-only';
    else if (UNIQ_VALUE_OPTIONS.has(a)) {
      if (!args[++i]) return 'unknown';
    } else if (a === '-' || !a.startsWith('-')) positional++;
  }
  return positional >= 2 ? 'write' : 'read-only';
}

/** Per-program verdict (ported rules), for a command already known to have no expansions or assignments. */
export function programSafety(root: string, args: string[]): Safety {
  if (WRITE_ROOT_COMMAND.test(root)) return 'write';
  if (root === 'git') return evaluateGitSafety(args);
  if (root === 'find') return evaluateFindSafety(args);
  if (root === 'sed') return classifySedCommandSafety(args);
  if (root === 'awk') return classifyAwkCommandSafety(args);
  if (root === 'sort' || root === 'tree') {
    let r: Safety = evaluateOutputOption(args, root === 'sort') ?? 'read-only';
    if (hasHelp(args, ['-o', '--output'])) r = 'unknown';
    if (beforeTerminator(args).some((a) => /^(?:--o|-[^-]+o)/.test(a) || (root === 'sort' && a.startsWith('--co')))) r = mergeSafety(r, 'unknown');
    return r;
  }
  if (root === 'uniq') return hasHelp(args) ? 'unknown' : evaluateUniqSafety(args);
  if (root === 'printf' && beforeTerminator(args).some((a) => /^-[^-]*v/.test(a))) return 'unknown';
  if ((root === 'rg' || root === 'ripgrep') && beforeTerminator(args).some((a) => /^(?:--(?:hostname-bin|pre)(?:=|$)|--search-zip$|-[^-]*z)/.test(a))) return 'unknown';
  // Tugline: jq can read any file named in --rawfile/--slurpfile/-L (paths are checked), but never runs programs
  return READ_ONLY_PROGRAMS.has(root) ? 'read-only' : 'unknown';
}

// ------------------------------------------------------------ Tugline: containment

function physical(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  for (let head = abs; ; ) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return abs;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function inside(p: string, root: string): boolean {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** Path-like parts of an argument (the word itself, and the value of `--opt=value`). */
function pathCandidates(v: string): string[] {
  if (v === '-' || v === '--') return [];
  if (v.startsWith('-')) {
    const eq = v.indexOf('=');
    return eq > 0 ? [v.slice(eq + 1)] : [];
  }
  // `HEAD:path`, `rev:path` (git show) name a path inside the repository; a plain word is a relative path
  return [v];
}

/** True when the command only reads, and only inside the workspace (see the module comment). */
export function readOnlyCommand(command: string, cwd: string, workspace: string): boolean {
  if (!command.trim()) return false;
  const ws = physical(workspace);
  let dir = physical(cwd);
  if (!inside(dir, ws)) return false;
  const cmds = lexSimple(command);
  if (!cmds?.length) return false;
  let usesGit = false;
  let changedDir = false;
  for (const c of cmds) {
    if (!c.words.length) return false; // a bare redirection
    if (c.words.some((w) => w.expands)) return false; // globs, braces, ~, $VAR, "$(…)": Qwen's "expansion → unknown"
    const [prog, ...rest] = c.words.map((w) => w.value);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(prog!)) return false; // GIT_EXTERNAL_DIFF=… git diff, LD_PRELOAD=… ls
    if (prog!.includes('/') || prog !== prog!.toLowerCase() && prog !== '[') return false;
    if (!READ_ONLY_PROGRAMS.has(prog!)) return false;
    // re-check finding A: every option must be on the program's allowlist (exact long names, every letter of a
    // short cluster); the ported Qwen rules below are a second, independent check
    if (!readOnlyOptions(prog!, rest)) return false;
    if (programSafety(prog!, rest) !== 'read-only') return false;
    for (const r of c.redirs) {
      if (r.op === '<') {
        if (!r.target || r.target.expands || !inside(physical(path.resolve(dir, r.target.value)), ws)) return false;
        continue;
      }
      if ((r.op === '>&' || r.op === '<&') && r.target && /^(?:\d+|-)$/.test(r.target.value)) continue; // 2>&1
      if (['>', '>>', '&>', '&>>', '>|'].includes(r.op) && r.target?.value === '/dev/null' && !r.target.expands) continue;
      return false; // writes, here-documents, read-write
    }
    if (prog === 'cd') {
      const t = rest.filter((a) => a !== '--');
      if (t.length !== 1 || t[0] === '-') return false;
      dir = physical(path.resolve(dir, t[0]!));
      if (!inside(dir, ws)) return false;
      changedDir = true;
      continue;
    }
    if (prog === 'git') {
      usesGit = true;
      if (changedDir) return false; // git config of another directory (Qwen: cd before git → unknown)
    }
    // every argument that could be a path must resolve inside the workspace (symlinks followed)
    for (const a of rest) for (const cand of pathCandidates(a)) if (!inside(physical(path.resolve(dir, cand)), ws)) return false;
  }
  // a repository-local config can make diff/status/log/show run a program (Qwen's local git config probe)
  if (usesGit) {
    const risk = getLocalGitConfigRisk(dir);
    if (risk.diffExternal || risk.fsmonitor || risk.helper) return false;
  }
  return true;
}
