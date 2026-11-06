/**
 * WS12 N16: `tug ask` — every citation resolves and points at evidence the model
 * was shown (AC1); unsupported questions return "not found" (AC2); the
 * `ask_codebase` tool is offered when enabled (AC3, the tool side).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ask, rank, terms } from '../src/core/docs/ask.js';
import { buildInventory } from '../src/core/docs/inventory.js';
import { providerTools } from '../src/core/tools/registry.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig } from './helpers.js';
import { fixtureRepo, promptOf } from './docs-helpers.js';

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});

async function model(reply: (prompt: string) => string) {
  const srv = await startMockServer((b) => ({ content: reply(promptOf(b)) }));
  closers.push(srv.close);
  return srv;
}

test('N16 AC1: every citation in an answer resolves to an existing line range the model was shown; others are dropped', async () => {
  const ws = fixtureRepo();
  const srv = await model(() => 'The client wraps each call in withRetry (src/llm/client.ts:4-6). withRetry tries up to three times and rethrows the last error (src/llm/retry.ts:2-5). It also has a circuit breaker (src/llm/retry.ts:900-910). Writes are atomic (src/fs/write.ts:3-7).');
  const r = await ask({ config: testConfig(srv.url), workspace: ws, question: 'How does the LLM client retry failed calls with withRetry?' });
  assert.equal(r.found, true, r.reason);
  assert.match(r.answer, /withRetry tries up to three times/);
  assert.ok(!/circuit breaker/.test(r.answer), 'the claim with a non-existent line range is dropped');
  const inv = buildInventory(ws);
  for (const c of r.citations) {
    const f = inv.byRel.get(c.path)!;
    assert.ok(f && c.start >= 1 && c.end <= f.lines, `${c.path}:${c.start}-${c.end} resolves`);
    assert.ok(r.sources.some((s) => s.path === c.path && c.start <= s.end && c.end >= s.start), `${c.path}:${c.start} was shown to the model`);
  }
  assert.ok(r.dropped.some((d) => /retry\.ts:900-910/.test(d)), r.dropped.join('\n'));
  if (!r.sources.some((s) => s.path === 'src/fs/write.ts')) assert.ok(r.dropped.some((d) => /write\.ts.*not in the excerpts/.test(d)), 'an existing but unshown span is dropped');
  // the excerpts were wrapped as untrusted
  assert.match(promptOf(srv.requests[0]), /<untrusted_excerpt source="code" path="src\/llm\/retry\.ts"/);
});

test('N16 AC2: a question with no supporting code returns "not found" (without asking the model, or when the model or validation finds nothing)', async () => {
  const ws = fixtureRepo();
  const srv = await model((p) => (/greet/.test(p) ? 'NOT_FOUND' : 'It uses Kubernetes (src/nope.ts:1)'));
  const config = testConfig(srv.url);
  const none = await ask({ config, workspace: ws, question: 'Which Kubernetes helm chart deploys the payments service?' });
  assert.equal(none.found, false);
  assert.match(none.answer, /^Not found/);
  assert.equal(srv.requests.length, 0, 'no evidence → the model is not even asked');
  const declined = await ask({ config, workspace: ws, question: 'Does greet support localisation of greetings?' });
  assert.equal(declined.found, false);
  assert.match(declined.reason!, /model found no answer/);
  const hallucinated = await ask({ config, workspace: ws, question: 'How does the agent loop run tools?' });
  assert.equal(hallucinated.found, false, 'an answer whose only citation does not resolve is "not found", not a guess');
  // CLI exit code 3 for not found
  const out: string[] = [];
  assert.equal(await getCliCommand('ask')!.run(['Which', 'Kubernetes', 'helm', 'chart?'], { config, workspace: ws, write: (t) => out.push(t) }), 3);
  assert.match(out.join('\n'), /^Not found/);
});

test('N16 AC3 (tool side): ask_codebase is offered only when docs.ask.tool is on, and answers through the agent\'s read policy', async () => {
  const ws = fixtureRepo();
  const off = await providerTools(testConfig('http://127.0.0.1:9/v1'), { workspace: ws, homeDir: '/tmp', depth: 0 });
  assert.ok(!off.some((t) => t.name === 'ask_codebase'));
  const srv = await model(() => 'Reading a file uses fs.readFileSync (src/fs/read.ts:4-6).');
  const cfg = testConfig(srv.url, { docs: { ask: { tool: true } } });
  const on = await providerTools(cfg, { workspace: ws, homeDir: cfg.homeDir, depth: 0 });
  const tool = on.find((t) => t.name === 'ask_codebase');
  assert.ok(tool && tool.kind === 'read' && tool.readOnly);
  const { LLMClient } = await import('../src/core/llm/client.js');
  const { resolveProfile } = await import('../src/core/config.js');
  const llm = new LLMClient(resolveProfile(cfg));
  const policyDenyRead = { check: (i: any) => ({ decision: /read\.ts$/.test(i.paths?.[0]?.path ?? '') ? 'ask' : 'allow' }) };
  const allowAll = { check: () => ({ decision: 'allow' }) };
  const ok = await tool!.run({ question: 'How is a text file read with readText?' }, { workspace: ws, config: cfg, llm, smallLlm: llm, policy: allowAll } as any);
  assert.match(ok.output, /readFileSync/);
  assert.equal(ok.meta?.found, true);
  const hidden = await tool!.run({ question: 'How is a text file read with readText?' }, { workspace: ws, config: cfg, llm, smallLlm: llm, policy: policyDenyRead } as any);
  assert.ok(!/read\.ts:4/.test(hidden.output), 'files the policy would ask about are not used as evidence');
});

test('N16: retrieval units — terms split identifiers, BM25 ranks the defining file first', () => {
  assert.deepEqual(terms('How does withRetry work?'), ['withretry', 'retry']);
  const ws = fixtureRepo();
  const inv = buildInventory(ws);
  const chunks = inv.files.map((f) => ({ source: f.kind as 'code' | 'doc', path: f.rel, start: 1, end: f.lines, text: inv.read(f.rel) }));
  assert.equal(rank('parseArgs prompt verbose flags', chunks, 3)[0].path, 'src/cli/args.ts');
  assert.ok(!fs.existsSync(path.join(ws, '.tugline/wiki')), 'works without a wiki');
});
