/**
 * Where a turn's time goes: Tugline's setup, the model's first reply (mostly the server reading the prompt), and the
 * prompt tokens the server reused from its cache. A user comparing response times needs these numbers to see whether
 * the wait is ours or the server's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from '../src/core/agent/agent.js';
import { LLMClient } from '../src/core/llm/client.js';
import { testConfig, tmpWorkspace } from './helpers.js';

/** A streaming server that waits `firstMs` before its first token, then reports `cached` prompt tokens (vLLM style). */
async function slowServer(firstMs: number, cached: number): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      setTimeout(() => {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] });
        setTimeout(() => {
          send({ choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }] });
          send({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cached } } });
          res.end('data: [DONE]\n\n');
        }, 150);
      }, firstMs);
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) };
}

test('timing: the client reports the time to the first token separately from the whole reply', async () => {
  const srv = await slowServer(400, 0);
  try {
    const r = await new LLMClient({ name: 't', baseUrl: srv.url, apiKey: '', model: 'm', contextWindow: 8192, maxOutputTokens: 256, toolMode: 'auto', vision: false }).complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.text, 'Hello!');
    assert.ok(r.ttftMs! >= 380 && r.ttftMs! < r.latencyMs, `ttft ${r.ttftMs} ms, total ${r.latencyMs} ms`);
    assert.ok(r.latencyMs >= 530);
  } finally {
    await srv.close();
  }
});

test('timing: a run reports setup, first reply, model time and cached prompt tokens', async () => {
  const srv = await slowServer(300, 4200);
  const ws = tmpWorkspace({});
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0 } }), mcp: false });
  try {
    const r = await agent.run('hi');
    const st = r.stats;
    assert.ok(st.setupMs !== undefined && st.setupMs >= 0 && st.setupMs < st.durationMs, `setup ${st.setupMs}`);
    assert.ok(st.firstTokenMs! >= 280, `first reply ${st.firstTokenMs}`);
    assert.ok(st.modelMs! >= st.firstTokenMs!, `model ${st.modelMs}`);
    assert.equal(st.cachedTokens, 4200);
    assert.ok(st.durationMs >= st.setupMs! + st.firstTokenMs!);
  } finally {
    await agent.dispose();
    await srv.close();
  }
});

test('first message: a prompt does not wait for a slow repo map; the map comes with the next prompt', async () => {
  const { startMockServer } = await import('./helpers.js');
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) files[`src/mod${i}.ts`] = `export function handler${i}(x: number): number {\n  return x + ${i};\n}\n`;
  const ws = tmpWorkspace(files);
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 1500, repoMapWaitMs: 1, repoMapCache: false } }), mcp: false });
  try {
    await agent.run('hi');
    await agent.run('now fix handler3');
    const userText = (i: number) => String(srv.requests[i].messages.filter((m: any) => m.role === 'user').at(-1).content);
    assert.doesNotMatch(userText(0), /<repo_map/, 'the first prompt did not wait for it');
    assert.match(userText(1), /<repo_map[\s\S]*handler3/, 'the next prompt carries it');
    assert.equal(srv.requests[2], undefined);
  } finally {
    await agent.dispose();
    await srv.close();
  }
});

test('first message: prewarm builds the repo map before the first prompt, which then carries it', async () => {
  const { startMockServer } = await import('./helpers.js');
  const ws = tmpWorkspace({ 'src/calc.ts': 'export function average(xs: number[]) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n' });
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 1500, repoMapWaitMs: 50 } }), mcp: false });
  try {
    await agent.prewarm();
    await agent.run('fix average for an empty list');
    assert.match(String(srv.requests[0].messages.at(-1).content), /<repo_map[\s\S]*average/);
  } finally {
    await agent.dispose();
    await srv.close();
  }
});
