/**
 * WS2 follow-ups: slash commands in the VS Code chat go through the core
 * registry (SPEC S0.6) — /rewind (C1) and /usage (C7) included — and the MCP
 * manager's "Log in (OAuth)" button uses the G3 core flow (mock auth server).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import '../src/core/tools/providers.js';
import { getSlashCommand, slashCommands } from '../src/core/commands.js';
import { oauthStoreFile } from '../src/core/mcp/oauth.js';
import { checkpointsFor } from '../src/core/checkpoint/index.js';
import { dispatchSlash, slashItems, type SlashDeps } from '../vscode/src/slash.js';
import { loginMcpServer, logoutMcpServer } from '../vscode/src/mcpAuth.js';
import { readConfigFile } from '../vscode/src/configEdit.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const NO_MAP = { agent: { repoMapTokens: 0 } };

function deps(agent: Agent, over: Partial<SlashDeps> = {}): SlashDeps & { out: string[]; chats: number; models: string[] } {
  // tsx loads vscode/src as CommonJS: hand it this (ESM) registry instance; the extension bundle has one instance.
  const d: any = { agent, out: [] as string[], chats: 0, models: [] as string[], registry: { get: getSlashCommand, list: slashCommands } };
  d.write = (t: string) => d.out.push(t);
  d.newChat = () => d.chats++;
  d.setModel = (c: string) => void d.models.push(c);
  return Object.assign(d, over);
}

test('S0.6 (VS Code): /usage (C7) and /rewind (C1) run through the core registry from the chat', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'v1\n' });
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : i === 1 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: 'v2\n' } }] } : { content: 'done' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...NO_MAP, permissionMode: 'yolo' }), mcp: false });
  await agent.run('bump a.txt');
  await srv.close();
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v2\n');
  const d = deps(agent);
  const u = await dispatchSlash('/usage', d);
  assert.ok(u.handled && !u.prompt);
  assert.match(d.out.join('\n'), /Usage since .*\n[\s\S]*Per model[\s\S]*mock-model/, 'the C7 ledger report');
  d.out.length = 0;
  const turns = await checkpointsFor(agent.config, ws).turns(agent.sessionId);
  const first = turns[turns.length - 1];
  const r = await dispatchSlash(`/rewind ${first.id} files`, d);
  assert.equal(r.handled, true);
  assert.match(d.out.join('\n'), /rewound to \w+ \(turn 1: bump a\.txt/);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'v1\n', 'files restored by the C1 command');
  d.out.length = 0;
  await dispatchSlash('/rewind', d);
  assert.match(d.out.join('\n'), /usage: \/rewind/, 'no argument lists checkpoints');
});

test('S0.6 (VS Code): built-ins, skills, /help with registered commands, unknown commands, and paths are not commands', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false, bundledSkillsDir: path.resolve('skills') });
  try {
  const d = deps(agent);
  await dispatchSlash('/help', d);
  const help = d.out.join('\n');
  for (const c of ['/clear', '/mode', '/model', '/compact', '/rewind', '/usage', '/context']) assert.ok(help.includes(c), `help lists ${c}`);
  assert.match(help, /run a skill: .*skill-creator/);
  await dispatchSlash('/mode plan', d);
  assert.equal(agent.policy.mode, 'plan');
  await dispatchSlash('/clear', d);
  assert.equal(d.chats, 1, '/clear starts a new chat');
  await dispatchSlash('/model other-model', d);
  assert.deepEqual(d.models, ['model:other-model']);
  await dispatchSlash('/model default', d);
  assert.deepEqual(d.models, ['model:other-model', 'profile:default']);
  const sk = await dispatchSlash('/code-review the parser', d);
  assert.deepEqual(sk, { handled: true, prompt: 'Use the "code-review" skill (call load_skill first). the parser' });
  d.out.length = 0;
  assert.deepEqual(await dispatchSlash('/nope', d), { handled: true });
  assert.match(d.out[0], /unknown command \/nope/);
  assert.deepEqual(await dispatchSlash('/usr/bin/python crashes', d), { handled: false });
  assert.deepEqual(await dispatchSlash('fix /etc', d), { handled: false });
  // a registered command that returns { prompt } sends it (D9 /goal without a check runs the agent loop itself; /context returns nothing)
  d.out.length = 0;
  const ctx = await dispatchSlash('/context', d);
  assert.equal(ctx.handled, true);
  assert.match(d.out.join('\n'), /system prompt\s+\d+ tok/);
  // composer autocomplete
  const items = slashItems(agent, 're', slashCommands).map((i) => i.insert.trim());
  assert.ok(items.includes('/rewind'), JSON.stringify(items));
  assert.ok(slashItems(agent, '', slashCommands).some((i) => i.insert.trim() === '/usage'));
  assert.ok(slashItems(agent, 'code', slashCommands).some((i) => i.insert.trim() === '/code-review' && /skill/.test(i.detail ?? '')));
  } finally {
    await srv.close();
    await agent.dispose();
  }
});

// ------------------------------------------------------------ MCP OAuth (G3 core flow) from the manager button

async function startMockAuth(): Promise<{ base: string; stats: { registered: number; tokens: number }; close: () => Promise<void> }> {
  const stats = { registered: 0, tokens: 0 };
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const clients = new Map<string, string[]>();
  let base = '';
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((r) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => r(s));
    });
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', base);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] });
    if (u.pathname.startsWith('/.well-known/oauth-authorization-server') || u.pathname.startsWith('/.well-known/openid-configuration'))
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true });
    if (u.pathname === '/register' && req.method === 'POST') {
      const meta = JSON.parse(await readBody(req));
      const id = `client-${++stats.registered}`;
      clients.set(id, meta.redirect_uris);
      return json(res, 201, { ...meta, client_id: id });
    }
    if (u.pathname === '/authorize') {
      const redirect = u.searchParams.get('redirect_uri')!;
      // RFC 8252 §7.3: loopback redirects may use any port (a later login reuses the registration on a new port)
      const noPort = (x: string) => x.replace(/^(http:\/\/127\.0\.0\.1):\d+/, '$1');
      if (!clients.get(u.searchParams.get('client_id')!)?.some((x) => noPort(x) === noPort(redirect)) || u.searchParams.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect });
      const to = new URL(redirect);
      to.searchParams.set('code', code);
      to.searchParams.set('state', u.searchParams.get('state') ?? '');
      to.searchParams.set('iss', base);
      res.writeHead(302, { Location: to.href });
      return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await readBody(req));
      const c = codes.get(p.get('code') ?? '');
      if (!c || c.challenge !== crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url') || c.redirect !== p.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
      stats.tokens++;
      return json(res, 200, { access_token: 'at-vscode-1', token_type: 'Bearer', expires_in: 3600 });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { base, stats, close: () => new Promise((r) => server.close(() => r())) };
}

test('B11 (G3): "Log in (OAuth)" runs the core OAuth flow, opens the browser through the injected opener, stores 0600 tokens and enables oauth for a user server', async () => {
  const auth = await startMockAuth();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-oauth-vsc-'));
  const userFile = path.join(home, 'config.json');
  fs.writeFileSync(userFile, JSON.stringify({ mcpServers: { remote: { url: `${auth.base}/mcp` } } }));
  try {
    const opened: string[] = [];
    // stands in for vscode.env.openExternal: the "browser" follows the redirect to the loopback callback
    const openUrl = async (url: URL) => {
      opened.push(url.href);
      const r1 = await fetch(url, { redirect: 'manual' });
      assert.equal(r1.status, 302, `authorize: ${r1.status} ${await r1.clone().text()}`);
      const r2 = await fetch(r1.headers.get('location')!);
      assert.equal(r2.status, 200);
    };
    const servers = { remote: { url: `${auth.base}/mcp` }, local: { command: 'node', args: ['x.mjs'] } };
    const r = await loginMcpServer('remote', servers, 'user', { homeDir: home, userFile, openUrl, timeoutMs: 10_000 });
    assert.equal(opened.length, 1);
    assert.equal(new URL(opened[0]).searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.stats.tokens, 1);
    assert.equal(r.tokenFile, oauthStoreFile(home, 'remote'));
    assert.equal(JSON.parse(fs.readFileSync(r.tokenFile, 'utf8')).tokens.access_token, 'at-vscode-1');
    if (process.platform !== 'win32') assert.equal(fs.statSync(r.tokenFile).mode & 0o777, 0o600);
    assert.equal(r.enabledOAuth, true);
    assert.equal(readConfigFile(userFile).mcpServers.remote.oauth, true, 'sessions now use the stored tokens');
    assert.match(r.message, /Logged in to remote/);
    await assert.rejects(loginMcpServer('local', servers, 'user', { homeDir: home, userFile, openUrl, timeoutMs: 1000 }), /stdio server/);
    await assert.rejects(loginMcpServer('nope', servers, 'user', { homeDir: home, userFile, openUrl }), /unknown MCP server/);
    // a project server is not rewritten into the user config; the message tells the user what to add
    const p = await loginMcpServer('remote', servers, 'project', { homeDir: home, userFile: path.join(home, 'other.json'), openUrl, timeoutMs: 10_000 });
    assert.equal(p.enabledOAuth, false);
    assert.match(p.message, /Add "oauth": true/);
    assert.match(logoutMcpServer('remote', home), /Removed the stored tokens/);
    assert.equal(fs.existsSync(r.tokenFile), false);
    assert.match(logoutMcpServer('remote', home), /No stored tokens/);
  } finally {
    await auth.close();
  }
});
