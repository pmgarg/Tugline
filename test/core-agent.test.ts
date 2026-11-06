/** WS4 agent-loop features: D1 parallel subagents, D3 tool search, D8 background compaction, D10 routing, D12 steering/queue/truncate. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, messageSequenceProblems } from '../src/core/agent/agent.js';
import type { ToolDef } from '../src/core/tools/types.js';
import type { AgentEvent, ChatMessage } from '../src/core/types.js';
import { estimateTokens } from '../src/core/util/text.js';
import { bm25Rank } from '../src/core/tools/search.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const sys = (body: any) => String(body.messages[0].content);
const NO_MAP = { agent: { repoMapTokens: 0 } };

// ------------------------------------------------------------------ D3

function mockMcpTools(n: number): ToolDef[] {
  const tools: ToolDef[] = [];
  for (let i = 0; i < n; i++) {
    const weather = i === 17;
    const name = weather ? 'mcp__mock__get_weather' : `mcp__mock__op_${i}`;
    tools.push({
      name,
      kind: 'mcp',
      mcpServer: 'mock',
      description: weather ? 'Get the current weather forecast for a city.' : `Operation number ${i} of the mock server: does an internal bookkeeping step with records, ledgers and audit entries.`,
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'record identifier' }, note: { type: 'string', description: 'free text note for the audit trail' }, limit: { type: 'integer' } }, required: ['id'] },
      title: () => name,
      run: async (a: any) => ({ output: weather ? `sunny in ${a.city ?? a.id}` : 'ok' }),
    });
  }
  return tools;
}

test('D3 AC1+AC2+AC3: 50 MCP tools are deferred; tool_search activates weather at the END of the list; it persists across runs', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'tool_search', arguments: { query: 'weather' } }] };
    if (i === 1) return { toolCalls: [{ name: 'mcp__mock__get_weather', arguments: { id: 'Dubai' } }] };
    return { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: mockMcpTools(50) });
  await agent.run('what is the weather in Dubai?');
  await agent.run('and again?');
  await srv.close();
  const first = toolNames(srv.requests[0]);
  assert.ok(first.length <= 20, `first request sends ${first.length} tools`);
  assert.ok(first.includes('tool_search') && !first.includes('mcp__mock__get_weather'));
  assert.match(sys(srv.requests[0]), /# Deferred tools[\s\S]*MCP server mock: .*get_weather/);
  const second = toolNames(srv.requests[1]);
  assert.equal(second.at(-1), 'mcp__mock__get_weather', 'activated tool is appended at the end');
  assert.deepEqual(second.slice(0, first.length), first, 'tool prefix unchanged (prompt cache)');
  assert.match(lastToolResult(srv.requests[2]), /sunny in Dubai/);
  // AC3: the next run still has it
  assert.ok(toolNames(srv.requests[3]).includes('mcp__mock__get_weather'));
  assert.equal(sys(srv.requests[0]), sys(srv.requests[1]), 'system prompt byte-stable within the run');
});

test('D3 AC4: deferring 50 MCP tools costs < 2k prompt tokens (vs > 5k when sent in full)', async () => {
  const ws = tmpWorkspace({});
  const measure = async (extra: ToolDef[], over: any = {}) => {
    const srv = await startMockServer(() => ({ content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, ...over }), mcp: false, extraTools: extra });
    await agent.run('hi');
    await srv.close();
    const b = srv.requests[0];
    return estimateTokens(JSON.stringify(b.tools ?? [])) + estimateTokens(sys(b));
  };
  const base = await measure([]);
  const deferred = await measure(mockMcpTools(50));
  const full = await measure(mockMcpTools(50), { agent: { toolSearch: 'off', repoMapTokens: 0 } });
  assert.ok(deferred - base < 2000, `deferred delta ${deferred - base} tokens`);
  assert.ok(full - base > 5000, `full delta ${full - base} tokens`);
});

test('D3: calling a listed deferred tool by name loads it; BM25 ranks name hits first', async () => {
  const ranked = bm25Rank([{ name: 'browser_click', description: 'click an element' }, { name: 'get_weather', description: 'weather forecast' }, { name: 'desktop_type', description: 'type text' }], 'weather', 3);
  assert.equal(ranked[0].doc.name, 'get_weather');
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'mcp__mock__op_3', arguments: { id: 'x' } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: mockMcpTools(30) });
  await agent.run('go');
  await srv.close();
  assert.equal(lastToolResult(srv.requests[1]), 'ok');
  assert.equal(toolNames(srv.requests[1]).at(-1), 'mcp__mock__op_3');
});

// ------------------------------------------------------------------ D1

function slowLookup(spans: { start: number; end: number }[]): ToolDef {
  return {
    name: 'slow_lookup',
    kind: 'read',
    readOnly: true,
    description: 'slow read-only lookup',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    title: () => 'slow lookup',
    async run(a: any) {
      const s = { start: Date.now(), end: 0 };
      await sleep(400);
      s.end = Date.now();
      spans.push(s);
      return { output: `found ${a.q}` };
    },
  };
}

test('D1 AC1+AC2: three explore tasks in one turn overlap in time and their stats are merged', async () => {
  const ws = tmpWorkspace({});
  const spans: { start: number; end: number }[] = [];
  const srv = await startMockServer((body) => {
    if (sys(body).startsWith('You are a fast, read-only')) {
      const q = String(body.messages[1].content).match(/topic (\w+)/)?.[1];
      if (!body.messages.some((m: any) => m.role === 'tool')) return { toolCalls: [{ name: 'slow_lookup', arguments: { q } }] };
      return { content: `report on ${q}` };
    }
    if (!body.messages.some((m: any) => m.role === 'tool'))
      return { toolCalls: ['a', 'b', 'c'].map((t) => ({ name: 'task', arguments: { agent_type: 'explore', description: `look ${t}`, prompt: `Research topic ${t}` } })) };
    return { content: 'all done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: [slowLookup(spans)] });
  const res = await agent.run('research a, b and c');
  await srv.close();
  assert.equal(spans.length, 3);
  const maxStart = Math.max(...spans.map((s) => s.start));
  const minEnd = Math.min(...spans.map((s) => s.end));
  assert.ok(maxStart < minEnd, `the three subagents ran concurrently (last start ${maxStart} < first end ${minEnd})`);
  const toolMsgs = srv.requests.at(-1).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
  assert.deepEqual(toolMsgs.map((t: string) => t.match(/report on (\w)/)?.[1]), ['a', 'b', 'c'], 'results keep call order');
  // main: 2 calls; each child: 2 calls → 8; child tool calls (3) + main task calls (3)
  assert.equal(res.stats.llmCalls, 8);
  assert.equal(res.stats.toolCalls, 6);
  assert.equal(res.stats.promptTokens, srv.requests.reduce((a: number, _b: any, i: number) => a + 100 + i, 0));
});

test('D1: maxParallelSubagents bounds concurrency', async () => {
  const ws = tmpWorkspace({});
  const spans: { start: number; end: number }[] = [];
  const srv = await startMockServer((body) => {
    if (sys(body).startsWith('You are a fast, read-only')) return body.messages.some((m: any) => m.role === 'tool') ? { content: 'r' } : { toolCalls: [{ name: 'slow_lookup', arguments: { q: 'x' } }] };
    if (!body.messages.some((m: any) => m.role === 'tool')) return { toolCalls: [1, 2, 3].map((n) => ({ name: 'task', arguments: { agent_type: 'explore', description: `t${n}`, prompt: `p${n}` } })) };
    return { content: 'ok' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { maxParallelSubagents: 1, repoMapTokens: 0 } }), mcp: false, extraTools: [slowLookup(spans)] });
  await agent.run('go');
  await srv.close();
  spans.sort((a, b) => a.start - b.start);
  assert.ok(spans[1].start >= spans[0].end && spans[2].start >= spans[1].end, 'serialised with maxParallelSubagents=1');
});

test('D1 AC3+AC4: background subagent returns a handle; task_result collects it; depth stays 1', async () => {
  const ws = tmpWorkspace({});
  let childTools: string[] = [];
  const srv = await startMockServer((body) => {
    if (sys(body).startsWith('You are a subagent handling')) {
      childTools = toolNames(body);
      return { content: 'background work finished: 7 files' };
    }
    const tools = body.messages.filter((m: any) => m.role === 'tool');
    if (tools.length === 0) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'general', description: 'count files', prompt: 'count', run_in_background: true } }] };
    if (tools.length === 1) {
      const handle = String(tools[0].content).match(/(task_\w+)/)![1];
      return { toolCalls: [{ name: 'task_result', arguments: { handle, wait_ms: 5000 } }] };
    }
    return { content: 'got it' };
  });
  // v1.2 N18: nesting is configurable (agent.maxDepth, default 2); this test keeps the depth-1 configuration
  const cfg1 = testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP });
  cfg1.agent.maxDepth = 1;
  const agent = await Agent.create({ workspace: ws, config: cfg1, mcp: false });
  const res = await agent.run('go');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  const first = srv.requests.find((b: any) => !sys(b).startsWith('You are a subagent') && b.messages.some((m: any) => m.role === 'tool'));
  assert.match(lastToolResult(first), /Started background subagent task_\w+/);
  assert.ok(toolNames(first).includes('task_result'), 'task_result is activated by a background task');
  assert.ok(!toolNames(srv.requests[0]).includes('task_result'), 'and hidden before');
  assert.match(lastToolResult(srv.requests.at(-1)), /finished:\nbackground work finished: 7 files/);
  assert.ok(!childTools.includes('task') && !childTools.includes('task_result'), 'subagents cannot spawn subagents at agent.maxDepth 1');
});

// ------------------------------------------------------------------ D10

test('D10 AC1: each role uses its own profile (mock server per profile); usage events carry the role', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const mk = (tag: string) => startMockServer((body) => {
    if (tag === 'main') {
      const n = body.messages.filter((m: any) => m.role === 'tool').length;
      if (n === 0) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'look', prompt: 'look around' } }] };
      return { content: 'main done' };
    }
    if (tag === 'summarizer') return { content: '## User requests\n> go\n## Progress so far\nsummarised' };
    return { content: `${tag} reply` };
  });
  const servers = Object.fromEntries(await Promise.all(['main', 'planner', 'explore', 'summarizer', 'approver', 'editor'].map(async (t) => [t, await mk(t)] as const)));
  const prof = (t: string) => ({ baseUrl: servers[t].url, model: `${t}-model`, apiKey: 'sk-test-1234567890abcdef', toolMode: 'native' });
  const cfg = testConfig(servers.main.url, {
    permissionMode: 'yolo',
    ...NO_MAP,
    profiles: { p_plan: prof('planner'), p_explore: prof('explore'), p_sum: prof('summarizer'), p_appr: prof('approver'), p_edit: prof('editor') },
    routing: { planner: 'p_plan', explore: 'p_explore', summarizer: 'p_sum', approver: 'p_appr', editor: 'p_edit' },
  });
  const usage: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { onEvent: (e) => e.type === 'usage' && usage.push(e) } });
  await agent.run('go');
  await agent.completeAs('approver', { messages: [{ role: 'user', content: 'classify' }] });
  await agent.completeAs('editor', { messages: [{ role: 'user', content: 'apply' }] });
  await agent.summarizeUpTo(agent.messages.length - 1);
  agent.setMode('plan');
  await agent.run('plan something');
  for (const s of Object.values(servers)) await s.close();
  assert.equal(servers.main.requests.length, 2, 'main loop on the main profile');
  assert.equal(servers.explore.requests.length, 1);
  assert.equal(servers.explore.requests[0].model, 'explore-model');
  assert.equal(servers.summarizer.requests.length, 1);
  assert.equal(servers.approver.requests.length, 1);
  assert.equal(servers.editor.requests.length, 1);
  assert.equal(servers.planner.requests.length, 1, 'plan mode uses the planner profile');
  const roles = new Set(usage.map((e: any) => e.role));
  for (const r of ['main', 'explore', 'summarizer', 'approver', 'editor', 'planner']) assert.ok(roles.has(r), `usage tagged ${r}`);
});

// ------------------------------------------------------------------ D8

test('D8 AC1: at the threshold the background-precomputed summary is swapped in (no extra blocking call)', async () => {
  const ws = tmpWorkspace({});
  const sumSrv = await startMockServer(() => ({ content: '## User requests\n> fetch the five blobs\n## Progress so far\nfetched blobs 1-3' }));
  let n = 0;
  const main = await startMockServer((body) => {
    const tools = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n++ < 7 && tools < 7) return { toolCalls: [{ name: 'blob', arguments: { i: n } }] };
    return { content: 'finished' };
  });
  const blob: ToolDef = { name: 'blob', kind: 'read', readOnly: true, description: 'blob', parameters: { type: 'object', properties: { i: { type: 'integer' } } }, title: () => 'blob', run: async (a: any) => ({ output: `blob ${a.i}\n` + `data-${a.i} `.repeat(1000) }) };
  const cfg = testConfig(main.url, { permissionMode: 'yolo', profiles: { default: { contextWindow: 16000, maxOutputTokens: 1000 }, sum: { baseUrl: sumSrv.url, model: 's', apiKey: 'sk-test-1234567890abcdef', toolMode: 'native' } }, routing: { summarizer: 'sum' }, agent: { repoMapTokens: 0, promptStyle: 'compact' } });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, extraTools: [blob], ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('fetch the five blobs');
  await main.close();
  await sumSrv.close();
  assert.equal(res.finalText, 'finished');
  const comp = events.filter((e) => e.type === 'compaction') as any[];
  assert.ok(comp.length >= 1, 'compaction happened');
  assert.equal(comp[0].strategy, 'precomputed-summary');
  assert.equal(sumSrv.requests.length, comp.filter((c) => c.strategy === 'precomputed-summary').length, 'one summariser call per swap, made in the background before the threshold');
  const text = JSON.stringify(main.requests.at(-1).messages);
  assert.ok(text.includes('fetched blobs 1-3') && text.includes('fetch the five blobs'));
  assert.deepEqual(messageSequenceProblems(agent.messages), []);
});

test('D8 AC2: summarizeUpTo keeps later messages verbatim', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((body, i) => {
    if (sys(body).startsWith('You are compressing')) return { content: 'SUMMARY OF EARLY WORK' };
    return i % 2 === 0 ? { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] } : { content: `answer ${i}` };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false });
  await agent.run('one');
  await agent.run('two');
  await agent.run('three');
  const idx = agent.messages.findIndex((m) => m.role === 'user' && m.content === 'three');
  const tail = structuredClone(agent.messages.slice(idx));
  await agent.summarizeUpTo(idx);
  await srv.close();
  assert.equal(agent.messages[0].role, 'system');
  assert.match(String(agent.messages[1].content), /SUMMARY OF EARLY WORK/);
  assert.deepEqual(agent.messages.slice(2), tail);
  assert.deepEqual(messageSequenceProblems(agent.messages), []);
});

// ------------------------------------------------------------------ D12

test('D12 AC1: a steer sent during a long tool call appears in the next request', async () => {
  const ws = tmpWorkspace({});
  let agent!: Agent;
  const slow: ToolDef = { name: 'slow_tool', kind: 'read', readOnly: true, description: 'slow', parameters: { type: 'object', properties: {} }, title: () => 'slow', run: async () => (await sleep(300), { output: 'slow done' }) };
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'slow_tool', arguments: {} }] } : { content: 'ok' }));
  const events: AgentEvent[] = [];
  agent = await Agent.create({
    workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, extraTools: [slow],
    ui: { onEvent: (e) => { events.push(e); if (e.type === 'tool_start' && e.name === 'slow_tool') agent.steer('also check the README'); } },
  });
  const res = await agent.run('start');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(srv.requests.length, 2, 'the steer did not start another run');
  const msgs = srv.requests[1].messages;
  assert.equal(msgs.at(-2).role, 'tool');
  assert.deepEqual([msgs.at(-1).role, msgs.at(-1).content], ['user', '[user steer] also check the README']);
  assert.ok(events.some((e) => e.type === 'steer' && e.text === 'also check the README' && !e.queued));
});

test('D12 AC2: queued prompts run after the current run, in order', async () => {
  const ws = tmpWorkspace({});
  let agent!: Agent;
  const srv = await startMockServer((body) => ({ content: `did: ${body.messages.filter((m: any) => m.role === 'user').at(-1).content}` }));
  agent = await Agent.create({
    workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false,
    ui: { onEvent: (e) => { if (e.type === 'run_start' && e.prompt === 'first') { agent.enqueue('second'); agent.enqueue('third'); } } },
  });
  const finals: string[] = [];
  const unsub = (e: AgentEvent) => e.type === 'run_end' && finals.push(e.finalText);
  (agent.opts.ui as any).onEvent = ((orig) => (e: AgentEvent) => { orig(e); unsub(e); })((agent.opts.ui as any).onEvent);
  const r = await agent.run('first');
  assert.equal(r.finalText, 'did: first');
  await assert.rejects(agent.run('direct'), /already running/, 'queued prompts run before new direct runs');
  await agent.idle();
  await srv.close();
  assert.deepEqual(finals, ['did: first', 'did: second', 'did: third']);
  const users = srv.requests.at(-1).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
  assert.deepEqual(users, ['first', 'second', 'third']);
});

test('D12: a steer that arrives after the final LLM call becomes the next prompt', async () => {
  const ws = tmpWorkspace({});
  let agent!: Agent;
  const srv = await startMockServer((body) => ({ content: `re: ${body.messages.at(-1).content}` }));
  agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false, ui: { onEvent: (e) => { if (e.type === 'assistant_message' && e.text === 're: go') agent.steer('one more thing'); } } });
  await agent.run('go');
  await agent.idle();
  await srv.close();
  assert.equal(srv.requests.length, 2);
  assert.equal(srv.requests[1].messages.at(-1).content, '[user steer] one more thing');
});

test('D12 AC3: truncateTo leaves a valid message sequence at every cut point', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'A\n', 'b.txt': 'B\n' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }, { name: 'read_file', arguments: { path: 'b.txt' } }] };
    if (i === 1) return { content: 'read both' };
    if (i === 2) return { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] };
    return { content: 'listed' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false });
  await agent.run('read files');
  await agent.run('list');
  const snapshot: ChatMessage[] = agent.messages.slice();
  assert.ok(snapshot.length >= 9);
  for (let i = 0; i <= snapshot.length + 1; i++) {
    agent.messages = snapshot.slice();
    agent.truncateTo(i);
    assert.equal(agent.messages[0].role, 'system', `system kept at cut ${i}`);
    assert.deepEqual(messageSequenceProblems(agent.messages), [], `valid at cut ${i}`);
    assert.ok(agent.messages.length <= Math.max(1, i));
  }
  // cutting between the two tool results drops the whole exchange
  agent.messages = snapshot.slice();
  const ai = snapshot.findIndex((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) === 2);
  agent.truncateTo(ai + 2);
  assert.equal(agent.messages.length, ai);
  // and the conversation continues from there
  agent.messages = snapshot.slice();
  const userTwo = snapshot.findIndex((m) => m.role === 'user' && m.content === 'list');
  agent.truncateTo(userTwo);
  await agent.run('list again');
  await srv.close();
  const last = srv.requests.at(-1).messages.filter((m: any) => m.role === 'user').map((m: any) => m.content);
  assert.ok(!last.includes('list') && last.includes('list again'), 'edit-and-resubmit replaced the later prompt');
});
