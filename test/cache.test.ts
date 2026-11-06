/** WS10 N10: prompt-cache-aware context management (hit meter, llama.cpp slots, prefix guard, idle compaction). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand } from '../src/core/commands.js';
import { LLMClient, mapUsage } from '../src/core/llm/client.js';
import { probeEndpoint } from '../src/core/llm/probe.js';
import { profileWithCapabilities, writeCapabilities } from '../src/core/llm/overlays.js';
import { cacheBodyFields, resetSlotTables, slotFor } from '../src/core/llm/promptCache.js';
import { resolveProfile } from '../src/core/config.js';
import { cacheTallyFor, costReport, emptyTally, formatCacheLine, tallyEvents, tallyUsage } from '../src/core/cache/meter.js';
import { diffSnapshots, stabilizeSystemPrompt, systemSections, takeSnapshot, volatileEnvironment } from '../src/core/cache/prefix.js';
import { idleCompactionInFlight } from '../src/core/cache/extension.js';
import { statusInput } from '../src/core/plugins/statusLine.js';
import { scoreRun, summarizeScores } from '../src/core/eval/scorer.js';
import { emptyMeter, meterReduce, meterView } from '../vscode/src/meter.js';
import type { ToolDef } from '../src/core/tools/types.js';
import type { AgentEvent, ChatMessage } from '../src/core/types.js';
import { testConfig, tmpWorkspace } from './helpers.js';
import '../src/core/tools/providers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_MAP = { agent: { repoMapTokens: 0 } };
const sys = (body: any) => String(body.messages[0].content);

interface Reply {
  content?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  /** extra usage fields (prompt_tokens_details …) or null for no usage */
  usage?: Record<string, unknown> | null;
  timings?: Record<string, unknown>;
  status?: number;
  errorBody?: string;
  delayMs?: number;
}

/** A JSON-only OpenAI-compatible mock whose usage/timings blocks are scripted (helpers.ts has fixed usage). */
async function cacheMock(script: (body: any, i: number) => Reply, props?: Record<string, unknown>) {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url?.endsWith('/models')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      if (req.url?.endsWith('/props') && props) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(props));
      return void res.writeHead(404).end('not found');
    }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      const i = requests.length;
      requests.push(body);
      const r = script(body, i);
      if (r.delayMs) await sleep(r.delayMs);
      if (r.status) return void res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(r.errorBody ?? '{"error":"mock"}');
      const toolCalls = (r.toolCalls ?? []).map((t, k) => ({ id: `c${i}x${k}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } }));
      const usage = r.usage === null ? undefined : { prompt_tokens: 1000, completion_tokens: 10, ...(r.usage ?? {}) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? '', tool_calls: toolCalls.length ? toolCalls : undefined }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage, ...(r.timings ? { timings: r.timings } : {}) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  return { url, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function noteTool(): ToolDef {
  return { name: 'note', kind: 'read', readOnly: true, description: 'Record a note.', parameters: { type: 'object', properties: { n: { type: 'integer' } } }, title: () => 'note', run: async (a: any) => ({ output: `noted ${a.n}` }) };
}

// ------------------------------------------------------------------ AC1: meter

test('N10 AC1: with a server returning cached_tokens, /cost and the VS Code meter show the hit % per call and per session', async () => {
  const ws = tmpWorkspace({});
  // call 1: cold (0 cached), call 2: 800 of 1000 cached, call 3: 900 of 1000
  const cached = [0, 800, 900];
  const srv = await cacheMock((_b, i) => (i < 2 ? { toolCalls: [{ name: 'note', arguments: { n: i } }], usage: { prompt_tokens_details: { cached_tokens: cached[i] } } } : { content: 'done', usage: { prompt_tokens_details: { cached_tokens: cached[i] } } }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: [noteTool()], ui: { onEvent: (e) => events.push(e) } });
  await agent.run('go');
  await srv.close();

  // per call: the usage events carry cachedTokens
  const usage = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
  assert.deepEqual(usage.map((u) => u.usage.cachedTokens), [0, 800, 900]);

  // /cost (shared CLI + VS Code text)
  const cost = costReport(agent);
  assert.match(cost, /3 LLM calls/);
  assert.match(cost, /prompt cache: 56\.7% this session \(1\.7k of 3\.0k prompt tokens, 3 call\(s\)\) · last call 90% \(900 of 1\.0k\)/);

  // /cache command through the shared registry
  let out = '';
  getSlashCommand('cache')!.run('', { agent, config: agent.config, workspace: ws, write: (t) => (out += t), surface: 'cli' });
  assert.match(out, /56\.7% this session/);
  assert.match(out, /prefix breaks this session: 0/);

  // VS Code meter: same events through the pure reducer
  let m = emptyMeter(32768);
  for (const e of events) m = meterReduce(m, e);
  const v = meterView(m);
  assert.equal(v.cache, 'cache 56.7% · last 90%');
  assert.match(v.cost, /cache 56\.7% · last 90%/);
  assert.match(v.title, /Prompt cache: 56\.7% of 3000 prompt tokens/);

  // status-line JSON
  const st = statusInput(agent as any, ws);
  assert.equal(st.cache?.hit_percent, 56.7);
  assert.equal(st.cache?.last_call_percent, 90);

  // eval report (from the recorded events)
  const t = tallyEvents(events as any);
  assert.equal(t.cachedTokens, 1700);
});

test('N10 AC1: llama.cpp timings, Anthropic-style and missing reports are normalised; "not reported" is never 0 %', () => {
  assert.equal(mapUsage({ prompt_tokens: 500, completion_tokens: 5 }, { prompt_n: 100, cache_n: 400 })?.cachedTokens, 400, 'llama.cpp timings.cache_n');
  assert.deepEqual(mapUsage(undefined, { prompt_n: 100, cache_n: 400, predicted_n: 7 }), { promptTokens: 500, completionTokens: 7, cachedTokens: 400 }, 'timings without usage');
  assert.equal(mapUsage({ prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 9999 } })?.cachedTokens, 50, 'clamped to the prompt');
  assert.equal(mapUsage({ input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 20 })?.cachedTokens, 20);
  assert.equal(mapUsage({ prompt_tokens: 50, completion_tokens: 1 })?.cachedTokens, undefined);
  let t = tallyUsage(emptyTally(), { promptTokens: 1000, completionTokens: 5 });
  assert.equal(formatCacheLine(t), 'prompt cache: not reported by this server');
  t = tallyUsage(t, { promptTokens: 1000, completionTokens: 5, cachedTokens: 500 });
  assert.match(formatCacheLine(t), /50% this session .*1 call\(s\), 1 call\(s\) without a report/);
  let m = emptyMeter(1000);
  m = meterReduce(m, { type: 'usage', usage: { promptTokens: 10, completionTokens: 1 }, costUsd: 0, latencyMs: 1, model: 'm' });
  assert.equal(meterView(m).cache, '', 'the meter shows nothing (not 0 %) when the server does not report caching');
});

test('N10: eval reports carry the prompt-cache hit rate per run and per arm', () => {
  const base = { runId: 'r1', manifest: { task: 't', taskVersion: 1, taskType: 'code', arm: 'a', repeat: 0, model: 'm', baseUrl: 'u', toolMode: 'native', harnessVersion: 'x', protectedPaths: [], maxRepeatFailures: 4, maxTurns: 10, timeoutS: 1, startedAt: '' }, prompt: 'p', stopReason: 'end_turn', finalText: 'done', stats: { turns: 1, llmCalls: 2, successfulLlmCalls: 2, unparseableReplies: 0, toolCalls: 0, toolErrors: 0, refusals: 0, promptTokens: 2000, completionTokens: 10, costUsd: 0, durationMs: 1000, filesChanged: [], commandsRun: [] }, finalDiff: '', protectedBefore: {}, protectedAfter: {}, acceptance: [{ command: 'true', exitCode: 0, output: '' }], verificationCommands: [] };
  const events = [
    { type: 'usage', usage: { promptTokens: 1000, completionTokens: 5, cachedTokens: 0 } },
    { type: 'usage', usage: { promptTokens: 1000, completionTokens: 5, cachedTokens: 900 } },
    { type: 'cache_break', turn: 2, causes: ['memory'] },
  ];
  const s = scoreRun({ ...base, events } as any);
  assert.equal(s.cost.cacheHitPct, 45);
  assert.equal(s.cost.cacheBreaks, 1);
  assert.match(summarizeScores([s]), /\| a \| 1 \| 45\.0 \| 1 \|/);
  assert.equal(scoreRun({ ...base, events: [] } as any).cost.cacheHitPct, null);
  assert.doesNotMatch(summarizeScores([scoreRun({ ...base, events: [] } as any)]), /mean cache hit/);
});

// ------------------------------------------------------------------ AC2: llama.cpp slots

test('N10 AC2: with the llama.cpp dialect, requests carry cache_prompt: true and a distinct, stable id_slot for the main agent and each subagent', async () => {
  resetSlotTables();
  const ws = tmpWorkspace({});
  const srv = await cacheMock((body) => {
    if (sys(body).startsWith('You are a subagent')) {
      if (!body.messages.some((m: any) => m.role === 'tool')) return { toolCalls: [{ name: 'note', arguments: { n: 1 } }] };
      return { content: 'sub report' };
    }
    if (sys(body).startsWith('You are compressing')) return { content: 'summary' };
    const tools = body.messages.filter((m: any) => m.role === 'tool').length;
    if (tools === 0) return { toolCalls: [{ name: 'note', arguments: { n: 0 } }] };
    if (tools === 1) return { toolCalls: ['A', 'B'].map((x) => ({ name: 'task', arguments: { agent_type: 'general', description: `job ${x}`, prompt: `do job ${x}` } })) };
    return { content: 'all done' };
  });
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP, profiles: { default: { server: 'llamacpp', llamacpp: { slots: 4 } } } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, extraTools: [noteTool()] });
  await agent.run('go');
  await agent.run('again');
  await srv.close();
  const who = (b: any) => (sys(b).startsWith('You are a subagent') ? `sub ${String(b.messages.find((m: any) => m.role === 'user')?.content).match(/job (\w)/)?.[1]}` : 'main');
  const slots = new Map<string, Set<number>>();
  for (const b of srv.requests) {
    assert.equal(b.cache_prompt, true, 'every request asks llama.cpp to reuse its cache');
    assert.equal(typeof b.id_slot, 'number');
    const k = who(b);
    slots.set(k, new Set([...(slots.get(k) ?? []), b.id_slot]));
  }
  assert.deepEqual([...slots.keys()].sort(), ['main', 'sub A', 'sub B']);
  for (const [k, s] of slots) assert.equal(s.size, 1, `${k} keeps one slot across all its calls (and across runs for main)`);
  const ids = [...slots.values()].map((s) => [...s][0]);
  assert.equal(new Set(ids).size, 3, `main and each subagent have distinct slots (${ids})`);
  assert.equal([...slots.get('main')!][0], 0, 'the main agent gets slot 0');
  assert.ok(srv.requests.filter((b) => who(b) === 'main').length >= 4);
});

test('N10 AC2: other servers get no llama.cpp fields; unknown slot counts send cache_prompt only; a rejected id_slot is healed', async () => {
  resetSlotTables();
  assert.deepEqual(cacheBodyFields({ baseUrl: 'http://x/v1' }, undefined, { key: 'a', primary: true }, false), {}, 'not llama.cpp → nothing');
  assert.deepEqual(cacheBodyFields({ baseUrl: 'http://x/v1', server: 'vllm' }, undefined, { key: 'a' }, false), {});
  assert.deepEqual(cacheBodyFields({ baseUrl: 'http://x/v1', server: 'llamacpp' }, undefined, { key: 'a', primary: true }, false), { cache_prompt: true }, 'no slot count → no id_slot (an out-of-range id is an error)');
  assert.deepEqual(cacheBodyFields({ baseUrl: 'http://x/v1', server: 'llamacpp', llamacpp: { cachePrompt: false, slots: 4 } }, undefined, { key: 'a', primary: true }, false), { cache_prompt: false }, 'the A/B arm sends cache_prompt:false explicitly');
  // slot table: primaries count up from 0, others (subagents, aux) down from the last slot; stable per key
  assert.equal(slotFor('http://y/v1', 3, { key: 'main1', primary: true }), 0);
  assert.equal(slotFor('http://y/v1', 3, undefined), 2, 'aux');
  assert.equal(slotFor('http://y/v1', 3, { key: 'sub1' }), 1);
  assert.equal(slotFor('http://y/v1', 3, { key: 'main1', primary: true }), 0, 'stable');
  assert.equal(slotFor('http://y/v1/', 3, { key: 'sub1' }), 1, 'same server, trailing slash');

  // passive detection: a reply with llama.cpp timings switches cache_prompt on for the next calls
  const srv = await cacheMock(() => ({ content: 'ok', timings: { prompt_n: 10, cache_n: 90 } }));
  const c = new LLMClient(resolveProfile(testConfig(srv.url)));
  const r1 = await c.complete({ messages: [{ role: 'user', content: 'hi' }] });
  await c.complete({ messages: [{ role: 'user', content: 'hi' }] });
  await srv.close();
  assert.equal(r1.usage.cachedTokens, 90);
  assert.equal(srv.requests[0].cache_prompt, undefined);
  assert.equal(srv.requests[1].cache_prompt, true);

  // a server that rejects id_slot keeps working without it
  const bad = await cacheMock((b) => (b.id_slot !== undefined ? { status: 400, errorBody: '{"error":{"message":"invalid id_slot: 7"}}' } : { content: 'ok' }));
  const p = resolveProfile(testConfig(bad.url, { profiles: { default: { server: 'llamacpp', llamacpp: { slots: 8 } } } }));
  const c2 = new LLMClient(p);
  const r = await c2.complete({ messages: [{ role: 'user', content: 'hi' }], cacheSlot: { key: 'k', primary: true } });
  await c2.complete({ messages: [{ role: 'user', content: 'again' }], cacheSlot: { key: 'k', primary: true } });
  await bad.close();
  assert.equal(r.text, 'ok');
  assert.deepEqual(bad.requests.map((b) => b.id_slot), [0, undefined, undefined]);
  assert.ok(bad.requests.every((b) => b.cache_prompt === true));
});

test('N10 AC2: the probe detects llama.cpp from /props and the cached capabilities give the agent its slot count', async () => {
  const srv = await cacheMock(() => ({ content: 'OK', usage: { prompt_tokens_details: { cached_tokens: 0 } } }), { total_slots: 4, default_generation_settings: {}, build_info: 'b9999' });
  const cfg = testConfig(srv.url);
  const profile = resolveProfile(cfg);
  const r = await probeEndpoint(profile);
  await srv.close();
  assert.equal(r.server, 'llamacpp');
  assert.equal(r.slots, 4);
  assert.equal(r.cacheReported, true);
  writeCapabilities(cfg.homeDir, profile, r);
  const tuned = profileWithCapabilities(profile, cfg.homeDir);
  assert.equal(tuned.server, 'llamacpp');
  assert.equal(tuned.llamacpp?.slots, 4);
  const explicit = profileWithCapabilities({ ...profile, toolMode: 'native', llamacpp: { slots: 2 } }, cfg.homeDir);
  assert.equal(explicit.llamacpp?.slots, 2, 'explicit profile keys win');
  assert.equal(explicit.toolMode, 'native');
  // a non-llama.cpp server: /props is a 404
  const other = await cacheMock(() => ({ content: 'OK' }));
  const r2 = await probeEndpoint(resolveProfile(testConfig(other.url)));
  await other.close();
  assert.equal(r2.server, undefined);
  assert.equal(r2.cacheReported, false);
});

// ------------------------------------------------------------------ AC3: prefix guard

function breaks(events: AgentEvent[]) {
  return events.filter((e): e is Extract<AgentEvent, { type: 'cache_break' }> => e.type === 'cache_break');
}

test('N10 AC3: a normal 10-turn loop produces no cache_break', async () => {
  const ws = tmpWorkspace({});
  const srv = await cacheMock((body) => {
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n < 9 ? { toolCalls: [{ name: 'note', arguments: { n } }] } : { content: 'finished' };
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: [noteTool()], ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('do ten steps');
  await srv.close();
  assert.equal(res.stats.turns, 10);
  assert.equal(breaks(events).length, 0, JSON.stringify(breaks(events)));
  // and the requests really share their prefix: each one extends the previous
  for (let i = 1; i < srv.requests.length; i++) {
    assert.equal(JSON.stringify(srv.requests[i].messages[0]), JSON.stringify(srv.requests[0].messages[0]));
    assert.equal(JSON.stringify(srv.requests[i].tools), JSON.stringify(srv.requests[0].tools));
    assert.equal(JSON.stringify(srv.requests[i].messages.slice(0, srv.requests[i - 1].messages.length)), JSON.stringify(srv.requests[i - 1].messages));
  }
});

test('N10 AC3: changing the system prompt mid-run produces exactly one cache_break naming its cause', async () => {
  const ws = tmpWorkspace({});
  const switchMode: ToolDef = { name: 'switch_mode', kind: 'meta', description: 'Switch the permission mode.', parameters: { type: 'object', properties: {} }, title: () => 'switch', run: async (_a, ctx) => (ctx.setMode('acceptEdits'), { output: 'mode switched' }) };
  const srv = await cacheMock((body) => {
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n === 2) return { toolCalls: [{ name: 'switch_mode', arguments: {} }] };
    return n < 6 ? { toolCalls: [{ name: 'note', arguments: { n } }] } : { content: 'finished' };
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: [noteTool(), switchMode], ui: { onEvent: (e) => events.push(e) } });
  await agent.run('go');
  await srv.close();
  const b = breaks(events);
  assert.equal(b.length, 1, JSON.stringify(b));
  assert.deepEqual(b[0].causes, ['mode']);
  assert.deepEqual(b[0].scope, ['system']);
  assert.equal(b[0].turn, 4);
  assert.ok(b[0].invalidatedTokens > 0);
  assert.equal(cacheTallyFor(agent.sessionId)?.breaks, 1);
});

test('N10 AC3: causes are named for memory, overlay, tool order, added tools, model and history rewrites', () => {
  const tools = [{ name: 'a', description: 'A', parameters: {} }, { name: 'b', description: 'B', parameters: {} }];
  const prompt = (mem: string, note = '') => `You are X.\n\n# How to work\n- r\n\n# Environment\n- Workspace: /w\n- OS: linux 1 (x64); date: 2026-10-29\n- Model: m\n- not a git repository${note ? `\n\n# Model notes\n${note}` : ''}\n\n# Project instructions\n${mem}\n\nPermission mode: ask — x`;
  const msgs = (p: string, extra: ChatMessage[] = []): ChatMessage[] => [{ role: 'system', content: p }, { role: 'user', content: 'hi' }, ...extra];
  const base = takeSnapshot('m', msgs(prompt('use npm')), tools);
  assert.deepEqual([...systemSections(prompt('x', 'n')).keys()], ['mode', 'role', 'rules', 'environment', 'overlay', 'memory']);
  const d = (cur: ChatMessage[], t = tools, model = 'm', compacted = false) => diffSnapshots(base, takeSnapshot(model, cur, t), cur, t, compacted);
  assert.equal(d(msgs(prompt('use npm'))), undefined, 'identical → no break');
  assert.equal(d(msgs(prompt('use npm'), [{ role: 'assistant', content: 'ok' }])), undefined, 'appended history → no break');
  assert.deepEqual(d(msgs(prompt('use pnpm')))?.causes, ['memory']);
  assert.deepEqual(d(msgs(prompt('use npm', 'be brief')))?.causes, ['overlay']);
  assert.deepEqual(d(msgs(prompt('use npm')), [tools[1], tools[0]])?.causes, ['tool order']);
  assert.match(d(msgs(prompt('use npm')), [...tools, { name: 'c', description: 'C', parameters: {} }])!.detail, /tools added: c/);
  assert.deepEqual(d(msgs(prompt('use npm')), [tools[0], { ...tools[1], description: 'B2' }])?.causes, ['tool schema']);
  assert.deepEqual(d(msgs(prompt('use npm')), tools, 'other')?.causes, ['model']);
  const rewritten = [{ role: 'system', content: prompt('use npm') }, { role: 'user', content: 'HELLO' }] as ChatMessage[];
  assert.deepEqual(d(rewritten)?.causes, ['history rewrite']);
  assert.deepEqual(d(rewritten, tools, 'm', true)?.causes, ['compaction']);
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test('N10 prefix guard: across runs the system prompt stays byte-identical when only the git status changed; the update rides on the user message', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\n' });
  git(ws, 'init', '-q');
  git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(ws, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const srv = await cacheMock(() => ({ content: 'ok' }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, ui: { onEvent: (e) => events.push(e) } });
  await agent.run('first');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'new file\n');
  await agent.run('second');
  await agent.run('third');
  // a real change (memory) uses the fresh prompt and is reported
  fs.mkdirSync(path.join(ws, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.tugline', 'MEMORY.md'), '# Memory\n\n- [fact] test-command: run `make check` (2026-10-29)\n');
  await agent.run('fourth');
  await srv.close();
  const [r1, r2, r3, r4] = srv.requests;
  assert.equal(r2.messages[0].content, r1.messages[0].content, 'system prompt kept byte-identical');
  assert.match(r1.messages[0].content, /0 changed file/);
  const u2 = String(r2.messages.at(-1).content);
  assert.match(u2, /^second/);
  assert.match(u2, /<environment_update>[\s\S]*1 changed file\(s\) \(\?\? b\.txt\)[\s\S]*<\/environment_update>/);
  assert.doesNotMatch(String(r3.messages.at(-1).content), /environment_update/, 'no repeat when nothing changed since the last update');
  assert.equal(JSON.stringify(r3.messages.slice(0, r2.messages.length)), JSON.stringify(r2.messages), 'history is append-only');
  assert.notEqual(r4.messages[0].content, r1.messages[0].content);
  assert.match(r4.messages[0].content, /make check/);
  const b = breaks(events);
  assert.equal(b.length, 1, JSON.stringify(b));
  assert.ok(b[0].causes.includes('memory'), JSON.stringify(b[0].causes));
});

test('N10 prefix guard (unit): the stabiliser keeps the old prompt only for volatile environment lines', () => {
  const p = (git: string, extra = '') => `Role\n\n# Environment\n- Workspace: /w\n- OS: linux 1 (x64); date: 2026-10-29\n- Model: m\n- git branch: main; ${git}\nrecent commits:\nabc init${extra}\n\nPermission mode: ask — x`;
  assert.ok(volatileEnvironment(p('0 changed file(s)')));
  const owner = {};
  assert.deepEqual(stabilizeSystemPrompt(owner, undefined, p('0 changed file(s)')), { system: p('0 changed file(s)') });
  const r = stabilizeSystemPrompt(owner, p('0 changed file(s)'), p('2 changed file(s)'));
  assert.equal(r.system, p('0 changed file(s)'));
  assert.match(r.note!, /2 changed file\(s\)/);
  assert.equal(stabilizeSystemPrompt(owner, p('0 changed file(s)'), p('2 changed file(s)')).note, undefined, 'shown once');
  const real = stabilizeSystemPrompt(owner, p('0 changed file(s)'), p('0 changed file(s)', '\n\n# Project instructions\nnew'));
  assert.equal(real.note, undefined);
  assert.match(real.system, /Project instructions/, 'a real change uses the fresh prompt');
  assert.equal(stabilizeSystemPrompt({}, p('a'), p('b'), false).system, p('b'), 'promptCache.stableEnvironment: false');
});

// ------------------------------------------------------------------ idle compaction

test('N10: at idle the agent compacts (no pending input), keeping the system prompt and tools byte-identical', async () => {
  const ws = tmpWorkspace({});
  const big = 'x'.repeat(3000);
  const srv = await cacheMock((body) => {
    if (sys(body).startsWith('You are compressing')) return { content: 'SUMMARY of the earlier work' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n < 4 ? { toolCalls: [{ name: 'bulk', arguments: { n } }] } : { content: 'done' };
  });
  const bulk: ToolDef = { name: 'bulk', kind: 'read', readOnly: true, description: 'Return a lot of text.', parameters: { type: 'object', properties: { n: { type: 'integer' } } }, title: () => 'bulk', run: async (a: any) => ({ output: `${a.n} ${big}` }) };
  const events: AgentEvent[] = [];
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP, agent: { repoMapTokens: 0, backgroundCompaction: false, maxTurns: 12 }, promptCache: { idleCompactMs: 20, idleCompactAt: 0.3 }, profiles: { default: { contextWindow: 16000, maxOutputTokens: 500 } } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, extraTools: [bulk], ui: { onEvent: (e) => events.push(e), askUser: async () => '' } });
  await agent.run('collect');
  const before = srv.requests.at(-1);
  assert.ok(!events.some((e) => e.type === 'compaction'), 'no compaction during the run (below the in-run threshold)');
  for (let i = 0; i < 100 && !events.some((e) => e.type === 'compaction'); i++) await sleep(20);
  await idleCompactionInFlight(agent);
  const comp = events.find((e) => e.type === 'compaction') as Extract<AgentEvent, { type: 'compaction' }>;
  assert.ok(comp, 'compacted while idle');
  assert.ok(comp.afterTokens < comp.beforeTokens);
  assert.ok(events.some((e) => e.type === 'notice' && /idle: compacting/.test(e.message)));
  const n1 = srv.requests.length;
  const e1 = events.length;
  assert.deepEqual(breaks(events).map((x) => x.causes), [['tools added']], 'run 1: loading the deferred bulk tool is reported (D3 appends its schema)');
  await agent.run('next');
  await srv.close();
  const after = srv.requests[n1]; // the first call after the idle compaction
  // (bulk was a deferred tool activated by the run: the deferred listing in the system prompt must not change either)
  assert.equal(after.messages[0].content, before.messages[0].content, 'system prompt byte-identical');
  assert.equal(JSON.stringify(after.tools), JSON.stringify(before.tools), 'tool schemas byte-identical');
  assert.ok(JSON.stringify(after.messages).includes('SUMMARY of the earlier work'));
  assert.ok(JSON.stringify(after.messages).length < JSON.stringify(before.messages).length, 'the history is smaller');
  const b = breaks(events.slice(e1));
  assert.deepEqual(b.map((x) => x.causes), [['compaction']], 'after idle compaction the only prefix break is the compacted history, never system/tools');
  assert.deepEqual(b[0].scope, ['history']);
});

test('N10: idle compaction never runs while a prompt is pending, and a prompt arriving during it waits and is kept', async () => {
  const ws = tmpWorkspace({});
  const big = 'y'.repeat(3000);
  let summaries = 0;
  const srv = await cacheMock((body) => {
    if (sys(body).startsWith('You are compressing')) {
      summaries++;
      return { content: 'SUMMARY', delayMs: 300 };
    }
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    const last = String(body.messages.at(-1).content);
    if (/late prompt/.test(last)) return { content: 'answered the late prompt' };
    return n < 4 ? { toolCalls: [{ name: 'bulk', arguments: { n } }] } : { content: 'done' };
  });
  const bulk: ToolDef = { name: 'bulk', kind: 'read', readOnly: true, description: 'Return a lot of text.', parameters: { type: 'object', properties: { n: { type: 'integer' } } }, title: () => 'bulk', run: async (a: any) => ({ output: `${a.n} ${big}` }) };
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, maxTurns: 12 }, promptCache: { idleCompactMs: 10, idleCompactAt: 0.3 }, profiles: { default: { contextWindow: 16000, maxOutputTokens: 500 } } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, extraTools: [bulk], ui: { askUser: async () => '' } });
  await agent.run('collect');
  for (let i = 0; i < 100 && !idleCompactionInFlight(agent); i++) await sleep(5);
  assert.ok(idleCompactionInFlight(agent), 'idle compaction started');
  const res = await agent.run('late prompt');
  await srv.close();
  assert.equal(res.finalText, 'answered the late prompt');
  const req = srv.requests.at(-1);
  assert.match(JSON.stringify(req.messages), /SUMMARY/, 'the run waited for the compaction');
  assert.match(String(req.messages.at(-1).content), /late prompt/, 'the new prompt survived the swap');
  assert.equal(summaries, 1);
});

test('N10: idle compaction is off with promptCache.idleCompaction false, for headless agents, and after dispose', async () => {
  const ws = tmpWorkspace({});
  const srv = await cacheMock((body) => (sys(body).startsWith('You are compressing') ? { content: 'S' } : { content: 'x'.repeat(20) }));
  const cfg = testConfig(srv.url, { ...NO_MAP, promptCache: { idleCompaction: false, idleCompactMs: 5, idleCompactAt: 0 }, profiles: { default: { contextWindow: 8000, maxOutputTokens: 500 } } });
  const events: AgentEvent[] = [];
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { onEvent: (e) => events.push(e), askUser: async () => '' } });
  await a.run('hi');
  await sleep(60);
  assert.ok(!events.some((e) => e.type === 'compaction'));
  // headless (no one to come back): eval, arena, schedules, `tug -p`
  const cfgH = testConfig(srv.url, { ...NO_MAP, promptCache: { idleCompactMs: 5, idleCompactAt: 0 } });
  const eventsH: AgentEvent[] = [];
  const h = await Agent.create({ workspace: ws, config: cfgH, mcp: false, ui: { onEvent: (e) => eventsH.push(e) } });
  await h.run('hi');
  await sleep(60);
  assert.ok(!eventsH.some((e) => e.type === 'compaction'), 'headless agents never compact at idle');
  // the same settings with an interactive UI do compact (so the check above is meaningful)
  const eventsI: AgentEvent[] = [];
  const i = await Agent.create({ workspace: ws, config: cfgH, mcp: false, ui: { onEvent: (e) => eventsI.push(e), askUser: async () => '' } });
  await i.run('hi');
  for (let k = 0; k < 50 && !eventsI.some((e) => e.type === 'compaction'); k++) await sleep(20);
  await idleCompactionInFlight(i);
  assert.ok(eventsI.some((e) => e.type === 'compaction'));
  const cfg2 = testConfig(srv.url, { ...NO_MAP, promptCache: { idleCompactMs: 40, idleCompactAt: 0 } });
  const events2: AgentEvent[] = [];
  const b = await Agent.create({ workspace: ws, config: cfg2, mcp: false, ui: { onEvent: (e) => events2.push(e), askUser: async () => '' } });
  await b.run('hi');
  await b.dispose();
  await sleep(80);
  await srv.close();
  assert.ok(!events2.some((e) => e.type === 'compaction'), 'disposed agents never compact');
});

// ------------------------------------------------------------------ review fix: idle compaction vs history replacement

test('N10 (review fix): /rewind, clear() and loadHistory() during an in-flight idle compaction are never undone by its swap', async () => {
  const big = 'z'.repeat(3000);
  let summaryRequests = 0;
  const srv = await cacheMock((body) => {
    if (sys(body).startsWith('You are compressing')) {
      summaryRequests++;
      return { content: 'SUMMARY', delayMs: 800 };
    }
    const last = String(body.messages.at(-1)?.content ?? '');
    if (/after replace/.test(last)) return { content: 'fresh answer' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    return n < 4 ? { toolCalls: [{ name: 'bulk', arguments: { n } }] } : { content: 'done' };
  });
  const bulk: ToolDef = { name: 'bulk', kind: 'read', readOnly: true, description: 'Return a lot of text.', parameters: { type: 'object', properties: { n: { type: 'integer' } } }, title: () => 'bulk', run: async (a: any) => ({ output: `${a.n} ${big}` }) };
  const setup = async () => {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, maxTurns: 12 }, promptCache: { idleCompactMs: 10, idleCompactAt: 0.3 }, profiles: { default: { contextWindow: 16000, maxOutputTokens: 500 } } });
    const events: AgentEvent[] = [];
    const agent = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false, extraTools: [bulk], ui: { onEvent: (e) => events.push(e), askUser: async () => '' } });
    await agent.run('collect');
    for (let i = 0; i < 200 && !idleCompactionInFlight(agent); i++) await sleep(5);
    assert.ok(idleCompactionInFlight(agent), 'idle compaction in flight');
    return { agent, events };
  };
  const settle = async (agent: Agent) => {
    await idleCompactionInFlight(agent);
    await agent.compactionSettled();
  };

  // 1. /rewind (truncateTo)
  {
    const { agent, events } = await setup();
    const keepN = 4; // system, user, assistant(call), tool
    const removed = agent.truncateTo(keepN);
    const after = JSON.stringify(agent.messages);
    assert.ok(removed.length > 0);
    await settle(agent);
    assert.equal(JSON.stringify(agent.messages), after, 'the rewound history stays rewound');
    assert.ok(!events.some((e) => e.type === 'compaction'), 'the compaction was discarded');
    assert.match(String(agent.messages[3].content), /zzzz/, 'kept tool output was not cleared in place by the discarded compaction');
    await agent.dispose();
  }
  // 2. clear() (new chat)
  {
    const { agent, events } = await setup();
    agent.clear();
    await settle(agent);
    assert.equal(agent.messages.length, 0, 'the new chat stays empty');
    assert.ok(!events.some((e) => e.type === 'compaction'));
    const res = await agent.run('after replace');
    assert.equal(res.finalText, 'fresh answer');
    assert.ok(!JSON.stringify(agent.messages).includes('collect'), 'the old chat never comes back');
    await agent.dispose();
  }
  // 3. loadHistory() (resume another session)
  {
    const { agent } = await setup();
    agent.loadHistory([{ role: 'user', content: 'OTHER SESSION' }, { role: 'assistant', content: 'ok' }]);
    await settle(agent);
    const text = JSON.stringify(agent.messages);
    assert.ok(text.includes('OTHER SESSION'), 'the resumed session is kept');
    assert.ok(!text.includes('collect') && !text.includes('SUMMARY'), 'nothing of the old session is swapped back in');
    await agent.dispose();
  }
  await srv.close();
  assert.ok(summaryRequests <= 3, 'each cancelled compaction made at most one summary request');
});

test('N10 (review fix): a compaction outside a run still swaps when the history was only appended to', async () => {
  const ws = tmpWorkspace({});
  const srv = await cacheMock((body) => (sys(body).startsWith('You are compressing') ? { content: 'SUMMARY', delayMs: 300 } : { content: 'x'.repeat(2000) }));
  const cfg = testConfig(srv.url, { ...NO_MAP, agent: { repoMapTokens: 0, backgroundCompaction: false }, promptCache: { idleCompaction: false }, profiles: { default: { contextWindow: 12000 } } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  for (const p of ['one', 'two', 'three', 'four']) await agent.run(p);
  assert.ok(!JSON.stringify(agent.messages).includes('SUMMARY'), 'no compaction during the runs');
  const p = agent.compactNow(true);
  // a run started meanwhile waits for the compaction, and its prompt survives the swap
  const res = await agent.run('five');
  await p;
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  const text = JSON.stringify(agent.messages);
  assert.ok(text.includes('SUMMARY'), 'the compaction applied');
  assert.ok(text.includes('five'), 'the later prompt is kept');
  assert.equal(agent.messages[0].role, 'system');
});
