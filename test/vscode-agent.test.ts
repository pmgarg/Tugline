/**
 * WS2 (SPEC B): extension logic exercised through a real Agent and the mock
 * OpenAI server — model picker / effort / plan profile (B8), /context and
 * subagent cost (B9), the visible-terminal host seam with command wrappers
 * (B10, S0.8), and image messages (B5).
 */
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand, type SlashContext } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { registerCommandWrapper, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { DiskHost, type HostCommand, type HostCommandResult } from '../src/core/host/workspace.js';
import type { AgentEvent } from '../src/core/types.js';
import { applyPlanProfile, applySelection, pickerItems } from '../vscode/src/modelPick.js';
import { emptyMeter, meterReduce } from '../vscode/src/meter.js';
import { buildUserMessage } from '../vscode/src/images.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const NO_MAP = { agent: { repoMapTokens: 0 } };

test('B8 AC1: switching the model mid-chat (even mid-run) changes `model` in the next request', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'hi\n' });
  let agent!: Agent;
  let originals: any;
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] };
    return { content: 'done' };
  });
  const cfg = testConfig(srv.url, NO_MAP);
  originals = JSON.parse(JSON.stringify(cfg.profiles));
  agent = await Agent.create({
    workspace: ws,
    config: cfg,
    mcp: false,
    ui: {
      onEvent: (e) => {
        // the user picks another model while the first tool runs
        if (e.type === 'tool_start') agent.setProfile(applySelection(agent.config, originals, 'default', { choice: 'model:other-model' }));
      },
    },
  });
  await agent.run('read a.txt');
  await agent.run('again');
  await srv.close();
  assert.equal(srv.requests[0].model, 'mock-model');
  assert.equal(srv.requests[1].model, 'other-model', 'the next request of the same run');
  assert.equal(srv.requests[2].model, 'other-model', 'and later runs');
  // back to the configured model
  agent.setProfile(applySelection(agent.config, originals, 'default', {}));
  assert.equal(agent.llm.profile.model, 'mock-model');
});

test('B8 AC2: effort maps to the dialect field (enable_thinking / reasoning_effort) and "default" sends nothing', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfg = testConfig(srv.url, NO_MAP);
  const originals = JSON.parse(JSON.stringify(cfg.profiles));
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const runWith = async (sel: any) => {
    agent.setProfile(applySelection(agent.config, originals, 'default', sel));
    await agent.run('hi');
    return srv.requests[srv.requests.length - 1];
  };
  const qwenLow = await runWith({ choice: 'model:qwen3-coder-30b', effort: 'low' });
  assert.deepEqual(qwenLow.chat_template_kwargs, { enable_thinking: true });
  const qwenOff = await runWith({ choice: 'model:qwen3-coder-30b', effort: 'off' });
  assert.deepEqual(qwenOff.chat_template_kwargs, { enable_thinking: false });
  const gptLow = await runWith({ choice: 'model:gpt-oss-20b', effort: 'low' });
  assert.equal(gptLow.reasoning_effort, 'low');
  assert.equal(gptLow.chat_template_kwargs, undefined, 'the previous effort field is gone');
  const def = await runWith({ choice: 'model:gpt-oss-20b', effort: 'default' });
  assert.equal(def.reasoning_effort, undefined);
  await srv.close();
});

test('B8 AC3: plan mode uses the plan profile when set (and the main profile otherwise)', async () => {
  const ws = tmpWorkspace({});
  const main = await startMockServer(() => ({ content: 'main answer' }));
  const planner = await startMockServer(() => ({ content: 'plan answer' }));
  const cfg = testConfig(main.url, { ...NO_MAP, profiles: { planner: { baseUrl: planner.url, model: 'big-planner', contextWindow: 32768, maxOutputTokens: 1024, toolMode: 'auto', timeoutMs: 20_000 } } });
  applyPlanProfile(cfg, 'planner');
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  agent.setMode('plan');
  await agent.run('plan the refactor');
  assert.equal(planner.requests.length, 1);
  assert.equal(planner.requests[0].model, 'big-planner');
  assert.equal(main.requests.length, 0);
  agent.setMode('acceptEdits');
  await agent.run('implement');
  assert.equal(main.requests.length, 1, 'other modes use the chat model');
  assert.equal(planner.requests.length, 1);
  const unset = testConfig(main.url);
  applyPlanProfile(unset, 'nope');
  assert.equal((unset as any).routing?.planner, undefined, 'an unknown plan profile is not routed');
  assert.deepEqual(pickerItems(cfg, ['m1']).map((i) => i.value), ['profile:default', 'profile:planner', 'model:m1']);
  await main.close();
  await planner.close();
});

test('B9 AC2: the CLI /context prints the 4 categories (system prompt, tools, history, attachments)', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'hello\n' });
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false });
  await agent.run('look <attached_context source="@a.txt">hello</attached_context>');
  await srv.close();
  let out = '';
  const ctx: SlashContext = { agent, config: agent.config, workspace: agent.workspace, write: (t) => (out += t + '\n'), surface: 'cli' };
  await getSlashCommand('context')!.run('', ctx);
  for (const cat of ['system prompt', 'tools', 'history', 'attachments']) assert.match(out, new RegExp(`${cat}\\s+\\d+ tok`));
});

test('B9 AC3: per-task cost in the meter includes subagent calls (usage events are forwarded to the UI)', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const srv = await startMockServer((body) => {
    const sys = String(body.messages[0]?.content ?? '');
    const last = body.messages[body.messages.length - 1];
    const isChild = !body.tools?.some((t: any) => t.function.name === 'task');
    if (isChild) return { content: 'child report: a.txt has one line' };
    if (last.role === 'user' && !sys.includes('child')) return last.content.includes('child report') ? { content: 'done' } : { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'look', prompt: 'look at a.txt' } }] };
    return { content: 'done' };
  });
  const cfg = testConfig(srv.url, { ...NO_MAP, permissionMode: 'yolo', profiles: { default: { pricing: { inputPerM: 1000, outputPerM: 2000 } } } });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('explore a.txt with a subagent');
  await srv.close();
  let m = emptyMeter();
  for (const e of events) m = meterReduce(m, e);
  const usageEvents = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
  assert.ok(usageEvents.some((e) => e.role === 'explore'), 'subagent usage reached the UI');
  assert.ok(m.task.subagentCalls >= 1);
  assert.ok(m.task.subagentCost > 0);
  const total = usageEvents.reduce((n, e) => n + e.costUsd, 0);
  assert.ok(Math.abs(m.task.cost - total) < 1e-12);
  assert.ok(Math.abs(m.task.cost - res.stats.costUsd) < 1e-9, 'meter task cost = run stats cost (core merges child stats)');
});

class TerminalHost extends DiskHost {
  calls: HostCommand[] = [];
  constructor(private reply: (c: HostCommand) => HostCommandResult | undefined) {
    super();
  }
  async runCommand(c: HostCommand): Promise<HostCommandResult | undefined> {
    this.calls.push(c);
    return this.reply(c);
  }
}

test('B10/S0.8: bash hands the host the command AFTER the command wrappers (sandbox) and returns its output and exit code', async () => {
  registerCommandWrapper('test-ws2-wrap', () => (spec) => ({ ...spec, file: '/usr/bin/env', args: ['TUG_WRAPPED=1', spec.file, ...spec.args], env: { ...spec.env, TUG_SANDBOXED: 'yes' } }));
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
    const host = new TerminalHost(() => ({ exitCode: 0, output: 'hi', timedOut: false, durationMs: 3 }));
    // processLifetime off: only this test's wrapper (WS3's lifetime wrapper would put bwrap around it on Linux)
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, permissionMode: 'yolo', shell: { processLifetime: 'off' } }), mcp: false, host });
    await agent.run('say hi');
    await srv.close();
    assert.equal(host.calls.length, 1);
    const c = host.calls[0];
    assert.equal(c.file, '/usr/bin/env', 'the wrapper ran first');
    assert.deepEqual(c.args.slice(0, 2), ['TUG_WRAPPED=1', process.env.SHELL?.endsWith('zsh') ? '/bin/zsh' : '/bin/bash']);
    assert.equal(c.args[c.args.length - 1], 'echo hi');
    assert.equal(c.env.TUG_SANDBOXED, 'yes');
    assert.equal(c.env.TUGLINE, '1', 'scrubbed harness env');
    assert.equal(c.command, 'echo hi');
    assert.match(lastToolResult(srv.requests[1]), /^\$ echo hi\nhi\n\[exit code 0,/);
  } finally {
    unregisterCommandWrapper('test-ws2-wrap');
  }
});

test('B10 AC2 / B1 AC4: when the host declines (no shell integration) bash spawns the hidden process, wrappers still applied', async () => {
  registerCommandWrapper('test-ws2-wrap2', () => (spec) => ({ ...spec, env: { ...spec.env, TUG_SANDBOXED: 'yes' } }));
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo "fallback:$TUG_SANDBOXED"' } }] } : { content: 'ok' }));
    const host = new TerminalHost(() => undefined);
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, permissionMode: 'yolo' }), mcp: false, host });
    await agent.run('go');
    await srv.close();
    assert.equal(host.calls.length, 1, 'asked once');
    assert.match(lastToolResult(srv.requests[1]), /fallback:yes\n\[exit code 0/);
  } finally {
    unregisterCommandWrapper('test-ws2-wrap2');
  }
});

test('B5: through the agent, a vision profile sends image_url parts; a text-only one sends none', async () => {
  const ws = tmpWorkspace({});
  const png = 'data:image/png;base64,' + Buffer.from('fakepng').toString('base64');
  for (const vision of [true, false]) {
    const srv = await startMockServer(() => ({ content: 'I see it' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, profiles: { default: { vision } } }), mcp: false });
    const msg = buildUserMessage('what is this?', [{ name: 'a.png', dataUrl: png }], { vision: agent.llm.profile.vision });
    await agent.run(msg.content);
    await srv.close();
    const body = JSON.stringify(srv.requests[0].messages);
    if (vision) assert.match(body, /"type":"image_url"/);
    else {
      assert.doesNotMatch(body, /image_url|base64/);
      assert.match(msg.notices[0], /no vision/);
    }
  }
});

test('B10 review fix 2: if the host fails after starting the command, bash reports an error and never runs it a second time', async () => {
  const ws = tmpWorkspace({});
  const marker = 'ran-hidden.txt';
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: `echo x >> ${marker}` } }] } : { content: 'ok' }));
  let started = 0;
  const host = new TerminalHost(() => {
    started++;
    throw new Error('terminal went away mid-command');
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, permissionMode: 'yolo' }), mcp: false, host });
  await agent.run('go');
  await srv.close();
  assert.equal(started, 1);
  assert.equal(fs.existsSync(path.join(ws, marker)), false, 'the hidden process did not run the command again');
  assert.match(lastToolResult(srv.requests[1]), /failed to run the command \(terminal went away mid-command\); it was not run again/);
});
