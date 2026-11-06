/** WS7 G2 (server mode) and H5 (remote agents). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startServer, tokenMatches, serveStdio } from '../src/server/server.js';
import { OhClient } from '../src/server/client.js';
import { runRemoteClient } from '../src/server/remote.js';
import type { AgentEvent, PermissionRequest } from '../src/core/types.js';
import { PassThrough } from 'node:stream';
import { startMockServer, testConfig, tmpWorkspace, type MockServer } from './helpers.js';

function serverFor(llm: MockServer, workspace: string, extra: any = {}) {
  const config = testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false }, ...extra });
  return startServer({ workspace, config, port: 0, configFor: (ws, o) => ({ ...testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false }, ...o }), homeDir: config.homeDir }) });
}

test('G2 AC1: WebSocket client creates a session, prompts, receives streamed events, and answers a permission request', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo from-server > out.txt' } }] } : { content: 'Created out.txt via the server.' }));
  const srv = await serverFor(llm, ws);
  const events: AgentEvent[] = [];
  const asked: PermissionRequest[] = [];
  const client = await OhClient.connect(srv.url, srv.token, {
    onEvent: (_sid, e) => events.push(e),
    onPermission: (_sid, req) => (asked.push(req), { decision: 'allow' }),
  });
  try {
    const init = await client.initialize();
    assert.equal(init.server, 'tugline');
    const s = await client.createSession({ mode: 'ask' });
    assert.equal(s.mode, 'ask');
    assert.equal(s.workspace, ws);
    const r = await client.prompt(s.sessionId, 'make out.txt');
    assert.equal(r.stopReason, 'end_turn');
    assert.equal(r.finalText, 'Created out.txt via the server.');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].tool, 'bash');
    assert.match(asked[0].title, /echo from-server/);
    assert.equal(fs.readFileSync(path.join(ws, 'out.txt'), 'utf8').trim(), 'from-server');
    const types = events.map((e) => e.type);
    for (const t of ['run_start', 'text_delta', 'tool_start', 'permission', 'tool_end', 'run_end']) assert.ok(types.includes(t as any), `streamed ${t}`);
    assert.ok(types.indexOf('tool_start') < types.indexOf('run_end'));
    const list = await client.request('session/list', {});
    assert.equal(list.live.length, 1);
    assert.ok(list.saved.some((x: any) => x.sessionId === s.sessionId), 'journal saved');
    // config/get redacts credentials; config/set only takes safe keys
    const cfg = await client.request('config/get', { sessionId: s.sessionId });
    assert.equal(cfg.profiles.default.apiKey, '***');
    await assert.rejects(client.request('config/set', { sessionId: s.sessionId, key: 'hooks', value: {} }), /allows only/);
    assert.deepEqual(await client.request('config/set', { sessionId: s.sessionId, key: 'permissionMode', value: 'plan' }), { ok: true, value: 'plan' });
    assert.deepEqual((await client.request('jobs/list', { sessionId: s.sessionId })).jobs, []);
    const cmd = await client.request('session/command', { sessionId: s.sessionId, name: 'output-style', args: 'concise' });
    assert.match(cmd.output, /concise/);
    assert.deepEqual(await client.request('session/delete', { sessionId: s.sessionId }), { deleted: true });
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
});

test('G2 AC1 (security): a client without an approval handler denies; with no client attached the ask is denied and recorded', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((_b, i) => (i % 2 === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch never.txt' } }] } : { content: 'ok' }));
  const srv = await serverFor(llm, ws);
  const client = await OhClient.connect(srv.url, srv.token);
  try {
    const s = await client.createSession({ mode: 'ask' });
    const r = await client.prompt(s.sessionId, 'try');
    assert.equal(r.stats.refusals, 1);
    assert.ok(!fs.existsSync(path.join(ws, 'never.txt')));
    // Detach: the session has no subscriber; prompts still run, asks are denied without waiting.
    await client.request('session/unsubscribe', { sessionId: s.sessionId });
    const started = Date.now();
    const r2 = await client.prompt(s.sessionId, 'try again');
    assert.equal(r2.stats.refusals, 1);
    assert.ok(Date.now() - started < 10_000);
    const journal = fs.readFileSync(srv.host.get(s.sessionId).agent.journalFile!, 'utf8');
    assert.match(journal, /"type":"refusal".*no client is attached/);
    assert.ok(!fs.existsSync(path.join(ws, 'never.txt')));
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
});

test('G2 AC2: requests without the token (or with a wrong one) are rejected', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer(() => ({ content: 'x' }));
  const srv = await serverFor(llm, ws);
  try {
    await assert.rejects(OhClient.connect(srv.url, 'wrong-token'), /authentication failed: invalid token/);
    // Raw socket: a request before auth is refused and the socket closed.
    const raw = new WebSocket(srv.url);
    await new Promise((r) => raw.once('open', r));
    const reply = new Promise<any>((r) => raw.once('message', (d) => r(JSON.parse(String(d)))));
    const closed = new Promise<number>((r) => raw.once('close', (code) => r(code)));
    raw.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/create', params: {} }));
    const msg = await reply;
    assert.equal(msg.error.code, -32001);
    assert.equal(await closed, 4401);
    assert.equal(srv.host.sessions.size, 0, 'no session was created');
    // Browser origins and non-loopback Host headers are refused at the upgrade.
    const fromPage = new WebSocket(srv.url, { headers: { Origin: 'https://evil.example' } });
    await assert.rejects(new Promise((res, rej) => (fromPage.once('open', res), fromPage.once('error', rej), fromPage.once('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode)))))), /403/);
    const rebinding = new WebSocket(srv.url, { headers: { Host: `attacker.example:${srv.port}` } });
    await assert.rejects(new Promise((res, rej) => (rebinding.once('open', res), rebinding.once('error', rej), rebinding.once('unexpected-response', (_q, r) => rej(new Error(String(r.statusCode)))))), /403/);
    assert.ok(tokenMatches(srv.token, srv.token));
    assert.ok(!tokenMatches(srv.token.slice(0, -1), srv.token));
    assert.ok(!tokenMatches(undefined, srv.token));
    assert.equal(srv.url.startsWith('ws://127.0.0.1:'), true, 'bound to loopback');
  } finally {
    await srv.close();
    await llm.close();
  }
});

test('G2 AC3: two sessions run concurrently', async () => {
  const wsA = tmpWorkspace({});
  const wsB = tmpWorkspace({});
  // A slow LLM: every reply waits 400 ms, so overlapping runs prove concurrency.
  const inflight = { now: 0, max: 0 };
  const llm = await startMockServer((body) => {
    const sys = String(body.messages[0].content);
    return { content: sys.includes(wsA) ? 'answer A' : 'answer B' };
  });
  const http = await import('node:http');
  const slow = http.createServer((req, res) => {
    inflight.now++;
    inflight.max = Math.max(inflight.max, inflight.now);
    setTimeout(() => {
      const fwd = http.request(llm.url.replace('/v1', '') + req.url, { method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers);
        r.pipe(res);
        r.on('end', () => inflight.now--);
      });
      req.pipe(fwd);
    }, 400);
  });
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  const slowUrl = `http://127.0.0.1:${(slow.address() as any).port}/v1`;
  const config = testConfig(slowUrl, { checkpoints: { enabled: false } });
  const srv = await startServer({ workspace: wsA, config, port: 0, configFor: (ws, o) => ({ ...testConfig(slowUrl, { checkpoints: { enabled: false }, ...o }), homeDir: config.homeDir }) });
  const events: Record<string, string[]> = {};
  const client = await OhClient.connect(srv.url, srv.token, { onEvent: (sid, e) => (events[sid] ??= []).push(e.type) });
  try {
    const a = await client.createSession({ workspace: wsA });
    const b = await client.createSession({ workspace: wsB });
    assert.notEqual(a.sessionId, b.sessionId);
    const t0 = Date.now();
    const [ra, rb] = await Promise.all([client.prompt(a.sessionId, 'question A'), client.prompt(b.sessionId, 'question B')]);
    assert.equal(ra.finalText, 'answer A');
    assert.equal(rb.finalText, 'answer B');
    assert.equal(inflight.max, 2, 'both sessions had an LLM call in flight at the same time');
    assert.ok(Date.now() - t0 < 1500, 'ran in parallel, not one after the other');
    assert.ok(events[a.sessionId].includes('run_end') && events[b.sessionId].includes('run_end'));
    const both = await Promise.allSettled([client.prompt(a.sessionId, 'x'), client.prompt(a.sessionId, 'y')]);
    assert.equal(both[0].status, 'fulfilled');
    assert.equal(both[1].status, 'rejected');
    assert.match(String((both[1] as PromiseRejectedResult).reason), /already running/);
  } finally {
    client.close();
    await srv.close();
    await new Promise<void>((r) => slow.close(() => r()));
    await llm.close();
  }
});

test('G2: steer and abort map onto the core APIs; the stdio transport speaks the same protocol', async () => {
  const ws = tmpWorkspace({});
  const llm = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 1; echo slept' } }] };
    return { content: JSON.stringify(body.messages).includes('[user steer] also say hi') ? 'saw the steer' : 'no steer' };
  });
  const srv = await serverFor(llm, ws, { permissionMode: 'yolo' });
  const client = await OhClient.connect(srv.url, srv.token);
  try {
    const s = await client.createSession({ mode: 'yolo' });
    const p = client.prompt(s.sessionId, 'sleep');
    await new Promise((r) => setTimeout(r, 300));
    await client.steer(s.sessionId, 'also say hi');
    assert.equal((await p).finalText, 'saw the steer');
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
  // stdio: same methods, no token
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: any[] = [];
  output.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  const llm2 = await startMockServer(() => ({ content: 'stdio ok' }));
  const cfg = testConfig(llm2.url, { checkpoints: { enabled: false } });
  const done = serveStdio({ workspace: ws, config: cfg, configFor: () => cfg, input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/create', params: {} }) + '\n');
  await new Promise((r) => setTimeout(r, 500));
  const sid = lines.find((l) => l.id === 1)?.result?.sessionId;
  assert.ok(sid);
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, text: 'hi' } }) + '\n');
  for (let i = 0; i < 50 && !lines.some((l) => l.id === 2); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines.find((l) => l.id === 2).result.finalText, 'stdio ok');
  assert.ok(lines.some((l) => l.method === 'session/event' && l.params.event.type === 'run_end'));
  input.end();
  await done;
  await llm2.close();
});

test('G2: abort stops a running command; checkpoints list/restore and session/load work over the protocol', async () => {
  const ws = tmpWorkspace({ 'keep.txt': 'k\n' });
  const llm = await startMockServer((body) => {
    const last = body.messages.at(-1);
    if (last.role !== 'user') return { content: 'done' };
    const first = String(last.content);
    if (first.startsWith('write')) return { toolCalls: [{ name: 'write_file', arguments: { path: 'new.txt', content: 'created\n' } }] };
    if (first.startsWith('sleep')) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 20' } }] };
    return { content: 'hello again' };
  });
  const config = testConfig(llm.url, { agent: { requireVerification: false } });
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (w, o) => ({ ...testConfig(llm.url, { agent: { requireVerification: false }, ...o }), homeDir: config.homeDir }) });
  const client = await OhClient.connect(srv.url, srv.token);
  try {
    const s = await client.createSession({ mode: 'yolo' });
    assert.equal((await client.prompt(s.sessionId, 'write new.txt')).stopReason, 'end_turn');
    assert.ok(fs.existsSync(path.join(ws, 'new.txt')));
    const cps = (await client.request('checkpoints/list', { sessionId: s.sessionId })).checkpoints;
    const turn = cps.filter((c: any) => c.kind === 'turn').at(-1); // newest first: the last one is before the first turn
    assert.ok(turn, 'a turn checkpoint was taken');
    const restored = await client.request('checkpoints/restore', { sessionId: s.sessionId, id: turn.id, scope: 'files' });
    assert.ok(restored.removed.includes('new.txt'));
    assert.ok(!fs.existsSync(path.join(ws, 'new.txt')) && fs.existsSync(path.join(ws, 'keep.txt')));
    // abort a long command
    const t0 = Date.now();
    const p = client.prompt(s.sessionId, 'sleep please');
    await new Promise((r) => setTimeout(r, 800));
    assert.deepEqual(await client.abort(s.sessionId), { aborted: true });
    assert.equal((await p).stopReason, 'aborted');
    assert.ok(Date.now() - t0 < 10_000);
    // load the saved journal into a new live session
    await client.request('session/delete', { sessionId: s.sessionId });
    const loaded = await client.request('session/load', { sessionId: s.sessionId, workspace: ws });
    assert.notEqual(loaded.sessionId, s.sessionId);
    const live = srv.host.get(loaded.sessionId);
    assert.ok(live.agent.messages.some((m) => m.role === 'user' && String(m.content).startsWith('write new.txt')));
    await assert.rejects(client.request('session/load', { sessionId: 'nope', workspace: ws }), /no saved session/);
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
});

// ------------------------------------------------------------ H5 remote agents

function fixtureRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-remote-origin-')));
  fs.writeFileSync(path.join(dir, 'greet.py'), 'def greet(name):\n    return "Hello " + nam\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

test('H5 AC1: loopback: the client starts a run on a local tug serve, the run edits a server-side clone, the patch comes back and is applied', async () => {
  const origin = fixtureRepo();
  const local = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-remote-local-')));
  execFileSync('git', ['clone', '-q', origin, local], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  const llm = await startMockServer((body, i) => {
    if (i === 0) {
      assert.ok(!String(body.messages[0].content).includes(local), 'the run happens in a server-side workspace');
      return { toolCalls: [{ name: 'read_file', arguments: { path: 'greet.py' } }] };
    }
    if (i === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'greet.py', old_string: '"Hello " + nam', new_string: '"Hello " + name' } }] };
    if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -c "import greet; print(greet.greet(\'x\'))"' } }] };
    return { content: 'Fixed the NameError in greet.py.' };
  });
  const serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-remote-home-'));
  const config = testConfig(llm.url, { homeDir: serverHome, checkpoints: { enabled: false }, server: { remote: { enabled: true, allowLocalRepos: true } } });
  const srv = await startServer({ workspace: serverHome, config, port: 0, configFor: (ws, o) => ({ ...testConfig(llm.url, { checkpoints: { enabled: false }, ...o }), homeDir: serverHome }) });
  const perms: string[] = [];
  const logs: string[] = [];
  try {
    const r = await runRemoteClient({
      server: srv.url,
      token: srv.token,
      prompt: 'fix greet.py',
      cwd: local,
      apply: 'ask',
      confirm: async (q) => (logs.push(q), true),
      handlers: { onPermission: (_s, req) => (perms.push(req.title), { decision: 'allow' }) },
      log: (s) => logs.push(s),
    });
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(r.applied, true, r.reason);
    assert.deepEqual(r.result.files, ['greet.py']);
    assert.match(r.result.stat, /greet\.py \| 2 \+-/);
    assert.equal(fs.readFileSync(path.join(local, 'greet.py'), 'utf8'), 'def greet(name):\n    return "Hello " + name\n');
    assert.equal(fs.readFileSync(path.join(origin, 'greet.py'), 'utf8').includes('nam\n'), true, 'the origin repo is untouched');
    assert.equal(perms.length, 1, 'the bash command was approved by the remote client (acceptEdits: edits auto, commands ask)');
    assert.ok(logs.some((l) => /Apply 1 changed file/.test(l)));
    assert.deepEqual(fs.readdirSync(path.join(serverHome, 'remote-workspaces')), [], 'server-side clone removed');
    assert.equal(srv.host.sessions.size, 0);
  } finally {
    await srv.close();
    await llm.close();
  }
});

test('H5 AC2: the token is required; remote runs are off by default; local repos need explicit opt-in', async () => {
  const origin = fixtureRepo();
  const llm = await startMockServer(() => ({ content: 'x' }));
  const ws = tmpWorkspace({});
  let srv = await serverFor(llm, ws);
  try {
    await assert.rejects(runRemoteClient({ server: srv.url, token: 'nope', prompt: 'p', cwd: ws, repo: origin, apply: 'no' }), /authentication failed/);
    await assert.rejects(runRemoteClient({ server: srv.url, token: srv.token, prompt: 'p', cwd: ws, repo: origin, apply: 'no' }), /remote runs are disabled/);
  } finally {
    await srv.close();
  }
  srv = await serverFor(llm, ws, { server: { remote: { enabled: true } } });
  try {
    await assert.rejects(runRemoteClient({ server: srv.url, token: srv.token, prompt: 'p', cwd: ws, repo: origin, apply: 'no' }), /local repositories are not allowed/);
    await assert.rejects(runRemoteClient({ server: srv.url, token: srv.token, prompt: 'p', cwd: ws, repo: 'ext::sh -c touch% /tmp/pwned', apply: 'no' }), /not allowed|unsupported/);
  } finally {
    await srv.close();
    await llm.close();
  }
});
