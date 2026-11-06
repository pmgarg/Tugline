/** SPEC C7: spend limits, usage ledger, `tug usage`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { getCliCommand, getSlashCommand } from '../src/core/commands.js';
import { localDate, readLedger, recordUsage, rootSession, usageCommand, usageReport, type LedgerLine } from '../src/core/permissions/limits.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

/**
 * Pricing that makes the worst case exact: output-only at $10/M and a 100k
 * output budget → every call's worst case is exactly $1.00, while the mock's
 * actual usage (20 completion tokens) costs $0.0002.
 */
const PRICED = { profiles: { default: { pricing: { inputPerM: 0, outputPerM: 10 }, maxOutputTokens: 100_000, contextWindow: 1_000_000 } } };

test('C7 AC1: the daily limit stops a run before the call that would exceed it', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] }));
  const cfg = testConfig(srv.url, { ...PRICED, permissionMode: 'yolo', limits: { maxCostUsdPerDay: 1.0001 } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const res = await agent.run('loop forever');
  await srv.close();
  // call 1: $0 spent + $1.00 worst case ≤ $1.0001 → admitted; call 2: $0.0002 + $1.00 > $1.0001 → refused
  assert.equal(srv.requests.length, 1, 'exactly one call was made');
  assert.equal(res.stopReason, 'budget');
  assert.match(res.finalText, /Stopped before the next model call: it could cost up to \$1\.0000 and today's spend is \$0\.0002 of the \$1\.0001 daily limit/);
});

test('C7 AC1: spend from other sessions today counts; token and session limits also gate', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfg = testConfig(srv.url, { ...PRICED, limits: { maxCostUsdPerDay: 1.4 } });
  recordUsage(cfg.homeDir, { ts: new Date().toISOString(), session: 'earlier', depth: 0, model: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.5 });
  const r1 = await (await Agent.create({ workspace: ws, config: cfg, mcp: false })).run('hi');
  assert.equal(r1.stopReason, 'budget');
  assert.equal(srv.requests.length, 0, 'refused before any call');
  const tok = testConfig(srv.url, { limits: { maxTokensPerDay: 500 } });
  const r2 = await (await Agent.create({ workspace: ws, config: tok, mcp: false })).run('hi');
  assert.equal(r2.stopReason, 'budget');
  assert.match(r2.finalText, /maxTokensPerDay/);
  const ses = testConfig(srv.url, { ...PRICED, limits: { maxCostUsdPerSession: 1.0001 } });
  const a3 = await Agent.create({ workspace: ws, config: ses, mcp: false });
  assert.equal((await a3.run('one')).stopReason, 'end_turn');
  const r3 = await a3.run('two');
  assert.equal(r3.stopReason, 'budget');
  assert.match(r3.finalText, /maxCostUsdPerSession/);
  await srv.close();
});

test('C7 AC2: ledger lines are correct, including subagent spend (counted under the parent session)', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((body) => {
    const msgs = body.messages as any[];
    if (msgs.some((m) => m.role === 'user' && String(m.content).includes('SUBTASK'))) return { content: 'sub done' };
    return msgs.some((m) => m.role === 'tool') ? { content: 'done' } : { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'x', prompt: 'SUBTASK look' } }] };
  });
  const cfg = testConfig(srv.url, { profiles: { default: { pricing: { inputPerM: 2, outputPerM: 10 } } }, permissionMode: 'yolo', agent: { requireVerification: false } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const res = await agent.run('delegate');
  await srv.close();
  const lines = readLedger(cfg.homeDir, localDate());
  assert.equal(lines.length, srv.requests.length, 'one ledger line per LLM call');
  assert.equal(lines.length, 3);
  const depths = lines.map((l) => l.depth).sort();
  assert.deepEqual(depths, [0, 0, 1], 'the subagent call is recorded');
  for (const [i, l] of lines.entries()) {
    assert.equal(l.session, agent.sessionId, 'subagent spend is under the parent session');
    assert.equal(l.model, 'mock-model');
    assert.equal(l.completionTokens, 20);
    assert.ok(l.promptTokens >= 100);
    assert.ok(Math.abs(l.costUsd - (l.promptTokens * 2 + l.completionTokens * 10) / 1e6) < 1e-12, `cost of line ${i}`);
    assert.ok(!Number.isNaN(Date.parse(l.ts)));
    assert.match(String(l.run), /^run_/);
  }
  const total = lines.reduce((s, l) => s + l.costUsd, 0);
  assert.ok(Math.abs(total - res.stats.costUsd) < 1e-12, 'ledger total equals the run cost (incl. subagent)');
  assert.ok(fs.statSync(path.join(cfg.homeDir, 'usage', `${localDate()}.jsonl`)).mode & 0o600);
});

function seed(home: string): void {
  const l = (model: string, p: number, c: number, cost: number, kind?: string): LedgerLine => ({ ts: '2026-10-25T10:00:00Z', session: 's1', depth: 0, model, promptTokens: p, completionTokens: c, costUsd: cost, kind });
  recordUsage(home, l('qwen3-coder', 1000, 200, 0.01), '2026-10-25');
  recordUsage(home, l('qwen3-coder', 3000, 100, 0.02), '2026-10-25');
  recordUsage(home, l('gpt-small', 500, 50, 0.5), '2026-10-25');
  recordUsage(home, l('qwen3-coder', 10, 10, 0.001, 'approver'), '2026-10-26');
  recordUsage(home, l('old-model', 9, 9, 9), '2026-09-01');
}

test('C7 AC3: `tug usage` prints a summary per day and per model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  seed(home);
  const out = usageReport(home, { since: '2026-10-20' });
  assert.match(out, /^Usage since 2026-10-20/);
  const perDay = out.split('Per model')[0];
  assert.match(perDay, /2026-10-25 +gpt-small +1 +500 +50 +\$0\.5000/);
  assert.match(perDay, /\n {12}qwen3-coder +2 +4000 +300 +\$0\.0300/);
  assert.match(perDay, /2026-10-26 +qwen3-coder \(approver\) +1 +10 +10 +\$0\.0010/);
  const perModel = out.split('Per model')[1];
  assert.match(perModel, /gpt-small +1 +500 +50 +\$0\.5000[\s\S]*qwen3-coder +2/, 'models sorted by cost');
  assert.match(perModel, /total +4 +4510 +360 +\$0\.5310/);
  assert.doesNotMatch(out, /old-model/, '--since excludes older days');
  const j = JSON.parse(usageReport(home, { since: '2026-10-25', json: true }));
  assert.equal(j.total.calls, 4);
  assert.equal(j.days['2026-10-25']['qwen3-coder'].prompt, 4000);
  assert.match(usageReport(home, { since: '2026-11-01' }), /No usage recorded since 2026-11-01/);
  assert.equal(usageReport(home, { since: '3d', now: new Date(2026, 9, 27) }).split('\n')[0].slice(0, 22), 'Usage since 2026-10-25');
  // registered as `tug usage` and /usage
  const cmd = getCliCommand('usage');
  assert.ok(cmd);
  let printed = '';
  assert.equal(usageCommand(['--since', '2026-10-25'], { config: { homeDir: home } as any, write: (t) => (printed += t + '\n') }), 0);
  assert.match(printed, /total +4/);
  assert.match(printed, /limits: none/);
  assert.equal(usageCommand(['--since', 'yesterday-ish'], { config: { homeDir: home } as any, write: () => {} }), 2);
  let slash = '';
  await getSlashCommand('usage')!.run('--since 2026-10-25', { agent: null, config: { homeDir: home } as any, workspace: '/', write: (t) => (slash += t), surface: 'cli' });
  assert.match(slash, /Per model/);
});

test('C7: subagent session ids map to the root session (v0.1 and parallel D1 forms)', () => {
  assert.equal(rootSession('2026-x-abc'), '2026-x-abc');
  assert.equal(rootSession('2026-x-abc-sub'), '2026-x-abc');
  assert.equal(rootSession('2026-x-abc-sub-3'), '2026-x-abc');
  assert.equal(rootSession('2026-x-abc-sub-1-sub-2'), '2026-x-abc');
});

test('C7 AC3: `tug usage` through the real CLI entry point', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-userhome-'));
  seed(path.join(fakeHome, '.tugline'));
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'usage', '--since', '2026-10-25'], { cwd: process.cwd(), env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, TUG_MANAGED_POLICY: '' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Per day[\s\S]*2026-10-25[\s\S]*Per model[\s\S]*total +4/);
});
