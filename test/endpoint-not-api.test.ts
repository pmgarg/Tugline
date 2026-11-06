/**
 * A base URL that is a chat website's address, not its API: the server answers with a web page. Users saw
 * "Unexpected token '<', "<!doctype "... is not valid JSON" under "Can't reach". Tugline must say what happened,
 * and point to the API on the same server when it can find it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LLMClient, LLMError } from '../src/core/llm/client.js';

const PAGE = '<!doctype html><html><head><title>Company AI</title></head><body><div id="app"></div></body></html>';

async function server(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const s = http.createServer(handle);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) };
}

const page = (res: http.ServerResponse, status = 200) => (res.writeHead(status, { 'content-type': 'text/html' }), res.end(PAGE));
const client = (baseUrl: string) => new LLMClient({ name: 't', baseUrl, apiKey: 'k', model: 'm1', contextWindow: 8192, maxOutputTokens: 256, toolMode: 'auto', vision: false, timeoutMs: 10_000 });

async function rejection(p: Promise<unknown>): Promise<LLMError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof LLMError, `an LLMError, not ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
    return e;
  }
  assert.fail('expected a rejection');
}

test('not-api: a chat website at the base URL is reported as a web page, and the API found on the same server is suggested', async () => {
  // a typical company deployment: the chat app at /, the OpenAI-compatible API at /v1
  const s = await server((req, res) => {
    if (req.url === '/v1/models') return void (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] })));
    page(res); // single-page apps answer every path with their index.html
  });
  try {
    const e = await rejection(client(s.url).listModels());
    assert.equal(e.kind, 'not_api');
    assert.doesNotMatch(e.message, /Unexpected token|not valid JSON/);
    assert.match(e.message, /answered with a web page, not an OpenAI-compatible API/);
    assert.equal(e.suggestedBaseUrl, `${s.url}/v1`);
    assert.match(e.message, new RegExp(`${s.url}/v1 answers as an API \\(2 models\\): use that as the base URL`));
    assert.deepEqual(await client(e.suggestedBaseUrl!).listModels(), ['m1', 'm2'], 'the suggestion works');
  } finally {
    await s.close();
  }
});

test('not-api: with no API to be found, the message says what a base URL looks like; an HTML error page reads the same', async () => {
  const s = await server((req, res) => page(res, req.url === '/models' ? 404 : 200));
  try {
    const e = await rejection(client(s.url).listModels());
    assert.equal(e.kind, 'not_api');
    assert.equal(e.suggestedBaseUrl, undefined);
    assert.match(e.message, /Use the API's base URL, not the chat website's address\. It usually ends in \/v1/);
  } finally {
    await s.close();
  }
});

test('not-api: a redirect to another server (a sign-in page) is named', async () => {
  const login = await server((_req, res) => page(res));
  const s = await server((_req, res) => (res.writeHead(302, { location: `${login.url}/login?next=/models` }), res.end()));
  try {
    const e = await rejection(client(s.url).listModels());
    assert.equal(e.kind, 'not_api');
    assert.match(e.message, new RegExp(`it redirected to ${login.url}, probably a sign-in page`));
  } finally {
    await s.close();
    await login.close();
  }
});

test('not-api: a chat request that gets a web page fails with the same plain message, not a JSON parse error', async () => {
  const s = await server((_req, res) => page(res));
  try {
    const e = await rejection(client(s.url).complete({ messages: [{ role: 'user', content: 'hi' }] }));
    assert.equal(e.kind, 'not_api');
    assert.match(e.message, /answered with a web page/);
  } finally {
    await s.close();
  }
});

test('not-api: the VS Code setup card is told it is a web page, with the API address to click', async () => {
  const { setupCheck } = await import('../vscode/src/onboarding.js');
  const s = await server((req, res) => {
    if (req.url === '/api/models') return void (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ data: [{ id: 'llama-3.3-70b' }] })));
    page(res);
  });
  try {
    const v = await setupCheck({ baseUrl: s.url, model: 'llama-3.3-70b' }, { candidates: [] });
    assert.equal(v?.state, 'unreachable');
    assert.equal(v?.notApi, true);
    assert.equal(v?.suggestBaseUrl, `${s.url}/api`);
  } finally {
    await s.close();
  }
});
