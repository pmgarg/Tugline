/**
 * WS9 Ollama-native support, core side: the effective context comes from
 * Ollama's own API (/api/show, /api/ps) instead of the configured 32768, toolMode
 * and vision follow /api/show capabilities, results are cached per model, and a
 * non-Ollama endpoint never receives an /api/* request. Plus the pure model
 * sorting/filtering used by the VS Code onboarding card.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent } from '../src/core/agent/agent.js';
import { readOllamaCache } from '../src/core/llm/overlays.js';
import { capabilityPatch, detectLocalServers, detectOllama, effectiveContext, isEmbeddingModel, ollamaCapabilities, ollamaRoot, parseShow, sortModelChoices, toChoice } from '../src/core/llm/ollama.js';
import type { AgentEvent } from '../src/core/types.js';
import { testConfig, tmpWorkspace } from './helpers.js';

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});

interface MockOpts {
  /** behave like Ollama (/, /api/*, fp_ollama); false = a generic OpenAI-compatible server */
  ollama: boolean;
  capabilities?: string[];
  models?: string[];
  maxContext?: number;
  /** context_length reported by /api/ps once a chat request loaded the model */
  loaded?: number;
}

/** A mock Ollama (or plain OpenAI-compatible) server that records every request path. */
async function mockOllama(o: MockOpts) {
  const hits: string[] = [];
  const chats: any[] = [];
  let loaded = false;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const url = req.url ?? '/';
      hits.push(`${req.method} ${url}`);
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (url === '/v1/models') return send(200, { object: 'list', data: (o.models ?? ['mock-coder:7b']).map((id) => ({ id, object: 'model', owned_by: 'library' })) });
      if (url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        chats.push(body);
        loaded = true;
        const first = chats.length === 1;
        const fp = o.ollama ? { system_fingerprint: 'fp_ollama' } : {};
        // first request: a tool call (native if tools were sent, else the text protocol); then a final answer
        const msg = first
          ? body.tools
            ? { role: 'assistant', content: '', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] }
            : { role: 'assistant', content: '<tool_call>{"name": "list_dir", "arguments": {"path": "."}}</tool_call>' }
          : { role: 'assistant', content: 'done' };
        return send(200, { id: 'x', object: 'chat.completion', model: body.model, ...fp, choices: [{ index: 0, message: msg, finish_reason: first && body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5 } });
      }
      if (!o.ollama) return send(404, '404 page not found');
      if (url === '/') return send(200, 'Ollama is running');
      if (url === '/api/version') return send(200, { version: '0.12.6' });
      if (url === '/api/show') {
        const { model } = JSON.parse(raw || '{}');
        const caps = /embed|bge/.test(model ?? '') ? ['embedding'] : (o.capabilities ?? ['completion', 'tools']);
        return send(200, { parameters: 'temperature 0.7\nstop "<|im_end|>"', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': o.maxContext ?? 40960, 'qwen3.embedding_length': 2048 }, capabilities: caps });
      }
      if (url === '/api/ps') return send(200, { models: loaded ? [{ name: 'mock-coder:7b', model: 'mock-coder:7b', size: 1, context_length: o.loaded ?? 16384 }] : [] });
      return send(404, '404 page not found');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { url, hits, chats, api: () => hits.filter((h) => / \/api\//.test(h)) };
}

const NO_MAP = { agent: { repoMapTokens: 0 }, permissionMode: 'yolo' };

async function runAgent(url: string, over: any = {}, cfg = testConfig(url, { ...NO_MAP, ...over, profiles: { default: { model: 'mock-coder:7b', contextWindow: 32768, toolMode: 'auto', vision: false, ...(over.profiles?.default ?? {}) } } })) {
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: tmpWorkspace({ 'a.txt': 'x\n' }), config: cfg, mcp: false, ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('list the files');
  const profile = { ...agent.llm.profile };
  await agent.dispose();
  const notices = events.filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice').map((e) => e.message);
  return { res, profile, notices, cfg };
}

test('WS9 AC1: a mock Ollama drives the effective context from 32768 down to 16384 with one notice; toolMode and vision follow /api/show capabilities', async () => {
  // A random port: detected passively by the fp_ollama fingerprint of the first reply, no request up front.
  const m = await mockOllama({ ollama: true, capabilities: ['completion', 'vision'] });
  const { res, profile, notices, cfg } = await runAgent(m.url);
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(profile.contextWindow, 16384, 'min(configured 32768, loaded 16384)');
  const ctx = notices.filter((n) => /Ollama is running mock-coder:7b with a 16384-token context; using that \(raise it in Ollama → Settings → Context length\)/.test(n));
  assert.equal(ctx.length, 1, `one notice: ${JSON.stringify(notices)}`);
  assert.equal(profile.vision, true, 'vision from capabilities');
  assert.equal(profile.toolMode, 'text', 'no "tools" capability → text protocol');
  assert.ok(!m.chats[1].tools, 'the request after detection uses the text protocol (no tools field)');
  assert.ok(m.api().includes('GET /api/version') && m.api().includes('POST /api/show') && m.api().includes('GET /api/ps'));
  assert.ok(m.api().length <= 4, `few /api calls: ${m.api()}`);
  // cached per model
  const cached = readOllamaCache(cfg.homeDir, { baseUrl: m.url, model: 'mock-coder:7b' });
  assert.equal(cached?.isOllama, true);
  assert.equal(cached?.loadedContext, 16384);
  assert.equal(cached?.maxContext, 40960);
  assert.deepEqual(cached?.capabilities, ['completion', 'vision']);
});

test('WS9 AC1: with the cache (or detect "always"), the budget and native tool mode apply BEFORE the first request; /api/show is not called again', async () => {
  const m = await mockOllama({ ollama: true, capabilities: ['completion', 'tools', 'thinking'] });
  const first = await runAgent(m.url, { ollama: { detect: 'always' } });
  assert.equal(first.profile.toolMode, 'native');
  assert.ok(m.chats[0].tools?.length, 'tools sent natively from the first request (capabilities known up front)');
  assert.equal(first.profile.contextWindow, 16384);
  assert.equal(first.notices.filter((n) => /16384-token context/.test(n)).length, 1);
  // second session, same home: the cache answers; only /api/ps is re-read (the app setting may have changed)
  const before = m.api().length;
  const chatsBefore = m.chats.length;
  const cfg2 = testConfig(m.url, { ...NO_MAP, profiles: { default: { model: 'mock-coder:7b', contextWindow: 32768, toolMode: 'auto' } } });
  cfg2.homeDir = first.cfg.homeDir;
  const events: AgentEvent[] = [];
  let ctxAtFirstRequest = 0;
  const agent = await Agent.create({ workspace: tmpWorkspace({}), config: cfg2, mcp: false, ui: { onEvent: (e) => { events.push(e); if (e.type === 'usage') ctxAtFirstRequest ||= agent.llm.profile.contextWindow; } } });
  await agent.run('list the files');
  await agent.dispose();
  assert.equal(ctxAtFirstRequest, 16384, 'the cached loaded context is the budget for the first request (before /api/ps is re-read)');
  assert.ok(m.chats[chatsBefore].tools?.length, 'cached capabilities → native from the first request');
  const calls = m.api().slice(before);
  assert.deepEqual(calls, ['GET /api/ps'], `only /api/ps after the first request: ${calls}`);
  assert.equal(events.filter((e) => e.type === 'notice' && /16384-token context/.test(e.message)).length, 1);
});

test('WS9 AC1: a configured context smaller than Ollama\'s is kept, with no notice', async () => {
  const m = await mockOllama({ ollama: true, loaded: 65536, maxContext: 131072 });
  const r = await runAgent(m.url, { profiles: { default: { contextWindow: 20000 } } });
  assert.equal(r.profile.contextWindow, 20000);
  assert.ok(!r.notices.some((n) => /token context/.test(n)), JSON.stringify(r.notices));
});

test('WS9 AC1: an explicit toolMode is never overridden by capabilities', async () => {
  const m = await mockOllama({ ollama: true, capabilities: ['completion'] });
  const r = await runAgent(m.url, { ollama: { detect: 'always' }, profiles: { default: { toolMode: 'native' } } });
  assert.equal(r.profile.toolMode, 'native');
  assert.ok(m.chats.every((c) => c.tools?.length));
});

test('WS9 AC1: a non-Ollama URL never receives an /api/* (or GET /) request', async () => {
  const m = await mockOllama({ ollama: false });
  const r = await runAgent(m.url);
  assert.equal(r.res.stopReason, 'end_turn');
  assert.deepEqual(m.hits.filter((h) => !h.startsWith('POST /v1/chat/completions')), [], `unexpected requests: ${m.hits}`);
  assert.equal(r.profile.contextWindow, 32768);
  assert.ok(!r.notices.some((n) => /Ollama/.test(n)));
  // the UI helper does not touch /api either: GET / does not say "Ollama is running"
  assert.equal(await detectOllama(m.url, { probeRoot: true }), undefined);
  assert.ok(!m.hits.some((h) => / \/api\//.test(h)));
  // ollama.detect "off" disables even the default port
  const m2 = await mockOllama({ ollama: true });
  await runAgent(m2.url, { ollama: { detect: 'off' } });
  assert.deepEqual(m2.api(), []);
});

test('WS9: pure helpers — root URL, /api/show parsing, effective context, capability patch', async () => {
  assert.equal(ollamaRoot('http://localhost:11434/v1/'), 'http://localhost:11434');
  assert.equal(ollamaRoot('http://h:11434/v1/chat/completions'), 'http://h:11434');
  const s = parseShow({ parameters: 'num_ctx                        8192\nstop "x"', model_info: { 'llama.context_length': 131072 }, capabilities: ['completion', 'tools'] });
  assert.deepEqual(s, { maxContext: 131072, numCtx: 8192, capabilities: ['completion', 'tools'] });
  assert.equal(effectiveContext(s), 8192);
  assert.equal(effectiveContext({ ...s, loadedContext: 16384 }), 16384, 'the loaded context wins over num_ctx');
  assert.equal(effectiveContext({ maxContext: 4096, loadedContext: 16384 }), 4096, 'never above the model maximum');
  assert.equal(effectiveContext({}), undefined);
  assert.deepEqual(capabilityPatch({ toolMode: 'auto', vision: false }, ['completion', 'tools', 'vision']), { toolMode: 'native', vision: true });
  assert.deepEqual(capabilityPatch({ toolMode: 'text', vision: true }, ['completion']), {});
  const m = await mockOllama({ ollama: true });
  assert.equal(await detectOllama(m.url, { probeRoot: true }), '0.12.6', 'UI detection on a non-default port: "Ollama is running" at GET /');
  assert.equal(await detectOllama(m.url), undefined, 'without probeRoot only the default port qualifies');
});

test('WS9 AC2: model list for onboarding — tool-capable coder models first, embedding-only models dropped', async () => {
  const caps: Record<string, string[]> = {
    'llama3.2:3b': ['completion', 'tools'],
    'qwen2.5-coder:7b': ['completion', 'tools', 'insert'],
    'starcoder2:3b': ['completion', 'insert'],
    'llava:7b': ['completion', 'vision'],
    'nomic-embed-text:latest': ['embedding'],
    'bge-m3:latest': ['embedding'],
    'devstral:24b': ['completion', 'tools'],
  };
  const sorted = sortModelChoices(Object.entries(caps).map(([id, c]) => toChoice(id, c)));
  assert.deepEqual(sorted.map((m) => m.id), ['devstral:24b', 'qwen2.5-coder:7b', 'llama3.2:3b', 'starcoder2:3b', 'llava:7b']);
  // without capabilities (LM Studio, llama.cpp): names decide; unknown sits between tool-capable and tool-less
  const noCaps = sortModelChoices(['text-embedding-nomic-embed-text-v1.5', 'bge-m3', 'qwen/qwen3-coder-30b', 'google/gemma-3-12b', 'mxbai-embed-large', 'e5-large'].map((id) => toChoice(id)));
  assert.deepEqual(noCaps.map((m) => m.id), ['qwen/qwen3-coder-30b', 'google/gemma-3-12b']);
  assert.equal(isEmbeddingModel('nomic-embed-text'), true);
  assert.equal(isEmbeddingModel('bge-m3:latest'), true);
  assert.equal(isEmbeddingModel('qwen3:8b'), false);
  assert.equal(isEmbeddingModel('qwen3-embedding:0.6b', ['completion']), false, 'capabilities win over the name when known');
  const mixed = sortModelChoices([toChoice('zeta:1b', ['completion']), toChoice('alpha-coder', undefined), toChoice('beta', ['completion', 'tools'])]);
  assert.deepEqual(mixed.map((m) => m.id), ['beta', 'alpha-coder', 'zeta:1b']);
  // capabilities from a (mock) Ollama
  const o = await mockOllama({ ollama: true, capabilities: ['completion', 'tools'] });
  const got = await ollamaCapabilities(o.url, ['a:1b', 'nomic-embed-text:latest']);
  assert.deepEqual(got.get('a:1b'), ['completion', 'tools']);
  assert.deepEqual(got.get('nomic-embed-text:latest'), ['embedding']);
});

test('WS9 AC3: local server detection lists only servers that answer', async () => {
  const live = await mockOllama({ ollama: true, models: ['qwen3:4b'] });
  const dead = 'http://127.0.0.1:9/v1'; // discard port: refused
  const found = await detectLocalServers([
    { kind: 'ollama', label: 'Ollama', baseUrl: live.url },
    { kind: 'lmstudio', label: 'LM Studio', baseUrl: dead },
  ]);
  assert.deepEqual(found.map((f) => [f.kind, f.models]), [['ollama', ['qwen3:4b']]]);
});

test('WS9 AC2+AC3: setupCheck — missing model → sorted model buttons; installed model → no card; unreachable → only the local servers that answer', async () => {
  const { setupCheck, serverModels, modelListed } = await import('../vscode/src/onboarding.js');
  const o = await mockOllama({ ollama: true, capabilities: ['completion', 'tools'], models: ['llama3.2:3b', 'nomic-embed-text:latest', 'qwen2.5-coder:7b', 'bge-m3:latest'] });
  const missing = await setupCheck({ baseUrl: o.url, model: 'qwen3-coder:30b' });
  assert.equal(missing?.state, 'missingModel');
  assert.equal(missing?.ollama, '0.12.6');
  assert.deepEqual(missing?.models.map((m) => m.id), ['qwen2.5-coder:7b', 'llama3.2:3b'], 'tool-capable coder first; embedding-only models (nomic-embed-text, bge-m3) excluded');
  assert.equal(await setupCheck({ baseUrl: o.url, model: 'qwen2.5-coder:7b' }), undefined, 'installed → no card');
  assert.equal((await setupCheck({ baseUrl: o.url, model: '' }))?.state, 'noModel');
  const down = await setupCheck({ baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }, { candidates: [{ kind: 'ollama', label: 'Ollama', baseUrl: o.url }, { kind: 'llamacpp', label: 'llama.cpp server', baseUrl: 'http://127.0.0.1:9/v1' }], timeoutMs: 1500 });
  assert.equal(down?.state, 'unreachable');
  assert.deepEqual(down?.servers.map((s) => s.baseUrl), [o.url]);
  const pick = await serverModels({ baseUrl: o.url, model: 'llama3.2:3b' });
  assert.equal(pick.state, 'pickModel', 'a server button always lists its models');
  assert.ok(modelListed('qwen3', ['qwen3:latest']) && modelListed('qwen3:latest', ['qwen3']) && modelListed('m', ['org/m']) && !modelListed('qwen3-coder:30b', ['qwen3:4b']));
});
