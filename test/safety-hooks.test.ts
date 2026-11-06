/** SPEC C6: hooks expansion (new events, permissionDecision) and hook trust. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { loadConfig } from '../src/core/config.js';
import { getSlashCommand } from '../src/core/commands.js';
import { pendingProjectHooks, runHooks } from '../src/core/agent/hooks.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const NEW_EVENTS = ['SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification'];

test('C6 AC1: each new event fires once in a mock run', async () => {
  const ws = tmpWorkspace({});
  const log = path.join(ws, 'events.log');
  const hooks: Record<string, unknown[]> = {};
  for (const ev of NEW_EVENTS) hooks[ev] = [{ command: `echo ${ev} >> ${log}` }];
  // PermissionRequest also answers with the Claude Code contract: allow
  hooks.PermissionRequest = [{ command: `echo PermissionRequest >> ${log}; echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'` }];
  const srv = await startMockServer((body) => {
    const msgs = body.messages as any[];
    const isSub = msgs.some((m) => m.role === 'user' && String(m.content).includes('SUBTASK'));
    const toolResults = msgs.filter((m) => m.role === 'tool').length;
    if (isSub) return { content: 'sub done' };
    if (toolResults === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo allowed-by-hook' } }] };
    if (toolResults === 1) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'look around', prompt: 'SUBTASK: list files' } }] };
    return { content: 'all done' };
  });
  const cfg = testConfig(srv.url, { permissionMode: 'ask', hooks, agent: { requireVerification: false } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const res = await agent.run('go');
  assert.equal(res.stopReason, 'end_turn');
  assert.match(lastToolResult(srv.requests[1]), /allowed-by-hook/, 'PermissionRequest hook approved the ask (no UI present)');
  await agent.compactNow(true);
  await agent.dispose();
  await srv.close();
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  for (const ev of NEW_EVENTS) assert.equal(lines.filter((l) => l === ev).length, 1, `${ev} fired once (log: ${lines.join(',')})`);
  assert.deepEqual(lines, ['SessionStart', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'SessionEnd']);
});

test('C6: hooks receive hook_event_name and event fields on stdin', async () => {
  const ws = tmpWorkspace({});
  const out = path.join(ws, 'payload.json');
  await runHooks([{ command: `cat > ${out}` }], 'SubagentStart', { agentType: 'explore', description: 'd' }, ws);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.hook_event_name, 'SubagentStart');
  assert.equal(j.agentType, 'explore');
});

test('C6 AC3: permissionDecision "deny" from PreToolUse blocks the call', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch should-not-exist' } }] } : { content: 'ok' }));
  const deny = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no touching in this repo"}}'`;
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', hooks: { PreToolUse: [{ matcher: 'bash', command: deny }] } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await agent.run('go');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /Blocked by a project hook: no touching in this repo/);
  assert.equal(fs.existsSync(path.join(ws, 'should-not-exist')), false);
  // "allow"/"ask" are parsed but never loosen the policy (PreToolUse runs after the permission engine)
  const r = await runHooks([{ command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }], 'PreToolUse', { tool: 'bash' }, ws);
  assert.deepEqual([r.block, r.decision], [false, 'allow']);
});

test('C6: a PermissionRequest hook can deny, but cannot approve a red-team call', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'git push origin main' } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] };
    return { content: 'ok' };
  });
  const allowAll = `echo '{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}'`;
  const cfg = testConfig(srv.url, { permissionMode: 'ask', hooks: { PermissionRequest: [{ command: allowAll }] } });
  const asked: string[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { requestPermission: async (r) => (asked.push(r.title), { decision: 'deny', feedback: 'human no' }) } });
  await agent.run('go');
  await srv.close();
  assert.deepEqual(asked, ['Run: git push origin main'], 'the push still went to the human');
  assert.match(lastToolResult(srv.requests[2]), /\bhi\b/);
  const r = await runHooks([{ command: 'echo nope >&2; exit 2' }], 'PermissionRequest', { tool: 'bash' }, ws);
  assert.deepEqual([r.block, r.decision, r.reason], [true, 'deny', 'nope']);
});

test('C6 AC2: a project hook runs only when the workspace is trusted and its hash approved; a modified hook needs re-approval', async () => {
  const ws = tmpWorkspace({});
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  const writeProject = (cmd: string) => fs.writeFileSync(path.join(ws, '.tugline/config.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ command: cmd }] } }));
  fs.mkdirSync(path.join(ws, '.tugline'), { recursive: true });
  writeProject('echo v1 >> hook-ran.log');
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfgFor = (trusted: boolean) => loadConfig({ workspace: ws, noUserConfig: true, trusted, env: {}, overrides: { homeDir, profiles: { default: { baseUrl: srv.url, model: 'mock-model' } } } });
  const runOnce = async (trusted: boolean) => {
    const cfg = cfgFor(trusted);
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('hi');
    return cfg;
  };
  const ran = () => (fs.existsSync(path.join(ws, 'hook-ran.log')) ? fs.readFileSync(path.join(ws, 'hook-ran.log'), 'utf8') : '');
  // untrusted workspace: never runs
  await runOnce(false);
  assert.equal(ran(), '');
  // trusted but not approved: does not run, and is reported as pending
  const c1 = await runOnce(true);
  assert.equal(ran(), '');
  assert.equal(pendingProjectHooks(c1).length, 1);
  assert.ok(c1.trust!.ignored.some((x) => /hooks\.UserPromptSubmit "echo v1/.test(x)));
  // approve via /hooks approve
  let out = '';
  await getSlashCommand('hooks')!.run('approve', { agent: null, config: c1, workspace: ws, write: (t) => (out += t), surface: 'cli' });
  assert.match(out, /approved 1 hook/);
  await runOnce(true);
  assert.equal(ran(), 'v1\n');
  // the project changes the hook: it must not run until approved again
  writeProject('echo v2-evil >> hook-ran.log');
  const c3 = await runOnce(true);
  assert.equal(ran(), 'v1\n', 'modified hook did not run');
  assert.equal(pendingProjectHooks(c3)[0].hook.command, 'echo v2-evil >> hook-ran.log');
  await srv.close();
  // user-level hooks (not from the project) need no approval
  const userHooks = loadConfig({ workspace: tmpWorkspace({}), noUserConfig: true, trusted: true, env: {}, overrides: { homeDir, hooks: { Stop: [{ command: 'true' }] } } });
  assert.equal(userHooks.hooks.Stop?.length, 1);
});
