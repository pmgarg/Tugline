/**
 * v1.1 R10 (external-agent arms, paired report) and N1 (Terminal-Bench in Harbor format and through Harbor,
 * SWE-bench Pro), WS8. The docker parts skip with a reason when Docker or a base image is missing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, testConfig, type MockServer } from './helpers.js';
import { runEval } from '../src/core/eval/runner.js';
import { compareReport, loadRecords, percentile, signTest, summarizeArms, wilson } from '../src/core/eval/compare.js';
import { EXTERNAL_PRESETS, resolveExternal, startMeteringProxy, substitute } from '../src/core/eval/external.js';
import { harborArgv, HARBOR_AGENT_PY, readHarborResults } from '../src/core/eval/harbor.js';
import { loadTerminalBench, runBench } from '../src/core/eval/bench.js';
import { loadSweBenchPro } from '../src/core/eval/swepro.js';
import { dockerAvailable } from '../src/core/eval/isolation.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/eval/commands.js';

const ROOT = process.cwd();
const TBH = path.join(ROOT, 'evals', 'bench', 'terminal-bench-harbor', 'tasks');
const PRO = path.join(ROOT, 'evals', 'bench', 'swe-bench-pro', 'instances.jsonl');
const PRO_SCRIPTS = path.join(ROOT, 'evals', 'bench', 'swe-bench-pro', 'run_scripts');
const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ------------------------------------------------------------ statistics

test('R10: Wilson intervals, percentiles and the sign test', () => {
  const [lo, hi] = wilson(7, 10);
  assert.ok(Math.abs(lo - 0.3968) < 1e-3 && Math.abs(hi - 0.8922) < 1e-3, `${lo} ${hi}`);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.ok(wilson(0, 5)[0] === 0 && wilson(5, 5)[1] === 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(signTest(0, 0), 1);
  assert.ok(Math.abs(signTest(8, 0) - 0.0078125) < 1e-9);
  assert.ok(Math.abs(signTest(5, 5) - 1) < 1e-9);
});

// ------------------------------------------------------------ external arms

test('R10: every external preset (Cline, Aider, OpenHands, Codex, mini-swe-agent) has a command, a version probe and install/docs, and substitutes cleanly', () => {
  assert.deepEqual(Object.keys(EXTERNAL_PRESETS).sort(), ['aider', 'cline', 'cline-pinned', 'codex', 'mini-swe-agent', 'openhands']);
  const vars = { pin: '3.0.74', workspace: '/w', prompt: "it's a bug", prompt_file: '/s/p.txt', base_url: 'http://127.0.0.1:1/v1', base_url_toml: '"http://127.0.0.1:1/v1"', model: 'qwen', api_key: 'sk-test', timeout_s: '60', state: '/s' };
  for (const [name, p] of Object.entries(EXTERNAL_PRESETS)) {
    assert.ok(p.command && p.version && p.install && /^https:\/\//.test(p.docs), name);
    const cmd = substitute(p.command!, vars, true);
    assert.ok(!/\{\{\w+\}\}/.test(cmd), `${name}: ${cmd}`);
    assert.ok(cmd.includes(`'it'\\''s a bug'`), `${name}: the prompt is shell-quoted`);
    for (const v of Object.values(p.env ?? {})) assert.ok(!/\{\{\w+\}\}/.test(substitute(v, vars, false)), name);
  }
  assert.throws(() => resolveExternal('nope'), /unknown external preset/);
  assert.equal(resolveExternal({ preset: 'aider', timeout_s: 9 }).timeout_s, 9);
});

test('R10: the metering proxy forwards to the endpoint and counts requests and tokens (usage, or an estimate)', async () => {
  const mock = await startMockServer(() => ({ content: 'hello' }));
  servers.push(mock);
  const p = await startMeteringProxy(mock.url);
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${p.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
      assert.equal(((await r.json()) as any).choices[0].message.content, 'hello');
    }
    const models = await fetch(`${p.url}/models`);
    assert.equal(models.status, 200);
    assert.deepEqual({ req: p.meter.requests, ok: p.meter.ok, prompt: p.meter.promptTokens, completion: p.meter.completionTokens, est: p.meter.estimated }, { req: 2, ok: 2, prompt: 201, completion: 40, est: false });
    assert.equal(mock.requests.length, 2, 'the listing is forwarded but not metered as a model call');
  } finally {
    await p.close();
  }
});

/** A fake external agent CLI: calls the (metered) endpoint once, then "fixes" the task the way its argv says. */
function fakeAgent(dir: string): string {
  const f = path.join(dir, 'fake-agent.sh');
  fs.writeFileSync(
    f,
    `#!/bin/bash
# usage: fake-agent.sh <base_url> <model> <mode> <prompt>
curl -s -X POST "$1/chat/completions" -H "authorization: Bearer $FAKE_KEY" -H 'content-type: application/json' -d '{"model":"'"$2"'","messages":[{"role":"user","content":"FAKE_AGENT_CALL"}]}' > /dev/null
case "$3" in
  fix) printf 'ok\\n' > answer.txt ;;
  cheat) printf 'ok\\n' > answer.txt; echo hacked > tests/judge.txt ;;
  lazy) ;;
esac
echo "All done, fixed."
`,
  );
  fs.chmodSync(f, 0o755);
  return f;
}

function suite(dir: string, arms: Record<string, unknown>): string {
  for (const id of ['t1', 't2']) {
    const t = path.join(dir, 'tasks', id);
    fs.mkdirSync(path.join(t, 'repo', 'tests'), { recursive: true });
    fs.writeFileSync(path.join(t, 'repo', 'tests', 'judge.txt'), 'judge\n');
    fs.writeFileSync(path.join(t, 'task.json'), JSON.stringify({ id, prompt: `Write ok to answer.txt (${id}).`, acceptance: ['test "$(cat answer.txt)" = ok'], protected: ['tests/**'], timeout_s: 60 }));
  }
  fs.writeFileSync(path.join(dir, 'suite.json'), JSON.stringify({ repeats: 1, arms }));
  return dir;
}

test('R10: an external-agent arm runs another CLI in the same workspace and endpoint, scored by the same scorer (integrity, false success, version, metered tokens)', async () => {
  const mock = await startMockServer((body) => {
    const p = JSON.stringify(body.messages);
    if (/FAKE_AGENT_CALL/.test(p)) return { content: 'ok' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'printf "ok\\n" > answer.txt' } }] } : { content: 'Done.' };
  });
  servers.push(mock);
  const dir = tmp('oh-ext-suite-');
  const agentBin = fakeAgent(dir);
  const ext = (mode: string) => ({ external: { command: `${agentBin} {{base_url}} {{model}} ${mode} {{prompt}}`, version: 'echo fake-agent 1.2.3', env: { FAKE_KEY: '{{api_key}}' }, timeout_s: 60 }, gpuShare: 0.5 });
  suite(dir, { default: {}, fixer: ext('fix'), cheater: ext('cheat'), lazy: ext('lazy') });
  const outDir = tmp('oh-ext-out-');
  const rows = await runEval({ suiteDir: dir, outDir, baseConfig: testConfig(mock.url), gpuShare: 1 });
  const by = (arm: string) => rows.filter((r) => r.arm === arm);
  assert.deepEqual(by('default').map((r) => r.outcome), ['pass', 'pass']);
  assert.deepEqual(by('fixer').map((r) => [r.outcome, r.integrity]), [['pass', 'clean'], ['pass', 'clean']]);
  assert.deepEqual(by('cheater').map((r) => r.integrity), ['protected_write', 'protected_write'], 'the same integrity check applies to an external agent');
  assert.deepEqual(by('lazy').map((r) => [r.outcome, r.verification]), [['fail', 'false_success'], ['fail', 'false_success']]);
  const rec = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 't1__fixer__r1.json'), 'utf8'));
  assert.equal(rec.manifest.external.version, 'fake-agent 1.2.3');
  assert.equal(rec.manifest.agentIsolation, 'host');
  assert.equal(rec.manifest.gpuShare, 0.5);
  assert.ok(!JSON.stringify(rec).includes('sk-test-1234567890abcdef'), 'the API key is never recorded');
  assert.match(rec.manifest.external.command, /fake-agent\.sh 'http:\/\/127\.0\.0\.1:\d+\/v1' 'mock-model' fix 'Write ok to answer\.txt \(t1\)\.'$/);
  assert.deepEqual([rec.stats.llmCalls, rec.stats.promptTokens > 0, rec.stats.completionTokens], [1, true, 20], 'tokens are metered at the endpoint');
  assert.match(fs.readFileSync(path.join(outDir, 'runs', 't1__fixer__r1.external.log'), 'utf8'), /All done, fixed\./);
  // The paired report: per arm, Wilson CIs, GPU-seconds per resolved, wins/losses vs the baseline.
  const report = compareReport({ records: loadRecords([outDir]), baseline: 'default' });
  assert.match(report, /\| default \| Tugline \| 2 \| 2 \(100%\) \|/);
  assert.match(report, /\| fixer \| custom \(fake-agent 1\.2\.3\) \| 2 \| 2 \(100%\) \|/);
  assert.match(report, /\| lazy \| custom \(fake-agent 1\.2\.3\) \| 2 \| 0 \(0%\) \| 0%–66% \| 2 \(100%\) \|/);
  assert.match(report, /\| lazy vs default \| 0 \| 2 \| 0 \| 0\.500 \|/);
  assert.match(report, /GPU-s \/ resolved/);
  const arms = summarizeArms({ records: loadRecords([outDir]) }).arms;
  const fixer = arms.find((a) => a.arm === 'fixer')!;
  assert.equal(fixer.integrity, 0);
  assert.equal(fixer.editRetries, null, "an external agent's edit retries are not visible");
  assert.ok(fixer.gpuSecondsPerResolved !== null && fixer.gpuSeconds <= arms.find((a) => a.arm === 'fixer')!.p95s * 2 * 0.5 + 0.2, 'GPU-s = wall × 0.5');
  assert.equal(arms.find((a) => a.arm === 'cheater')!.integrity, 2);
  // Through the CLI: tug bench --compare writes compare.md, with a per-arm GPU share.
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['--compare', outDir, '--baseline', 'default', '--gpu-share', 'default=1,fixer=0.25'], { config: testConfig(mock.url), workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  assert.ok(fs.existsSync(path.join(outDir, 'compare.md')));
});

test('R10: a missing external CLI is reported, not scored as an agent failure', async () => {
  const mock = await startMockServer(() => ({ content: 'x' }));
  servers.push(mock);
  const dir = tmp('oh-ext-missing-');
  suite(dir, { gone: { external: { command: 'definitely-not-installed-agent-xyz {{prompt}}', version: 'definitely-not-installed-agent-xyz --version' } } });
  const outDir = tmp('oh-ext-missing-out-');
  const rows = await runEval({ suiteDir: dir, outDir, baseConfig: testConfig(mock.url) });
  assert.deepEqual(rows.map((r) => r.outcome), ['not_evaluable', 'not_evaluable']);
  const rec = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 't1__gone__r1.json'), 'utf8'));
  assert.match(rec.error, /external agent not runnable/);
  assert.match(rec.manifest.external.version, /^unavailable/);
});

test('live 31 Oct: an external agent that never calls the metered endpoint is not_evaluable (misconfigured), not a 0% result', async () => {
  const mock = await startMockServer(() => ({ content: 'x' }));
  servers.push(mock);
  const dir = tmp('oh-ext-nocall-');
  // like Cline with `-P openai`: it runs, talks to some other endpoint (here: none), fails, exits 0
  suite(dir, { offline: { external: { command: 'echo "You didn\'t provide an API key." {{prompt}}', version: 'echo offline-agent 1.0' } } });
  const outDir = tmp('oh-ext-nocall-out-');
  const rows = await runEval({ suiteDir: dir, outDir, baseConfig: testConfig(mock.url), tasks: ['t1'] });
  assert.deepEqual(rows.map((r) => r.outcome), ['not_evaluable']);
  const rec = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 't1__offline__r1.json'), 'utf8'));
  assert.match(rec.error, /never called the model endpoint \(0 metered requests/);
  assert.match(rec.error, /didn't provide an API key/);
});

test('live 31 Oct: the Cline presets run the openai-compatible provider that `cline auth` configured, from one isolated config + data dir', async () => {
  const { EXTERNAL_PRESETS } = await import('../src/core/eval/external.js');
  for (const k of ['cline', 'cline-pinned']) {
    const p = EXTERNAL_PRESETS[k]!;
    assert.match(p.command!, /\s-P openai-compatible\s/, `${k}: -P defaults to Cline's cloud provider; -P openai is api.openai.com`);
    assert.doesNotMatch(p.command!.replace(/^npx -y /, ''), /(^|\s)-y(\s|$)/, `${k}: there is no -y flag in Cline 3.x (npx -y is npx's own)`);
    assert.match(p.setup!, /-b \{\{base_url\}\}/, `${k}: auth points Cline at the metering proxy`);
    for (const flag of ['--config {{state}}/cline', '--data-dir {{state}}/cline/data']) {
      assert.ok(p.setup!.includes(flag) && p.command!.includes(flag), `${k}: auth and run share ${flag}`);
    }
    assert.equal(p.env?.CLINE_DATA_DIR, '{{state}}/cline/data');
  }
});

// ------------------------------------------------------------ N1: Harbor (official runner)

test('N1: tug bench terminal-bench --harbor writes the installed-agent adapter, runs `harbor run`, and reads the trial results', async () => {
  const dir = tmp('oh-harbor-');
  const fake = path.join(dir, 'harbor');
  const argvFile = path.join(dir, 'argv.txt');
  // A stand-in for the harbor CLI: records its argv and env, checks the adapter is importable from PYTHONPATH, writes Harbor-style results.
  fs.writeFileSync(
    fake,
    `#!/bin/bash
printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}
echo "PYTHONPATH=$PYTHONPATH TUG_BASE_URL=$TUG_BASE_URL TUG_MODEL=$TUG_MODEL" >> ${JSON.stringify(argvFile)}
ls "\${PYTHONPATH%%:*}/tugline_agent.py" "\${PYTHONPATH%%:*}/install-tugline.sh.j2" >> ${JSON.stringify(argvFile)}
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
mkdir -p "$out/job1/hello-file__a1" "$out/job1/hello-file__a2" "$out/job1/count-errors__a1"
echo '{"task_name":"hello-file","trial_name":"hello-file__a1","verifier_result":{"rewards":{"reward":1.0}}}' > "$out/job1/hello-file__a1/result.json"
echo '{"task_name":"hello-file","trial_name":"hello-file__a2","verifier_result":{"rewards":{"reward":0.0}}}' > "$out/job1/hello-file__a2/result.json"
echo '{"task_name":"count-errors","trial_name":"count-errors__a1","verifier_result":null,"exception_info":{"exception_message":"agent timed out"}}' > "$out/job1/count-errors__a1/result.json"
echo '{"n_trials":3}' > "$out/job1/result.json"
`,
  );
  fs.chmodSync(fake, 0o755);
  const outDir = path.join(dir, 'out');
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['terminal-bench', '--harbor', '--data', TBH, '--repeats', '2', '--agent-version', 'tugline@1.1.0', '--harbor-bin', fake, '--out', outDir], { config: testConfig('http://127.0.0.1:8080/v1'), workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  const rec = fs.readFileSync(argvFile, 'utf8');
  assert.match(rec, /^run\n-p\n.*terminal-bench-harbor\/tasks\n-a\ntugline_agent:TuglineAgent\n-m\nmock-model\n-o\n.*harbor-jobs\n-k\n2\n-n\n1\n-y\n--ak\nversion=tugline@1\.1\.0\n/);
  assert.match(rec, /TUG_BASE_URL=http:\/\/127\.0\.0\.1:8080\/v1 TUG_MODEL=mock-model/);
  assert.match(rec, /harbor-agent\/tugline_agent\.py$/m);
  assert.match(rec, /harbor-agent\/install-tugline\.sh\.j2$/m);
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, /Trials: 3 over 2 task\(s\); reward ≥ 1: 1 \(33\.3%\)/);
  assert.match(report, /\| count-errors \| 1 \| 0 \| 1 \|/);
  assert.match(report, /isolated: docker/);
  assert.deepEqual(readHarborResults(path.join(outDir, 'harbor-jobs')).map((t) => [t.task, t.reward]), [['count-errors', null], ['hello-file', 1], ['hello-file', 0]]);
  assert.deepEqual(harborArgv({ dataset: 'terminal-bench/terminal-bench@4.0.0', model: 'm', baseUrl: 'u', jobsDir: 'j', adapterDir: 'a', limit: 5 }).slice(0, 3), ['run', '-d', 'terminal-bench/terminal-bench@4.0.0']);
  // The adapter is valid Python, runs tug headless in auto mode, and points a loopback endpoint at the docker host.
  const py = path.join(outDir, 'harbor-agent', 'tugline_agent.py');
  execFileSync('python3', ['-m', 'py_compile', py]);
  assert.match(HARBOR_AGENT_PY, /tug -p \{prompt\} --mode yolo --json/);
  assert.match(HARBOR_AGENT_PY, /async def install\(self, environment[\s\S]*async def run\(self, instruction: str, environment/);
  assert.match(HARBOR_AGENT_PY, /host\.docker\.internal/);
  // Without Harbor installed, the failure says how to install it.
  const out2: string[] = [];
  const code2 = await getCliCommand('bench')!.run(['terminal-bench', '--harbor', '--data', TBH, '--harbor-bin', path.join(dir, 'no-such-harbor'), '--out', path.join(dir, 'out2')], { config: testConfig('http://127.0.0.1:8080/v1'), workspace: ROOT, write: (t) => out2.push(t) });
  assert.equal(code2, 1);
  assert.match(out2.join('\n'), /uv tool install harbor/);
});

test('N1: the bundled Harbor-format (Terminal-Bench 2.0+) samples load: instruction.md, task.toml timeouts, environment image, tests at /tests after the agent', async () => {
  const tasks = await loadTerminalBench(TBH);
  assert.deepEqual(tasks.map((t) => [t.id, t.harbor, t.timeoutS, t.docker?.workdir]), [['count-errors', true, 300, '/app'], ['hello-file', true, 300, '/app']]);
  assert.match(tasks[1].prompt, /^Create a file named hello\.txt/);
  assert.match(tasks[0].acceptance[0], /cp -r "\{\{HIDDEN\}\}\/tests" \/tests[\s\S]*bash \/tests\/test\.sh[\s\S]*reward/);
  assert.ok(tasks[0].docker?.build?.endsWith(path.join('count-errors', 'environment')));
  // Harbor tasks are verified inside their container: host isolation is refused, with the reason.
  await assert.rejects(runBench({ config: testConfig('http://127.0.0.1:9/v1'), format: 'terminal-bench', data: TBH, outDir: tmp('oh-tbh-host-'), isolation: 'host' }), /need --isolation docker/);
});

// ------------------------------------------------------------ docker parts

const imagePresent = (name: string) => {
  try {
    execFileSync('docker', ['image', 'inspect', name], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};
const DOCKER = await dockerAvailable();
const TB_BASE = 'ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624';
const skipUnless = (image: string, why: string) => (DOCKER ? (imagePresent(image) ? false : `${image} is not available locally (${why})`) : 'no Docker daemon is reachable (start dockerd)');

const SOLVE: [RegExp, string][] = [
  [/hello\.txt/, "printf 'Hello, world!\\n' > hello.txt"],
  [/error_count\.txt/, "awk '$3 == \"ERROR\"' app.log | wc -l | tr -d ' ' > error_count.txt"],
  // python, not GNU `sed -i` (R7 portability guard)
  [/word_count miscounts/, "python3 -c \"p='textstats/core.py'; s=open(p).read().replace('text.split(\\\" \\\")', 'text.split()'); open(p,'w').write(s)\""],
];
/** Probe first (the tests must be unreachable), then the fix. */
function solver(probe: string) {
  return (body: any) => {
    const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n === 0) return { toolCalls: [{ name: 'bash', arguments: { command: probe } }] };
    if (n === 1) return { toolCalls: [{ name: 'bash', arguments: { command: SOLVE.find(([re]) => re.test(prompt))?.[1] ?? 'true' } }] };
    return { content: 'Done.' };
  };
}

test('N1 (Harbor format, native): the bundled samples pass in their task images; `find / -name test_*` finds no tests during the agent phase', { skip: skipUnless(TB_BASE, `docker pull ${TB_BASE}`) }, async () => {
  const probe = "find / -xdev \\( -name 'test_outputs.py' -o -name 'test.sh' \\) -not -path '/proc/*' 2>/dev/null | head; ls /tests 2>&1; echo PROBE_END";
  const mock = await startMockServer(solver(probe));
  servers.push(mock);
  const outDir = tmp('oh-tbh-out-');
  const rows = await runBench({ config: testConfig(mock.url), format: 'terminal-bench', data: TBH, outDir, isolation: 'docker' });
  assert.deepEqual(rows.map((r) => [r.task, r.outcome]), [['count-errors', 'pass'], ['hello-file', 'pass']], JSON.stringify(rows));
  const probes = mock.requests.filter((b) => b.messages.filter((m: any) => m.role === 'tool').length === 1).map((b) => String(b.messages.at(-1).content));
  assert.equal(probes.length, 2);
  for (const p of probes) {
    assert.match(p, /ls: cannot access '\/tests': No such file or directory/);
    const found = p.replace(/^\$ find[^\n]*\n/, '').split('PROBE_END')[0];
    assert.ok(!/test_outputs\.py|\/test\.sh/.test(found), `no test file is reachable:\n${p}`);
  }
  const run = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 'hello-file__default__r1.json'), 'utf8'));
  assert.match(run.acceptance[0].output, /reward=1/);
  assert.equal(run.manifest.isolation, 'docker');
  assert.match(fs.readFileSync(path.join(outDir, 'report.md'), 'utf8'), /isolated: docker/);
  // A do-nothing model gets reward 0.
  const idle = await startMockServer(() => ({ content: 'nothing' }));
  servers.push(idle);
  const r2 = await runBench({ config: testConfig(idle.url), format: 'terminal-bench', data: TBH, subset: 1, outDir: tmp('oh-tbh-idle-'), isolation: 'docker' });
  assert.deepEqual(r2.map((r) => r.outcome), ['fail']);
});

test('N1 (SWE-bench Pro): the bundled instance runs in its image, is graded locally with run_script.sh + parser.py, and exports the official predictions', { skip: skipUnless('python:3.12-slim', 'docker pull python:3.12-slim') }, async () => {
  const tasks = loadSweBenchPro(PRO, { cacheDir: tmp('oh-pro-cache-'), scriptsDir: PRO_SCRIPTS });
  assert.deepEqual(tasks.map((t) => [t.id, t.docker?.image, t.docker?.workdir]), [['tugline__textstats-1', 'python:3.12-slim', '/app']]);
  assert.match(tasks[0].prompt, /Requirements:[\s\S]*Interface:/);
  assert.deepEqual(loadSweBenchPro(PRO, { cacheDir: tmp('oh-pro-cache-'), dockerhubUser: 'jefzda' }).map((t) => t.acceptance.length), [0], 'without run scripts there is no local grading (official grader only)');
  const probe = 'grep -c test_multiple_spaces tests/test_core.py; ls /oh-hidden 2>&1; pwd';
  const mock = await startMockServer(solver(probe));
  servers.push(mock);
  const dir = tmp('oh-pro-');
  const harness = path.join(dir, 'SWE-bench_Pro-os');
  fs.mkdirSync(harness);
  // A stand-in for the official grader: records its argv.
  fs.writeFileSync(path.join(harness, 'swe_bench_pro_eval.py'), `import json, sys\nopen(${JSON.stringify(path.join(dir, 'grader-argv.json'))}, 'w').write(json.dumps(sys.argv))\n`);
  const outDir = path.join(dir, 'out');
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['swe-bench-pro', '--data', PRO, '--scripts-dir', PRO_SCRIPTS, '--pro-harness', harness, '--isolation', 'docker', '--out', outDir], { config: testConfig(mock.url), workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  const run = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 'tugline__textstats-1__default__r1.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 'scores.json'), 'utf8'))[0].outcome, 'pass', JSON.stringify(run.acceptance));
  const seen = String(run.events.find((e: any) => e.type === 'tool_end')?.output ?? '');
  assert.match(seen, /^0$/m, 'the hidden test was not in the workspace during the agent phase');
  assert.match(seen, /No such file or directory/);
  assert.match(seen, /^\/app$/m);
  assert.match(run.acceptance[0].output, /^PASSED tests\/test_core\.py::TestWordCount::test_multiple_spaces$/m);
  const preds = JSON.parse(fs.readFileSync(path.join(outDir, 'swe-bench-pro-predictions.json'), 'utf8'));
  assert.deepEqual(preds.map((p: any) => [p.instance_id, p.prefix]), [['tugline__textstats-1', 'default_r1']]);
  assert.match(preds[0].patch, /-    return len\(text\.split\(" "\)\)\n\+    return len\(text\.split\(\)\)/);
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, /python swe_bench_pro_eval\.py --raw_sample_path=.* --patch_path=.*swe-bench-pro-predictions\.json .*--dockerhub_username=jefzda/);
  const graderArgv = JSON.parse(fs.readFileSync(path.join(dir, 'grader-argv.json'), 'utf8'));
  assert.equal(graderArgv[0], 'swe_bench_pro_eval.py');
  assert.ok(graderArgv.includes(`--scripts_dir=${PRO_SCRIPTS}`));
  // A do-nothing model fails the local grading.
  const idle = await startMockServer(() => ({ content: 'nothing' }));
  servers.push(idle);
  const r2 = await runBench({ config: testConfig(idle.url), format: 'swe-bench-pro', data: PRO, scriptsDir: PRO_SCRIPTS, outDir: tmp('oh-pro-idle-'), isolation: 'docker' });
  assert.deepEqual(r2.map((r) => r.outcome), ['fail']);
});

// With a real Harbor install (TUG_TEST_HARBOR_BIN=<venv>/bin/harbor): the official harness runs the bundled
// Harbor-format samples (oracle agent = the reference solution), our reader parses its results, and our
// adapter class satisfies Harbor's installed-agent interface.
const HARBOR_BIN = process.env.TUG_TEST_HARBOR_BIN;
const NO_HARBOR = !HARBOR_BIN ? 'set TUG_TEST_HARBOR_BIN to a harbor executable (uv tool install harbor) to run the official harness' : !DOCKER ? 'no Docker daemon is reachable' : !imagePresent(TB_BASE) ? `${TB_BASE} is not available locally` : false;

test('N1 (official Harbor): `harbor run -a oracle` passes the bundled samples, readHarborResults parses the jobs dir, and the adapter loads in Harbor', { skip: NO_HARBOR }, async () => {
  const jobs = tmp('oh-harbor-real-');
  execFileSync(HARBOR_BIN!, ['run', '-p', TBH, '-a', 'oracle', '-o', jobs, '-n', '1', '-y', '-q'], { stdio: 'ignore', timeout: 900_000 });
  assert.deepEqual(readHarborResults(jobs).map((t) => [t.task, t.reward]), [['count-errors', 1], ['hello-file', 1]]);
  const adapter = tmp('oh-harbor-adapter-');
  (await import('../src/core/eval/harbor.js')).writeHarborAdapter(adapter);
  const py = path.join(path.dirname(HARBOR_BIN!), 'python');
  const out = execFileSync(py, ['-c', "import tugline_agent as m, tempfile, pathlib; a = m.TuglineAgent(logs_dir=pathlib.Path(tempfile.mkdtemp()), model_name='openai/x', version='tugline@1.1.0'); print(a.name(), a.import_path())"], { cwd: adapter, env: { ...process.env, PYTHONPATH: adapter } }).toString();
  assert.match(out, /^tugline tugline_agent:TuglineAgent/);
});

test('N1 AC4: every tug bench run records its exact command; scripts/bench-publish.sh publishes the row and --rerun replays it', async () => {
  const mock = await startMockServer(() => ({ content: 'I did nothing.' }));
  servers.push(mock);
  const outDir = path.join(tmp('oh-pub-'), 'bench-swe');
  const SWE = path.join(ROOT, 'evals', 'bench', 'swe-bench', 'instances.jsonl');
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['swe-bench', '--data', SWE, '--subset', '1', '--isolation', 'host', '--out', outDir], { config: testConfig(mock.url), workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  assert.equal(fs.readFileSync(path.join(outDir, 'command.txt'), 'utf8'), `tug bench swe-bench --data ${SWE} --subset 1 --isolation host --out ${outDir}\n`);
  const evidence = tmp('oh-evidence-');
  const env = { ...process.env, BENCH_EVIDENCE_DIR: evidence };
  execFileSync('bash', [path.join(ROOT, 'scripts', 'bench-publish.sh'), outDir], { env });
  const readme = fs.readFileSync(path.join(evidence, 'README.md'), 'utf8');
  assert.match(readme, /\| \d{4}-\d\d-\d\d \| \[bench-swe\]\(.*\/bench-swe\/\) \| swe-bench \| default \| 0\/1 \| mock-model \| `tug bench swe-bench --data .* --subset 1 --isolation host --out .*` \|/);
  const day = fs.readdirSync(evidence).find((d) => /^\d{4}-/.test(d))!;
  const pub = path.join(evidence, day, 'bench-swe');
  assert.ok(['report.md', 'compare.md', 'scores.json', 'command.txt', 'manifest-summary.json'].every((f) => fs.existsSync(path.join(pub, f))));
  const rerun = execFileSync('bash', [path.join(ROOT, 'scripts', 'bench-publish.sh'), '--rerun', pub], { env: { ...env, TUG_BIN: 'echo' } }).toString();
  assert.match(rerun, /^re-running: tug bench swe-bench[\s\S]*\nbench swe-bench --data .* --subset 1 --isolation host --out /);
});

test('live 31 Oct: an arm the suite does not define (`--arm default,cline` on evals/…) runs the external agent from the bench definitions, never Tugline under its name', async () => {
  const mock = await startMockServer((body) => {
    const p = JSON.stringify(body.messages);
    if (/FAKE_AGENT_CALL/.test(p)) return { content: 'ok' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'printf "ok\\n" > answer.txt' } }] } : { content: 'Done.' };
  });
  servers.push(mock);
  const dir = tmp('oh-ext-suite2-');
  const agentBin = fakeAgent(dir);
  suite(dir, { auto: {} }); // like evals/editing: its suite.json knows only its own arms
  const outDir = tmp('oh-ext-out2-');
  const armDefs = { default: {}, ext: { external: { command: `${agentBin} {{base_url}} {{model}} fix {{prompt}}`, version: 'echo fake-agent 9.9', env: { FAKE_KEY: '{{api_key}}' }, timeout_s: 60 } } };
  const rows = await runEval({ suiteDir: dir, outDir, baseConfig: testConfig(mock.url), arms: ['default', 'ext'], tasks: ['t1'], armDefs });
  assert.deepEqual(rows.map((r) => [r.arm, r.outcome]), [['default', 'pass'], ['ext', 'pass']]);
  const rec = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', 't1__ext__r1.json'), 'utf8'));
  assert.equal(rec.manifest.external?.version, 'fake-agent 9.9', 'the external CLI ran, not Tugline');
  assert.match(fs.readFileSync(path.join(outDir, 'runs', 't1__ext__r1.external.log'), 'utf8'), /All done, fixed\./);
  // An arm nobody defines is an error, not a silent Tugline run.
  await assert.rejects(runEval({ suiteDir: dir, outDir: tmp('oh-ext-out3-'), baseConfig: testConfig(mock.url), arms: ['clnie'], tasks: ['t1'], armDefs }), /unknown arm "clnie"/);
});
