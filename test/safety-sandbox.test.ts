/** SPEC C2: OS sandbox for commands (bwrap, Seatbelt profile, allowlist proxy). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { commandWrapperFor, execCommand, scrubbedEnv } from '../src/core/tools/shell.js';
import { closeSandboxProxies, lifetimeAvailable, runnerAvailable, seatbeltProfile, selectRunner, sandboxWrapper, bwrapArgs } from '../src/core/sandbox/index.js';
import { DomainProxy, matchDomain } from '../src/core/sandbox/proxy.js';
import type { HarnessConfig } from '../src/core/config.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const HAVE_BWRAP = runnerAvailable('bwrap');
const HAVE_CURL = fs.existsSync('/usr/bin/curl');
after(() => closeSandboxProxies());

// CI sets TUG_REQUIRE_BWRAP=1 on Linux, so the sandbox tests below can never skip silently there (R7 review).
test('C2 [CI]: bwrap is available where the environment requires it', { skip: process.env.TUG_REQUIRE_BWRAP !== '1' && 'TUG_REQUIRE_BWRAP not set' }, () => {
  assert.ok(HAVE_BWRAP, 'TUG_REQUIRE_BWRAP=1 but bwrap cannot create a sandbox here (install bubblewrap; on Ubuntu 24.04 allow unprivileged user namespaces)');
});

async function sh(cfg: HarnessConfig, ws: string, command: string): Promise<{ exitCode: number | null; output: string }> {
  return execCommand({ shellCommand: command, cwd: ws, timeoutMs: 30_000, env: scrubbedEnv(cfg.shell.scrubEnv), wrap: commandWrapperFor(cfg) });
}

test('C2 AC1 [CI]: with bwrap, writing outside the workspace fails and writing inside succeeds', { skip: !HAVE_BWRAP && 'bwrap not installed (apt-get install -y bubblewrap)' }, async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const outsideDir = fs.mkdtempSync(path.join(os.homedir(), '.oh-sbx-outside-'));
  try {
    const srv = await startMockServer((_b, i) => {
      if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: `echo inside > inside.txt && echo ok-inside` } }] };
      // R1: the static check now refuses plain spellings of these writes before anything runs; the targets are
      // built with $(…) so the static parse cannot see them and the sandbox itself is what is tested here.
      if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: `echo pwned > "$(echo ${outsideDir})/outside.txt"; echo exit=$?` } }] };
      if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: `mkdir -p .git/hooks; echo evil > "$(echo .git)/hooks/pre-commit"; echo hook-exit=$?` } }] };
      return { content: 'done' };
    });
    fs.mkdirSync(path.join(ws, '.git/hooks'), { recursive: true });
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', shell: { sandbox: 'bwrap' }, agent: { requireVerification: false } });
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('go');
    await srv.close();
    assert.match(lastToolResult(srv.requests[1]), /ok-inside[\s\S]*exit code 0/);
    assert.equal(fs.readFileSync(path.join(ws, 'inside.txt'), 'utf8'), 'inside\n');
    assert.match(lastToolResult(srv.requests[2]), /Read-only file system[\s\S]*exit=1/);
    assert.equal(fs.existsSync(path.join(outsideDir, 'outside.txt')), false, 'nothing written outside the workspace');
    assert.match(lastToolResult(srv.requests[3]), /hook-exit=1/, '.git/hooks stays read-only inside the workspace');
    assert.equal(fs.existsSync(path.join(ws, '.git/hooks/pre-commit')), false);
    // /tmp inside the sandbox is private
    const r = await sh(cfg, ws, 'echo t > /tmp/oh-sbx-private && cat /tmp/oh-sbx-private');
    assert.equal(r.exitCode, 0);
    assert.equal(fs.existsSync('/tmp/oh-sbx-private'), false);
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('C2 AC2 [CI]: curl to a non-allowlisted domain fails; an allowlisted one passes through the proxy', { skip: (!HAVE_BWRAP || !HAVE_CURL) && 'needs bwrap and curl' }, async () => {
  const site = http.createServer((req, res) => res.end(`hello from allowed site ${req.url}`));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as any).port;
  try {
    const ws = tmpWorkspace({});
    const cfg = testConfig('http://127.0.0.1:9/v1', { shell: { sandbox: 'bwrap' }, sandbox: { allowDomains: ['localhost'], upstreamProxy: 'none' } });
    // allowed: plain HTTP through the proxy
    const ok = await sh(cfg, ws, `curl -sS -m 10 http://localhost:${port}/a`);
    assert.equal(ok.exitCode, 0, ok.output);
    assert.match(ok.output, /hello from allowed site \/a/);
    // allowed: CONNECT tunnel through the proxy (curl -p forces CONNECT)
    const tun = await sh(cfg, ws, `curl -sS -m 10 -p http://localhost:${port}/tunnel`);
    assert.equal(tun.exitCode, 0, tun.output);
    assert.match(tun.output, /hello from allowed site \/tunnel/);
    // blocked: a non-allowlisted domain (HTTPS → CONNECT refused with 403)
    const bad = await sh(cfg, ws, 'curl -sS -m 10 https://example.com/ -o /dev/null');
    assert.notEqual(bad.exitCode, 0);
    assert.match(bad.output, /403|CONNECT/);
    const bad2 = await sh(cfg, ws, 'curl -sS -m 10 -w "%{http_code}" http://example.org/ -o /dev/null');
    assert.match(bad2.output, /403/);
    // bypassing the proxy does not work: the sandbox has no network of its own
    const direct = await sh(cfg, ws, `curl -sS -m 5 --noproxy '*' http://127.0.0.1:${port}/direct`);
    assert.notEqual(direct.exitCode, 0);
    assert.doesNotMatch(direct.output, /hello from allowed site/);
  } finally {
    site.close();
  }
});

test('C2 AC2: blocked hosts are reported back to the model after the command', { skip: (!HAVE_BWRAP || !HAVE_CURL) && 'needs bwrap and curl' }, async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'curl -sS -m 5 https://evil.example.com/x -o /dev/null; true' } }] } : { content: 'done' }));
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', shell: { sandbox: 'bwrap' }, sandbox: { allowDomains: ['registry.npmjs.org'], upstreamProxy: 'none' } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await agent.run('go');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /\[sandbox\] network access blocked: evil\.example\.com \(not in sandbox\.allowDomains\)/);
});

test('C2: without allowDomains a bwrap sandbox has no network at all', { skip: (!HAVE_BWRAP || !HAVE_CURL) && 'needs bwrap and curl' }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { shell: { sandbox: 'bwrap' } });
  const r = await sh(cfg, ws, 'curl -sS -m 5 https://example.com -o /dev/null');
  assert.notEqual(r.exitCode, 0);
});

test('C2 [LIVE-net, optional]: an allowlisted public domain is reachable through the proxy chained to the upstream', { skip: (process.env.TUG_TEST_NETWORK !== '1' || !HAVE_BWRAP) && 'set TUG_TEST_NETWORK=1 (needs outbound network)' }, async () => {
  const ws = tmpWorkspace({});
  const cfg = testConfig('http://127.0.0.1:9/v1', { shell: { sandbox: 'bwrap' }, sandbox: { allowDomains: ['example.com'] } });
  const r = await sh(cfg, ws, 'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://example.com/');
  assert.match(r.output, /200/, r.output);
});

test('C2 AC3 [DEVICE unit]: the Seatbelt profile allows writes only to workspace/tmp/caches and network only to the proxy', () => {
  const p = seatbeltProfile({ workspace: '/Users/me/proj', writable: ['/Users/me/.npm'], readOnly: ['.git/hooks', '.tugline'], network: 'proxy', proxyPort: 41234 });
  assert.match(p, /^\(version 1\)/);
  assert.match(p, /\(allow default\)\n\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\*\n {2}\(subpath "\/Users\/me\/proj"\)\n {2}\(subpath "\/private\/tmp"\)\n {2}\(subpath "\/private\/var\/folders"\)/);
  assert.match(p, /\(subpath "\/Users\/me\/\.npm"\)/);
  assert.match(p, /\(deny file-write\*\n {2}\(subpath "\/Users\/me\/proj\/\.git\/hooks"\)\n {2}\(subpath "\/Users\/me\/proj\/\.tugline"\)\)/);
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /\(allow network-outbound \(remote ip "localhost:41234"\)\)/);
  // the deny-after-allow order matters in SBPL (last match wins)
  assert.ok(p.indexOf('(deny network*)') < p.indexOf('(allow network-outbound'));
  assert.ok(p.indexOf('(allow file-write*') < p.lastIndexOf('(deny file-write*'));
  // quoting cannot be broken out of
  const q = seatbeltProfile({ workspace: '/tmp/a"b\\c', writable: [], readOnly: [], network: 'none' });
  assert.match(q, /\(subpath "\/tmp\/a\\"b\\\\c"\)/);
  assert.doesNotMatch(q, /network-outbound/);
  assert.ok(fs.existsSync(path.join(process.cwd(), 'scripts/device-checks/sandbox-macos.sh')), 'device check script exists');
});

test('C2: selection is auto → bwrap on Linux / seatbelt on macOS / none with a warning', () => {
  const cfg = (sandbox: any) => ({ ...testConfig('http://x/v1'), shell: { ...testConfig('http://x/v1').shell, sandbox } }) as HarnessConfig;
  const all = () => true;
  const none = () => false;
  if (process.platform === 'linux') assert.equal(selectRunner(cfg('auto'), all).kind, 'bwrap');
  // N30 AC3: on macOS, auto uses Seatbelt once it is verified (device-check pass marker or sandbox.macosSeatbelt)
  if (process.platform === 'darwin') assert.equal(selectRunner({ ...cfg('auto'), sandbox: { macosSeatbelt: true } } as HarnessConfig, all).kind, 'seatbelt');
  const n = selectRunner(cfg('auto'), none);
  assert.equal(n.kind, 'none');
  assert.match(n.unavailable!, /no OS sandbox/);
  assert.equal(selectRunner(cfg('none'), all).kind, 'none');
  assert.equal(selectRunner(cfg('docker'), all).kind, 'docker');
});

test('C2: an explicitly requested but unavailable sandbox fails closed', async () => {
  const ws = tmpWorkspace({});
  const want = process.platform === 'darwin' ? 'bwrap' : 'seatbelt';
  const cfg = testConfig('http://127.0.0.1:9/v1', { shell: { sandbox: want } });
  const r = await sh(cfg, ws, 'echo should-not-run');
  assert.equal(r.exitCode, 126);
  assert.doesNotMatch(r.output, /should-not-run/);
  assert.match(r.output, /command not run: .* not available/);
  // managed forceSandbox (required) with auto and nothing available also refuses
  const forced = testConfig('http://127.0.0.1:9/v1', { shell: { sandbox: 'none' }, sandbox: { required: true } });
  assert.equal((await sh(forced, ws, 'echo x')).exitCode, 126);
});

test('C2: bwrap arguments bind the workspace rw, persistence paths ro, and run the bridge only with the proxy', () => {
  const spec = { file: '/bin/bash', args: ['-c', 'ls'], cwd: '/w', env: {} };
  const a = bwrapArgs(spec, { workspace: '/w', writable: ['/c'], readOnly: ['.git/hooks'], network: 'none' });
  const s = a.join(' ');
  assert.match(s, /^--ro-bind \/ \/ --dev \/dev --proc \/proc --tmpfs \/tmp (?:--tmpfs \S+ --remount-ro \S+ )*--bind-try \/c \/c --bind \/w \/w --ro-bind-try \/w\/\.git\/hooks \/w\/\.git\/hooks --unshare-net --unshare-pid --die-with-parent --chdir \/w -- \/bin\/bash -c ls$/);
  const p = bwrapArgs(spec, { workspace: '/w', writable: [], readOnly: [], network: 'proxy', proxySocket: '/s/d/proxy.sock', nodePath: '/node' });
  assert.ok(p.includes('--unshare-net'));
  assert.deepEqual(p.slice(p.indexOf('--') + 1, p.indexOf('--') + 3), ['/node', '-e']);
  assert.ok(p.join(' ').includes('/s/d/proxy.sock 3128 /bin/bash -c ls'));
  const h = bwrapArgs(spec, { workspace: '/w', writable: [], readOnly: [], network: 'host' });
  assert.ok(!h.includes('--unshare-net'));
  assert.equal(sandboxWrapper(testConfig('http://x/v1', { shell: { processLifetime: 'off' } })), undefined, 'sandbox none, lifetime off: no wrapper');
  // R1 (B): sandbox none with the default processLifetime: only the PID-namespace wrapper, where bwrap works (cwd kept, no --chdir)
  const lw = sandboxWrapper(testConfig('http://x/v1'));
  if (lifetimeAvailable()) assert.deepEqual(lw!(spec), { ...spec, file: 'bwrap', args: ['--dev-bind', '/', '/', '--unshare-pid', '--die-with-parent', '--', spec.file, ...spec.args] });
  else assert.equal(lw, undefined);
  assert.equal(sandboxWrapper({ ...testConfig('http://x/v1'), evalContainer: { name: 'x' } } as any), undefined, 'not inside an eval container');
});

test('C2: proxy allowlist matching and private-address refusal', async () => {
  assert.equal(matchDomain('github.com', ['github.com']), 'github.com');
  assert.equal(matchDomain('api.github.com', ['github.com']), undefined);
  assert.equal(matchDomain('api.github.com', ['*.github.com']), '*.github.com');
  assert.equal(matchDomain('github.com', ['*.github.com']), undefined);
  assert.equal(matchDomain('evilgithub.com', ['*.github.com']), undefined);
  assert.equal(matchDomain('GitHub.COM.', ['github.com']), 'github.com');
  const p = new DomainProxy({ allowDomains: ['*'] });
  assert.equal((await p.check('169.254.169.254', 80)).ok, false, 'cloud metadata blocked even with *');
  assert.equal((await p.check('127.0.0.1', 80)).ok, false, 'loopback blocked unless listed literally');
  assert.equal((await p.check('localhost', 80)).ok, false, 'localhost resolves to loopback');
  const lit = new DomainProxy({ allowDomains: ['localhost', '10.0.0.5'] });
  assert.equal((await lit.check('localhost', 80)).ok, true);
  assert.equal((await lit.check('10.0.0.5', 80)).ok, true);
  assert.equal((await lit.check('10.0.0.6', 80)).ok, false);
  assert.ok(p.log.length >= 3 && p.log.every((l) => !l.allowed));
});

test('C2: the proxy connects to the address it checked (no DNS-rebinding window)', async () => {
  const site = http.createServer((req, res) => res.end(`pinned ok host=${req.headers.host}`));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  const port = (site.address() as any).port;
  // A rebinding resolver: first answer is the "public" address, any later answer is internal.
  // In this test world 127.0.0.1 counts as public and 10.x as private.
  let lookups = 0;
  const proxy = new DomainProxy({
    allowDomains: ['rebind.test'],
    lookup: async () => (lookups++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.9.9.9', family: 4 }]),
    isPrivate: (ip) => ip.startsWith('10.'),
  });
  const pport = proxy.listenTcpSync();
  await new Promise((r) => setTimeout(r, 50));
  try {
    // CONNECT tunnel: must reach the checked 127.0.0.1 (the name itself does not resolve anywhere).
    const viaConnect = await new Promise<string>((resolve, reject) => {
      const s = net.connect(pport, '127.0.0.1', () => s.write(`CONNECT rebind.test:${port} HTTP/1.1\r\nHost: rebind.test:${port}\r\n\r\n`));
      let buf = '';
      let sent = false;
      s.on('data', (d) => {
        buf += d;
        if (!sent && buf.includes('\r\n\r\n')) {
          sent = true;
          if (!buf.startsWith('HTTP/1.1 200')) return reject(new Error(buf));
          buf = '';
          s.write(`GET /x HTTP/1.1\r\nHost: rebind.test:${port}\r\nConnection: close\r\n\r\n`);
        }
      });
      s.on('end', () => resolve(buf));
      s.on('error', reject);
    });
    assert.match(viaConnect, /pinned ok host=rebind\.test/);
    assert.equal(lookups, 1, 'resolved once per request');
    // Plain HTTP forward: same pinning, original Host header kept.
    const viaHttp = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: pport, path: `http://rebind.test:${port}/y`, headers: { host: `rebind.test:${port}` } }, (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => resolve(b));
      }).on('error', reject);
    });
    // The second lookup answered 10.9.9.9 (private) → refused: the check and the connection use the same answer.
    assert.match(viaHttp, /blocked \(resolves to a private address\)/);
    assert.equal(lookups, 2);
    assert.equal(proxy.log.find((l) => l.allowed)?.address, '127.0.0.1');
  } finally {
    proxy.close();
    site.close();
  }
});
