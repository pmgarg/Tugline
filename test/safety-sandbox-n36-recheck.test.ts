/**
 * WS18: the fixes for the re-check of ee8ac18 (docs/reviews/v1.2-WS18-recheck.md): RC-1 (the container-session
 * model relay must not forward off the configured endpoint), RC-2 (the project clamp compares with the effective
 * runner), RC-3 (Landlock's multiprocessing limit is explained), RC-4 (credentialReference false positives and
 * harder spellings). Each test is named `N36 RC<n>` and fails without its fix.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { buildUpstreamTarget, isAllowedMethod, MODEL_API_METHODS, MODEL_API_PATHS } from '../src/core/util/upstream.js';
import { relayHandler, relayTarget, type RelayRoute } from '../src/core/sandbox/container.js';
import { closeSandboxProxies, runnerAvailable, sandboxStatus, selectRunner } from '../src/core/sandbox/index.js';
import { landlockProbe } from '../src/core/sandbox/landlock.js';
import { loadConfig, defaultConfig } from '../src/core/config.js';
import { credentialReference } from '../src/core/permissions/credentials.js';
import { getCliCommand } from '../src/core/commands.js';
import { commandWrapperFor, execCommand, scrubbedEnv } from '../src/core/tools/shell.js';
import { Agent } from '../src/core/agent/agent.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, tmpWorkspace, trackTmp, lastToolResult } from './helpers.js';

after(() => closeSandboxProxies());

// ------------------------------------------------------------ RC-1: the relay

const ROUTES: RelayRoute[] = [
  { prefix: '/m0', origin: 'https://api.example.com', basePath: '/v1', headers: { authorization: 'Bearer K' } },
  { prefix: '/m1', origin: 'http://172.17.0.1:11434', basePath: '/', headers: { authorization: 'Bearer K' } },
];

/** every variant of the reviewer's relay-target and relay-live probes, plus encoded, doubled and mixed-case ones */
const REFUSED = [
  '/m0/v1/%2e%2e/admin',
  '/m0/v1/%2E%2E/%2e%2e/key/generate',
  '/m0/v1/.%2e/x',
  '/m0/v1/%2e./x',
  '/m0/v1/%2e',
  '/m0/v1//evil.example/x',
  '/m0/v1/\\..\\x',
  '/m0/v1/..',
  '/m0/v1/../admin',
  '/m0/v1/./chat/completions',
  '/m0/v1%2fchat/completions',
  '/m0/v1/chat%2Fcompletions',
  '/m0/v1/chat%5ccompletions',
  '/m0/v1/%252e%252e/admin',
  '/m0/admin',
  '/m0/v1x/chat/completions',
  '/m0/v1/admin',
  '/m0/v1/chat/completions#frag',
  '/m0/v1/chat/completions\t',
  '/m0http://evil.example/x',
  '/m1//evil.example/steal',
  '/m1/\\evil.example/steal',
  '/m1/%2F%2Fevil.example/x',
  '/m1/%2f%2fevil.example/x',
  '/m1/%5C%5Cevil.example/x',
  '/m1/api/pull',
  '/m1/api/delete',
  '/m1/api/../api/pull',
  '/m1///evil.example/x',
  '/m1/http://evil.example/x',
  '/m2/v1/chat/completions',
  '/x/v1/chat/completions',
];
const ACCEPTED: [string, string][] = [
  ['/m0/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
  ['/m0/v1/models', 'https://api.example.com/v1/models'],
  ['/m0/v1/models/gpt-4o-mini', 'https://api.example.com/v1/models/gpt-4o-mini'],
  ['/m0/v1/embeddings?x=1', 'https://api.example.com/v1/embeddings?x=1'],
  ['/m1/api/chat', 'http://172.17.0.1:11434/api/chat'],
  ['/m1/api/tags', 'http://172.17.0.1:11434/api/tags'],
  ['/m1/v1/chat/completions', 'http://172.17.0.1:11434/v1/chat/completions'],
];

test('N36 RC1: buildUpstreamTarget / relayTarget refuse every off-endpoint variant (encoded dots and slashes, protocol-relative, backslash, dot segments, other paths)', () => {
  for (const u of REFUSED) {
    const t = relayTarget(ROUTES, u);
    assert.ok('error' in t, `${u} was accepted: ${'target' in t ? t.target.href : ''}`);
  }
  for (const [u, want] of ACCEPTED) {
    const t = relayTarget(ROUTES, u);
    assert.ok('target' in t, `${u} refused: ${'error' in t ? t.error : ''}`);
    assert.equal(t.target.href, want);
    assert.equal(t.target.origin, new URL(t.route.origin).origin);
  }
  // the shared function on its own (the signature WS17's metering proxy uses)
  const r = { origin: 'https://api.example.com', basePath: '/v1' };
  assert.equal(buildUpstreamTarget(r, '/v1/chat/completions').ok, true);
  for (const bad of ['http://evil/x', '//evil/x', '/v1/%2e%2e/x', '/v1/../x', '/v1\\x', 'v1/chat/completions', '']) assert.equal(buildUpstreamTarget(r, bad).ok, false, bad);
  // a caller may pass its own path list, or none (then only origin and base path are enforced)
  assert.equal(buildUpstreamTarget(r, '/v1/anything', null).ok, true);
  assert.equal(buildUpstreamTarget(r, '/v1/anything', MODEL_API_PATHS).ok, false);
  // encoded separators are refused even when no path list applies (an upstream that decodes %2f would see "../admin")
  for (const enc of ['/v1/x%2f..%2fadmin', '/v1/x%2F..%2Fadmin', '/v1/x%5c..%5cadmin', '/v1/%2e%2e', '/v1/x%252f..%252fadmin']) assert.equal(buildUpstreamTarget(r, enc, null).ok, false, enc);
});

test('N36 RC1: the live relay never reaches another origin or path, never adds the key off-endpoint, and never follows a redirect', async () => {
  const seen: { who: string; url?: string; auth?: string }[] = [];
  const evil = http.createServer((req, res) => (seen.push({ who: 'evil', url: req.url, auth: req.headers.authorization }), res.end('EVIL')));
  await new Promise<void>((r) => evil.listen(0, '127.0.0.1', () => r()));
  const eport = (evil.address() as any).port;
  const model = http.createServer((req, res) => {
    seen.push({ who: 'model', url: req.url, auth: req.headers.authorization });
    if (req.url === '/v1/models') return void res.writeHead(302, { location: `http://127.0.0.1:${eport}/steal` }).end();
    res.end('MODEL-OK');
  });
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
  const mport = (model.address() as any).port;
  const routes: RelayRoute[] = [
    { prefix: '/m0', origin: `http://127.0.0.1:${mport}`, basePath: '/v1', headers: { authorization: 'Bearer sk-REAL' } },
    { prefix: '/m1', origin: `http://127.0.0.1:${mport}`, basePath: '/', headers: { authorization: 'Bearer sk-REAL' } },
  ];
  const relay = http.createServer(relayHandler(routes));
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  const rport = (relay.address() as any).port;
  // a raw request line, so nothing on our side normalises the path first
  const raw = (p: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(rport, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer agent-supplied\r\nConnection: close\r\n\r\n`));
      let b = '';
      s.on('data', (d: Buffer) => (b += d));
      s.on('end', () => resolve(b.split('\r\n')[0] ?? ''));
      s.on('error', (e: Error) => resolve(`err ${e.message}`));
    });
  try {
    for (const p of [`/m1//127.0.0.1:${eport}/steal`, `/m1/%2f%2f127.0.0.1:${eport}/steal`, '/m0/v1/%2e%2e/admin', '/m0/v1/../admin', '/m0/v1/.%2E/admin', '/m1/admin', '/m1/api/pull', `/m1/\\127.0.0.1:${eport}/steal`]) {
      const status = await raw(p);
      assert.match(status, / 40\d /, `${p}: ${status}`);
    }
    assert.match(await raw('/m0/v1/chat/completions'), / 200 /);
    assert.match(await raw('/m0/v1/models'), / 502 /, 'a redirect is not passed on');
    assert.deepEqual(seen.filter((s) => s.who === 'evil'), [], 'nothing reached another origin');
    assert.deepEqual([...new Set(seen.map((s) => s.url))].sort(), ['/v1/chat/completions', '/v1/models'], 'only model API paths reached the model');
    assert.ok(seen.every((s) => s.auth === 'Bearer sk-REAL'), 'the agent cannot pick the credentials; the relay adds its own');
  } finally {
    relay.close();
    model.close();
    evil.close();
  }
});

test('N36 RC1g: only GET, HEAD and POST are forwarded (shared check in upstream.ts; DELETE, PUT, PATCH, OPTIONS, TRACE refused)', async () => {
  const r = { origin: 'https://api.example.com', basePath: '/v1' };
  for (const m of ['GET', 'HEAD', 'POST']) assert.equal(buildUpstreamTarget(r, '/v1/models', MODEL_API_PATHS, m).ok, true, m);
  for (const m of ['DELETE', 'PUT', 'PATCH', 'OPTIONS', 'TRACE', 'CONNECT', 'get', 'PROPFIND', '']) {
    assert.equal(buildUpstreamTarget(r, '/v1/models', MODEL_API_PATHS, m).ok, false, m);
    assert.equal(isAllowedMethod(m), false, m);
  }
  assert.deepEqual([...MODEL_API_METHODS].sort(), ['GET', 'HEAD', 'POST']);
  assert.equal(buildUpstreamTarget(r, '/v1/models').ok, true, 'the three-argument signature is unchanged (no method check)');
  // the live relay
  const seen: string[] = [];
  const model = http.createServer((req, res) => (seen.push(`${req.method} ${req.url}`), res.end('ok')));
  await new Promise<void>((x) => model.listen(0, '127.0.0.1', () => x()));
  const relay = http.createServer(relayHandler([{ prefix: '/m0', origin: `http://127.0.0.1:${(model.address() as any).port}`, basePath: '/v1', headers: { authorization: 'Bearer K' } }]));
  await new Promise<void>((x) => relay.listen(0, '127.0.0.1', () => x()));
  const rport = (relay.address() as any).port;
  const call = (method: string) => new Promise<number>((res) => http.request({ host: '127.0.0.1', port: rport, path: '/m0/v1/models/ft-abc', method }, (x) => (x.resume(), res(x.statusCode ?? 0))).on('error', () => res(-1)).end());
  try {
    for (const m of ['DELETE', 'PUT', 'PATCH', 'OPTIONS', 'TRACE']) assert.equal(await call(m), 403, m);
    assert.equal(await call('GET'), 200);
    assert.deepEqual(seen, ['GET /v1/models/ft-abc'], 'nothing but the GET reached the model');
  } finally {
    relay.close();
    model.close();
  }
});

// ------------------------------------------------------------ RC-2: effective runner

test('N36 RC2: with the user on "auto", a trusted project cannot pick a runner weaker than the one auto selects here', (t) => {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rc2-')));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.tugline'));
    fs.writeFileSync(path.join(home, '.tugline', 'config.json'), '{}');
    const auto = selectRunner(defaultConfig()).kind;
    if (auto !== 'bwrap') return t.skip(`auto selects ${auto} here (needs bwrap to show the downgrade)`);
    const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ sandbox: { runner: 'landlock' } }) });
    const cfg = loadConfig({ workspace: ws, trusted: true });
    assert.equal(sandboxStatus(cfg).runner, 'bwrap', 'the effective runner stays bwrap');
    assert.ok(cfg.trust.clamped.some((c) => /sandbox\.runner "landlock".*which is bwrap here/.test(c)), JSON.stringify(cfg.trust.clamped));
    // asking for what auto already gives, or something stronger, is kept
    assert.equal(sandboxStatus(loadConfig({ workspace: tmpWorkspace({ '.tugline/config.json': JSON.stringify({ sandbox: { runner: 'bwrap' } }) }), trusted: true })).runner, 'bwrap');
  } finally {
    process.env.HOME = old;
  }
});

// ------------------------------------------------------------ RC-3: Landlock's multiprocessing limit

test('N36 RC3: `tug sandbox status` and a failing command under Landlock say that Python multiprocessing needs bwrap', { skip: !landlockProbe().ok && 'Landlock unavailable' }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', network: 'none' } });
  const out: string[] = [];
  await getCliCommand('sandbox')!.run(['status'], { config: cfg, workspace: ws, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /multiprocessing \(Lock, Pool, ProcessPoolExecutor, Manager/);
  assert.match(out.join('\n'), /bwrap/);
  // the bash tool appends the explanation when a command fails that way
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: `python3 -c "import multiprocessing as m; m.Lock()"` } }] } : { content: 'done' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'landlock', network: 'none' }, agent: { requireVerification: false } }), mcp: false });
  await agent.run('go');
  await agent.dispose();
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /\[sandbox: Landlock gives commands no \/dev\/shm and no unix sockets, so Python multiprocessing/);
  // and bwrap runs it (where available)
  if (runnerAvailable('bwrap')) {
    const b = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'bwrap', network: 'none' } });
    const r = await execCommand({ shellCommand: `python3 -c "import multiprocessing as m; l=m.Lock(); print('lock ok')"`, cwd: ws, timeoutMs: 30_000, env: scrubbedEnv(b.shell.scrubEnv), wrap: commandWrapperFor(b) });
    assert.match(r.output, /lock ok/);
  }
});

// ------------------------------------------------------------ RC-4: credentialReference

test('N36 RC4: credentialReference: no false positive on commit messages or read-only docker commands; harder spellings ask', () => {
  const home = '/home/me';
  const ws = '/home/me/proj';
  const c = (command: string) => credentialReference({ command, cwd: ws, workspace: ws }, home);
  for (const quiet of ['git commit -m "fix ~/.ssh docs"', 'git commit --message="mention ~/.aws/credentials"', 'git commit -am "update .ssh docs" && git log', 'docker ps', 'docker images', 'podman ps -a', 'docker version', 'docker compose ps', 'git status', 'ls ~', 'cat ~/.gitconfig', 'grep -r foo ~/projects', 'find ~/projects -name x -exec cat {} \\;'])
    assert.equal(c(quiet), null, quiet);
  for (const ask of [
    'cat ~me/.ssh/id_ed25519',
    'cat ${HOME%/}/.ssh/id_ed25519',
    'cat ${HOME:-/x}/.ssh/id_ed25519',
    "cd ~ && cat $'.ssh/id_ed25519'",
    'H=$(getent passwd me | cut -d: -f6); cat $H/.ssh/id_ed25519',
    'cat $(eval echo ~)/.ssh/id_ed25519',
    'cat "$(dirname ~/x)/.ssh/id_ed25519"',
    'git -C ~ archive HEAD',
    'cat<~/.ssh/id_ed25519',
    'du -a ~ | xargs -n1 cat',
    'docker run -v /:/host alpine cat /host/root/.ssh/id_rsa',
    'docker -H tcp://10.0.0.1 ps',
    'docker inspect web',
    'git commit -m x ~/.ssh/id_ed25519',
    // re-check 2 RC-4b: -F/--file read a file (only the -m/--message value is a message)
    'git commit -F ~/.ssh/id_ed25519',
    'git commit --file ~/.ssh/id_ed25519',
    'git commit --file=/home/me/.ssh/id_ed25519',
    'git commit -F/home/me/.ssh/id_ed25519',
    'git commit -m x -F ~/.aws/credentials',
    'git commit -am x -F ~/.aws/credentials',
    'git tag -a v1 -F ~/.ssh/id_ed25519',
    'git commit -m "$(cat ~/.ssh/id_ed25519)"',
    'git commit -m "`cat ~/.ssh/id_ed25519`"',
    // re-check 2 RC-4c: a read-only docker command pointed at another daemon, or chained with a real one
    'docker -H unix:///var/run/docker.sock ps',
    'docker -H tcp://10.0.0.5:2375 ps',
    'docker --host=tcp://10.0.0.5:2375 ps',
    'docker --host tcp://10.0.0.5:2375 images',
    'docker -c remote ps',
    'docker --context remote version',
    'docker --context=remote ps',
    'podman --url ssh://root@10.0.0.5/run/podman/podman.sock ps',
    'DOCKER_HOST=tcp://10.0.0.5:2375 docker ps',
    'export DOCKER_HOST=unix:///var/run/docker.sock; docker ps',
    'docker ps; docker run --privileged -v /:/h alpine cat /h/etc/shadow',
    'docker ps && docker exec -it x sh',
    'docker ps | xargs docker rm -f',
  ])
    assert.ok(c(ask), `does not ask: ${ask}`);
});
