/** N22 (signed central policy, version pinning, org usage quotas) and N23 (security events and audit export). */
import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { Agent } from '../src/core/agent/agent.js';
import type { HarnessConfig } from '../src/core/config.js';
import { applyGovernance, managedWarnings } from '../src/core/policy/managed.js';
import { canonicalJson, compareVersions, signPolicyDocument, verifyPolicyDocument } from '../src/core/policy/remote.js';
import { resetOrgUsage, syncOrgUsage } from '../src/core/policy/orgUsage.js';
import { recordUsage } from '../src/core/permissions/limits.js';
import { auditCommand, auditDir, onSecurityEvent, SECURITY_EVENT_TYPES, verifyHashChain, type SecurityEvent } from '../src/core/permissions/audit.js';
import { flushAuditSinks } from '../src/core/permissions/auditSink.js';
import { setTelemetryProvider } from '../src/core/telemetry/otel.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';
// @ts-expect-error plain ESM example without types
import { startPolicyServer } from '../examples/policy-server/server.mjs';

const HAVE_PY = spawnSync('python3', ['-c', 'pass']).status === 0;

/** A managed file that points at the policy server (what MDM would install). */
function managedFile(extra: Record<string, unknown>): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-')), 'managed.json');
  fs.writeFileSync(f, JSON.stringify(extra));
  return f;
}
const govern = (cfg: HarnessConfig, file: string, o: { version?: string; now?: Date } = {}) =>
  applyGovernance(cfg, { workspace: tmpWorkspace({}), env: { TUG_MANAGED_POLICY: file }, trusted: true, systemPath: path.join(os.tmpdir(), 'oh-no-system-managed.json'), ...o });

// ------------------------------------------------------------ N22 AC1: signed remote policy

/**
 * The reference server in its own process: loadConfig fetches the policy synchronously (a child
 * process), which would deadlock against a server in this test's own event loop.
 */
async function policyServer(args: string[] = []) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'examples/policy-server/server.mjs'), '--port', '0', '--json', '--control', ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line: string = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) resolve(buf.split('\n')[0]!);
    });
    child.on('exit', (c) => reject(new Error(`policy server exited ${c}`)));
  });
  const { url, publicKey } = JSON.parse(line) as { url: string; publicKey: string };
  const control = async (c: Record<string, unknown>) => {
    try {
      await (await fetch(`${url}/_control`, { method: "POST", body: JSON.stringify(c), headers: { connection: "close" } })).text();
    } catch (e) {
      throw new Error(`control ${url}: ${(e as Error).message} ${String((e as any).cause)}`);
    }
  };
  return { url, policyUrl: `${url}/policy`, usageUrl: `${url}/usage`, auditUrl: `${url}/audit`, publicKey, control, close: async () => void child.kill() };
}
const policyFile = (o: Record<string, unknown>) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-pol-')), 'policy.json');
  fs.writeFileSync(f, JSON.stringify(o));
  return f;
};

test('N22 AC1: a signed remote policy is applied, combined restrictively with the local file', async () => {
  const srv = await policyServer(['--policy', policyFile({ deny: ['Bash(curl *)'], protectedPaths: ['infra/**'], disableAutoMode: true })]);
  try {
    const cfg = govern(testConfig('http://unused', { permissionMode: 'yolo' }), managedFile({ deny: ['Bash(rm *)'], remote: { url: srv.policyUrl, publicKey: srv.publicKey } }));
    assert.ok(cfg.permissions.deny.includes('Bash(rm *)') && cfg.permissions.deny.includes('Bash(curl *)'), `local and remote denies both apply: ${cfg.managed?.violations.join('; ')}`);
    assert.ok(cfg.permissions.protectedPaths.includes('infra/**'));
    assert.equal(cfg.permissionMode, 'ask', 'the remote disableAutoMode applies');
    assert.ok(cfg.managed!.sources.some((x) => x === srv.policyUrl));
  } finally {
    await srv.close();
  }
});

test('N22 re-check (Low): `tug doctor` warns when a remote policy is used without remote.highWaterFile (the default mark is user-writable)', async () => {
  const srv = await policyServer(['--policy', policyFile({ deny: ['Bash(curl *)'] })]);
  try {
    const bare = govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey } }));
    const w = managedWarnings(bare);
    assert.equal(w.length, 1);
    assert.match(w[0]!, /no remote\.highWaterFile.*user-writable.*MDM/);
    const hwm = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mdm-')), 'policy.hwm');
    const pinned = govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey, highWaterFile: hwm } }));
    assert.deepEqual(managedWarnings(pinned), []);
    assert.deepEqual(managedWarnings(testConfig('http://unused')), [], 'no managed policy: nothing to warn about');
  } finally {
    await srv.close();
  }
});

test('N22 AC1: a forged or unsigned remote policy is refused and reported; with failClosed it refuses to start', async () => {
  const srv = await policyServer(['--policy', policyFile({ deny: ['Bash(curl *)'] })]);
  const other = await policyServer();
  try {
    // the policy was changed after signing (a man in the middle)
    await srv.control({ tamper: 'policy' });
    const cfg = govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey } }));
    assert.ok(!cfg.permissions.deny.includes('Bash(curl *)'));
    assert.ok(cfg.managed!.violations.some((v) => /signature does not match the pinned public key/.test(v)), cfg.managed!.violations.join('\n'));
    await srv.control({ tamper: 'unsigned' });
    const cfg2 = govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey } }));
    assert.ok(cfg2.managed!.violations.some((v) => /not a signed policy document/.test(v)));
    assert.throws(() => govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey, failClosed: true } })), /not a signed/);
    // a document signed by another key (an attacker's own server) is refused too
    await srv.control({ tamper: null });
    assert.throws(() => govern(testConfig('http://unused'), managedFile({ remote: { url: srv.policyUrl, publicKey: other.publicKey, failClosed: true } })), /signature does not match/);
    // the env form needs a pinned key
    assert.throws(() => applyGovernance(testConfig('http://unused'), { workspace: tmpWorkspace({}), env: { TUG_MANAGED_POLICY_URL: srv.policyUrl }, trusted: true, systemPath: '/nonexistent/managed.json' }), /no public key is pinned/);
  } finally {
    await srv.close();
    await other.close();
  }
});

test('N22: canonical JSON and Ed25519 signatures are stable and order-independent', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, { d: null, c: 'x' }] }), '{"a":[true,{"c":"x","d":null}],"b":1}');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const doc = signPolicyDocument({ z: 1, a: 2 }, privateKey);
  const reordered = JSON.parse(JSON.stringify({ signature: doc.signature, issuedAt: doc.issuedAt, policy: { a: 2, z: 1 } }));
  assert.ok(verifyPolicyDocument(reordered, raw));
  assert.ok(verifyPolicyDocument(doc, publicKey.export({ format: 'pem', type: 'spki' }).toString()));
  assert.throws(() => verifyPolicyDocument({ ...doc, issuedAt: '2020-01-01T00:00:00.000Z' }, raw), /does not match/);
});

// ------------------------------------------------------------ N22 AC4: cache and offline

test('N22 AC4: offline, the cached policy is used until it expires; an expired cache fails closed when configured', async () => {
  const srv = await policyServer(['--policy', policyFile({ deny: ['Bash(curl *)'] }), '--ttl', '3600']);
  const cfg = testConfig('http://unused');
  const file = managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey, refreshSeconds: 0, timeoutMs: 2000 } });
  const fileClosed = managedFile({ remote: { url: srv.policyUrl, publicKey: srv.publicKey, refreshSeconds: 0, failClosed: true, timeoutMs: 2000 } });
  govern(structuredClone(cfg), file); // fetched and cached under cfg.homeDir
  await srv.close();
  // offline, within expiresAt: the cache is used
  const off = govern(structuredClone(cfg), fileClosed);
  assert.ok(off.permissions.deny.includes('Bash(curl *)'), `cached policy applied: ${off.managed?.violations.join('; ')}`);
  assert.ok(off.managed!.sources.some((x) => /\(cached /.test(x)));
  assert.ok(off.managed!.violations.some((v) => /unreachable/.test(v)), 'the failed refresh is reported');
  // two hours later the signed document has expired
  const later = new Date(Date.now() + 2 * 3600_000);
  assert.throws(() => govern(structuredClone(cfg), fileClosed, { now: later }), /expired[\s\S]*failClosed/);
  const open = govern(structuredClone(cfg), file, { now: later });
  assert.ok(!open.permissions.deny.includes('Bash(curl *)'), 'without failClosed the expired policy is not applied');
  assert.ok(open.managed!.violations.some((v) => /expired/.test(v)));
  // failClosed with no cache at all
  assert.throws(() => govern(testConfig('http://unused'), fileClosed), /failClosed/);
  // editing the cache to loosen it does not work: it is re-verified
  const cacheDir = path.join(cfg.homeDir, 'managed-cache');
  const cf = path.join(cacheDir, fs.readdirSync(cacheDir)[0]);
  const c = JSON.parse(fs.readFileSync(cf, 'utf8'));
  c.document.policy.deny = [];
  fs.writeFileSync(cf, JSON.stringify(c));
  assert.throws(() => govern(structuredClone(cfg), fileClosed), /cached remote policy ignored: signature does not match[\s\S]*failClosed/);
});

// ------------------------------------------------------------ N22 AC2: version pinning

test('N22 AC2: a version below minVersion (or above maxVersion, or not allowed) refuses to start, with a message', async () => {
  assert.throws(() => govern(testConfig('http://unused'), managedFile({ minVersion: '1.2.0' }), { version: '1.1.9' }), /Tugline 1\.1\.9 is older than the minimum version 1\.2\.0/);
  assert.throws(() => govern(testConfig('http://unused'), managedFile({ maxVersion: '1.5.0' }), { version: '2.0.0' }), /newer than the maximum version 1\.5\.0/);
  assert.throws(() => govern(testConfig('http://unused'), managedFile({ allowedVersions: ['1.0.0', '1.0.2'] }), { version: '1.0.1' }), /not one of the versions allowed/);
  assert.doesNotThrow(() => govern(testConfig('http://unused'), managedFile({ minVersion: '1.0.0', maxVersion: '1.9.9' }), { version: '1.4.0' }));
  // from the signed remote policy too; the stricter of local and remote wins
  const srv = await policyServer(['--policy', policyFile({ minVersion: '3.0.0' })]);
  try {
    assert.throws(() => govern(testConfig('http://unused'), managedFile({ minVersion: '1.0.0', remote: { url: srv.policyUrl, publicKey: srv.publicKey } }), { version: '2.0.0' }), /older than the minimum version 3\.0\.0/);
  } finally {
    await srv.close();
  }
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  // the real CLI refuses to start
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, '..', 'src/cli/main.ts'), 'usage'], { env: { ...process.env, TUG_MANAGED_POLICY: managedFile({ minVersion: '99.0.0' }), HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-')) }, encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /older than the minimum version 99\.0\.0/);
});

// ------------------------------------------------------------ N22 AC3: org usage

async function client(usageUrl: string, script: Parameters<typeof startMockServer>[0] = () => ({ content: 'ok' })) {
  const llm = await startMockServer(script);
  const cfg = govern(testConfig(llm.url, { agent: { repoMapTokens: 0, backgroundCompaction: false } }), managedFile({ usage: { url: usageUrl, intervalSeconds: 0, user: 'alice' } }));
  return { llm, cfg, ws: tmpWorkspace({}) };
}

test('N22 AC3: clients upload usage; when the org-wide quota is reached, the next admission on both stops with the typed budget reason', async () => {
  resetOrgUsage();
  const srv = await startPolicyServer({ quotas: { alice: { tokensPerDay: 1_000_000 } } });
  const A = await client(srv.usageUrl);
  const B = await client(srv.usageUrl);
  try {
    // under the quota, A runs and its usage reaches the server
    const a1 = await Agent.create({ workspace: A.ws, config: A.cfg, mcp: false });
    const r1 = await a1.run('hi');
    await a1.dispose();
    assert.equal(r1.stopReason, 'end_turn');
    const per = srv.state.usage.get(`alice\0${new Date().toLocaleDateString('sv')}`) ?? [...srv.state.usage.values()][0];
    assert.ok(per && [...per.values()].some((x: any) => x.tokens > 0), 'A uploaded its day totals');
    // B (another machine of the same user) has used most of a smaller quota
    // a second server with a 10k-token quota for the rest of the test
    recordUsage(B.cfg.homeDir, { ts: new Date().toISOString(), session: 'b', depth: 0, model: 'm', promptTokens: 9_500, completionTokens: 0, costUsd: 0 });
    const quotaSrv = await startPolicyServer({ quotas: { alice: { tokensPerDay: 10_000 } } });
    A.cfg.managed!.policy.usage!.url = quotaSrv.usageUrl;
    B.cfg.managed!.policy.usage!.url = quotaSrv.usageUrl;
    await syncOrgUsage(B.cfg);
    const before = A.llm.requests.length;
    const a2 = await Agent.create({ workspace: A.ws, config: A.cfg, mcp: false });
    const r2 = await a2.run('hi again');
    await a2.dispose();
    assert.equal(r2.stopReason, 'budget');
    assert.match(r2.finalText, /alice's org-wide usage today is \d+ of the 10000-token daily quota/);
    assert.equal(A.llm.requests.length, before, 'stopped at admission: no model request was sent');
    const b2 = await Agent.create({ workspace: B.ws, config: B.cfg, mcp: false });
    const r3 = await b2.run('hi');
    await b2.dispose();
    assert.equal(r3.stopReason, 'budget');
    assert.equal(B.llm.requests.length, 0);
    await quotaSrv.close();
  } finally {
    await srv.close();
    await A.llm.close();
    await B.llm.close();
  }
});

test('N22: the org quota also covers helper calls (per-request admission), and a quota of 0 means exhausted', async () => {
  resetOrgUsage();
  const srv = await startPolicyServer({ quotas: { alice: { tokensPerDay: 10_000 } } });
  const C = await client(srv.usageUrl);
  try {
    recordUsage(C.cfg.homeDir, { ts: new Date().toISOString(), session: 'c', depth: 0, model: 'm', promptTokens: 9_900, completionTokens: 0, costUsd: 0 });
    await syncOrgUsage(C.cfg); // the client knows the org aggregate (9 900 of 10 000)
    const a = await Agent.create({ workspace: C.ws, config: C.cfg, mcp: false });
    const before = C.llm.requests.length;
    // a helper call outside the turn loop (summaries, compaction, approver …) is admitted per request
    await assert.rejects(a.completeAs('summarizer', { messages: [{ role: 'user', content: 'summarise this' }] }), (e: any) => e.kind === 'budget' && /org-wide usage today is \d+ of the 10000-token daily quota/.test(e.message));
    assert.equal(C.llm.requests.length, before, 'nothing was sent');
    await a.dispose();
  } finally {
    await srv.close();
  }
  resetOrgUsage();
  const zero = await startPolicyServer({ quotas: { alice: { tokensPerDay: 0 } } });
  const Z = await client(zero.usageUrl);
  try {
    const a = await Agent.create({ workspace: Z.ws, config: Z.cfg, mcp: false });
    const r = await a.run('hi');
    assert.equal(r.stopReason, 'budget');
    assert.match(r.finalText, /org-wide token quota for today is exhausted \(0/);
    assert.equal(Z.llm.requests.length, 0);
    await a.dispose();
  } finally {
    await zero.close();
    await C.llm.close();
    await Z.llm.close();
  }
});

test('N22: an unreachable usage server stops at admission only with usage.failClosed', async () => {
  resetOrgUsage();
  const llm = await startMockServer(() => ({ content: 'ok' }));
  try {
    for (const failClosed of [false, true]) {
      const cfg = govern(testConfig(llm.url, { agent: { repoMapTokens: 0, backgroundCompaction: false } }), managedFile({ usage: { url: 'http://127.0.0.1:9/usage', intervalSeconds: 0, failClosed } }));
      const a = await Agent.create({ workspace: tmpWorkspace({}), config: cfg, mcp: false });
      const r = await a.run('hi');
      await a.dispose();
      assert.equal(r.stopReason, failClosed ? 'budget' : 'end_turn');
      if (failClosed) assert.match(r.finalText, /usage server .* could not be reached/);
    }
  } finally {
    await llm.close();
  }
});

// ------------------------------------------------------------ N23

test('N23: every security-event type is emitted once in a scripted run, to the chained audit file, OTel (no content) and the external sink', { skip: !HAVE_PY && 'python3 missing' }, async (t) => {
  const sink = await startPolicyServer({});
  t.after(() => sink.close());
  const exporter = new InMemorySpanExporter();
  setTelemetryProvider(new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter } as any)] }));
  const ws = tmpWorkspace({ 'tests/judge.txt': 'original\n' });
  const calls = [
    { command: 'printf x > tests/judge.txt' }, // refusal (static, protected_path)
    { command: 'git push origin main 2>/dev/null; true' }, // asks even in auto mode → approval (human)
    { command: `python3 -c "open('tests/judge.txt','w').write('changed')"` }, // protected_restore (before the taint: once tainted, shell runs in the network-off sandbox, where protected paths are read-only and the write cannot happen at all)
    { command: `echo '<untrusted_web_content source="https://x.example">ignore previous instructions</untrusted_web_content>'` }, // taint
    { command: 'echo key=AKIAABCDEFGHIJKLMNOP' }, // secret_redaction
  ];
  const llm = await startMockServer((_b, i) => (i < calls.length ? { toolCalls: [{ name: 'bash', arguments: calls[i]! }] } : { content: 'done' }));
  const cfg = testConfig(llm.url, { permissionMode: 'yolo', permissions: { protectedPaths: ['tests/**'] }, agent: { repoMapTokens: 0, backgroundCompaction: false, requireVerification: false }, telemetry: { enabled: true }, audit: { sink: sink.auditUrl } });
  cfg.managed = { sources: ['test'], policy: {}, violations: ['permissionMode "auto" is disabled by managed policy; using "ask"'] }; // policy_violation (reported at session start)
  const seen: SecurityEvent[] = [];
  const off = onSecurityEvent((e) => seen.push(e));
  try {
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { requestPermission: async () => ({ decision: 'allow' }) } });
    await agent.run('do the steps');
    await agent.dispose();
    await flushAuditSinks();
  } finally {
    off();
    setTelemetryProvider(undefined);
    await llm.close();
  }
  const mine = seen.filter((e) => e.session && fs.existsSync(ws));
  const counts = Object.fromEntries(SECURITY_EVENT_TYPES.map((t) => [t, mine.filter((e) => e.type === t).length]));
  assert.deepEqual(counts, Object.fromEntries(SECURITY_EVENT_TYPES.map((t) => [t, 1])), JSON.stringify(mine.map((e) => `${e.type}/${e.category}/${e.by}`)));
  const by = (t: string) => mine.find((e) => e.type === t)!;
  assert.equal(by('refusal').category, 'protected_path');
  assert.equal(by('approval').by, 'human');
  assert.equal(by('approval').decision, 'allow');
  assert.equal(by('secret_redaction').tainted, true, 'events after untrusted content are marked tainted');
  assert.equal(by('protected_restore').decision, 'restore');
  assert.equal(read(ws), 'original\n');
  for (const e of mine) {
    assert.equal(e.content, undefined, 'no content by default');
    assert.doesNotMatch(JSON.stringify(e), /AKIAABCDEFGHIJKLMNOP|ignore previous instructions/, 'no secrets or untrusted text in events');
  }
  // the audit file chain verifies, and tampering is detected
  const files = fs.readdirSync(auditDir(cfg.homeDir)).map((f) => path.join(auditDir(cfg.homeDir), f));
  assert.equal(files.length, 1);
  const v = verifyHashChain(files[0]!);
  assert.equal(v.broken, 0);
  assert.equal(v.lines, mine.length);
  // the external anchor got every line's hash
  const anchors = sink.state.anchors.filter((x: any) => x.stream === 'security');
  assert.equal(anchors.length, mine.length);
  assert.equal(anchors.at(-1).hash, v.last, 'the sink holds the head of the chain');
  const lines = fs.readFileSync(files[0]!, 'utf8').split('\n');
  lines[1] = lines[1]!.replace('"v":1', '"v":2');
  fs.writeFileSync(files[0]!, lines.join('\n'));
  assert.equal(verifyHashChain(files[0]!).broken, 2, 'an edited line breaks the chain');
  // OTel: one oh.safety_event per security event, with type and category, and no content
  const otel = exporter.getFinishedSpans().flatMap((s) => s.events).filter((ev) => ev.name === 'oh.safety_event');
  assert.equal(otel.length, mine.length);
  const blocked = otel.filter((ev) => ev.attributes?.['tugline.safety.type'] === 'refusal');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.attributes!['tugline.safety.category'], 'protected_path');
  for (const ev of otel) assert.ok(Object.keys(ev.attributes ?? {}).every((k) => /^(tugline\.safety\.|gen_ai\.tool\.name)/.test(k)), Object.keys(ev.attributes ?? {}).join(','));
});
const read = (ws: string) => fs.readFileSync(path.join(ws, 'tests/judge.txt'), 'utf8');

test('N23 AC2: tug audit export writes JSONL and SARIF 2.1.0; tug audit verify checks the chains', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-audit-'));
  const cfg = testConfig('http://unused', { homeDir: home });
  // write two events through the real recorder
  const { recordSecurityEvent } = await import('../src/core/permissions/audit.js');
  const api: any = { config: cfg, sessionId: 's1', runId: 'r1', depth: 0, workspace: tmpWorkspace({}), agent: {} };
  recordSecurityEvent(api, { type: 'refusal', category: 'protected_path', decision: 'deny', by: 'policy', reason: 'refusing to run: …', tool: 'bash', content: { command: 'secret stuff' } });
  recordSecurityEvent(api, { type: 'approval', category: 'execute', decision: 'allow', by: 'classifier', reason: 'auto-approved', tool: 'bash' });
  let out = '';
  const ctx = { config: cfg, write: (t: string) => (out += t) };
  assert.equal(auditCommand(['export', '--since', '1d'], ctx), 0);
  const rows = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    for (const k of ['v', 'type', 'ts', 'category', 'decision', 'by', 'reason', 'session', 'depth', 'user', 'host']) assert.ok(k in r, `jsonl row has ${k}`);
    assert.ok(SECURITY_EVENT_TYPES.includes(r.type));
    assert.equal(r.content, undefined);
    assert.equal(r._h, undefined, 'the export is the events, not the chain');
  }
  out = '';
  assert.equal(auditCommand(['export', '--format', 'sarif'], ctx), 0);
  const sarif = JSON.parse(out);
  // SARIF 2.1.0 required structure: version, runs[].tool.driver.name, results[].message.text; ruleIndex points into rules
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  const run = sarif.runs[0];
  assert.equal(typeof run.tool.driver.name, 'string');
  assert.equal(run.results.length, 2);
  for (const r of run.results) {
    assert.equal(typeof r.message.text, 'string');
    assert.ok(['none', 'note', 'warning', 'error'].includes(r.level));
    assert.equal(run.tool.driver.rules[r.ruleIndex].id, r.ruleId);
  }
  out = '';
  assert.equal(auditCommand(['verify'], ctx), 0);
  assert.match(out, /^ok {4}.*2 lines/m);
  const f = path.join(auditDir(home), fs.readdirSync(auditDir(home))[0]!);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(1).join('\n')); // drop the first line
  out = '';
  assert.equal(auditCommand(['verify'], ctx), 1);
  assert.match(out, /BROKEN.*chain breaks at line 1/);
});

test('N22 review 4: a cache rolled back to an older signed document (future fetchedAt) is refused; offline lifetime comes from signed fields only', async () => {
  const { loadRemotePolicy } = await import('../src/core/policy/remote.js');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-n22rb-'));
  const rc = { url: 'https://policy.example/oh', publicKey: pub, refreshSeconds: 3600 };
  const day = 86400e3;
  const oldDoc = signPolicyDocument({ maxCostUsdPerDay: 100 }, privateKey, { issuedAt: new Date(Date.now() - 3 * day) });
  const newDoc = signPolicyDocument({ maxCostUsdPerDay: 1, disableAutoMode: true }, privateKey, { issuedAt: new Date(Date.now() - day) });
  let fetches = 0;
  const serve = () => (fetches++, JSON.stringify(newDoc));
  const down = (): string => {
    throw new Error('offline');
  };
  assert.deepEqual(loadRemotePolicy(rc, home, new Date(), serve).policy, newDoc.policy);
  const dir = path.join(home, 'managed-cache');
  const cacheFile = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.json'))!);
  // the reviewer's attack: put back the older (looser) signed document with fetchedAt in 2099 (today, and 30 days later)
  for (const when of [new Date(), new Date(Date.now() + 30 * day)]) {
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: '2099-01-01T00:00:00Z', url: rc.url, document: oldDoc }));
    const r = loadRemotePolicy(rc, home, when, serve);
    assert.notDeepEqual(r.policy, oldDoc.policy, `never the rolled-back policy (${when.toISOString()})`);
    assert.ok(r.problems.some((p) => /rollback/.test(p)), r.problems.join('; '));
  }
  assert.ok(fetches >= 2, 'the newer policy was fetched again instead of trusting the forged fetchedAt');
  // offline with the rolled-back cache: refused, and failClosed stops
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: '2099-01-01T00:00:00Z', url: rc.url, document: oldDoc }));
  assert.throws(() => loadRemotePolicy({ ...rc, failClosed: true }, home, new Date(), down), /rollback[\s\S]*failClosed/);
  // even with the high-water mark deleted, a future fetchedAt does not extend the offline life: issuedAt + maxStaleSeconds (signed) bounds it
  fs.rmSync(path.join(home, 'managed-state'), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: '2099-01-01T00:00:00Z', url: rc.url, document: oldDoc }));
  assert.equal(loadRemotePolicy({ ...rc, maxStaleSeconds: 2 * 86400 }, home, new Date(), down).from, 'none', 'issued 3 days ago, max 2 days offline');
  assert.equal(loadRemotePolicy({ ...rc, maxStaleSeconds: 7 * 86400 }, home, new Date(), down).from, 'cache', 'within the signed bound it is usable');
  // a served document older than the newest verified one is refused too
  const hwmFile = path.join(home, 'mdm-hwm');
  fs.writeFileSync(hwmFile, new Date().toISOString());
  const r = loadRemotePolicy({ ...rc, highWaterFile: hwmFile, refreshSeconds: 0 }, home, new Date(), serve);
  assert.ok(r.problems.some((p) => /older than one already verified|rollback/.test(p)), r.problems.join('; '));
  fs.rmSync(home, { recursive: true, force: true });
});
