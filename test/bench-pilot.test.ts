/**
 * v1.1 R18 (pilot protocol in `tug bench --compare`: installed + pinned Cline, fixed conditions, prompts recorded,
 * tuning effort, held-out split, repeats, contention runs, judges, predeclared target, ablations) and
 * R19 (one command for the live editing + coding suites with an interval report), WS8.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, testConfig, type MockServer } from './helpers.js';
import { runEval } from '../src/core/eval/runner.js';
import { compareReport, evaluateRule, loadPilot, loadRecords, pilotChecks, summarizeArms, type PilotSpec } from '../src/core/eval/compare.js';
import { ablationArm, BENCH_ARMS, expandArms, runBench } from '../src/core/eval/bench.js';
import { CLINE_PINNED, EXTERNAL_PRESETS, resolveExternal, substitute } from '../src/core/eval/external.js';
import { startLoad } from '../src/core/eval/contention.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/eval/commands.js';

const ROOT = process.cwd();
const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Two tiny tasks: write ok to answer.txt (hidden check), with a protected judge file. */
function suite(dir: string, arms: Record<string, unknown>, ids = ['t1', 't2']): string {
  for (const id of ids) {
    const t = path.join(dir, 'tasks', id);
    fs.mkdirSync(path.join(t, 'repo', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(t, 'repo', 'tests', 'judge.txt'), 'judge\n');
    fs.writeFileSync(path.join(t, 'task.json'), JSON.stringify({ id, prompt: `Write ok to answer.txt (${id}).`, acceptance: ['test "$(cat answer.txt)" = ok'], protected: ['tests/**'], timeout_s: 60 }));
  }
  fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify({ repeats: 1, arms }));
  return dir;
}

/** Tugline solves with bash; a fake external agent says it fixed things but does nothing. Load requests answer quickly. */
function model() {
  return (body: any) => {
    const p = JSON.stringify(body.messages);
    if (/You are load client/.test(p)) return { content: 'summary' };
    if (/LAZY_AGENT/.test(p)) return { content: 'ok' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'printf "ok\\n" > answer.txt' } }] } : { content: 'Done.' };
  };
}

function lazyAgent(dir: string): string {
  const f = path.join(dir, 'lazy-agent.sh');
  fs.writeFileSync(f, `#!/bin/bash\ncurl -s -X POST "$1/chat/completions" -H 'content-type: application/json' -d '{"model":"m","messages":[{"role":"system","content":"LAZY_AGENT system prompt v1"},{"role":"user","content":"go"}]}' > /dev/null\necho "Fixed it, all tests pass."\n`);
  fs.chmodSync(f, 0o755);
  return f;
}

// ------------------------------------------------------------ R18 arms

test('R18: installed and pinned Cline presets; the pinned one runs a fixed release through npx', () => {
  assert.match(CLINE_PINNED, /^\d+\.\d+\.\d+$/);
  const p = resolveExternal('cline-pinned');
  assert.equal(p.pin, CLINE_PINNED);
  const vars = { pin: p.pin!, workspace: '/w', prompt: 'x', base_url: 'http://127.0.0.1:1/v1', model: 'q', api_key: 'k', timeout_s: '60', state: '/s' };
  assert.equal(substitute(p.version!, vars, true), `npx -y cline@'${CLINE_PINNED}' --version`);
  assert.match(substitute(p.command!, vars, true), new RegExp(`^npx -y cline@'${CLINE_PINNED.replace(/\./g, '\\.')}' --json --auto-approve true `));
  assert.equal(resolveExternal({ preset: 'cline-pinned', pin: '3.0.50' }).pin, '3.0.50');
  assert.match(EXTERNAL_PRESETS.cline.title, /installed/);
  assert.deepEqual(expandArms('pilot'), ['default', 'cline', 'cline-pinned', 'mini-swe-agent']);
  assert.deepEqual(expandArms('ablations,default'), ['oh-full', 'oh-no-planner', 'oh-no-reviewer', 'oh-no-subagents', 'oh-no-code-mode', 'oh-simple', 'default']);
  assert.ok(expandArms('pilot').every((a) => BENCH_ARMS[a]));
});

test('R18: ablation switches (planner, reviewer, subagents, Code Mode) change what the agent gets, and the paired report has an ablation table', async () => {
  assert.deepEqual(ablationArm(['subagents']).__withoutTools, ['task']);
  assert.deepEqual(ablationArm(['planner']).__withoutTools, ['todo_write', 'exit_plan_mode']);
  assert.deepEqual((ablationArm(['reviewer']).agent as any).autoValidate, false);
  assert.deepEqual((ablationArm(['codeMode']).codeMode as any).enabled, false);
  const mock = await startMockServer(model());
  servers.push(mock);
  const dir = suite(tmp('oh-abl-'), { 'oh-full': BENCH_ARMS['oh-full'], 'oh-no-subagents': BENCH_ARMS['oh-no-subagents'], 'oh-simple': BENCH_ARMS['oh-simple'] }, ['t1']);
  const outDir = tmp('oh-abl-out-');
  const toolsSeen: Record<string, string[]> = {};
  for (const arm of ['oh-full', 'oh-no-subagents', 'oh-simple']) {
    const mark = mock.requests.length;
    const rows = await runEval({ suiteDir: dir, outDir: path.join(outDir, arm), baseConfig: testConfig(mock.url), arms: [arm] });
    assert.deepEqual(rows.map((r) => r.outcome), ['pass'], arm);
    toolsSeen[arm] = (mock.requests.slice(mark).find((b) => (b.tools ?? []).length)?.tools ?? []).map((t: any) => t.function.name);
  }
  const { 'oh-full': full, 'oh-no-subagents': noSub, 'oh-simple': simple } = toolsSeen;
  assert.ok(full.includes('task') && full.includes('todo_write'), full.join(','));
  assert.ok(!noSub.includes('task') && noSub.includes('todo_write'), noSub.join(','));
  assert.ok(!simple.includes('task') && !simple.includes('todo_write') && !simple.includes('exit_plan_mode') && simple.includes('bash') && simple.includes('read_file'), simple.join(','));
  const recs = loadRecords(['oh-full', 'oh-no-subagents', 'oh-simple'].map((a) => path.join(outDir, a)));
  assert.deepEqual(recs.find((r) => r.manifest.arm === 'oh-simple')!.manifest.ablation, { planner: false, reviewer: false, subagents: false, codeMode: false });
  const report = compareReport({ records: recs });
  assert.match(report, /## Ablations \(vs oh-full\)/);
  assert.match(report, /\| oh-no-subagents \| on \| on \| off \| on \| 1\/1 \| 0 \|/);
  assert.match(report, /\| oh-simple \| off \| off \| off \| off \| 1\/1 \| 0 \|/);
});

// ------------------------------------------------------------ R18 contention + prompts

test('R18: shared-server contention runs — load clients hit the same endpoint during the run, and each manifest records the condition', async () => {
  const mock = await startMockServer(model());
  servers.push(mock);
  const g = startLoad({ baseUrl: mock.url, model: 'm', clients: 2, promptTokens: 50 });
  await new Promise((r) => setTimeout(r, 300));
  await g.stop();
  assert.ok(g.stats.requests >= 2 && g.stats.errors === 0, JSON.stringify(g.stats));
  const dir = suite(tmp('oh-cont-'), { default: {} }, ['t1']);
  const outDir = tmp('oh-cont-out-');
  const before = mock.requests.length;
  await runBench({ config: testConfig(mock.url), format: 'suite', data: dir, outDir, load: 2, loadPromptTokens: 50 });
  const rec = loadRecords([outDir])[0];
  assert.equal(rec.manifest.condition?.name, 'shared');
  assert.equal(rec.manifest.condition?.loadClients, 2);
  assert.ok((rec.manifest.condition?.loadRequests ?? 0) > 0, 'load was running while the task ran');
  assert.ok(mock.requests.slice(before).some((b) => /You are load client/.test(JSON.stringify(b.messages))));
  const quiet = tmp('oh-cont-quiet-');
  await runBench({ config: testConfig(mock.url), format: 'suite', data: dir, outDir: quiet });
  assert.deepEqual(loadRecords([quiet])[0].manifest.condition, { name: 'quiet', loadClients: 0 });
  // Two conditions in one report: a section per condition.
  assert.match(compareReport({ records: loadRecords([quiet, outDir]) }), /## Condition: quiet[\s\S]*## Condition: shared/);
});

// ------------------------------------------------------------ R18 pilot protocol and decision

test('R18: the pilot report checks the protocol (fixed conditions, prompts, tuning, held-out, repeats, contention, judges, predeclared) and evaluates the predeclared target per condition', async () => {
  const mock = await startMockServer(model());
  servers.push(mock);
  const dir = tmp('oh-pilot-');
  const lazy = lazyAgent(dir);
  suite(dir, { default: {}, cline: { external: { command: `${lazy} {{base_url}}`, version: 'echo cline 3.0.70' } } }, ['t1', 't2', 't3']);
  const declaredAt = new Date(Date.now() - 60_000).toISOString();
  const outQ = tmp('oh-pilot-q-');
  const outS = tmp('oh-pilot-s-');
  await runEval({ suiteDir: dir, outDir: outQ, baseConfig: testConfig(mock.url), repeats: 1, condition: () => ({ name: 'quiet', loadClients: 0 }) });
  await runEval({ suiteDir: dir, outDir: outS, baseConfig: testConfig(mock.url), repeats: 1, condition: () => ({ name: 'shared', loadClients: 4, loadRequests: 10 }) });
  const records = loadRecords([outQ, outS]);
  // Harness prompts: Tugline's own and the external agent's (seen by the metering proxy), hashed per run, text once per arm.
  assert.ok(records.every((r) => /^[0-9a-f]{16}$/.test(r.manifest.systemPromptSha ?? '')), JSON.stringify(records.map((r) => r.manifest.systemPromptSha)));
  assert.equal(fs.readFileSync(path.join(outQ, 'prompts', 'cline.txt'), 'utf8'), 'LAZY_AGENT system prompt v1');
  assert.ok(fs.readFileSync(path.join(outQ, 'prompts', 'default.txt'), 'utf8').length > 200);
  const pilot: PilotSpec = {
    name: 'unit pilot',
    declaredAt,
    model: { weights: 'mock.gguf', sha256: 'abc123', quant: 'Q4_K_M', chatTemplate: 'chatml', server: 'mock-server' },
    arms: { default: { tuningHours: 4 }, cline: { tuningHours: 4 } },
    heldOut: ['t2', 't3'],
    minTasks: 2,
    targetTasks: 100,
    minRepeats: 1,
    target: { candidate: 'default', baseline: 'cline', rules: [] },
  };
  const file = path.join(dir, 'pilot.json');
  fs.writeFileSync(file, JSON.stringify(pilot));
  const { spec, sha } = loadPilot(file);
  assert.equal(spec.target.rules.length, 5, 'the default decision rule of PILOT.md §6');
  const checks = pilotChecks(records, spec, sha);
  const st = (name: string) => checks.find((c) => c.check.startsWith(name))?.status;
  assert.equal(st('same model'), 'ok');
  assert.equal(st('same endpoint'), 'ok');
  assert.equal(st('same context window'), 'ok');
  assert.equal(st('same generation budget'), 'ok');
  assert.equal(st('harness prompts recorded'), 'ok');
  assert.equal(st('equal tuning effort'), 'ok');
  assert.equal(st('held-out tasks'), 'warn', 'above the minimum, below the 100-task target');
  assert.equal(st('contention conditions'), 'ok');
  assert.equal(st('judges outside'), 'warn', 'host-isolated runs are flagged');
  assert.equal(st('target predeclared'), 'ok');
  assert.equal(st('installed and pinned Cline'), 'warn', 'only one Cline arm');
  const report = compareReport({ records, pilot: spec, pilotSha: sha });
  assert.match(report, /^# Pilot: unit pilot/);
  assert.match(report, /### quiet[\s\S]*resolvedRate higher \| ✅ met \| 100% > 0%[\s\S]*falseSuccessRate notHigher \| ✅ met[\s\S]*### shared/);
  assert.match(report, /\*\*Verdict:\*\* the predeclared target is met under every condition/);
  assert.match(report, /## Held-out results: quiet[\s\S]*\| default \| Tugline \| 2 \| 2 \(100%\)/, 'the decision uses held-out tasks only');
  assert.match(report, /## Development tasks \(tuning set; not used for the decision\)[\s\S]*\| default \| Tugline \| 2 \| 2 \(100%\)/);
  // Failures that void a pilot: a target declared after the runs, unequal tuning, missing repeats, a missing condition, mixed models.
  const late = pilotChecks(records, { ...spec, declaredAt: new Date().toISOString(), minRepeats: 3, arms: { default: { tuningHours: 10 }, cline: { tuningHours: 2 } }, conditions: ['quiet', 'shared', 'peak'] });
  for (const name of ['target predeclared', 'equal tuning effort', '≥ 3 repeats', 'contention conditions']) assert.equal(late.find((c) => c.check.startsWith(name))?.status, 'fail', name);
  const mixed = records.map((r, i) => (i === 0 ? { ...r, manifest: { ...r.manifest, temperature: 0.9 } } : r));
  assert.equal(pilotChecks(mixed, spec).find((c) => c.check.startsWith('same sampling'))?.status, 'fail');
  assert.match(compareReport({ records, pilot: { ...spec, heldOut: undefined } }), /held-out split \| ❌ \| no heldOut task list declared/);
  // Rules: the interval rule and ratios.
  const arms = summarizeArms({ records: records.filter((r) => r.manifest.condition?.name === 'quiet') }).arms;
  const cand = arms.find((a) => a.arm === 'default')!;
  const base = arms.find((a) => a.arm === 'cline')!;
  assert.equal(evaluateRule({ metric: 'resolvedRate', kind: 'ciNotBelow' }, cand, base).pass, true);
  assert.equal(evaluateRule({ metric: 'resolvedRate', kind: 'higher', margin: 1 }, cand, base).pass, false);
  // Through the CLI: tug bench --compare --pilot.
  const out: string[] = [];
  assert.equal(await getCliCommand('bench')!.run(['--compare', `${outQ},${outS}`, '--pilot', file, '--out', path.join(dir, 'pilot.md')], { config: testConfig(mock.url), workspace: ROOT, write: (t) => out.push(t) }), 0, out.join('\n'));
  assert.match(fs.readFileSync(path.join(dir, 'pilot.md'), 'utf8'), /## Protocol checks/);
});

// ------------------------------------------------------------ R19

test('R19: scripts/live-evals.sh runs the suites live against any endpoint for several models and writes one interval report', async () => {
  const mock = await startMockServer(model());
  servers.push(mock);
  const out = path.join(tmp('oh-live-'), 'live');
  const env: NodeJS.ProcessEnv = { ...process.env, TUG_BIN: `node --import tsx ${path.join(ROOT, 'src', 'cli', 'main.ts')}`, HOME: tmp('oh-live-home-') };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const code = await new Promise<number | null>((resolve) => {
    const p = spawn('bash', [path.join(ROOT, 'scripts', 'live-evals.sh'), '--url', mock.url, '--models', 'model-a,model-b', '--suites', 'coding-basics', '--tasks', 't04-js-word-count', '--arm', 'guarded', '--repeats', '2', '--gpu-share', '0.5', '--out', out], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (c) => {
      if (c !== 0) console.error(log);
      resolve(c);
    });
  });
  assert.equal(code, 0);
  const report = fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8');
  // One row per model (arm @ model), with Wilson intervals over the 2 repeats, and GPU-seconds at the declared share.
  assert.match(report, /\| guarded @ model-a \| Tugline \| 2 \| \d \(\d+%\) \| \d+%–\d+% \|/);
  assert.match(report, /\| guarded @ model-b \| Tugline \| 2 \|/);
  assert.match(report, /Endpoint `http:\/\/127\.0\.0\.1:\d+\/v1`, models `model-a,model-b`, suites `coding-basics`, 2 repeat\(s\)/);
  assert.ok(fs.existsSync(path.join(out, 'coding-basics.md')));
  const recs = loadRecords([path.join(out, 'model-a', 'coding-basics'), path.join(out, 'model-b', 'coding-basics')]);
  assert.deepEqual([...new Set(recs.map((r) => r.manifest.model))].sort(), ['model-a', 'model-b']);
  assert.ok(recs.every((r) => r.manifest.gpuShare === 0.5 && r.manifest.task === 't04-js-word-count'));
  // bash 3.2 (macOS) compatibility: no associative arrays, mapfile or ${x,,}.
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'live-evals.sh'), 'utf8');
  assert.ok(!/declare -A|mapfile|readarray|\$\{\w+,,\}|\$\{\w+\^\^\}/.test(src));
});
