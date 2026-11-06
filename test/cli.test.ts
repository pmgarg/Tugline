/** WS4 D13: CLI parity — /context, /goal, /jobs, /memory, @file/@folder mentions; scripted CLI smoke runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand, type SlashContext } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { expandMentions } from '../src/core/context/mentions.js';
import { contextBreakdown } from '../src/core/context/breakdown.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const NO_MAP = { agent: { repoMapTokens: 0 } };

async function slash(agent: Agent, name: string, args: string): Promise<string> {
  let out = '';
  const ctx: SlashContext = { agent, config: agent.config, workspace: agent.workspace, write: (t) => (out += t + '\n'), surface: 'cli' };
  await getSlashCommand(name)!.run(args, ctx);
  return out;
}

test('D13 AC1 /context prints the 4 categories with token counts', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'hello\n' });
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false });
  await agent.run(expandMentions('look at @a.txt', ws).text);
  await srv.close();
  const out = await slash(agent, 'context', '');
  for (const cat of ['system prompt', 'tools', 'history', 'attachments']) assert.match(out, new RegExp(`${cat}\\s+\\d+ tok`));
  const b = contextBreakdown({ ...agent, systemPrompt: () => agent.systemPrompt(), toolSpecs: () => agent.toolSpecs(), messages: agent.messages, llm: agent.llm, config: agent.config });
  assert.ok(b.attachments > 0 && b.system > 0 && b.tools > 0 && b.history > 0);
  assert.equal(b.total, b.system + b.tools + b.history + b.attachments);
});

test('D13 AC1 /goal runs the goal loop until the check passes', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'done' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false });
  const out = await slash(agent, 'goal', 'create the flag file --check "test -f flag || (touch flag; exit 1)" --max-turns 4');
  await srv.close();
  assert.match(out, /\[goal\] met after 2 iteration\(s\); last check exit 0/);
  assert.equal(srv.requests.length, 2);
  assert.match(await slash(agent, 'goal', ''), /usage: \/goal/);
});

test('D13 AC1 /jobs lists, shows and kills background jobs of the session', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo started-job; sleep 30', run_in_background: true } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { backgroundJobs: true, repoMapTokens: 0 } }), mcp: false });
  assert.match(await slash(agent, 'jobs', ''), /no background jobs/);
  await agent.run('start');
  await srv.close();
  const list = await slash(agent, 'jobs', '');
  const id = list.match(/(job_\w+)\s+running/)![1];
  // poll for the job's first output instead of assuming how fast it starts
  let log = '';
  for (let t = 0; t < 200 && !/started-job/.test(log); t++) {
    log = await slash(agent, 'jobs', `log ${id}`);
    if (!/started-job/.test(log)) await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(log, /started-job/);
  assert.match(await slash(agent, 'jobs', `kill ${id}`), /killed/);
  assert.match(await slash(agent, 'jobs', ''), new RegExp(`${id}\\s+killed`));
  await agent.dispose();
});

test('D13 AC1 /memory adds and lists memories (and they reach the next prompt)', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, NO_MAP), mcp: false });
  assert.match(await slash(agent, 'memory', 'add package-manager: use pnpm, never npm'), /saved \(project\): - \[fact\] package-manager: package-manager: use pnpm/);
  assert.match(await slash(agent, 'memory', 'add --user prefer short answers'), /saved \(user\)/);
  const list = await slash(agent, 'memory', '');
  assert.match(list, /project memory \(\.tugline\/MEMORY\.md\): 1 active, 0 superseded/);
  assert.match(list, /user memory .*: 1 active/);
  await agent.run('hi');
  await srv.close();
  assert.match(String(srv.requests[0].messages[0].content), /use pnpm, never npm[\s\S]*|prefer short answers/);
});

test('D13 @file / @folder mentions: files, line ranges, folders; non-paths, e-mails and secret files are not attached', () => {
  const ws = tmpWorkspace({ 'src/a.py': 'l1\nl2\nl3\nl4\n', 'src/b.py': 'x', '.env': 'SECRET=1', 'docs/readme.md': '# hi' });
  const policy = { check: (i: any) => (/\.env$/.test(i.paths[0].path) ? { decision: 'ask' as const, reason: 'file may contain secrets' } : { decision: 'allow' as const, reason: 'read-only' }) };
  const r = expandMentions('fix @src/a.py:2-3, compare @src/ and @.env; mail me@example.com about @nothere.', ws, { policy });
  assert.deepEqual(r.attached.map((a) => a.source), ['@src/a.py:2-3', '@src/']);
  assert.match(r.text, /<attached_context source="@src\/a\.py:2-3" kind="file" id="[0-9a-f]{16}">\n {4}2\tl2\n {4}3\tl3\n<\/attached_context>/);
  assert.match(r.text, /<attached_context source="@src\/" kind="folder" id="[0-9a-f]{16}">\na\.py\nb\.py\n<\/attached_context>/);
  assert.deepEqual(r.skipped, [{ source: '@.env', reason: 'file may contain secrets' }]);
  assert.ok(!r.text.includes('SECRET'));
  assert.equal(expandMentions('ping @someone', ws).text, 'ping @someone');
  assert.match(expandMentions('see @docs/readme.md.', ws).text, /source="@docs\/readme\.md"/);
});

// ------------------------------------------------------------------ scripted CLI runs

function runCli(args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: process.cwd(), env: { ...process.env, ...env, TUG_API_KEY: '', OPENAI_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

test('D13 AC1 scripted interactive session: /context /jobs /memory /goal /compact /help', async () => {
  const ws = tmpWorkspace({ 'note.txt': 'n\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-'));
  const srv = await startMockServer((body) => (String(body.messages[0].content).startsWith('You are compressing') ? { content: 'summary' } : { content: 'ok from mock' }));
  const script = ['/context', '/jobs', '/memory add build: run make', '/memory', '/goal be done --check "true" --max-turns 2', 'summarise @note.txt', '/compact focus on tests', '/help', '/exit', ''].join('\n');
  const r = await runCli(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', '--native-tools'], { HOME: home }, script);
  await srv.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /system prompt\s+\d+ tok/);
  assert.match(r.out, /attachments\s+\d+ tok/);
  assert.match(r.out, /no background jobs/);
  assert.match(r.out, /saved \(project\): - \[fact\] build: build: run make/);
  assert.match(r.out, /\[goal\] met after 1 iteration/);
  assert.match(r.err, /\[attached @note\.txt \(2 lines\)\]/);
  assert.ok(srv.requests.some((b: any) => JSON.stringify(b.messages).includes('attached_context source=\\"@note.txt\\"')));
  assert.match(r.out, /\/context .*context window/);
  assert.match(r.out, /\/goal <condition>/);
  assert.match(r.out, /\/jobs/);
  assert.match(r.out, /\/memory/);
});

test('D13 headless -p expands @mentions', async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def f():\n    return 1\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-'));
  const srv = await startMockServer(() => ({ content: 'it returns 1' }));
  const r = await runCli(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', '-p', 'what does @calc.py return?'], { HOME: home });
  await srv.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /it returns 1/);
  const user = srv.requests[0].messages.find((m: any) => m.role === 'user').content;
  assert.match(user, /<attached_context source="@calc\.py" kind="file" id="[0-9a-f]{16}">\n {4}1\tdef f\(\):/);
});
