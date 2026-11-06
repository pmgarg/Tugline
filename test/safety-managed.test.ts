/** SPEC C4: managed (enterprise) policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { loadConfig, resolveProfile } from '../src/core/config.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { applyGovernance, combinePolicies, loadManagedPolicy, systemManagedPath, type ManagedPolicy } from '../src/core/policy/managed.js';
import type { AgentEvent } from '../src/core/types.js';
import { startMockServer, tmpWorkspace, lastToolResult } from './helpers.js';

function managedFile(p: ManagedPolicy | string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-')), 'managed.json');
  fs.writeFileSync(f, typeof p === 'string' ? p : JSON.stringify(p));
  return f;
}
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
/** loadConfig as the CLI does it, with a managed policy file and explicit env/overrides. */
function load(ws: string, policy: ManagedPolicy | undefined, overrides: any = {}, env: Record<string, string> = {}) {
  const e: NodeJS.ProcessEnv = { ...env };
  if (policy) e.TUG_MANAGED_POLICY = managedFile(policy);
  return loadConfig({ workspace: ws, noUserConfig: true, env: e, overrides: { homeDir: home(), web: { searchProvider: 'none' }, ...overrides } });
}

test('C4 AC1: a managed deny beats a user allow (and auto mode)', async () => {
  const ws = tmpWorkspace({});
  const cfg = load(ws, { deny: ['bash(curl*)'] }, { permissionMode: 'yolo', permissions: { allow: ['bash(curl*)', 'bash'] } });
  assert.ok(cfg.permissions.deny.includes('bash(curl*)'));
  const pol = new PermissionPolicy({ workspace: ws, mode: cfg.permissionMode, allow: cfg.permissions.allow, deny: cfg.permissions.deny, protectedPaths: cfg.permissions.protectedPaths, additionalDirectories: [] });
  assert.equal(pol.check({ tool: 'bash', kind: 'execute', command: 'curl https://example.com' }).decision, 'deny');
  assert.equal(pol.check({ tool: 'bash', kind: 'execute', command: 'npm test' }).decision, 'allow');
  // end to end
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'curl -s https://example.com' } }] } : { content: 'ok' }));
  cfg.profiles.default = { ...cfg.profiles.default, baseUrl: srv.url, model: 'mock-model' };
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await agent.run('go');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /Refused: denied by rule 'bash\(curl\*\)'/);
});

test('C4 AC2: a non-allowlisted MCP server is not started', async () => {
  const ws = tmpWorkspace({});
  const markers = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mcp-'));
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const mcpServers = {
    evil: { command: '/bin/sh', args: ['-c', `touch ${markers}/evil-started; exit 1`] },
    approved: { command: '/bin/sh', args: ['-c', `touch ${markers}/approved-started; exit 1`] },
  };
  const cfg = load(ws, { allowMcpServers: ['approved'] }, { mcpServers, profiles: { default: { baseUrl: srv.url, model: 'mock-model', timeoutMs: 5000 } } });
  assert.deepEqual(Object.keys(cfg.mcpServers), ['approved']);
  assert.ok(cfg.managed!.violations.some((v) => /"evil" is not in the managed allowMcpServers/.test(v)));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, ui: { onEvent: (e) => events.push(e) } });
  await agent.run('hi');
  await agent.dispose();
  await srv.close();
  assert.equal(fs.existsSync(path.join(markers, 'evil-started')), false, 'evil server never spawned');
  assert.equal(fs.existsSync(path.join(markers, 'approved-started')), true, 'allowlisted server does start');
  assert.ok(events.some((e) => e.type === 'notice' && /managed policy .* overrode: .*evil/.test(e.message)), 'violation reported');
  // allowlisting by command also works
  const byCmd = load(ws, { allowMcpServers: ['/bin/sh'] }, { mcpServers });
  assert.deepEqual(Object.keys(byCmd.mcpServers).sort(), ['approved', 'evil']);
});

test('C4 AC3: a locked endpoint cannot be overridden by env vars or CLI flags', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'from the managed endpoint' }));
  const locked = { lockedProfile: { baseUrl: srv.url, model: 'corp-model' } };
  const cfg = load(
    ws,
    locked,
    { profile: 'mine', profiles: { default: { baseUrl: 'https://evil.example/v1' }, mine: { baseUrl: 'https://flag.example/v1', model: 'flag-model', timeoutMs: 5000 } } }, // CLI/VS Code overrides
    { TUG_BASE_URL: 'https://env.example/v1', TUG_MODEL: 'env-model', TUG_API_KEY: 'sk-env-0123456789' }, // env
  );
  for (const name of Object.keys(cfg.profiles)) {
    const p = resolveProfile(cfg, name);
    assert.equal(p.baseUrl, srv.url, `profile ${name} baseUrl locked`);
    assert.equal(p.model, 'corp-model', `profile ${name} model locked`);
  }
  assert.ok(cfg.managed!.violations.some((v) => /baseUrl is locked/.test(v)));
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  assert.equal((await agent.run('hi')).finalText, 'from the managed endpoint');
  // runtime switch (VS Code setProfileObject / /model) is reverted before the next call
  agent.setProfileObject({ ...agent.llm.profile, baseUrl: 'https://runtime.example/v1', model: 'other' });
  const r2 = await agent.run('again');
  await srv.close();
  assert.equal(r2.finalText, 'from the managed endpoint');
  assert.equal(srv.requests.length, 2);
  assert.ok(srv.requests.every((b) => b.model === 'corp-model'));
});

test('C4 AC4: protectedPaths, allowSkills, disableAutoMode, maxCostUsdPerDay, forceSandbox', async () => {
  const skill = (n: string) => `---\nname: ${n}\ndescription: skill ${n}\n---\nbody`;
  const ws = tmpWorkspace({ '.tugline/skills/good/SKILL.md': skill('good'), '.tugline/skills/rogue/SKILL.md': skill('rogue') });
  const cfg = load(ws, { protectedPaths: ['infra/**'], allowSkills: ['good'], disableAutoMode: true, maxCostUsdPerDay: 2, forceSandbox: true }, { permissionMode: 'yolo', approver: { enabled: true }, limits: { maxCostUsdPerDay: 50 }, shell: { sandbox: 'none' } });
  assert.ok(cfg.permissions.protectedPaths.includes('infra/**'));
  assert.ok(cfg.skills.disabled.includes('rogue') && !cfg.skills.disabled.includes('good'));
  assert.equal(cfg.permissionMode, 'ask');
  assert.equal(cfg.approver!.enabled, false);
  assert.equal(cfg.limits!.maxCostUsdPerDay, 2);
  assert.equal(cfg.shell.sandbox, 'auto');
  assert.equal(cfg.sandbox!.required, true);
  const v = cfg.managed!.violations.join('\n');
  for (const re of [/permissionMode "yolo" is disabled/, /approver .* disabled/, /maxCostUsdPerDay 50 lowered/, /skills not in the managed allowSkills list are disabled: rogue/]) assert.match(v, re);
  // a lower user cap is kept; an explicit OS sandbox is kept
  const c2 = load(ws, { maxCostUsdPerDay: 2, forceSandbox: true }, { limits: { maxCostUsdPerDay: 1 }, shell: { sandbox: 'bwrap' } });
  assert.equal(c2.limits!.maxCostUsdPerDay, 1);
  assert.equal(c2.shell.sandbox, 'bwrap');
  // skills: only the allowlisted one loads
  const srv = await startMockServer(() => ({ content: 'ok' }));
  cfg.profiles.default = { ...cfg.profiles.default, baseUrl: srv.url, model: 'mock-model' };
  cfg.shell.sandbox = 'none';
  cfg.sandbox = { required: false };
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  assert.deepEqual(agent.skills.list().map((s) => s.name).filter((n) => ['good', 'rogue'].includes(n)), ['good']);
  // runtime /mode auto is refused before the next call
  agent.setMode('yolo');
  await agent.run('hi');
  await srv.close();
  assert.equal(agent.policy.mode, 'ask');
});

test('C4: forceSandbox makes commands fail closed when no sandbox is available', async () => {
  const ws = tmpWorkspace({});
  const cfg = load(ws, { forceSandbox: process.platform === 'darwin' ? 'bwrap' : 'seatbelt' });
  const { execCommand, commandWrapperFor, scrubbedEnv } = await import('../src/core/tools/shell.js');
  const r = await execCommand({ shellCommand: 'echo ran', cwd: ws, timeoutMs: 10_000, env: scrubbedEnv([]), wrap: commandWrapperFor(cfg) });
  assert.equal(r.exitCode, 126);
  assert.doesNotMatch(r.output, /^ran/m);
});

test('C4: invalid or missing managed files fail closed; policies combine restrictively; user files cannot fake it', () => {
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ managed: { sources: ['fake'], policy: {}, violations: [] } }) });
  assert.throws(() => load(ws, '{not json' as any), /managed policy .* is not valid JSON/);
  assert.throws(() => loadConfig({ workspace: ws, noUserConfig: true, env: { TUG_MANAGED_POLICY: managedFile({ deny: ['x'], bogus: 1 } as any) } }), /unknown field\(s\) bogus/);
  assert.throws(() => loadConfig({ workspace: ws, noUserConfig: true, env: { TUG_MANAGED_POLICY: '/nonexistent/managed.json' } }), /missing file/);
  const trusted = loadConfig({ workspace: ws, noUserConfig: true, trusted: true, env: {} });
  assert.equal(trusted.managed, undefined, 'a project config cannot pose as managed state');
  const c = combinePolicies({ deny: ['a'], allowMcpServers: ['x', 'y'], maxCostUsdPerDay: 5, lockedProfile: { model: 'sys' } }, { deny: ['b'], allowMcpServers: ['y', 'z'], maxCostUsdPerDay: 3, disableAutoMode: true, lockedProfile: { model: 'env', baseUrl: 'u' } });
  assert.deepEqual(c.deny, ['a', 'b']);
  assert.deepEqual(c.allowMcpServers, ['y']);
  assert.equal(c.maxCostUsdPerDay, 3);
  assert.equal(c.disableAutoMode, true);
  assert.deepEqual(c.lockedProfile, { model: 'sys', baseUrl: 'u' });
  // system file + env file are combined
  const sys = managedFile({ deny: ['bash(rm*)'] });
  const { policy, sources } = loadManagedPolicy({ TUG_MANAGED_POLICY: managedFile({ deny: ['bash(curl*)'] }) }, sys);
  assert.equal(sources.length, 2);
  assert.deepEqual(policy.deny, ['bash(rm*)', 'bash(curl*)']);
  assert.equal(systemManagedPath('linux'), '/etc/tugline/managed.json');
  assert.equal(systemManagedPath('darwin'), '/Library/Application Support/Tugline/managed.json');
  assert.match(systemManagedPath('win32', { ProgramData: 'C:\\ProgramData' }), /Tugline[\\/]managed\.json$/);
});

test('C4×R4: the managed daily cap follows R4 (absent = no cap, 0 = exhausted); a second policy file can only tighten; a user 0 stays 0', () => {
  const ws = tmpWorkspace({});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-c4r4-'));
  const sys = path.join(dir, 'system.json');
  fs.writeFileSync(sys, JSON.stringify({ maxCostUsdPerDay: 5 }));
  const user = (p: object) => {
    const f = path.join(dir, `user-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(p));
    return f;
  };
  const cfgWith = (env: Record<string, string>, limits?: object) =>
    applyGovernance(loadConfig({ workspace: ws, noUserConfig: true, env: {}, overrides: { homeDir: home(), web: { searchProvider: 'none' }, ...(limits ? { limits } : {}) } }), { workspace: ws, env, trusted: true, systemPath: sys });
  // the reviewer's repro: a user TUG_MANAGED_POLICY file with 0 must not erase the system cap (min(5, 0) = 0 = exhausted, not "no cap")
  assert.equal(loadManagedPolicy({ TUG_MANAGED_POLICY: user({ maxCostUsdPerDay: 0 }) }, sys).policy.maxCostUsdPerDay, 0);
  assert.equal(loadManagedPolicy({ TUG_MANAGED_POLICY: user({ maxCostUsdPerDay: 50 }) }, sys).policy.maxCostUsdPerDay, 5, 'a looser second file cannot raise the cap');
  assert.equal(loadManagedPolicy({ TUG_MANAGED_POLICY: user({ deny: ['x'] }) }, sys).policy.maxCostUsdPerDay, 5, 'a second file without the key keeps the cap');
  const cases: [Record<string, string>, object | undefined, number | undefined][] = [
    [{}, undefined, 5], // no user limit: the cap applies
    [{}, { maxCostUsdPerDay: 50 }, 5], // looser user limit: lowered
    [{}, { maxCostUsdPerDay: 1 }, 1], // stricter user limit: kept
    [{}, { maxCostUsdPerDay: 0 }, 0], // user 0 (exhausted) stays 0, never raised to the cap
    [{ TUG_MANAGED_POLICY: user({ maxCostUsdPerDay: 0 }) }, undefined, 0], // managed 0 = exhausted
    [{ TUG_MANAGED_POLICY: user({ maxCostUsdPerDay: 0 }) }, { maxCostUsdPerDay: 3 }, 0],
  ];
  for (const [env, limits, want] of cases) assert.equal(cfgWith(env, limits).limits?.maxCostUsdPerDay, want, JSON.stringify({ env: Object.keys(env), limits }));
  // without any managed policy nothing is set (unlimited)
  assert.equal(loadConfig({ workspace: ws, noUserConfig: true, env: {}, overrides: { homeDir: home(), web: { searchProvider: 'none' } } }).limits?.maxCostUsdPerDay, undefined);
});

test('C4×R4 review 3: a non-number user limit (null, a string, an object) cannot escape the managed cap; loadConfig rejects it with a clear error', async () => {
  const { applyManagedPolicy, validateLimits } = await import('../src/core/policy/managed.js');
  const { limitState } = await import('../src/core/llm/admission.js');
  const ws = tmpWorkspace({});
  // the managed cap replaces anything that is not a finite number ≥ 0
  for (const bad of [null, 'none', '50', {}, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const cfg = loadConfig({ workspace: ws, noUserConfig: true, env: {}, overrides: { homeDir: home(), web: { searchProvider: 'none' } } });
    (cfg as any).limits = { maxCostUsdPerDay: bad };
    const v = applyManagedPolicy(cfg, { maxCostUsdPerDay: 5 }, { workspace: ws });
    assert.equal(cfg.limits!.maxCostUsdPerDay, 5, `${JSON.stringify(bad)} → the cap`);
    assert.ok(v.some((x) => /replaced by the managed cap 5/.test(x)));
  }
  // a non-number never reads as "unlimited" anywhere
  for (const bad of [null, 'none', {}, Number.NaN]) assert.equal(limitState(bad as any), 'exhausted');
  assert.equal(limitState(undefined), 'unlimited');
  // end to end through loadConfig (the reviewer's c4-managed-cap-null-e2e): the user's own config file
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fakehome-'));
  const ohHome = path.join(fakeHome, '.tugline');
  fs.mkdirSync(ohHome);
  const pol = path.join(ohHome, 'managed.json');
  fs.writeFileSync(pol, '{"maxCostUsdPerDay":5}');
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    for (const bad of [null, 'none', {}]) {
      fs.writeFileSync(path.join(ohHome, 'config.json'), JSON.stringify({ limits: { maxCostUsdPerDay: bad } }));
      assert.throws(() => loadConfig({ workspace: ws, env: { TUG_MANAGED_POLICY: pol } }), /limits\.maxCostUsdPerDay must be a number ≥ 0/);
    }
    fs.writeFileSync(path.join(ohHome, 'config.json'), JSON.stringify({ limits: { maxCostUsdPerDay: 50 } }));
    assert.equal(loadConfig({ workspace: ws, env: { TUG_MANAGED_POLICY: pol } }).limits?.maxCostUsdPerDay, 5);
  } finally {
    process.env.HOME = oldHome;
  }
  assert.throws(() => validateLimits({ limits: { maxTokensPerDay: '1000' } } as any), /limits\.maxTokensPerDay must be a number/);
});
