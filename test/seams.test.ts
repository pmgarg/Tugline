/** SPEC S0: shared seams every workstream builds on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent/agent.js';
import { registerToolProvider, unregisterToolProvider } from '../src/core/tools/registry.js';
import type { AgentExtension } from '../src/core/agent/extensions.js';
import type { AgentEvent } from '../src/core/types.js';
import { DiskHost } from '../src/core/host/workspace.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

test('S0.2 tool providers contribute tools to the agent', async () => {
  registerToolProvider({ id: 'test-echo', tools: () => [{ name: 'echo_x', description: 'echo', parameters: { type: 'object', properties: { s: { type: 'string' } } }, kind: 'meta', title: () => 'echo', run: async (a: any) => ({ output: `echo:${a.s}` }) }] });
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'echo_x', arguments: { s: 'hi' } }] } : { content: 'done' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
    await agent.run('go');
    await srv.close();
    assert.ok(srv.requests[0].tools.some((t: any) => t.function.name === 'echo_x'));
    assert.equal(lastToolResult(srv.requests[1]), 'echo:hi');
  } finally {
    unregisterToolProvider('test-echo');
  }
});

test('S0.3 extensions: lifecycle order, approve settles asks, afterTool appends, beforeShell sees the command', async () => {
  const ws = tmpWorkspace({});
  const order: string[] = [];
  const shells: string[] = [];
  const ext: AgentExtension = {
    id: 't',
    onRunStart: () => void order.push('start'),
    beforeTurn: (_a, n) => void order.push(`turn${n}`),
    approve: (_a, q) => (q.input.command?.startsWith('echo') ? { decision: 'allow', by: 'test-approver' } : q.input.command?.startsWith('touch') ? { decision: 'deny', by: 'test-approver', reason: 'no touching' } : undefined),
    beforeShell: (_a, c) => void shells.push(c),
    afterTool: (_a, c) => (c.tool === 'bash' ? '[ext] noted' : undefined),
    onRunEnd: (_a, info) => void order.push(`end:${info.stopReason}`),
  };
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo approved-by-ext' } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'touch nope.txt' } }] };
    return { content: 'ok' };
  });
  const events: AgentEvent[] = [];
  // ask mode, no UI: without the extension both commands would be denied
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask' }), mcp: false, extensions: [ext], ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('go');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.match(lastToolResult(srv.requests[1]), /approved-by-ext[\s\S]*\[ext\] noted/);
  assert.match(lastToolResult(srv.requests[2]), /blocked by test-approver: no touching/);
  assert.deepEqual(shells, ['echo approved-by-ext']);
  assert.deepEqual(order, ['start', 'turn1', 'turn2', 'turn3', 'end:end_turn']);
  assert.ok(events.some((e) => e.type === 'permission' && e.auto && /test-approver/.test(e.request.reason ?? '')));
});

test('S0.3 approve is never consulted for hard denies', async () => {
  const ws = tmpWorkspace({ 'tests/t.py': 'x' });
  let asked = 0;
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'tests/t.py', content: 'y' } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', permissions: { protectedPaths: ['tests/**'] } }), mcp: false, extensions: [{ id: 'yes', approve: () => (asked++, { decision: 'allow' }) }] });
  await agent.run('go');
  await srv.close();
  assert.equal(asked, 0);
  assert.match(lastToolResult(srv.requests[1]), /Refused/);
});

test('S0.3 a throwing extension becomes a notice, not a crash', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'fine' }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false, extensions: [{ id: 'boom', beforeTurn: () => { throw new Error('kaboom'); } }], ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('go');
  await srv.close();
  assert.equal(res.finalText, 'fine');
  assert.ok(events.some((e) => e.type === 'notice' && /boom\.beforeTurn failed: kaboom/.test(e.message)));
});

test('S0.1 DiskHost round-trips text and reports versions', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\r\ntwo\r\n' });
  const h = new DiskHost();
  const r = await h.readText(`${ws}/a.txt`);
  assert.equal(r?.eol, '\r\n');
  assert.equal(r?.dirty, false);
  await h.writeText(`${ws}/sub/b.txt`, 'x');
  assert.equal((await h.readText(`${ws}/sub/b.txt`))?.text, 'x');
  assert.equal(await h.readText(`${ws}/missing`), undefined);
});

import { registerCommandWrapper, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { registerSlashCommand, getSlashCommand } from '../src/core/commands.js';

test('S0.7 command wrappers rewrite spawned commands', async () => {
  registerCommandWrapper('test-wrap', (cfg) => ((cfg as any).testWrap ? (s) => ({ ...s, file: '/bin/bash', args: ['-c', 'echo WRAPPED'] }) : undefined));
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo plain' } }] } : { content: 'ok' }));
    const cfg: any = testConfig(srv.url, { permissionMode: 'yolo' });
    cfg.testWrap = true;
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('go');
    await srv.close();
    assert.match(lastToolResult(srv.requests[1]), /WRAPPED/);
  } finally {
    unregisterCommandWrapper('test-wrap');
  }
});

test('S0.6 slash command registry', async () => {
  registerSlashCommand({ name: 'zz-test', description: 'test', run: (a) => ({ prompt: `do ${a}` }) });
  const c = getSlashCommand('zz-test')!;
  assert.deepEqual(await c.run('x', { agent: null, config: {} as any, workspace: '/', write: () => {}, surface: 'cli' }), { prompt: 'do x' });
});

test('S0.3 beforeTurn gate stops the run with a typed reason; onEvent observes events', async () => {
  const ws = tmpWorkspace({});
  const seen: string[] = [];
  const srv = await startMockServer(() => ({ content: 'should not be reached' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false, extensions: [{ id: 'gate', beforeTurn: () => ({ stop: 'budget', message: 'daily limit reached' }), onEvent: (_a, e) => void seen.push(e.type) }] });
  const res = await agent.run('go');
  await srv.close();
  assert.equal(res.stopReason, 'budget');
  assert.equal(res.finalText, 'daily limit reached');
  assert.equal(srv.requests.length, 0);
  assert.ok(seen.includes('run_start') && seen.includes('run_end'));
});

import { execFileSync } from 'node:child_process';
import fsx from 'node:fs';
import { registerCliCommand } from '../src/core/commands.js';

test('S0.3 onSessionStart fires once before the first run; onSessionEnd on dispose', async () => {
  const ws = tmpWorkspace({});
  const seen: string[] = [];
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false, extensions: [{ id: 's', onSessionStart: () => void seen.push('ss'), onRunStart: () => void seen.push('rs'), onSessionEnd: () => void seen.push('se') }] });
  await agent.run('a');
  await agent.run('b');
  await agent.dispose();
  await srv.close();
  assert.deepEqual(seen, ['ss', 'rs', 'rs', 'se']);
});

test('S0.1 DiskHost flags invalid UTF-8 and exposes raw bytes', async () => {
  const ws = tmpWorkspace({});
  fsx.writeFileSync(`${ws}/latin1.txt`, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Latin-1
  const r = await new DiskHost().readText(`${ws}/latin1.txt`);
  assert.equal(r?.utf8, false);
  assert.deepEqual([...r!.bytes!], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
  assert.equal((await new DiskHost().readText(`${ws}/latin1.txt`.replace('latin1', 'missing'))), undefined);
});

test('S0.7 a wrapper may change cwd', async () => {
  const ws = tmpWorkspace({ 'sub/marker.txt': 'm' });
  registerCommandWrapper('cwd-wrap', () => (s) => ({ ...s, cwd: `${s.cwd}/sub` }));
  try {
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }] } : { content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
    await agent.run('go');
    await srv.close();
    assert.match(lastToolResult(srv.requests[1]), /marker\.txt/);
  } finally {
    unregisterCommandWrapper('cwd-wrap');
  }
});

test('S0.2 duplicate tool names are sent once; explore subagents see provider read-only tools', async () => {
  const { toolsForAgentType } = await import('../src/core/tools/index.js');
  registerToolProvider({ id: 'dup', tools: () => [{ name: 'read_file', description: 'dup', parameters: { type: 'object', properties: {} }, kind: 'read', title: () => 'x', run: async () => ({ output: 'dup' }) }, { name: 'ro_probe', description: 'ro', readOnly: true, parameters: { type: 'object', properties: {} }, kind: 'read', title: () => 'x', run: async () => ({ output: 'x' }) }] });
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer(() => ({ content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false });
    await agent.run('go');
    await srv.close();
    assert.equal(srv.requests[0].tools.filter((t: any) => t.function.name === 'read_file').length, 1);
    assert.ok(toolsForAgentType(agent.toolList, 'explore').some((t) => t.name === 'ro_probe'));
  } finally {
    unregisterToolProvider('dup');
  }
});

test('S0.6 registered CLI subcommands dispatch from `tug <name>`', () => {
  // Use a tiny entry that registers a command, then runs the real CLI main.
  const ws = tmpWorkspace({});
  const entry = `${ws}/entry.mts`;
  fsx.writeFileSync(entry, `import { registerCliCommand } from '${process.cwd()}/src/core/commands.ts';\nregisterCliCommand({ name: 'zz-hello', description: 'test', run: (argv, ctx) => { ctx.write('hello ' + argv.join(',')); } });\nprocess.argv = [process.argv[0], 'tug', 'zz-hello', 'a', 'b', '--cwd', ${JSON.stringify(ws)}];\nawait import('${process.cwd()}/src/cli/main.ts');\n`);
  const out = execFileSync(process.execPath, ['--import', 'tsx', entry], { encoding: 'utf8', env: { ...process.env, HOME: ws, TUG_BASE_URL: 'http://127.0.0.1:9/v1' } });
  assert.match(out, /hello a,b,--cwd/);
  void registerCliCommand;
});

test('D3 × providers: tools marked core stay loaded when tool search defers the rest', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `bulk_${i}`, description: `bulk tool ${i}`, parameters: { type: 'object', properties: {} }, kind: 'read' as const, title: () => 'x', run: async () => ({ output: 'x' }) }));
  registerToolProvider({ id: 'bulk', tools: () => [...many, { ...many[0], name: 'essential_x', core: true }] });
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer(() => ({ content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false });
    await agent.run('go');
    await srv.close();
    const names = srv.requests[0].tools.map((t: any) => t.function.name);
    assert.ok(names.includes('tool_search'), 'tool search active');
    assert.ok(names.includes('essential_x'));
    assert.ok(!names.includes('bulk_5'));
  } finally {
    unregisterToolProvider('bulk');
  }
});

test('D4 follow-up: reasoning_content is passed back only for interleaved-thinking models', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  for (const [model, expectBack] of [['glm-4.6', true], ['mock-model', false]] as const) {
    const srv = await startMockServer((_b, i) => (i === 0 ? { reasoning: 'I should read a.txt', toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'done' }));
    const cfg = testConfig(srv.url, { permissionMode: 'yolo' });
    (cfg.profiles as any)[cfg.profile].model = model;
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('go');
    await srv.close();
    const asst = srv.requests[1].messages.find((m: any) => m.role === 'assistant');
    assert.equal(asst.reasoning_content === 'I should read a.txt', expectBack, model);
  }
});

test('integration: session list shows the first prompt (run_start is journaled inside an event)', async () => {
  const { Journal } = await import('../src/core/agent/journal.js');
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const cfg = testConfig(srv.url);
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await agent.run('rename the parser module');
  await srv.close();
  const s = Journal.listSessions(cfg.homeDir, ws);
  assert.equal(s[0]?.firstPrompt, 'rename the parser module');
});

test('integration: tug serve mounts HTTP routes (H1 webhooks via --with-daemon); unknown paths still 426', async () => {
  const { startServer } = await import('../src/server/server.js');
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1');
  const srv = await startServer({ workspace: ws, config: cfg, port: 0, httpHandlers: [async (req, res) => (req.url === '/hooks/x' ? (res.writeHead(202).end('ok'), true) : false)] } as any);
  try {
    const base = srv.url.replace(/^ws/, 'http');
    assert.equal((await fetch(`${base}/hooks/x`, { method: 'POST' })).status, 202);
    assert.equal((await fetch(`${base}/other`)).status, 426);
  } finally {
    await srv.close();
  }
});

test('D10 follow-up: routing.editor and routing.approver feed the apply model and the classifier profile', async () => {
  const { editConfig } = await import('../src/core/edit/config.js');
  const { approverConfig } = await import('../src/core/approver/index.js');
  const cfg: any = { routing: { editor: 'fast', approver: 'tiny' } };
  assert.equal(editConfig(cfg).applyModel, 'fast');
  assert.equal(approverConfig(cfg).profile, 'tiny');
  // explicit settings win
  assert.equal(editConfig({ ...cfg, edit: { applyModel: 'big' } }).applyModel, 'big');
  assert.equal(approverConfig({ ...cfg, approver: { profile: 'x' } }).profile, 'x');
  assert.equal(editConfig({} as any).applyModel, undefined, 'still off by default');
});

test('CLI --help lists --max-output, --verbose and --acp; version is package.json\'s', () => {
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--help'], { encoding: 'utf8' });
  for (const f of ['--max-output', '--verbose', '--acp']) assert.ok(out.includes(f), f);
  assert.ok(!/oh replay tug replay/.test(out));
  assert.equal(execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', '--version'], { encoding: 'utf8' }).trim(), JSON.parse(fsx.readFileSync('package.json', 'utf8')).version);
});

test('alwaysAsk inputs never reach approver extensions (review gap after D6)', async () => {
  registerToolProvider({ id: 'always', tools: () => [{ name: 'sensitive_x', description: 'x', parameters: { type: 'object', properties: {} }, kind: 'edit', title: () => 'x', permissionInput: () => ({ alwaysAsk: 'must ask a human' }) as any, run: async () => ({ output: 'RAN' }) }] });
  try {
    const ws = tmpWorkspace({});
    let consulted = 0;
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'sensitive_x', arguments: {} }] } : { content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false, extensions: [{ id: 'yes-man', approve: () => (consulted++, { decision: 'allow', by: 'yes-man' }) }] });
    await agent.run('go');
    await srv.close();
    assert.equal(consulted, 0);
    assert.doesNotMatch(lastToolResult(srv.requests[1]), /RAN/, 'headless: no human, so it must not run');
  } finally {
    unregisterToolProvider('always');
  }
});

test('integration: read_file renders .ipynb by cell (raw JSON with offset/limit)', async () => {
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'], metadata: {} }, { cell_type: 'code', source: ['x = 1\n', 'print(x)'], metadata: {}, outputs: [], execution_count: 3 }], metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }, null, 1);
  const ws = tmpWorkspace({ 'a.ipynb': nb });
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.ipynb' } }] } : i === 1 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.ipynb', offset: 1, limit: 3 } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
  await agent.run('go');
  await srv.close();
  const r1 = lastToolResult(srv.requests[1]);
  assert.match(r1, /### cell 0[\s\S]*# Title[\s\S]*### cell 1[\s\S]*```python\nx = 1\nprint\(x\)/);
  assert.match(r1, /notebook_edit/);
  assert.match(lastToolResult(srv.requests[2]), /^\s+1\t\{/, 'offset/limit shows the raw JSON lines');
});

test('integration: apply_patch multi-file changes are all recorded; the prompt teaches the active edit family', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** Update File: b.txt\n@@\n-two\n+TWO\n*** Add File: c.txt\n+three\n*** End Patch';
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }, { name: 'read_file', arguments: { path: 'b.txt' } }] };
    if (i === 1) return { toolCalls: [{ name: 'apply_patch', arguments: { patch, input: patch } }] };
    return { content: 'ok' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: false }, edit: { editFormat: 'apply_patch' } } as any), mcp: false });
  const res = await agent.run('go');
  await srv.close();
  const names = srv.requests[0].tools.map((t: any) => t.function.name);
  assert.ok(names.includes('apply_patch') && !names.includes('edit_file'), names.join(','));
  const sys = srv.requests[0].messages[0].content as string;
  assert.match(sys, /apply_patch \(\*\*\* Begin Patch/);
  assert.doesNotMatch(sys, /Change files with the edit tools/);
  assert.match(lastToolResult(srv.requests[2]), /Applied patch/);
  assert.deepEqual([...res.stats.filesChanged].sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(agent.editHistory.length, 3);
  assert.equal(agent.editHistory.find((e) => e.path.endsWith('c.txt'))?.before, null);
});

test('eval: TUG_EVAL_TIMEOUT_SCALE multiplies task timeouts', async () => {
  const { timeoutScale } = await import('../src/core/eval/runner.js');
  assert.equal(timeoutScale({}), 1);
  assert.equal(timeoutScale({ TUG_EVAL_TIMEOUT_SCALE: '4' }), 4);
  assert.equal(timeoutScale({ TUG_EVAL_TIMEOUT_SCALE: 'x' }), 1);
});
