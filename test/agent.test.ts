import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { LLMClient } from '../src/core/llm/client.js';
import { resolveProfile } from '../src/core/config.js';
import { probeEndpoint } from '../src/core/llm/probe.js';
import type { AgentEvent } from '../src/core/types.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const BUGGY = 'def average(numbers):\n    """Mean of a list. Returns 0 for an empty list."""\n    return sum(numbers) / len(numbers)\n';
const TEST = 'from calc import average\n\ndef test_empty():\n    assert average([]) == 0\n\ndef test_mean():\n    assert average([1, 2, 3]) == 2\n';

test('agent loop: read → edit → verify → answer, with native tool calls over SSE', async () => {
  const ws = tmpWorkspace({ 'calc.py': BUGGY, 'tests/test_calc.py': TEST });
  const srv = await startMockServer((body, i) => {
    switch (i) {
      case 0: return { content: 'Let me look.', toolCalls: [{ name: 'read_file', arguments: { path: 'calc.py' } }] };
      case 1: return { toolCalls: [{ name: 'edit_file', arguments: { path: 'calc.py', old_string: '    return sum(numbers) / len(numbers)', new_string: '    if not numbers:\n        return 0\n    return sum(numbers) / len(numbers)' } }] };
      case 2: return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -c "from calc import average; assert average([])==0; print(\'ok\')"' } }] };
      default: return { content: 'Fixed average([]) to return 0; verified.' };
    }
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), ui: { onEvent: (e) => events.push(e) }, mcp: false });
  const res = await agent.run('Fix average so the empty-list test passes.');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(res.finalText, 'Fixed average([]) to return 0; verified.');
  assert.match(fs.readFileSync(path.join(ws, 'calc.py'), 'utf8'), /if not numbers/);
  assert.deepEqual(res.stats.filesChanged, ['calc.py']);
  assert.equal(res.stats.commandsRun.length, 1);
  assert.equal(res.stats.commandsRun[0].exitCode, 0);
  assert.equal(res.stats.commandsRun[0].afterLastEdit, true);
  // v1.1 R2 batch 4: the inline `python3 -c` assertion is only the model's evidence; the harness ran the project's own
  // check (pytest, detected before the edit) itself, so the claim is verified without a nudge
  assert.equal(res.completion.state, 'verified', res.completion.summary);
  assert.match(res.completion.summary, /`python3 -m pytest -q` passed after the last edit \(run by the harness/);
  assert.equal(res.stats.promptTokens, 100 + 101 + 102 + 103, 'usage from stream_options is metered');
  assert.ok(srv.requests[0].tools.some((t: any) => t.function.name === 'edit_file'), 'native tools sent');
  assert.equal(srv.requests[1].messages.at(-1).role, 'tool');
  assert.ok(events.some((e) => e.type === 'tool_end' && e.name === 'bash' && e.ok));
  assert.ok(agent.journalFile && fs.readFileSync(agent.journalFile, 'utf8').includes('"type":"manifest"'));
  assert.ok(!fs.readFileSync(agent.journalFile!, 'utf8').includes('sk-test-1234567890abcdef'), 'API key never lands in the journal');
});

test('protected test files are refused and the refusal is recorded (the agent may not write the judge)', async () => {
  const ws = tmpWorkspace({ 'calc.py': BUGGY, 'tests/test_calc.py': TEST });
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'tests/test_calc.py' } }] };
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'tests/test_calc.py', old_string: 'assert average([]) == 0', new_string: 'assert average([]) is not None' } }] };
    return { content: 'I could not change the test; the code must be fixed instead.' };
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', permissions: { protectedPaths: ['tests/**'] } }), ui: { onEvent: (e) => events.push(e) }, mcp: false });
  const res = await agent.run('make the tests pass');
  await srv.close();
  assert.equal(fs.readFileSync(path.join(ws, 'tests/test_calc.py'), 'utf8'), TEST);
  assert.equal(res.stats.refusals, 1);
  assert.ok(events.some((e) => e.type === 'refusal' && /protected pattern/.test(e.reason)));
  assert.match(lastToolResult(srv.requests[2]), /Refused: refusing to modify tests\/test_calc.py/);
});

test('thrash ceiling: the same failing command 4 times stops the run (EAG S17)', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const srv = await startMockServer(() => ({ toolCalls: [{ name: 'bash', arguments: { command: 'exit 1' } }] }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { maxRepeatFailures: 4 } }), mcp: false });
  const res = await agent.run('do it');
  await srv.close();
  assert.equal(res.stopReason, 'thrashing');
  assert.equal(res.stats.commandsRun.length, 4);
  assert.match(String(srv.requests[3].messages.at(-1).content), /failed 3 times in a row/);
});

test('headless run with ask mode denies risky calls instead of hanging', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask' }), mcp: false });
  const res = await agent.run('run echo');
  await srv.close();
  assert.equal(res.stats.refusals, 1);
  assert.match(lastToolResult(srv.requests[1]), /no user is available/);
});

test('interactive approval: allow-always adds a session rule; deny feedback reaches the model', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((b, i) => {
    if (i < 2) return { toolCalls: [{ name: 'bash', arguments: { command: i === 0 ? 'npm --version' : 'npm --version --json' } }] };
    if (i === 2) return { toolCalls: [{ name: 'write_file', arguments: { path: 'x.txt', content: 'hi' } }] };
    return { content: 'done' };
  });
  let asked = 0;
  const agent = await Agent.create({
    workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask' }), mcp: false,
    ui: { requestPermission: async (r) => { asked++; return r.tool === 'bash' ? { decision: 'allow', always: true } : { decision: 'deny', feedback: 'use notes.md instead' }; } },
  });
  await agent.run('go');
  await srv.close();
  assert.equal(asked, 2, 'second npm call auto-allowed by the session rule bash(npm --version*)');
  assert.match(lastToolResult(srv.requests[3]), /use notes.md instead/);
});

test('text-protocol fallback: server rejects tools → harness switches dialect and parses <tool_call>', async () => {
  const ws = tmpWorkspace({ 'hello.txt': 'world\n' });
  const srv = await startMockServer((body) => {
    if (body.tools) return { status: 400, errorBody: JSON.stringify({ error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set' } }) };
    const n = body.messages.filter((m: any) => m.role === 'assistant').length;
    if (n === 0) return { content: 'Reading.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "hello.txt"}}\n</tool_call>' };
    return { content: 'The file says world.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
  const res = await agent.run('what is in hello.txt?');
  await srv.close();
  assert.equal(res.finalText, 'The file says world.');
  assert.equal(agent.llm.dialect, 'text');
  const textReq = srv.requests.at(-1);
  assert.equal(textReq.tools, undefined);
  assert.match(textReq.messages[0].content, /Tool calling protocol/);
  assert.ok(textReq.messages.some((m: any) => m.role === 'user' && /<tool_result name="read_file"/.test(m.content)));
});

test('leaked text tool calls in native mode are still executed', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const srv = await startMockServer((b, i) => (i === 0 ? { content: '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>' } : { content: 'alpha' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', profiles: { default: { toolMode: 'native' } } }), mcp: false });
  const res = await agent.run('read a.txt');
  await srv.close();
  assert.equal(res.stats.toolCalls, 1);
  assert.equal(res.finalText, 'alpha');
});

test('dialect healing: stream_options rejected → retried without it; 429 retried; reasoning separated', async () => {
  let calls = 0;
  const srv = await startMockServer((body) => {
    calls++;
    if (body.stream_options) return { status: 400, errorBody: '{"error":"Unrecognized request argument supplied: stream_options"}' };
    if (calls === 2) return { status: 429 };
    return { content: '<think>secret plan</think>Visible answer', noUsage: true };
  });
  const client = new LLMClient(resolveProfile(testConfig(srv.url)));
  const res = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
  await srv.close();
  assert.equal(res.text, 'Visible answer');
  assert.equal(res.reasoning, 'secret plan');
  assert.equal(res.usage.estimated, true);
  assert.ok(calls >= 3);
});

test('empty reply caused by max_tokens is detected (EAG S15: HTTP 200 is not an answer)', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((b, i) => (i === 0 ? { reasoning: 'thinking...'.repeat(50), finishReason: 'length' } : { content: 'answer' }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), ui: { onEvent: (e) => events.push(e) }, mcp: false });
  const res = await agent.run('q');
  await srv.close();
  assert.equal(res.finalText, 'answer');
  assert.equal(res.stats.unparseableReplies, 1);
  assert.match(String(srv.requests[1].messages.at(-1).content), /output-token limit/);
});

test('invalid tool-call JSON is reported back to the model, not guessed', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: '{path: oops' }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), mcp: false });
  await agent.run('x');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /not valid JSON/);
});

test('compaction: tiny context window triggers clearing + summary and keeps the original request', async () => {
  const big = 'line of content\n'.repeat(400);
  const ws = tmpWorkspace({ 'big1.txt': big, 'big2.txt': big, 'big3.txt': big });
  let summarized = false;
  let reads = 0;
  const srv = await startMockServer((body, i) => {
    if (String(body.messages[0].content).startsWith('You are compressing')) {
      summarized = true;
      return { content: '## User requests\n> read the three big files\n## Progress so far\nread big1, big2' };
    }
    if (reads < 3) return { toolCalls: [{ name: 'read_file', arguments: { path: `big${++reads}.txt` } }] };
    return { content: 'all read' };
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { profiles: { default: { contextWindow: 9000, maxOutputTokens: 500 } }, agent: { promptStyle: 'compact' } }), ui: { onEvent: (e) => events.push(e) }, mcp: false });
  const res = await agent.run('read the three big files');
  await srv.close();
  assert.equal(res.finalText, 'all read');
  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction happened');
  const last = srv.requests.at(-1);
  const text = JSON.stringify(last.messages);
  assert.ok(text.includes('read the three big files'), 'original request survives compaction verbatim');
  assert.ok(summarized || text.includes('earlier tool output cleared'));
});

test('subagents: explore gets a fresh context and read-only tools; validator that ran nothing is UNVERIFIED', async () => {
  const ws = tmpWorkspace({ 'x.py': 'print(1)\n' });
  const srv = await startMockServer((body) => {
    const sys = String(body.messages[0].content);
    const toolNames = (body.tools ?? []).map((t: any) => t.function.name);
    if (sys.startsWith('You are a fast, read-only research subagent')) {
      assert.ok(!toolNames.includes('edit_file') && !toolNames.includes('bash') && !toolNames.includes('task'));
      assert.equal(body.messages.filter((m: any) => m.role === 'user').length, 1, 'fresh context');
      return { content: 'x.py prints 1 (x.py:1)' };
    }
    if (sys.startsWith('You are an independent validator')) return { content: 'Looks fine. VERDICT: PASS' };
    const n = body.messages.filter((m: any) => m.role === 'tool').length;
    if (n === 0) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'explore', description: 'find print', prompt: 'What does x.py print?' } }] };
    if (n === 1) return { toolCalls: [{ name: 'task', arguments: { agent_type: 'validator', description: 'check', prompt: 'Check x.py' } }] };
    return { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
  await agent.run('investigate');
  await srv.close();
  const toolMsgs = srv.requests.at(-1).messages.filter((m: any) => m.role === 'tool');
  assert.match(toolMsgs[0].content, /x\.py prints 1/);
  assert.match(toolMsgs[1].content, /^UNVERIFIED/);
});

test('skills are listed in the prompt and loaded on demand; todo list emits events', async () => {
  const ws = tmpWorkspace({ '.tugline/skills/house-style/SKILL.md': '---\nname: house-style\ndescription: Use when writing any prose for the user.\n---\nAlways end with a haiku.' });
  const srv = await startMockServer((body, i) => {
    if (i === 0) {
      assert.match(body.messages[0].content, /house-style: Use when writing any prose/);
      assert.doesNotMatch(body.messages[0].content, /haiku/, 'body is not injected until loaded');
      return { toolCalls: [{ name: 'load_skill', arguments: { name: 'house-style' } }, { name: 'todo_write', arguments: { todos: [{ content: 'write', status: 'in_progress' }] } }] };
    }
    return { content: 'ok' };
  });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url), ui: { onEvent: (e) => events.push(e) }, mcp: false });
  await agent.run('write something');
  await srv.close();
  assert.match(srv.requests[1].messages.find((m: any) => m.role === 'tool').content, /Always end with a haiku/);
  assert.ok(events.some((e) => e.type === 'todos' && e.todos.length === 1));
});

test('MCP tools are exposed as mcp__server__tool and called through the loop', async () => {
  const ws = tmpWorkspace({});
  const fixture = path.resolve('test/fixtures/mcp-server.mjs');
  const srv = await startMockServer((body, i) => {
    if (i === 0) {
      assert.ok(body.tools.some((t: any) => t.function.name === 'mcp__calc__add'));
      return { toolCalls: [{ name: 'mcp__calc__add', arguments: { a: 20, b: 22 } }] };
    }
    return { content: 'The answer is 42' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask', mcpServers: { calc: { command: 'node', args: [fixture], trusted: true } } }) });
  const res = await agent.run('add 20 and 22');
  await agent.dispose();
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /42/);
  assert.equal(res.stats.refusals, 0, 'trusted server tools run without asking');
});

test('plan mode blocks edits until the plan is approved', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'old\n' });
  const srv = await startMockServer((b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: 'x' } }] };
    if (i === 1) return { toolCalls: [{ name: 'exit_plan_mode', arguments: { plan: '1. create b.txt' } }] };
    if (i === 2) return { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: 'x' } }] };
    return { content: 'created' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'plan' }), mcp: false, ui: { approvePlan: async () => true } });
  await agent.run('create b.txt');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /plan mode is read-only/);
  assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'x');
  assert.equal(agent.policy.mode, 'acceptEdits');
});

test('hooks: PreToolUse exit 2 blocks; Stop hook can demand more work', async () => {
  const ws = tmpWorkspace({});
  let stopAsked = false;
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo forbidden' } }] };
    const last = String(body.messages.at(-1).content);
    if (/did not accept stopping/.test(last)) stopAsked = true;
    return { content: 'finished' };
  });
  const hookFile = path.join(ws, 'stop-hook.sh');
  fs.writeFileSync(hookFile, `#!/bin/sh\nif [ -f "${ws}/.stopped-once" ]; then exit 0; fi\ntouch "${ws}/.stopped-once"\necho "run the tests first" >&2\nexit 2\n`, { mode: 0o755 });
  const agent = await Agent.create({
    workspace: ws, mcp: false,
    config: testConfig(srv.url, { permissionMode: 'yolo', hooks: { PreToolUse: [{ matcher: 'bash', command: 'grep -q forbidden && { echo "no forbidden commands" >&2; exit 2; } || exit 0' }], Stop: [{ command: hookFile }] } }),
  });
  const res = await agent.run('go');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /Blocked by a project hook: no forbidden commands/);
  assert.ok(stopAsked);
  assert.equal(res.finalText, 'finished');
});

test('capability probe detects native tools vs text-only endpoints', async () => {
  const native = await startMockServer((body) => (body.tools ? { toolCalls: [{ name: 'get_weather', arguments: { city: 'Dubai' } }] } : { content: 'OK' }));
  const r1 = await probeEndpoint(resolveProfile(testConfig(native.url)));
  await native.close();
  assert.equal(r1.nativeTools, true);
  assert.equal(r1.recommendedToolMode, 'native');
  // the text protocol is a fallback: not tried when native works, and so not reported as failing
  assert.equal(r1.textToolsTested, false);
  const textOnly = await startMockServer((body) => {
    if (body.tools) return { status: 400, errorBody: '{"error":"tools are not supported by this model"}' };
    if (/get_weather/.test(JSON.stringify(body.messages))) return { content: '<tool_call>{"name":"get_weather","arguments":{"city":"Dubai"}}</tool_call>' };
    return { content: 'OK' };
  });
  const r2 = await probeEndpoint(resolveProfile(testConfig(textOnly.url)));
  await textOnly.close();
  assert.equal(r2.nativeTools, false);
  assert.equal(r2.textTools, true);
  assert.equal(r2.textToolsTested, true);
  assert.equal(r2.recommendedToolMode, 'text');
});

test('undo reverts agent edits, removes created files, and never clobbers later user changes', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\n' });
  const srv = await startMockServer((b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] };
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'a.txt', old_string: 'one', new_string: 'two' } }, { name: 'write_file', arguments: { path: 'b.txt', content: 'new' } }] };
    return { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
  await agent.run('go');
  await srv.close();
  assert.equal(agent.editHistory.length, 2);
  assert.deepEqual(agent.undo(1).restored, ['b.txt']);
  assert.equal(fs.existsSync(path.join(ws, 'b.txt')), false);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'user changed it\n');
  const r = agent.undo(1);
  assert.equal(r.restored.length, 0);
  assert.match(r.skipped[0], /changed since/);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'user changed it\n');
});

test('verification nudge: edits without a check after the last edit get one request to verify', async () => {
  const ws = tmpWorkspace({ 'a.py': 'x = 1\n' });
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.py' } }] };
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' } }] };
    if (i === 2) return { content: 'Fixed, all good.' };
    if (i === 3) {
      assert.match(String(body.messages.at(-1).content), /did not run any check after your last edit/);
      return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 a.py' } }] };
    }
    return { content: 'Fixed; ran python3 a.py (exit 0).' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' }), mcp: false });
  const res = await agent.run('change x to 2');
  await srv.close();
  assert.equal(res.finalText, 'Fixed; ran python3 a.py (exit 0).');
  assert.equal(res.stats.commandsRun.at(-1)?.afterLastEdit, true);
});
