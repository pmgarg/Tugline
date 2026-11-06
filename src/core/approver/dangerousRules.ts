/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: ported from Qwen Code
 * packages/core/src/permissions/dangerousRules.ts (commit c726d2c). Changed to
 * our rule syntax (`tool(spec)` strings, `:*` prefix form, kind aliases such as
 * `Bash`/`execute`, wildcard tool names), dropped the Agent/Skill tool rules
 * (our subagents and skills run every call through the same permission engine,
 * so an allow rule on them grants nothing), and added `bash -c`-style shells,
 * `xargs`, `env`, `sudo`, `uv run`, `poetry run`, `deno`/`tsx`-style runners.
 * Used by policy.ts: a dangerous rule is IGNORED while the mode is `auto`
 * (never deleted), so it cannot let code run without the classifier.
 */

/**
 * Programs that, as the leading command of a shell allow rule, run arbitrary code
 * the classifier would never see: shells, interpreters, script runners, package
 * runners that fetch and execute code, remote shells and eval-like builtins.
 */
export const DANGEROUS_INTERPRETERS: readonly string[] = Object.freeze([
  // Unix and Windows shells
  'bash', 'sh', 'zsh', 'fish', 'csh', 'tcsh', 'dash', 'ksh', 'cmd', 'pwsh', 'powershell',
  // interpreters
  'python', 'python2', 'python3', 'pypy', 'pypy3', 'node', 'nodejs', 'deno', 'tsx', 'ts-node', 'bun', 'ruby', 'perl', 'php', 'lua', 'julia', 'r', 'rscript', 'groovy', 'awk', 'gawk', 'osascript',
  // build and package tools that run project scripts
  'cargo', 'npm', 'pnpm', 'yarn', 'make', 'gmake', 'gradle', 'gradlew', 'mvn', 'rake', 'task', 'just', 'go', 'uv', 'poetry', 'pipenv', 'hatch', 'nox', 'tox',
  // package runners that fetch and execute packages by name
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'dlx',
  // remote shells, privilege and eval-like wrappers
  'ssh', 'sudo', 'doas', 'eval', 'exec', 'source', 'env', 'xargs', 'nohup', 'timeout', 'watch',
]);

/** Tool parts of a rule that cover shell commands (our tool names, kind aliases, wildcards). */
function shellLikeTool(tool: string): boolean {
  if (tool.includes('*')) return true; // `*(…)` or `b*(…)` can match bash
  return /^(?:bash|Bash|execute|shell|run_command|run_shell_command|job_start|monitor|Monitor)$/.test(tool);
}

function isInterpreterToken(raw: string): boolean {
  let t = raw.toLowerCase();
  while (t.endsWith('*')) t = t.slice(0, -1);
  const colon = t.indexOf(':');
  if (colon >= 0 && !/^[a-z]:[\\/]/.test(t)) t = t.slice(0, colon);
  let last = t.split(/[\\/]/).pop() ?? '';
  if (last.endsWith('.exe')) last = last.slice(0, -4);
  if (!last) return false;
  // python3.12, node18 … are the same program
  const base = last.replace(/\d+(?:\.\d+)*$/, '');
  return DANGEROUS_INTERPRETERS.includes(last) || (base !== last && DANGEROUS_INTERPRETERS.includes(base));
}

/**
 * True when an allow rule (`bash`, `bash(*)`, `bash(python*)`, `Bash(npm run:*)`, `execute(node -e *)`,
 * `*`) is broad enough to defeat the classifier. A concrete command (`bash(npm test)`, `bash(python
 * scripts/check.py)`) is NOT flagged: the user spelled out exactly what they trust.
 */
export function isDangerousAllowRule(rule: string): boolean {
  const m = rule.trim().match(/^([\w*.-]+)(?:\((.*)\))?$/s);
  if (!m) return false;
  const [, tool, spec] = m;
  if (!shellLikeTool(tool!)) return false;
  // tool-level: every command
  if (spec === undefined || spec.trim() === '' || spec.trim() === '*') return true;
  const content = spec.trim().toLowerCase();
  const first = content.split(/\s/)[0] ?? '';
  // a leading wildcard (`*test*`) can match any program
  if (first.startsWith('*')) return true;
  if (!isInterpreterToken(first)) return false;
  // a bare interpreter, any wildcard with it, or the empty colon form runs everything
  if (first === content && !content.includes(':')) return true;
  if (content.includes('*')) return true;
  const colon = content.indexOf(':');
  if (colon >= 0 && !/^[a-z]:[\\/]/.test(content)) return content.slice(colon + 1).trim() === '';
  return false;
}

export function findDangerousAllowRules(rules: readonly string[]): string[] {
  return rules.filter(isDangerousAllowRule);
}
