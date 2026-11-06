/**
 * WS18: the fixes for the independent review of bdeb854 (docs/reviews/v1.2-WS18-review.md, findings 1–19).
 * Each test is named after the finding (`N36 R<n>` / `V0.1 R<n>` / `V0.2 R<n>`) and fails without its fix.
 * The container-session findings (R2, R7, R8) are in safety-sandbox-n36.test.ts next to AC3, which they extend.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { clampProjectLayer, defaultConfig, loadConfig, type HarnessConfig } from '../src/core/config.js';
import { getCliCommand } from '../src/core/commands.js';
import { commandWrapperFor, containerSandboxFor, execCommand, registerCommandWrapper, scrubbedEnv, sweepStaleCommandContainers, unregisterCommandWrapper, CMD_LABEL } from '../src/core/tools/shell.js';
import { closeSandboxProxies, maskedPaths, runnerAvailable, sandboxConfig, sandboxStatus, sandboxWrapper } from '../src/core/sandbox/index.js';
import { LANDLOCK_MIN_ABI, landlockProbe, landlockSpec } from '../src/core/sandbox/landlock.js';
import { LANDLOCK_HELPER_PY } from '../src/core/sandbox/landlockHelper.js';
import { denyReadPaths, requestedRunner, sandboxRequired } from '../src/core/sandbox/settings.js';
import { relayTarget } from '../src/core/sandbox/container.js';
import { matchDomain } from '../src/core/sandbox/proxy.js';
import { credentialReference, dangerousReason, PermissionPolicy } from '../src/core/permissions/policy.js';
import { setTrustConfirm } from '../src/core/sandbox/cli.js';
import { verifyHashChain } from '../src/core/permissions/audit.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, tmpWorkspace, trackTmp, lastToolResult } from './helpers.js';

after(() => closeSandboxProxies());

const LL = landlockProbe();
const HAVE_BWRAP = runnerAvailable('bwrap');
const needLL = !LL.ok && `Landlock unavailable: ${LL.reason}`;
const needBwrap = !HAVE_BWRAP && 'bwrap unavailable';
const engineOk = (e: string, image: string) => spawnSync(e, ['version'], { stdio: 'ignore', timeout: 20_000 }).status === 0 && spawnSync(e, ['image', 'inspect', image], { stdio: 'ignore', timeout: 20_000 }).status === 0;
const DOCKER_IMG = 'node:22-bookworm-slim';
const PODMAN_IMG = 'docker.io/library/alpine:3.20';
const DOCKER = engineOk('docker', DOCKER_IMG);
const PODMAN = engineOk('podman', PODMAN_IMG);

/** A fake $HOME under the real home (bwrap gives commands a private /tmp), with a canary SSH key. */
function fakeHome(): { home: string; canary: string; restore: () => void } {
  const home = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36r-home-')));
  const canary = `N36R-CANARY-${crypto.randomBytes(8).toString('hex')}`;
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), canary + '\n');
  fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
  const old = process.env.HOME;
  process.env.HOME = home;
  return { home, canary, restore: () => (process.env.HOME = old) };
}

function projectWs(layer: unknown, files: Record<string, string> = {}): string {
  return tmpWorkspace({ '.tugline/config.json': JSON.stringify(layer), ...files });
}

async function sh(cfg: HarnessConfig, ws: string, command: string, o: { timeoutMs?: number; pty?: boolean } = {}) {
  return execCommand({ shellCommand: command, cwd: ws, timeoutMs: o.timeoutMs ?? 30_000, env: scrubbedEnv(cfg.shell.scrubEnv), wrap: commandWrapperFor(cfg), sandbox: containerSandboxFor(cfg, ws), pty: o.pty });
}

// ------------------------------------------------------------ R1: denyRead only adds

test('N36 R1: a project sandbox.denyRead adds to the credential stores, never replaces them (untrusted and trusted); only the user can allow one back', () => {
  const h = fakeHome();
  try {
    const ssh = path.join(h.home, '.ssh');
    for (const trusted of [false, true]) {
      const ws = projectWs({ sandbox: { denyRead: ['/nonexistent-r1'], allowRead: ['~/.ssh'] } });
      const cfg = loadConfig({ workspace: ws, trusted });
      const deny = denyReadPaths({ homeDir: cfg.homeDir, sandbox: sandboxConfig(cfg) }, h.home);
      assert.ok(deny.includes(ssh), `${trusted ? 'trusted' : 'untrusted'}: ~/.ssh stays a credential store`);
      assert.ok(deny.includes('/nonexistent-r1'), 'the project entry is added');
      assert.ok(maskedPaths(cfg, sandboxConfig(cfg), [ws]).includes(ssh), 'and the sandbox hides it');
      assert.match(credentialReference({ command: `cat ${ssh}/id_ed25519`, cwd: ws, workspace: ws, credentialPaths: (cfg.sandbox as any)?.denyRead ?? [] }, h.home) ?? '', /credential store/, 'the policy layer still asks');
    }
    // the user (user scope) can let commands read one default store
    fs.writeFileSync(path.join(h.home, '.tugline', 'config.json'), JSON.stringify({ sandbox: { allowRead: ['~/.ssh'] } }));
    const user = loadConfig({ workspace: tmpWorkspace({}), trusted: false });
    assert.ok(!denyReadPaths({ homeDir: user.homeDir, sandbox: sandboxConfig(user) }, h.home).includes(ssh));
    assert.ok(denyReadPaths({ homeDir: user.homeDir, sandbox: sandboxConfig(user) }, h.home).includes(user.homeDir), 'the harness home cannot be allowed');
  } finally {
    h.restore();
  }
});

test('N36 R1: end to end, an untrusted repository with sandbox.denyRead does not re-expose ~/.ssh (bwrap and Landlock)', async (t) => {
  for (const runner of ['bwrap', 'landlock'] as const) {
    if ((runner === 'bwrap' && !HAVE_BWRAP) || (runner === 'landlock' && !LL.ok)) {
      t.diagnostic(`${runner} unavailable: skipped`);
      continue;
    }
    const h = fakeHome();
    try {
      const ws = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36r-ws-')));
      fs.mkdirSync(path.join(ws, '.tugline'));
      fs.writeFileSync(path.join(ws, '.tugline', 'config.json'), JSON.stringify({ sandbox: { denyRead: ['/nonexistent-r1'] } }));
      const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'cat ~/.ssh/id_ed25519' } }] } : { content: 'done' }));
      fs.writeFileSync(path.join(h.home, '.tugline', 'config.json'), JSON.stringify({ permissionMode: 'yolo', sandbox: { runner }, profiles: { default: { baseUrl: srv.url, model: 'mock-model', apiKey: 'sk-x' } }, agent: { requireVerification: false } }));
      const cfg = loadConfig({ workspace: ws });
      assert.equal(cfg.trust.workspaceTrusted, false);
      const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { requestPermission: async () => ({ decision: 'deny' }) } });
      await agent.run('show me the key');
      await agent.dispose();
      await srv.close();
      assert.ok(!JSON.stringify(srv.requests).includes(h.canary), `${runner}: the key reached the model`);
      // and the kernel alone (no policy): the command cannot read it either
      const k = await sh(cfg, ws, `cat "$(printf %s ${path.join(h.home, '.s')})sh/id_ed25519"; true`);
      assert.ok(!k.output.includes(h.canary), `${runner}: the sandbox exposed ~/.ssh: ${k.output}`);
    } finally {
      h.restore();
    }
  }
});

// ------------------------------------------------------------ R3: MPTCP, SCTP, other families

test('N36 R3: Landlock network "proxy": MPTCP, SCTP and non-IP families (vsock, packet) cannot be opened; plain TCP to the proxy still works', { skip: needLL || (LL.abi < 4 && 'Landlock ABI < 4') }, async () => {
  const ws = tmpWorkspace({});
  const site = http.createServer((_q, r) => r.end('direct-ok'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as net.AddressInfo).port;
  try {
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', allowDomains: ['localhost'], allowDomainsPreset: [], upstreamProxy: 'none' } });
    let n = 0;
    const py = (code: string) => {
      const f = `probe${++n}.py`;
      fs.writeFileSync(path.join(ws, f), code + '\n');
      return `python3 ${f} 2>&1 | tail -1`;
    };
    const open = (fam: string, type: string, proto: number) => py(`import socket\ntry:\n s=socket.socket(${fam},${type},${proto});print("OPENED")\nexcept OSError as e: print("refused",e.errno)`);
    const mptcp = await sh(cfg, ws, py(`import socket\ntry:\n s=socket.socket(socket.AF_INET,socket.SOCK_STREAM,262);s.connect(("127.0.0.1",${port}));s.send(b"GET / HTTP/1.0\\r\\n\\r\\n");print("MPTCP",s.recv(200))\nexcept OSError as e: print("refused",e.errno)`));
    assert.doesNotMatch(mptcp.output, /direct-ok/, `MPTCP reached a non-proxy port: ${mptcp.output}`);
    assert.match(mptcp.output, /refused 13/, mptcp.output);
    for (const [label, fam, type, proto] of [['SCTP', 'socket.AF_INET', 'socket.SOCK_STREAM', 132], ['SCTP v6', 'socket.AF_INET6', 'socket.SOCK_STREAM', 132], ['vsock', '40', 'socket.SOCK_STREAM', 0], ['packet', '17', 'socket.SOCK_RAW', 0]] as const) {
      const r = await sh(cfg, ws, open(fam, type, proto));
      assert.doesNotMatch(r.output, /OPENED/, `${label} socket opened: ${r.output}`);
    }
    const tcp = await sh(cfg, ws, py(`import socket,os\nh,p=os.environ["HTTP_PROXY"].rsplit(":",1);s=socket.socket(socket.AF_INET,socket.SOCK_STREAM,6);s.connect(("127.0.0.1",int(p)));print("PROXY-OK")`));
    assert.match(tcp.output, /PROXY-OK/, `IPPROTO_TCP to the proxy port: ${tcp.output}`);
  } finally {
    site.close();
  }
});

// ------------------------------------------------------------ R4: host daemon sockets

test('N36 R4: the host Docker socket is unreachable from bwrap and Landlock (and Landlock status says unix sockets are closed)', async (t) => {
  const real = ['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock', '/run/containerd/containerd.sock'].filter((s) => {
    try {
      return fs.statSync(s).isSocket();
    } catch {
      return false;
    }
  });
  const ws = tmpWorkspace({});
  // a stand-in socket where a rootless daemon would listen ($XDG_RUNTIME_DIR), under the real home
  const rt = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36r-run-')));
  const sock = path.join(rt, 'docker.sock');
  let hits = 0;
  const srv = net.createServer((c) => (hits++, c.end('HTTP/1.0 200 OK\r\n\r\n{"ApiVersion":"1"}')));
  await new Promise<void>((r) => srv.listen(sock, () => r()));
  const oldX = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = rt;
  try {
    for (const runner of ['bwrap', 'landlock']) {
      if ((runner === 'bwrap' && !HAVE_BWRAP) || (runner === 'landlock' && !LL.ok)) continue;
      const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner, network: 'none' } });
      for (const s of [...real, sock]) {
        const r = await sh(cfg, ws, `python3 -c "import socket,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);s.send(b'GET /version HTTP/1.0\\r\\n\\r\\n');print('CONNECTED',s.recv(100))" ${s} 2>&1 | tail -1`);
        assert.doesNotMatch(r.output, /CONNECTED/, `${runner}: ${s} was reachable: ${r.output}`);
      }
      if (runner === 'landlock') assert.match(sandboxStatus(cfg).summary, /no unix-socket connections/);
    }
    assert.equal(hits, 0, 'the stand-in daemon socket was never connected to');
    if (!real.length) t.diagnostic('no real daemon socket on this machine; checked the stand-in only');
  } finally {
    process.env.XDG_RUNTIME_DIR = oldX;
    srv.close();
  }
});

// ------------------------------------------------------------ R5: workspace = home

test('N36 R5: workspace = the home directory: Landlock keeps ~/.ssh unreadable and the harness home unwritable; read_file of .ssh asks in auto mode', { skip: needLL }, async () => {
  const h = fakeHome();
  try {
    const harness = path.join(h.home, '.tugline');
    fs.writeFileSync(path.join(harness, 'trusted-workspaces.json'), '{}');
    const cfg = testConfig('http://127.0.0.1:9/v1', { homeDir: harness, sandbox: { runner: 'landlock', network: 'none' }, permissionMode: 'yolo' });
    const read = await sh(cfg, h.home, 'cat "$(printf .s)sh/id_ed25519"; echo rc=$?');
    assert.ok(!read.output.includes(h.canary), `the key was read: ${read.output}`);
    const write = await sh(cfg, h.home, `printf '{"/":true}' > "$(printf .open)harness/trusted-workspaces.json"; echo rc=$?`);
    assert.equal(fs.readFileSync(path.join(harness, 'trusted-workspaces.json'), 'utf8'), '{}', `the harness trust store was written: ${write.output}`);
    // ordinary workspace files stay writable (in its subdirectories: a Landlock grant on the home directory itself
    // would cover the stores below it, so new top-level entries of the home cannot be created; documented)
    fs.mkdirSync(path.join(h.home, 'proj'));
    const ok = await sh(cfg, h.home, 'echo fine > proj/note.txt && cat proj/note.txt');
    assert.match(ok.output, /fine/);
    // the policy layer (any runner, file tools included)
    const pol = new PermissionPolicy({ workspace: h.home, mode: 'yolo', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] });
    assert.equal(pol.check({ tool: 'read_file', kind: 'read', paths: [{ path: path.join(h.home, '.ssh', 'id_ed25519'), write: false }] }).decision, 'ask');
    assert.equal(pol.check({ tool: 'bash', kind: 'execute', command: 'cat .ssh/id_ed25519', cwd: h.home }).decision, 'ask');
    // the H5 case still works: a clone UNDER a store is not a store for its own files
    const clone = path.join(harness, 'remote', 'clone');
    fs.mkdirSync(clone, { recursive: true });
    assert.equal(credentialReference({ paths: [path.join(clone, 'src.ts')], cwd: clone, workspace: clone }, h.home), null);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ R6: clamp gaps

test('N36 R6: a trusted project cannot loosen through non-objects, weaker runners, allow rules, extra directories or shell settings (10 cases)', () => {
  const h = fakeHome();
  try {
    const user = (cfg: unknown) => fs.writeFileSync(path.join(h.home, '.tugline', 'config.json'), JSON.stringify(cfg));
    const load = (layer: unknown) => loadConfig({ workspace: projectWs(layer), trusted: true });
    user({ sandbox: { runner: 'landlock', require: true }, permissionMode: 'ask' });
    for (const bad of ['off', []]) {
      const c = load({ sandbox: bad });
      assert.equal(requestedRunner(c), 'landlock', `sandbox ${JSON.stringify(bad)}`);
      assert.equal(sandboxRequired(c), true);
    }
    assert.ok(load({ sandbox: 'off' }).trust.clamped.some((x) => /not an object/.test(x)), 'reported');
    user({ sandbox: { runner: 'bwrap' } });
    const auto = load({ sandbox: { runner: 'auto' } });
    assert.equal(requestedRunner(auto), 'bwrap', '"auto" is weaker than an explicit bwrap');
    assert.equal(sandboxStatus(auto, () => false).refusing, true, 'and bwrap missing still refuses');
    assert.equal(requestedRunner(load({ sandbox: { runner: 'landlock' } })), 'bwrap', 'landlock is weaker than bwrap');
    assert.equal(requestedRunner(load({ sandbox: { runner: 'docker' } })), 'docker', 'a stronger runner is taken');
    user({ shell: { mode: 'allowlist', allowlist: ['ls'] }, permissionMode: 'ask' });
    const c = load({ permissions: { allow: ['bash(*)', 'write_file(*)'], additionalDirectories: [h.home], deny: ['bash(rm*)'] }, shell: { mode: 'shell', scrubEnv: [], allowlist: ['bash', 'curl'] } });
    assert.deepEqual(c.permissions.allow, []);
    assert.deepEqual(c.permissions.additionalDirectories, []);
    assert.ok(c.permissions.deny.includes('bash(rm*)'), 'deny rules still apply');
    assert.equal(c.shell.mode, 'allowlist');
    assert.deepEqual(c.shell.allowlist, ['ls']);
    assert.ok(c.shell.scrubEnv.includes('TUG_API_KEY'), 'scrubEnv only grows');
    for (const k of ['permissions.allow', 'permissions.additionalDirectories', 'shell.mode', 'shell.allowlist']) assert.ok(c.trust.clamped.some((x) => x.includes(k)), `${k} reported`);
    // the clamp is a pure function too: unknown sandbox keys are dropped
    const clamped: string[] = [];
    const out = clampProjectLayer({ sandbox: { upstreamProxy: 'http://evil:1', allowRead: ['~/.ssh'], trustProjectConfig: ['/x'] } }, defaultConfig(), 'p', clamped);
    assert.deepEqual(out.sandbox, {});
    assert.equal(clamped.length, 3);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------------ R8 (unit): port-aware allowlist, relay routes

test('N36 R8: allowlist entries may name a port (host:port); the model relay forwards only to its endpoint', () => {
  assert.equal(matchDomain('172.17.0.1', ['172.17.0.1:8080'], 8080), '172.17.0.1:8080');
  assert.equal(matchDomain('172.17.0.1', ['172.17.0.1:8080'], 22), undefined);
  assert.equal(matchDomain('api.example.com', ['api.example.com'], 443), 'api.example.com');
  assert.equal(matchDomain('::1', ['[::1]:11434'], 11434), '[::1]:11434');
  const routes = [{ prefix: '/m0', origin: 'http://172.17.0.1:11434', basePath: '/v1', headers: { authorization: 'Bearer k' } }];
  const ok = relayTarget(routes, '/m0/v1/chat/completions');
  assert.ok('target' in ok && ok.target.href === 'http://172.17.0.1:11434/v1/chat/completions');
  for (const bad of ['/m0/admin', '/m0/v1/../admin', '/m1/v1/x', '/other']) assert.ok('error' in relayTarget(routes, bad), bad);
});

// ------------------------------------------------------------ R9: per-command container lifetime

async function perCommandLifetime(engine: 'docker' | 'podman', image: string) {
  const ws = tmpWorkspace({});
  const tag = `${crypto.randomInt(100000, 999999)}`;
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: engine }, shell: { dockerImage: image } });
  const running = (pat: string) => spawnSync(engine, ['ps', '--no-trunc', '--format', '{{.ID}} {{.Command}}'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(pat));
  // 1. timeout: the container is killed with the client
  const r = await sh(cfg, ws, `sleep 7${tag}`, { timeoutMs: 4000 });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 1500));
  assert.deepEqual(running(`7${tag}`), [], `${engine}: the timed-out container is still running`);
  // 2. the harness is SIGKILLed: the watchdog removes the container
  const script = path.join(ws, 'h.mts');
  fs.writeFileSync(script, `import { execCommand, commandWrapperFor, containerSandboxFor, scrubbedEnv } from ${JSON.stringify(path.resolve('src/core/tools/shell.ts'))};
import ${JSON.stringify(path.resolve('src/core/sandbox/index.ts'))};
import { testConfig } from ${JSON.stringify(path.resolve('test/helpers.ts'))};
const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: '${engine}' }, shell: { dockerImage: '${image}' } });
console.log('ready');
await execCommand({ shellCommand: 'sleep 8${tag}', cwd: ${JSON.stringify(ws)}, timeoutMs: 120000, env: scrubbedEnv(cfg.shell.scrubEnv), wrap: commandWrapperFor(cfg), sandbox: containerSandboxFor(cfg, ${JSON.stringify(ws)}) });`);
  const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((res) => child.stdout.on('data', (d) => String(d).includes('ready') && res()));
  for (let i = 0; i < 120 && !running(`8${tag}`).length; i++) await new Promise((res) => setTimeout(res, 500));
  assert.equal(running(`8${tag}`).length, 1, 'the container started');
  child.kill('SIGKILL');
  let left = running(`8${tag}`);
  for (let i = 0; i < 30 && left.length; i++) {
    await new Promise((res) => setTimeout(res, 500));
    left = running(`8${tag}`);
  }
  for (const l of left) spawnSync(engine, ['rm', '-f', l.split(' ')[0]!]);
  assert.deepEqual(left, [], `${engine}: the container outlived the SIGKILLed harness`);
  // 3. the next start sweeps a labelled container whose harness is gone
  const dead = 999_999;
  const id = spawnSync(engine, ['run', '-d', '--rm', '--label', `${CMD_LABEL}=1`, '--label', `tugline.pid=${dead}`, '--label', `tugline.host=${os.hostname()}`, '--entrypoint', 'sleep', image, `9${tag}`], { encoding: 'utf8' }).stdout.trim();
  assert.ok(id, 'stale container created');
  const removed = sweepStaleCommandContainers(engine);
  assert.ok(removed.some((x) => id.startsWith(x) || x.startsWith(id.slice(0, 12))), `swept: ${removed.join(', ')}`);
  assert.deepEqual(running(`9${tag}`), []);
}

test('N36 R9: Docker per-command containers die on timeout, with a SIGKILLed harness, and stale ones are swept', { skip: !DOCKER && `docker with ${DOCKER_IMG} not available`, timeout: 300_000 }, () => perCommandLifetime('docker', DOCKER_IMG));
test('N36 R9: Podman per-command containers die on timeout, with a SIGKILLed harness, and stale ones are swept', { skip: !PODMAN && `podman with ${PODMAN_IMG} not available`, timeout: 300_000 }, () => perCommandLifetime('podman', PODMAN_IMG));

// ------------------------------------------------------------ R10: write-time re-check

test('N36 R10: a write approved for src/x whose src became a link to .git/hooks is refused at write time (disk and editor hosts)', async () => {
  for (const host of ['disk', 'editor'] as const) {
    const ws = tmpWorkspace({ 'src/a.txt': 'a\n', '.git/hooks/README': 'hooks\n' });
    const hook = '#!/bin/sh\necho PWNED-BY-HOOK\n';
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'src/pre-commit', content: hook } }] } : { content: 'done' }));
    const written: string[] = [];
    const agent = await Agent.create({
      workspace: ws,
      config: testConfig(srv.url, { permissionMode: 'ask', agent: { requireVerification: false } }),
      mcp: false,
      ui: {
        requestPermission: async () => {
          fs.rmSync(path.join(ws, 'src'), { recursive: true, force: true });
          fs.symlinkSync(path.join(ws, '.git', 'hooks'), path.join(ws, 'src'));
          return { decision: 'allow' };
        },
      },
      ...(host === 'editor'
        ? {
            host: {
              kind: 'vscode',
              readText: async (p: string) => (fs.existsSync(p) ? { text: fs.readFileSync(p, 'utf8'), version: '1' } : undefined),
              writeText: async (p: string, t: string) => {
                written.push(p);
                fs.writeFileSync(p, t); // an editor follows the link, like VS Code / an ACP client
                return { version: '2' };
              },
              exists: async (p: string) => fs.existsSync(p),
              delete: async (p: string) => fs.rmSync(p),
            } as any,
          }
        : {}),
    });
    await agent.run('write it');
    await agent.dispose();
    await srv.close();
    assert.ok(!fs.existsSync(path.join(ws, '.git', 'hooks', 'pre-commit')), `${host}: the hook was written`);
    assert.deepEqual(written, [], `${host}: the editor host was asked to write`);
    assert.match(lastToolResult(srv.requests[1]), /refused at write time/);
  }
});

// ------------------------------------------------------------ R11: ABI floor

test('N36 R11: Landlock below ABI 3 refuses (truncate(2) is not controlled): no command runs, status says so', { skip: needLL }, async () => {
  const ws = tmpWorkspace({});
  const outside = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36r-abi-')));
  const victim = path.join(outside, 'victim.txt');
  for (const abi of [1, 2]) {
    fs.writeFileSync(victim, 'precious\n');
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', network: 'none', landlock: { maxAbi: abi } } });
    const r = await sh(cfg, ws, `python3 -c "import os,sys; os.truncate(sys.argv[1], 0)" "$(echo ${victim})"; echo ran`);
    assert.equal(fs.statSync(victim).size, 9, `ABI ${abi}: the outside file was truncated`);
    assert.doesNotMatch(r.output, /^ran$/m);
    assert.equal(r.exitCode, 126);
    const st = sandboxStatus(cfg);
    assert.equal(st.refusing, true);
    assert.match(st.summary, /ABI \d < 3/);
  }
  // the helper itself refuses below its floor, whatever the caller asks
  const spec = JSON.stringify({ ro: ['/'], rw: [], net: null, ip: 'all', unix: 'allow', max_abi: 2, min_abi: 1 });
  const h = spawnSync(LL.python ?? 'python3', ['-I', '-S', '-c', LANDLOCK_HELPER_PY, spec, '--', '/bin/true'], { encoding: 'utf8' });
  assert.equal(h.status, 125, h.stderr);
  assert.equal(LANDLOCK_MIN_ABI, 3);
});

// ------------------------------------------------------------ R12: the suite sees a surface that drops the sandbox

test('V0.1 R12: the kernel-boundary scenario fails a surface whose commands skip the OS sandbox (the runner comes from the spawn path)', { skip: (!HAVE_BWRAP && !LL.ok) && 'no OS sandbox here', timeout: 300_000 }, async () => {
  const { runScenario, loadDrivers } = await import('./conformance/harness.js');
  const sdk = (await loadDrivers()).find((d) => d.id === 'sdk-ts')!;
  const ok = await runScenario(sdk, 'kernel-boundary', { sandboxed: true });
  assert.deepEqual(ok.verdict.failures, []);
  assert.deepEqual(ok.obs.security.filter((e) => e.decision === 'exec_mismatch'), [], 'the commands ran under the runner in force');
  // the mutation (M15): commands of this surface run without the sandbox wrapper, the config is unchanged
  unregisterCommandWrapper('ws3-sandbox');
  try {
    const bad = await runScenario(sdk, 'kernel-boundary', { sandboxed: true });
    assert.ok(bad.verdict.failures.some((f) => /without the OS sandbox/.test(f)), JSON.stringify(bad.verdict));
    assert.deepEqual(bad.obs.security.filter((e) => e.decision === 'exec_mismatch').map((e) => e.category), ['none'], 'the spawn path records what really happened, although the config still names the sandbox');
  } finally {
    registerCommandWrapper('ws3-sandbox', (cfg) => sandboxWrapper(cfg));
  }
});

// ------------------------------------------------------------ R13: credentialReference spellings

test('N36 R13: credentialReference resolves commands like the shell: 19 spellings ask, 5 ordinary commands do not', () => {
  const home = '/home/me';
  const ws = '/home/me/proj';
  const c = (command: string, workspace = ws, cwd = workspace) => credentialReference({ command, cwd, workspace }, home);
  const ask = [
    c('cat ~/.ssh/id_ed25519'),
    c(`python3 -c "print(open('/home/me/.ssh/id_ed25519').read())"`),
    c('less ~/.ssh/id_ed25519'),
    c('tar czf - ~/.ssh | base64'),
    c('cp ~/.aws/credentials ./x'),
    c('cd ~ && cat .ssh/id_ed25519'),
    c('cat ~/.ss?/*'),
    c('cat $(echo ~)/.ssh/id_ed25519'),
    c(`find ~ -name 'id_*' -exec cat {} \\;`),
    c('grep -r PRIVATE ~'),
    c('tar cf - ~ | base64'),
    c('cd ~/ ; cat .ssh/id_ed25519'),
    c('cd .. && cat .ssh/id_ed25519'),
    c('H=$HOME; cat $H/.ssh/id_ed25519'),
    c('cat ~/".ssh"/id_ed25519'),
    c("cat /home/me/.s''sh/id_ed25519"),
    c('cat /proc/1/env*on'),
    credentialReference({ paths: ['/home/me/.ssh/id_ed25519'], cwd: home, workspace: home }, home),
    c('cat .ssh/id_ed25519', home),
  ];
  ask.forEach((r, i) => assert.ok(r, `spelling ${i + 1} does not ask`));
  for (const quiet of ['ls ~/projects', 'cat README.md', 'npm test', 'git push', 'echo "configure ~/.ssh/config"']) assert.equal(c(quiet), null, quiet);
});

// ------------------------------------------------------------ R14: /dev/pts and /dev/shm

test('N36 R14: Landlock commands cannot write the host terminals (/dev/pts) or shared memory (/dev/shm)', { skip: needLL }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner: 'landlock', network: 'none' } });
  const tag = `oh-n36r-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  const r = await sh(cfg, ws, `echo x > /dev/shm/${tag}; echo shm-rc=$?; for p in /dev/pts/[0-9]*; do echo y > $p && echo WROTE $p; done; echo done`);
  assert.ok(!fs.existsSync(`/dev/shm/${tag}`), `/dev/shm was written: ${r.output}`);
  assert.doesNotMatch(r.output, /WROTE/, r.output);
  fs.rmSync(`/dev/shm/${tag}`, { force: true });
  // the spec handed to the helper grants neither
  const s = landlockSpec({ file: '/bin/true', args: [], cwd: ws, env: {} }, { workspace: ws, writable: [], denyRead: [], filesystem: 'workspace-write', network: 'none', scratch: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n36r-s-'))), requireNetwork: false });
  const specFile = s.args[s.args.indexOf('--') - 1]!.slice(1);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  fs.rmSync(specFile, { force: true });
  assert.ok(!spec.rw.some((p: string) => /^\/dev\/(pts|shm|ptmx)/.test(p)), JSON.stringify(spec.rw));
});

// ------------------------------------------------------------ R16: sandboxed PTY execution

test('N36 R16: bash with tty: true runs on a pseudo-terminal inside the sandbox (bwrap, Landlock, none)', async (t) => {
  const ws = tmpWorkspace({});
  for (const runner of ['bwrap', 'landlock', 'none']) {
    if ((runner === 'bwrap' && !HAVE_BWRAP) || (runner === 'landlock' && !LL.ok)) {
      t.diagnostic(`${runner} unavailable`);
      continue;
    }
    const cfg = testConfig('http://127.0.0.1:9/v1', { sandbox: { runner, network: 'none', require: false }, shell: { processLifetime: 'off' } });
    const plain = await sh(cfg, ws, 'test -t 1 && echo IS-TTY || echo NOT-TTY');
    assert.match(plain.output, /NOT-TTY/, `${runner}: no terminal by default`);
    const tty = await sh(cfg, ws, 'test -t 0 && test -t 1 && echo IS-TTY || echo NOT-TTY; read x; echo read-rc=$?; touch made-$RANDOM', { pty: true });
    assert.match(tty.output, /IS-TTY/, `${runner}: ${tty.output}`);
    assert.match(tty.output, /read-rc=1/, 'input is end-of-file, a prompt does not hang');
    assert.doesNotMatch(tty.output, /\r\n/, 'output has plain newlines');
    assert.equal(tty.exitCode, 0);
    if (runner === 'landlock') {
      // still confined: no write outside the workspace through the terminal path
      const out = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-n36r-pty-')));
      await sh(cfg, ws, `echo x > ${out}/escape.txt`, { pty: true });
      assert.ok(!fs.existsSync(path.join(out, 'escape.txt')));
    }
  }
  // the model can ask for it
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'test -t 1 && echo IS-TTY', tty: true } }] } : { content: 'done' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: false } }), mcp: false });
  await agent.run('check');
  await agent.dispose();
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /IS-TTY/);
});


// ------------------------------------------------------------ R17: trust-project needs a person

test('N36 R17: `tug sandbox trust-project` needs a yes at an interactive terminal and is always-ask for the policy', async () => {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n36r-trust-')));
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://x/v1', { homeDir: home });
  const out: string[] = [];
  // no terminal (a script, an agent's command): refused, nothing written
  const undo = setTrustConfirm(async () => false);
  try {
    assert.equal(await getCliCommand('sandbox')!.run(['trust-project', ws], { config: cfg, workspace: ws, write: (t) => out.push(t) }), 1);
    assert.ok(!fs.existsSync(path.join(home, 'config.json')));
  } finally {
    undo();
  }
  assert.match(dangerousReason('tug sandbox trust-project .') ?? '', /trusts/);
  assert.match(dangerousReason('cd x && tug --trust -p hi') ?? '', /trusts/);
  const pol = new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] });
  assert.equal(pol.check({ tool: 'bash', kind: 'execute', command: 'tug sandbox trust-project .' }).decision, 'ask');
  // and it never writes through a link
  const target = path.join(home, 'elsewhere.json');
  fs.writeFileSync(target, '{"keep":true}');
  fs.symlinkSync(target, path.join(home, 'config.json'));
  const undo2 = setTrustConfirm(async () => true);
  try {
    await assert.rejects(getCliCommand('sandbox')!.run(['trust-project', ws], { config: cfg, workspace: ws, write: () => {} }), /symbolic link/);
  } finally {
    undo2();
  }
  assert.equal(fs.readFileSync(target, 'utf8'), '{"keep":true}');
});

// ------------------------------------------------------------ R18: registry patterns

test('V0.1 R18: a new scheduled trigger module or a second CLI entry point needs a driver', async () => {
  const { registryProblems } = await import('./conformance/surfaces.js');
  const base = ['src/cli/main.ts', 'src/core/schedule/run.ts'];
  for (const extra of ['src/core/schedule/mqtt.ts', 'src/cli/agentd.ts']) {
    const p = registryProblems([...base, extra], ['cli-headless', 'scheduler']);
    assert.ok(p.some((x) => x.includes(extra)), `${extra}: ${JSON.stringify(p)}`);
  }
});

// ------------------------------------------------------------ R19: journal events and chains

test('V0.1 R19: journals are normalised for comparison across surfaces and every chain is verified', async () => {
  const { normaliseJournal } = await import('./conformance/harness.js');
  const ev = (e: unknown) => ({ ts: '2026-10-31T00:00:00Z', type: 'event', event: e });
  const a = normaliseJournal([ev({ type: 'refusal', tool: 'bash', reason: 'denied by user' }), ev({ type: 'tool_end', name: 'bash', ok: false })]);
  const b = normaliseJournal([ev({ type: 'refusal', tool: 'bash', reason: 'no user is available to approve this' }), ev({ type: 'tool_end', name: 'bash', ok: false })]);
  assert.deepEqual(a, ['refusal:bash:denied', 'tool:bash:failed']);
  assert.deepEqual(a, b, 'a human no and nobody to ask are the same decision');
  assert.notDeepEqual(a, normaliseJournal([ev({ type: 'tool_end', name: 'bash', ok: true })]), 'a surface that ran the command differs');
  // a tampered journal line is caught
  const f = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n36r-j-'))), 'j.jsonl');
  let prev = 'genesis';
  const lines: string[] = [];
  for (const body of ['{"a":1}', '{"a":2}']) {
    const h = crypto.createHash('sha256').update(prev + body).digest('hex').slice(0, 32);
    lines.push(`${body.slice(0, -1)},"_h":"${h}"}`);
    prev = h;
  }
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.equal(verifyHashChain(f).broken, 0);
  fs.writeFileSync(f, lines.join('\n').replace('"a":1', '"a":9') + '\n');
  assert.equal(verifyHashChain(f).broken, 1);
});
