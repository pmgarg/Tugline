/**
 * A9: the editing evaluation suite (evals/editing) and its metrics.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadSuite } from '../src/core/eval/runner.js';
import { editMetrics, renderEditMetrics, INTEGRITY_PREFIX } from '../src/core/edit/metrics.js';
import { checkTask } from '../evals/editing/check.mts';
import { startMockServer } from './helpers.js';

const SUITE = path.join(import.meta.dirname, '..', 'evals', 'editing');

test('A9: the suite has ≥ 30 tasks over Python, TS, Go, Java and JSON/YAML, each with an integrity check and a hidden solution', () => {
  const { suite, tasks } = loadSuite(SUITE);
  assert.ok(tasks.length >= 30, `${tasks.length} tasks`);
  const langs = new Set(tasks.map((t) => (t as any).language));
  assert.deepEqual([...langs].sort(), ['config', 'go', 'java', 'python', 'typescript']);
  for (const t of tasks) {
    assert.ok(t.acceptance.some((c) => c.startsWith(INTEGRITY_PREFIX)), t.id);
    assert.ok(t.protected.includes('.oh-eval/**'), t.id);
    assert.ok(fs.existsSync(path.join(t.dir, 'solution')), t.id);
    assert.ok(!fs.existsSync(path.join(t.dir, 'repo', 'solution')), `${t.id}: solution is not visible to the agent`);
  }
  assert.ok(Object.keys(suite.arms).length >= 1);
});

test('A9: one task per language is real (fails unfixed), solvable (reference passes) and detects corruption', (ctx) => {
  const { tasks } = loadSuite(SUITE);
  // The TypeScript tasks check with `node tests/check.ts`, which needs a Node that runs .ts files (22.6+ / 23.6+).
  const tsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-a9-ts-'));
  fs.writeFileSync(path.join(tsDir, 'probe.ts'), 'const n: number = 1; if (n !== 1) process.exit(1);\n');
  const nodeRunsTs = spawnSync(process.execPath, [path.join(tsDir, 'probe.ts')], { stdio: 'ignore' }).status === 0;
  fs.rmSync(tsDir, { recursive: true, force: true });
  for (const id of ['py02-crlf', 'ts04-template-escapes', 'go05-crlf-stack', 'java03-escapes', 'cfg03-yaml-list']) {
    if (id.startsWith('ts') && !nodeRunsTs) {
      ctx.diagnostic(`${id} skipped: Node ${process.version} cannot run .ts files`);
      continue;
    }
    const t = tasks.find((x) => x.id === id)!;
    assert.deepEqual(checkTask(t.dir, t.acceptance), [], id);
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: path.join(import.meta.dirname, '..'), env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('A9 AC1+AC2: `tug eval evals/editing` runs the suite and the report includes the 4 edit metrics', async () => {
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'pricing.py' } }] };
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'pricing.py', old_string: 'return price * pct / 100', new_string: 'return price * (100 - pct) / 100' } }] };
    if (i === 2) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'pricing.py', old_string: '        raise ValueError("percent out of range")\n    return price * percent / 100', new_string: '        raise ValueError("percent out of range")\n    return price * (100 - percent) / 100' } }] };
    if (i === 3) return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -m pytest -q tests' } }] };
    return { content: 'Fixed apply_discount; tests pass.' };
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-a9-home-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-a9-out-'));
  const r = await runCli(['eval', 'evals/editing', '--tasks', 'py02-crlf', '--out', out, '--base-url', srv.url, '--model', 'mock-model', '--native-tools'], { ...process.env, HOME: home, TUG_API_KEY: 'sk-test-1234567890abcdef' });
  await srv.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /py02-crlf__auto__r1/);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  assert.match(report, /\| py02-crlf__auto__r1 \| py02-crlf \| auto \| pass \|/);
  assert.match(report, /## Edit metrics \(SPEC A9\)/);
  assert.match(report, /\| arm \| runs \| first-try edit success \| recovered after error \| corrupted file \| edit calls ok \/ failed \| tier histogram \|/);
  assert.match(report, /\| auto \| 1 \| 0\/1 \(0%\) \| 1\/1 \(100%\) \| 0\/1 \(0%\) \| 1 \/ 1 \| eol 1 \|/);
  const json = JSON.parse(fs.readFileSync(path.join(out, 'edit-metrics.json'), 'utf8'));
  assert.deepEqual(json.auto.tiers, { eol: 1 });
  // CRLF survived the agent's LF anchor: the integrity check passed
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'runs', 'py02-crlf__auto__r1.json'), 'utf8'));
  assert.ok(rec.acceptance.every((a: any) => a.exitCode === 0), JSON.stringify(rec.acceptance));
});

test('A9 AC2: metrics count first-try, recovery, corruption and tiers from raw records', () => {
  const rec = (arm: string, events: any[], integrityExit: number) => ({ manifest: { arm }, events, acceptance: [{ command: 'pytest', exitCode: 0, output: '' }, { command: `${INTEGRITY_PREFIX} python3 .oh-eval/intact.py`, exitCode: integrityExit, output: '' }] }) as any;
  const start = (id: string, name: string, args: any) => ({ type: 'tool_start', id, name, args });
  const end = (id: string, name: string, ok: boolean, output: string, meta?: any) => ({ type: 'tool_end', id, name, ok, output, meta });
  const m = editMetrics([
    rec('a', [start('1', 'edit_file', { path: 'a.py' }), end('1', 'edit_file', true, 'Edited', { editTiers: ['indent'] }), start('2', 'multi_edit', { path: 'b.py' }), end('2', 'multi_edit', false, 'edit #1 of 2 failed; old_string was not found in b.py'), start('3', 'multi_edit', { path: 'b.py' }), end('3', 'multi_edit', true, 'Edited', { editTiers: [] })], 0),
    rec('a', [start('4', 'edit_file', { path: 'c.py' }), end('4', 'edit_file', false, 'cannot edit c.py before reading it'), start('5', 'apply_patch', { input: '*** Begin Patch\n*** Update File: c.py\n@@\n-a\n+b\n*** End Patch' }), end('5', 'apply_patch', false, 'Failed to find expected lines in c.py')], 1),
  ]);
  assert.deepEqual(m.firstTry, { ok: 1, total: 3 });
  assert.deepEqual(m.recovered, { ok: 1, total: 2 });
  assert.deepEqual(m.corrupted, { ok: 1, total: 2 });
  assert.deepEqual(m.tiers, { indent: 1, exact: 1 });
  assert.deepEqual(m.editCalls, { ok: 2, failed: 2 }, 'the read-before-edit refusal is not an edit failure');
  assert.match(renderEditMetrics([{ arm: 'a', m }]), /\| a \| 2 \| 1\/3 \(33%\) \| 1\/2 \(50%\) \| 1\/2 \(50%\) \| 2 \/ 2 \| (indent 1, exact 1|exact 1, indent 1) \|/);
});
