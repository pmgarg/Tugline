/** WS7 G6: SDK surface, the example against the mock server, and the Python client against `tug serve`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAgent, defineSkill, defineTool, run, sdkConfig } from '../src/sdk/index.js';
import { startMockServer, tmpWorkspace } from './helpers.js';

const TSX = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = path.resolve('src/cli/main.ts');

function isolatedEnv(llmUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sdk-home-'));
  return { ...process.env, HOME: home, TUG_BASE_URL: llmUrl, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-test-1234567890abcdef', TUG_CONTEXT_WINDOW: '32768', TUG_MAX_OUTPUT_TOKENS: '1024', ...extra };
}

function runNode(args: string[], env: NodeJS.ProcessEnv, cwd = path.resolve('.')): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('G6 AC1: the example in examples/sdk runs against the mock server', async () => {
  const llm = await startMockServer((body, i) => {
    if (i === 0) {
      assert.ok(body.tools.some((t: any) => t.function.name === 'multiply'), 'custom tool offered');
      assert.match(String(body.messages[0].content), /math-answers: Use for arithmetic questions\./, 'code-defined skill listed');
      return { toolCalls: [{ name: 'multiply', arguments: { a: 6, b: 7 } }] };
    }
    assert.equal(body.messages.at(-1).content, '42');
    return { content: '42' };
  });
  try {
    const r = await runNode(['--import', TSX, path.resolve('examples/sdk/basic.mts'), 'What is 6 times 7?'], isolatedEnv(llm.url));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), '42');
    assert.match(r.stderr, /\[tool\] multiply → 42/);
    assert.match(r.stderr, /\[end_turn\] 1 tool call/);
  } finally {
    await llm.close();
  }
});

test('G6: createAgent / run / defineTool / defineSkill behave as documented (deny without onPermission)', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'shell_thing', arguments: { cmd: 'x' } }] } : { content: 'ok' }));
  let ran = 0;
  const t = defineTool<{ cmd: string }>({ name: 'shell_thing', kind: 'execute', description: 'Runs a thing', parameters: { type: 'object', properties: { cmd: { type: 'string' } } }, permission: (a) => ({ command: a.cmd }), run: () => (ran++, 'ran') });
  try {
    const r = await run('go', { workspace: ws, baseUrl: llm.url, model: 'mock-model', apiKey: 'sk-test-1234567890abcdef', loadUserConfig: false, tools: [t], config: { homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sdkh-')), checkpoints: { enabled: false } } });
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(ran, 0, 'an execute tool is denied without an approval handler');
    assert.equal(r.stats.refusals, 1);
    assert.ok(r.events.some((e) => e.type === 'refusal'));
  } finally {
    await llm.close();
  }
  assert.throws(() => defineTool({ name: 'bad name', kind: 'meta', description: '', parameters: {}, run: () => '' }), /invalid tool name/);
  assert.throws(() => defineTool({ name: 'x', kind: 'whatever' as any, description: '', parameters: {}, run: () => '' }), /kind must be/);
  assert.throws(() => defineSkill({ name: 'Bad', description: '', instructions: '' }), /invalid skill name/);
  assert.throws(() => defineSkill({ name: 'ok', description: '', instructions: '', files: { '../x': '' } }), /inside the skill/);
  const cfg = sdkConfig({ workspace: ws, baseUrl: 'http://h/v1', model: 'm', permissionMode: 'plan', loadUserConfig: false });
  assert.equal(cfg.profiles.default.baseUrl, 'http://h/v1');
  assert.equal(cfg.permissionMode, 'plan');
  const agent = await createAgent({ workspace: ws, baseUrl: 'http://127.0.0.1:9/v1', loadUserConfig: false, mcp: false, skills: [defineSkill({ name: 'sdk-skill', description: 'd', instructions: 'body', files: { 'ref/x.md': 'more' } })], config: { homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sdkh-')) } });
  try {
    assert.match(agent.skills.load('sdk-skill') ?? '', /body[\s\S]*ref\/x\.md/);
  } finally {
    await agent.dispose();
  }
});

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('G6 AC2: the Python client passes its tests against `tug serve` (WebSocket and stdio)', { skip: hasPython ? false : 'python3 is not available' }, async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((body) => {
    const last = body.messages.at(-1);
    if (last.role === 'user' && !String(last.content).startsWith('Before finishing')) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo py > py-made.txt' } }] };
    return { content: 'PY-OK' };
  });
  const token = 'py-test-token-' + Math.random().toString(36).slice(2);
  const env = isolatedEnv(llm.url, { TUG_SERVER_TOKEN: token });
  const serve = spawn(process.execPath, ['--import', TSX, CLI, 'serve', '--port', '0'], { env, cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`tug serve did not start: ${err}`)), 30_000);
      serve.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/listening on (ws:\/\/127\.0\.0\.1:\d+)/);
        if (m && /token: /.test(err)) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
    });
    assert.match(err, new RegExp(`token: ${token}`));
    // async spawn: the mock LLM runs in this process, so its event loop must stay free
    const py = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('python3', ['-I', path.resolve('sdk/python/test_tugline_client.py'), '-v'], {
        env: { ...env, TUG_SERVER_URL: url, TUG_TEST_WORKSPACE: ws, TUG_STDIO_ARGV: JSON.stringify([process.execPath, '--import', TSX, CLI, 'serve', '--stdio']) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const t = setTimeout(() => c.kill('SIGKILL'), 120_000);
      c.stdout.on('data', (d) => (stdout += d));
      c.stderr.on('data', (d) => (stderr += d));
      c.on('close', (status) => (clearTimeout(t), resolve({ status, stdout, stderr })));
    });
    assert.equal(py.status, 0, `${py.stdout}\n${py.stderr}`);
    assert.match(py.stderr, /Ran 4 tests[\s\S]*OK/);
  } finally {
    serve.kill('SIGTERM');
    await new Promise((r) => serve.once('close', r));
    await llm.close();
  }
});
