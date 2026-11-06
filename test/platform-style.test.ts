/** WS7 G7: output styles and the CLI status line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand } from '../src/core/commands.js';
import { outputStyleSection, BUILTIN_STYLES } from '../src/core/skills/outputStyles.js';
import { statusInput, statusLineBlocked, statusLineText } from '../src/core/plugins/statusLine.js';
import { approveHookHashes, hookHash } from '../src/core/agent/hooks.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

async function systemPromptWith(over: any, ws = tmpWorkspace({})): Promise<string> {
  const llm = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(llm.url, { checkpoints: { enabled: false }, ...over }), mcp: false });
  await agent.run('hi');
  await agent.dispose();
  await llm.close();
  return String(llm.requests[0].messages[0].content);
}

test('G7 AC1: the output style changes the system prompt (default, concise, explanatory, custom:<file>)', async () => {
  const base = await systemPromptWith({});
  assert.ok(!base.includes('# Output style'));
  const concise = await systemPromptWith({ outputStyle: 'concise' });
  assert.ok(concise.includes(BUILTIN_STYLES.concise));
  const explanatory = await systemPromptWith({ outputStyle: 'explanatory' });
  assert.match(explanatory, /# Output style: explanatory[\s\S]*Insight/);
  const ws = tmpWorkspace({ '.tugline/output-styles/pirate.md': '---\nname: Pirate\n---\nAnswer like a pirate.\n', 'styles/terse.md': 'One word answers.' });
  assert.match(await systemPromptWith({ outputStyle: 'custom:pirate' }, ws), /# Output style: Pirate\nAnswer like a pirate\./);
  assert.match(await systemPromptWith({ outputStyle: 'custom:styles/terse.md' }, ws), /# Output style: terse\nOne word answers\./);
  // only markdown/text files can become a style
  fs.writeFileSync(path.join(ws, 'secret.env'), 'TOKEN=abc');
  assert.equal(outputStyleSection({ outputStyle: 'custom:secret.env', homeDir: ws }, ws), '');
  // the slash command switches it from the next prompt
  const out: string[] = [];
  const cfg = testConfig('http://127.0.0.1:9');
  await getSlashCommand('output-style')!.run('explanatory', { agent: undefined, config: cfg, workspace: ws, write: (t) => out.push(t), surface: 'cli' });
  assert.equal(cfg.outputStyle, 'explanatory');
  await getSlashCommand('output-style')!.run('custom:nope', { agent: undefined, config: cfg, workspace: ws, write: (t) => out.push(t), surface: 'cli' });
  assert.equal(cfg.outputStyle, 'explanatory');
  assert.match(out.join('\n'), /not found/);
});

const STATUS_CMD = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log('SL '+j.model.id+' ctx='+j.context.percent+'% mode='+j.mode+' cost='+j.cost.total_cost_usd)})"`;

test('G7 AC2: the status-line command output appears in the CLI prompt (smoke test through the real CLI)', async () => {
  const llm = await startMockServer(() => ({ content: 'hello from the model' }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sl-home-'));
  fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tugline', 'config.json'), JSON.stringify({ statusLine: { command: STATUS_CMD }, checkpoints: { enabled: false }, web: { searchProvider: 'none' } }));
  const ws = tmpWorkspace({});
  const tsx = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
  const p = spawn(process.execPath, ['--import', tsx, path.resolve('src/cli/main.ts')], {
    cwd: ws,
    env: { ...process.env, HOME: home, TUG_BASE_URL: llm.url, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-test-1234567890abcdef' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  p.stdout.on('data', (d) => (stdout += d));
  p.stdin.write('say hi\n');
  p.stdin.write('/exit\n');
  p.stdin.end();
  const code = await new Promise((r) => p.on('close', r));
  await llm.close();
  assert.equal(code, 0, stdout);
  const lines = stdout.split('\n').filter((l) => l.startsWith('SL '));
  assert.ok(lines.length >= 2, `status line shown before each prompt:\n${stdout}`);
  assert.equal(lines[0], 'SL mock-model ctx=0% mode=ask cost=0');
  assert.match(lines[1], /^SL mock-model ctx=[1-9][\d.]*% mode=ask cost=0$/, 'context use grows after a turn');
  assert.ok(stdout.indexOf(lines[0]) < stdout.indexOf('hello from the model'));
});

test('G7: a status line defined only by the project needs approval; failures show nothing', async () => {
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ statusLine: { command: 'echo PROJECT-SL' } }) });
  const cfg = testConfig('http://127.0.0.1:9', { statusLine: { command: 'echo PROJECT-SL' } });
  const agent = { sessionId: 's', messages: [], llm: { profile: { model: 'm', name: 'default', contextWindow: 1000 } }, policy: { mode: 'ask' }, totals: { promptTokens: 0, completionTokens: 0, costUsd: 0, llmCalls: 0 } };
  assert.match(statusLineBlocked(cfg, ws) ?? '', /not approved/);
  assert.equal(await statusLineText(agent, cfg, ws), '');
  approveHookHashes(cfg.homeDir, ws, [hookHash('StatusLine', { command: 'echo PROJECT-SL' })]);
  assert.equal(statusLineBlocked(cfg, ws), undefined);
  assert.equal(await statusLineText(agent, cfg, ws), 'PROJECT-SL');
  const failing = testConfig('http://127.0.0.1:9', { statusLine: { command: 'echo nope; exit 3' } });
  assert.equal(await statusLineText(agent, failing, tmpWorkspace({})), '');
  const slow = testConfig('http://127.0.0.1:9', { statusLine: { command: 'sleep 5; echo late', timeoutMs: 200 } });
  assert.equal(await statusLineText(agent, slow, tmpWorkspace({})), '');
  const ansi = testConfig('http://127.0.0.1:9', { statusLine: { command: `printf '\\033[32mgreen\\033[0m\\033[2J'` } });
  assert.equal(await statusLineText(agent, ansi, tmpWorkspace({})), '\x1b[32mgreen\x1b[0m', 'colours kept, screen-control sequences dropped');
  assert.equal(statusInput(agent, ws).context.window, 1000);
});
