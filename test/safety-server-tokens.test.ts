/** R16: `tug serve` per-client tokens: a client can address only the sessions it created. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../src/server/server.js';
import { OhClient } from '../src/server/client.js';
import { TokenStore } from '../src/server/tokens.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

async function setup() {
  const ws = tmpWorkspace({});
  const llm = await startMockServer(() => ({ content: 'ok' }));
  const config = testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false } });
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (_w, o) => ({ ...testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false }, ...o }), homeDir: config.homeDir }) });
  return { ws, llm, srv, store: TokenStore.forHome(config.homeDir) };
}

const SESSION_METHODS: [string, (sid: string) => Record<string, unknown>][] = [
  ['session/prompt', (sid) => ({ sessionId: sid, text: 'hi' })],
  ['session/steer', (sid) => ({ sessionId: sid, text: 'x' })],
  ['session/enqueue', (sid) => ({ sessionId: sid, text: 'x' })],
  ['session/abort', (sid) => ({ sessionId: sid })],
  ['session/subscribe', (sid) => ({ sessionId: sid })],
  ['session/permissionReply', (sid) => ({ sessionId: sid, requestId: 'r', decision: 'allow' })],
  ['session/command', (sid) => ({ sessionId: sid, name: 'help' })],
  ['config/get', (sid) => ({ sessionId: sid })],
  ['config/set', (sid) => ({ sessionId: sid, key: 'permissionMode', value: 'auto' })],
  ['checkpoints/list', (sid) => ({ sessionId: sid })],
  ['jobs/list', (sid) => ({ sessionId: sid })],
  ['session/load', (sid) => ({ sessionId: sid })],
  ['session/delete', (sid) => ({ sessionId: sid })],
];

test('R16: a client token addresses only the sessions it created; another client sees them as unknown; the owner sees all', async () => {
  const { ws, llm, srv, store } = await setup();
  const a = store.issue('alice-laptop');
  const b = store.issue('bob-ci');
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes(a.token), 'tokens are stored hashed');
  const A = await OhClient.connect(srv.url, a.token);
  const B = await OhClient.connect(srv.url, b.token);
  const O = await OhClient.connect(srv.url, srv.token);
  try {
    const sa = await A.createSession({ workspace: ws });
    const sb = await B.createSession({ workspace: ws });
    // B cannot reach A's session through any session-addressed method, and the error is the same as for a missing id
    for (const [m, params] of SESSION_METHODS) {
      await assert.rejects(B.request(m, params(sa.sessionId)), (e: Error) => /unknown session|no saved session/.test(e.message), `${m} must be refused`);
      await assert.rejects(B.request(m, params('no-such-session')), (e: Error) => /unknown session|no saved session/.test(e.message));
    }
    // listing shows only one's own
    const la = await A.request('session/list', { workspace: ws });
    assert.deepEqual(la.live.map((s: any) => s.sessionId), [sa.sessionId]);
    const lb = await B.request('session/list', { workspace: ws });
    assert.deepEqual(lb.live.map((s: any) => s.sessionId), [sb.sessionId]);
    // A uses its own session normally, also from a second connection with the same token (reconnect)
    assert.equal((await A.prompt(sa.sessionId, 'hi')).stopReason, 'end_turn');
    const A2 = await OhClient.connect(srv.url, a.token);
    assert.ok((await A2.request('jobs/list', { sessionId: sa.sessionId })).jobs);
    A2.close();
    // the owner (server token) sees and addresses all
    const lo = await O.request('session/list', { workspace: ws });
    assert.deepEqual(lo.live.map((s: any) => s.sessionId).sort(), [sa.sessionId, sb.sessionId].sort());
    assert.ok((await O.request('jobs/list', { sessionId: sb.sessionId })).jobs);
    // saved journals: a client can reload only its own
    assert.ok(!(await B.request('session/list', { workspace: ws })).saved.some((s: any) => s.sessionId === sa.sessionId));
  } finally {
    A.close();
    B.close();
    O.close();
    await srv.close();
    await llm.close();
  }
});

test('R16: only the owner manages client tokens; a revoked token can no longer authenticate and its connections close', async () => {
  const { llm, srv, store } = await setup();
  const O = await OhClient.connect(srv.url, srv.token);
  try {
    const issued = await O.request('tokens/issue', { label: 'ci' });
    assert.match(issued.token, /^ohc_/);
    const C = await OhClient.connect(srv.url, issued.token);
    await assert.rejects(C.request('tokens/issue', { label: 'x' }), /only the server owner/);
    await assert.rejects(C.request('tokens/list', {}), /only the server owner/);
    const listed = await O.request('tokens/list', {});
    assert.ok(listed.tokens.some((t: any) => t.id === issued.id && !('hash' in t)), 'the list never returns hashes');
    const closed = new Promise<void>((r) => (C as any).ws.once('close', () => r()));
    assert.deepEqual(await O.request('tokens/revoke', { id: issued.id }), { revoked: true });
    await closed;
    await assert.rejects(OhClient.connect(srv.url, issued.token), /authentication failed/);
    assert.equal(store.verify(issued.token), undefined);
    await assert.rejects(OhClient.connect(srv.url, 'ohc_wrong'), /authentication failed/);
  } finally {
    O.close();
    await srv.close();
    await llm.close();
  }
});
