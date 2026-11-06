/**
 * Fixes from the v1.2 live run on OpenRouter qwen/qwen3.8-27b (5 Nov 2026), each with a test that fails without it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent/agent.js';
import { registerAgentExtension } from '../src/core/agent/extensions.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

let phase = 0;

test('LIVE1: in an unattended run, the harness check goes through the approval extensions (auto mode), so a fix can be verified', async () => {
  let consulted = 0;
  phase = 1;
  registerAgentExtension({
    id: 'live1-approver',
    approve(_a, q) {
      if (phase === 1 && q.tool === 'bash' && /npm test|node -e/.test(String((q.args as any)?.command ?? ''))) {
        consulted++;
        return { decision: 'allow', by: 'classifier', reason: 'runs the project tests' };
      }
      return undefined;
    },
  });
  const pkg = JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
  const ws = tmpWorkspace({ 'package.json': pkg });
  const srv = await startMockServer((_b: any, i: number) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'answer.txt', content: 'x\n' } }] } : { content: 'Done, tests pass.' }));
  try {
    // "ask" mode and no UI: before the fix, the harness check could only ask a human, found none, and ended unverified
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask', permissions: { allow: ['write_file(*)'] }, agent: { requireVerification: true, repoMapTokens: 0, backgroundCompaction: false } } as any), mcp: false, ui: {} });
    const r = await agent.run('Write the answer and verify');
    await agent.dispose();
    assert.ok(consulted >= 1, 'the approver was consulted for the harness check');
    assert.equal(r.completion.state, 'verified', JSON.stringify(r.completion));
  } finally {
    phase = 0;
    await srv.close();
  }
});

test('LIVE1: the harness check never takes an approver allow past a floor ask, nor when the session is tainted', async () => {
  phase = 2;
  registerAgentExtension({
    id: 'live1-floor',
    approve(_a, q) {
      if (phase === 2 && q.tool === 'bash' && /npm test|node -e/.test(String((q.args as any)?.command ?? ''))) return { decision: 'ask', by: 'prefilter', reason: 'floor' };
      return undefined;
    },
  });
  registerAgentExtension({ id: 'live1-allow', approve: (_a, q) => (phase === 2 && q.tool === 'bash' ? { decision: 'allow', by: 'classifier' } : undefined) });
  const pkg = JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
  const ws = tmpWorkspace({ 'package.json': pkg });
  const srv = await startMockServer((_b: any, i: number) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'answer.txt', content: 'x\n' } }] } : { content: 'Done.' }));
  try {
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask', permissions: { allow: ['write_file(*)'] }, agent: { requireVerification: true, repoMapTokens: 0, backgroundCompaction: false } } as any), mcp: false, ui: {} });
    const r = await agent.run('Write the answer and verify');
    await agent.dispose();
    assert.notEqual(r.completion.state, 'verified', 'a floor ask wins over an allow');
  } finally {
    phase = 0;
    await srv.close();
  }
});

test('LIVE2: classifier calls switch thinking off on OpenRouter (otherwise the 24-token stage 1 is spent thinking)', async () => {
  const { thinkingOffBody } = await import('../src/core/approver/automode.js');
  assert.deepEqual(thinkingOffBody({ baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3.8-27b' }), { reasoning: { enabled: false } });
});

test('LIVE3: floor categories the live classifier let through (credentials printed, program-running git options and env, schema wipes) are deterministic now', async () => {
  const { prefilter } = await import('../src/core/approver/prefilter.js');
  const hit = (c: string) => prefilter({ tool: 'bash', input: { tool: 'bash', kind: 'execute', command: c, cwd: '/w' } as any, args: { command: c }, reason: 'ask' }, '/w');
  for (const c of ['kubectl config view --raw --minify', 'gh auth token', 'aws configure get aws_secret_access_key', 'gcloud auth print-access-token', 'GIT_EXTERNAL_DIFF="sh x;" git diff', 'GIT_PAGER="sh x" git log', 'LD_PRELOAD=/tmp/x.so ls', 'git grep -O"sh x" TODO', 'git grep -nO"sh x" t', 'git grep --open-files-in-pa=x t', 'git diff --ext-diff', 'git -c core.pager="sh x" log', 'alembic downgrade base', 'rails db:reset', 'python manage.py flush', 'prisma migrate reset', 'php artisan migrate:fresh'])
    assert.ok(hit(c), `floored: ${c}`);
  for (const c of ['kubectl config view', 'kubectl get pods', 'alembic upgrade head', 'git diff', 'git grep -n TODO', 'git log --oneline', 'npm test', 'rails db:migrate'])
    assert.equal(hit(c), null, `not floored: ${c}`);
});

test('LIVE4: eval tasks whose verification lists tool names (browser_verify) do not run them as shell checks', async () => {
  const { isToolName } = await import('../src/core/eval/runner.js');
  for (const v of ['browser_verify', 'browser_snapshot', 'desktop_snapshot']) assert.equal(isToolName(v), true, v);
  for (const v of ['pytest', 'python3 -m pytest -q', 'npm test', 'grep -q X answer.txt', 'make check']) assert.equal(isToolName(v), false, v);
});

test('LIVE5: OpenRouter models without configured prices are costed from the published list (dollar limits work); a configured price wins', async () => {
  const { parseOpenRouterModels, _setPublishedPricing } = await import('../src/core/llm/pricing.js');
  const { costOf } = await import('../src/core/llm/client.js');
  const m = parseOpenRouterModels({ data: [{ id: 'qwen/qwen3.8-27b', pricing: { prompt: '0.00000015', completion: '0.000001875' } }, { id: 'bad', pricing: { prompt: 'x' } }] });
  assert.deepEqual(m.get('qwen/qwen3.8-27b'), { inputPerM: 0.15, outputPerM: 1.875 });
  assert.equal(m.has('bad'), false);
  const base = 'https://openrouter.ai/api/v1';
  const prof: any = { baseUrl: base, model: 'qwen/qwen3.8-27b' };
  const usage: any = { promptTokens: 1_000_000, completionTokens: 1_000_000 };
  _setPublishedPricing(base, 'qwen/qwen3.8-27b', undefined);
  assert.equal(costOf(usage, prof), 0, 'unknown before the list is loaded');
  _setPublishedPricing(base, 'qwen/qwen3.8-27b', { inputPerM: 0.15, outputPerM: 1.875 });
  assert.ok(Math.abs(costOf(usage, prof) - 2.025) < 1e-9);
  assert.equal(costOf(usage, { ...prof, pricing: { inputPerM: 1, outputPerM: 1 } }), 2, 'configured price wins');
  _setPublishedPricing(base, 'qwen/qwen3.8-27b', undefined);
});

test('LIVE6: an eval task\'s harness check is its acceptance commands, never the verification markers (bare `javac`, `Check`)', async () => {
  const { harnessChecksFor } = await import('../src/core/eval/runner.js');
  const java = { verification: ['javac', 'Check'], acceptance: ['rm -rf .oh-build && javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check', ': integrity; python3 .oh-eval/intact.py'] };
  assert.deepEqual(harnessChecksFor(java), java.acceptance);
  assert.deepEqual(harnessChecksFor({ verification: ['browser_verify', 'browser_snapshot'], acceptance: ['grep -q X answer.txt'] }), ['grep -q X answer.txt']);
  assert.deepEqual(harnessChecksFor({ verification: ['javac', 'browser_verify', 'go test ./...'] }), ['go test ./...'], 'without acceptance, only runnable commands');
});

test('LIVE7: a benchmarked external agent (Cline arm) never gets the real API key: only a dummy in argv/env/state, the proxy adds the real one upstream', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const http = await import('node:http');
  const { runExternal } = await import('../src/core/eval/external.js');
  const REAL = 'sk-or-v1-REALKEY-0123456789abcdef0123456789';
  let upstreamAuth = '';
  const up = http.createServer((req, res) => {
    upstreamAuth = String(req.headers.authorization ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
  const port = (up.address() as any).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live7-'));
  const ws = path.join(dir, 'ws');
  const state = path.join(dir, 'state');
  fs.mkdirSync(ws);
  // a stand-in agent: saves its argv and env "settings" in its state dir (as `cline auth` does), then calls the model
  const agent = path.join(dir, 'agent.mjs');
  fs.writeFileSync(agent, `import fs from 'node:fs';
const [,, key, base, st] = process.argv;
fs.mkdirSync(st, { recursive: true });
fs.writeFileSync(st + '/providers.json', JSON.stringify({ key, envKey: process.env.AGENT_KEY }));
const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
console.log('status', r.status);`);
  try {
    const r = await runExternal({
      arm: { command: `${process.execPath} ${agent} {{api_key}} {{base_url}} {{state}}`, env: { AGENT_KEY: '{{api_key}}' }, timeout_s: 60 } as any,
      workspace: ws, prompt: 'hi', profile: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm', apiKey: REAL }, stateDir: state, timeoutS: 60,
    });
    const saved = fs.readFileSync(path.join(state, 'providers.json'), 'utf8');
    assert.ok(!saved.includes(REAL), `the agent's saved settings hold no real key: ${saved}`);
    assert.match(saved, /oh-ext-[0-9a-f]{24}/, 'a per-run dummy key');
    assert.equal(upstreamAuth, `Bearer ${REAL}`, 'the proxy put the real key on the upstream request');
    assert.ok(!JSON.stringify(r).includes(REAL), 'the run result holds no real key');
  } finally {
    up.close();
  }
});
