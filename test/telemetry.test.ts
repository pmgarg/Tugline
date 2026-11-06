/**
 * SPEC H4: OpenTelemetry spans (WS8). In-memory exporter; GenAI semantic conventions.
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { Agent } from '../src/core/agent/agent.js';
import { localDate, readLedger, recordUsage, rootSession } from '../src/core/permissions/limits.js';
import { setTelemetryProvider, telemetryConfig } from '../src/core/telemetry/otel.js';
import type { AgentExtension } from '../src/core/agent/extensions.js';
import { startMockServer, testConfig, tmpWorkspace, type MockServer } from './helpers.js';

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const servers: MockServer[] = [];
after(async () => {
  setTelemetryProvider(undefined);
  for (const s of servers) await s.close();
  await provider.shutdown();
});
beforeEach(() => exporter.reset());

const SECRET_PROMPT = 'PROMPT-CONTENT-7f3a: look for the config loader';

/** main: task(explore) → read_file → answer; child: read_file → answer. */
function script(body: any) {
  const msgs = body.messages as any[];
  const isChild = msgs.some((m) => m.role === 'user' && String(m.content).includes('SUBTASK'));
  const tools = msgs.filter((m) => m.role === 'tool').length;
  if (isChild) return tools === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'sub: a.txt holds hello' };
  if (tools === 0) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'look around', prompt: 'SUBTASK read a.txt' } }] };
  if (tools === 1) return { toolCalls: [{ name: 'read_file', arguments: { path: 'missing.txt' } }] };
  return { content: 'All done: the loader is in a.txt.' };
}

async function runTraced(over: any = {}, extensions: AgentExtension[] = []) {
  const ws = tmpWorkspace({ 'a.txt': 'hello\n' });
  const srv = await startMockServer(script);
  servers.push(srv);
  const cfg = testConfig(srv.url, { profiles: { default: { pricing: { inputPerM: 3, outputPerM: 15 } } }, permissionMode: 'yolo', agent: { requireVerification: false }, telemetry: { enabled: true }, ...over });
  setTelemetryProvider(provider);
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, extensions });
  const res = await agent.run(SECRET_PROMPT);
  await agent.dispose();
  return { res, cfg, agent, srv, spans: exporter.getFinishedSpans() };
}

const parentId = (s: any): string | undefined => s.parentSpanContext?.spanId ?? s.parentSpanId;
const idOf = (s: any): string => s.spanContext().spanId;

test('H4 AC1: span tree run → turn → llm.call / tool.call, a subagent run nests under its task span, GenAI attributes', async () => {
  // ws3-limits (C7 ledger) is registered by importing limits.js above.
  const { res, spans, srv } = await runTraced();
  assert.equal(res.stopReason, 'end_turn');
  const byName = (n: string) => spans.filter((s: any) => s.name === n);
  const runs = byName('run');
  assert.equal(runs.length, 2, 'main run + subagent run');
  const main = runs.find((s: any) => s.attributes['tugline.depth'] === 0)!;
  const child = runs.find((s: any) => s.attributes['tugline.depth'] === 1)!;
  assert.equal(parentId(main), undefined, 'the main run is the root');
  assert.equal(main.attributes['gen_ai.operation.name'], 'invoke_agent');
  assert.equal(main.attributes['gen_ai.request.model'], 'mock-model');
  assert.equal(main.attributes['tugline.stop_reason'], 'end_turn');
  // turns are children of the run
  const mainTurns = byName('turn').filter((t: any) => parentId(t) === idOf(main));
  assert.equal(mainTurns.length, 3);
  // every llm.call sits in a turn; there is one per model request
  const llm = byName('llm.call');
  assert.equal(llm.length, srv.requests.length);
  const turnIds = new Set(byName('turn').map(idOf));
  assert.ok(llm.every((s: any) => turnIds.has(parentId(s)!)), 'llm.call spans are children of turns');
  for (const s of llm) {
    assert.equal(s.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(s.attributes['gen_ai.request.model'], 'mock-model');
    assert.equal(s.attributes['gen_ai.provider.name'], 'openai');
    assert.equal(s.attributes['gen_ai.usage.output_tokens'], 20);
    assert.ok(Number(s.attributes['gen_ai.usage.input_tokens']) >= 100);
    assert.ok(Number(s.attributes['tugline.cost_usd']) > 0);
    assert.equal(s.attributes['server.address'], '127.0.0.1');
  }
  assert.deepEqual(llm.map((s: any) => s.attributes['tugline.role']).sort(), ['explore', 'explore', 'main', 'main', 'main']);
  // tool.call spans: name, outcome, duration
  const tools = byName('tool.call');
  const task = tools.find((s: any) => s.attributes['gen_ai.tool.name'] === 'task')!;
  assert.equal(task.attributes['gen_ai.operation.name'], 'execute_tool');
  assert.equal(task.attributes['tugline.tool.outcome'], 'ok');
  assert.equal(typeof task.attributes['tugline.tool.duration_ms'], 'number');
  assert.equal(parentId(child), idOf(task), 'the subagent run nests under the task tool span');
  const failed = tools.find((s: any) => s.attributes['gen_ai.tool.name'] === 'read_file' && s.attributes['tugline.tool.outcome'] === 'error');
  assert.ok(failed, 'the missing-file read is an error outcome');
  assert.equal(failed!.status.code, 2);
  const childRead = tools.find((s: any) => s.attributes['gen_ai.tool.name'] === 'read_file' && s.attributes['tugline.tool.outcome'] === 'ok')!;
  const childTurnIds = new Set(byName('turn').filter((t: any) => parentId(t) === idOf(child)).map(idOf));
  assert.ok(childTurnIds.has(parentId(childRead)!), "the child's tool call is inside the child's turn");
  // one trace for everything
  assert.equal(new Set(spans.map((s: any) => s.spanContext().traceId)).size, 1);
});

test('H4 AC1: content is excluded by default (no prompt, arguments, output or messages on any span); includeContent opts in', async () => {
  const { spans } = await runTraced();
  const all = JSON.stringify(spans.map((s: any) => ({ n: s.name, a: s.attributes, e: s.events })));
  assert.ok(!all.includes('PROMPT-CONTENT-7f3a'), 'prompt text absent');
  assert.ok(!all.includes('SUBTASK'), 'tool arguments absent');
  assert.ok(!all.includes('hello'), 'tool output absent');
  assert.ok(!all.includes('All done'), 'final text absent');
  assert.ok(!/gen_ai\.(input|output)\.messages|gen_ai\.tool\.call\.(arguments|result)/.test(all));
  exporter.reset();
  const { spans: withContent } = await runTraced({ telemetry: { enabled: true, includeContent: true } });
  const all2 = JSON.stringify(withContent.map((s: any) => s.attributes));
  assert.ok(all2.includes('PROMPT-CONTENT-7f3a'));
  assert.ok(all2.includes('gen_ai.tool.call.arguments'));
});

test('H4 AC2: the span cost sum equals the C7 ledger cost for the run (difference zero), subagent and approver calls included', async () => {
  // Simulate classifier-approver spend (C3 writes it straight to the ledger, not as a usage event).
  const approverLike: AgentExtension = {
    id: 'test-approver-spend',
    depths: [0],
    afterTool(a) {
      recordUsage(a.config.homeDir, { ts: new Date().toISOString(), session: rootSession(a.sessionId), run: a.runId, depth: a.depth, model: 'judge-small', promptTokens: 50, completionTokens: 5, costUsd: 0.000321, kind: 'approver' });
    },
  };
  const { spans, cfg, agent, res } = await runTraced({}, [approverLike]);
  const ledger = readLedger(cfg.homeDir, localDate()).filter((l) => l.session === agent.sessionId);
  const llm = spans.filter((s: any) => s.name === 'llm.call');
  assert.equal(llm.length, ledger.length, 'one llm.call span per ledger line');
  const approverLines = ledger.filter((l) => l.kind === 'approver').length;
  assert.ok(approverLines >= 1);
  assert.equal(llm.filter((s: any) => s.attributes['tugline.role'] === 'approver').length, approverLines, 'approver calls back-filled');
  const spanCost = llm.reduce((s: number, x: any) => s + Number(x.attributes['tugline.cost_usd']), 0);
  const ledgerCost = ledger.reduce((s, l) => s + l.costUsd, 0);
  assert.ok(spanCost > 0);
  assert.ok(Math.abs(spanCost - ledgerCost) < 1e-12, `span ${spanCost} vs ledger ${ledgerCost}`);
  // token totals reconcile too, and the run span's own total equals the model spend of the run
  const tok = (k: string) => llm.reduce((s: number, x: any) => s + Number(x.attributes[k]), 0);
  assert.equal(tok('gen_ai.usage.input_tokens'), ledger.reduce((s, l) => s + l.promptTokens, 0));
  assert.equal(tok('gen_ai.usage.output_tokens'), ledger.reduce((s, l) => s + l.completionTokens, 0));
  const nonApprover = llm.filter((s: any) => s.attributes['tugline.role'] !== 'approver').reduce((s: number, x: any) => s + Number(x.attributes['tugline.cost_usd']), 0);
  assert.ok(Math.abs(nonApprover - res.stats.costUsd) < 1e-12, 'model-call spans equal the run cost');
});

test('H4: telemetry is off by default (no spans), and an OTLP endpoint in the environment turns it on', async () => {
  setTelemetryProvider(undefined);
  const ws = tmpWorkspace({ 'a.txt': 'hello\n' });
  const srv = await startMockServer(() => ({ content: 'hi' }));
  servers.push(srv);
  const cfg = testConfig(srv.url);
  assert.equal(telemetryConfig(cfg, {}).active, false);
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await agent.run('hello');
  await agent.dispose();
  assert.equal(exporter.getFinishedSpans().length, 0);
  const on = telemetryConfig(cfg, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' });
  assert.equal(on.active, true);
  assert.equal(on.url, 'http://collector:4318/v1/traces');
  assert.equal(telemetryConfig({ ...cfg, telemetry: { enabled: false } }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }).active, false, 'explicit off wins');
  assert.equal(telemetryConfig({ ...cfg, telemetry: { enabled: true, endpoint: 'http://x:4318/v1/traces' } }, {}).url, 'http://x:4318/v1/traces');
});

test('H4: the OTLP/HTTP exporter really sends the spans to a collector endpoint', async () => {
  setTelemetryProvider(undefined);
  const http = await import('node:http');
  const got: { path?: string; type?: string; bytes: number }[] = [];
  const collector = http.createServer((req, res) => {
    let n = 0;
    req.on('data', (d) => (n += d.length));
    req.on('end', () => {
      got.push({ path: req.url, type: req.headers['content-type'], bytes: n });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', () => r()));
  const port = (collector.address() as any).port;
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const srv = await startMockServer(() => ({ content: 'hi' }));
  servers.push(srv);
  const prev = { http: process.env.HTTP_PROXY, https: process.env.HTTPS_PROXY, no: process.env.NO_PROXY };
  process.env.NO_PROXY = '127.0.0.1,localhost';
  try {
    const cfg = testConfig(srv.url, { telemetry: { enabled: true, endpoint: `http://127.0.0.1:${port}/v1/traces`, serviceName: 'oh-test' } });
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('hello');
    await agent.dispose();
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(got.length >= 1, 'the collector received an export');
    assert.equal(got[0].path, '/v1/traces');
    assert.ok(got[0].bytes > 50);
  } finally {
    process.env.NO_PROXY = prev.no;
    const { shutdownTelemetry } = await import('../src/core/telemetry/otel.js');
    await shutdownTelemetry();
    await new Promise<void>((r) => collector.close(() => r()));
  }
});
