/**
 * SPEC I2: public benchmark subset runner (WS8), on the 2 bundled sample tasks per format.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, testConfig, lastToolResult, needsPytest, type MockServer } from './helpers.js';
import { fetchSweBench, loadSweBench, loadTerminalBench, runBench, sweTestCommand } from '../src/core/eval/bench.js';
import { getCliCommand } from '../src/core/commands.js';
import { dockerAvailable, dockerExecWrap, resolveIsolation } from '../src/core/eval/isolation.js';
import { commandWrapperFor } from '../src/core/tools/shell.js';
import '../src/core/eval/commands.js';

const ROOT = process.cwd();
const TB = path.join(ROOT, 'evals', 'bench', 'terminal-bench', 'tasks');
const SWE = path.join(ROOT, 'evals', 'bench', 'swe-bench', 'instances.jsonl');
const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const SOLUTIONS: [RegExp, string][] = [
  [/hello\.txt/, "printf 'Hello, world!\\n' > hello.txt"],
  [/error_count\.txt/, "awk '$3 == \"ERROR\"' app.log | wc -l | tr -d ' ' > error_count.txt"],
  [/divide\(\) silently returns 0/, "python3 - <<'EOF'\nimport re\np='calc/ops.py'\ns=open(p).read().replace('    if b == 0:\\n        return 0\\n','')\nopen(p,'w').write(s)\nEOF"],
  // python, not GNU `sed -i` (BSD sed on macOS reads the script as a backup suffix, R7)
  [/slugify leaves repeated dashes/, "python3 - <<'EOF'\np='slugkit/slug.py'\ns=open(p).read().replace('[^a-z0-9]\"', '[^a-z0-9]+\"')\nopen(p,'w').write(s)\nEOF"],
];

/** A scripted "model": look around (ls -a), apply the known fix with bash, then report. */
function solver(): Parameters<typeof startMockServer>[0] {
  return (body) => {
    const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
    const tools = body.messages.filter((m: any) => m.role === 'tool').length;
    if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'ls -a' } }] };
    if (tools === 1) {
      const fix = SOLUTIONS.find(([re]) => re.test(prompt))?.[1];
      return fix ? { toolCalls: [{ name: 'bash', arguments: { command: fix } }] } : { content: 'no idea' };
    }
    return { content: 'Done.' };
  };
}

test('I2 AC1: the 2 bundled terminal-bench sample tasks load (task.yaml, run-tests.sh, hidden tests)', async () => {
  const tasks = await loadTerminalBench(TB);
  assert.deepEqual(tasks.map((t) => t.id), ['count-errors', 'hello-file']);
  assert.match(tasks[1].prompt, /^Create a file named hello\.txt/);
  assert.equal(tasks[1].timeoutS, 300);
  assert.ok(tasks.every((t) => t.exclude?.includes('tests') && t.exclude.includes('solution.sh') && t.exclude.includes('run-tests.sh')));
});

test('I2 AC1: the 2 bundled swe-bench sample instances load (test_patch hidden, FAIL_TO_PASS + PASS_TO_PASS command)', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-cache-'));
  const tasks = await loadSweBench(SWE, cache);
  assert.deepEqual(tasks.map((t) => t.id), ['tugline__calc-1', 'tugline__slugkit-2']);
  assert.match(tasks[0].prompt, /Resolve this issue[\s\S]*ZeroDivisionError/);
  // v1.1 G5: the patch is applied by a host-side prepare step after the agent; acceptance is the test command alone (it may run in a container).
  assert.deepEqual(tasks[0].prepare, ['git apply --whitespace=nowarn "{{HIDDEN}}/test.patch"']);
  assert.match(tasks[0].acceptance[0], /^python3 -m pytest -q -p no:cacheprovider 'tests\/test_ops\.py::test_divide_by_zero_raises' 'tests\/test_ops\.py::test_add'/);
  assert.ok(fs.readFileSync(tasks[0].hidden['test.patch'], 'utf8').startsWith('diff --git a/tests/test_ops.py'));
  assert.equal(sweTestCommand({ instance_id: 'x', repo: 'r', base_commit: 'h', problem_statement: '', test_patch: '', FAIL_TO_PASS: ['a::b'], test_cmd: 'make test' }), 'make test');
});

// The bundled formats score with pytest, as terminal-bench and SWE-bench do: skip with the reason when it is missing (R7).
test('I2 AC1: tug bench runs both formats end to end through the eval harness (hidden tests score the work)', { skip: needsPytest() }, async () => {
  const mock = await startMockServer(solver());
  servers.push(mock);
  const config = testConfig(mock.url);
  for (const format of ['terminal-bench', 'swe-bench'] as const) {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `oh-bench-out-${format}-`));
    const rows = await runBench({ config, format, data: format === 'terminal-bench' ? TB : SWE, outDir, cacheDir: path.join(config.homeDir, 'bench'), isolation: 'host' });
    assert.equal(rows.length, 2, format);
    assert.deepEqual(rows.map((r) => r.outcome), ['pass', 'pass'], `${format}: ${JSON.stringify(rows)}`);
    const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
    assert.match(report, /\| default \| 2 \| 2 \|/);
    assert.match(report, /\$ \/ resolved/);
    assert.match(report, /## Isolation limitations \(results are indicative, not leaderboard-comparable\)[\s\S]*not in each task's Docker image[\s\S]*full shell can still find them/);
  }
  // The agent never saw the hidden tests, the solution or the test patch.
  const listings = mock.requests.filter((b) => b.messages.filter((m: any) => m.role === 'tool').length === 1).map((b) => lastToolResult(b));
  assert.equal(listings.length, 4);
  for (const l of listings) assert.ok(!/run-tests\.sh|solution\.sh|task\.yaml|Dockerfile|test\.patch/.test(l), l);
  const tbListings = listings.filter((l) => /app\.log/.test(l) || !/calc|slugkit/.test(l));
  assert.equal(tbListings.length, 2);
  for (const l of tbListings) assert.ok(!/^tests$/m.test(l), `terminal-bench tests are hidden:\n${l}`);
  // swe-bench: the repo's own tests are visible, but not the new test from test_patch
  const calcRun = mock.requests.find((b) => /ZeroDivisionError/.test(JSON.stringify(b.messages)) && b.messages.filter((m: any) => m.role === 'tool').length === 2);
  assert.ok(calcRun && !/test_divide_by_zero_raises/.test(JSON.stringify(calcRun.messages)));
  // A model that does nothing fails the hidden tests.
  const idle = await startMockServer(() => ({ content: 'I did nothing.' }));
  servers.push(idle);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-out-idle-'));
  const rows = await runBench({ config: testConfig(idle.url), format: 'swe-bench', data: SWE, subset: 1, outDir, isolation: 'host' });
  assert.deepEqual(rows.map((r) => [r.task, r.outcome]), [['tugline__calc-1', 'fail']]);
});

test('I2 AC2: --arm bash-only restricts the agent to the bash tool (and records it in the manifest)', { skip: needsPytest() }, async () => {
  const mock = await startMockServer(solver());
  servers.push(mock);
  const config = testConfig(mock.url);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-arms-'));
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['terminal-bench', '--data', TB, '--subset', '1', '--arm', 'all', '--isolation', 'host', '--out', outDir], { config, workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  const toolSets = mock.requests.map((b) => (b.tools ?? []).map((t: any) => t.function.name).sort().join(','));
  const bashOnly = toolSets.filter((s) => s === 'bash');
  const full = toolSets.filter((s) => s !== 'bash');
  assert.equal(bashOnly.length, 3, 'every request of the bash-only arm offers exactly one tool: bash');
  assert.ok(full.length === 3 && full.every((s) => s.includes('read_file') && s.includes('bash')), 'the default arm keeps the full tool set');
  const runs = fs.readdirSync(path.join(outDir, 'runs')).map((f) => JSON.parse(fs.readFileSync(path.join(outDir, 'runs', f), 'utf8')));
  assert.deepEqual(runs.map((r) => [r.manifest.arm, r.manifest.tools ?? null]).sort(), [['bash-only', ['bash']], ['default', null]]);
  assert.match(out.join('\n'), /\| default \| 1 \| 1 \|[\s\S]*\| bash-only \| 1 \| 1 \|/);
});

test('I2: --fetch reads SWE-bench rows from the datasets server (mocked) into JSONL; the help documents manual fetching', async () => {
  const urls: string[] = [];
  const fake = (async (u: string) => {
    urls.push(String(u));
    const offset = Number(new URL(String(u)).searchParams.get('offset'));
    const rows = offset === 0 ? [{ row: { instance_id: 'a__b-1', repo: 'a/b' } }, { row: { instance_id: 'a__b-2', repo: 'a/b' } }] : [];
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }) as typeof fetch;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fetch-')), 'lite.jsonl');
  assert.equal(await fetchSweBench(2, file, 'princeton-nlp/SWE-bench_Lite', fake), 2);
  assert.match(urls[0], /^https:\/\/datasets-server\.huggingface\.co\/rows\?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test&offset=0&length=2$/);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
  const out: string[] = [];
  await getCliCommand('bench')!.run([], { config: testConfig('http://x/v1'), workspace: ROOT, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /git clone --depth 1 https:\/\/github\.com\/laude-institute\/terminal-bench/);
});

test('I2: task.yaml is read without the optional yaml package too (block scalars, plain values)', async () => {
  const { miniYaml } = await import('../src/core/eval/bench.js');
  const y = miniYaml(fs.readFileSync(path.join(TB, 'count-errors', 'task.yaml'), 'utf8'));
  assert.match(String(y.instruction), /^The file app\.log in the current directory[\s\S]*do not count\.$/);
  assert.equal(y.max_agent_timeout_sec, '300');
  assert.equal(y.difficulty, 'easy');
  assert.deepEqual(miniYaml('instruction: >-\n  one\n  two\nx: 1\n'), { instruction: 'one two', x: '1' });
});

// ------------------------------------------------------------ v1.1 G5: docker isolation

const imagePresent = (name: string) => {
  try {
    execFileSync('docker', ['image', 'inspect', name], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
};
const DOCKER = await dockerAvailable();
const NO_DOCKER = DOCKER ? false : 'no Docker daemon is reachable (start dockerd); the docker-isolation tests need one';
/** Base of the probe task image: python3 + bash, no network needed in the build. */
const PROBE_BASE = process.env.TUG_TEST_BENCH_BASE || 'python:3.12-slim';
/** SWE-bench image with pytest (scripts/bench-python-image.sh builds it without network in the build). */
const PY_IMAGE = process.env.TUG_TEST_BENCH_PYTHON_IMAGE || 'tugline/bench-python:3.12';
const TB_BASE = 'ghcr.io/laude-institute/t-bench/ubuntu-24-04:20250624';
const skipUnless = (image: string, why: string) => NO_DOCKER || (imagePresent(image) ? false : `${image} is not available locally (${why})`);

test('G5: tug bench isolation defaults to docker when a daemon is reachable, else host; --isolation docker without one fails clearly', async () => {
  const pathBefore = process.env.PATH;
  const real = await dockerAvailable(true);
  assert.equal(await resolveIsolation('auto'), real ? 'docker' : 'host');
  assert.equal(await resolveIsolation('host'), 'host');
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-nodocker-')); // no docker binary at all
  try {
    assert.equal(await dockerAvailable(true), false);
    assert.equal(await resolveIsolation('auto'), 'host');
    await assert.rejects(resolveIsolation('docker'), /--isolation docker: no Docker daemon is reachable/);
    // Through the CLI: a bad value is a usage error; docker without a daemon is a clear failure, not a silent host run.
    const out: string[] = [];
    const cfg = testConfig('http://127.0.0.1:9/v1');
    assert.equal(await getCliCommand('bench')!.run(['terminal-bench', '--data', TB, '--isolation', 'vm'], { config: cfg, workspace: ROOT, write: (t) => out.push(t) }), 2);
    assert.equal(await getCliCommand('bench')!.run(['terminal-bench', '--data', TB, '--isolation', 'docker', '--out', fs.mkdtempSync(path.join(os.tmpdir(), 'oh-b-'))], { config: cfg, workspace: ROOT, write: (t) => out.push(t) }), 1);
    assert.match(out.join('\n'), /--isolation must be docker or host[\s\S]*bench failed: --isolation docker: no Docker daemon is reachable/);
  } finally {
    process.env.PATH = pathBefore;
    await dockerAvailable(true);
  }
});

test('G5: the docker-exec command wrapper is scoped to the eval run (other agents are untouched) and passes no host env', () => {
  const c = { name: 'oh-eval-x', workdir: '/app', hostWork: '/tmp/w', shell: '/bin/bash' };
  // processLifetime off: this test is about the eval docker wrapper alone (WS3's lifetime wrapper is skipped inside an eval container anyway)
  const plain = testConfig('http://x/v1', { shell: { processLifetime: 'off' } });
  const spec = { file: '/bin/bash', args: ['-c', 'ls /'], cwd: '/tmp/w/sub', env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-secret' } };
  const w = commandWrapperFor(plain);
  assert.deepEqual(w ? w(spec) : spec, spec, 'no evalContainer in the config: commands are not rewritten');
  const scoped = commandWrapperFor({ ...plain, evalContainer: c } as any)!(spec);
  const scopedDefault = commandWrapperFor({ ...testConfig('http://x/v1'), evalContainer: c } as any)!(spec);
  assert.deepEqual(scopedDefault.args.slice(-3), ['/bin/bash', '-c', 'ls /'], 'no lifetime wrapper inside the eval container (default processLifetime)');
  assert.equal(scoped.file, 'docker');
  assert.deepEqual(scoped.args.slice(0, 2), ['exec', '-i']);
  assert.deepEqual(scoped.args.slice(-6), ['-w', '/app/sub', 'oh-eval-x', '/bin/bash', '-c', 'ls /']);
  assert.ok(scoped.args.includes('/app/sub') && !scoped.args.join(' ').includes('sk-secret'), 'cwd mapped into the container; host env values never become -e flags');
  assert.equal(dockerExecWrap(c)({ ...spec, cwd: '/etc' }).args.includes('/app'), true, 'a cwd outside the workspace maps to the workdir');
});

/** A terminal-bench-format task whose Dockerfile copies its whole context: tests/ and the solution must still not reach the image. */
function probeTasks(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-tb-probe-'));
  const t = path.join(root, 'probe');
  fs.mkdirSync(path.join(t, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(t, 'task.yaml'), 'instruction: |-\n  Copy data.txt to out.txt.\nmax_agent_timeout_sec: 120\n');
  fs.writeFileSync(path.join(t, 'Dockerfile'), `FROM ${PROBE_BASE}\nRUN echo task-image > /oh-task-image-marker\nWORKDIR /app\nCOPY . /app\n`);
  fs.writeFileSync(path.join(t, 'data.txt'), 'hello from data\n');
  fs.writeFileSync(path.join(t, 'solution.sh'), 'cp data.txt out.txt\n');
  fs.writeFileSync(path.join(t, 'tests', 'expected.txt'), 'hello from data\n');
  // Acceptance must run inside the task container, after the agent, with the hidden tests present.
  fs.writeFileSync(path.join(t, 'run-tests.sh'), '#!/bin/bash\nset -e\ntest -f /oh-task-image-marker\ntest -f "$TEST_DIR/expected.txt"\ndiff "$TEST_DIR/expected.txt" /app/out.txt\necho ACCEPTANCE_IN_CONTAINER_OK\n');
  return root;
}

const PROBE_CMD = 'ls -a /; echo "PWD=$(pwd)"; ls -a /app; if [ -e /oh-hidden ]; then echo HIDDEN=present; else echo HIDDEN=absent; fi';

test('G5: terminal-bench in the task\'s own image — `ls /` sees the container root, hidden tests are absent while the agent runs, acceptance runs after inside the container', { skip: skipUnless(PROBE_BASE, 'docker pull python:3.12-slim, or set TUG_TEST_BENCH_BASE to a local image with bash') }, async () => {
  const data = probeTasks();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-cache-'));
  const hiddenRuns = path.join(cacheDir, 'hidden-runs');
  const mock = await startMockServer((body) => {
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n === 0) return { toolCalls: [{ name: 'bash', arguments: { command: PROBE_CMD } }] };
    // The file tools run on the host side of the bind mount; they may not read the host copy of the hidden tests.
    // (Here the cache is under the OS temp dir, which file tools may read, so the run directory can be listed.)
    if (n === 1) return { toolCalls: [{ name: 'list_dir', arguments: { path: hiddenRuns } }] };
    if (n === 2) {
      const run = String(body.messages.at(-1).content).match(/run-\w+/)?.[0] ?? 'run-missing';
      return { toolCalls: [{ name: 'read_file', arguments: { path: path.join(hiddenRuns, run, 'probe', 'tests', 'expected.txt') } }] };
    }
    if (n === 3) return { toolCalls: [{ name: 'bash', arguments: { command: 'cat /oh-task-image-marker && cp data.txt out.txt' } }] };
    return { content: 'Done.' };
  });
  servers.push(mock);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-docker-tb-'));
  const rows = await runBench({ config: testConfig(mock.url), format: 'terminal-bench', data, outDir, cacheDir, isolation: 'docker' });
  assert.deepEqual(rows.map((r) => r.outcome), ['pass'], JSON.stringify(rows));
  const results = mock.requests.map((b) => b.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))).sort((a, b) => b.length - a.length)[0];
  const [listing, listDir, peek, solve] = results;
  // The container root: the marker the task's Dockerfile created, Docker's own /.dockerenv, the workspace at /app.
  assert.match(listing, /^oh-task-image-marker$/m, listing);
  assert.match(listing, /^\.dockerenv$/m);
  assert.match(listing, /PWD=\/app$/m);
  assert.match(listing, /^data\.txt$/m);
  assert.match(listing, /HIDDEN=absent/, 'no hidden tests in the container during the agent phase');
  assert.ok(!/^(tests|run-tests\.sh|solution\.sh)$/m.test(listing), `tests and solution are not in the image or the workspace:\n${listing}`);
  assert.match(listDir, /run-\w+/);
  assert.match(peek, /^(Error: )?Refused: denied by rule 'read\(.*hidden-runs\/run-\w+\/probe\/\*\*\)'/, `file tools cannot read the host copy of the hidden tests: ${peek}`);
  assert.ok(!peek.includes('hello from data'));
  assert.match(solve, /task-image/);
  const run = JSON.parse(fs.readFileSync(path.join(outDir, 'runs', fs.readdirSync(path.join(outDir, 'runs'))[0]), 'utf8'));
  assert.equal(run.manifest.isolation, 'docker');
  assert.match(run.manifest.image, /^oh-bench\/probe:[0-9a-f]{12}$/);
  assert.match(run.acceptance[0].output, /ACCEPTANCE_IN_CONTAINER_OK/);
  assert.ok(Date.parse(run.manifest.agentEndedAt) >= Date.parse(run.manifest.agentStartedAt));
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, /## Isolation\n\nisolated: docker\n/);
  assert.ok(!/Isolation limitations/.test(report), 'the host-mode warning is not printed for a docker run');
  // No task container is left behind.
  assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', 'label=tugline.eval=1']).toString().trim(), '');
  // A model that does nothing fails the same in-container acceptance.
  const idle = await startMockServer(() => ({ content: 'I did nothing.' }));
  servers.push(idle);
  const idleRows = await runBench({ config: testConfig(idle.url), format: 'terminal-bench', data, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-docker-idle-')), cacheDir, isolation: 'docker' });
  assert.deepEqual(idleRows.map((r) => r.outcome), ['fail']);
});

test('G5: the bundled terminal-bench samples pass in their own images (t-bench base, no pytest: the offline runner)', { skip: skipUnless(TB_BASE, `docker pull ${TB_BASE}`) }, async () => {
  const mock = await startMockServer(solver());
  servers.push(mock);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-docker-tbs-'));
  const rows = await runBench({ config: testConfig(mock.url), format: 'terminal-bench', data: TB, outDir, isolation: 'docker' });
  assert.deepEqual(rows.map((r) => [r.task, r.outcome]), [['count-errors', 'pass'], ['hello-file', 'pass']], JSON.stringify(rows));
  const runs = fs.readdirSync(path.join(outDir, 'runs')).map((f) => JSON.parse(fs.readFileSync(path.join(outDir, 'runs', f), 'utf8')));
  assert.ok(runs.every((r) => r.manifest.isolation === 'docker' && /^oh-bench\//.test(r.manifest.image)));
});

test('G5: swe-bench in a python base image — the repo is at /testbed, the test patch arrives only after the agent, acceptance runs in the container', { skip: skipUnless(PY_IMAGE, 'run scripts/bench-python-image.sh, or set TUG_TEST_BENCH_PYTHON_IMAGE to an image with python3 and pytest') }, async () => {
  const mock = await startMockServer((body) => {
    const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'ls -a /; echo "PWD=$(pwd)"; cat tests/*.py; [ -e /oh-hidden ] && echo HIDDEN=present || echo HIDDEN=absent' } }] };
    if (n === 1) return { toolCalls: [{ name: 'bash', arguments: { command: SOLUTIONS.find(([re]) => re.test(prompt))![1] } }] };
    return { content: 'Done.' };
  });
  servers.push(mock);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-bench-docker-swe-'));
  const out: string[] = [];
  const code = await getCliCommand('bench')!.run(['swe-bench', '--data', SWE, '--isolation', 'docker', '--image', PY_IMAGE, '--out', outDir], { config: testConfig(mock.url), workspace: ROOT, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  const runs = fs.readdirSync(path.join(outDir, 'runs')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(outDir, 'runs', f), 'utf8')));
  assert.deepEqual(runs.map((r) => [r.manifest.task, r.manifest.isolation, r.manifest.image]), [
    ['tugline__calc-1', 'docker', PY_IMAGE],
    ['tugline__slugkit-2', 'docker', PY_IMAGE],
  ]);
  const scored = JSON.parse(fs.readFileSync(path.join(outDir, 'scores.json'), 'utf8'));
  assert.deepEqual(scored.map((r: any) => r.outcome), ['pass', 'pass'], JSON.stringify(runs.map((r) => r.acceptance)));
  for (const r of runs) {
    const seen = JSON.stringify(r.events);
    assert.match(seen, /\.dockerenv/, 'the agent saw the container root');
    assert.match(seen, /PWD=\/testbed/);
    assert.match(seen, /HIDDEN=absent/);
    assert.ok(!/test_divide_by_zero_raises|test_collapses_repeated_separators/.test(seen), `the new tests were not in the workspace during the agent phase`);
    // Acceptance ran in the container (pytest from the image; the host has a different python).
    assert.match(r.acceptance[0].output, /passed/);
  }
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, new RegExp(`isolated: docker[\\s\\S]*from \`${PY_IMAGE.replace(/[./]/g, '\\$&')}\`[\\s\\S]*bind-mounted at /testbed`));
  assert.match(out.join('\n'), /isolation: docker/);
});
