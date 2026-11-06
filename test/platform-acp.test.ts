/** WS7 G1: ACP server, tested with a scripted ACP client over stdio against `tug --acp`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { acpToolKind, mcpFromAcp, promptText } from '../src/acp/agent.js';
import { startMockServer, tmpWorkspace, type MockServer, lastToolResult } from './helpers.js';

interface Scripted {
  conn: acp.ClientSideConnection;
  child: ChildProcess;
  updates: acp.SessionNotification[];
  permissions: acp.RequestPermissionRequest[];
  reads: string[];
  writes: { path: string; content: string }[];
  stderr: () => string;
  close: () => Promise<void>;
}

/** Spawn `tug --acp` with an isolated HOME and the mock LLM, and connect a scripted client. */
function startAcp(llm: MockServer, opts: { onPermission?: (r: acp.RequestPermissionRequest, conn: acp.ClientSideConnection) => Promise<acp.RequestPermissionResponse>; fs?: Record<string, string> } = {}): Scripted {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-acp-home-'));
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/cli/main.ts'), '--acp'], {
    cwd: path.resolve('.'),
    env: { ...process.env, HOME: home, TUG_BASE_URL: llm.url, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-test-1234567890abcdef', TUG_CONTEXT_WINDOW: '32768', TUG_MAX_OUTPUT_TOKENS: '1024' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  const updates: acp.SessionNotification[] = [];
  const permissions: acp.RequestPermissionRequest[] = [];
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as any, Readable.toWeb(child.stdout!) as any);
  let conn!: acp.ClientSideConnection;
  conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(p) {
        updates.push(p);
      },
      async requestPermission(p) {
        permissions.push(p);
        if (opts.onPermission) return opts.onPermission(p, conn);
        return { outcome: { outcome: 'selected', optionId: 'allow' } };
      },
      async readTextFile(p) {
        reads.push(p.path);
        const v = opts.fs?.[p.path];
        if (v === undefined) throw acp.RequestError.resourceNotFound(p.path);
        return { content: v };
      },
      async writeTextFile(p) {
        writes.push({ path: p.path, content: p.content });
        return {};
      },
    }),
    stream,
  );
  return {
    conn,
    child,
    updates,
    permissions,
    reads,
    writes,
    stderr: () => err,
    close: async () => {
      child.stdin!.end();
      await new Promise<void>((r) => {
        const t = setTimeout(() => (child.kill('SIGKILL'), r()), 5000);
        child.once('exit', () => (clearTimeout(t), r()));
      });
    },
  };
}

test('G1 AC1: initialize → new session → prompt → message chunks and a tool_call update → permission answered → end turn', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((_b, i) => (i === 0 ? { content: 'I will create the file.', toolCalls: [{ name: 'bash', arguments: { command: 'echo acp > made-by-acp.txt' } }] } : { content: 'Done: made-by-acp.txt exists.' }));
  const c = startAcp(llm);
  try {
    const init = await c.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(init.agentCapabilities?.loadSession, true);
    const s = await c.conn.newSession({ cwd: ws, mcpServers: [] });
    assert.ok(s.sessionId);
    assert.equal(s.modes?.currentModeId, 'ask');
    const res = await c.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: 'make a file' }] });
    assert.equal(res.stopReason, 'end_turn');
    const kinds = c.updates.map((u) => u.update.sessionUpdate);
    const text = c.updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk').map((u: any) => u.update.content.text).join('');
    assert.match(text, /I will create the file\.[\s\S]*Done: made-by-acp\.txt exists\./);
    const call = c.updates.find((u) => u.update.sessionUpdate === 'tool_call')!.update as any;
    assert.equal(call.kind, 'execute');
    assert.match(call.title, /echo acp/);
    const done = c.updates.find((u) => u.update.sessionUpdate === 'tool_call_update')!.update as any;
    assert.equal(done.toolCallId, call.toolCallId);
    assert.equal(done.status, 'completed');
    assert.ok(kinds.indexOf('tool_call') < kinds.indexOf('tool_call_update'));
    // session/request_permission mapped from our PermissionRequest
    assert.equal(c.permissions.length, 1);
    const p = c.permissions[0];
    assert.equal(p.sessionId, s.sessionId);
    assert.equal(p.toolCall.toolCallId, call.toolCallId);
    assert.equal(p.toolCall.kind, 'execute');
    // a command with a redirection never gets an "always allow" rule from the policy, so only once/reject are offered
    assert.deepEqual(p.options.map((o) => o.kind), ['allow_once', 'reject_once']);
    assert.equal(fs.readFileSync(path.join(ws, 'made-by-acp.txt'), 'utf8').trim(), 'acp');
    // set_mode
    await c.conn.setSessionMode({ sessionId: s.sessionId, modeId: 'plan' });
    assert.ok(c.updates.some((u: any) => u.update.sessionUpdate === 'current_mode_update' && u.update.currentModeId === 'plan'));
  } finally {
    await c.close();
    await llm.close();
  }
});

test('G1 AC1: a rejected permission is a denial the agent records; fs delegation reads and writes through the client', async () => {
  const ws = tmpWorkspace({ 'notes.txt': 'DISK VERSION\n' });
  const file = path.join(ws, 'notes.txt');
  const llm = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'notes.txt' } }] };
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'notes.txt', old_string: 'BUFFER VERSION', new_string: 'EDITED IN EDITOR' } }] };
    if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'touch forbidden.txt' } }] };
    return { content: 'finished' };
  });
  const c = startAcp(llm, {
    fs: { [file]: 'BUFFER VERSION (unsaved)\n' },
    onPermission: async (r) => (r.toolCall.kind === 'execute' ? { outcome: { outcome: 'selected', optionId: 'deny' } } : { outcome: { outcome: 'selected', optionId: 'allow' } }),
  });
  try {
    await c.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    const s = await c.conn.newSession({ cwd: ws, mcpServers: [] });
    const res = await c.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: 'edit notes' }] });
    assert.equal(res.stopReason, 'end_turn');
    assert.match(lastToolResult(llm.requests[1]), /BUFFER VERSION \(unsaved\)/, 'read_file saw the editor buffer, not the disk');
    assert.ok(c.reads.includes(file));
    assert.deepEqual(c.writes, [{ path: file, content: 'EDITED IN EDITOR (unsaved)\n' }], 'the edit went through fs/write_text_file');
    assert.equal(fs.readFileSync(file, 'utf8'), 'DISK VERSION\n', 'the agent did not write the disk');
    const edit = c.permissions.find((p) => p.toolCall.kind === 'edit')!;
    assert.ok(edit.toolCall.content?.some((x: any) => x.type === 'diff' && x.newText.includes('EDITED IN EDITOR')), 'edit permission carries a diff');
    assert.match(lastToolResult(llm.requests[3]), /denied/);
    assert.ok(!fs.existsSync(path.join(ws, 'forbidden.txt')));
    const failed = c.updates.filter((u: any) => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'failed');
    assert.equal(failed.length, 1);
  } finally {
    await c.close();
    await llm.close();
  }
});

test('G1 AC2: cancel works (during a permission request and during a running command)', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (/sleep-now/.test(JSON.stringify(body.messages[1])) && !/Cancelled|cancel/i.test(last)) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 20' } }] };
    return { toolCalls: [{ name: 'bash', arguments: { command: 'touch never.txt' } }] };
  });
  let cancelled: Promise<void> | undefined;
  const c = startAcp(llm, {
    onPermission: async (r, conn) => {
      if (/touch never/.test(r.toolCall.title ?? '')) {
        // The user hits Stop while the approval is open: cancel, then answer "cancelled" as the spec requires.
        cancelled = conn.cancel({ sessionId: r.sessionId });
        await cancelled;
        return { outcome: { outcome: 'cancelled' } };
      }
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    },
  });
  try {
    await c.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await c.conn.newSession({ cwd: ws, mcpServers: [] });
    const r1 = await c.conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: 'do it' }] });
    assert.equal(r1.stopReason, 'cancelled');
    assert.ok(!fs.existsSync(path.join(ws, 'never.txt')));
    const s2 = await c.conn.newSession({ cwd: ws, mcpServers: [] });
    const t0 = Date.now();
    const p = c.conn.prompt({ sessionId: s2.sessionId, prompt: [{ type: 'text', text: 'sleep-now' }] });
    for (let i = 0; i < 100 && !c.updates.some((u: any) => u.sessionId === s2.sessionId && u.update.sessionUpdate === 'tool_call'); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    await c.conn.cancel({ sessionId: s2.sessionId });
    const r2 = await p;
    assert.equal(r2.stopReason, 'cancelled');
    assert.ok(Date.now() - t0 < 15_000, 'sleep 20 was interrupted');
  } finally {
    await c.close();
    await llm.close();
  }
});

test('G1: session/load replays the saved conversation', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer(() => ({ content: 'remembered answer' }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-acp-home-'));
  void home;
  const c = startAcp(llm);
  let sessionId = '';
  try {
    await c.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    sessionId = (await c.conn.newSession({ cwd: ws, mcpServers: [] })).sessionId;
    await c.conn.prompt({ sessionId, prompt: [{ type: 'text', text: 'first question' }] });
    c.updates.length = 0;
    await c.conn.loadSession({ sessionId, cwd: ws, mcpServers: [] });
    const replay = c.updates.map((u: any) => [u.update.sessionUpdate, u.update.content?.text]);
    assert.ok(replay.some(([k, t]) => k === 'user_message_chunk' && /first question/.test(t)));
    assert.ok(replay.some(([k, t]) => k === 'agent_message_chunk' && t === 'remembered answer'));
    await assert.rejects(c.conn.loadSession({ sessionId: 'no-such-session', cwd: ws, mcpServers: [] }));
  } finally {
    await c.close();
    await llm.close();
  }
});

test('G1: mapping helpers (tool kinds, MCP servers from the editor, prompt blocks)', () => {
  assert.equal(acpToolKind('grep', 'read'), 'search');
  assert.equal(acpToolKind('web_fetch', 'network'), 'fetch');
  assert.equal(acpToolKind('edit_file', 'edit'), 'edit');
  assert.deepEqual(mcpFromAcp([{ name: 'fs', command: 'npx', args: ['-y', 'x'], env: [{ name: 'A', value: '1' }] } as any, { type: 'http', name: 'h', url: 'https://m/mcp', headers: [{ name: 'X', value: 'y' }] } as any]), { fs: { command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, h: { url: 'https://m/mcp', headers: { X: 'y' } } });
  assert.match(promptText([{ type: 'text', text: 'look at' }, { type: 'resource_link', uri: 'file:///w/a%20b.ts', name: 'a b.ts' } as any, { type: 'resource', resource: { uri: 'file:///w/c.ts', text: 'const c = 1;' } } as any]), /^look at\n\n@\/w\/a b\.ts\n\n<file path="\/w\/c\.ts" id="[0-9a-f]{16}">\nconst c = 1;\n<\/file>$/); // N43 re-check D: harness-built blocks carry an id
});
