/**
 * Live run on the user's Mac (30 Oct 2026, 96 runs, 8 Ollama models): every run that really solved its task was
 * labelled `failed` by the harness check, because the tasks' check commands were run literally:
 *  - bare `pytest` does not put the project root on sys.path → `No module named 'calc'`, exit 2;
 *  - `tests/check.py` without the executable bit → `permission denied`, exit 126.
 * The harness now runs checks the way a developer would (runnableCheck), and exit 126 is "could not start".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { planChecks, runnableCheck, runnerUnavailable } from '../src/core/context/harnessCheck.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const HAVE_PYTEST = spawnSync('python3', ['-c', 'import pytest'], { stdio: 'ignore' }).status === 0;
const PY = process.platform === 'win32' ? 'python' : 'python3';

async function solve(ws: string, verifyCommands: string[]): Promise<{ state?: string; summary?: string }> {
  const calls = [
    { name: 'read_file', arguments: { path: 'calc.py' } },
    { name: 'edit_file', arguments: { path: 'calc.py', old_string: 'return sum(xs) / len(xs)', new_string: 'return sum(xs) / len(xs) if xs else 0' } },
  ];
  const srv = await startMockServer((_b, i) => (calls[i] ? { toolCalls: [calls[i]] } : { content: 'Fixed: average([]) is 0 now.' }));
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { verifyCommands, repoMapTokens: 0, backgroundCompaction: false } });
    const a: any = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    try {
      const r: any = await a.run('make average([]) return 0');
      return { state: r.completion?.state, summary: r.completion?.summary };
    } finally {
      await a.dispose();
    }
  } finally {
    await srv.close();
  }
}

const calcRepo = (extra: Record<string, string> = {}) =>
  tmpWorkspace({
    'calc.py': 'def average(xs):\n    return sum(xs) / len(xs)\n',
    'tests/test_calc.py': 'from calc import average\n\ndef test_empty():\n    assert average([]) == 0\n\ndef test_one():\n    assert average([4]) == 4\n',
    ...extra,
  });

test('live 1 (unit): pytest runs as `python -m pytest`; a non-executable script runs through its interpreter', () => {
  const ws = tmpWorkspace({ 'tests/check.py': '#!/usr/bin/env python3\nprint(1)\n', 'tools/run.sh': 'echo hi\n', 'tools/x.js': 'console.log(1)\n', 'bin/ok': '#!/bin/sh\necho ok\n' });
  fs.chmodSync(path.join(ws, 'bin/ok'), 0o755);
  assert.equal(runnableCheck(ws, 'pytest'), `${PY} -m pytest`);
  assert.equal(runnableCheck(ws, 'pytest -q tests'), `${PY} -m pytest -q tests`);
  assert.equal(runnableCheck(ws, 'py.test'), `${PY} -m pytest`);
  assert.equal(runnableCheck(ws, 'tests/check.py'), 'python3 tests/check.py', 'the shebang interpreter');
  assert.equal(runnableCheck(ws, 'tools/run.sh --x'), 'bash tools/run.sh --x', 'by extension');
  assert.equal(runnableCheck(ws, 'tools/x.js'), 'node tools/x.js');
  assert.equal(runnableCheck(ws, 'bin/ok'), 'bin/ok', 'an executable script runs as is');
  assert.equal(runnableCheck(ws, 'npm test'), 'npm test');
  assert.equal(runnableCheck(ws, 'python3 -m pytest -q'), 'python3 -m pytest -q');
  assert.equal(runnableCheck(ws, '../outside.py'), '../outside.py', 'never outside the workspace');
  assert.deepEqual(planChecks(ws, { verifyCommands: ['pytest', 'tests/check.py'] }).map((c) => c.command), [`${PY} -m pytest`, 'python3 tests/check.py']);
  assert.match(runnerUnavailable(126, 'zsh:1: permission denied: tests/check.py') ?? '', /could not be executed/);
});

test('live 1: a solved task checked with bare `pytest` ends `verified` (it ended `failed`: No module named calc)', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const r = await solve(calcRepo(), ['pytest']);
  assert.equal(r.state, 'verified', r.summary);
});

test('live 1: a solved task checked with a non-executable `tests/check.py` ends `verified` (it ended `failed`, exit 126)', async () => {
  const ws = calcRepo({ 'tests/check.py': '#!/usr/bin/env python3\nimport sys\nsys.path.insert(0, ".")\nfrom calc import average\nassert average([]) == 0 and average([4]) == 4\nprint("ok")\n' });
  fs.chmodSync(path.join(ws, 'tests/check.py'), 0o644);
  const r = await solve(ws, ['tests/check.py']);
  assert.equal(r.state, 'verified', r.summary);
});

test('live 1: an unsolved task still ends `failed` with the normalised check', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const ws = calcRepo({ 'tests/test_more.py': 'from calc import average\n\ndef test_two():\n    assert average([1, 2]) == 2\n' });
  const r = await solve(ws, ['pytest']);
  assert.equal(r.state, 'failed', r.summary);
});
