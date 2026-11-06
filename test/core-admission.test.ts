/** WS4 v1.1 R4: one admission point for every model request (C7 limits + run budget, reserve, reconcile). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent/agent.js';
import { LLMClient, LLMError } from '../src/core/llm/client.js';
import { resolveProfile } from '../src/core/config.js';
import { limitState, reservedNow, withAdmissionScope } from '../src/core/llm/admission.js';
import { readLedger, localDate, spentOn } from '../src/core/permissions/limits.js';
import { llmClassifier } from '../src/core/approver/index.js';
import { runApplyModel } from '../src/core/edit/applyModel.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const NO_MAP = { repoMapTokens: 0, backgroundCompaction: false };

test('R4 probe 7: with a 1-token daily limit, completeAs is refused before any request is sent', async () => {
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfg = testConfig(srv.url, { limits: { maxTokensPerDay: 1 }, agent: NO_MAP });
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false });
  const r = await a.run('hi');
  assert.equal(r.stopReason, 'budget');
  await assert.rejects(a.completeAs('summarizer', { messages: [{ role: 'user', content: 'hi' }] }), (e: unknown) => e instanceof LLMError && e.kind === 'budget' && /limits\.maxTokensPerDay/.test(e.message));
  assert.equal(srv.requests.length, 0, 'no request reached the endpoint');
  assert.equal(spentOn(cfg.homeDir).tokens, 0);
  await a.dispose();
  await srv.close();
});

test('R4: summarize-up-to, the approver classifier and the apply model are admitted too (nothing sent when exhausted)', async () => {
  const srv = await startMockServer(() => ({ content: 'summary' }));
  const cfg = testConfig(srv.url, { limits: { maxTokensPerDay: 0 }, agent: NO_MAP });
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false });
  a.loadHistory([
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'working' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'more' },
  ]);
  const s = await a.summarizeUpTo(3);
  assert.equal(s.strategy, 'mechanical-summary', 'the summariser call was refused, the mechanical fallback used');
  const scope = { config: cfg, sessionId: 's1', depth: 0 };
  const classify = llmClassifier(new LLMClient(resolveProfile(cfg)));
  await assert.rejects(withAdmissionScope(scope, () => classify([{ role: 'user', content: 'x' }])), /exhausted/);
  const applied = await withAdmissionScope(scope, () => runApplyModel(cfg, cfg.profile, { path: 'a.ts', original: 'a', snippet: 'b' }));
  assert.equal(applied.ok, false);
  assert.match((applied as any).reason, /exhausted/);
  assert.equal(srv.requests.length, 0);
  await a.dispose();
  await srv.close();
});

test('R4: the worst case is reserved, so two concurrent calls cannot both spend one remaining budget', async () => {
  const srv = await startMockServer(() => ({ content: 'ok' }));
  // testConfig: maxOutputTokens 1024 → worst case ≈ 1030 tokens; the day allows one such call
  const cfg = testConfig(srv.url, { limits: { maxTokensPerDay: 1500 }, agent: NO_MAP });
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false });
  const req = { messages: [{ role: 'user' as const, content: 'hi' }] };
  const both = await Promise.allSettled([a.completeAs('summarizer', req), a.completeAs('summarizer', req)]);
  assert.deepEqual(both.map((x) => x.status), ['fulfilled', 'rejected']);
  assert.match(String((both[1] as PromiseRejectedResult).reason.message), /reserved by calls in flight/);
  assert.equal(srv.requests.length, 1);
  assert.deepEqual(reservedNow(cfg.homeDir, a.sessionId).day, { tokens: 0, costUsd: 0 }, 'reservations released after the call');
  // reconciled: the actual usage (mock: 100 + 20) is in the ledger, once
  assert.equal(spentOn(cfg.homeDir).tokens, 120);
  await a.dispose();
  await srv.close();
});

test('R4: unlimited (absent) and exhausted (0) are distinct, for agent.maxCostUsd/maxTokens and limits.*', async () => {
  assert.equal(limitState(undefined), 'unlimited');
  assert.equal(limitState(0), 'exhausted');
  assert.equal(limitState(-1), 'exhausted');
  assert.equal(limitState(5), 'limited');
  const srv = await startMockServer(() => ({ content: 'ok' }));
  // defaults: no budget → the run proceeds
  let a = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { agent: NO_MAP }), mcp: false });
  assert.equal((await a.run('hi')).stopReason, 'end_turn');
  assert.equal(a.config.agent.maxCostUsd, undefined);
  assert.equal(srv.requests.length, 1);
  // an exhausted run budget refuses the first call
  a = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { agent: { ...NO_MAP, maxTokens: 0 } }), mcp: false });
  const r = await a.run('hi');
  assert.equal(r.stopReason, 'budget');
  assert.match(r.finalText, /run budget is exhausted/);
  assert.equal(srv.requests.length, 1, 'nothing sent');
  // an exhausted daily limit too
  a = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { limits: { maxCostUsdPerDay: 0 }, agent: NO_MAP }), mcp: false });
  const r2 = await a.run('hi');
  assert.equal(r2.stopReason, 'budget');
  assert.match(r2.finalText, /limits\.maxCostUsdPerDay is 0 \(exhausted/);
  assert.equal(srv.requests.length, 1);
  await srv.close();
});

test('R4: every request is recorded exactly once in the ledger (main loop and helpers), tagged with the run', async () => {
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfg = testConfig(srv.url, { agent: NO_MAP });
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false });
  const r = await a.run('hi');
  await a.completeAs('summarizer', { messages: [{ role: 'user', content: 'x' }] });
  await a.dispose();
  await srv.close();
  const lines = readLedger(cfg.homeDir, localDate());
  assert.equal(lines.length, srv.requests.length);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].run, r.runId);
  assert.ok(lines.every((l) => l.session === a.sessionId));
});
