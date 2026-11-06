#!/usr/bin/env node
/**
 * A tiny OpenAI-compatible server for smoke tests (CI artefact smoke, R7), with no
 * dependencies, so it also runs next to an installed package.
 *
 *   node scripts/mock-openai.mjs [--port 0] [--port-file f]
 *     prints MOCK_OPENAI_URL=http://127.0.0.1:<port>/v1 and serves until killed.
 *
 * GET  /v1/models            → one model, "mock-model"
 * POST /v1/chat/completions  → when the last user message says "Use the <tool> tool" and
 *                              that tool is offered, a call to it (get_weather gets
 *                              {"city":"Dubai"}: `tug doctor`'s tool-calling probe);
 *                              otherwise text: the X of "Reply with exactly: X", or "OK from mock".
 * Streams (SSE) when the request asks to, and reports usage.
 */
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

function reply(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const text = (m) => (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((p) => p.text ?? '').join('\n') : '');
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const asked = tools.find((t) => t.function?.name && text(lastUser).includes(`Use the ${t.function.name} tool`));
  if (asked && !msgs.some((m) => m.role === 'tool')) {
    const args = asked.function.name === 'get_weather' ? { city: 'Dubai' } : {};
    return { toolCalls: [{ id: 'call_mock_1', name: asked.function.name, arguments: JSON.stringify(args) }] };
  }
  const exact = text(lastUser).match(/Reply with exactly:\s*(\S+)/);
  return { content: exact ? exact[1] : 'OK from mock' };
}

export function startMockOpenAI({ port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models\/?$/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
      return;
    }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        res.writeHead(400).end();
        return;
      }
      requests.push(body);
      const r = reply(body);
      const usage = { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 };
      const toolCalls = (r.toolCalls ?? []).map((t, index) => ({ index, id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }));
      const finish = toolCalls.length ? 'tool_calls' : 'stop';
      const base = { id: 'chatcmpl-mock', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model ?? 'mock-model' };
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const send = (o) => res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', ...o })}\n\n`);
        send({ choices: [{ index: 0, delta: { role: 'assistant' } }] });
        if (r.content) send({ choices: [{ index: 0, delta: { content: r.content } }] });
        for (const tc of toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: [tc] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        if (body.stream_options?.include_usage) send({ choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? null, tool_calls: toolCalls.length ? toolCalls.map(({ index, ...t }) => t) : undefined }, finish_reason: finish }], usage }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}/v1`;
      resolve({ url, requests, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const m = await startMockOpenAI({ port: Number(arg('--port') ?? 0) });
  if (arg('--port-file')) fs.writeFileSync(arg('--port-file'), m.url + '\n');
  console.log(`MOCK_OPENAI_URL=${m.url}`);
  const stop = () => m.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
