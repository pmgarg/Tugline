/**
 * The harness check (v1.1 R2, batch 4).
 *
 * Batches 1–3 judged the commands the model ran, and each round found another way to change what such a
 * command executes without changing its text (a root `pytest.py`, a `.pytest.ini` plugin, a
 * `node_modules/.bin` shim, a PATH entry, an `npm_config_*` variable…). Pattern lists keep leaking, so the
 * class is closed differently: `verified` comes only from a check the HARNESS runs itself.
 *
 *  1. The check is fixed at run start, before the first edit: the task's acceptance commands, else
 *     `agent.verifyCommands`, else the test/verify/check/typecheck commands in AGENTS.md, else one detected
 *     from the pre-edit project (package.json `test` script, pytest config or test files, go.mod, Cargo.toml).
 *  2. At the same moment the harness fingerprints everything the check's runner can load as code from the
 *     workspace: runner configuration and scripts (`DEFINITION`), existing tests, the files the commands
 *     execute, the `node_modules/.bin` entries they resolve to with the runner packages and lockfiles, and
 *     every Python module on a top-level import path (a root `pytest.py` shadows pytest under `python -m`).
 *  3. When the model claims success, and at the end of the run, the harness compares. If the run created or
 *     changed any of those files (or still carries one an earlier run of the session changed), the result is
 *     `unverified` with the files named, and the check is not run at all.
 *  4. Otherwise it runs the commands itself: cwd = workspace root, a PATH without workspace or relative
 *     entries, PYTHON*, NODE_OPTIONS, npm_config_*, PYTEST_*, JEST_* … removed, a private Python bytecode
 *     cache, nothing added to the command line. A runner that resolves into the workspace must be a
 *     lockfile-pinned `node_modules` entry that is unchanged in this run (configured commands may name a
 *     project script by path; it is fingerprinted like any other file the check executes).
 *
 * The commands the model runs are still recorded as evidence (shown, journaled, used for the nudge), but
 * never confer `verified` on their own.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitCommandSegments } from '../permissions/policy.js';
import { splitArgs } from '../tools/shell.js';
import { agentsMdCheckCommands, isDefinitionFile, isTestFile, snapshotCheckDefinitions } from './verification.js';

export type CheckSource = 'acceptance' | 'verifyCommands' | 'AGENTS.md' | 'detected';

export interface PlannedCheck {
  command: string;
  source: CheckSource;
}

export interface CheckPlan {
  checks: PlannedCheck[];
  /** fingerprints taken at run start (keys are `<kind>:<workspace-relative path>`) */
  baseline: Map<string, string>;
  /** files the commands execute (scripts named on the command line or in package.json scripts) */
  entries: string[];
  /** node_modules/.bin entries the commands resolve programs to (whether they exist yet or not) */
  bins: string[];
  /** packages those bins point into */
  pkgs: string[];
  /** npm script programs that resolve into node_modules/.bin at run start (they need a lockfile) */
  nodeRunners: { bin: string; pkg?: string; name: string }[];
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.next', 'vendor', '.tugline', 'coverage', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.gradle']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['timeout', 'env', 'nice', 'time', 'stdbuf', 'command', 'nohup', 'xvfb-run', 'exec']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Modules Python loads for pytest itself or at start-up: a workspace file with one of these names is never a coincidence. */
const ALWAYS_LOADED = new Set(['pytest', '_pytest', 'py', 'pluggy', 'iniconfig', 'packaging', 'sitecustomize', 'usercustomize', 'conftest', 'unittest']);
const PY_MODULE = /\.(?:py|pyc|pyw|so|pyd)$/;

// ------------------------------------------------------------ which check

/** The check fixed for this run: the first non-empty of acceptance, verifyCommands, AGENTS.md, detected. */
export function planChecks(workspace: string, o: { acceptance?: string[]; verifyCommands?: string[] } = {}): PlannedCheck[] {
  const clean = (l: string[] | undefined) => [...new Set((l ?? []).map((c) => runnableCheck(workspace, c.trim())).filter(Boolean))];
  const acc = clean(o.acceptance);
  if (acc.length) return acc.map((command) => ({ command, source: 'acceptance' }));
  const vc = clean(o.verifyCommands);
  if (vc.length) return vc.map((command) => ({ command, source: 'verifyCommands' }));
  const md = clean(agentsMdCheckCommands(workspace));
  if (md.length) return md.map((command) => ({ command, source: 'AGENTS.md' }));
  return detectChecks(workspace).map((command) => ({ command, source: 'detected' }));
}

const PY = process.platform === 'win32' ? 'python' : 'python3';
const BY_EXT: Record<string, string> = { '.py': PY, '.sh': 'bash', '.bash': 'bash', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.rb': 'ruby', '.pl': 'perl' };

/**
 * The check command as a careful developer would run it (live run 30 Oct: every resolved task was labelled
 * `failed`, because bare `pytest` does not put the project root on sys.path, and a script without the
 * executable bit exits 126):
 *  - `pytest …` / `py.test …` → `python3 -m pytest …` (the root is importable, like the tasks' own acceptance);
 *  - `path/to/script …` that exists in the workspace but is not executable → its shebang interpreter, or the
 *    interpreter for its extension.
 * The project's own files are still fingerprinted the same way (the script stays an entry the run must not change).
 */
export function runnableCheck(workspace: string, command: string): string {
  if (!command) return command;
  const m = /^(\s*)(\S+)(.*)$/s.exec(command);
  if (!m) return command;
  const [, lead, first, rest] = m;
  if (first === 'pytest' || first === 'py.test') return `${lead}${PY} -m pytest${rest}`;
  if (!/[/\\]/.test(first) || path.isAbsolute(first)) return command;
  const abs = path.resolve(workspace, first);
  if (!inside(workspace, abs)) return command;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return command;
  }
  if (!st.isFile() || (process.platform !== 'win32' && st.mode & 0o111)) return command;
  const head = (readText(abs, 64 * 1024) ?? '').split('\n', 1)[0] ?? '';
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(head);
  let interp: string | undefined;
  if (shebang) interp = path.basename(shebang[1]!) === 'env' && shebang[2] ? shebang[2] : shebang[1];
  interp ??= BY_EXT[path.extname(abs).toLowerCase()];
  return interp ? `${lead}${interp} ${first}${rest}` : command;
}

function readText(abs: string, max = 2_000_000): string | undefined {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > max) return undefined;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

function readJson(abs: string): any {
  const t = readText(abs);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** The project's own test command, detected from the files present before any edit. */
export function detectChecks(workspace: string): string[] {
  const out: string[] = [];
  const has = (rel: string) => fs.existsSync(path.join(workspace, rel));
  const test = readJson(path.join(workspace, 'package.json'))?.scripts?.test;
  if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) out.push('npm test');
  if (hasPytestProject(workspace)) out.push(`${process.platform === 'win32' ? 'python' : 'python3'} -m pytest -q`);
  if (has('go.mod')) out.push('go test ./...');
  if (has('Cargo.toml')) out.push('cargo test');
  return out;
}

function hasPytestProject(workspace: string): boolean {
  const t = (rel: string) => readText(path.join(workspace, rel)) ?? '';
  if (['pytest.ini', '.pytest.ini', 'conftest.py'].some((f) => fs.existsSync(path.join(workspace, f)))) return true;
  if (/^\[tool\.pytest/m.test(t('pyproject.toml')) || /^\[tool:pytest\]/m.test(t('setup.cfg')) || /^\[pytest\]/m.test(t('tox.ini'))) return true;
  // test files at the root or in a test directory (bounded)
  let found = false;
  const walk = (dir: string, depth: number) => {
    if (found || depth > 3) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 2000)) {
      if (e.isFile() && /^test_.*\.py$|_test\.py$/.test(e.name)) {
        found = true;
        return;
      }
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(workspace, 0);
  return found;
}

// ------------------------------------------------------------ what the commands execute

interface Invocation {
  prog: string;
  args: string[];
  /** absolute cwd */
  cwd: string;
  /** resolved through node_modules/.bin first (npm scripts, npx) */
  viaNodeBin: boolean;
}

function tokens(seg: string): string[] {
  try {
    return splitArgs(seg);
  } catch {
    return seg.trim().split(/\s+/).filter(Boolean);
  }
}

function stripPrefix(t: string[]): string[] {
  const out = [...t];
  for (;;) {
    if (out.length && ENV_ASSIGN.test(out[0]!)) out.shift();
    else if (out.length && WRAPPERS.has(path.basename(out[0]!))) {
      out.shift();
      while (out.length && (out[0]!.startsWith('-') || /^\d+(?:\.\d+)?[smhd]?$/.test(out[0]!) || ENV_ASSIGN.test(out[0]!))) out.shift();
    } else break;
  }
  return out;
}

/** The script a package-manager command runs (npm test, npm run x, yarn x, pnpm test …), or undefined. */
function scriptName(pm: string, args: string[]): string | undefined {
  const a = args.filter((x) => !x.startsWith('-'));
  if (!a.length) return undefined;
  if (['test', 't', 'tst'].includes(a[0]!)) return 'test';
  if (a[0] === 'run' || a[0] === 'run-script') return a[1];
  if (pm === 'yarn' || pm === 'pnpm' || pm === 'bun') return ['install', 'add', 'remove', 'exec', 'dlx', 'x'].includes(a[0]!) ? undefined : a[0];
  return undefined;
}

/** Every program the check commands invoke, npm scripts (with pre/post) expanded. */
function invocations(workspace: string, command: string, cwd = workspace, viaNodeBin = false, depth = 0): Invocation[] {
  if (depth > 3) return [];
  const out: Invocation[] = [];
  let dir = cwd;
  for (const seg of splitCommandSegments(command)) {
    const t = stripPrefix(tokens(seg.replace(/^[({\s]+|[)}\s]+$/g, '')));
    if (!t.length) continue;
    const [prog, ...args] = t as [string, ...string[]];
    if (prog === 'cd') {
      dir = path.resolve(dir, args[0] ?? workspace);
      continue;
    }
    out.push({ prog, args, cwd: dir, viaNodeBin });
    const base = path.basename(prog);
    if (PACKAGE_MANAGERS.has(base)) {
      const name = scriptName(base, args);
      const scripts = readJson(path.join(dir, 'package.json'))?.scripts ?? {};
      if (name) for (const s of [`pre${name}`, name, `post${name}`]) if (typeof scripts[s] === 'string') out.push(...invocations(workspace, scripts[s], dir, true, depth + 1));
      // npx-like: pnpm exec X, yarn dlx X, bun x X
      const sub = args.findIndex((x) => ['exec', 'dlx', 'x'].includes(x));
      if (sub >= 0 && args[sub + 1]) out.push({ prog: args[sub + 1]!, args: args.slice(sub + 2), cwd: dir, viaNodeBin: true });
    } else if (base === 'npx' || base === 'pnpx' || base === 'bunx') {
      const rest = args.filter((x) => !x.startsWith('-'));
      if (rest[0]) out.push({ prog: rest[0], args: rest.slice(1), cwd: dir, viaNodeBin: true });
    }
  }
  return out;
}

const rel = (workspace: string, abs: string) => path.relative(workspace, abs).split(path.sep).join('/');
const inside = (workspace: string, abs: string) => {
  const r = path.relative(workspace, abs);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

/** node_modules/.bin/<prog> from cwd up to the workspace root (what npm puts first on PATH). */
function nodeBinFor(workspace: string, cwd: string, prog: string): string[] {
  const out: string[] = [];
  for (let d = cwd; inside(workspace, d); d = path.dirname(d)) {
    out.push(path.join(d, 'node_modules', '.bin', prog));
    if (d === path.dirname(d)) break;
  }
  return out;
}

/** The package directory a node_modules/.bin entry points into (nearest package.json above its target). */
function packageOf(workspace: string, binAbs: string): string | undefined {
  let target: string;
  try {
    target = fs.realpathSync(binAbs);
  } catch {
    return undefined;
  }
  if (!inside(workspace, target)) return undefined;
  for (let d = path.dirname(target); inside(workspace, d) && d !== workspace; d = path.dirname(d)) {
    if (path.basename(path.dirname(d)) === 'node_modules' || path.basename(path.dirname(path.dirname(d))) === 'node_modules') if (fs.existsSync(path.join(d, 'package.json'))) return d;
  }
  return undefined;
}

/** Fix the check and fingerprint what it can load, before the first edit. */
export function prepareCheckPlan(workspace: string, checks: PlannedCheck[]): CheckPlan {
  const entries = new Set<string>();
  const bins = new Set<string>();
  const pkgs = new Set<string>();
  const nodeRunners: CheckPlan['nodeRunners'] = [];
  for (const c of checks) {
    for (const inv of invocations(workspace, c.command)) {
      // a program named by path, and file arguments (node scripts/x.mjs, bash check.sh, python tool.py)
      for (const tok of [inv.prog, ...inv.args]) {
        if (!tok || tok.startsWith('-') || !/[/\\]|\.(?:[cm]?[jt]sx?|py|sh|bash|rb|pl|php|mk)$/.test(tok)) continue;
        const abs = path.resolve(inv.cwd, tok);
        if (!inside(workspace, abs)) continue;
        try {
          if (fs.statSync(abs).isFile()) entries.add(rel(workspace, abs));
        } catch {
          /* not a file */
        }
      }
      if (/[/\\]/.test(inv.prog)) {
        const abs = path.resolve(inv.cwd, inv.prog);
        if (inside(workspace, abs) && /(?:^|\/)node_modules\/\.bin\//.test(rel(workspace, abs))) {
          bins.add(rel(workspace, abs));
          const pkg = packageOf(workspace, abs);
          if (pkg) pkgs.add(rel(workspace, pkg));
        }
        continue;
      }
      if (!inv.viaNodeBin) continue;
      const candidates = nodeBinFor(workspace, inv.cwd, inv.prog);
      for (const b of candidates) bins.add(rel(workspace, b));
      const hit = candidates.find((b) => fs.existsSync(b));
      if (hit) {
        const pkg = packageOf(workspace, hit);
        if (pkg) pkgs.add(rel(workspace, pkg));
        nodeRunners.push({ bin: rel(workspace, hit), pkg: pkg ? rel(workspace, pkg) : undefined, name: inv.prog });
      }
    }
  }
  const plan: CheckPlan = { checks, baseline: new Map(), entries: [...entries], bins: [...bins], pkgs: [...pkgs], nodeRunners };
  plan.baseline = loadableSnapshot(workspace, plan);
  return plan;
}

// ------------------------------------------------------------ fingerprints

function hashFile(abs: string): string {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return 'not-a-file';
    if (st.size > 32_000_000) return `size:${st.size}:${st.mtimeMs}`;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 16);
  } catch {
    return 'missing';
  }
}

/** A .bin entry: where it points and what is there. */
function hashBin(abs: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return 'missing';
  }
  let target = abs;
  try {
    target = fs.realpathSync(abs);
  } catch {
    return `dangling:${st.isSymbolicLink() ? fs.readlinkSync(abs) : ''}`;
  }
  return `${target}:${hashFile(target)}`;
}

/** A package directory (bounded): every file's path and content. */
function hashDir(abs: string): string {
  const h = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (files > 6000) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
      } else if (e.isFile()) {
        files++;
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        h.update(`${path.relative(abs, p)}\0${st.size}\0`);
        if (bytes + st.size <= 64_000_000) {
          bytes += st.size;
          try {
            h.update(fs.readFileSync(p));
          } catch {
            /* unreadable */
          }
        } else h.update(String(st.mtimeMs));
      } else if (e.isSymbolicLink()) {
        try {
          h.update(`${path.relative(abs, p)}->${fs.readlinkSync(p)}`);
        } catch {
          /* gone */
        }
      }
    }
  };
  if (!fs.existsSync(abs)) return 'missing';
  walk(abs);
  return h.digest('hex').slice(0, 16);
}

/**
 * Python modules on a top-level import path: files in directories that are not packages (no __init__.py),
 * and package directories whose parent is not a package. `python -m pytest` puts the cwd first on sys.path,
 * and pytest's default import mode puts each test's first non-package directory there, so a file with a
 * module's name there shadows that module. Bytecode and extension modules count (a sourceless `pytest.pyc`
 * imports too).
 */
function pythonModules(workspace: string, out: Map<string, string>, maxFiles = 20_000): void {
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || seen > maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '__init__.py')) return; // a package: its modules import as pkg.mod only
    for (const e of entries) {
      if (++seen > maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        const init = path.join(abs, '__init__.py');
        if (fs.existsSync(init)) out.set(`py:${rel(workspace, init)}`, hashFile(init));
        else walk(abs, depth + 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && PY_MODULE.test(e.name)) out.set(`py:${rel(workspace, abs)}`, e.isSymbolicLink() ? hashBin(abs) : hashFile(abs));
    }
  };
  walk(workspace, 0);
}

/** Everything the check can load from the workspace, fingerprinted. */
export function loadableSnapshot(workspace: string, plan: Pick<CheckPlan, 'entries' | 'bins' | 'pkgs' | 'nodeRunners'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of snapshotCheckDefinitions(workspace)) out.set(`def:${k}`, v);
  pythonModules(workspace, out);
  for (const e of plan.entries) out.set(`entry:${e}`, hashFile(path.join(workspace, e)));
  for (const b of plan.bins) out.set(`bin:${b}`, hashBin(path.join(workspace, b)));
  for (const p of plan.pkgs) out.set(`pkg:${p}`, hashDir(path.join(workspace, p)));
  if (plan.nodeRunners.length) for (const l of LOCKFILES) out.set(`lock:${l}`, hashFile(path.join(workspace, l)));
  return out;
}

// ------------------------------------------------------------ what changed

export interface Untrusted {
  /** workspace-relative files the run created, changed or removed that the check would load */
  files: string[];
  /** one sentence each */
  reasons: string[];
  /** key → current fingerprint, for the files flagged now (carried into later runs of the session) */
  flagged: Map<string, string>;
}

/** Plugins named in the pytest configuration (`-p name`) and in conftest files (`pytest_plugins`). */
function pytestPluginNames(workspace: string, defKeys: string[]): string[] {
  const names = new Set<string>();
  for (const f of ['pytest.ini', '.pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml']) for (const m of (readText(path.join(workspace, f)) ?? '').matchAll(/(?:^|[\s"'[,=])-p\s*([A-Za-z_][\w.]*)/g)) names.add(m[1]!);
  for (const k of defKeys.filter((k) => k.endsWith('conftest.py'))) {
    const t = readText(path.join(workspace, k)) ?? '';
    for (const m of t.matchAll(/pytest_plugins\s*=\s*([\s\S]{0,400}?)(?:\n\S|$)/g)) for (const s of m[1]!.matchAll(/["']([A-Za-z_][\w.]*)["']/g)) names.add(s[1]!);
  }
  return [...names];
}

/** The module name a top-level module file provides, and its dotted path from the workspace root. */
function moduleName(relPath: string): { name: string; dotted: string } {
  const pkg = relPath.endsWith('/__init__.py') || relPath === '__init__.py';
  const parts = relPath.replace(/\/?__init__\.py$/, '').split('/');
  const last = pkg ? parts.pop()! : parts.pop()!.split('.')[0]!;
  return { name: last, dotted: [...parts, last].filter(Boolean).join('.') };
}

/** Which of these module names Python resolves outside the workspace (stdlib, site-packages): a workspace file with that name shadows it. */
export function resolvableModules(names: string[], env: NodeJS.ProcessEnv, python = process.platform === 'win32' ? 'python' : 'python3'): Set<string> | undefined {
  if (!names.length) return new Set();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-pymod-'));
  try {
    const code = 'import importlib.util as u, sys\nfor n in sys.argv[1:]:\n    try:\n        print(n) if u.find_spec(n) else None\n    except Exception:\n        pass\n';
    const r = spawnSync(python, ['-E', '-c', code, ...names], { cwd: dir, env, encoding: 'utf8', timeout: 15_000 });
    if (r.status !== 0) return undefined;
    return new Set(r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the run did to the files the check loads. A file counts when it differs from the run-start
 * fingerprint, or when an earlier run of this session flagged it and it is still in that state (`carried`).
 * New test files are fine (adding tests is part of the work); edits to existing tests are not.
 */
export function untrustedChanges(workspace: string, plan: CheckPlan, carried: Map<string, string> = new Map(), env: NodeJS.ProcessEnv = process.env): Untrusted {
  const now = loadableSnapshot(workspace, plan);
  const files: string[] = [];
  const reasons: string[] = [];
  const flagged = new Map<string, string>();
  const flag = (key: string, why: string) => {
    const p = key.slice(key.indexOf(':') + 1);
    if (!files.includes(p)) files.push(p);
    if (!reasons.includes(why)) reasons.push(why);
    flagged.set(key, now.get(key) ?? 'missing');
  };
  const pyCandidates: string[] = [];
  const keys = new Set([...plan.baseline.keys(), ...now.keys()]);
  for (const key of keys) {
    const was = plan.baseline.get(key);
    const is = now.get(key);
    const carriedState = carried.get(key);
    if (was === is) {
      if (carriedState !== undefined && carriedState === (is ?? 'missing')) flag(key, 'an earlier run in this session changed it');
      continue;
    }
    const kind = key.slice(0, key.indexOf(':'));
    const p = key.slice(kind.length + 1);
    if (kind === 'def') {
      if (was === undefined && !isDefinitionFile(p) && isTestFile(p)) continue; // a new test file
      flag(key, isDefinitionFile(p) ? 'runner configuration or scripts changed' : 'an existing test changed');
    } else if (kind === 'entry') flag(key, 'a file the check executes changed');
    else if (kind === 'bin') flag(key, 'a node_modules/.bin entry the check resolves changed');
    else if (kind === 'pkg') flag(key, 'the runner package in node_modules changed');
    else if (kind === 'lock') flag(key, 'the lockfile that pins the runner changed');
    else if (kind === 'py' && is !== undefined && is !== 'missing') pyCandidates.push(key);
  }
  if (pyCandidates.length) {
    const plugins = pytestPluginNames(workspace, [...now.keys()].filter((k) => k.startsWith('def:')).map((k) => k.slice(4)));
    const mods = pyCandidates.map((k) => ({ key: k, ...moduleName(k.slice(3)) }));
    const unknown = [...new Set(mods.map((m) => m.name).filter((n) => !ALWAYS_LOADED.has(n)))];
    const outside = resolvableModules(unknown, env);
    for (const m of mods) {
      if (ALWAYS_LOADED.has(m.name)) flag(m.key, `it shadows the Python module \`${m.name}\` the runner loads`);
      else if (plugins.some((n) => n === m.name || n === m.dotted || m.dotted.endsWith(`.${n}`))) flag(m.key, `it is a pytest plugin the configuration loads (\`${m.name}\`)`);
      else if (outside === undefined) {
        /* python unavailable: only the always-loaded names above */
      } else if (outside.has(m.name)) flag(m.key, `it shadows the installed Python module \`${m.name}\``);
    }
  }
  // a runner that resolves into the workspace must be pinned by a lockfile
  if (plan.nodeRunners.length) {
    const lock = LOCKFILES.map((l) => ({ l, t: readText(path.join(workspace, l), 50_000_000) })).find((x) => x.t !== undefined);
    for (const r of plan.nodeRunners) {
      const pkgName = r.pkg ? readJson(path.join(workspace, r.pkg, 'package.json'))?.name : undefined;
      if (!lock) {
        files.push(r.bin);
        reasons.push(`\`${r.name}\` resolves to ${r.bin}, and no lockfile pins it`);
      } else if (pkgName && lock.l !== 'bun.lockb' && !lock.t!.includes(pkgName)) {
        files.push(r.bin);
        reasons.push(`\`${r.name}\` resolves to ${r.bin} (${pkgName}), which ${lock.l} does not pin`);
      }
    }
  }
  return { files, reasons, flagged };
}

// ------------------------------------------------------------ the clean environment

/** Variables that change what a runner loads or runs: removed for the harness check. */
const RUNNER_ENV = /^(?:PYTHON\w*|PIP_\w+|NODE_OPTIONS|NODE_PATH|NODE_TEST_\w+|TS_NODE_\w+|TSX_\w+|npm_\w+|NPM_\w+|YARN_\w+|PNPM_\w+|BUN_\w+|COREPACK_\w+|PYTEST_\w+|JEST_\w+|VITEST_\w+|MOCHA_\w+|GOFLAGS|GOTESTFLAGS|GOPATH|GOROOT|GOTOOLCHAIN|CARGO_BUILD_\w+|CARGO_TARGET_\w+|CARGO_ALIAS_\w+|RUSTFLAGS|RUSTDOCFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC|RUST_TEST_\w+|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w+|BASH_ENV|ENV|ZDOTDIR|PERL5LIB|PERL5OPT|PERLLIB|RUBYOPT|RUBYLIB|GEM_\w+|BUNDLE_\w+|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|MAVEN_OPTS|MAVEN_ARGS|GRADLE_OPTS|GRADLE_USER_HOME|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|SKIP\w*|\w*_SKIP(?:_\w+)?|NO_TESTS?|TEST_FILTER|TESTS?|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|IFS|CDPATH)$/i;

/** PATH without empty, relative or workspace entries. */
export function cleanPath(p: string | undefined, workspace: string): string {
  let ws = workspace;
  try {
    ws = fs.realpathSync(workspace);
  } catch {
    /* keep */
  }
  const keep = (p ?? '').split(path.delimiter).filter((d) => {
    if (!d || !path.isAbsolute(d)) return false;
    let real = d;
    try {
      real = fs.realpathSync(d);
    } catch {
      /* missing dir: harmless */
    }
    return !inside(workspace, d) && !inside(ws, real);
  });
  return [...new Set(keep)].join(path.delimiter);
}

/** The environment the harness check runs in: the scrubbed base, runner-changing variables removed, a clean PATH, a private bytecode cache. */
/**
 * Data-only directories the check may still read from the real home (dependency caches and toolchains). Config
 * files that can run code (usercustomize/sitecustomize under ~/.local, ~/.npmrc, ~/.gitconfig, ~/.gradle/init.d,
 * ~/.gradle/gradle.properties, ~/.m2/settings.xml, ~/.cargo/config.toml, ~/.config/*) are NOT carried over.
 */
export const CHECK_HOME_DATA = ['.cargo/registry', '.cargo/git', '.rustup', 'go/pkg/mod', '.m2/repository', '.gradle/caches', '.gradle/wrapper', '.npm/_cacache', '.cache/pip', '.pyenv', '.nvm', '.asdf', '.local/share/uv'];

/**
 * A fresh, empty home for the harness check (R2 review: code the run planted under the real $HOME, e.g. a
 * usercustomize.py in the per-user site directory or `script-shell` in ~/.npmrc, reached the check when no
 * sandbox ran). Dependency caches and toolchains are linked in read-through; nothing that configures a runner is.
 */
export function makeCheckHome(realHome: string | undefined): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-checkhome-'));
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), '');
  // npm refuses one file as both user and global config ("double-loading config")
  fs.writeFileSync(path.join(home, '.npmrc-global'), '');
  if (realHome) {
    for (const d of CHECK_HOME_DATA) {
      const src = path.join(realHome, d);
      try {
        if (!fs.statSync(src).isDirectory()) continue;
        fs.mkdirSync(path.dirname(path.join(home, d)), { recursive: true });
        fs.symlinkSync(src, path.join(home, d), 'dir');
      } catch {
        /* absent or not linkable: the tool falls back to downloading or reports a missing runner */
      }
    }
  }
  return home;
}

export function cleanCheckEnv(base: NodeJS.ProcessEnv, workspace: string, pycache?: string, checkHome?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!RUNNER_ENV.test(k)) env[k] = v;
  const pathKey = Object.keys(base).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env[pathKey] = cleanPath(base[pathKey], workspace);
  env.PWD = workspace;
  // Python reads bytecode from __pycache__ when the header matches the source's mtime and size: a private cache ignores any the run planted
  if (pycache) env.PYTHONPYCACHEPREFIX = pycache;
  env.PYTHONDONTWRITEBYTECODE = '1';
  // No per-user site directory (usercustomize, .pth files in ~/.local/lib/python*/site-packages).
  env.PYTHONNOUSERSITE = '1';
  if (checkHome) {
    const realHome = base.HOME ?? base.USERPROFILE;
    env.HOME = checkHome;
    if (process.platform === 'win32') env.USERPROFILE = checkHome;
    env.XDG_CONFIG_HOME = path.join(checkHome, '.config');
    env.XDG_DATA_HOME = path.join(checkHome, '.local', 'share');
    env.XDG_CACHE_HOME = path.join(checkHome, '.cache');
    env.npm_config_userconfig = path.join(checkHome, '.npmrc');
    env.npm_config_globalconfig = path.join(checkHome, '.npmrc-global');
    env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    // toolchains that locate their data from HOME keep finding it (read-through links in the check home)
    if (realHome) {
      if (!env.RUSTUP_HOME && fs.existsSync(path.join(realHome, '.rustup'))) env.RUSTUP_HOME = path.join(realHome, '.rustup');
      if (!env.GOMODCACHE && fs.existsSync(path.join(realHome, 'go', 'pkg', 'mod'))) env.GOMODCACHE = path.join(realHome, 'go', 'pkg', 'mod');
      if (!env.PYENV_ROOT && fs.existsSync(path.join(realHome, '.pyenv'))) env.PYENV_ROOT = path.join(realHome, '.pyenv');
    }
  }
  return env;
}

/** Where a bare program name resolves on this PATH (null when it does not). */
export function whichOnPath(prog: string, PATH: string): string | null {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const d of PATH.split(path.delimiter)) {
    for (const x of exts) {
      const p = path.join(d, prog + x);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (process.platform === 'win32' || st.mode & 0o111)) return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Programs of the check that resolve into the workspace on the clean PATH (after the PATH was cleaned, only symlinks can do that). */
export function programsInWorkspace(workspace: string, plan: CheckPlan, PATH: string): string[] {
  const out: string[] = [];
  for (const c of plan.checks) {
    for (const inv of invocations(workspace, c.command)) {
      if (inv.viaNodeBin || /[/\\]/.test(inv.prog) || inv.prog === 'cd') continue;
      const hit = whichOnPath(inv.prog, PATH);
      if (!hit) continue;
      let real = hit;
      try {
        real = fs.realpathSync(hit);
      } catch {
        /* keep */
      }
      if (inside(workspace, real)) out.push(`\`${inv.prog}\` resolves to ${rel(workspace, real)} inside the workspace`);
    }
  }
  return out;
}

/** The runner could not start (not installed): the check says nothing about the work. */
export function runnerUnavailable(exitCode: number | null, output: string): string | null {
  if (exitCode === 0 || exitCode === null) return null;
  const o = output.slice(-4000);
  if (exitCode === 126) return 'the check could not be executed (exit 126: not executable or permission denied)';
  if (exitCode === 127) return `the runner was not found (exit 127${/([\w./-]+): (?:command )?not found/.exec(o) ? `: ${/([\w./-]+): (?:command )?not found/.exec(o)![1]}` : ''})`;
  if (/No module named '?pytest'?\s*$/m.test(o)) return 'pytest is not installed for this Python';
  if (/is not recognized as an internal or external command/.test(o)) return 'the runner was not found';
  return null;
}

/** The tail of an output, for the evidence and the nudge. */
export function outputTail(output: string, n = 4000): string {
  return output.length > n ? `…${output.slice(-n)}` : output;
}
