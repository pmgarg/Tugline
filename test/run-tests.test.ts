/** The test runner's stall watchdog (scripts/run-tests.mjs): a test file that blocks its own event loop must not hang CI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNNER = path.resolve('scripts/run-tests.mjs');

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-runner-'));
  fs.mkdirSync(path.join(root, 'test'));
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'test', f), body);
  fs.symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  return root;
}

function runner(cwd: string, stallMs: number): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = { ...process.env, TUG_TEST_STALL_MS: String(stallMs) };
    delete env.CI;
    delete env.NODE_TEST_CONTEXT; // else the nested runner thinks it is inside a test file and runs nothing
    const c = spawn(process.execPath, [RUNNER, '--parallel'], { cwd, env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

test('runner: a test file blocked in a synchronous call is reported by name, stopped, and fails the run', { skip: process.platform === 'win32' ? 'uses ps and POSIX signals' : false, timeout: 120_000 }, async () => {
  const marker = `oh-stall-${process.pid}-${Date.now()}`;
  const root = fixture({
    'ok.test.ts': "import { test } from 'node:test';\ntest('fine', () => {});\n",
    // a spawnSync that never returns blocks the event loop: --test-timeout and --test-force-exit cannot fire
    'block.test.ts': `import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\ntest('blocks', () => { spawnSync('bash', ['-c', 'exec -a ${marker} sleep 600']); });\n`,
  });
  try {
    const r = await runner(root, 3000);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.ms < 90_000, `stopped after ${r.ms} ms`);
    assert.match(r.out, /Test run stalled::no output for 3 s; still running: \S*block\.test\.ts/);
    assert.match(r.out, new RegExp(marker), 'the blocking child command is listed');
    const left = spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(marker) && !l.includes('exec -a'));
    assert.deepEqual(left, [], 'nothing from the stalled file is left running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner: a group that keeps printing is not stopped, and a passing run exits 0', { skip: process.platform === 'win32' ? 'uses ps and POSIX signals' : false, timeout: 120_000 }, async () => {
  const root = fixture({ 'ok.test.ts': "import { test } from 'node:test';\ntest('fine', async () => { await new Promise((r) => setTimeout(r, 200)); });\n" });
  try {
    const r = await runner(root, 60_000);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /# pass 1/, 'the fixture test really ran');
    assert.doesNotMatch(r.out, /stalled/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
