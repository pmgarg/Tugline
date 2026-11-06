/** WS7 G4: plugins and marketplace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from '../src/core/agent/agent.js';
import { loadConfig, type HarnessConfig } from '../src/core/config.js';
import { getSlashCommand, getCliCommand } from '../src/core/commands.js';
import { addMarketplace, installPlugin, readManifest, readState, removePlugin, setEnabled, trustPlugin, pluginDir, isTrusted } from '../src/core/plugins/index.js';
import { loadAgentDefinitions } from '../src/core/skills/manager.js';
import '../src/core/tools/providers.js';
import { startMockServer, tmpWorkspace } from './helpers.js';

const FIX = path.resolve('test/fixtures/plugins');

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oh-plughome-'));
}

function cfgFor(home: string, ws: string, baseUrl: string, extra: any = {}): HarnessConfig {
  return loadConfig({
    workspace: ws,
    noUserConfig: true,
    env: {},
    overrides: {
      homeDir: home,
      permissionMode: 'yolo',
      profiles: { default: { baseUrl, model: 'mock-model', apiKey: 'sk-test-1234567890abcdef', contextWindow: 32768, maxOutputTokens: 1024, toolMode: 'auto', timeoutMs: 20_000 } },
      web: { searchProvider: 'none' },
      checkpoints: { enabled: false },
      ...extra,
    },
  });
}

/** A git repository containing a copy of a fixture plugin; returns a file:// URL. */
function gitRepoOf(fixture: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-plugrepo-'));
  fs.cpSync(path.join(FIX, fixture), dir, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'plugin');
  return `file://${dir}`;
}

test('G4 AC1: a fixture plugin installed from a local path: its skill, agent, command and MCP server appear', async () => {
  const home = freshHome();
  const ws = tmpWorkspace({});
  const r = await installPlugin(home, path.join(FIX, 'oh-demo'), { trust: true });
  assert.equal(r.manifest.name, 'oh-demo');
  assert.equal(r.trusted, true, '--trust is honoured for a local path');
  assert.ok(fs.existsSync(path.join(home, 'plugins', 'oh-demo', 'tugline-plugin.json')));
  const srv = await startMockServer((body, i) => {
    if (i === 0) {
      assert.ok(body.tools.some((t: any) => t.function.name === 'mcp__oh-demo-calc__add'), 'plugin MCP tool offered');
      return { toolCalls: [{ name: 'mcp__oh-demo-calc__add', arguments: { a: 2, b: 40 } }] };
    }
    return { content: 'done' };
  });
  const cfg = cfgFor(home, ws, srv.url);
  const agent = await Agent.create({ workspace: ws, config: cfg });
  try {
    assert.ok(agent.skills.list().some((s) => s.name === 'demo-skill' && s.source === 'plugin'), 'skill appears');
    assert.ok(agent.agentDefinitions.some((d) => d.name === 'demo-agent' && d.tools?.includes('grep')), 'agent appears');
    assert.deepEqual(agent.mcp?.status().map((s) => [s.name, s.status]), [['oh-demo-calc', 'connected']], 'MCP server appears');
    const cmd = getSlashCommand('oh-demo:hello');
    assert.ok(cmd, 'command appears as /oh-demo:hello');
    const out = await cmd!.run('Ada', { agent, config: cfg, workspace: ws, write: () => {}, surface: 'cli' });
    assert.equal((out as any).prompt, 'Say hello to Ada in one line.');
    await agent.run('add');
    assert.match(JSON.stringify(srv.requests[1].messages.at(-1)), /42/);
  } finally {
    await agent.dispose();
    await srv.close();
  }
});

test('G4 AC2: a Claude Code plugin layout (.claude-plugin/plugin.json, nested hooks, ${CLAUDE_PLUGIN_ROOT}) installs', async () => {
  const home = freshHome();
  const r = await installPlugin(home, path.join(FIX, 'cc-demo'));
  const m = r.manifest;
  assert.equal(m.format, 'claude');
  assert.equal(m.name, 'cc-demo');
  assert.equal(m.author, 'Fixture Author');
  const dir = pluginDir(home, 'cc-demo');
  assert.deepEqual(m.hooks.PostToolUse, [{ matcher: 'write_file|edit_file|multi_edit|apply_patch', command: `${dir}/scripts/format.sh`, timeoutMs: 30_000 }]);
  assert.deepEqual(m.hooks.PreToolUse, [{ matcher: 'bash', command: 'echo cc-demo-hook >> plugin-hook-ran.txt' }]);
  assert.deepEqual(m.mcpServers.tools, { command: 'node', args: [`${dir}/server.mjs`] });
  assert.equal(r.trusted, false, 'not trusted without --trust');
  assert.match(r.notes.join('\n'), /2 hook\(s\) and 1 MCP server\(s\).*tug plugin trust cc-demo/s);
  assert.ok(fs.statSync(path.join(dir, 'scripts', 'format.sh')).mode & 0o100, 'executable bit kept');
  const ws = tmpWorkspace({});
  const cfg = cfgFor(home, ws, 'http://127.0.0.1:9');
  assert.ok(cfg.skills.dirs.includes(path.join(dir, 'skills')));
  assert.ok(loadAgentDefinitions(ws).some((d) => d.name === 'cc-reviewer'));
  const cmd = getSlashCommand('cc-demo:review');
  assert.equal(((await cmd!.run('src/a.ts "error handling"', { agent: undefined, config: cfg, workspace: ws, write: () => {}, surface: 'cli' })) as any).prompt, 'Review src/a.ts for bugs, focusing on error handling.');
  assert.deepEqual(Object.keys(cfg.mcpServers), [], 'untrusted plugin MCP servers are not configured');
});

test('G4 AC3: remove cleans up (files, state, skills, agents, MCP servers)', async () => {
  const home = freshHome();
  const ws = tmpWorkspace({});
  await installPlugin(home, path.join(FIX, 'oh-demo'), { trust: true });
  let cfg = cfgFor(home, ws, 'http://127.0.0.1:9');
  assert.ok(cfg.mcpServers['oh-demo-calc']);
  assert.ok(removePlugin(home, 'oh-demo'));
  assert.ok(!fs.existsSync(pluginDir(home, 'oh-demo')));
  assert.deepEqual(readState(home).plugins, {});
  cfg = cfgFor(home, ws, 'http://127.0.0.1:9');
  assert.equal(cfg.mcpServers['oh-demo-calc'], undefined);
  assert.ok(!cfg.skills.dirs.some((d) => d.includes('oh-demo')));
  assert.ok(!loadAgentDefinitions(ws).some((d) => d.name === 'demo-agent'));
  const out: string[] = [];
  await getSlashCommand('oh-demo:hello')?.run('x', { agent: undefined, config: cfg, workspace: ws, write: (t) => out.push(t), surface: 'cli' });
  assert.match(out.join(''), /not defined/);
  assert.equal(removePlugin(home, 'oh-demo'), false);
});

test('G4 AC4: untrusted plugin hooks do not run (git install); trust enables them; a changed plugin needs trust again', async () => {
  const home = freshHome();
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const url = gitRepoOf('oh-demo');
  const r = await installPlugin(home, url, { trust: true });
  assert.equal(r.entry.sourceType, 'git');
  assert.ok(r.entry.commit && /^[0-9a-f]{40}$/.test(r.entry.commit));
  assert.equal(r.trusted, false, '--trust is ignored for git sources');
  assert.ok(!fs.existsSync(path.join(pluginDir(home, 'oh-demo'), '.git')));
  const marker = path.join(ws, 'plugin-hook-ran.txt');
  const runBash = async () => {
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
    const events: string[] = [];
    const agent = await Agent.create({ workspace: ws, config: cfgFor(home, ws, srv.url), ui: { onEvent: (e) => e.type === 'notice' && events.push(e.message) } });
    try {
      await agent.run('run it');
      return { mcp: agent.mcp?.status() ?? [], notices: events };
    } finally {
      await agent.dispose();
      await srv.close();
    }
  };
  let res = await runBash();
  assert.ok(!fs.existsSync(marker), 'untrusted hook did not run');
  assert.deepEqual(res.mcp, [], 'untrusted MCP server not started');
  assert.ok(res.notices.some((n) => /plugin code not trusted.*oh-demo: hook PreToolUse/.test(n)), res.notices.join('\n'));

  trustPlugin(home, 'oh-demo');
  res = await runBash();
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'oh-demo-hook', 'trusted hook ran');
  assert.equal(res.mcp[0]?.status, 'connected');

  // Tamper with the installed plugin: trust is void until reviewed again.
  fs.unlinkSync(marker);
  fs.appendFileSync(path.join(pluginDir(home, 'oh-demo'), 'server.mjs'), '\n// changed\n');
  assert.equal(isTrusted(home, readState(home).plugins['oh-demo']), false);
  res = await runBash();
  assert.ok(!fs.existsSync(marker), 'changed plugin: hook did not run');
  assert.deepEqual(res.mcp, []);
});

test('G4: disabled plugins contribute nothing; marketplaces install by name (never trusted); managed allowMcpServers applies', async () => {
  const home = freshHome();
  const ws = tmpWorkspace({});
  const m = await addMarketplace(home, FIX);
  assert.equal(m.name, 'test-market');
  const r = await installPlugin(home, 'cc-demo@test-market', { trust: true });
  assert.equal(r.entry.sourceType, 'marketplace');
  assert.equal(r.entry.marketplace, 'test-market');
  assert.equal(r.trusted, false);
  const r2 = await installPlugin(home, 'marketplace:oh-demo');
  assert.equal(r2.manifest.name, 'oh-demo');
  setEnabled(home, 'cc-demo', false);
  let cfg = cfgFor(home, ws, 'http://127.0.0.1:9');
  assert.ok(!cfg.skills.dirs.some((d) => d.includes('cc-demo')));
  assert.ok(cfg.skills.dirs.some((d) => d.includes('oh-demo')));
  // trusted, but managed policy does not allow the server
  trustPlugin(home, 'oh-demo');
  const policy = path.join(home, 'managed.json');
  fs.writeFileSync(policy, JSON.stringify({ allowMcpServers: ['something-else'] }));
  cfg = loadConfig({ workspace: ws, noUserConfig: true, env: { TUG_MANAGED_POLICY: policy }, overrides: { homeDir: home } });
  assert.equal(cfg.mcpServers['oh-demo-calc'], undefined);
  assert.ok(cfg.managed?.violations.some((v) => /oh-demo-calc/.test(v)));
  await assert.rejects(installPlugin(home, 'nope@test-market'), /not found/);
});

test('G4: plugins with symlinks or paths outside the plugin are refused; the CLI lists trust state', async () => {
  const home = freshHome();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-badplug-'));
  fs.cpSync(path.join(FIX, 'oh-demo'), src, { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(src, 'skills', 'demo-skill', 'leak.txt'));
  await assert.rejects(installPlugin(home, src), /symbolic links/);
  fs.unlinkSync(path.join(src, 'skills', 'demo-skill', 'leak.txt'));
  fs.writeFileSync(path.join(src, 'tugline-plugin.json'), JSON.stringify({ name: 'evil', skills: '../../' }));
  await assert.rejects(installPlugin(home, src), /outside the plugin directory/);
  fs.writeFileSync(path.join(src, 'tugline-plugin.json'), JSON.stringify({ name: '../evil' }));
  await assert.rejects(installPlugin(home, src), /invalid plugin name/);
  await installPlugin(home, path.join(FIX, 'cc-demo'));
  const out: string[] = [];
  const cli = getCliCommand('plugin')!;
  await cli.run(['list'], { config: { homeDir: home } as any, workspace: '.', write: (t) => out.push(t) });
  assert.match(out.join('\n'), /cc-demo 0\.3\.0 \[enabled\].*NOT trusted/);
  out.length = 0;
  const code = await cli.run(['trust', 'cc-demo'], { config: { homeDir: home } as any, workspace: '.', write: (t) => out.push(t) });
  if (!process.stdin.isTTY) {
    assert.equal(code, 1, 'trust needs --yes without a terminal');
    assert.match(out.join('\n'), /hook PreToolUse\(bash\): echo cc-demo-hook/);
  }
  assert.equal(await cli.run(['trust', 'cc-demo', '--yes'], { config: { homeDir: home } as any, workspace: '.', write: (t) => out.push(t) }), 0);
  assert.ok(isTrusted(home, readState(home).plugins['cc-demo']));
  assert.equal(readManifest(pluginDir(home, 'cc-demo')).name, 'cc-demo');
});

test('G4/H5 (security): plugin and remote clones ignore a hostile global/system git config (insteadOf redirect, template hooks)', async () => {
  const realUrl = gitRepoOf('oh-demo');
  const evilUrl = gitRepoOf('cc-demo');
  const evilHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-evilhome-'));
  const marker = path.join(evilHome, 'hook-ran.txt');
  const tpl = path.join(evilHome, 'tpl');
  fs.mkdirSync(path.join(tpl, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(tpl, 'hooks', 'post-checkout'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
  const gitconfig = path.join(evilHome, '.gitconfig');
  fs.writeFileSync(gitconfig, `[url "${evilUrl}"]\n\tinsteadOf = ${realUrl}\n[init]\n\ttemplateDir = ${tpl}\n[core]\n\thooksPath = ${path.join(tpl, 'hooks')}\n`);
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = evilHome;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.XDG_CONFIG_HOME = evilHome;
  try {
    // sanity: plain git does honour this config
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-probe-'));
    execFileSync('git', ['clone', '-q', realUrl, path.join(probe, 'c')], { stdio: 'ignore' });
    assert.ok(fs.existsSync(path.join(probe, 'c', '.claude-plugin', 'plugin.json')), 'the hostile config redirects a plain clone');
    fs.rmSync(marker, { force: true });
    const home = freshHome();
    const r = await installPlugin(home, realUrl);
    assert.equal(r.manifest.name, 'oh-demo', 'the insteadOf redirect was ignored');
    assert.ok(!fs.existsSync(marker), 'no hook from the global config ran');
    const { gitClone } = await import('../src/core/plugins/store.js');
    const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rc-')), 'repo');
    await gitClone(realUrl, dest);
    assert.ok(fs.existsSync(path.join(dest, 'tugline-plugin.json')));
    assert.ok(!fs.existsSync(marker));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
