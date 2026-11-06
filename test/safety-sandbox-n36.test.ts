/**
 * N36: sandbox parity and beyond (WS18). Landlock fallback, credential stores unreadable, Podman per-command runner,
 * whole-session container mode, `tug sandbox`, project-scope rules (SAC1), fail closed (SAC2), lifetime (SAC4).
 * The conformance run with Landlock on every surface (SAC3) is test/conformance/landlock.test.ts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { loadConfig, type HarnessConfig } from '../src/core/config.js';
import { getCliCommand, getSlashCommand } from '../src/core/commands.js';
import { commandWrapperFor, containerSandboxFor, execCommand, scrubbedEnv } from '../src/core/tools/shell.js';
import { bwrapArgs, closeSandboxProxies, maskedPaths, runnerAvailable, sandboxConfig, sandboxStatus, sandboxWrapper, seatbeltProfile, selectRunner } from '../src/core/sandbox/index.js';
import { landlockProbe, readGrants } from '../src/core/sandbox/landlock.js';
import { LANDLOCK_HELPER_PY } from '../src/core/sandbox/landlockHelper.js';
import { splitAround } from '../src/core/sandbox/settings.js';
import { containerSessionPlan, extraMounts, innerConfig, rewriteEndpoint, runContainerSession, sweepStale } from '../src/core/sandbox/container.js';
import { onSecurityEvent } from '../src/core/permissions/audit.js';
import { setTrustConfirm } from '../src/core/sandbox/cli.js';
import { checkpointsFor } from '../src/core/checkpoint/index.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, tmpWorkspace, trackTmp, lastToolResult } from './helpers.js';

after(() => closeSandboxProxies());

const LL = landlockProbe();
const HAVE_BWRAP = runnerAvailable('bwrap');
const needLL = !LL.ok && `Landlock unavailable: ${LL.reason}`;
const ROOT = path.resolve('.');

// N36 needs a real kernel feature and, for AC3/AC4, container engines. CI sets these so nothing skips silently.
test('N36 [CI]: Landlock, docker and podman are available where the environment requires them', { skip: process.env.TUG_REQUIRE_N36 !== '1' && 'TUG_REQUIRE_N36 not set' }, () => {
  assert.ok(LL.ok, `Landlock: ${LL.reason}`);
  assert.ok(runnerAvailable('docker'), 'docker');
  assert.ok(runnerAvailable('podman'), 'podman');
});

/** A fake $HOME under the real home (not /tmp: bwrap gives commands a private /tmp), with a canary SSH key. */
function fakeHome(): { home: string; canary: string; restore: () => void } {
  const home = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36-home-')));
  const canary = `N36-CANARY-${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), canary + '\n');
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), `[default]\naws_secret_access_key=${canary}\n`);
  const old = process.env.HOME;
  process.env.HOME = home;
  return { home, canary, restore: () => (process.env.HOME = old) };
}

function outsideDir(): string {
  return trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36-outside-')));
}

async function sh(cfg: HarnessConfig, ws: string, command: string, timeoutMs = 30_000) {
  return execCommand({ shellCommand: command, cwd: ws, timeoutMs, env: scrubbedEnv(cfg.shell.scrubEnv), wrap: commandWrapperFor(cfg), sandbox: containerSandboxFor(cfg, ws) });
}

// ------------------------------------------------------------ AC1: Landlock filesystem

test('N36 AC1: forced sandbox.runner "landlock": a workspace write succeeds, a write outside is denied, ~/.ssh is unreadable, a protected path is not written', { skip: needLL }, async () => {
  const h = fakeHome();
  const out = outsideDir();
  try {
    const ws = tmpWorkspace({ 'tests/test_a.py': 'def test_a():\n    assert True\n', '.k': '.ssh/id_ed25519\n' });
    const srv = await startMockServer((_b, i) => {
      if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo inside > inside.txt && cat inside.txt' } }] };
      // the targets are built at run time so the static check cannot see them: the kernel is what is tested
      if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: `echo pwned > "$(echo ${out})/x.txt"; echo rc=$?` } }] };
      // (the key's name comes from a file: the policy layer resolves `$(echo $HOME)/.ssh` itself since review finding 13)
      if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'cat "$HOME/$(cat .k)"; echo rc=$?' } }] };
      if (i === 3) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo x >> tests/test_a.py' } }] };
      if (i === 4) return { toolCalls: [{ name: 'bash', arguments: { command: 'f=tests; echo y >> "$f/test_a.py"; echo rc=$?' } }] };
      return { content: 'done' };
    });
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'landlock' }, permissions: { protectedPaths: ['tests/**'] }, agent: { requireVerification: false } });
    assert.equal(sandboxStatus(cfg).runner, 'landlock');
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('go');
    await agent.dispose();
    await srv.close();
    assert.match(lastToolResult(srv.requests[1]), /inside[\s\S]*exit code 0/);
    assert.equal(fs.readFileSync(path.join(ws, 'inside.txt'), 'utf8'), 'inside\n');
    assert.match(lastToolResult(srv.requests[2]), /Permission denied[\s\S]*rc=1/);
    assert.equal(fs.existsSync(path.join(out, 'x.txt')), false, 'nothing written outside the workspace');
    assert.match(lastToolResult(srv.requests[3]), /Permission denied[\s\S]*rc=1/);
    assert.ok(!JSON.stringify(srv.requests).includes(h.canary), 'the SSH key never reached the model');
    assert.match(lastToolResult(srv.requests[4]), /Refused: refusing to run: the command writes tests\/test_a\.py/);
    assert.equal(fs.readFileSync(path.join(ws, 'tests/test_a.py'), 'utf8'), 'def test_a():\n    assert True\n', 'protected file unchanged (static refusal, and the restore guard for the dynamic spelling)');
  } finally {
    h.restore();
  }
});

test('N36 AC1: Landlock read grants are "/" minus the credential stores, split around them (unit)', () => {
  const tree: Record<string, string[]> = { '/': ['etc', 'home', 'usr'], '/home': ['me', 'other'], '/home/me': ['.ssh', 'proj', '.config'], '/home/me/.config': ['gh', 'nvim'] };
  const list = (d: string) => tree[d] ?? [];
  const isDir = (p: string) => p in tree || ['/etc', '/usr', '/home/other', '/home/me/proj', '/home/me/.ssh', '/home/me/.config/gh', '/home/me/.config/nvim'].includes(p);
  const g = readGrants(['/home/me/.ssh', '/home/me/.config/gh'], '/', list, isDir);
  assert.deepEqual(g.sort(), ['/etc', '/home/me/.config/nvim', '/home/me/proj', '/home/other', '/usr']);
  // a denied directory that holds the workspace (an H5 clone under ~/.tugline) is split around it
  const s = splitAround('/home/me/.tugline', ['/home/me/.tugline/remote/run-1/repo'], (d) => ({ '/home/me/.tugline': ['vault.json', 'remote'], '/home/me/.tugline/remote': ['run-1', 'run-2'], '/home/me/.tugline/remote/run-1': ['repo', 'meta'] })[d] ?? [], () => true);
  assert.deepEqual(s.sort(), ['/home/me/.tugline/remote/run-1/meta', '/home/me/.tugline/remote/run-2', '/home/me/.tugline/vault.json']);
});

test('N36 AC1 (bar 2): bwrap hides the credential stores too (reads, not just writes)', { skip: !HAVE_BWRAP && 'bwrap not available' }, async () => {
  const h = fakeHome();
  try {
    const ws = tmpWorkspace({});
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'bwrap' } });
    const r = await sh(cfg, ws, 'cat ~/.ssh/id_ed25519; cat ~/.aws/credentials; ls -A ~/.ssh | wc -l');
    assert.ok(!r.output.includes(h.canary), r.output);
    assert.match(r.output, /No such file|Permission denied/);
    // the mask list: existing stores only, the harness home included
    const masks = maskedPaths(cfg, sandboxConfig(cfg), [ws]);
    assert.ok(masks.includes(path.join(h.home, '.ssh')) && masks.includes(path.join(h.home, '.aws')), masks.join(','));
    assert.ok(masks.includes(fs.realpathSync(cfg.homeDir)), 'the harness home is hidden');
    const args = bwrapArgs({ file: '/bin/true', args: [], cwd: ws, env: {} }, { workspace: ws, writable: [], readOnly: [], network: 'none', denyRead: masks });
    assert.ok(args.join(' ').includes(`--tmpfs ${path.join(h.home, '.ssh')}`));
    // workspace = the home directory: ~/.ssh is still hidden
    const r2 = await sh(cfg, h.home, 'cat .ssh/id_ed25519; echo rc=$?');
    assert.ok(!r2.output.includes(h.canary), r2.output);
  } finally {
    h.restore();
  }
});

test('N36 AC1 (bar 2): the Seatbelt profile denies reads of the credential stores; "restrictive" denies by default (unit)', () => {
  const p = seatbeltProfile({ workspace: '/Users/me/proj', writable: [], readOnly: [], network: 'proxy', proxyPort: 4100, denyRead: ['/Users/me/.ssh', '/Users/me/.aws'] });
  assert.match(p, /\(deny file-read\* file-write\*\n {2}\(subpath "\/Users\/me\/\.ssh"\)\n {2}\(subpath "\/Users\/me\/\.aws"\)\)/);
  assert.ok(p.indexOf('(deny file-read*') > p.indexOf('(allow default)'), 'the deny comes after the allow (last match wins)');
  const r = seatbeltProfile({ workspace: '/Users/me/proj', writable: [], readOnly: [], network: 'none', denyRead: ['/Users/me/.ssh'], style: 'restrictive' });
  assert.match(r, /^\(version 1\)\n.*\n\(deny default\)\n\(allow file-read\*\)/);
  assert.doesNotMatch(r, /\(allow default\)/);
  assert.match(r, /\(deny network\*\)/);
  const ro = seatbeltProfile({ workspace: '/Users/me/proj', writable: [], readOnly: [], network: 'none', filesystem: 'read-only' });
  assert.doesNotMatch(ro, /subpath "\/Users\/me\/proj"/, 'read-only workspace: no write grant');
});

test('N36 AC1: the Landlock helper refuses to run the command when the ruleset cannot be enforced (no unconfined fallback)', { skip: needLL }, () => {
  const ws = tmpWorkspace({});
  const marker = path.join(ws, 'ran');
  const spec = JSON.stringify({ ro: ['/'], rw: [ws], net: null, ip: 'all', min_abi: 99, ppid: process.pid });
  const r = spawnSync(LL.python!, ['-I', '-S', '-c', LANDLOCK_HELPER_PY, spec, '--', '/bin/sh', '-c', `touch ${marker}`], { encoding: 'utf8' });
  assert.equal(r.status, 125, r.stderr);
  assert.match(r.stderr, /Landlock ABI \d+ is below the required 99/);
  assert.equal(fs.existsSync(marker), false, 'the command never ran');
});

// ------------------------------------------------------------ AC2: Landlock network

test('N36 AC2: with Landlock ABI >= 4 a connection to a non-proxy port is denied; the proxy port works for allowed hosts', { skip: (needLL || LL.abi < 4) && `needs Landlock ABI >= 4 (${LL.reason ?? `ABI ${LL.abi}`})` }, async () => {
  const site = http.createServer((req, res) => res.end(`hello ${req.url}`));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as any).port;
  try {
    const ws = tmpWorkspace({});
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', allowDomains: ['localhost'], allowDomainsPreset: [], upstreamProxy: 'none' } });
    assert.match(sandboxStatus(cfg).summary, /TCP only to the allowlist proxy/);
    const direct = await sh(cfg, ws, `(exec 3<>/dev/tcp/127.0.0.1/${port}) && echo connected`);
    assert.notEqual(direct.exitCode, 0, direct.output);
    assert.match(direct.output, /Permission denied/);
    assert.doesNotMatch(direct.output, /connected/);
    const via = await sh(cfg, ws, `curl -sS -m 10 http://localhost:${port}/ok`);
    assert.equal(via.exitCode, 0, via.output);
    assert.match(via.output, /hello \/ok/);
    const blocked = await sh(cfg, ws, `curl -sS -m 10 -o /dev/null -w '%{http_code}' http://example.org/`);
    assert.match(blocked.output, /403/);
    const udp = await sh(cfg, ws, `python3 -c "import socket; socket.socket(socket.AF_INET, socket.SOCK_DGRAM)"`);
    assert.notEqual(udp.exitCode, 0, 'UDP sockets are closed (seccomp)');
    // network "none": no IP sockets at all, whatever the ABI
    const none = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', network: 'none' } });
    const n = await sh(none, ws, `(exec 3<>/dev/tcp/127.0.0.1/${port}) && echo connected`);
    assert.notEqual(n.exitCode, 0);
    assert.doesNotMatch(n.output, /connected/);
  } finally {
    site.close();
  }
});

test('N36 AC2: below ABI 4, status says "network not restricted by Landlock" and sandbox.require refuses network-needing runs', { skip: needLL }, async () => {
  const ws = tmpWorkspace({});
  const base = { runner: 'landlock', allowDomains: ['localhost'], allowDomainsPreset: [], landlock: { maxAbi: 3 } };
  const soft = testConfig('http://127.0.0.1:9/v1', { sandbox: base });
  assert.match(sandboxStatus(soft).summary, /network not restricted by Landlock/);
  const hard = testConfig('http://127.0.0.1:9/v1', { sandbox: { ...base, require: true } });
  const st = sandboxStatus(hard);
  assert.equal(st.refusing, true);
  assert.match(st.summary, /network not restricted by Landlock \(ABI 3 < 4\) and sandbox\.require is set/);
  const r = await sh(hard, ws, 'echo should-not-run');
  assert.equal(r.exitCode, 125, r.output);
  assert.match(r.output, /network not restricted by Landlock \(ABI 3 < 4\) and a sandbox is required: refusing/);
  assert.doesNotMatch(r.output, /should-not-run/);
  // with network off nothing needs the network: seccomp closes IP sockets on any ABI, so the command runs
  const off = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', network: 'none', require: true, landlock: { maxAbi: 3 } } });
  const ok = await sh(off, ws, 'echo runs; (exec 3<>/dev/tcp/1.1.1.1/80)');
  assert.match(ok.output, /runs/);
  assert.notEqual(ok.exitCode, 0, 'and the connection still fails');
});

// ------------------------------------------------------------ AC3: container session (Docker)

function engineOk(e: string): boolean {
  return spawnSync(e, ['version'], { stdio: 'ignore', timeout: 20_000 }).status === 0 && spawnSync(e, ['image', 'inspect', 'node:22-bookworm-slim'], { stdio: 'ignore', timeout: 20_000 }).status === 0;
}
const DOCKER = engineOk('docker');
const PODMAN = engineOk('podman');

/** A mock model on all interfaces (the container reaches it through the host gateway), scripted per tool step. */
async function wideModel(steps: string[] | ((step: number) => string | undefined), done: string) {
  const reqs: any[] = [];
  const auth: (string | undefined)[] = [];
  const at = (i: number) => (typeof steps === 'function' ? steps(i) : steps[i]);
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.method === 'GET') return void res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      const body = JSON.parse(b);
      reqs.push(body);
      auth.push(req.headers.authorization);
      const step = body.messages.filter((m: any) => m.role === 'tool').length;
      const cmd = at(step);
      const msg = cmd !== undefined ? { role: 'assistant', content: '', tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) } }] } : { role: 'assistant', content: done };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ index: 0, message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '0.0.0.0', () => r()));
  return { port: (srv.address() as any).port, reqs, auth, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

interface ContainerRunOpts {
  /** reuse a previous run's dirs (a second session of the same project) */
  base?: string;
  steps?: (x: { gw: string; sport: number; oport: number; mport: number; home: string; ws: string; base: string }) => string[];
}

async function containerRun(engine: 'docker' | 'podman', o: ContainerRunOpts = {}) {
  const base = o.base ?? trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36-ct-')));
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'HOST-CANARY.txt'), 'host-home-canary');
  // and something in the real home directory, next to (not inside) the mounted workspace
  const realCanary = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36-hostcanary-')));
  fs.writeFileSync(path.join(realCanary, 'secret.txt'), 'real-home-canary');
  // an "allowed" site on the host, reachable only through the proxy (listed as gateway:port), and another service on
  // the same host that is NOT allowed (review finding 8: the host is not opened on every port)
  const site = http.createServer((_req, res) => res.end('allowed-site-ok'));
  await new Promise<void>((r) => site.listen(0, '0.0.0.0', () => r()));
  const sport = (site.address() as any).port;
  const other = http.createServer((_req, res) => res.end('OTHER-HOST-SERVICE'));
  await new Promise<void>((r) => other.listen(0, '0.0.0.0', () => r()));
  const oport = (other.address() as any).port;
  const { hostGateway } = await import('../src/core/sandbox/container.js');
  const gw = hostGateway(engine);
  const js = (s: string) => `node -e ${JSON.stringify(s)}`;
  // paths the commands assemble at run time (the in-container permission engine would otherwise ask, and nobody answers -p)
  fs.writeFileSync(path.join(ws, '.envname'), 'environ\n');
  fs.writeFileSync(path.join(ws, '.hd'), '/oh-home\n');
  const defaults = (x: { mport: number }) => [
    `echo made-in-container > made.txt; cat ${home}/HOST-CANARY.txt; echo home-rc=$?; cat ${realCanary}/secret.txt; echo hosthome-rc=$?; ls -a /var/run/ /run/ 2>/dev/null | grep -E 'd.cker|p.dman|c.ntainerd' | sed 's/^/SOCK-PRESENT /'; echo sock-check-done`,
    `(exec 3<>/dev/tcp/1.1.1.1/80) 2>&1; echo direct-rc=$?`,
    js(`fetch('http://${gw}:${sport}/').then(r=>r.text()).then(t=>console.log('allowed:'+t)).catch(e=>console.log('allowed-err:'+(e.cause?.code||e.message)))`),
    // plain HTTP through the proxy (absolute-form request): the proxy's own answer is visible as the status
    js(`require('http').get('http://example.org/',r=>console.log('blocked-status:'+r.statusCode)).on('error',e=>console.log('blocked-err:'+e.message))`),
    // review finding 8: another port on the model/gateway host, and the model port itself outside the relay
    js(`const h=require('http');h.get('http://${gw}:${oport}/',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log('other:'+r.statusCode+':'+b))}).on('error',e=>console.log('other-err:'+e.message));h.get('http://${gw}:${x.mport}/v1/models',r=>console.log('model-direct:'+r.statusCode)).on('error',e=>console.log('model-direct-err:'+e.message))`),
    // review finding 7: the API key is nowhere in the container (no process environment, no file in the home)
    `for i in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' '\\n' < /proc/$i/$(cat .envname) 2>/dev/null; done | grep -c "sk-n36-co[n]tainer"; grep -rsl "sk-n36-co[n]tainer" "$(cat .hd)" | head -3; echo key-scan-done`,
    // re-check RC-1: the relay (127.0.0.1:3129 in the agent container) refuses crafted paths and serves the model path
    js(`const h=require('http');const g=(n,p)=>new Promise(r=>h.get({host:'127.0.0.1',port:3129,path:p},x=>{x.resume();console.log(n+':'+x.statusCode);r()}).on('error',e=>{console.log(n+'-err:'+e.message);r()}));(async()=>{await g('relay-dots','/m0/v1/%2e%2e/admin');await g('relay-origin','/m0//${gw}:${oport}/x');await g('relay-raw','/m0/v1/../admin');await g('relay-ok','/m0/v1/models')})()`),
  ];
  let mport = 0;
  const model = await wideModel(
    (step: number) => (o.steps ? o.steps({ gw, sport, oport, mport, home, ws, base }) : defaults({ mport }))[step],
    'container task done',
  );
  mport = model.port;
  fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
  const userCfg = path.join(home, '.tugline', 'config.json');
  if (!fs.existsSync(userCfg)) fs.writeFileSync(userCfg, JSON.stringify({ permissionMode: 'yolo', agent: { requireVerification: false }, checkpoints: { enabled: false }, sandbox: { allowDomains: [`${gw}:${sport}`], allowDomainsPreset: [] } }));
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'node_modules/tsx/dist/esm/index.mjs'), path.join(ROOT, 'src/cli/main.ts'), '--container', engine, '-p', 'make the file'], { cwd: ws, env: { ...process.env, HOME: home, TUG_BASE_URL: `http://127.0.0.1:${model.port}/v1`, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-n36-container-0123456789', TUG_CONTEXT_WINDOW: '32768' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  const tools = model.reqs.slice(1).map((r) => String(r.messages.at(-1).content));
  await model.close();
  site.close();
  other.close();
  const left = execFileSync(engine, ['ps', '-a', '--filter', 'label=tugline.session', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  const nets = execFileSync(engine, ['network', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' }).split('\n').filter((n) => n.startsWith('oh-net-'));
  return { code, out, tools, ws, home, left, nets, base, auth: model.auth };
}

test('N36 AC3: container session on Docker: the agent completes a mock task; the host $HOME is not visible; egress only through the proxy; nothing left behind', { skip: !DOCKER && 'docker with node:22-bookworm-slim not available', timeout: 600_000 }, async () => {
  const r = await containerRun('docker');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /container task done/);
  assert.equal(fs.readFileSync(path.join(r.ws, 'made.txt'), 'utf8'), 'made-in-container\n', 'the workspace is mounted read-write');
  assert.match(r.tools[0]!, /home-rc=1/, 'the (fake) host home is not mounted');
  assert.match(r.tools[0]!, /hosthome-rc=1/, 'nothing else in the real home directory is visible');
  assert.match(r.tools[0]!, /sock-check-done/);
  assert.doesNotMatch(r.tools[0]!, /^SOCK-PRESENT /m, 'N36 SAC5: no container-runtime socket inside the session container');
  assert.ok(!r.tools[0]!.includes('host-home-canary') && !r.tools[0]!.includes('real-home-canary'));
  assert.match(r.tools[1]!, /direct-rc=1/, 'no direct route out');
  assert.match(r.tools[2]!, /allowed:allowed-site-ok/, 'an allowed host is reached through the proxy');
  assert.match(r.tools[3]!, /blocked-status:403/, 'a host outside the allowlist is refused by the proxy');
  assert.equal(r.left, '', 'no session container left');
  assert.deepEqual(r.nets, [], 'no session network left');
  assert.ok(!r.out.includes('sk-n36-container-0123456789'), 'the API key is not printed');
  // N36 RC1: crafted relay paths are refused inside the real container session; the model path works
  assert.match(r.tools[6]!, /relay-dots:403/);
  assert.match(r.tools[6]!, /relay-origin:403/);
  assert.match(r.tools[6]!, /relay-raw:40\d/);
  assert.match(r.tools[6]!, /relay-ok:200/);
});

test('N36 R8: container session egress: the model host is reachable only through the relay (its endpoint), not on every port', { skip: !DOCKER && 'docker with node:22-bookworm-slim not available', timeout: 600_000 }, async () => {
  const r = await containerRun('docker');
  assert.equal(r.code, 0, r.out);
  assert.match(r.tools[4]!, /other:403:|other-err:/, `another service on the gateway host must be refused: ${r.tools[4]}`);
  assert.doesNotMatch(r.tools[4]!, /OTHER-HOST-SERVICE/);
  assert.match(r.tools[4]!, /model-direct:403|model-direct-err:/, 'the model port itself is not open through the proxy (only the relay reaches it)');
  // ...and the model was reached, through the relay, with the key the relay added
  assert.ok(r.auth.every((h: string | undefined) => h === 'Bearer sk-n36-container-0123456789'), `the relay adds the key: ${JSON.stringify(r.auth)}`);
});

test('N36 R7: container session: the API key never enters the agent container (no process environment, no file)', { skip: !DOCKER && 'docker with node:22-bookworm-slim not available', timeout: 600_000 }, async () => {
  const r = await containerRun('docker', { steps: () => [`for i in $(ls /proc | grep -E '^[0-9]+$'); do tr '\\0' '\\n' < /proc/$i/$(cat .envname) 2>/dev/null; done | grep -c "sk-n36-co[n]tainer"; grep -rsl "sk-n36-co[n]tainer" "$(cat .hd)" /tmp 2>/dev/null | head -3; echo key-scan-done`] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.tools[0]!, /^0\n(?:key-scan-done)/m, `the key is in the container: ${r.tools[0]}`);
});

test('N36 R2: a container session cannot make the host write through a link it planted in its home', { skip: !DOCKER && 'docker with node:22-bookworm-slim not available', timeout: 600_000 }, async () => {
  // session 1: a command tries to replace the in-container config (and its directory) with links to host files
  const plant = ({ home }: { home: string }) => {
    const hostCfg = path.join(home, '.tugline', 'config.json');
    return [`printf '%s\\n' "${hostCfg}" > .t; t=$(cat .t); ln -sfn "$t" "$HOME/.tugline/config.json" 2>&1; echo ln1-rc=$?; ln -sfn "$t" "$HOME/.tugline/trusted-workspaces.json" 2>&1; echo ln2-rc=$?; ls -la "$HOME/.tugline/" | head -5; echo planted`];
  };
  const r1 = await containerRun('docker', { steps: plant });
  assert.equal(r1.code, 0, r1.out);
  const hostCfg = path.join(r1.home, '.tugline', 'config.json');
  const before = fs.readFileSync(hostCfg, 'utf8');
  // session 2 of the same project: the host prepares the container home again
  const r2 = await containerRun('docker', { base: r1.base, steps: () => ['echo second-session'] });
  assert.equal(r2.code, 0, r2.out);
  assert.equal(fs.readFileSync(hostCfg, 'utf8'), before, 'the host user config was not rewritten');
  const after = JSON.parse(fs.readFileSync(hostCfg, 'utf8'));
  assert.notEqual(after.sandbox?.runner, 'none');
  assert.ok(!fs.lstatSync(hostCfg).isSymbolicLink());
});

test('N36 AC3: Podman runs the same container session', { skip: !PODMAN && 'podman with node:22-bookworm-slim not available', timeout: 600_000 }, async () => {
  const r = await containerRun('podman');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(r.ws, 'made.txt'), 'utf8'), 'made-in-container\n');
  assert.match(r.tools[0]!, /home-rc=1[\s\S]*hosthome-rc=1/);
  assert.match(r.tools[1]!, /direct-rc=1/);
  assert.match(r.tools[2]!, /allowed:allowed-site-ok/);
  assert.match(r.tools[3]!, /blocked-status:403/);
  assert.match(r.tools[4]!, /other:403:|other-err:/);
  assert.match(r.tools[5]!, /^0\n/m, 'no API key in the Podman agent container');
  assert.match(r.tools[6]!, /relay-dots:403[\s\S]*relay-origin:403[\s\S]*relay-ok:200/, 'N36 RC1 on Podman');
  assert.equal(r.left, '');
});

test('N36 AC3: image selection: environment.Dockerfile and devcontainer need a trusted workspace; config and default otherwise (unit)', () => {
  const probe = () => true;
  const ws = tmpWorkspace({ '.tugline/environment.Dockerfile': 'FROM node:22-bookworm-slim\nRUN echo hi\n' });
  const untrusted = testConfig('http://x/v1', {});
  const p1 = containerSessionPlan({ ...untrusted, trust: { workspaceTrusted: false, ignored: [] } }, ws, 'docker', probe);
  assert.equal(p1.ok, false);
  assert.match(p1.reason!, /trust the workspace/);
  const p2 = containerSessionPlan({ ...untrusted, trust: { workspaceTrusted: true, ignored: [] } }, ws, 'docker', probe);
  assert.equal(p2.ok, true);
  assert.equal(p2.source, 'environment.Dockerfile');
  assert.match(p2.image!, /^tugline-env:[0-9a-f]{12}$/);
  const dc = tmpWorkspace({ '.devcontainer/devcontainer.json': '// comment\n{ "image": "python:3.12-slim", }\n' });
  assert.equal(containerSessionPlan({ ...untrusted, trust: { workspaceTrusted: true, ignored: [] } }, dc, 'auto', probe).image, 'python:3.12-slim');
  const plain = tmpWorkspace({});
  assert.equal(containerSessionPlan(untrusted, plain, 'podman', probe).image, 'node:22-bookworm-slim');
  assert.equal(containerSessionPlan(testConfig('http://x/v1', { container: { image: 'my/img:1' } }), plain, 'docker', probe).image, 'my/img:1');
  assert.match(containerSessionPlan(untrusted, plain, 'docker', () => false).reason!, /docker is not installed or cannot run/);
  // the endpoint on the host loopback is rewritten; the inner config carries no secrets and does not recurse
  assert.equal(rewriteEndpoint('http://127.0.0.1:11434/v1', '172.17.0.1'), 'http://172.17.0.1:11434/v1');
  assert.equal(rewriteEndpoint('https://api.example.com/v1', '172.17.0.1'), 'https://api.example.com/v1');
  const inner = innerConfig(testConfig('http://127.0.0.1:9/v1', { web: { braveApiKey: 'brave-secret-123' }, sandbox: { trustProjectConfig: ['/x'] } }), '172.17.0.1') as any;
  assert.equal(inner.profiles.default.apiKey, undefined);
  assert.equal(inner.profiles.default.baseUrl, 'http://172.17.0.1:9/v1');
  assert.equal(inner.web.braveApiKey, undefined);
  assert.equal(inner.sandbox.session, 'host');
  assert.equal(inner.sandbox.trustProjectConfig, undefined);
  // extra mounts never include a credential store or the harness home
  const h = fakeHome();
  try {
    assert.throws(() => extraMounts([{ from: path.join(h.home, '.ssh') }], testConfig('http://x/v1')), /credential store/);
    assert.deepEqual(extraMounts([{ from: ws }], testConfig('http://x/v1')), ['-v', `${ws}:${ws}:ro`]);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ AC4: Podman per-command runner

test('N36 AC4: the Podman per-command runner: workspace writable, protected paths read-only, no network, no host home', { skip: !runnerAvailable('podman') && 'podman not available', timeout: 300_000 }, async () => {
  const h = fakeHome();
  try {
    const ws = tmpWorkspace({ 'tests/test_a.py': 'ok\n' });
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'podman' }, shell: { dockerImage: 'docker.io/library/alpine:3.20' }, permissions: { protectedPaths: ['tests/**'] } });
    assert.equal(selectRunner(cfg).kind, 'podman');
    assert.match(sandboxStatus(cfg).summary, /podman container per command/);
    const r = await sh(cfg, ws, `echo in-podman > made.txt; echo x >> tests/test_a.py; echo prot-rc=$?; cat /etc/os-release | head -1; ls ${h.home} 2>&1; echo home-rc=$?; wget -q -T 3 -O- http://1.1.1.1/ 2>&1; echo net-rc=$?`, 240_000);
    assert.equal(fs.readFileSync(path.join(ws, 'made.txt'), 'utf8'), 'in-podman\n', r.output);
    assert.match(r.output, /Alpine/);
    assert.match(r.output, /prot-rc=1/);
    assert.equal(fs.readFileSync(path.join(ws, 'tests/test_a.py'), 'utf8'), 'ok\n');
    assert.match(r.output, /home-rc=1/);
    assert.match(r.output, /net-rc=1/);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ tug sandbox status / verify / run

test('N36 R5: `tug sandbox status` explains what is in force and why; verify probes the boundary; run confines one command', { skip: needLL }, async () => {
  const h = fakeHome();
  try {
    const ws = tmpWorkspace({});
    const cmd = getCliCommand('sandbox')!;
    const out: string[] = [];
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock' } });
    assert.equal(await cmd.run(['status'], { config: cfg, workspace: ws, write: (t) => out.push(t) }), 0);
    const text = out.join('\n');
    assert.match(text, /^sandbox: landlock/m);
    assert.match(text, /requested runner: landlock \(sandbox\.runner\)/);
    assert.match(text, /effective runner: landlock/);
    assert.match(text, /landlock: Landlock ABI \d+/);
    assert.match(text, /credential stores hidden from commands: .*~\/\.ssh/);
    assert.match(text, /process lifetime: commands die with the session/);
    out.length = 0;
    assert.equal(await cmd.run(['verify'], { config: cfg, workspace: ws, write: (t) => out.push(t) }), 0, out.join('\n'));
    assert.match(out.join('\n'), /PASS {2}a write outside the workspace is denied[\s\S]*PASS {2}a credential store read is denied/);
    out.length = 0;
    const none = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'none' } });
    assert.equal(await cmd.run(['verify'], { config: none, workspace: ws, write: (t) => out.push(t) }), 1, 'verify fails without a sandbox');
    assert.match(out.join('\n'), /FAIL {2}a write outside the workspace is denied/);
    out.length = 0;
    assert.equal(await cmd.run(['run', '--', `cat ${h.home}/.ssh/id_ed25519`], { config: cfg, workspace: ws, write: (t) => out.push(t) }), 1);
    assert.ok(!out.join('\n').includes(h.canary));
    out.length = 0;
    // the auto chain explains itself
    const auto = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'auto' } });
    const sel = selectRunner(auto, (k) => k === 'landlock', 'linux');
    assert.equal(sel.kind, 'landlock');
    assert.match(sel.chain!.join('\n'), /bwrap: .*\nlandlock: available/);
    const nothing = selectRunner(auto, () => false, 'linux');
    assert.equal(nothing.kind, 'none');
    assert.match(nothing.unavailable!, /no OS sandbox available on linux/);
    // and /sandbox in a session prints the same report
    const so: string[] = [];
    await getSlashCommand('sandbox')!.run('', { agent: undefined, config: cfg, workspace: ws, write: (t) => so.push(t), surface: 'server' });
    assert.match(so.join('\n'), /effective runner: landlock/);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ SAC1: project config cannot loosen

function projectWs(layer: unknown): string {
  return tmpWorkspace({ '.tugline/config.json': JSON.stringify(layer) });
}

test('N36 SAC1: a project config setting sandbox.mode none or adding allowDomains is ignored with a warning, even in a trusted workspace', async () => {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n36-cfg-')));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const ws = projectWs({ sandbox: { mode: 'none', allowDomains: ['evil.example.com'], require: false, network: 'host', trustProjectConfig: ['/'] }, shell: { sandbox: 'none', requireSandbox: false }, permissionMode: 'auto', web: { allowHosts: ['169.254.169.254'] } });
    fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tugline', 'config.json'), JSON.stringify({ sandbox: { runner: 'landlock', require: true, allowDomains: ['registry.npmjs.org'] }, permissionMode: 'ask' }));
    const cfg = loadConfig({ workspace: ws, trusted: true });
    assert.equal(cfg.trust!.workspaceTrusted, true);
    assert.equal((cfg.sandbox as any).mode, undefined, 'sandbox.mode none ignored');
    assert.equal(cfg.shell.sandbox, 'auto', 'shell.sandbox none ignored');
    assert.equal((cfg.sandbox as any).runner, 'landlock');
    assert.deepEqual((cfg.sandbox as any).allowDomains, ['registry.npmjs.org'], 'no host added');
    assert.equal((cfg.sandbox as any).require, true);
    assert.equal((cfg.sandbox as any).network, undefined);
    assert.equal((cfg.sandbox as any).trustProjectConfig, undefined, 'a project cannot trust itself');
    assert.equal(cfg.permissionMode, 'ask', 'approval mode not loosened');
    assert.equal(cfg.web.allowHosts, undefined);
    const c = cfg.trust!.clamped!.join('\n');
    for (const k of ['sandbox.mode "none"', 'sandbox.allowDomains (evil.example.com)', 'sandbox.require false', 'sandbox.network "host"', 'shell.sandbox "none"', 'permissionMode "auto"', 'web.allowHosts', 'sandbox.trustProjectConfig']) assert.ok(c.includes(k), `${k} reported: ${c}`);
    // tightening passes: a stricter mode, network off, a read-only workspace
    const tight = loadConfig({ workspace: projectWs({ sandbox: { network: 'none', filesystem: 'read-only' }, permissionMode: 'plan' }), trusted: true });
    assert.equal((tight.sandbox as any).network, 'none');
    assert.equal((tight.sandbox as any).filesystem, 'read-only');
    assert.equal(tight.permissionMode, 'plan');
    assert.deepEqual(tight.trust!.clamped, []);
    // the warning reaches every surface: a notice and a policy_violation security event at run start
    const srv = await startMockServer(() => ({ content: 'ok' }));
    const cfg2 = loadConfig({ workspace: ws, trusted: true, overrides: { profiles: { default: { baseUrl: srv.url, model: 'mock-model' } }, agent: { requireVerification: false } } });
    const notices: string[] = [];
    const sec: string[] = [];
    const off = onSecurityEvent((e) => sec.push(`${e.type}:${e.category}`));
    const agent = await Agent.create({ workspace: ws, config: cfg2, mcp: false, ui: { onEvent: (e) => e.type === 'notice' && notices.push(e.message) } });
    await agent.run('hi');
    await agent.dispose();
    off();
    await srv.close();
    assert.ok(notices.some((n) => /project config ignored \(it cannot loosen sandbox, network or approval settings\): .*sandbox\.mode "none"/.test(n)), notices.join('\n'));
    assert.ok(sec.includes('policy_violation:project_config'));
  } finally {
    process.env.HOME = old;
  }
});

test('N36 SAC1: the user can let one workspace loosen it at user scope (sandbox.trustProjectConfig / tug sandbox trust-project)', async () => {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n36-cfg-')));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const ws = projectWs({ sandbox: { mode: 'none', allowDomains: ['internal.example.com'] } });
    const before = loadConfig({ workspace: ws, trusted: true });
    assert.equal((before.sandbox as any).mode, undefined);
    const out: string[] = [];
    const undo = setTrustConfirm(async () => true); // the person at the terminal says yes (N36 R17)
    assert.equal(await getCliCommand('sandbox')!.run(['trust-project', ws], { config: before, workspace: ws, write: (t) => out.push(t) }), 0);
    undo();
    const after = loadConfig({ workspace: ws, trusted: true });
    assert.equal((after.sandbox as any).mode, 'none');
    assert.deepEqual((after.sandbox as any).allowDomains, ['internal.example.com']);
    assert.deepEqual(after.trust!.clamped, []);
    // an untrusted workspace still gets nothing from it
    const untrusted = loadConfig({ workspace: ws, trusted: false });
    assert.equal((untrusted.sandbox as any)?.mode, undefined);
    await getCliCommand('sandbox')!.run(['trust-project', ws, '--revoke'], { config: after, workspace: ws, write: () => {} });
    assert.equal((loadConfig({ workspace: ws, trusted: true }).sandbox as any).mode, undefined);
  } finally {
    process.env.HOME = old;
  }
});

// ------------------------------------------------------------ SAC2: fail closed

test('N36 SAC2: sandbox.require with no runner available: commands are refused with a typed reason', async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'auto', require: true } });
  const wrap = sandboxWrapper(cfg, ws, () => false)!;
  assert.ok(wrap, 'a refusing wrapper, not "no wrapper"');
  const r = await execCommand({ shellCommand: `touch ${ws}/ran`, cwd: ws, timeoutMs: 10_000, env: process.env, wrap });
  assert.equal(r.exitCode, 126);
  assert.match(r.output, /Tugline: command not run: no OS sandbox available on linux.*Sandboxing is required \(sandbox\.require/);
  assert.equal(fs.existsSync(path.join(ws, 'ran')), false);
  // an explicitly requested runner that is missing is refused too (seatbelt is not on Linux), even without require
  const explicit = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'seatbelt' } });
  const r2 = await sh(explicit, ws, `touch ${ws}/ran2`);
  assert.equal(r2.exitCode, 126);
  assert.equal(fs.existsSync(path.join(ws, 'ran2')), false);
  assert.equal(sandboxStatus(explicit).refusing, true);
  // the agent reports it back to the model as a command result, and the run's sandbox event says "refuse"
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch ran3' } }] } : { content: 'done' }));
  const sec: string[] = [];
  const off = onSecurityEvent((e) => e.type === 'sandbox' && sec.push(e.decision));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'seatbelt', require: true }, agent: { requireVerification: false } }), mcp: false });
  await agent.run('go');
  await agent.dispose();
  off();
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /command not run: seatbelt is not available on this machine/);
  assert.equal(fs.existsSync(path.join(ws, 'ran3')), false);
  assert.ok(sec.includes('refuse'));
});

// ------------------------------------------------------------ SAC4: nothing outlives the session

function alive(tag: string): boolean {
  return spawnSync('/bin/sh', ['-c', `ps -eo args | grep -F -- "${tag}" | grep -v grep`], { encoding: 'utf8' }).stdout.trim() !== '';
}

test('N36 SAC4: a Landlock-sandboxed command cannot outlive it: setsid orphans die with the command, background jobs with the session, everything with the harness', { skip: needLL, timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock' } });
  // (a) a foreground command that daemonizes a child: the reaper kills it when the command ends
  const tagA = `sleep 3${crypto.randomInt(100, 999)}1`;
  await sh(cfg, ws, `(setsid ${tagA} &); echo started`);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(tagA), false, 'the setsid orphan was reaped');
  // the command cannot signal the harness (Landlock signal scoping, ABI >= 6): it cannot kill its reaper either
  if (LL.abi >= 6) {
    const k = await sh(cfg, ws, `kill -0 ${process.pid}; echo rc=$?`);
    assert.match(k.output, /Operation not permitted[\s\S]*rc=1/, k.output);
  }
  // (b) a background job of an agent session ends with the session (and its setsid child with it)
  const tagB = `sleep 3${crypto.randomInt(100, 999)}2`;
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: `(setsid ${tagB} &); ${tagB}`, run_in_background: true } }] } : { content: 'started' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'landlock' }, agent: { requireVerification: false, backgroundJobs: true } }), mcp: false });
  await agent.run('start it');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(alive(tagB), true, 'the job runs while the session is open');
  await agent.dispose();
  await srv.close();
  for (let i = 0; i < 50 && alive(tagB); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(tagB), false, 'the job and its setsid child died with the session');
  // (c) the harness is SIGKILLed: the helper gets SIGTERM (parent-death signal) and kills everything below it
  const tagC = `sleep 3${crypto.randomInt(100, 999)}3`;
  const script = `import { execCommand, commandWrapperFor } from ${JSON.stringify(path.join(ROOT, 'src/core/tools/shell.ts'))};
import { testConfig } from ${JSON.stringify(path.join(ROOT, 'test/helpers.ts'))};
import ${JSON.stringify(path.join(ROOT, 'src/core/sandbox/index.ts'))};
const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock' } });
console.log('ready');
await execCommand({ shellCommand: '(setsid ${tagC} &); ${tagC}', cwd: ${JSON.stringify(ws)}, timeoutMs: 60000, env: process.env, wrap: commandWrapperFor(cfg) });`;
  const f = path.join(ws, 'harness.mts');
  fs.writeFileSync(f, script);
  const child = spawn(process.execPath, ['--import', 'tsx', f], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((r) => child.stdout.on('data', (d) => String(d).includes('ready') && r()));
  for (let i = 0; i < 50 && !alive(tagC); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(tagC), true);
  child.kill('SIGKILL');
  for (let i = 0; i < 50 && alive(tagC); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(tagC), false, 'killing the harness kills the sandboxed command and its orphans');
});

test('N36 SAC4: container sessions whose host process died are removed by the next session (sweep)', { skip: !runnerAvailable('docker') && 'docker not available', timeout: 120_000 }, () => {
  const id = crypto.randomBytes(4).toString('hex');
  const dead = 999_999;
  const r = spawnSync('docker', ['run', '-d', '--rm', '--name', `oh-agent-${id}`, '--label', `tugline.session=${id}`, '--label', `tugline.pid=${dead}`, '--label', `tugline.host=${os.hostname()}`, 'node:22-bookworm-slim', 'sleep', '300'], { encoding: 'utf8' });
  if (r.status !== 0) return assert.fail(r.stderr);
  const removed = sweepStale('docker');
  assert.ok(removed.length >= 1, 'the orphaned container was removed');
  const left = execFileSync('docker', ['ps', '-a', '--filter', `label=tugline.session=${id}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim();
  assert.equal(left, '');
});

// ------------------------------------------------------------ bar 4: shell side effects are still checkpointed

test('N36 bar 4: under the Landlock runner, a shell command\'s changes are checkpointed and restorable', { skip: needLL }, async () => {
  const ws = tmpWorkspace({ 'b.txt': 'beta\n' });
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: "perl -pi -e 's/beta/BETA-SED/' b.txt && echo made > c.txt" } }] } : { content: 'done' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'landlock' }, agent: { requireVerification: false } }), mcp: false });
  await agent.run('go');
  await srv.close();
  assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'BETA-SED\n', 'the sandboxed command really changed the file');
  // the turn's checkpoint was taken before the sandboxed command ran (a shell checkpoint is skipped when nothing changed since)
  const m = checkpointsFor(agent.config, ws);
  const all = await m.list();
  assert.ok(all.length >= 1, 'a checkpoint exists');
  const before = all.reduce((a, b) => (a.ts <= b.ts ? a : b));
  await m.restore(before.id, { files: true, conversation: false, agent });
  await agent.dispose();
  assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'beta\n');
  assert.equal(fs.existsSync(path.join(ws, 'c.txt')), false);
});

// ------------------------------------------------------------ file tools: write-time confinement (Qwen file worker parity)

test('N36 inventory (file worker): a path swapped for a symlink while the approval was pending cannot carry a write out of the workspace', async () => {
  const ws = tmpWorkspace({ 'docs/README.md': '# docs\n' });
  const out = outsideDir();
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'docs/new.md', content: 'written\n' } }] } : { content: 'done' }));
  const agent = await Agent.create({
    workspace: ws,
    config: testConfig(srv.url, { permissionMode: 'ask', agent: { requireVerification: false } }),
    mcp: false,
    ui: {
      // while the human looks at the prompt, the directory is replaced by a link outside the workspace
      requestPermission: async () => {
        fs.rmSync(path.join(ws, 'docs'), { recursive: true, force: true });
        fs.symlinkSync(out, path.join(ws, 'docs'));
        return { decision: 'allow' };
      },
    },
  });
  await agent.run('write the doc');
  await agent.dispose();
  await srv.close();
  assert.equal(fs.existsSync(path.join(out, 'new.md')), false, 'nothing was written outside');
  assert.match(lastToolResult(srv.requests[1]), /refused at write time: .* now resolves to .*outside the workspace/);
});

// ------------------------------------------------------------ first layer: the policy (no sandbox needed)

test('N36 bar 2 (policy layer): credential-store reads ask in every mode, auto included, with no OS sandbox at all', async () => {
  const h = fakeHome();
  try {
    const ws = tmpWorkspace({});
    const srv = await startMockServer((_b, i) => {
      if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'cat ~/.ssh/id_ed25519' } }] };
      if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'cd ~ && base64 .aws/credentials' } }] };
      if (i === 2) return { toolCalls: [{ name: 'read_file', arguments: { path: path.join(h.home, '.ssh', 'id_ed25519') } }] };
      if (i === 3) return { toolCalls: [{ name: 'bash', arguments: { command: 'tr "\\0" "\\n" < /proc/$PPID/environ' } }] };
      return { content: 'done' };
    });
    // sandbox off and no lifetime wrapper: only the permission engine stands between the model and the key
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', sandbox: { runner: 'none' }, shell: { processLifetime: 'off' }, agent: { requireVerification: false } });
    const asked: string[] = [];
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { requestPermission: async (r) => (asked.push(`${r.tool}: ${r.reason}`), { decision: 'deny' }) } });
    await agent.run('check the keys');
    await agent.dispose();
    await srv.close();
    assert.ok(!JSON.stringify(srv.requests).includes(h.canary), 'the canary never reached the model');
    assert.equal(asked.length, 4, asked.join('\n'));
    assert.match(asked[0]!, /bash: the command reads a credential store \(~\/\.ssh\); credential stores need your approval in every mode/);
    assert.match(asked[1]!, /credential store \(~\/\.aws\)/);
    assert.match(asked[2]!, /read_file: reads a credential store \(~\/\.ssh\)/);
    assert.match(asked[3]!, /another process's environment/);
    // headless (no human): the same calls are denied
    const srv2 = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'cat "$HOME/.ssh/id_ed25519"' } }] } : { content: 'done' }));
    const a2 = await Agent.create({ workspace: ws, config: testConfig(srv2.url, { permissionMode: 'yolo', sandbox: { runner: 'none' }, agent: { requireVerification: false } }), mcp: false });
    await a2.run('x');
    await a2.dispose();
    await srv2.close();
    assert.match(lastToolResult(srv2.requests[1]), /no user is available to approve this \(the command reads a credential store/);
    // ordinary commands and workspace files are untouched
    const { credentialReference } = await import('../src/core/permissions/policy.js');
    for (const c of ['npm test', 'cat src/.ssh-notes.md', 'ls ~/projects', 'cat /proc/self/environ', 'git log']) assert.equal(credentialReference({ command: c, cwd: ws, workspace: ws }), null, c);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ SAC5 (WS17 review F2): no host daemon socket reachable

/** A fake container-daemon socket in a fake $XDG_RUNTIME_DIR, and one under /run when this user may create it. */
async function daemonSockets() {
  const net = await import('node:net');
  const rt = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-sac5-run-')));
  const socks = [path.join(rt, 'docker.sock')];
  const runSock = path.join('/run', `oh-sac5-${crypto.randomBytes(4).toString('hex')}.sock`);
  try {
    fs.accessSync('/run', fs.constants.W_OK);
    socks.push(runSock);
  } catch {
    /* not root: /run is covered by the real Docker socket when present */
  }
  let hits = 0;
  const servers = await Promise.all(socks.map((s) => new Promise<import('node:net').Server>((r) => {
    const srv = net.createServer((c) => (hits++, c.end('HTTP/1.0 200 OK\r\n\r\n{"ApiVersion":"fake"}')));
    srv.listen(s, () => r(srv));
  })));
  const old = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = rt;
  // a probe the policy layer cannot see (a script file), so the sandbox itself is what is tested
  const probe = `import socket, sys\nfor p in sys.argv[1:]:\n    try:\n        s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(p); s.send(b'GET /version HTTP/1.0\\r\\n\\r\\n'); print('REACHED', p, s.recv(100))\n    except Exception as e:\n        print('BLOCKED', p, type(e).__name__)\n`;
  const real = ['/var/run/docker.sock', '/run/containerd/containerd.sock', '/run/podman/podman.sock'].filter((p) => fs.existsSync(p));
  return {
    socks: [...socks, ...real],
    hits: () => hits,
    probe,
    close: () => {
      for (const s of servers) s.close();
      fs.rmSync(runSock, { force: true });
      if (old === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = old;
    },
  };
}

for (const runner of ['bwrap', 'landlock'] as const) {
  test(`N36 SAC5 (${runner}): no host daemon socket is reachable ($XDG_RUNTIME_DIR, /run, the real Docker socket)`, { skip: (runner === 'bwrap' ? !HAVE_BWRAP : !LL.ok) && `${runner} not available` }, async () => {
    const d = await daemonSockets();
    try {
      const ws = tmpWorkspace({});
      fs.writeFileSync(path.join(ws, 'probe.py'), d.probe);
      // network "host" too: a socket is not network, so the namespace alone never closed it
      for (const network of ['auto', 'host'] as const) {
        const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner, network } });
        const r = await sh(cfg, ws, `python3 probe.py ${d.socks.join(' ')}`);
        assert.doesNotMatch(r.output, /REACHED/, `${runner}/${network}: ${r.output}`);
        assert.equal((r.output.match(/BLOCKED/g) ?? []).length, d.socks.length, r.output);
      }
      assert.equal(d.hits(), 0, 'no connection reached a daemon socket');
      // the opt-out exists and works (so the test measures the control): sandbox.unixSockets "allow"
      const open = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner, unixSockets: 'allow', network: 'host' } });
      const r2 = await sh(open, ws, `python3 probe.py ${d.socks[0]}`);
      assert.match(r2.output, /REACHED/, r2.output);
    } finally {
      d.close();
    }
  });
}

test('N36 SAC5 (seatbelt, unit): the profile denies daemon sockets in every network mode; restrictive too', () => {
  for (const network of ['none', 'proxy', 'host'] as const)
    for (const style of ['permissive', 'restrictive'] as const) {
      const p = seatbeltProfile({ workspace: '/Users/me/proj', writable: [], readOnly: [], network, proxyPort: 4100, style });
      assert.match(p, /\(literal "\/var\/run\/docker\.sock"\)/);
      if (network === 'host') {
        assert.match(p, /\(deny network-outbound\n {2}\(remote unix-socket \(path-regex #"\/\(docker\|dockerd\|containerd\|podman/, `${style}/${network}`);
        assert.ok(p.lastIndexOf('(deny network-outbound') > p.lastIndexOf('(allow network'), 'the deny is the last network rule');
      } else {
        // `(deny network*)` refuses every unix-socket connect; nothing after it allows one
        assert.match(p, /\(deny network\*\)/, `${style}/${network}`);
        assert.doesNotMatch(p.slice(p.lastIndexOf('(deny network*)')), /allow network-outbound \(remote unix/, `${style}/${network}`);
      }
    }
  assert.doesNotMatch(seatbeltProfile({ workspace: '/w', writable: [], readOnly: [], network: 'host', unixSockets: 'allow' }), /remote unix-socket/);
});

test('N36 SAC5 (docker/podman per command, container session): the daemon socket is never mounted', { skip: !runnerAvailable('podman') && 'podman not available', timeout: 300_000 }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'podman' }, shell: { dockerImage: 'docker.io/library/alpine:3.20' } });
  const r = await sh(cfg, ws, 'ls -la /var/run/docker.sock /run/docker.sock /run/podman/podman.sock 2>&1; echo rc=$?', 240_000);
  assert.match(r.output, /No such file or directory/);
  assert.doesNotMatch(r.output, /^s/m, 'no socket file inside the container');
  // the container session never passes the socket (or any host path but the workspace, the session home and the harness)
  const { innerConfig } = await import('../src/core/sandbox/container.js');
  assert.ok(!JSON.stringify(innerConfig(testConfig('http://127.0.0.1:9/v1'), '172.17.0.1')).includes('docker.sock'));
  const src = fs.readFileSync(path.join(ROOT, 'src/core/sandbox/container.ts'), 'utf8');
  assert.doesNotMatch(src, /docker\.sock|\/var\/run|\/run\/podman/, 'container.ts mounts no runtime socket');
});

test('N36 SAC5 (policy layer, no sandbox): commands that name or open a daemon socket ask in every mode', async () => {
  const { credentialReference } = await import('../src/core/permissions/policy.js');
  const ws = tmpWorkspace({});
  for (const c of ['curl --unix-socket /var/run/docker.sock http://d/version', 'docker run --rm alpine true', 'docker -H tcp://10.0.0.1 ps', 'podman run -v /:/host alpine', 'nc -U /run/containerd/containerd.sock', 'DOCKER_HOST=unix:///tmp/d.sock make', `python3 -c "import socket;s=socket.socket(socket.AF_UNIX)"`]) assert.match(credentialReference({ command: c, cwd: ws, workspace: ws }) ?? '', /daemon|unix-socket|DOCKER_HOST/, c);
  for (const c of ['ls /run', 'python3 -m http.server 8000', 'grep docker README.md', 'npm test', 'docker ps']) assert.equal(credentialReference({ command: c, cwd: ws, workspace: ws }), null, c);
});
