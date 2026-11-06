/**
 * N43 AC1: `auto` (and the renamed `yolo`) is selectable on every surface: CLI flag and /mode, VS Code
 * (picker, settings, /mode), `tug serve`, ACP, the TS SDK and the Python SDK. Where the surface can run a
 * session here, the session really runs in auto mode: the classifier request goes to the (mock) model
 * through the real transport and the routine command runs without a prompt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { Agent } from '../src/core/agent/agent.js';
import '../src/core/tools/providers.js';
import { getSlashCommand, slashCommands } from '../src/core/commands.js';
import { createAgent, sdkConfig, PERMISSION_MODES, isPermissionMode } from '../src/sdk/index.js';
import { startServer } from '../src/server/server.js';
import { OhClient } from '../src/server/client.js';
import { dispatchSlash } from '../vscode/src/slash.js';
import { governedConfig } from '../vscode/src/settingsConfig.js';
import { startMockServer, testConfig, tmpWorkspace, type MockServer } from './helpers.js';

const TSX = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
const CLI = path.resolve('src/cli/main.ts');

/** The auto-mode classifier's requests start with this rubric line. */
const isClassifier = (body: any) => String(body.messages?.[0]?.content ?? '').startsWith('You review ONE pending action');

/** A mock model: the classifier always answers ALLOW; the agent runs `command` once, then finishes. */
async function autoLlm(command: string): Promise<MockServer & { classifierCalls: () => number }> {
  let agentTurns = 0;
  let cls = 0;
  const srv = await startMockServer((body) => {
    if (isClassifier(body)) return cls++, { content: 'ALLOW' };
    return agentTurns++ === 0 ? { toolCalls: [{ name: 'bash', arguments: { command } }] } : { content: 'Done.' };
  });
  return Object.assign(srv, { classifierCalls: () => cls });
}

function env(llmUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-am-home-'));
  return { ...process.env, HOME: home, TUG_BASE_URL: llmUrl, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-test-1234567890abcdef', TUG_CONTEXT_WINDOW: '32768', TUG_MAX_OUTPUT_TOKENS: '1024', ...extra };
}

function runCli(args: string[], e: NodeJS.ProcessEnv, stdin = ''): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', TSX, CLI, ...args], { env: e, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

test('N43 AC1: (CLI) --mode auto runs a session with the classifier through the real transport; --yolo is loud; unknown modes fail', async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('echo cli-auto > made.txt');
  try {
    const r = await runCli(['--cwd', ws, '--mode', 'auto', '--native-tools', '-p', 'make the file'], env(llm.url));
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(path.join(ws, 'made.txt'), 'utf8').trim(), 'cli-auto');
    assert.equal(llm.classifierCalls(), 1, 'one stage-1 classifier call');
    const req = llm.requests.find(isClassifier);
    assert.equal(req.max_tokens, 24, 'stage 1 asks for a tiny answer');
    assert.equal(req.temperature, 0);
    assert.match(req.messages[1].content, /<untrusted_transcript>[\s\S]*make the file[\s\S]*<pending_call>[\s\S]*echo cli-auto > made\.txt/);
    assert.ok(!/WARNING: yolo/.test(r.err));
    const y = await runCli(['--cwd', ws, '--yolo', '-p', 'hi'], env(llm.url));
    assert.match(y.err, /WARNING: yolo mode runs commands/);
    const bad = await runCli(['--cwd', ws, '--mode', 'bypass', '-p', 'hi'], env(llm.url));
    assert.notEqual(bad.code, 0);
    assert.match(bad.err + bad.out, /unknown permission mode "bypass".*auto \| yolo/);
  } finally {
    await llm.close();
  }
});

test('N43 AC1: (CLI) /mode auto, /mode yolo (warning), /mode shows the list, /auto shows the counters', async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('true');
  try {
    const r = await runCli(['--cwd', ws], env(llm.url), ['/mode auto', '/mode', '/auto', '/mode yolo', '/mode nonsense', '/exit', ''].join('\n'));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mode: auto {2}\(ask \| acceptEdits \| plan \| auto \| yolo\)/);
    assert.match(r.out, /blocks 0\/3 in a row, 0\/20 in the session/);
    assert.match(r.out, /WARNING: yolo mode/);
    assert.match(r.out, /unknown permission mode "nonsense"/);
  } finally {
    await llm.close();
  }
});

test('N43 AC1: (tug serve) session/create and config/set accept auto and yolo, reject unknown modes; an auto session runs classifier-approved commands without asking the client', async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('echo serve-auto > s.txt');
  const config = testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false } });
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (w, o) => ({ ...testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false }, ...o }), homeDir: config.homeDir }) });
  const asked: string[] = [];
  const client = await OhClient.connect(srv.url, srv.token, { onPermission: (_s, r) => (asked.push(r.tool), { decision: 'deny' }) });
  try {
    await client.initialize();
    const s = await client.createSession({ mode: 'auto' });
    assert.equal(s.mode, 'auto');
    await client.prompt(s.sessionId, 'make s.txt');
    assert.deepEqual(asked, []);
    assert.equal(fs.readFileSync(path.join(ws, 's.txt'), 'utf8').trim(), 'serve-auto');
    assert.equal(llm.classifierCalls(), 1);
    assert.deepEqual(await client.request('config/set', { sessionId: s.sessionId, key: 'permissionMode', value: 'yolo' }), { ok: true, value: 'yolo' });
    await assert.rejects(client.request('config/set', { sessionId: s.sessionId, key: 'permissionMode', value: 'bypass' }), /unknown permission mode/);
    await assert.rejects(client.createSession({ mode: 'bypass' } as any), /unknown permission mode/);
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
});

test('N43 AC1: (ACP) the mode list has auto and yolo; set_mode auto runs the next prompt in auto mode', async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('echo acp-auto > a.txt');
  const child = spawn(process.execPath, ['--import', TSX, CLI, '--acp'], { env: env(llm.url), stdio: ['pipe', 'pipe', 'pipe'] });
  const updates: acp.SessionNotification[] = [];
  const perms: unknown[] = [];
  const conn = new acp.ClientSideConnection(
    () => ({
      async sessionUpdate(p) {
        updates.push(p);
      },
      async requestPermission(p) {
        perms.push(p);
        return { outcome: { outcome: 'cancelled' } };
      },
      async readTextFile() {
        throw acp.RequestError.resourceNotFound('x');
      },
      async writeTextFile() {
        return {};
      },
    }),
    acp.ndJsonStream(Writable.toWeb(child.stdin!) as any, Readable.toWeb(child.stdout!) as any),
  );
  try {
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.newSession({ cwd: ws, mcpServers: [] });
    assert.deepEqual(s.modes?.availableModes.map((m) => m.id), ['ask', 'acceptEdits', 'plan', 'auto', 'yolo']);
    await conn.setSessionMode({ sessionId: s.sessionId, modeId: 'auto' });
    assert.ok(updates.some((u: any) => u.update.sessionUpdate === 'current_mode_update' && u.update.currentModeId === 'auto'));
    await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: 'make a.txt' }] });
    assert.equal(perms.length, 0, 'no permission request: the classifier approved');
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8').trim(), 'acp-auto');
    assert.equal(llm.classifierCalls(), 1);
  } finally {
    child.stdin!.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => (child.kill('SIGKILL'), r()), 5000);
      child.once('exit', () => (clearTimeout(t), r()));
    });
    await llm.close();
  }
});

test('N43 AC1: (VS Code) /mode, the settings value and the picker offer auto and yolo; yolo warns', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask' }), mcp: false });
  const out: string[] = [];
  const d: any = { agent, write: (t: string) => out.push(t), newChat: () => {}, setModel: () => {}, registry: { get: getSlashCommand, list: slashCommands } };
  await dispatchSlash('/mode auto', d);
  assert.equal(agent.policy.mode, 'auto');
  await dispatchSlash('/mode yolo', d);
  assert.equal(agent.policy.mode, 'yolo');
  assert.match(out.join('\n'), /mode: yolo\. WARNING/);
  await dispatchSlash('/mode bogus', d);
  assert.equal(agent.policy.mode, 'yolo');
  assert.match(out.at(-1)!, /unknown permission mode "bogus"[\s\S]*ask \| acceptEdits \| plan \| auto \| yolo/);
  await srv.close();
  // settings → config (application scope: user only), validated
  const get = (m: string) => (k: string) => (k === 'permissionMode' ? m : undefined);
  const NOSYS = path.join(ws, 'no-managed.json');
  assert.equal(governedConfig({ workspace: ws, get: get('auto'), env: { ...process.env, TUG_MANAGED_POLICY: '' }, noUserConfig: true, systemPath: NOSYS }).permissionMode, 'auto');
  assert.equal(governedConfig({ workspace: ws, get: get('nonsense'), env: { ...process.env, TUG_MANAGED_POLICY: '' }, noUserConfig: true, systemPath: NOSYS }).permissionMode, 'ask');
  // the picker (webview) and the settings schema list exactly the core's modes
  const mainJs = fs.readFileSync('vscode/media/main.js', 'utf8');
  for (const m of PERMISSION_MODES) assert.match(mainJs, new RegExp(`<option value="${m}">`));
  const pkg = JSON.parse(fs.readFileSync('vscode/package.json', 'utf8'));
  const prop = pkg.contributes.configuration.properties?.['tugline.permissionMode'] ?? pkg.contributes.configuration.find?.((c: any) => c.properties['tugline.permissionMode'])?.properties['tugline.permissionMode'];
  assert.deepEqual(prop.enum, [...PERMISSION_MODES]);
  assert.equal(prop.scope, 'application', 'a workspace settings file cannot select the mode (S7)');
  // the chat's picker handler validates and warns
  const chat = fs.readFileSync('vscode/src/chat.ts', 'utf8');
  assert.match(chat, /case 'setMode':\s*\n\s*\/\/ N43[^\n]*\n\s*if \(!isPermissionMode\(m\.mode\)\)[^\n]*\n\s*if \(m\.mode === 'yolo'\) void vscode\.window\.showWarningMessage/);
});

test('N43 AC1: (TS SDK) permissionMode auto/yolo is accepted and validated; the mode list is exported', async () => {
  assert.deepEqual([...PERMISSION_MODES], ['ask', 'acceptEdits', 'plan', 'auto', 'yolo']);
  assert.equal(isPermissionMode('auto'), true);
  const ws = tmpWorkspace({});
  const llm = await autoLlm('echo sdk-auto > k.txt');
  try {
    const agent = await createAgent({ workspace: ws, baseUrl: llm.url, model: 'mock-model', apiKey: 'sk-test-1234567890abcdef', loadUserConfig: false, permissionMode: 'auto', mcp: false, config: { homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sdkh-')), checkpoints: { enabled: false }, agent: { requireVerification: false }, shell: { sandbox: 'none' } } });
    assert.equal(agent.policy.mode, 'auto');
    await agent.run('make k.txt');
    assert.equal(fs.readFileSync(path.join(ws, 'k.txt'), 'utf8').trim(), 'sdk-auto', 'ran without onPermission: the classifier approved');
    assert.equal(llm.classifierCalls(), 1);
    assert.throws(() => sdkConfig({ workspace: ws, loadUserConfig: false, permissionMode: 'bypass' as any }), /unknown permission mode/);
  } finally {
    await llm.close();
  }
});

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('N43 AC1: (Python SDK) create_session(mode="auto"), set_mode, client- and server-side validation against `tug serve`', { skip: hasPython ? false : 'python3 is not available' }, async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('echo py > py-auto.txt');
  const token = 'py-am-' + Math.random().toString(36).slice(2);
  const e = env(llm.url, { TUG_SERVER_TOKEN: token });
  // `tug serve` defaults to the OS sandbox when one exists; the mock model is on loopback, the command is local
  const serve = spawn(process.execPath, ['--import', TSX, CLI, 'serve', '--port', '0'], { env: e, cwd: ws, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`tug serve did not start: ${err}`)), 30_000);
      serve.stderr.on('data', (d) => {
        err += d;
        const m = err.match(/listening on (ws:\/\/127\.0\.0\.1:\d+)/);
        if (m && /token: /.test(err)) {
          clearTimeout(t);
          resolve(m[1]!);
        }
      });
    });
    const py = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const c = spawn('python3', ['-I', path.resolve('sdk/python/test_automode.py'), '-v'], { env: { ...e, TUG_SERVER_URL: url, TUG_TEST_WORKSPACE: ws }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const t = setTimeout(() => c.kill('SIGKILL'), 120_000);
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (status) => (clearTimeout(t), resolve({ status, out })));
    });
    assert.equal(py.status, 0, py.out);
    assert.match(py.out, /Ran 3 tests[\s\S]*OK/);
  } finally {
    serve.kill('SIGTERM');
    await new Promise((r) => serve.once('close', r));
    await llm.close();
  }
});

test('N43 R7: tug serve config/set and ACP set_mode report the mode in effect when managed policy forbids the requested one', async () => {
  const ws = tmpWorkspace({});
  const llm = await autoLlm('true');
  const policyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-')), 'managed.json');
  fs.writeFileSync(policyFile, JSON.stringify({ disableYoloMode: true }));
  // tug serve (in process): the reply is the effective mode, at once
  const config = testConfig(llm.url, { checkpoints: { enabled: false } });
  const withPolicy = (o: any) => {
    const c = { ...testConfig(llm.url, { checkpoints: { enabled: false }, ...o }), homeDir: config.homeDir };
    c.managed = { sources: [policyFile], policy: { disableYoloMode: true }, violations: [] };
    return c;
  };
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (_w, o) => withPolicy(o) });
  const client = await OhClient.connect(srv.url, srv.token);
  try {
    await client.initialize();
    const s = await client.createSession({ mode: 'auto' });
    assert.deepEqual(await client.request('config/set', { sessionId: s.sessionId, key: 'permissionMode', value: 'yolo' }), { ok: true, value: 'ask' });
    assert.deepEqual(await client.request('config/set', { sessionId: s.sessionId, key: 'permissionMode', value: 'auto' }), { ok: true, value: 'auto' });
  } finally {
    client.close();
    await srv.close();
  }
  // ACP (spawned, the managed file through TUG_MANAGED_POLICY): the mode update names the mode in effect
  const child = spawn(process.execPath, ['--import', TSX, CLI, '--acp'], { env: env(llm.url, { TUG_MANAGED_POLICY: policyFile }), stdio: ['pipe', 'pipe', 'pipe'] });
  const updates: acp.SessionNotification[] = [];
  const conn = new acp.ClientSideConnection(() => ({ async sessionUpdate(p) { updates.push(p); }, async requestPermission() { return { outcome: { outcome: 'cancelled' } }; }, async readTextFile() { throw acp.RequestError.resourceNotFound('x'); }, async writeTextFile() { return {}; } }), acp.ndJsonStream(Writable.toWeb(child.stdin!) as any, Readable.toWeb(child.stdout!) as any));
  try {
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.newSession({ cwd: ws, mcpServers: [] });
    await conn.setSessionMode({ sessionId: s.sessionId, modeId: 'yolo' });
    const modes = updates.filter((u: any) => u.update.sessionUpdate === 'current_mode_update').map((u: any) => u.update.currentModeId);
    assert.deepEqual(modes, ['ask'], 'never reported as yolo');
  } finally {
    child.stdin!.end();
    await new Promise<void>((r) => {
      const t = setTimeout(() => (child.kill('SIGKILL'), r()), 5000);
      child.once('exit', () => (clearTimeout(t), r()));
    });
    await llm.close();
  }
});

test('N43 R5: /permissions lists rules by source and adds or removes allow/ask/deny rules persistently (CLI registry and VS Code chat)', async () => {
  const srv = await startMockServer([]);
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ permissions: { allow: ['edit_file(src/**)'], deny: ['bash(curl*)'] } }) });
  const config = testConfig(srv.url, { permissionMode: 'ask', permissions: { allow: ['bash(python*)'] } });
  config.managed = { sources: ['/etc/oh/managed.json'], policy: { deny: ['web_fetch'] }, violations: [] } as any;
  fs.writeFileSync(path.join(config.homeDir, 'config.json'), JSON.stringify({ permissions: { allow: ['bash(python*)'], ask: ['bash(git push*)'] } }));
  const agent = await Agent.create({ workspace: ws, config, mcp: false });
  try {
    const cmd = getSlashCommand('permissions');
    assert.ok(cmd, '/permissions is registered');
    const out: string[] = [];
    const ctx = { agent, config, workspace: ws, write: (t: string) => out.push(t), surface: 'cli' as const };
    // listing: every source, with what auto mode ignores
    agent.setMode('auto');
    await cmd.run('', ctx);
    const list = out.join('\n');
    assert.match(list, /managed policy \(\/etc\/oh\/managed\.json\) \[cannot be changed here\]\n\s+deny: web_fetch/);
    assert.match(list, /user \(.*config\.json\)\n\s+allow: bash\(python\*\)\n\s+ask: bash\(git push\*\)/);
    assert.match(list, /project \(\.tugline\/config\.json\)\n\s+allow: edit_file\(src\/\*\*\)\n\s+deny: bash\(curl\*\)/);
    assert.match(list, /ignored in auto mode .*bash\(python\*\)/);
    agent.setMode('ask');
    // add (user scope): persisted and live in this session
    const userFile = path.join(config.homeDir, 'config.json');
    assert.equal(agent.policy.check({ tool: 'bash', kind: 'execute', command: 'npm test' }).decision, 'ask');
    out.length = 0;
    await cmd.run('add allow bash(npm test*)', ctx);
    assert.match(out.join('\n'), /added allow bash\(npm test\*\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(userFile, 'utf8')).permissions.allow, ['bash(python*)', 'bash(npm test*)']);
    assert.equal(agent.policy.check({ tool: 'bash', kind: 'execute', command: 'npm test' }).decision, 'allow');
    await cmd.run('add deny bash(npm publish*)', ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(userFile, 'utf8')).permissions.deny, ['bash(npm publish*)']);
    assert.equal(agent.policy.check({ tool: 'bash', kind: 'execute', command: 'npm publish' }).decision, 'deny');
    // remove
    await cmd.run('remove allow bash(npm test*)', ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(userFile, 'utf8')).permissions.allow, ['bash(python*)']);
    assert.equal(agent.policy.check({ tool: 'bash', kind: 'execute', command: 'npm test' }).decision, 'ask');
    // S7: project scope cannot pre-approve floor categories or self-modification
    const projFile = path.join(ws, '.tugline', 'config.local.json');
    for (const bad of ['bash(*)', 'bash(rm -rf /*)', 'bash(git push --force*)', 'bash(cat ~/.ssh/*)', 'edit_file(.github/workflows/**)', 'write_file(Makefile)', 'edit_file(**)', '*']) {
      out.length = 0;
      await cmd.run(`add allow ${bad} --project`, ctx);
      assert.match(out.join('\n'), /refused: project rules can only be tightened/, bad);
    }
    assert.equal(fs.existsSync(projFile), false, 'nothing written');
    out.length = 0;
    // re-check C: project rules only tighten from here (an allow, even a harmless one, is refused)
    await cmd.run('add allow bash(npm run lint*) --project', ctx);
    assert.match(out.join('\n'), /refused: project rules can only be tightened/);
    assert.equal(fs.existsSync(projFile), false);
    // project deny / ask rules are always fine
    await cmd.run('add ask bash(git push*) --project', ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(projFile, 'utf8')).permissions.ask, ['bash(git push*)']);
    // VS Code chat: the same command through dispatchSlash
    const vs: string[] = [];
    const d: any = { agent, write: (t: string) => vs.push(t), newChat: () => {}, setModel: () => {}, registry: { get: getSlashCommand, list: slashCommands } };
    assert.deepEqual(await dispatchSlash('/permissions add deny web_fetch(domain:evil.example)', d), { handled: true, prompt: undefined });
    assert.ok(JSON.parse(fs.readFileSync(userFile, 'utf8')).permissions.deny.includes('web_fetch(domain:evil.example)'));
    await dispatchSlash('/permissions', d);
    assert.match(vs.join('\n'), /deny: bash\(npm publish\*\), web_fetch\(domain:evil\.example\)/);
    assert.ok(slashCommands().some((c) => c.name === 'permissions'), 'in /help and the VS Code "/" list');
  } finally {
    await agent.close?.();
    await srv.close();
  }
});

test('N43 R5: a trusted project config cannot allow floor-category commands or self-modification edits (S7, at load time)', async () => {
  const { loadConfig } = await import('../src/core/config.js');
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ permissions: { allow: ['bash(npm test*)', 'bash(*)', 'bash(git push --force*)', 'edit_file(.github/workflows/**)', 'edit_file(src/**)', 'write_file(.envrc)'] } }) });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  // (after the WS18 merge a project's allow rules load only where the user lets that project loosen settings,
  // sandbox.trustProjectConfig; even then the S7 gate below holds)
  const cfg = loadConfig({ workspace: ws, noUserConfig: true, trusted: true, env: {}, overrides: { homeDir, sandbox: { trustProjectConfig: [ws] } } } as any);
  const defaultAllow = loadConfig({ workspace: tmpWorkspace({}), noUserConfig: true, trusted: true, env: {}, overrides: { homeDir } } as any).permissions.allow;
  assert.deepEqual(cfg.permissions.allow.filter((r: string) => !defaultAllow.includes(r)), ['bash(npm test*)', 'edit_file(src/**)']);
  const ign = cfg.trust!.ignored.join('\n');
  for (const r of ['bash(*)', 'bash(git push --force*)', 'edit_file(.github/workflows/**)', 'write_file(.envrc)']) assert.ok(ign.includes(`permissions.allow ${JSON.stringify(r)}`), r);
  // the user's own scope may (the user decides): /permissions writes it without --project
  const out: string[] = [];
  const config = { ...cfg, homeDir } as any;
  await getSlashCommand('permissions')!.run('add allow edit_file(.github/workflows/**)', { agent: undefined, config, workspace: ws, write: (t: string) => out.push(t), surface: 'cli' });
  assert.match(out.join('\n'), /added allow/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8')).permissions.allow, ['edit_file(.github/workflows/**)']);
});

// ------------------------------------------------------------ re-check (docs/reviews/v1.2-WS23-recheck.md)

test('N43 RRC: a managed deny (and a project ask) survives every /permissions add/remove sequence, on every surface; the live lists are rebuilt from their sources', async () => {
  const { loadConfig } = await import('../src/core/config.js');
  const srv = await startMockServer([]);
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ permissions: { ask: ['bash(git push*)'] } }) });
  // the managed deny comes through the real managed-policy path (TUG_MANAGED_POLICY → applyGovernance)
  const managedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-')), 'managed.json');
  fs.writeFileSync(managedFile, JSON.stringify({ deny: ['bash(curl*)'] }));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  const config = loadConfig({ workspace: ws, noUserConfig: true, trusted: true, env: { TUG_MANAGED_POLICY: managedFile }, overrides: { homeDir, permissionMode: 'ask', profiles: { default: { baseUrl: srv.url, model: 'mock-model', apiKey: 'sk-test' } }, shell: { sandbox: 'none', requireSandbox: false } } } as any);
  assert.deepEqual(config.managed?.policy.deny, ['bash(curl*)'], 'managed policy loaded');
  assert.ok(config.permissions.deny.includes('bash(curl*)'));
  const agent = await Agent.create({ workspace: ws, config, mcp: false });
  const cmd = getSlashCommand('permissions')!;
  const out: string[] = [];
  const run = (op: string, surface: 'cli' | 'vscode' | 'server' = 'cli') => cmd.run(op, { agent, config, workspace: ws, write: (t) => out.push(t), surface });
  const decide = (command: string) => agent.policy.check({ tool: 'bash', kind: 'execute', command }).decision;
  const userFile = path.join(homeDir, 'config.json');
  const projLocal = path.join(ws, '.tugline', 'config.local.json');
  const initial = { allow: [...agent.policy.opts.allow], ask: [...(agent.policy.opts.ask ?? [])], deny: [...agent.policy.opts.deny] };
  const reset = () => {
    fs.rmSync(userFile, { force: true });
    fs.rmSync(projLocal, { force: true });
    agent.policy.opts.allow = [...initial.allow];
    agent.policy.opts.ask = [...initial.ask];
    agent.policy.opts.deny = [...initial.deny];
  };
  try {
    assert.equal(decide('curl https://x.example'), 'deny');
    assert.equal(decide('git push origin main'), 'ask');
    // a user-scope change takes effect live, both ways
    assert.equal(decide('wget https://x.example'), 'ask');
    await run('add deny bash(wget*)');
    assert.equal(decide('wget https://x.example'), 'deny', 'the added deny applies at once');
    await run('remove deny bash(wget*)');
    assert.equal(decide('wget https://x.example'), 'ask', 'the removed deny is lifted at once');
    await run('add allow bash(npm test*)');
    assert.equal(decide('npm test'), 'allow');
    await run('remove allow bash(npm test*)');
    assert.equal(decide('npm test'), 'ask');
    reset();
    // every two-step sequence, from a fresh state each time: the managed deny (from its source, not from the base
    // snapshot) and the project ask always hold after the rebuild
    const OPS = ['add deny bash(curl*)', 'remove deny bash(curl*)', 'add allow bash(curl*)', 'remove allow bash(curl*)', 'add ask bash(curl*)', 'remove ask bash(curl*)', 'add ask bash(git push*)', 'remove ask bash(git push*)', 'add allow bash(git push*)', 'remove allow bash(git push*)'];
    const all = [...OPS, ...OPS.map((o) => `${o} --project`)];
    for (const surface of ['cli', 'vscode', 'server'] as const) {
      for (const a of all) {
        for (const b of all) {
          reset();
          for (const op of [a, b]) await run(op, surface);
          assert.equal(decide('curl https://x.example'), 'deny', `${surface}: ${a} ; ${b}`);
          assert.ok(agent.policy.opts.deny.includes('bash(curl*)'), `${surface}: ${a} ; ${b}: the managed deny is still in the live list`);
          assert.equal(decide('git push origin main'), 'ask', `${surface}: ${a} ; ${b}: the project ask still applies`);
        }
      }
    }
    // the managed rule cannot be removed, and says so
    reset();
    out.length = 0;
    await run('remove deny bash(curl*)');
    assert.match(out.join('\n'), /refused: deny bash\(curl\*\) comes from managed policy/);
    // user-scope changes touch only the user file; the project file never gains a looser rule
    for (const op of all) await run(op);
    const projRules = fs.existsSync(projLocal) ? JSON.parse(fs.readFileSync(projLocal, 'utf8')).permissions : {};
    assert.ok(!(projRules.allow ?? []).length, 'no allow rule was added to the project');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ws, '.tugline', 'config.json'), 'utf8')).permissions.ask, ['bash(git push*)']);
  } finally {
    await agent.close?.();
    await srv.close();
  }
});

test('N43 RRE: the project allow-rule gate resolves tool aliases, refuses every-command patterns and network rules; acceptEdits asks for self-modification edits by every edit tool', async () => {
  const { projectAllowProblem } = await import('../src/core/approver/ruleScope.js');
  const { loadConfig } = await import('../src/core/config.js');
  const { PermissionPolicy } = await import('../src/core/permissions/policy.js');
  const ws = tmpWorkspace({});
  const BAD = ['WriteFile(package.json)', 'MultiEdit(Makefile)', 'NotebookEdit(Makefile)', 'Write(Makefile)', 'Edit(.github/workflows/ci.yml)', 'write_file(**/Makefile)', 'edit_file(*)', 'Edit', 'bash(* *)', 'bash(*;*)', 'bash(*&&*)', 'Bash(*)', 'bash', 'bash(:*)', 'web_fetch', 'WebFetch', 'web_fetch(*)', 'web_fetch(domain:docs.python.org)', 'WebSearch', 'web_search', 'network', 'browser_navigate', '*', 'bash(git push*)', 'bash(curl * | sh)', 'bash(curl *)', 'bash(wget*)'];
  for (const r of BAD) assert.ok(projectAllowProblem(r, ws), r);
  for (const r of ['bash(npm test*)', 'bash(npm run lint*)', 'edit_file(src/**)', 'write_file(docs/*.md)', 'read_file', 'Read(**)']) assert.equal(projectAllowProblem(r, ws), null, r);
  // at load: a trusted project's file keeps none of them
  fs.mkdirSync(path.join(ws, '.tugline'));
  fs.writeFileSync(path.join(ws, '.tugline', 'config.json'), JSON.stringify({ permissions: { allow: [...BAD, 'bash(npm test*)'] } }));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  const base = loadConfig({ workspace: tmpWorkspace({}), noUserConfig: true, trusted: true, env: {}, overrides: { homeDir } } as any).permissions.allow;
  const cfg = loadConfig({ workspace: ws, noUserConfig: true, trusted: true, env: {}, overrides: { homeDir, sandbox: { trustProjectConfig: [ws] } } } as any);
  assert.deepEqual(cfg.permissions.allow.filter((r: string) => !base.includes(r)), ['bash(npm test*)']);
  // acceptEdits: every edit tool asks for a self-modification file (no rule), and is allowed elsewhere
  const pol = new PermissionPolicy({ workspace: ws, mode: 'acceptEdits', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] });
  for (const tool of ['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch']) {
    assert.equal(pol.check({ tool, kind: 'edit', paths: [{ path: path.join(ws, 'Makefile'), write: true }] }).decision, 'ask', tool);
    assert.equal(pol.check({ tool, kind: 'edit', paths: [{ path: path.join(ws, 'src/a.ts'), write: true }] }).decision, 'allow', tool);
  }
});

test('N43 RRF: every /permissions change is journaled and recorded as a security event; tug serve clients cannot change rules', async () => {
  const { onSecurityEvent } = await import('../src/core/permissions/audit.js');
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const ws = tmpWorkspace({});
  const config = testConfig(srv.url, { permissionMode: 'ask' });
  const seen: any[] = [];
  const off = onSecurityEvent((e) => seen.push(e));
  const agent = await Agent.create({ workspace: ws, config, mcp: false });
  const cmd = getSlashCommand('permissions')!;
  const out: string[] = [];
  try {
    await agent.run('hi').catch(() => {}); // opens the journal
    await cmd.run('add allow bash(npm test*)', { agent, config, workspace: ws, write: (t) => out.push(t), surface: 'cli' });
    await cmd.run('remove allow bash(npm test*)', { agent, config, workspace: ws, write: (t) => out.push(t), surface: 'vscode' });
    await cmd.run('add allow bash(npm test*)', { agent, config, workspace: ws, write: (t) => out.push(t), surface: 'server' });
    assert.match(out.at(-1)!, /refused: permission rules cannot be changed over tug serve/);
    assert.equal(fs.existsSync(path.join(config.homeDir, 'config.json')) ? (JSON.parse(fs.readFileSync(path.join(config.homeDir, 'config.json'), 'utf8')).permissions?.allow ?? []).length : 0, 0, 'the serve request wrote nothing');
    const ev = seen.filter((e) => /^permission_rule:/.test(e.category));
    assert.deepEqual(ev.map((e) => e.decision), ['add', 'remove', 'refused']);
    assert.ok(ev.every((e) => e.type === 'approval' && e.by === 'user'));
    const journal = fs.readFileSync(agent.journalFile!, 'utf8');
    const recs = journal.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'permission_change');
    assert.deepEqual(recs.map((r) => `${r.op}/${r.outcome}/${r.surface}`), ['add/applied/cli', 'remove/applied/vscode', 'add/refused/server']);
    // through the real server: session/command is refused for changes, listing still works
    const s2 = await startServer({ workspace: ws, config, port: 0 });
    const client = await OhClient.connect(s2.url, s2.token);
    try {
      await client.initialize();
      const sess = await client.createSession({});
      const r1: any = await client.request('session/command', { sessionId: sess.sessionId, name: 'permissions', args: 'add allow bash(rm*)' });
      assert.match(r1.output, /refused/);
      const r2: any = await client.request('session/command', { sessionId: sess.sessionId, name: 'permissions', args: '' });
      assert.match(r2.output, /user \(/);
    } finally {
      client.close();
      await s2.close();
    }
  } finally {
    off();
    await agent.close?.();
    await srv.close();
  }
});
