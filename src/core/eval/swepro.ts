/**
 * SWE-bench Pro (public set, ScaleAI/SWE-bench_Pro; v1.1 N1).
 *
 * Each instance has its own environment image (`jefzda/sweap-images:<dockerhub_tag>`)
 * with the repository at /app, already at the base commit and with its
 * dependencies installed. Tugline runs the agent in that image with our
 * docker isolation (G5): the image's /app is copied into the bind-mounted
 * workspace, `before_repo_set_cmd` runs as container setup, and every agent
 * command runs via `docker exec`.
 *
 * Grading:
 *  - Official (authoritative): every run's diff is exported as the grader's
 *    predictions file (`[{instance_id, patch, prefix}]`) and the report
 *    prints the `swe_bench_pro_eval.py` command of github.com/scaleapi/SWE-bench_Pro-os,
 *    which re-applies each patch in a clean image and runs the instance's
 *    run_script.sh / parser.py. `--pro-harness <checkout>` runs it for you.
 *  - Local (indicative, needs `--scripts-dir <checkout>/run_scripts`): after the
 *    agent, the hidden test patch is applied to the workspace, then the
 *    instance's run_script.sh runs inside the container on
 *    `selected_test_files_to_run`, parser.py turns its output into test
 *    statuses, and the run passes when every FAIL_TO_PASS and PASS_TO_PASS
 *    test PASSED. Deviation: `before_repo_set_cmd` runs before the agent, not
 *    again at grading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { BenchTask } from './bench.js';
import type { RawRunRecord } from './scorer.js';

export interface SweProInstance {
  instance_id: string;
  repo: string;
  base_commit?: string;
  problem_statement: string;
  requirements?: string;
  interface?: string;
  fail_to_pass: string | string[];
  pass_to_pass?: string | string[];
  test_patch?: string;
  dockerhub_tag?: string;
  before_repo_set_cmd?: string;
  selected_test_files_to_run?: string | string[];
  repo_language?: string;
  /** Extensions used by the bundled sample: a local image and a local checkout instead of the image's /app. */
  image?: string;
  repo_path?: string;
}

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? (JSON.parse(v) as string[]) : []);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

export const PRO_DOCKERHUB_USER = 'jefzda';

export function proImage(inst: SweProInstance, user = PRO_DOCKERHUB_USER): string {
  if (inst.image) return inst.image;
  if (!inst.dockerhub_tag) throw new Error(`${inst.instance_id}: no dockerhub_tag (and no image)`);
  return `${user}/sweap-images:${inst.dockerhub_tag}`;
}

export function proPrompt(inst: SweProInstance): string {
  const parts = [`You are working in a checkout of ${inst.repo}. Resolve this issue by changing the source code (not the tests):`, '', inst.problem_statement.trim()];
  if (inst.requirements?.trim()) parts.push('', 'Requirements:', inst.requirements.trim());
  if (inst.interface?.trim()) parts.push('', 'Interface:', inst.interface.trim());
  parts.push('', 'Hidden tests will check your change.');
  return parts.join('\n');
}

/** The checker that runs after parser.py: every required test must be PASSED in output.json. */
export function proCheckScript(inst: SweProInstance): string {
  const want = [...list(inst.fail_to_pass), ...list(inst.pass_to_pass)];
  return `import json, sys
want = ${JSON.stringify(want)}
data = json.load(open(sys.argv[1]))
status = {t.get("name"): t.get("status") for t in data.get("tests", [])}
missing = [t for t in want if status.get(t) != "PASSED"]
for t in want:
    print(("PASSED " if status.get(t) == "PASSED" else "NOT PASSED ") + t + (" (" + str(status.get(t)) + ")" if status.get(t) != "PASSED" else ""))
sys.exit(1 if missing else 0)
`;
}

export interface LoadProOptions {
  cacheDir: string;
  limit?: number;
  /** Official run scripts (<SWE-bench_Pro-os>/run_scripts): enables local grading. */
  scriptsDir?: string;
  dockerhubUser?: string;
}

export function loadSweBenchPro(jsonl: string, o: LoadProOptions): BenchTask[] {
  const insts = fs
    .readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as SweProInstance)
    .sort((a, b) => a.instance_id.localeCompare(b.instance_id))
    .slice(0, o.limit);
  const tasks: BenchTask[] = [];
  for (const inst of insts) {
    const id = safe(inst.instance_id);
    const hiddenDir = path.join(o.cacheDir, 'hidden-pro', id);
    fs.rmSync(hiddenDir, { recursive: true, force: true });
    fs.mkdirSync(hiddenDir, { recursive: true });
    const hidden: Record<string, string> = {};
    if (inst.test_patch) {
      fs.writeFileSync(path.join(hiddenDir, 'test.patch'), inst.test_patch);
      hidden['test.patch'] = path.join(hiddenDir, 'test.patch');
    }
    fs.writeFileSync(path.join(hiddenDir, 'check.py'), proCheckScript(inst));
    hidden['check.py'] = path.join(hiddenDir, 'check.py');
    const scripts = o.scriptsDir ? path.join(o.scriptsDir, inst.instance_id) : undefined;
    const graded = !!scripts && fs.existsSync(path.join(scripts, 'run_script.sh')) && fs.existsSync(path.join(scripts, 'parser.py'));
    if (graded) {
      hidden['run_script.sh'] = path.join(scripts!, 'run_script.sh');
      hidden['parser.py'] = path.join(scripts!, 'parser.py');
    }
    const selected = list(inst.selected_test_files_to_run).join(',');
    // The repo comes from the image's /app (seeded into the workspace); a bundled sample may bring its own.
    const repoDir = inst.repo_path ? path.resolve(path.dirname(jsonl), inst.repo_path) : path.join(o.cacheDir, 'empty-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    tasks.push({
      id,
      prompt: proPrompt(inst),
      repoDir,
      hidden,
      prepare: inst.test_patch ? ['git apply --whitespace=nowarn "{{HIDDEN}}/test.patch"'] : [],
      acceptance: graded
        ? [`bash "{{HIDDEN}}/run_script.sh" ${JSON.stringify(selected)} > /tmp/oh-pro-stdout.log 2> /tmp/oh-pro-stderr.log; python3 "{{HIDDEN}}/parser.py" /tmp/oh-pro-stdout.log /tmp/oh-pro-stderr.log /tmp/oh-pro-output.json && python3 "{{HIDDEN}}/check.py" /tmp/oh-pro-output.json`]
        : [],
      timeoutS: 1800,
      docker: { image: proImage(inst, o.dockerhubUser), workdir: '/app', setup: inst.before_repo_set_cmd?.trim() ? [inst.before_repo_set_cmd] : [] },
    });
  }
  return tasks;
}

/** The official grader's predictions file, from the raw run records (one entry per run, prefix = arm and repeat). */
export function proPredictions(records: RawRunRecord[], ids: Map<string, string>): { instance_id: string; patch: string; prefix: string }[] {
  return records.map((r) => ({ instance_id: ids.get(r.manifest.task) ?? r.manifest.task, patch: r.finalDiff, prefix: `${r.manifest.arm}_r${r.manifest.repeat}` }));
}

export function proEvalArgv(o: { rawSamplePath: string; patchPath: string; outputDir: string; scriptsDir: string; workers?: number; dockerhubUser?: string }): string[] {
  return ['swe_bench_pro_eval.py', `--raw_sample_path=${o.rawSamplePath}`, `--patch_path=${o.patchPath}`, `--output_dir=${o.outputDir}`, `--scripts_dir=${o.scriptsDir}`, `--num_workers=${o.workers ?? 4}`, `--dockerhub_username=${o.dockerhubUser ?? PRO_DOCKERHUB_USER}`];
}

/** Run the official grader from a SWE-bench_Pro-os checkout (it starts its own containers). */
export function runProGrader(harness: string, argv: string[], log?: (s: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.env.TUG_PYTHON ?? 'python3', argv, { cwd: harness, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => log?.(l));
    child.stdout.on('data', line);
    child.stderr.on('data', line);
    child.on('error', (e) => {
      log?.(`cannot run the SWE-bench Pro grader: ${e.message}`);
      resolve(127);
    });
    child.on('close', resolve);
  });
}

export const PRO_HELP = `SWE-bench Pro (public):
  1. Rows: download ScaleAI/SWE-bench_Pro (test split) as JSONL, or: tug bench swe-bench-pro --fetch --subset N
  2. Grader: git clone https://github.com/scaleapi/SWE-bench_Pro-os  (run_scripts/ and swe_bench_pro_eval.py)
  3. tug bench swe-bench-pro --data pro.jsonl --scripts-dir SWE-bench_Pro-os/run_scripts [--pro-harness SWE-bench_Pro-os] --repeats 3
Each instance runs in jefzda/sweap-images:<dockerhub_tag> (pulled by Docker; several GB each). The predictions file for
the official grader is written next to the report; --pro-harness also runs it.`;
