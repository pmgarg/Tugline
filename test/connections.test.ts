/**
 * Saved connections (the panel's connection manager): keys and header values live in secret storage, one entry per
 * connection, and stay with the server they were saved for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInput, ConnectionStore, defaultName, friendly, PROVIDERS, providerFor, type MementoLike, type SecretsLike } from '../vscode/src/connections.js';

import { governedConfig, clientProfile } from '../vscode/src/settingsConfig.js';
import { tmpWorkspace } from './helpers.js';

function fakes() {
  const state = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento: MementoLike = { get: <T>(k: string) => state.get(k) as T | undefined, update: async (k, v) => void (v === undefined ? state.delete(k) : state.set(k, JSON.parse(JSON.stringify(v)))) };
  const sec: SecretsLike = { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) };
  return { state, secrets, store: new ConnectionStore(memento, sec) };
}

test('connections: a saved connection keeps its key in secret storage, never in the list', async () => {
  const { state, secrets, store } = fakes();
  const { connection } = await store.save({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/', model: 'qwen/qwen3-coder', apiKey: 'sk-or-123', contextWindow: 262144 });
  assert.equal(connection.baseUrl, 'https://openrouter.ai/api/v1', 'trailing slash removed');
  assert.equal(connection.name, 'OpenRouter');
  assert.equal(connection.contextWindow, 262144);
  assert.equal(await store.key(connection.id), 'sk-or-123');
  assert.doesNotMatch(JSON.stringify(state.get('tugline.connections.v1')), /sk-or-123/);
  assert.deepEqual([...secrets.keys()], [`tugline.connection.${connection.id}.key`]);
  const [v] = await store.views();
  assert.equal(v.hasKey, true);
  assert.equal(v.host, 'openrouter.ai');
  assert.equal((v as any).apiKey, undefined);
});

test('connections: moving a connection to another server drops its key and header values unless new ones are typed', async () => {
  const { store } = fakes();
  const { connection: c } = await store.save({ baseUrl: 'https://ai.corp.example/v1', model: 'm', apiKey: 'corp-key', headers: [{ name: 'X-Team', value: 'secret-team' }] });
  // same server, other path: the key and headers stay
  const same = await store.save({ ...c, baseUrl: 'https://ai.corp.example/api', headers: [{ name: 'X-Team' }] });
  assert.equal(same.dropped, false);
  assert.equal(await store.key(c.id), 'corp-key');
  assert.deepEqual(await store.headers(c.id), { 'X-Team': 'secret-team' });
  // another server: dropped, and the caller is told
  const moved = await store.save({ ...c, baseUrl: 'https://evil.example/v1', headers: [{ name: 'X-Team' }] });
  assert.equal(moved.dropped, true);
  assert.equal(await store.key(c.id), '');
  assert.deepEqual(await store.headers(c.id), {});
  assert.equal(moved.connection.headerNames, undefined);
  // another server with a new key typed: kept
  const typed = await store.save({ ...moved.connection, baseUrl: 'https://other.example/v1', apiKey: 'new-key' });
  assert.equal(typed.dropped, false);
  assert.equal(await store.key(c.id), 'new-key');
});

test('connections: switching, deleting (not the active one) and duplicating', async () => {
  const { secrets, store } = fakes();
  const a = (await store.save({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' })).connection;
  const b = (await store.save({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'ds' })).connection;
  assert.equal(a.provider, 'ollama');
  assert.equal(b.name, 'DeepSeek');
  await store.setActive(b.id);
  assert.equal(store.activeId(), b.id);
  await assert.rejects(store.remove(b.id), /Switch to another connection/);
  const copy = await store.duplicate(b.id);
  assert.equal(copy.name, 'DeepSeek (copy)');
  assert.equal(await store.key(copy.id), 'ds', 'the copy has its own copy of the key');
  await store.setActive(a.id);
  await store.remove(b.id);
  assert.deepEqual(store.list().map((c) => c.id), [a.id, copy.id]);
  assert.equal(secrets.has(`tugline.connection.${b.id}.key`), false, 'its key is deleted with it');
});

test('connections: the endpoint already configured becomes the first connection, once', async () => {
  const { store } = fakes();
  const c = await store.seed({ baseUrl: 'https://chat.corp.example/api', model: 'llama-3.3-70b', toolMode: 'auto' }, 'corp-key', { 'X-Org': 'o1' });
  assert.ok(c);
  assert.equal(c!.provider, 'openwebui');
  assert.equal(c!.name, 'chat.corp.example');
  assert.equal(store.activeId(), c!.id);
  assert.equal(await store.key(c!.id), 'corp-key');
  assert.deepEqual(await store.headers(c!.id), { 'X-Org': 'o1' });
  assert.equal(await store.seed({ baseUrl: 'http://x/v1', model: 'y' }, ''), undefined);
  assert.equal(store.list().length, 1);
});

test('connections: a changed model or server forgets the last test; the same one keeps it', async () => {
  const { store } = fakes();
  const c = (await store.save({ baseUrl: 'http://localhost:1234/v1', model: 'a' })).connection;
  await store.setLastTest(c.id, { ok: true, at: 1, latencyMs: 300, tools: 'native' });
  assert.equal((await store.save({ ...store.get(c.id)!, name: 'LM' })).connection.lastTest?.ok, true);
  assert.equal((await store.save({ ...store.get(c.id)!, model: 'b' })).connection.lastTest, undefined);
});

test('connections: the form is checked before anything is saved', () => {
  assert.match(checkInput({ baseUrl: 'ai.example.com', model: 'm' })!, /http:\/\/ or https:\/\//);
  assert.match(checkInput({ baseUrl: 'https://ai.example.com/v1', model: ' ' })!, /Choose a model/);
  assert.match(checkInput({ baseUrl: 'https://a/v1', model: 'm', headers: [{ name: 'Bad Header', value: 'x' }] })!, /not a valid header name/);
  assert.match(checkInput({ baseUrl: 'https://a/v1', model: 'm', headers: [{ name: 'Content-Type', value: 'x' }] })!, /set by Tugline itself/);
  assert.match(checkInput({ baseUrl: 'https://a/v1', model: 'm', headers: [{ name: 'X-A', value: 'a\r\nInjected: 1' }] })!, /one line/);
  assert.equal(checkInput({ baseUrl: 'https://a/v1', model: 'm', headers: [{ name: 'X-Api-Key', value: 'k' }] }), undefined);
});

test('connections: providers and names', () => {
  assert.equal(providerFor('http://localhost:11434/v1/'), 'ollama');
  assert.equal(providerFor('http://127.0.0.1:1234/v1'), 'lmstudio');
  assert.equal(providerFor('https://openrouter.ai/api/v1'), 'openrouter');
  assert.equal(providerFor('https://chat.corp.example/api'), 'openwebui');
  assert.equal(providerFor('http://gpu-7:8000/v1'), 'company');
  assert.equal(defaultName('company', 'http://gpu-7:8000/v1'), 'gpu-7');
  for (const p of PROVIDERS) {
    assert.ok(p.mark && p.name && p.blurb, p.id);
    if (p.baseUrl) assert.match(p.baseUrl, /^https?:\/\//, p.id);
    if (p.keyUrl) assert.match(p.keyUrl, /^https:\/\//, p.id);
  }
});

test('connections: the active connection\'s secret headers reach the model profile', () => {
  const ws = tmpWorkspace({});
  const get = (k: string) => ({ baseUrl: 'https://gw.example/v1', model: 'm', extraHeaders: { 'X-Plain': '1' } } as any)[k];
  const cfg = governedConfig({ workspace: ws, get, apiKey: 'k', secretHeaders: { 'X-Team': 't' }, noUserConfig: true });
  assert.deepEqual(clientProfile(cfg).headers, { 'X-Plain': '1', 'X-Team': 't' });
});

test('connections: failures read as what to do next', () => {
  const u = 'http://gpu-7:8000/v1';
  assert.match(friendly(new Error('fetch failed: connect ECONNREFUSED 10.0.0.7:8000'), u), /Nothing answers at gpu-7:8000/);
  assert.match(friendly(new Error('getaddrinfo ENOTFOUND gpu-7'), u), /could not be found.*VPN/);
  assert.match(friendly(new Error('GET /models failed: 401 {"error":"bad key"}'), u), /refused the API key/);
  assert.match(friendly(new Error('self-signed certificate in certificate chain'), u), /NODE_EXTRA_CA_CERTS/);
  assert.match(friendly(new Error('GET /models failed: 404 Not Found'), u), /ends in \/v1/);
  assert.equal(friendly(new Error('something else'), u), 'something else');
});

test('connections: a stale value echoed back by globalState after two quick writes does not lose a connection', async () => {
  // VS Code's Memento can briefly return the value of an earlier write (the main process echoes it after a later one)
  const state = new Map<string, unknown>();
  const memento: MementoLike = {
    get: <T>(k: string) => state.get(k) as T | undefined,
    update: async (k, v) => {
      const before = state.get(k);
      state.set(k, JSON.parse(JSON.stringify(v)));
      // the echo of the previous write lands after this one
      if (before !== undefined) queueMicrotask(() => state.set(k, before));
    },
  };
  const secrets = new Map<string, string>();
  const store = new ConnectionStore(memento, { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k) });
  const a = (await store.save({ baseUrl: 'http://a.example/v1', model: 'm1' })).connection;
  await store.setActive(a.id);
  const b = (await store.save({ baseUrl: 'http://b.example/v1', model: 'm2' })).connection;
  await store.save({ ...store.get(a.id)!, model: 'm1b' });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(store.list().map((c) => [c.id, c.model]), [[a.id, 'm1b'], [b.id, 'm2']]);
  await store.setActive(b.id);
  await store.setActive(a.id);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.activeId(), a.id);
  assert.equal(store.get(b.id)?.model, 'm2', 'the store hands out copies: callers cannot change it by accident');
});
