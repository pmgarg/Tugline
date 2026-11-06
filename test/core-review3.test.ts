/** WS4 v1.1 review batch 3 (review 9681339): R2 neutered checks, R4 IDE autocomplete/NES admission, R6 dead lock owners. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { Journal } from '../src/core/agent/journal.js';
import { classifyCheck, definitionChanges, onlyNewTests, snapshotCheckDefinitions, zeroTestsReported } from '../src/core/context/verification.js';
import { rawAdmission } from '../src/core/llm/admission.js';
import { readLedger, localDate } from '../src/core/permissions/limits.js';
import { completeFim } from '../vscode/src/fim.js';
import { requestNextEdit, buildZetaPrompt } from '../vscode/src/nes.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const NO_MAP = { repoMapTokens: 0, backgroundCompaction: false };
const BASE = { 'src/calc.py': 'def add(a, b):\n    return a - b\n', 'tests/test_other.py': 'def test_other():\n    assert 1 == 2\n', 'tests/test_calc.py': 'from src.calc import add\n\ndef test_add():\n    assert add(2, 2) == 4\n', 'src/__init__.py': '' };
const hasPytest = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;

/** scripts/review/v1.1/r2-batch3-e2e.mts: fix add(), then neuter the check, then claim success */
async function stateAfter(calls: any[], files: Record<string, string> = BASE): Promise<{ state: string; why: string }> {
  const ws = tmpWorkspace(files);
  const steps = [{ name: 'read_file', arguments: { path: 'src/calc.py' } }, { name: 'edit_file', arguments: { path: 'src/calc.py', old_string: 'return a - b', new_string: 'return a + b' } }, ...calls];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'All tests pass. Fixed.' }));
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: true, ...NO_MAP } }), mcp: false, journal: false });
  const r = await a.run('fix add() and verify with the tests');
  await a.dispose();
  await srv.close();
  return { state: r.completion.state, why: r.completion.summary };
}

test('R2 batch 3: neutering the check never gives `verified` (the reviewer\'s e2e cases; batch 4: judged by the harness\'s own run)', { skip: !hasPytest && 'pytest is not installed' }, async () => {
  assert.equal((await stateAfter([{ name: 'bash', arguments: { command: 'python3 -m pytest -q' } }])).state, 'failed', 'baseline');
  // changes to what the check loads: the harness does not run it and names the files; changes to the agent's own
  // command only: the harness runs the real suite, which still fails (test_other)
  const cases: [string, any[], string, RegExp][] = [
    ['conftest skips every test', [{ name: 'write_file', arguments: { path: 'conftest.py', content: 'import pytest\ndef pytest_collection_modifyitems(items):\n    for i in items:\n        i.add_marker(pytest.mark.skip(reason="x"))\n' } }, { name: 'bash', arguments: { command: 'python3 -m pytest -q' } }], 'unverified', /not run: the run created or changed files the check would load: conftest\.py/],
    ['pytest.ini addopts -k', [{ name: 'write_file', arguments: { path: 'pytest.ini', content: '[pytest]\naddopts = -k "not add"\n' } }, { name: 'bash', arguments: { command: 'python3 -m pytest -q' } }], 'unverified', /pytest\.ini \(runner configuration or scripts changed\)/],
    ['one trivial new test file', [{ name: 'write_file', arguments: { path: 'tests/test_ok.py', content: 'def test_ok():\n    assert True\n' } }, { name: 'bash', arguments: { command: 'python3 -m pytest -q tests/test_ok.py' } }], 'failed', /`python3 -m pytest -q` exited 1 after the last edit \(run by the harness\)/],
    ['package.json test script made a no-op', [{ name: 'write_file', arguments: { path: 'package.json', content: '{"name":"x","scripts":{"test":"echo \\"Tests: 3 passed, 3 total\\""}}' } }, { name: 'bash', arguments: { command: 'npm test' } }], 'unverified', /package\.json \(runner configuration or scripts changed\)/],
    ['all-skipped output', [{ name: 'write_file', arguments: { path: 'package.json', content: '{"name":"x","scripts":{"test":"echo \\"Tests:       5 skipped, 5 total\\""}}' } }, { name: 'bash', arguments: { command: 'npm test' } }], 'unverified', /package\.json/],
    ['PYTEST_ADDOPTS=--co', [{ name: 'bash', arguments: { command: 'PYTEST_ADDOPTS=--co python3 -m pytest -q' } }], 'failed', /`python3 -m pytest -q` exited 1/],
  ];
  for (const [name, calls, state, why] of cases) {
    const r = await stateAfter(calls);
    assert.equal(r.state, state, `${name}: ${r.why}`);
    assert.match(r.why, why, name);
  }
});

test('R2 batch 3: legitimate work still verifies: a dependency added to package.json, a new test file run together with the suite', async () => {
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "console.log(\'# tests 2\\n# pass 2\')"' } });
  // (batch 4: the harness runs every detected check, so the base here has no failing python test)
  const { 'tests/test_other.py': _failing, ...passing } = BASE;
  const r = await stateAfter([{ name: 'read_file', arguments: { path: 'package.json' } }, { name: 'write_file', arguments: { path: 'package.json', content: JSON.stringify({ ...JSON.parse(pkg), dependencies: { leftpad: '1.0.0' } }) } }, { name: 'write_file', arguments: { path: 'test/new.test.js', content: 'x' } }, { name: 'bash', arguments: { command: 'npm test' } }], { ...passing, 'package.json': pkg });
  assert.equal(r.state, 'verified', r.why);
});

test('R2 batch 3: selecting filters and runner env vars are not trusted unless they are the configured verify command', () => {
  for (const c of ['pytest -k "not test_"', 'pytest --deselect tests', 'pytest -m nomarker', 'pytest tests/test_none.py::nothing', 'pytest --ignore=tests', 'go test -run "^$" ./...', 'cargo test nonexistent_filter', 'npx jest -t "no such test"', 'npx vitest run --testNamePattern zzz', 'npx mocha --grep zzz', 'npx jest --testPathPattern=nothing', 'CI=true SKIP_TESTS=1 npm test', 'PYTEST_ADDOPTS=--co pytest', 'PYTEST_ADDOPTS="--collect-only" pytest -q', 'export PYTEST_ADDOPTS=--co; pytest', 'JEST_SILENT=1 npm test', 'GOFLAGS=-run=X go test ./...', 'coproc npm test', 'if npm test; then :; fi'])
    assert.equal(classifyCheck(c).trusted, false, c);
  for (const c of ['python3 -m pytest -q', 'cargo test', 'cargo test --release -p core', 'go test -timeout 30s ./...', 'CI=true npm test', 'pytest tests/test_calc.py', 'make -k test'])
    assert.equal(classifyCheck(c).trusted, true, c);
  assert.equal(classifyCheck('pytest -m smoke', { verifyCommands: ['pytest -m smoke'] }).trusted, true, 'a configured filtered command is the project\'s own check');
  for (const out of ['Tests:       5 skipped, 5 total\n', '=== 4 skipped in 0.02s ===\n', '3 skipped in 0.01s\n', '# tests 3\n# pass 0\n# skip 3\n', 'test result: ok. 0 passed; 0 failed; 4 ignored\n', ' Tests  2 skipped (2)\n'])
    assert.ok(zeroTestsReported(out), out);
  for (const out of ['Tests:       1 skipped, 4 passed, 5 total\n', '=== 3 passed, 1 skipped in 0.1s ===\n', 'test result: ok. 3 passed; 0 failed\n']) assert.equal(zeroTestsReported(out), null, out);
});

test('R2 batch 3: definition snapshot: scripts/config changes and edits to existing tests count; new tests and unrelated package.json fields do not', () => {
  const ws = tmpWorkspace({ 'package.json': '{"name":"x","scripts":{"test":"jest"}}', 'pyproject.toml': '[project]\nname="x"\n[tool.pytest.ini_options]\naddopts="-q"\n', 'tests/test_a.py': 'def test_a(): pass\n', 'src/a.py': 'x' });
  const before = snapshotCheckDefinitions(ws);
  fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"x","version":"2","dependencies":{"a":"1"},"scripts":{"test":"jest"}}');
  fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[project]\nname="y"\n[tool.pytest.ini_options]\naddopts="-q"\n');
  fs.writeFileSync(path.join(ws, 'tests/test_new.py'), 'def test_n(): pass\n');
  fs.writeFileSync(path.join(ws, 'src/a.py'), 'y');
  assert.deepEqual(definitionChanges(before, ws), { changed: [], newTests: ['tests/test_new.py'] });
  fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[project]\nname="y"\n[tool.pytest.ini_options]\naddopts="-q -k nothing"\n');
  fs.writeFileSync(path.join(ws, 'tests/test_a.py'), 'import pytest\n@pytest.mark.skip\ndef test_a(): pass\n');
  fs.writeFileSync(path.join(ws, 'conftest.py'), '');
  assert.deepEqual(definitionChanges(before, ws).changed.sort(), ['conftest.py', 'pyproject.toml', 'tests/test_a.py']);
  assert.deepEqual(onlyNewTests('pytest -q tests/test_new.py', ['tests/test_new.py']), ['tests/test_new.py']);
  assert.equal(onlyNewTests('pytest -q tests/test_new.py tests/test_a.py', ['tests/test_new.py']), null);
  assert.equal(onlyNewTests('pytest -q', ['tests/test_new.py']), null);
});

// ------------------------------------------------------------------ R4 (IDE): autocomplete and NES

test('R4 batch 3: autocomplete (FIM) and next-edit requests are admitted: an exhausted budget stops them quietly, others leave one ledger line each', async () => {
  const srv = await startMockServer(() => ({ content: 'x' }));
  const hits: string[] = [];
  const fetchSpy: typeof fetch = (async (url: any, init: any) => {
    hits.push(String(url));
    return new Response(JSON.stringify({ choices: [{ text: 'return a + b' }], usage: { prompt_tokens: 50, completion_tokens: 5 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  const ac = { enabled: true, endpoint: 'completions' as const, template: 'qwen' as const, debounceMs: 0, maxTokens: 64, baseUrl: srv.url, model: 'm' };
  const token = { isCancellationRequested: false };
  // exhausted: nothing is sent, the completion is '' (quiet)
  const exhausted = testConfig(srv.url, { limits: { maxTokensPerDay: 0 } });
  const admitX = rawAdmission(exhausted, { kind: 'fim', role: 'autocomplete' });
  assert.equal(await completeFim({ config: () => ac, fetch: fetchSpy, admit: admitX }, { prefix: 'def add(a, b):\n    ', suffix: '\n', path: 'a.py' }, token), '');
  const zp = buildZetaPrompt({ path: 'a.py', text: 'x = 1\n', cursor: 0, events: [] } as any);
  const nesX = await requestNextEdit(fetchSpy, { baseUrl: srv.url, model: 'm', maxTokens: 64, latencyMs: 2000, admit: rawAdmission(exhausted, { kind: 'nes', role: 'next-edit' }) } as any, zp);
  assert.equal(nesX.reason, 'budget');
  assert.equal(hits.length, 0, 'no request sent');
  // allowed: one ledger line per request, with the reported usage
  const ok = testConfig(srv.url);
  assert.notEqual(await completeFim({ config: () => ac, fetch: fetchSpy, admit: rawAdmission(ok, { kind: 'fim', role: 'autocomplete' }) }, { prefix: 'def add(a, b):\n    ', suffix: '\n', path: 'a.py' }, token), undefined);
  await requestNextEdit(fetchSpy, { baseUrl: srv.url, model: 'm', maxTokens: 64, latencyMs: 2000, admit: rawAdmission(ok, { kind: 'nes', role: 'next-edit' }) } as any, zp);
  assert.equal(hits.length, 2);
  const lines = readLedger(ok.homeDir, localDate());
  assert.deepEqual(lines.map((l) => [l.kind, l.promptTokens, l.completionTokens]), [['fim', 50, 5], ['nes', 50, 5]]);
  await srv.close();
});

// ------------------------------------------------------------------ R6

test('R6 batch 3: a lock left by a dead process is taken at once (pid check), not after the stale timeout', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-j7-'));
  const ws = tmpWorkspace({});
  const j = new Journal(home, ws, 'crashy');
  j.write({ type: 'a' });
  // a crashed writer: the lock names a pid that no longer exists
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  fs.writeFileSync(`${j.file}.lock`, `${dead}\n`);
  const t0 = Date.now();
  j.write({ type: 'b' });
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
  assert.equal(fs.readFileSync(j.file, 'utf8').trim().split('\n').length, 2);
  assert.equal(Journal.verify(j.file), 0);
  // a live owner's lock is respected (bounded wait, then the write goes ahead unlocked rather than blocking forever)
  fs.writeFileSync(`${j.file}.lock`, `${process.pid}\n`);
  const t1 = Date.now();
  j.write({ type: 'c' });
  assert.ok(Date.now() - t1 >= 400, 'waited for the live owner');
  fs.rmSync(`${j.file}.lock`, { force: true });
});
