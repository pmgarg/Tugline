/**
 * `tug bench` (SPEC I2): run a subset of a public benchmark through the eval
 * harness (same raw records, scorer and report as `tug eval`).
 *
 *   tug bench terminal-bench|swe-bench [--subset N] [--repeats 3] [--arm default|bash-only|all] [--data path] [--fetch]
 *
 * Formats:
 *  - terminal-bench: one directory per task with task.yaml (`instruction`,
 *    `max_agent_timeout_sec`), run-tests.sh and tests/ (plus Dockerfile and
 *    solution.sh, which we do not use). The agent never sees tests/,
 *    run-tests.sh or solution.sh; the scorer runs them afterwards with
 *    TEST_DIR pointing at the hidden copy (as the official harness does).
 *  - swe-bench: JSONL instances (`instance_id`, `repo`, `base_commit`,
 *    `problem_statement`, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`). The
 *    scorer applies `test_patch` after the run and runs the listed tests.
 *    Extensions used by the bundled samples: `repo_path` (a local checkout
 *    instead of cloning) and `test_cmd` (instead of pytest).
 *
 * Arms: `default` (all tools) and `bash-only` (only the bash tool, the
 * mini-swe-agent-style baseline).
 *
 * Isolation (v1.1 G5, `--isolation docker|host`, default docker when a Docker
 * daemon is reachable; see isolation.ts):
 *  - docker: each run gets its own container. terminal-bench tasks use the
 *    image built from their own Dockerfile / docker-compose.yaml (built from a
 *    copy of the task directory without tests/ and the solution, so those
 *    cannot be baked into the image), workspace at /app. SWE-bench instances
 *    use one python base image (`--image`, default python:3.12-slim) with the
 *    repository at /testbed. Every agent bash command runs via `docker exec`
 *    in that container. The test patch is applied (host side, on the
 *    bind-mounted workspace) and the hidden files are copied into the
 *    container only after the agent has finished; acceptance runs inside it.
 *  - host: tasks run on this machine, and the report says so ("Isolation
 *    limitations"): tasks that need their image's packages fail for
 *    environmental reasons, and an unrestricted shell can find hidden tests.
 */
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { HarnessConfig } from '../config.js';
import { resolveIsolation, type Isolation, type TaskDocker } from './isolation.js';
import { runEval } from './runner.js';
import { compareReport, loadPilot, loadRecords } from './compare.js';
import { startLoad, type LoadGenerator } from './contention.js';
import { resolveProfile } from '../config.js';
import { EXTERNAL_PRESETS } from './external.js';
import { HARBOR_ACCEPTANCE, isHarborTask, miniToml, workdirOf } from './harbor.js';
import { loadSweBenchPro, PRO_DOCKERHUB_USER, proEvalArgv, proPredictions, runProGrader } from './swepro.js';
import type { ScoredRun } from './scorer.js';

const pexec = promisify(execFile);

/** 'suite': an existing eval suite directory (evals/editing, evals/coding-basics …) with the bench machinery: arms, conditions, paired report (R19). */
export type BenchFormat = 'terminal-bench' | 'swe-bench' | 'swe-bench-pro' | 'suite';

/** R18 ablation features (see ablationArm). Declared before BENCH_ARMS, which uses them. */
export const ABLATION_FEATURES = ['planner', 'reviewer', 'subagents', 'codeMode'] as const;
export type AblationFeature = (typeof ABLATION_FEATURES)[number];

export const BENCH_ARMS: Record<string, Record<string, unknown>> = {
  default: {},
  'bash-only': { __tools: ['bash'] },
  // v1.1 R10: other agents' CLIs on the same tasks and endpoint (installed by the user; see EXTERNAL_PRESETS).
  ...Object.fromEntries(Object.keys(EXTERNAL_PRESETS).map((k) => [k, { external: { preset: k } }])),
  // v1.1 R18: ablations of Tugline's own machinery against the simple loop (same model, same tasks).
  ...ablationArms(),
};

/**
 * R18 ablation switches. Each feature maps to what turns it off in this build:
 *  - planner: the planning tools (todo_write, exit_plan_mode) and the D10 planner routing;
 *  - reviewer: the fresh-context validator subagent before finishing (agent.autoValidate);
 *  - subagents: the task tool;
 *  - codeMode: Code Mode (N21, `codeMode.enabled`). Until N21 is merged the switch is recorded but changes nothing.
 * oh-full has everything on, oh-no-<x> turns one off, oh-simple turns all off (read/edit/bash loop).
 */

export function ablationArm(off: AblationFeature[]): Record<string, unknown> {
  const on = (f: AblationFeature) => !off.includes(f);
  const without = [...(on('planner') ? [] : ['todo_write', 'exit_plan_mode']), ...(on('subagents') ? [] : ['task'])];
  return {
    agent: { autoValidate: on('reviewer') },
    codeMode: { enabled: on('codeMode') },
    ...(on('planner') ? {} : { routing: { planner: '' } }),
    ...(without.length ? { __withoutTools: without } : {}),
    __ablation: Object.fromEntries(ABLATION_FEATURES.map((f) => [f, on(f)])),
  };
}

function ablationArms(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { 'oh-full': ablationArm([]), 'oh-simple': ablationArm([...ABLATION_FEATURES]) };
  for (const f of ABLATION_FEATURES) out[`oh-no-${f.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = ablationArm([f]);
  return out;
}

/** `--arm` shorthands: all = OH arms, ablations = R18 switches, pilot = the paired Cline pilot (R18). */
export const ARM_GROUPS: Record<string, string[]> = {
  all: ['default', 'bash-only'],
  ablations: ['oh-full', 'oh-no-planner', 'oh-no-reviewer', 'oh-no-subagents', 'oh-no-code-mode', 'oh-simple'],
  pilot: ['default', 'cline', 'cline-pinned', 'mini-swe-agent'],
};

export function expandArms(spec: string): string[] {
  return [...new Set(spec.split(',').map((a) => a.trim()).filter(Boolean).flatMap((a) => ARM_GROUPS[a] ?? [a]))];
}

export interface BenchTask {
  id: string;
  prompt: string;
  /** Files the agent works in (copied fresh per run). */
  repoDir: string;
  /** Hidden material for the scorer only. */
  hidden: Record<string, string>;
  acceptance: string[];
  /** Host-side commands after the agent, before acceptance (SWE-bench: apply the test patch). */
  prepare?: string[];
  timeoutS: number;
  /** Top-level names in repoDir the agent must not get (terminal-bench tests and solution). */
  exclude?: string[];
  /** Container for docker isolation (G5). `build` is the task directory with its Dockerfile / compose file. */
  docker?: TaskDocker;
  /** A Harbor-format task: its verifier needs the task container (/tests, /logs/verifier), so docker isolation is required. */
  harbor?: boolean;
}

// ------------------------------------------------------------ terminal-bench

/** Minimal reader for the keys we need when the `yaml` package is absent. */
export function miniYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (/^[|>][-+]?\s*$/.test(v)) {
      const block: string[] = [];
      let indent = -1;
      for (i++; i < lines.length; i++) {
        const l = lines[i];
        if (l.trim() && indent < 0) indent = l.length - l.trimStart().length;
        if (l.trim() && l.length - l.trimStart().length < indent) break;
        block.push(l.slice(Math.max(indent, 0)));
      }
      i--;
      out[k] = v.startsWith('>') ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n').replace(/\n+$/, '');
    } else out[k] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

async function parseYaml(text: string): Promise<Record<string, any>> {
  try {
    const mod = 'yaml';
    const y: any = await import(mod);
    return (y.parse ?? y.default.parse)(text) ?? {};
  } catch {
    return miniYaml(text);
  }
}

/** Never part of a task image's build context: the hidden tests and the reference solution. */
const TB_SECRET = ['tests', 'run-tests.sh', 'solution.sh', 'solution.yaml'];
const TB_HIDDEN = new Set(['tests', 'run-tests.sh', 'solution.sh', 'solution.yaml', 'task.yaml', 'Dockerfile', 'docker-compose.yaml', 'docker-compose.yml']);

/** A Harbor-format task (Terminal-Bench 2.0 and later; v1.1 N1): instruction.md, task.toml, environment/, tests/test.sh. */
function harborTask(id: string, tdir: string): BenchTask | undefined {
  const instruction = fs.readFileSync(path.join(tdir, 'instruction.md'), 'utf8').trim();
  if (!instruction || !fs.existsSync(path.join(tdir, 'tests', 'test.sh'))) return undefined;
  const toml = miniToml(fs.readFileSync(path.join(tdir, 'task.toml'), 'utf8'));
  const env = path.join(tdir, 'environment');
  const image = typeof toml.environment?.docker_image === 'string' ? (toml.environment.docker_image as string) : undefined;
  const empty = path.join(os.tmpdir(), 'oh-bench-empty-repo');
  return {
    id,
    prompt: `${instruction}\n\nWhen you are done, stop; the task is checked by hidden tests.`,
    // The workspace is what the task image puts in its WORKDIR (seeded from the image); there is no repo directory.
    repoDir: fs.existsSync(path.join(tdir, 'repo')) ? path.join(tdir, 'repo') : (fs.mkdirSync(empty, { recursive: true }), empty),
    hidden: { tests: path.join(tdir, 'tests') },
    acceptance: [HARBOR_ACCEPTANCE],
    timeoutS: Number(toml.agent?.timeout_sec) || 900,
    docker: image && !fs.existsSync(path.join(env, 'Dockerfile')) ? { image, workdir: '/app' } : { build: env, workdir: workdirOf(env) },
    harbor: true,
  };
}

export async function loadTerminalBench(dir: string): Promise<BenchTask[]> {
  const tasks: BenchTask[] = [];
  for (const id of fs.readdirSync(dir).sort()) {
    const tdir = path.join(dir, id);
    if (isHarborTask(tdir)) {
      const t = harborTask(id, tdir);
      if (t) tasks.push(t);
      continue;
    }
    const yml = path.join(tdir, 'task.yaml');
    if (!fs.existsSync(yml)) continue;
    const t = await parseYaml(fs.readFileSync(yml, 'utf8'));
    const instruction = typeof t.instruction === 'string' ? t.instruction : Array.isArray(t.descriptions) ? String(t.descriptions[0]?.description ?? '') : '';
    if (!instruction || !fs.existsSync(path.join(tdir, 'run-tests.sh'))) continue;
    tasks.push({
      id,
      prompt: `${instruction.trim()}\n\nWork in the current directory. When you are done, stop; the task is checked by hidden tests.`,
      repoDir: tdir,
      hidden: { 'run-tests.sh': path.join(tdir, 'run-tests.sh'), tests: path.join(tdir, 'tests') },
      acceptance: ['TEST_DIR="{{HIDDEN}}/tests" bash "{{HIDDEN}}/run-tests.sh"'],
      timeoutS: Number(t.max_agent_timeout_sec) || 900,
      exclude: [...TB_HIDDEN],
      // terminal-bench's convention: the task container works in /app.
      docker: { build: tdir, workdir: '/app' },
    });
  }
  return tasks;
}

// ------------------------------------------------------------ swe-bench

export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  FAIL_TO_PASS: string | string[];
  PASS_TO_PASS?: string | string[];
  repo_path?: string;
  test_cmd?: string;
}

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? (JSON.parse(v) as string[]) : []);
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The SWE-bench base image (`--image`, or TUG_BENCH_PYTHON_IMAGE). It needs python3; pytest is installed by setup when missing. */
export const SWE_DEFAULT_IMAGE = 'python:3.12-slim';
const PYTEST_SETUP = 'python3 -m pytest --version >/dev/null 2>&1 || python3 -m pip install -q pytest';

export function sweTestCommand(inst: SweInstance): string {
  const ids = [...list(inst.FAIL_TO_PASS), ...list(inst.PASS_TO_PASS)];
  if (inst.test_cmd) return inst.test_cmd;
  return `python3 -m pytest -q -p no:cacheprovider ${ids.map(shq).join(' ')}`;
}

/** Materialise the repository at base_commit: a bundled checkout, or a cached clone (network). */
async function sweRepo(inst: SweInstance, jsonlDir: string, cacheDir: string): Promise<string> {
  if (inst.repo_path) return path.resolve(jsonlDir, inst.repo_path);
  const mirror = path.join(cacheDir, 'repos', inst.repo.replace(/[^A-Za-z0-9._-]/g, '__'));
  if (!fs.existsSync(path.join(mirror, 'HEAD')) && !fs.existsSync(path.join(mirror, '.git'))) {
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    await pexec('git', ['clone', '--quiet', '--no-checkout', `https://github.com/${inst.repo}.git`, mirror], { maxBuffer: 1 << 26, timeout: 900_000 });
  }
  const out = path.join(cacheDir, 'checkouts', inst.instance_id.replace(/[^A-Za-z0-9._-]/g, '_'));
  if (!fs.existsSync(out)) {
    fs.mkdirSync(out, { recursive: true });
    const { stdout } = await pexec('git', ['-C', mirror, 'archive', '--format=tar', inst.base_commit], { encoding: 'buffer', maxBuffer: 1 << 30 });
    const tar = path.join(cacheDir, `${inst.instance_id}.tar`);
    fs.writeFileSync(tar, stdout);
    await pexec('tar', ['-xf', tar, '-C', out]);
    fs.rmSync(tar);
  }
  return out;
}

export async function loadSweBench(jsonl: string, cacheDir: string, limit?: number, image = process.env.TUG_BENCH_PYTHON_IMAGE || SWE_DEFAULT_IMAGE): Promise<BenchTask[]> {
  const insts = fs
    .readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SweInstance)
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id))
    .slice(0, limit);
  const tasks: BenchTask[] = [];
  for (const inst of insts) {
    const hiddenDir = path.join(cacheDir, 'hidden', inst.instance_id.replace(/[^A-Za-z0-9._-]/g, '_'));
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, 'test.patch'), inst.test_patch);
    tasks.push({
      id: inst.instance_id.replace(/[^A-Za-z0-9._-]/g, '_'),
      prompt: `You are working in a checkout of ${inst.repo}. Resolve this issue by changing the source code (not the tests):\n\n${inst.problem_statement.trim()}\n\nHidden tests will check your change.`,
      repoDir: await sweRepo(inst, path.dirname(jsonl), cacheDir),
      hidden: { 'test.patch': path.join(hiddenDir, 'test.patch') },
      // The patch is applied on the host (git is there; the bind mount shows it in the container), after the agent.
      prepare: ['git apply --whitespace=nowarn "{{HIDDEN}}/test.patch"'],
      acceptance: [sweTestCommand(inst)],
      timeoutS: 1800,
      docker: { image, workdir: '/testbed', setup: [PYTEST_SETUP] },
    });
  }
  return tasks;
}

// ------------------------------------------------------------ fetching (network permitting)

export const FETCH_HELP = `Fetching the full benchmarks (network permitting):
  terminal-bench:  git clone --depth 1 https://github.com/laude-institute/terminal-bench ~/.tugline/bench/terminal-bench
                   tug bench terminal-bench --data ~/.tugline/bench/terminal-bench/tasks --subset 10
  swe-bench Lite:  tug bench swe-bench --fetch --subset 10      (rows from the Hugging Face datasets server; repos cloned per instance)
                   or download princeton-nlp/SWE-bench_Lite as JSONL and pass --data instances.jsonl
With a Docker daemon, each task runs in its own container (terminal-bench: the task's image; swe-bench: --image, default python:3.12-slim).
Without one (or with --isolation host), tasks run on this machine: install each task's dependencies.`;

/** SWE-bench Lite rows via the Hugging Face datasets server → JSONL. */
export async function fetchSweBench(n: number, outFile: string, dataset = 'princeton-nlp/SWE-bench_Lite', fetchFn: typeof fetch = fetch): Promise<number> {
  const rows: unknown[] = [];
  for (let offset = 0; rows.length < n; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=test&offset=${offset}&length=${Math.min(100, n - rows.length)}`;
    const r = await fetchFn(url);
    if (!r.ok) throw new Error(`datasets server: HTTP ${r.status}`);
    const j: any = await r.json();
    const got = (j.rows ?? []).map((x: any) => x.row);
    if (!got.length) break;
    rows.push(...got);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

// ------------------------------------------------------------ suite building and running

/**
 * Turn benchmark tasks into an eval suite directory (task.json + repo/), with
 * the hidden material outside it. `{{HIDDEN}}` in acceptance commands points
 * at the task's hidden directory.
 */
export function buildSuite(tasks: BenchTask[], suiteDir: string, arms: string[], hiddenRoot: string, image?: string): void {
  fs.mkdirSync(path.join(suiteDir, 'tasks'), { recursive: true });
  const armDefs: Record<string, unknown> = {};
  for (const a of arms) armDefs[a] = BENCH_ARMS[a] ?? {};
  fs.writeFileSync(path.join(suiteDir, 'suite.json'), JSON.stringify({ description: 'generated by tug bench', repeats: 1, arms: armDefs }, null, 2));
  for (const t of tasks) {
    const tdir = path.join(suiteDir, 'tasks', t.id);
    const hidden = path.join(hiddenRoot, t.id);
    fs.mkdirSync(hidden, { recursive: true });
    for (const [name, src] of Object.entries(t.hidden)) if (fs.existsSync(src)) fs.cpSync(src, path.join(hidden, name), { recursive: true });
    fs.mkdirSync(tdir, { recursive: true });
    fs.cpSync(t.repoDir, path.join(tdir, 'repo'), { recursive: true, filter: (src) => !(path.dirname(src) === t.repoDir && (t.exclude ?? []).includes(path.basename(src))) });
    fs.rmSync(path.join(tdir, 'repo', '.git'), { recursive: true, force: true });
    const docker = imageSpec(t, path.join(suiteDir, 'images', t.id), image);
    // `{{HIDDEN}}` stays in the commands: the runner points it at the host copy, or at the container copy (G5).
    fs.writeFileSync(
      path.join(tdir, 'task.json'),
      JSON.stringify({ id: t.id, version: 1, type: 'benchmark', behaviour: 'hidden tests pass', prompt: t.prompt, acceptance: t.acceptance, prepare: t.prepare ?? [], hidden, docker, verification: [], protected: [], timeout_s: t.timeoutS }, null, 2),
    );
  }
}

/**
 * The container spec written into task.json. A task image is built from a copy of its directory without the
 * hidden tests and the solution, so a Dockerfile that copies its whole context cannot leak them into /app.
 */
function imageSpec(t: BenchTask, ctxCopy: string, image?: string): TaskDocker | undefined {
  if (!t.docker) return undefined;
  if (!t.docker.build) return { ...t.docker, image: image ?? t.docker.image };
  const src = t.docker.build;
  if (!fs.existsSync(path.join(src, 'Dockerfile')) && !fs.existsSync(path.join(src, 'docker-compose.yaml')) && !fs.existsSync(path.join(src, 'docker-compose.yml'))) {
    // No image of its own: use --image if given (else the run fails with a clear docker-isolation error).
    return { workdir: t.docker.workdir, setup: t.docker.setup, image };
  }
  fs.mkdirSync(path.dirname(ctxCopy), { recursive: true });
  fs.cpSync(src, ctxCopy, { recursive: true, filter: (p) => !(path.dirname(p) === src && TB_SECRET.includes(path.basename(p))) });
  return { ...t.docker, build: ctxCopy };
}

/**
 * SWE-bench Pro, official grading (v1.1 N1): the predictions file for swe_bench_pro_eval.py, the exact
 * command (in the report), and with --pro-harness the grader run itself.
 */
async function proOfficial(o: BenchOptions, data: string, tasks: BenchTask[]): Promise<void> {
  const ids = new Map<string, string>();
  for (const l of fs.readFileSync(data, 'utf8').split('\n').filter((x) => x.trim())) {
    const inst = JSON.parse(l) as { instance_id: string };
    ids.set(inst.instance_id.replace(/[^A-Za-z0-9._-]/g, '_'), inst.instance_id);
  }
  const records = loadRecords([o.outDir]);
  const predFile = path.join(o.outDir, 'swe-bench-pro-predictions.json');
  fs.writeFileSync(predFile, JSON.stringify(proPredictions(records, ids), null, 2));
  const rawSample = path.join(o.outDir, 'swe-bench-pro-instances.jsonl');
  fs.copyFileSync(data, rawSample);
  const scripts = o.scriptsDir ?? (o.proHarness ? path.join(o.proHarness, 'run_scripts') : '<SWE-bench_Pro-os>/run_scripts');
  const argv = proEvalArgv({ rawSamplePath: rawSample, patchPath: predFile, outputDir: path.join(o.outDir, 'official-eval'), scriptsDir: scripts, dockerhubUser: o.dockerhubUser ?? PRO_DOCKERHUB_USER });
  const graded = tasks.some((t) => t.acceptance.length);
  fs.appendFileSync(
    path.join(o.outDir, 'report.md'),
    `\n## SWE-bench Pro: official grading\n\n${graded ? 'The pass/fail above is the local, indicative grading (run_script.sh + parser.py inside each instance image). ' : 'No run scripts were given (--scripts-dir), so the runs above are not graded locally. '}The authoritative score comes from the official grader, which re-applies each patch in a clean image:\n\n\`\`\`\ncd <SWE-bench_Pro-os> && python ${argv.join(' ')}\n\`\`\`\n\nPredictions: \`${predFile}\` (one entry per run; prefix = arm and repeat). The raw-sample file there is the JSONL this run used; the grader also accepts the CSV from its README.\n`,
  );
  if (o.proHarness) {
    o.log?.(`running the official SWE-bench Pro grader in ${o.proHarness}`);
    const code = await runProGrader(o.proHarness, argv, o.log);
    fs.appendFileSync(path.join(o.outDir, 'report.md'), `\nOfficial grader exit code: ${code}; results in \`${path.join(o.outDir, 'official-eval')}\`.\n`);
  }
}

/** Printed in every host-isolated `tug bench` report: these numbers are not leaderboard numbers. */
export const BENCH_LIMITATIONS = `## Isolation limitations (results are indicative, not leaderboard-comparable)

- Tasks ran on this machine, not in each task's Docker image. A task that needs its image's packages or services fails here for environmental reasons, not because of the agent.
- The hidden tests (terminal-bench \`tests/\`, SWE-bench \`test_patch\`) are kept out of the agent's workspace, but an agent with a full shell can still find them on disk.
- Compare arms and models measured under the same conditions with each other; do not compare these scores with published leaderboards.`;

/** Printed in a docker-isolated `tug bench` report (G5). */
export function benchDockerIsolation(format: BenchFormat, image: string, network: 'bridge' | 'none'): string {
  const where =
    format === 'terminal-bench'
      ? "Each task ran in its own container, from the image built from the task's Dockerfile / docker-compose.yaml (without its tests/ and solution), with the workspace bind-mounted at its WORKDIR (/app)."
      : format === 'swe-bench-pro'
        ? "Each instance ran in its own environment image (`jefzda/sweap-images:<dockerhub_tag>`), with the image's repository copied into the workspace and bind-mounted back at /app."
        : `Each instance ran in its own container from \`${image}\`, with the repository bind-mounted at /testbed.`;
  return `## Isolation

isolated: docker

- ${where} Every bash command of the agent ran via \`docker exec\` in that container (network: ${network}); the file tools work on the same bind-mounted workspace and are confined to it.
- The hidden tests (${format === 'terminal-bench' ? '`tests/` and `run-tests.sh` (Harbor format: `tests/` at /tests)' : format === 'swe-bench-pro' ? '`test_patch`, run_script.sh, parser.py' : '`test_patch`'}) reached the container only after the agent had finished; acceptance ran inside the container.
- Remaining differences from the official harness: ${format === 'terminal-bench' ? 'the agent loop and model run on the host (only commands run in the container), and terminal-bench\'s tmux session is not used (`--harbor` runs the official harness instead)' : format === 'swe-bench-pro' ? '`before_repo_set_cmd` runs before the agent, not again at grading, and local grading is indicative: the official grader (command below) is authoritative' : 'one python base image is used, not the per-instance SWE-bench environment images, so a repository that needs extra dependencies fails unless `--image` provides them'}. Compare arms and models with each other rather than with published leaderboards.`;
}

export interface BenchOptions {
  config: HarnessConfig;
  format: BenchFormat;
  data?: string;
  subset?: number;
  repeats?: number;
  arms?: string[];
  outDir: string;
  fetch?: boolean;
  cacheDir?: string;
  log?: (s: string) => void;
  /** G5: 'auto' (the default) = docker when a Docker daemon is reachable, else host. */
  isolation?: 'auto' | Isolation;
  /** SWE-bench base image, and the image for terminal-bench tasks without a Dockerfile. */
  image?: string;
  /** Network of the task containers while the agent runs (setup always has the default network). */
  network?: 'bridge' | 'none';
  /** v1.1 R10: GPU share for GPU-seconds per resolved task in the paired report. */
  gpuShare?: number;
  /** v1.1 N1 SWE-bench Pro: official run scripts (local grading) and grader checkout (official grading). */
  scriptsDir?: string;
  proHarness?: string;
  dockerhubUser?: string;
  /** v1.1 R18: contention condition label (default quiet, or shared with --load) and synthetic load clients on the endpoint. */
  condition?: string;
  load?: number;
  loadPromptTokens?: number;
  /** v1.1 R18: the predeclared pilot file; compare.md then carries the protocol checks and the decision. */
  pilot?: string;
  /** Suite runs: only these task ids. */
  tasks?: string[];
}

/** Run `fn` under a contention condition: N synthetic clients on the model endpoint while it runs (R18). */
async function underCondition<T>(o: BenchOptions, fn: (condition: () => { name: string; loadClients: number; loadRequests?: number; loadErrors?: number }) => Promise<T>): Promise<T> {
  const clients = o.load ?? 0;
  const name = o.condition ?? (clients > 0 ? 'shared' : 'quiet');
  let gen: LoadGenerator | undefined;
  if (clients > 0) {
    const prof = resolveProfile(o.config);
    gen = startLoad({ baseUrl: prof.baseUrl, model: prof.model, apiKey: prof.apiKey, clients, promptTokens: o.loadPromptTokens });
    o.log?.(`condition ${name}: ${clients} load client(s) on ${prof.baseUrl}`);
  }
  try {
    return await fn(() => ({ name, loadClients: clients, ...(gen ? { loadRequests: gen.stats.requests, loadErrors: gen.stats.errors } : {}) }));
  } finally {
    await gen?.stop();
  }
}

function writeCompare(o: BenchOptions, baseline: string | undefined): void {
  const pilot = o.pilot ? loadPilot(o.pilot) : undefined;
  if (o.pilot) fs.copyFileSync(o.pilot, path.join(o.outDir, 'pilot.json'));
  const compare = compareReport({ records: loadRecords([o.outDir]), gpuShare: o.gpuShare, baseline: pilot?.spec.target.baseline ?? baseline, pilot: pilot?.spec, pilotSha: pilot?.sha });
  fs.writeFileSync(path.join(o.outDir, 'compare.md'), `${compare}\n`);
}

/** R19: an eval suite (editing, coding-basics, …) through the bench machinery: arms, repeats, conditions, compare.md. */
async function runSuiteBench(o: BenchOptions): Promise<ScoredRun[]> {
  if (!o.data) throw new Error('bench suite: --data <suite dir> is required');
  const rows = await underCondition(o, (condition) => runEval({ suiteDir: o.data!, outDir: o.outDir, baseConfig: o.config, arms: o.arms, repeats: o.repeats, tasks: o.tasks, log: o.log, gpuShare: o.gpuShare, condition, armDefs: BENCH_ARMS }));
  writeCompare(o, o.arms?.[0]);
  return rows;
}

export function defaultBenchData(format: BenchFormat, root: string): string {
  if (format === 'suite') return path.join(root, 'evals', 'coding-basics');
  if (format === 'swe-bench-pro') return path.join(root, 'evals', 'bench', 'swe-bench-pro', 'instances.jsonl');
  return format === 'terminal-bench' ? path.join(root, 'evals', 'bench', 'terminal-bench', 'tasks') : path.join(root, 'evals', 'bench', 'swe-bench', 'instances.jsonl');
}

export const PYTEST_MISSING = '`python3 -m pytest` is not available, so every hidden test fails and these results say nothing about the agent. Install pytest for the python3 on PATH (python3 -m pip install pytest) and re-run.';

/** Whether `python3 -m pytest` runs (the bundled benchmark formats score with pytest). */
export function pytestAvailable(): boolean {
  return spawnSync('python3', ['-m', 'pytest', '--version'], { stdio: 'ignore', timeout: 60_000 }).status === 0;
}

/** The task scores with pytest: in its acceptance command, or in terminal-bench's run-tests.sh. */
function usesPytest(t: BenchTask): boolean {
  if (t.acceptance.some((c) => /pytest/.test(c))) return true;
  try {
    return /pytest/.test(fs.readFileSync(t.hidden['run-tests.sh'] ?? '', 'utf8'));
  } catch {
    return false;
  }
}

export async function runBench(o: BenchOptions): Promise<ScoredRun[]> {
  if (o.format === 'suite') return runSuiteBench(o);
  const cache = o.cacheDir ?? path.join(o.config.homeDir, 'bench');
  let data = o.data;
  if (o.fetch) {
    if (o.format === 'terminal-bench') throw new Error(`--fetch supports swe-bench and swe-bench-pro; for terminal-bench:\n${FETCH_HELP}`);
    const pro = o.format === 'swe-bench-pro';
    data = path.join(cache, pro ? 'swe-bench-pro.jsonl' : 'swe-bench-lite.jsonl');
    const n = await fetchSweBench(o.subset ?? 10, data, pro ? 'ScaleAI/SWE-bench_Pro' : undefined);
    o.log?.(`fetched ${n} ${pro ? 'SWE-bench Pro' : 'SWE-bench Lite'} instance(s) → ${data}`);
  }
  if (!data) throw new Error('no --data');
  const isolation = await resolveIsolation(o.isolation ?? 'auto');
  let tasks =
    o.format === 'terminal-bench'
      ? await loadTerminalBench(data)
      : o.format === 'swe-bench-pro'
        ? loadSweBenchPro(data, { cacheDir: cache, limit: o.subset, scriptsDir: o.scriptsDir, dockerhubUser: o.dockerhubUser })
        : await loadSweBench(data, cache, o.subset, o.image || undefined);
  if (o.subset) tasks = tasks.slice(0, o.subset);
  if (!tasks.length) throw new Error(`no ${o.format} tasks found in ${data}`);
  if (isolation !== 'docker' && tasks.some((t) => t.harbor || o.format === 'swe-bench-pro'))
    throw new Error(`${o.format === 'swe-bench-pro' ? 'SWE-bench Pro instances run in their environment images' : 'Harbor-format (Terminal-Bench 2.0+) tasks are verified inside their container'}: they need --isolation docker (no Docker daemon is reachable, or --isolation host was given)`);
  const arms = o.arms?.length ? o.arms : ['default'];
  for (const a of arms) if (!BENCH_ARMS[a]) throw new Error(`unknown arm "${a}" (${Object.keys(BENCH_ARMS).join(', ')})`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `oh-bench-${o.format}-`));
  const suiteDir = path.join(work, 'suite');
  // Hidden tests live outside the temp dir (the agent may read the OS temp dir) and outside its workspace.
  // An agent with an unrestricted shell can still find them; the scorer flags no such reads, so compare arms, not absolutes.
  fs.mkdirSync(path.join(cache, 'hidden-runs'), { recursive: true, mode: 0o700 });
  const hiddenRoot = fs.mkdtempSync(path.join(cache, 'hidden-runs', 'run-'));
  try {
    buildSuite(tasks, suiteDir, arms, hiddenRoot, o.format === 'terminal-bench' ? o.image : undefined);
    o.log?.(`${o.format}: ${tasks.length} task(s) × ${arms.join(', ')} × ${o.repeats ?? 1} repeat(s), isolation: ${isolation}`);
    // R7: without pytest every hidden test "fails", which reads as agent failures (or false_success): say so up front.
    // Only on the host: in docker mode the tests run in the task's image, not with the host's python.
    const noPytest = isolation === 'host' && tasks.some(usesPytest) && !pytestAvailable() ? PYTEST_MISSING : '';
    if (noPytest) o.log?.(`! ${noPytest}`);
    const network = o.network ?? 'bridge';
    const rows = await underCondition(o, (condition) => runEval({ suiteDir, outDir: o.outDir, baseConfig: o.config, arms, repeats: o.repeats ?? 1, log: o.log, isolation, dockerNetwork: network, gpuShare: o.gpuShare, condition }));
    if (noPytest) fs.appendFileSync(path.join(o.outDir, 'report.md'), `\n> **Warning:** ${noPytest}\n`);
    const note = isolation === 'docker' ? benchDockerIsolation(o.format, tasks[0].docker?.image ?? SWE_DEFAULT_IMAGE, network) : BENCH_LIMITATIONS;
    fs.appendFileSync(path.join(o.outDir, 'report.md'), `\n${note}\n`);
    o.log?.(note.replace(/^## .*\n\n/, ''));
    // v1.1 R10: the paired report over this run's arms (several arms, or repeats).
    writeCompare(o, arms[0]);
    if (o.format === 'swe-bench-pro') await proOfficial(o, data, tasks);
    return rows;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(hiddenRoot, { recursive: true, force: true });
  }
}
