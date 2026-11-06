/**
 * WS4 v1.1 review batch 4 (re-check 3c51a9d): R2 — `verified` comes only from a check the harness runs
 * itself (fixed at run start, clean environment, nothing it loads changed in the run); R4 lows — autocomplete
 * pricing, cancelled FIM/NES requests counted, repo-context blocks counted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import type { AgentEvent, PermissionRequest } from '../src/core/types.js';
import { cleanCheckEnv, cleanPath, planChecks, prepareCheckPlan, untrustedChanges } from '../src/core/context/harnessCheck.js';
import { rawAdmission } from '../src/core/llm/admission.js';
import { readLedger, localDate } from '../src/core/permissions/limits.js';
import { completeFim, requestPromptText, buildCompletionsBody } from '../vscode/src/fim.js';
import { requestNextEdit, buildZetaPrompt } from '../vscode/src/nes.js';
import { autocompleteAdmission } from '../vscode/src/settingsConfig.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const NO_MAP = { repoMapTokens: 0, backgroundCompaction: false };
const hasPytest = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;
const PY = { 'src/__init__.py': '', 'src/calc.py': 'def add(a, b):\n    return a - b\n', 'tests/test_calc.py': 'from src.calc import add\n\ndef test_add():\n    assert add(2, 2) == 4\n' };
/** the reviewer's base: the suite still fails after the fix (test_other), and package.json says `jest` */
const REVIEW_BASE = { ...PY, 'tests/test_other.py': 'def test_other():\n    assert 1 == 2\n', 'package.json': '{"name":"x","scripts":{"test":"jest"}}' };
const FIX = [{ name: 'read_file', arguments: { path: 'src/calc.py' } }, { name: 'edit_file', arguments: { path: 'src/calc.py', old_string: 'return a - b', new_string: 'return a + b' } }];
const W = (p: string, content: string) => ({ name: 'write_file', arguments: { path: p, content } });
const B = (command: string) => ({ name: 'bash', arguments: { command } });
const PASSALL = 'import pytest\n@pytest.hookimpl(hookwrapper=True)\ndef pytest_runtest_makereport(item, call):\n    o = yield\n    r = o.get_result()\n    r.outcome = "passed"\n';

async function run(files: Record<string, string>, calls: any[], over: any = {}, ui: any = {}) {
  const ws = tmpWorkspace(files);
  const steps = [...FIX, ...calls];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'All tests pass. Fixed.' }));
  const events: AgentEvent[] = [];
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: true, ...NO_MAP }, ...over }), mcp: false, journal: false, ui: { onEvent: (e: AgentEvent) => events.push(e), ...ui } });
  const r = await a.run('fix add() and verify with the tests');
  await a.dispose();
  await srv.close();
  return { r, ws, srv, events, harness: (r.stats.evidence ?? []).filter((e) => e.byHarness) };
}

// ------------------------------------------------------------------ R2: the six re-check cases

test('R2 batch 4: swapping the program a check runs never gives `verified` (scripts/review/v1.1/r2-batch4-e2e.mts, all cases)', { skip: !hasPytest && 'pytest is not installed' }, async () => {
  const cases: [string, any[], 'unverified' | 'failed', RegExp][] = [
    ['baseline', [B('python3 -m pytest -q')], 'failed', /`python3 -m pytest -q` exited 1 after the last edit \(run by the harness\)/],
    ['A root pytest.py', [W('pytest.py', 'print("2 passed in 0.01s")\n'), B('python3 -m pytest -q')], 'unverified', /pytest\.py \(it shadows the Python module `pytest`/],
    ['B .pytest.ini + plugin', [W('passall.py', PASSALL), W('.pytest.ini', '[pytest]\naddopts = -p passall\n'), B('python3 -m pytest -q')], 'unverified', /\.pytest\.ini, passall\.py/],
    // C, E, F change only the model's own command: the harness runs the real suite, which fails
    ['C -p on the command line', [W('passall.py', PASSALL), B('python3 -m pytest -q -p passall')], 'failed', /`python3 -m pytest -q` exited 1/],
    ['D node_modules/.bin/jest shim', [W('node_modules/.bin/jest', '#!/bin/sh\necho "Tests:       4 passed, 4 total"\n'), B('chmod +x node_modules/.bin/jest && npm test')], 'unverified', /node_modules\/\.bin\/jest \(a node_modules\/\.bin entry the check resolves changed\)/],
    ['E PATH shim', [W('bin/pytest', '#!/bin/sh\necho "4 passed in 0.02s"\n'), B('chmod +x bin/pytest && PATH=$PWD/bin:$PATH pytest -q')], 'failed', /`python3 -m pytest -q` exited 1/],
    ['F npm_config_script_shell', [B('npm_config_script_shell=/bin/true npm test')], 'failed', /`python3 -m pytest -q` exited 1/],
    ['G sitecustomize + PYTHONPATH', [W('sitecustomize.py', 'import os\nprint("2 passed in 0.01s"); os._exit(0)\n'), B('PYTHONPATH=. python3 -m pytest -q')], 'unverified', /sitecustomize\.py/],
  ];
  for (const [name, calls, state, why] of cases) {
    const { r, harness } = await run(REVIEW_BASE, calls);
    assert.equal(r.completion.state, state, `${name}: ${r.completion.summary}`);
    assert.match(r.completion.summary, why, name);
    assert.ok(harness.length, `${name}: the harness recorded its own check`);
    // the model's own command is recorded as evidence, never as the verdict
    assert.ok(r.stats.evidence!.some((e) => !e.byHarness), name);
  }
});

test('R2 batch 4: the harness runs the check itself: the honest path verifies (a real fix and the real suite), with no command from the model', { skip: !hasPytest && 'pytest is not installed' }, async () => {
  const { r, harness, events } = await run(PY, []);
  assert.equal(r.completion.state, 'verified', r.completion.summary);
  assert.match(r.completion.summary, /`python3 -m pytest -q` passed after the last edit \(run by the harness in a clean environment\)/);
  assert.deepEqual(harness.map((e) => [e.command, e.source, e.exitCode, e.trusted]), [['python3 -m pytest -q', 'detected', 0, true]]);
  assert.match(harness[0].outputTail ?? '', /1 passed/);
  assert.ok(events.some((e) => e.type === 'notice' && /verification: running `python3 -m pytest -q`/.test((e as any).message)));
  // the unfixed code fails the same check, and the model is told with the output
  const ws = tmpWorkspace(PY);
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [W('src/notes.txt', 'x')] } : { content: 'All tests pass. Fixed.' }));
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: true, ...NO_MAP } }), mcp: false, journal: false });
  const bad = await a.run('fix add()');
  await a.dispose();
  await srv.close();
  assert.equal(bad.completion.state, 'failed');
  assert.match(String(srv.requests[2].messages.at(-1).content), /the last check after your last edit failed[\s\S]*Output \(tail\):[\s\S]*assert -2 == 4|assert 0 == 4/);
});

test('R2 batch 4: an honest Node fix verifies; adding a dependency and a new test is fine; a configured verify command is the documented way', async () => {
  const files = { 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node --test' } }), 'src/calc.js': 'exports.add = (a, b) => a - b;\n', 'test/calc.test.js': "const t = require('node:test'); const a = require('node:assert'); const { add } = require('../src/calc.js');\nt.test('add', () => a.equal(add(2, 2), 4));\n" };
  const ws = tmpWorkspace(files);
  const steps = [{ name: 'read_file', arguments: { path: 'src/calc.js' } }, { name: 'read_file', arguments: { path: 'package.json' } }, { name: 'edit_file', arguments: { path: 'src/calc.js', old_string: 'a - b', new_string: 'a + b' } }, W('package.json', JSON.stringify({ ...JSON.parse(files['package.json']), dependencies: { leftpad: '1.0.0' } })), W('test/more.test.js', "require('node:test').test('more', () => {});\n")];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'Fixed; the tests pass.' }));
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: NO_MAP }), mcp: false, journal: false });
  const r = await a.run('fix add');
  await a.dispose();
  await srv.close();
  assert.equal(r.completion.state, 'verified', r.completion.summary);
  // verifyCommands wins over detection, and a project script named by path is fingerprinted like the rest
  const ws2 = tmpWorkspace({ 'check.sh': '#!/bin/sh\nexit 0\n', 'a.txt': '1' });
  fs.chmodSync(path.join(ws2, 'check.sh'), 0o755);
  assert.deepEqual(planChecks(ws2, { verifyCommands: ['./check.sh'] }), [{ command: './check.sh', source: 'verifyCommands' }]);
  const plan = prepareCheckPlan(ws2, planChecks(ws2, { verifyCommands: ['./check.sh'] }));
  assert.deepEqual(plan.entries, ['check.sh']);
  fs.writeFileSync(path.join(ws2, 'check.sh'), '#!/bin/sh\nexit 0 # changed\n');
  assert.deepEqual(untrustedChanges(ws2, plan).files, ['check.sh']);
});

test('R2 batch 4: the model\'s own passing command never verifies on its own (no detectable check, or the harness check off)', async () => {
  const ws = tmpWorkspace({ 'calc.js': 'exports.add = (a, b) => a - b;\n', 'calc.test.js': "require('node:test').test('x', () => {});\n" });
  const steps = [{ name: 'read_file', arguments: { path: 'calc.js' } }, { name: 'edit_file', arguments: { path: 'calc.js', old_string: 'a - b', new_string: 'a + b' } }, B('node --test')];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'I ran node --test; it could not be verified by a project check.' }));
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: NO_MAP }), mcp: false, journal: false });
  const r = await a.run('fix add');
  await a.dispose();
  await srv.close();
  assert.equal(r.stats.evidence![0].exitCode, 0);
  assert.equal(r.completion.state, 'unverified');
  assert.match(r.completion.summary, /no check is configured or detectable for this project \(set agent\.verifyCommands[\s\S]*the agent's own commands are evidence only: `node --test` → exit 0/);
  const off = await run(PY, [B('python3 -m pytest -q')], { agent: { requireVerification: false, harnessCheck: 'off', ...NO_MAP } });
  assert.equal(off.r.completion.state, 'unverified');
  assert.match(off.r.completion.summary, /the harness check is off/);
  assert.equal(off.harness.length, 0);
});

// ------------------------------------------------------------------ R2: what the harness trusts

test('R2 batch 4: a node_modules runner must be lockfile-pinned and unchanged in the run', async () => {
  const jest = { 'node_modules/jest/package.json': '{"name":"jest","version":"1.0.0","bin":{"jest":"bin/jest.js"}}', 'node_modules/jest/bin/jest.js': '#!/usr/bin/env node\nconsole.log("Tests:       1 passed, 1 total");\n', 'package.json': '{"name":"x","version":"1.0.0","scripts":{"test":"jest"}}', 'src/a.js': 'x\n' };
  const make = (extra: Record<string, string> = {}) => {
    const ws = tmpWorkspace({ ...jest, ...extra });
    fs.mkdirSync(path.join(ws, 'node_modules/.bin'), { recursive: true });
    fs.chmodSync(path.join(ws, 'node_modules/jest/bin/jest.js'), 0o755);
    fs.symlinkSync('../jest/bin/jest.js', path.join(ws, 'node_modules/.bin/jest'));
    return ws;
  };
  /** `calls` after a change to src/a.js; `later` is a second run of the same session (one more change to src/a.js) */
  const runIn = async (ws: string, calls: any[], later = false) => {
    const steps: any[] = [{ name: 'read_file', arguments: { path: 'src/a.js' } }, W('src/a.js', 'y\n'), ...calls, null, W('src/a.js', 'z\n'), null];
    const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'Done.' }));
    const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: NO_MAP }), mcp: false, journal: false });
    const r = await a.run('change a');
    const r2 = later ? await a.run('change a again') : undefined;
    await a.dispose();
    await srv.close();
    return { r, r2 };
  };
  // no lockfile: the runner in node_modules is not pinned
  const unpinned = await runIn(make(), []);
  assert.equal(unpinned.r.completion.state, 'unverified');
  assert.match(unpinned.r.completion.summary, /`jest` resolves to node_modules\/\.bin\/jest, and no lockfile pins it/);
  // pinned and unchanged: it runs
  const lock = { 'package-lock.json': JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { 'node_modules/jest': { version: '1.0.0' } } }) };
  const pinned = await runIn(make(lock), []);
  assert.equal(pinned.r.completion.state, 'verified', pinned.r.completion.summary);
  // the runner package changed in the run: not run
  const swapped = await runIn(make(lock), [{ name: 'read_file', arguments: { path: 'node_modules/jest/bin/jest.js' } }, W('node_modules/jest/bin/jest.js', '#!/usr/bin/env node\nconsole.log("Tests:       9 passed, 9 total");\n')], true);
  assert.equal(swapped.r.completion.state, 'unverified');
  assert.match(swapped.r.completion.summary, /node_modules\/jest[ ,(][\s\S]*the runner package in node_modules changed/);
  // ...and the next run of the session still does not trust it: the earlier run left it so
  assert.equal(swapped.r2!.completion.state, 'unverified', swapped.r2!.completion.summary);
  assert.match(swapped.r2!.completion.summary, /node_modules\/jest[\s\S]*an earlier run in this session changed it/);
});

test('R2 batch 4: shadow modules: a new root module named like an installed one is flagged, an ordinary module is not', { skip: spawnSync('python3', ['-c', '0']).status !== 0 && 'no python3' }, () => {
  const ws = tmpWorkspace({ ...PY, 'calc.py': 'x = 1\n' });
  const plan = prepareCheckPlan(ws, planChecks(ws));
  assert.deepEqual(plan.checks, [{ command: 'python3 -m pytest -q', source: 'detected' }]);
  fs.writeFileSync(path.join(ws, 'calc.py'), 'x = 2\n'); // the project's own root module, edited
  fs.writeFileSync(path.join(ws, 'helper.py'), 'y = 1\n'); // a new module that shadows nothing
  fs.writeFileSync(path.join(ws, 'tests/test_new.py'), 'def test_n(): pass\n'); // a new test
  assert.deepEqual(untrustedChanges(ws, plan).files, []);
  fs.writeFileSync(path.join(ws, 'json.py'), 'raise SystemExit(0)\n'); // shadows the stdlib json
  fs.writeFileSync(path.join(ws, 'pytest.pyc'), 'x'); // sourceless bytecode shadows pytest
  fs.mkdirSync(path.join(ws, 'pluggy'));
  fs.writeFileSync(path.join(ws, 'pluggy/__init__.py'), '');
  assert.deepEqual(untrustedChanges(ws, plan).files.sort(), ['json.py', 'pluggy/__init__.py', 'pytest.pyc']);
});

test('R2 batch 4: the clean environment: no workspace or relative PATH entries, runner variables removed, a private bytecode cache', () => {
  const ws = tmpWorkspace({});
  fs.mkdirSync(path.join(ws, 'bin'));
  const base = { PATH: [path.join(ws, 'bin'), '.', '', 'bin', '/usr/bin', '/bin'].join(path.delimiter), NODE_OPTIONS: '--require ./x.js', npm_config_script_shell: '/bin/true', PYTEST_ADDOPTS: '-p passall', PYTHONPATH: '.', JEST_X: '1', LD_PRELOAD: 'x.so', BASH_ENV: './x', HOME: '/home/u', CI: '1' };
  const env = cleanCheckEnv(base, ws, '/tmp/pyc');
  assert.equal(env.PATH, ['/usr/bin', '/bin'].join(path.delimiter));
  for (const k of ['NODE_OPTIONS', 'npm_config_script_shell', 'PYTEST_ADDOPTS', 'PYTHONPATH', 'JEST_X', 'LD_PRELOAD', 'BASH_ENV']) assert.equal(env[k], undefined, k);
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.CI, '1');
  assert.equal(env.PYTHONPYCACHEPREFIX, '/tmp/pyc');
  assert.equal(cleanPath(`${ws}${path.delimiter}/usr/bin`, ws), '/usr/bin');
  // the plan is fixed before the first edit: AGENTS.md beats detection, acceptance beats both
  const w2 = tmpWorkspace({ 'AGENTS.md': '- Tests: `npm test`\n- Build: `npm run build`\n- Typecheck: `npx tsc --noEmit`\n', 'package.json': '{"scripts":{"test":"x"}}' });
  assert.deepEqual(planChecks(w2).map((c) => [c.command, c.source]), [['npm test', 'AGENTS.md'], ['npx tsc --noEmit', 'AGENTS.md']]);
  assert.deepEqual(planChecks(w2, { acceptance: ['bash judge.sh'], verifyCommands: ['make ci'] }).map((c) => c.source), ['acceptance']);
});

test('R2 batch 4: the harness check follows the permission policy: ask mode asks, a refusal ends unverified', async () => {
  const files = { 'package.json': JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "0"' } }), 'a.txt': '1' };
  const ws = tmpWorkspace(files);
  const steps = [{ name: 'read_file', arguments: { path: 'a.txt' } }, W('a.txt', '2')];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'Done.' }));
  const asked: PermissionRequest[] = [];
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'acceptEdits', agent: NO_MAP }), mcp: false, journal: false, ui: { requestPermission: async (r: PermissionRequest) => (asked.push(r), { decision: 'deny' as const }) } });
  const r = await a.run('change a');
  await a.dispose();
  await srv.close();
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /the harness runs the project's check itself to verify the agent's work/);
  assert.equal(r.completion.state, 'unverified');
  assert.match(r.completion.summary, /not run: the user declined to run it/);
});

// ------------------------------------------------------------------ R4 lows

test('R4 batch 4 lows: autocomplete is priced (dollar caps apply); cancelled FIM/NES requests are counted; repo-context blocks are counted', async () => {
  const srv = await startMockServer(() => ({ content: 'x' }));
  // (a) priced like its profile: a $ cap stops it; without pricing it never would
  const priced = testConfig(srv.url, { profiles: { default: { pricing: { inputPerM: 1_000_000, outputPerM: 1_000_000 } } }, limits: { maxCostUsdPerDay: 1 } });
  assert.equal(autocompleteAdmission(priced)('def add(a, b):\n    ' + 'x'.repeat(400), 64, 'mock-model').ok, false, 'a $1 cap stops a request estimated at more than $1');
  assert.equal(rawAdmission(priced, { kind: 'fim', role: 'autocomplete' })('def add(a, b):\n    ' + 'x'.repeat(400), 64, 'mock-model').ok, true, 'the unpriced hook (the old wiring) let it through');
  // (c) the counted prompt is the request's: repo-context blocks included
  const input = { prefix: 'def add(a, b):\n    ', suffix: '\n', path: 'a.py', extra: [{ filename: 'util.py', text: 'HELPER = 1\n'.repeat(50) }] };
  assert.match(requestPromptText(buildCompletionsBody('m', 'qwen', input, 64)), /<\|file_sep\|>util\.py\nHELPER = 1/);
  const seen: string[] = [];
  const cfg = testConfig(srv.url);
  const admit = rawAdmission(cfg, { kind: 'fim', role: 'autocomplete' });
  const ac = { enabled: true, endpoint: 'completions' as const, template: 'qwen' as const, debounceMs: 0, maxTokens: 64, baseUrl: srv.url, model: 'm' };
  // (b) cancelled after it was sent: the prompt estimate is recorded
  let cancel: () => void = () => {};
  const token = { isCancellationRequested: false, onCancellationRequested: (cb: () => void) => ((cancel = () => ((token.isCancellationRequested = true), cb())), { dispose() {} }) };
  const hanging: typeof fetch = ((_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
  const p = completeFim({ config: () => ac, fetch: hanging, admit: (t, m, mo) => (seen.push(t), admit(t, m, mo)) }, input, token);
  setTimeout(() => cancel(), 20);
  assert.equal(await p, '');
  assert.match(seen[0]!, /util\.py\nHELPER = 1/, 'admission counted the context blocks');
  // NES: timed out in flight
  const zp = buildZetaPrompt({ path: 'a.py', text: 'x = 1\n', cursor: 0, events: [] } as any);
  const nes = await requestNextEdit(hanging as any, { baseUrl: srv.url, model: 'm', maxTokens: 64, latencyMs: 30, admit: rawAdmission(cfg, { kind: 'nes', role: 'next-edit' }) } as any, zp);
  assert.equal(nes.reason, 'timeout');
  // a plain network failure before any answer spends nothing
  const refused: typeof fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as any;
  assert.equal(await completeFim({ config: () => ac, fetch: refused, admit }, { prefix: 'a', suffix: 'b' }, { isCancellationRequested: false }), '');
  const lines = readLedger(cfg.homeDir, localDate());
  assert.deepEqual(lines.map((l: any) => [l.kind, l.completionTokens, !!l.estimated]), [['fim', 0, true], ['nes', 0, true]], 'one estimated line per cancelled request; none for the refused connection');
  assert.ok((lines[0] as any).promptTokens > 100, 'the estimate includes the context blocks');
  await srv.close();
});

test('R2 batch 4: the harness check is journaled as evidence (byHarness, its source)', async () => {
  const pkg = JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: 'node -e "console.log(\'# tests 1\\n# pass 1\')"' } });
  const ws = tmpWorkspace({ 'package.json': pkg, 'a.txt': '1' });
  const steps = [{ name: 'read_file', arguments: { path: 'a.txt' } }, W('a.txt', '2')];
  const srv = await startMockServer((_b, i) => (steps[i] ? { toolCalls: [steps[i]] } : { content: 'Done, tests pass.' }));
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: NO_MAP });
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const r = await a.run('change a');
  await a.dispose();
  await srv.close();
  assert.equal(r.completion.state, 'verified', r.completion.summary);
  const lines = fs.readFileSync(a.journalFile!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'evidence' && l.evidence.byHarness && l.evidence.command === 'npm test' && l.evidence.source === 'detected'));
});
