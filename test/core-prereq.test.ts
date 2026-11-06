/** Live run 31 Oct: stop and say what is missing instead of looping on a secret the environment does not have. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { missingFromOutput, workaround } from '../src/core/agent/prereq.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const HAVE_PYTEST = spawnSync('python3', ['-c', 'import pytest'], { stdio: 'ignore' }).status === 0;
const repo = () =>
  tmpWorkspace({
    'digest.py': 'import hmac, hashlib, os\n\ndef digest(message):\n    secret = os.environ.get("DIGEST_SECRET", "")\n    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()[:16]\n',
    'tests/test_digest.py': 'import os\n\nfrom digest import digest\n\n\ndef test_secret_configured():\n    assert os.environ.get("DIGEST_SECRET"), "DIGEST_SECRET must be provided by the deployment"\n\n\ndef test_digest_known_value():\n    assert digest("hello") == "ad5d0d9bd2b9f2a7"\n',
  });

test('prereq (unit): missing secrets are recognised in test and runtime output; ordinary failures are not', () => {
  const pytestOut = `>       assert os.environ.get("DIGEST_SECRET"), "DIGEST_SECRET must be provided by the deployment"\nE       AssertionError: DIGEST_SECRET must be provided by the deployment\nFAILED tests/test_digest.py::test_secret_configured`;
  assert.deepEqual(missingFromOutput(pytestOut), ['DIGEST_SECRET']);
  assert.deepEqual(missingFromOutput(`Traceback (most recent call last):\nKeyError: 'STRIPE_API_KEY'`), ['STRIPE_API_KEY']);
  assert.deepEqual(missingFromOutput(`Error: OPENAI_API_KEY is not set`), ['OPENAI_API_KEY']);
  assert.deepEqual(missingFromOutput(`TypeError: Cannot read properties of undefined (process.env.GITHUB_TOKEN)`), ['GITHUB_TOKEN']);
  assert.deepEqual(missingFromOutput(`ERROR: DEPLOY_REGION must be provided by the deployment`), ['DEPLOY_REGION'], 'a deployment-provided value even without a credential-like name');
  // not prerequisites
  assert.deepEqual(missingFromOutput(`E   assert 3 == 4\nFAILED tests/test_calc.py::test_add`), []);
  assert.deepEqual(missingFromOutput(`ModuleNotFoundError: No module named 'calc'`), []);
  assert.deepEqual(missingFromOutput(`2 passed in 0.01s (reads os.environ.get("API_TOKEN") only when set)`), [], 'no failure, no signal');
  assert.deepEqual(missingFromOutput(`FAILED: PATH is not set correctly`), [], 'PATH is not a secret');
});

test('prereq (unit): setting, guessing or test-editing counts as a workaround; real fixes do not', () => {
  const n = ['DIGEST_SECRET'];
  assert.ok(workaround(n, 'bash', { command: 'DIGEST_SECRET=secret python3 -m pytest -q' }));
  assert.ok(workaround(n, 'bash', { command: 'export DIGEST_SECRET=x && python3 -m pytest -q' }));
  assert.ok(workaround(n, 'bash', { command: "python3 - <<'EOF'\nimport hmac, hashlib, itertools\nfor k in itertools.product('abc', repeat=4): pass\nEOF" }));
  assert.ok(workaround(n, 'edit_file', { path: 'tests/test_digest.py', old_string: 'a', new_string: 'b' }));
  assert.ok(workaround(n, 'edit_file', { path: 'conftest.py', new_string: 'os.environ["DIGEST_SECRET"] = "x"' }));
  assert.ok(!workaround(n, 'edit_file', { path: 'digest.py', old_string: 'x', new_string: 'y' }));
  assert.ok(!workaround(n, 'bash', { command: 'python3 -m pytest -q' }));
});

async function run(script: (i: number) => any) {
  const ws = repo();
  const srv = await startMockServer((_b, i) => script(i));
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, maxTurns: 40 } });
    const a: any = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    try {
      const t = Date.now();
      const r: any = await a.run('Make `python3 -m pytest -q` pass.');
      return { r, ms: Date.now() - t, requests: srv.requests.length };
    } finally {
      await a.dispose();
    }
  } finally {
    await srv.close();
  }
}

test('prereq: a model that keeps guessing the secret is stopped as `blocked` within a few turns, with what is needed', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const guesses = (i: number) => ({ toolCalls: [{ name: 'bash', arguments: { command: `python3 -c "import hmac, hashlib; print([hmac.new(k.encode(), b'hello', hashlib.sha256).hexdigest()[:16] for k in ['k${i}a','k${i}b']])"` } }] });
  const { r, requests } = await run((i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -m pytest -q' } }] } : guesses(i)));
  assert.equal(r.stopReason, 'blocked');
  assert.match(r.finalText, /needs `DIGEST_SECRET`/);
  assert.match(r.finalText, /export DIGEST_SECRET=/);
  assert.ok(requests <= 8, `stopped after ${requests} model calls (it ran to the 25-minute limit before)`);
});

test('prereq: setting the variable itself twice is stopped as `blocked` straight away', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const { r, requests } = await run((i) => ({ toolCalls: [{ name: 'bash', arguments: { command: i === 0 ? 'python3 -m pytest -q' : `DIGEST_SECRET=guess${i} python3 -m pytest -q` } }] }));
  assert.equal(r.stopReason, 'blocked');
  assert.ok(requests <= 4, `${requests} model calls`);
});

test('prereq: the honest path (report and stop) ends normally after one hint', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  let hinted = false;
  const { r, requests } = await run((i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -m pytest -q' } }] };
    return { content: 'I cannot make this pass: the tests need DIGEST_SECRET, which is not set here. Please provide it.' };
  });
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(requests, 2);
  void hinted;
});

test('prereq: an ordinary failing test with no missing secret is never stopped early', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def add(a, b):\n    return a - b\n', 'tests/test_calc.py': 'from calc import add\n\ndef test_add():\n    assert add(2, 2) == 4\n' });
  const srv = await startMockServer((_b, i) => (i < 6 ? { toolCalls: [{ name: 'bash', arguments: { command: `python3 -m pytest -q # try ${i}` } }] } : { content: 'done' }));
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false } });
    const a: any = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    const r: any = await a.run('fix add');
    await a.dispose();
    assert.notEqual(r.stopReason, 'blocked');
  } finally {
    await srv.close();
  }
});
