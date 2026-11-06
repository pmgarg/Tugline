/**
 * Verification evidence and completion status (v1.1 R2).
 *
 * "Ran some command after the last edit" is not verification: `echo checked`
 * and `false` both satisfied the v1.0 nudge. A run now records evidence for
 * every command it runs (command, exit code, time, the changed files and their
 * versions at that moment, whether the disk matched the editor), and only a
 * *trusted check* can establish a verified completion:
 *   - a task acceptance command (eval task, `/goal --check`, `acceptanceChecks`);
 *   - `agent.verifyCommands` from config, or the verify/test/lint/build commands
 *     listed in AGENTS.md;
 *   - a known test/build/lint/typecheck runner (npm test, pytest, go test,
 *     cargo test, mvn, gradle, tsc, …), detected from the command itself.
 * `echo`, `true`, `:` and commands whose exit code is masked (`|| true`, a pipe
 * into a filter without pipefail) never count.
 *
 * Batch 4: that classification now only describes the model's own commands
 * (evidence for the record and the nudge). The verdict comes from the check
 * the HARNESS runs itself (harnessCheck.ts): fixed at run start, run in a clean
 * environment, and not trusted when the run changed anything it loads.
 *
 * Completion status (separate from the stop reason, which only says why the
 * loop ended):
 *   verified        the harness's check passed after the last edit;
 *   failed          the harness's check after the last edit failed;
 *   unverified      files changed but the harness could not verify (no check,
 *                   untrusted, runner missing, refused, off);
 *   not_applicable  no files changed (explanations, reviews, questions).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitCommandSegments } from '../permissions/policy.js';
import type { CompletionStatus, VerificationEvidence } from '../types.js';

export type { CompletionState, CompletionStatus, EvidenceFile, VerificationEvidence } from '../types.js';

// ------------------------------------------------------------ trusted checks

/** Program (+ subcommand) patterns of known test, build, lint and typecheck runners. */
const RUNNERS: [RegExp, string][] = [
  [/^(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?(?:test|t|tests|test:\S+|build|lint|typecheck|type-check|check|verify|ci|e2e|coverage)\b/, 'package-manager test/build/lint script'],
  [/^(?:npm|pnpm)\s+(?:-\S+\s+)*(?:test|t)\b/, 'package-manager test script'],
  [/^(?:npx|pnpx|bunx|yarn\s+dlx|pnpm\s+(?:exec|dlx))\s+(?:-\S+\s+)*(?:tsc|jest|vitest|mocha|ava|tap|eslint|biome|playwright\s+test|cypress\s+run|prettier\s+(?:--check|-c)|vue-tsc|svelte-check|astro\s+check|nx\s+(?:test|build|lint)|turbo\s+(?:run\s+)?(?:test|build|lint))\b/, 'test/lint/typecheck tool via npx'],
  [/^node\s+(?:--\S+\s+)*--test\b|^node\s+(?:\S+\s+)*--test\b/, 'node --test'],
  [/^(?:tsc|vue-tsc|jest|vitest|mocha|eslint|biome|deno\s+(?:test|check|lint)|bun\s+test)\b/, 'test/lint/typecheck tool'],
  [/^(?:python\d*(?:\.\d+)?|py)\s+(?:-\S+\s+)*-m\s+(?:pytest|unittest|mypy|ruff|flake8|pylint|pyright|tox|nox|compileall|py_compile|doctest)\b/, 'python test/lint module'],
  [/^(?:pytest|py\.test|tox|nox|mypy|ruff\s+(?:check|format\s+--check)|flake8|pylint|pyright|black\s+--check|isort\s+--check)\b/, 'python test/lint tool'],
  [/^(?:uv|poetry|pdm|hatch|pipenv|rye)\s+run\s+(?:pytest|tox|nox|mypy|ruff|flake8|pylint|pyright|python\s+-m\s+(?:pytest|unittest))\b/, 'python test runner via env manager'],
  [/^go\s+(?:test|build|vet)\b|^golangci-lint\s+run\b|^staticcheck\b/, 'go test/build/vet'],
  [/^cargo\s+(?:test|build|check|clippy|nextest)\b/, 'cargo test/build/check'],
  [/^(?:mvn|mvnw|\.\/mvnw)\s+(?:-\S+\s+)*(?:test|verify|package|compile|install)\b/, 'maven'],
  [/^(?:gradle|gradlew|\.\/gradlew)\s+(?:-\S+\s+)*(?:test|build|check|assemble|compile\w*)\b/, 'gradle'],
  [/^(?:make|gmake)\s+(?:-\S+\s+)*(?:test|tests|check|build|lint|all|ci)\b|^(?:make|gmake)\s*$/, 'make target'],
  [/^(?:dotnet)\s+(?:test|build)\b|^(?:ctest|bazel\s+test|bazel\s+build|buck2?\s+test|rspec|bundle\s+exec\s+(?:rspec|rake\s+test)|rake\s+test|phpunit|vendor\/bin\/phpunit|composer\s+test|swift\s+(?:test|build)|mix\s+test|sbt\s+test|lein\s+test|stack\s+test|cabal\s+test|dune\s+(?:test|build)|zig\s+build|flutter\s+test|dart\s+test|xcodebuild\s+test|shellcheck)\b/, 'test/build runner'],
];

/** Never verification, whatever their exit code. */
const NOT_A_CHECK = new Set(['echo', 'printf', 'true', ':', 'false', 'exit', 'cat', 'ls', 'pwd', 'sleep', 'test', '[', 'wc', 'head', 'tail', 'grep', 'rg', 'find', 'git', 'cd', 'export', 'set']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'time', 'stdbuf', 'command', 'nohup', 'xvfb-run']);

/** Collapse spaces and tabs (newlines separate commands, so they stay). */
function normalise(cmd: string): string {
  return cmd
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n');
}

/** The program part of a simple command: env assignments and wrappers removed. */
function core(seg: string): string {
  const t = seg.trim().split(/\s+/);
  for (;;) {
    if (t.length && ENV_ASSIGN.test(t[0]!)) t.shift();
    else if (t.length && WRAPPERS.has(path.basename(t[0]!))) {
      t.shift();
      while (t.length && (t[0]!.startsWith('-') || /^\d+[smh]?$/.test(t[0]!))) t.shift();
    } else break;
  }
  return t.join(' ');
}

/** Exit code hidden from us: `|| true`, `|| echo …`, `; true`, `; exit 0`, or a pipe into a filter without pipefail. */
export function exitCodeMasked(command: string): string | null {
  if (/\|\|/.test(command)) return 'its exit code is masked by `||`';
  if (/(?:^|[\s;&|(])coproc\s/.test(command)) return 'it runs as a coprocess, so its exit code is not the check\'s';
  if (/(?:^|[\s;(])if\s[\s\S]*\bthen\b/.test(command)) return 'it runs inside an `if`, whose exit code is not the check\'s';
  // `cmd &` / `cmd & wait`: a backgrounded command's exit code never reaches us (`wait` without a pid returns 0).
  // A single `&` that is not `&&`, `>&`, `&>` or `|&`.
  if (/(?<![&>|<0-9])&(?![&>])/.test(command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''"))) return 'it runs in the background (`&`), so its exit code is not the check\'s';
  if (/;\s*(?:true|:|exit\s+0)\s*$/.test(command)) return 'it ends with a command that always succeeds';
  // `a; b`: the exit code is the last command's
  const parts = command.split(/;|\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1) {
    const tail = parts[parts.length - 1]!;
    if (!tail.split(/&&/).some((x) => RUNNERS.some(([re]) => re.test(core(x))))) return 'a later command after `;` decides its exit code';
  }
  // a pipe: the exit code is the last stage's unless pipefail is set
  const pipes = command.replace(/\|\|/g, '').split(/(?<![|])\|(?![|])/);
  if (pipes.length > 1 && !/set\s+-[a-z]*o\s+pipefail|set\s+-o\s+pipefail|pipefail/.test(command)) {
    const last = core(pipes[pipes.length - 1]!);
    if (!RUNNERS.some(([re]) => re.test(last))) return 'its exit code is the pipe filter\'s, not the check\'s (use `set -o pipefail`)';
  }
  return null;
}

/** Flags that make a runner list, collect or build tests without running them (or pass when none exist). */
const RUNS_NOTHING: [RegExp, string][] = [
  [/(?:^|\s)(?:--co|--collect-only|--collectonly)(?=\s|$)/, 'collects tests without running them'],
  [/(?:^|\s)--no-run(?=\s|$)/, 'builds tests without running them'],
  [/(?:^|\s)(?:--listTests|--list-tests|--list|-list|--listfiles)(?=\s|=|$)/, 'lists tests without running them'],
  [/(?:^|\s)--passWithNoTests(?=\s|=|$)/, 'passes when no test runs'],
  [/(?:^|\s)--if-present(?=\s|$)/, 'succeeds without running anything when the script is missing'],
  [/(?:^|\s)(?:--dry-run|--dryrun|-n)(?=\s|$)(?=[\s\S]*\b(?:make|gmake)\b)|\b(?:make|gmake)\b[\s\S]*(?:^|\s)(?:-n|--dry-run|--just-print)(?=\s|$)/, 'only prints what it would run'],
  [/(?:^|\s)(?:--help|-h|--version|-V)(?=\s|$)/, 'prints help or a version'],
];

/** Environment variables that change what a test runner runs (set inline, with env, or exported). */
const RUNNER_ENV = /^(?:PYTEST_\w+|PY_COLORS_SKIP|JEST_\w+|VITEST_\w+|MOCHA_\w+|NODE_TEST_\w+|GOFLAGS|GOTESTFLAGS|CARGO_\w+|RUSTFLAGS|RUST_TEST_\w+|MAVEN_OPTS|GRADLE_OPTS|SKIP\w*|\w*_SKIP(?:_\w+)?|NO_TESTS?|TEST_FILTER|TESTS?)$/;

/** A runner-changing environment variable this command sets, or null. */
export function runnerEnv(command: string): string | null {
  for (const m of command.matchAll(/(?:^|[\s;&|(])(?:export\s+|env\s+(?:-\S+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)=/g)) if (RUNNER_ENV.test(m[1]!)) return m[1]!;
  return null;
}

/** Flags and arguments that select a subset of the tests (pytest -k/-m/--deselect/node ids, go -run, cargo filters, jest -t, mocha --grep …). */
export function selectsSubset(command: string): string | null {
  // `python -m pytest`: the interpreter's -m is not pytest's marker filter; flags of make and others are not selections
  const c = command.replace(/\b(python\d*(?:\.\d+)?|py)\s+(?:-\S+\s+)*?-m\s+/g, '$1 ');
  if (!/\b(?:pytest|py\.test|jest|vitest|mocha|go\s+test|cargo\s+test|npm|pnpm|yarn|bun|npx|node\s+(?:\S+\s+)*--test|deno\s+test|tox|nox)\b/.test(c)) return null;
  const flag = c.match(/(?:^|\s)(-k|-m|--deselect|--ignore|--ignore-glob|-run|-skip|--skip|-t|--testNamePattern|--testPathPattern|--testPathIgnorePatterns|--shard|--grep|-g|--fgrep|--invert|--only|--exclude|--filter|-p\s+no:)(?=[\s=]|$)/);
  if (flag) return flag[1]!.trim();
  if (/\S::\S/.test(c) && /\b(?:pytest|py\.test)\b/.test(c)) return 'a pytest node id';
  // cargo test <filter> [-- …]: a positional argument after `cargo test`
  const cargo = c.match(/\bcargo\s+(?:\+\S+\s+)?test\b((?:\s+(?!--(?:\s|$))\S+)*)/);
  if (cargo) {
    const toks = cargo[1]!.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (t.startsWith('-')) {
        if (['-p', '--package', '--test', '--bin', '--example', '--bench', '--features', '-F', '--target', '--manifest-path', '-j', '--jobs', '--profile'].includes(t)) i++;
        continue;
      }
      return `cargo test filter "${t}"`;
    }
  }
  return null;
}

/** Why this command runs no tests although it calls a runner, or null. */
export function runsNothing(command: string): string | null {
  for (const [re, why] of RUNS_NOTHING) if (re.test(command)) return why;
  return null;
}

/**
 * The runner reported that no test ran (pytest "collected 0 items" / "no tests ran", jest "No tests
 * found", go "[no test files]" / "no tests to run", cargo "running 0 tests" in every binary, node
 * --test "# tests 0", mocha "0 passing", maven "Tests run: 0"). A passing check that ran nothing
 * verifies nothing. Null when the output names no zero count.
 */
export function zeroTestsReported(output: string): string | null {
  const o = output.slice(-20_000);
  if ((/\bno tests ran\b|\bcollected 0 items\b/i.test(o) || /=+ \d+ deselected in /.test(o)) && !/\b[1-9]\d* passed\b/.test(o)) return 'pytest ran no tests';
  if (/\bNo tests found\b/.test(o) || /^Tests:\s+0 total/m.test(o) || /No test files found/i.test(o)) return 'the test runner found no tests';
  // go: every package line says it ran nothing ("ok  pkg 0.01s [no tests to run]", "?  pkg [no test files]")
  const goLines = o.split('\n').filter((l) => /^(?:ok|\?|FAIL)\s+\S+/.test(l));
  if (goLines.length && goLines.every((l) => /\[no tests to run\]|\[no test files\]/.test(l))) return 'go test ran no tests';
  if (/^testing: warning: no tests to run$/m.test(o) && !goLines.length) return 'go test ran no tests';
  const cargo = [...o.matchAll(/^running (\d+) tests?$/gm)].map((m) => Number(m[1]));
  if (cargo.length && cargo.every((n) => n === 0)) return 'cargo test ran 0 tests';
  if (/^# tests 0$/m.test(o)) return 'node --test ran 0 tests';
  if (/^\s*0 passing\b/m.test(o) && !/\b[1-9]\d* (?:passing|failing)\b/.test(o)) return 'mocha ran 0 tests';
  const mvn = [...o.matchAll(/Tests run: (\d+)/g)].map((m) => Number(m[1]));
  if (mvn.length && mvn.every((n) => n === 0)) return 'the build ran 0 tests';
  // all skipped / none passed (a check that skips everything verifies nothing)
  const jest = o.match(/^Tests:\s+(.*\btotal)\s*$/m);
  if (jest && !/\b[1-9]\d* passed\b/.test(jest[1]!)) return `no test passed (${jest[1]!.trim()})`;
  const vitest = o.match(/^\s*Tests\s+(.*\(\d+\))\s*$/m);
  if (vitest && !/\b[1-9]\d* passed\b/.test(vitest[1]!)) return `no test passed (${vitest[1]!.trim()})`;
  const pySummaries = [...o.matchAll(/^(?:=+ )?((?:\d+ (?:passed|failed|skipped|deselected|xfailed|xpassed|errors?|warnings?)(?:, )?)+) in [\d.]+s/gm)].map((m) => m[1]!);
  const py = pySummaries[pySummaries.length - 1];
  if (py && !/\b[1-9]\d* passed\b/.test(py)) return `no test passed (pytest: ${py})`;
  if (/^# pass 0$/m.test(o) && /^# tests [1-9]/m.test(o)) return 'no test passed (node --test)';
  const cargoRes = [...o.matchAll(/^test result: \w+\. (\d+) passed/gm)].map((m) => Number(m[1]));
  if (cargoRes.length && cargoRes.every((n) => n === 0)) return 'no test passed (cargo)';
  return null;
}

export interface TrustedCheckOptions {
  /** task acceptance commands (eval task, /goal --check) */
  acceptance?: string[];
  /** agent.verifyCommands + AGENTS.md commands */
  verifyCommands?: string[];
}

/** Is this command a trusted check? Judged on the command text only. */
export function classifyCheck(command: string, o: TrustedCheckOptions = {}): { trusted: boolean; why: string } {
  const cmd = normalise(command);
  if (!cmd) return { trusted: false, why: 'empty command' };
  const masked = exitCodeMasked(cmd);
  const segments = splitCommandSegments(cmd).map((x) => core(x));
  const matchesListed = (list: string[] | undefined) => (list ?? []).map(normalise).filter(Boolean).find((v) => cmd === v || cmd.startsWith(`${v} `) || segments.some((g) => g === core(v) || g.startsWith(`${core(v)} `)));
  const acc = matchesListed(o.acceptance);
  if (acc && !masked && runsNothing(cmd) && !runsNothing(normalise(acc))) return { trusted: false, why: `task acceptance check, but it ${runsNothing(cmd)}` };
  if (acc) return masked ? { trusted: false, why: `task acceptance check, but ${masked}` } : { trusted: true, why: `task acceptance check \`${acc}\`` };
  const listed = matchesListed(o.verifyCommands);
  if (listed && !masked && runsNothing(cmd) && !runsNothing(normalise(listed))) return { trusted: false, why: `configured verify command, but it ${runsNothing(cmd)}` };
  if (listed) return masked ? { trusted: false, why: `configured verify command, but ${masked}` } : { trusted: true, why: `configured verify command \`${listed}\`` };
  // Known runners: every simple command must be setup (cd, env, export) or a runner, and at least one a runner.
  const segs = splitCommandSegments(cmd.replace(/\|\|[^;&|]*/g, ''))
    .map(core)
    .filter(Boolean);
  let runner: string | undefined;
  for (const s of segs) {
    const prog = path.basename(s.split(' ')[0] ?? '');
    const hit = RUNNERS.find(([re]) => re.test(s));
    if (hit) {
      runner ??= hit[1];
      continue;
    }
    if (prog === 'cd' || prog === 'export' || prog === 'set' || prog === 'source' || prog === '.') continue;
    if (NOT_A_CHECK.has(prog)) continue; // harmless companions (echo "---", cat log) do not make it trusted on their own
  }
  if (!runner) {
    const prog = path.basename((segs[0] ?? '').split(' ')[0] ?? '');
    return { trusted: false, why: NOT_A_CHECK.has(prog) ? `\`${prog}\` is not a check` : 'not a known test, build, lint or typecheck command (add it to agent.verifyCommands)' };
  }
  if (masked) return { trusted: false, why: `${runner}, but ${masked}` };
  const nothing = runsNothing(cmd);
  if (nothing) return { trusted: false, why: `${runner}, but it ${nothing}` };
  const env = runnerEnv(cmd);
  if (env) return { trusted: false, why: `${runner}, but it sets ${env}, which changes what the runner runs` };
  const filter = selectsSubset(cmd);
  if (filter) return { trusted: false, why: `${runner}, but it selects a subset of the tests (${filter}); a filtered run verifies only when it is a configured verify command` };
  return { trusted: true, why: runner };
}

/**
 * Verify commands listed in AGENTS.md: inline-code commands on lines labelled
 * test / verify / check / lint / build / typecheck, e.g. "- Tests: `npm test`".
 */
export function agentsMdVerifyCommands(workspace: string, labels = /\b(test|tests|verify|verification|check|checks|lint|build|typecheck|type-check)\b/i): string[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n').slice(0, 400)) {
    const m = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([A-Za-z][\w /()-]{0,40}?)(?:\*\*)?\s*:\s*(.*)$/);
    if (!m || !labels.test(m[1]!)) continue;
    for (const c of m[2]!.matchAll(/`([^`\n]{2,200})`/g)) {
      const cmd = c[1]!.trim();
      if (/^(?:cd\s+\S+\s+&&\s+)?[\w./-]+(?:\s|$)/.test(cmd) && !/\s(?:or|and)\s*$/.test(cmd)) out.push(cmd.replace(/^\(([^)]*)\)$/, '$1'));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

/** The AGENTS.md commands the harness runs as its check: test / verify / check / typecheck lines (not build or lint). */
export function agentsMdCheckCommands(workspace: string): string[] {
  return agentsMdVerifyCommands(workspace, /\b(test|tests|verify|verification|check|checks|typecheck|type-check)\b/i);
}

// ------------------------------------------------------------ what defines a check (batch 3)

/**
 * Files that define what a check runs or that the runner loads as code by name: runner configuration and
 * scripts, build files, package-manager config (`.npmrc` can set `script-shell`), test setup files, and
 * Python's start-up hooks.
 */
const DEFINITION = /(?:^|\/)(?:package\.json|conftest\.py|\.?pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|noxfile\.py|sitecustomize\.py|usercustomize\.py|(?:GNU)?[Mm]akefile|[^/]+\.mk|(?:jest|vitest|vite|playwright|cypress|karma|babel)\.config\.[cm]?[jt]s(?:on)?|\.babelrc(?:\.[a-z]+)?|\.swcrc|(?:jest|vitest|test)[.-]?setup[^/]*\.[cm]?[jt]sx?|setupTests\.[cm]?[jt]sx?|\.mocharc(?:\.[a-z]+)?|tsconfig[^/]*\.json|\.eslintrc(?:\.[a-z]+)?|eslint\.config\.[cm]?[jt]s|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|bunfig\.toml|Cargo\.toml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml|Rakefile|\.rspec|phpunit\.xml(?:\.dist)?|deno\.jsonc?|go\.work)$/;
/** Test files. */
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$|\.(?:test|spec)\.[cm]?[jt]sx?$|Tests?\.(?:java|kt|cs)$|_spec\.rb$/;
export const isDefinitionFile = (rel: string): boolean => DEFINITION.test(rel);
export const isTestFile = (rel: string): boolean => TEST_FILE.test(rel);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', 'vendor', '.tugline', 'coverage', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.gradle']);

/** Only the parts of a shared file that define tests (package.json scripts and runner keys; the pytest sections of pyproject/setup.cfg). */
function definitionFingerprint(rel: string, text: string): string {
  const base = rel.split('/').pop()!;
  let part = text;
  if (base === 'package.json') {
    try {
      const j = JSON.parse(text);
      part = JSON.stringify([j.scripts ?? null, j.jest ?? null, j.vitest ?? null, j.mocha ?? null, j.ava ?? null]);
    } catch {
      part = text;
    }
  } else if (base === 'pyproject.toml') part = [...text.matchAll(/^\[tool\.(?:pytest|coverage|tox|hatch\.envs)[^\]]*\][\s\S]*?(?=^\[|$(?![\s\S]))/gm)].map((m) => m[0]).join('\n');
  else if (base === 'setup.cfg') part = [...text.matchAll(/^\[(?:tool:pytest|pytest)\][\s\S]*?(?=^\[|$(?![\s\S]))/gm)].map((m) => m[0]).join('\n');
  else if (base === 'Cargo.toml') part = [...text.matchAll(/^\[(?:\[test\]|lib|features|profile\.test)[^\]]*\]?[\s\S]*?(?=^\[|$(?![\s\S]))/gm)].map((m) => m[0]).join('\n');
  return crypto.createHash('sha256').update(part).digest('hex').slice(0, 16);
}

/** Path → fingerprint of every check-defining file and test file in the workspace (bounded walk). */
export function snapshotCheckDefinitions(workspace: string, maxFiles = 20_000): Map<string, string> {
  const out = new Map<string, string>();
  let seen = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || seen > maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile() && (DEFINITION.test(r) || TEST_FILE.test(r))) {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          if (st.size > 2_000_000) continue;
          out.set(r, definitionFingerprint(r, fs.readFileSync(path.join(dir, e.name), 'utf8')));
        } catch {
          /* unreadable */
        }
      }
    }
  };
  walk(workspace, '', 0);
  return out;
}

/**
 * What changed since the snapshot taken at the start of the run, among the files that define checks:
 * runner configs and scripts (changed, added or removed) and test files that existed before the run
 * (changed or removed). New test files are returned separately: adding tests is fine, but a run of
 * only new tests does not verify the task.
 */
export function definitionChanges(before: Map<string, string>, workspace: string): { changed: string[]; newTests: string[] } {
  const now = snapshotCheckDefinitions(workspace);
  const changed: string[] = [];
  const newTests: string[] = [];
  for (const [rel, fp] of now) {
    const was = before.get(rel);
    if (was === undefined) {
      if (DEFINITION.test(rel)) changed.push(rel);
      else newTests.push(rel);
    } else if (was !== fp) changed.push(rel);
  }
  for (const rel of before.keys()) if (!now.has(rel)) changed.push(rel);
  return { changed, newTests };
}

/** The command names test paths, and every one of them is a test file written in this run. */
export function onlyNewTests(command: string, newTests: string[]): string[] | null {
  if (!newTests.length) return null;
  const args = command.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, '').replace(/::.*$/, '').replace(/^\.\//, '')).filter((t) => TEST_FILE.test(t) || /\.(?:py|[cm]?[jt]sx?|go|rs)$/.test(t));
  if (!args.length) return null;
  const hits = args.filter((a) => newTests.some((n) => n === a || n.endsWith(`/${a}`) || a.endsWith(`/${n}`)));
  return hits.length === args.length ? hits : null;
}

// ------------------------------------------------------------ evidence + status

export function fileVersion(abs: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

/** Claims of success in a final answer. */
const CLAIM = /\b(?:all (?:the )?(?:\w+ )?tests? (?:now )?pass(?:es|ed|ing)?|tests? (?:now |all )?pass(?:es|ed|ing)?|(?:is|are|now|been) (?:fixed|working|resolved|verified)|fixed|verified|works? (?:now|correctly|as expected)|now works|everything works|build (?:passes|succeeds|is green)|successfully (?:fixed|implemented|completed|verified)|problem (?:is )?solved|bug (?:is )?(?:gone|fixed))\b/i;
/** An explicit "could not verify": an honest unverified exit, not a claim. */
const CANNOT_VERIFY = /\b(?:could ?n[o']t|can ?n[o']t|cannot|unable to|was not able to|wasn't able to|did ?n[o']t|have ?n[o']t|haven't|not been able to)\s+(?:be\s+)?(?:verif|test|run (?:the )?(?:tests?|checks?|build)|check|confirm)|\bunverified\b|\bnot (?:been )?(?:verified|tested)\b|\bwithout (?:running|being able to run) (?:the )?(?:tests?|checks?)\b/i;

export function claimsSuccess(text: string): boolean {
  return CLAIM.test(text) && !CANNOT_VERIFY.test(text);
}

export function declaresUnverifiable(text: string): boolean {
  return CANNOT_VERIFY.test(text);
}

/**
 * The completion status of a run from its evidence (batch 4). Only a check the HARNESS ran itself, after the
 * last edit, decides `verified` or `failed`: the commands the model ran are evidence for the record and the
 * nudge, never the verdict (the model can change what its own command runs; it cannot change the command the
 * harness fixed at run start, or the clean environment it runs in). `noCheck` says why there is no harness
 * check when there is none (nothing configured or detectable, the check is off, a subagent run).
 */
export function completionStatus(o: { filesChanged: string[]; evidence: VerificationEvidence[]; finalText: string; noCheck?: string }): CompletionStatus {
  const claimedSuccess = claimsSuccess(o.finalText) || undefined;
  const declaredUnverifiable = declaresUnverifiable(o.finalText) || undefined;
  if (!o.filesChanged.length) return { state: 'not_applicable', summary: 'no files changed', claimedSuccess, declaredUnverifiable };
  const harness = o.evidence.filter((e) => e.byHarness && e.afterLastEdit);
  const lastId = harness[harness.length - 1]?.checkId;
  const group = harness.filter((e) => e.checkId === lastId);
  if (!group.length) {
    const ran = o.evidence.filter((e) => e.afterLastEdit && !e.byHarness);
    const base = o.noCheck ?? 'the harness has not run the project\'s check after the last edit';
    const why = ran.length ? `${base} (the agent's own commands are evidence only: ${ran.slice(-3).map((e) => `\`${e.command.slice(0, 60)}\` → ${e.exitCode === null ? 'timeout' : `exit ${e.exitCode}`}`).join('; ')})` : base;
    return { state: 'unverified', summary: declaredUnverifiable ? `${why}; the agent said it could not verify` : why, claimedSuccess, declaredUnverifiable };
  }
  const disk = (e: VerificationEvidence) => (e.unsavedInEditor?.length ? ` (against the disk version; unsaved editor changes in ${e.unsavedInEditor.join(', ')})` : '');
  const failed = group.find((e) => e.trusted && e.exitCode !== 0);
  if (failed) {
    const check = { command: failed.command, exitCode: failed.exitCode, ts: failed.ts };
    return { state: 'failed', summary: `\`${failed.command.slice(0, 80)}\` ${failed.exitCode === null ? 'timed out' : `exited ${failed.exitCode}`} after the last edit (run by the harness)${disk(failed)}`, check, claimedSuccess, declaredUnverifiable };
  }
  const untrusted = group.find((e) => !e.trusted);
  if (untrusted) return { state: 'unverified', summary: `the harness could not verify with \`${untrusted.command.slice(0, 80)}\`: ${untrusted.why}`, claimedSuccess, declaredUnverifiable };
  const last = group[group.length - 1]!;
  const check = { command: last.command, exitCode: last.exitCode, ts: last.ts };
  return { state: 'verified', summary: `${group.map((e) => `\`${e.command.slice(0, 60)}\``).join(', ')} passed after the last edit (run by the harness in a clean environment)${disk(last)}`, check, claimedSuccess, declaredUnverifiable };
}

/** The nudge text, with the real evidence. */
export function verificationNudge(status: CompletionStatus, evidence: VerificationEvidence[]): string {
  const harness = evidence.filter((e) => e.byHarness && e.afterLastEdit);
  if (harness.length) {
    const failed = harness.filter((e) => e.trusted && e.exitCode !== 0).at(-1);
    if (status.state === 'failed' && failed)
      return `Before finishing: your answer claims success, but the last check after your last edit failed: ${status.summary}.\nThe harness ran the project's check \`${failed.command}\` itself, in a clean environment. Output (tail):\n\`\`\`\n${(failed.outputTail ?? '').slice(-3000)}\n\`\`\`\nFix the cause and finish again (the harness re-runs the check), or say explicitly that it could not be fixed instead of claiming success.`;
    return `Before finishing: your answer claims success, but the harness could not verify it: ${status.summary}.\nOnly a check the harness runs itself can verify the work, and it does not trust a check whose runner, configuration or loaded files changed in this run. If those changes were not part of the task, revert them and finish again; otherwise say explicitly that the work could not be verified instead of claiming success.`;
  }
  const recent = evidence.filter((e) => e.afterLastEdit).slice(-4);
  const lines = recent.map((e) => `- \`${e.command.slice(0, 120)}\` → ${e.exitCode === null ? 'timeout' : `exit ${e.exitCode}`} (${e.trusted ? 'a check, run by you' : `not a check: ${e.why}`})`);
  const head = `Before finishing: your answer claims success, but you did not run any check after your last edit that verifies it (a test, build, lint or typecheck command; ${status.summary}).`;
  return `${head}\nEvidence recorded after the last edit:\n${lines.length ? lines.join('\n') : '- (no commands)'}\nRun the relevant test, build or typecheck command with bash now and report its actual result. If it cannot be verified in this environment, say explicitly that it could not be verified instead of claiming success.`;
}
