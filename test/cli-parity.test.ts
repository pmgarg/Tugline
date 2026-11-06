/**
 * v1.2 N49: CLI parity+ (Qwen Code packages/cli, Cline CLI). One test per implemented inventory row
 * (docs/parity/inventory/N49.md), the published headless JSON schema (AC2), and the loosening-flag controls (SAC1).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import Ajv2020 from 'ajv/dist/2020.js';
import { startMockServer, testConfig, tmpWorkspace, trackTmp, type MockServer } from './helpers.js';
import { headlessJsonSchema, HEADLESS_SCHEMA_VERSION } from '../src/cli/output.js';
import { palette, resolveTheme } from '../src/cli/theme.js';
import { attachVim, vimInit, vimKey, type VimState } from '../src/cli/vim.js';
import { completionScript } from '../src/cli/completion.js';
import { copyToClipboard } from '../src/cli/slash.js';
import { getSlashCommand, type SlashContext } from '../src/core/commands.js';
import { Agent } from '../src/core/agent/agent.js';
import '../src/core/tools/providers.js';
import '../src/cli/slash.js';
const PKG_VERSION: string = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const VRE = PKG_VERSION.replace(/\./g, '\\.');

const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

function runCli(args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: process.cwd(), env: { ...process.env, TUG_API_KEY: '', OPENAI_API_KEY: '', TUG_MANAGED_POLICY: '', NO_COLOR: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin);
  });
}

const home = () => trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-')));
async function mock(script: Parameters<typeof startMockServer>[0] = () => ({ content: 'ok from mock' })): Promise<MockServer> {
  const s = await startMockServer(script);
  servers.push(s);
  return s;
}
const base = (srv: MockServer, ws: string) => ['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', '--native-tools'];
const sys = (body: any) => String(body.messages.find((m: any) => m.role === 'system')?.content ?? '');
const userTexts = (body: any) => body.messages.filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

// ------------------------------------------------------------------ AC2: published schema

test('N49 AC2: headless --output-format json and stream-json (and --json) validate against the published JSON schema', { timeout: 120_000 }, async () => {
  const published = JSON.parse(fs.readFileSync('docs/schemas/headless-output.schema.json', 'utf8'));
  assert.deepEqual(published, headlessJsonSchema(), 'docs/schemas/headless-output.schema.json is the generated schema (regenerate with scripts/gen-headless-schema.mts)');
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  const validateResult = ajv.compile(published);
  const validateLine = ajv.getSchema(`${published.$id}#/$defs/line`);
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const srv = await mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'read it' }));
  const json = await runCli([...base(srv, ws), '-p', 'read a.txt', '--output-format', 'json'], { HOME: home() });
  assert.equal(json.code, 0, json.err);
  const doc = JSON.parse(json.out);
  assert.ok(validateResult(doc), JSON.stringify(validateResult.errors));
  assert.equal(doc.type, 'result');
  assert.equal(doc.version, HEADLESS_SCHEMA_VERSION);
  assert.equal(doc.result, 'read it');
  assert.equal(doc.stats.tool_calls, 1);
  assert.equal(json.out.trim().split('\n').length, 1, 'json is one document on stdout');
  for (const flag of [['--output-format', 'stream-json'], ['--json']]) {
    const srv2 = await mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'read it' }));
    const r = await runCli([...base(srv2, ws), '-p', 'read a.txt', ...flag], { HOME: home() });
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l));
    for (const l of lines) assert.ok(validateLine(l), `${JSON.stringify(l).slice(0, 200)}: ${JSON.stringify(validateLine.errors)}`);
    assert.equal(lines[0].type, 'system');
    assert.equal(lines[0].subtype, 'init');
    assert.ok(lines[0].tools.includes('read_file'));
    assert.ok(lines.some((l) => l.type === 'tool_start'));
    assert.equal(lines[lines.length - 1].type, 'result');
    assert.ok(validateResult(lines[lines.length - 1]));
  }
  // a document that breaks the contract is rejected (the schema is not vacuous)
  assert.equal(validateResult({ ...doc, stats: { ...doc.stats, turns: -1 } }), false);
  assert.equal(validateResult({ ...doc, extra: 1 }), false);
});

// ------------------------------------------------------------------ AC1: one test per row

test('N49 AC1 output formats: text (default) prints only the answer; json lists permission denials', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch made.txt' } }] } : { content: 'tried' }));
  const r = await runCli([...base(srv, ws), '-p', 'make a file', '--output-format', 'json', '--mode', 'ask'], { HOME: home() });
  const doc = JSON.parse(r.out);
  assert.equal(doc.permission_denials.length, 1, r.out);
  assert.equal(doc.permission_denials[0].tool, 'bash');
  assert.ok(!fs.existsSync(path.join(ws, 'made.txt')));
  const srv2 = await mock(() => ({ content: 'plain answer' }));
  const t = await runCli([...base(srv2, ws), '-p', 'hi'], { HOME: home() });
  assert.equal(t.out, 'plain answer\n');
});

test('N49 AC1 --input-format stream-json: one user message per stdin line, multi-turn in one session', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock((body) => ({ content: `answer to: ${userTexts(body).at(-1)}` }));
  const r = await runCli([...base(srv, ws), '--input-format', 'stream-json', '--output-format', 'json'], { HOME: home() }, '{"type":"user","text":"first"}\n{"type":"user","text":"second"}\n');
  assert.equal(r.code, 0, r.err);
  const doc = JSON.parse(r.out);
  assert.equal(doc.result, 'answer to: second');
  assert.deepEqual(userTexts(srv.requests[1]).filter((t: string) => /first|second/.test(t)), ['first', 'second'], 'the second turn carries the first');
  const bad = await runCli([...base(srv, ws), '--input-format', 'stream-json'], { HOME: home() }, 'not json\n');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /stream-json: not JSON/);
});

test('N49 AC1 --input-file and piped stdin: the prompt comes from a file; piped input is attached to -p', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const f = path.join(ws, 'task.md');
  fs.writeFileSync(f, 'the task from a file');
  const srv = await mock(() => ({ content: 'ok' }));
  await runCli([...base(srv, ws), '--input-file', f], { HOME: home() });
  assert.ok(userTexts(srv.requests[0]).some((t: string) => t.includes('the task from a file')));
  const srv2 = await mock(() => ({ content: 'ok' }));
  await runCli([...base(srv2, ws), '-p', 'summarize this'], { HOME: home() }, 'piped log line\n');
  assert.ok(userTexts(srv2.requests[0]).some((t: string) => /summarize this[\s\S]*stdin[\s\S]*piped log line/.test(t)));
});

test('N49 AC1 sessions: --session-id, --continue, --resume <id>, --fork-session; tug sessions list/show/export/rename/delete', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const srv = await mock((body) => ({ content: `turn ${userTexts(body).length}` }));
  const r1 = await runCli([...base(srv, ws), '-p', 'remember the word kiwi', '--session-id', 'mysession-1', '--output-format', 'json'], { HOME: h });
  assert.equal(JSON.parse(r1.out).session_id, 'mysession-1');
  const r2 = await runCli([...base(srv, ws), '-p', 'what was the word?', '--continue', '--output-format', 'json'], { HOME: h });
  assert.equal(JSON.parse(r2.out).session_id, 'mysession-1', '--continue resumes the latest session id');
  assert.ok(userTexts(srv.requests.at(-1)).some((t: string) => t.includes('kiwi')), 'history carried');
  const r3 = await runCli([...base(srv, ws), '-p', 'fork it', '--resume', 'mysession', '--fork-session', '--output-format', 'json'], { HOME: h });
  const forked = JSON.parse(r3.out).session_id;
  assert.notEqual(forked, 'mysession-1', 'fork gets a new id');
  assert.ok(userTexts(srv.requests.at(-1)).some((t: string) => t.includes('kiwi')));
  const bad = await runCli([...base(srv, ws), '-p', 'x', '--session-id', '../evil'], { HOME: h });
  assert.notEqual(bad.code, 0);
  const list = await runCli(['--cwd', ws, 'sessions', 'list', '--output-format', 'json'], { HOME: h });
  const ids = JSON.parse(list.out).map((s: any) => s.id);
  assert.ok(ids.includes('mysession-1') && ids.includes(forked), list.out);
  const show = await runCli(['--cwd', ws, 'sessions', 'show', 'mysession-1'], { HOME: h });
  assert.match(show.out, /## User\n\nremember the word kiwi/);
  const exp = await runCli(['--cwd', ws, 'sessions', 'export', 'mysession-1', '--format', 'html'], { HOME: h });
  assert.match(exp.out, /^<!doctype html>.*Content-Security-Policy.*default-src 'none'/s);
  assert.ok(!/<script/i.test(exp.out));
  await runCli(['--cwd', ws, 'sessions', 'rename', 'mysession-1', 'Kiwi', 'chat'], { HOME: h });
  assert.match((await runCli(['--cwd', ws, 'sessions'], { HOME: h })).out, /mysession-1 .* Kiwi chat/);
  const del = await runCli(['--cwd', ws, 'sessions', 'delete', 'mysession-1'], { HOME: h });
  assert.match(del.out, /trash/);
  assert.ok(!JSON.parse((await runCli(['--cwd', ws, 'sessions', '--output-format', 'json'], { HOME: h })).out).some((s: any) => s.id === 'mysession-1'));
});

test('N49 AC1 --allowed-tools / --exclude-tools narrow the tool set (never widen it)', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock(() => ({ content: 'ok' }));
  const r = await runCli([...base(srv, ws), '-p', 'x', '--output-format', 'stream-json', '--allowed-tools', 'read_file,grep,nonexistent_tool'], { HOME: home() });
  const init = JSON.parse(r.out.split('\n')[0]);
  assert.deepEqual(init.tools.sort(), ['grep', 'read_file']);
  assert.deepEqual(srv.requests[0].tools.map((t: any) => t.function.name).sort(), ['grep', 'read_file']);
  const srv2 = await mock(() => ({ content: 'ok' }));
  const r2 = await runCli([...base(srv2, ws), '-p', 'x', '--output-format', 'stream-json', '--exclude-tools', 'bash,write_file'], { HOME: home() });
  const init2 = JSON.parse(r2.out.split('\n')[0]);
  assert.ok(!init2.tools.includes('bash') && !init2.tools.includes('write_file') && init2.tools.includes('read_file'));
});

test('N49 AC1 --allowed-mcp-server-names, --include-directories, --output-style, --plan and tug config get/path (secrets redacted)', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  fs.mkdirSync(path.join(h, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.tugline', 'config.json'), JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } }, profiles: { default: { apiKey: 'sk-supersecret-value-123456' } } }));
  const extra = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-extra-')));
  const get = async (key: string, more: string[] = []) => JSON.parse((await runCli(['--cwd', ws, ...more, 'config', 'get', key], { HOME: h })).out);
  assert.deepEqual(Object.keys(await get('mcpServers', ['--allowed-mcp-server-names', 'b'])), ['b']);
  assert.ok((await get('permissions.additionalDirectories', ['--include-directories', extra])).includes(path.resolve(extra)));
  assert.equal(await get('outputStyle', ['--output-style', 'concise']), 'concise');
  assert.equal(await get('permissionMode', ['--plan']), 'plan');
  const all = (await runCli(['--cwd', ws, 'config'], { HOME: h })).out;
  assert.ok(!all.includes('supersecret'), 'api key redacted');
  assert.match(all, /"apiKey": "\*\*\*"/);
  assert.match((await runCli(['--cwd', ws, 'config', 'path'], { HOME: h })).out, /\.tugline\/config\.json/);
});

test('N49 AC1 --system-prompt / --append-system-prompt: the role line is replaced or extended, the harness safety rules stay', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock(() => ({ content: 'ok' }));
  await runCli([...base(srv, ws), '-p', 'x', '--append-system-prompt', 'Always answer in haiku.'], { HOME: home() });
  const s1 = sys(srv.requests[0]);
  assert.match(s1, /^You are Tugline/);
  assert.match(s1, /# Additional instructions from the user\nAlways answer in haiku\./);
  assert.match(s1, /never instructions/, 'untrusted-data rules still in the prompt');
  const f = path.join(ws, 'role.txt');
  fs.writeFileSync(f, 'You are a terse reviewer.');
  const srv2 = await mock(() => ({ content: 'ok' }));
  await runCli([...base(srv2, ws), '-p', 'x', '--system-prompt', `@${f}`], { HOME: home() });
  const s2 = sys(srv2.requests[0]);
  assert.match(s2, /^You are a terse reviewer\./);
  assert.match(s2, /never instructions/);
});

test('N49 AC1 unattended limits: --max-tool-calls and --max-wall-time / -t stop the run', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.txt': 'a\n' });
  const srv = await mock((_b, i) => ({ toolCalls: [{ name: 'bash', arguments: { command: `echo step${i}` } }] }));
  const r = await runCli([...base(srv, ws), '-p', 'loop', '--yes', '--max-tool-calls', '2', '--output-format', 'json'], { HOME: home() });
  const doc = JSON.parse(r.out);
  assert.equal(doc.stop_reason, 'aborted');
  assert.ok(doc.stats.tool_calls <= 2, r.out);
  assert.equal(r.code, 1);
  const slow = await mock(() => ({ toolCalls: [{ name: 'bash', arguments: { command: 'sleep 3' } }] }));
  const t0 = Date.now();
  const r2 = await runCli([...base(slow, ws), '-p', 'wait', '--yes', '-t', '1', '--output-format', 'json'], { HOME: home() });
  assert.equal(JSON.parse(r2.out).stop_reason, 'aborted');
  assert.ok(Date.now() - t0 < 30_000);
});

test('N49 AC1 --effort maps to the model family\'s reasoning field (same table as the VS Code picker)', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock(() => ({ content: 'ok' }));
  await runCli(['--cwd', ws, '--base-url', srv.url, '--model', 'qwen3-8b', '--native-tools', '-p', 'x', '--effort', 'off'], { HOME: home() });
  assert.deepEqual(srv.requests[0].chat_template_kwargs, { enable_thinking: false });
  const bad = await runCli(['--cwd', ws, '--base-url', srv.url, '-p', 'x', '--effort', 'max'], { HOME: home() });
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--effort must be one of/);
});

test('N49 AC1 themes: --theme light/high-contrast/none, NO_COLOR and non-TTY output are plain', () => {
  assert.equal(resolveTheme({ tty: false, flag: 'dark' }), 'none');
  assert.equal(resolveTheme({ tty: true, env: { NO_COLOR: '1' } }), 'none');
  assert.equal(resolveTheme({ tty: true, env: {}, screenReader: true }), 'none');
  assert.equal(resolveTheme({ tty: true, env: {}, flag: 'light', config: 'dark' }), 'light');
  assert.equal(resolveTheme({ tty: true, env: {}, config: 'high-contrast' }), 'high-contrast');
  assert.equal(palette('none').red('x'), 'x');
  assert.equal(palette('dark').yellow('x'), '\x1b[33mx\x1b[0m');
  assert.equal(palette('light').yellow('x'), '\x1b[35mx\x1b[0m', 'no yellow on a white background');
  assert.equal(palette('high-contrast').dim('x'), '\x1b[97mx\x1b[0m', 'nothing dimmed');
});

test('N49 AC1 vim mode: normal-mode motions and edits (reducer) and the readline integration', () => {
  const keys = (s: VimState, seq: string) => {
    for (const ch of seq) s = vimKey(s, ch === '\x1b' ? { name: 'escape' } : { sequence: ch, name: ch }).state;
    return s;
  };
  let s: VimState = { ...vimInit(), line: 'hello big world', cursor: 15 };
  s = keys(s, '\x1b');
  assert.equal(s.mode, 'normal');
  assert.equal(s.cursor, 14);
  s = keys(s, '0w');
  assert.equal(s.cursor, 6);
  s = keys(s, 'dw');
  assert.equal(s.line, 'hello world');
  s = keys(s, 'u');
  assert.equal(s.line, 'hello big world');
  s = keys(s, '$x');
  assert.equal(s.line, 'hello big worl');
  s = keys(s, '0cwbye');
  assert.equal(s.mode, 'insert');
  assert.equal(vimKey(keys({ ...vimInit(), line: 'abc', cursor: 3 }, '\x1bZ'), { sequence: 'Q' }).state.line, 'abc', 'unknown keys never type into the line');
  // through a real readline interface (terminal mode on a fake TTY)
  const input = new PassThrough() as any;
  const output = new PassThrough();
  input.isTTY = true;
  const rl = readline.createInterface({ input, output, terminal: true });
  const detach = attachVim(rl);
  const lines: string[] = [];
  rl.on('line', (l) => lines.push(l));
  input.write('make it blue');
  input.write('\x1b');
  for (const ch of 'bdw') input.write(ch);
  input.write('agreen');
  input.write('\r');
  detach();
  rl.close();
  assert.deepEqual(lines, ['make it green']);
});

test('N49 AC1 shell completion: bash, zsh and fish scripts cover subcommands, flags and flag values', () => {
  const bash = completionScript('bash');
  for (const w of ['board', 'arena', 'sessions', 'completion', '--output-format', 'stream-json', '--theme']) assert.ok(bash.includes(w), w);
  const dir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-compl-')));
  fs.writeFileSync(path.join(dir, 'oh.bash'), bash);
  const b = spawnSync('bash', ['-n', path.join(dir, 'oh.bash')]);
  assert.equal(b.status, 0, b.stderr.toString());
  // the completion function itself, run in bash
  const run = spawnSync('bash', ['-c', `source ${path.join(dir, 'oh.bash')}; COMP_WORDS=(tug --output-format s); COMP_CWORD=2; _tug; echo "\${COMPREPLY[@]}"`]);
  assert.equal(run.stdout.toString().trim(), 'stream-json');
  const zsh = completionScript('zsh');
  assert.match(zsh, /^#compdef tug tugline/);
  if (spawnSync('zsh', ['--version']).status === 0) {
    fs.writeFileSync(path.join(dir, '_oh'), zsh);
    assert.equal(spawnSync('zsh', ['-n', path.join(dir, '_oh')]).status, 0);
  }
  assert.match(completionScript('fish'), /complete -c tug -l output-format -x -a 'text json stream-json'/);
  assert.throws(() => completionScript('tcsh'), /unknown shell/);
});

test('N49 AC1 REPL: multi-line input (trailing backslash), /theme, /vim (needs a terminal), /fork', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const srv = await mock((body) => ({ content: `got ${JSON.stringify(userTexts(body).at(-1))}` }));
  const script = ['first line \\', 'second line', '/theme light', '/theme', '/vim', '/fork', 'after fork', '/exit', ''].join('\n');
  const r = await runCli(base(srv, ws), { HOME: home() }, script);
  assert.equal(r.code, 0, r.err);
  assert.ok(srv.requests.some((b) => userTexts(b).some((t: string) => t === 'first line \nsecond line')), JSON.stringify(srv.requests.map(userTexts)));
  assert.match(r.out, /theme: light \(colour is off/);
  assert.match(r.out, /themes: dark, light, high-contrast, none/);
  assert.match(r.out, /vim mode needs a terminal/);
  assert.match(r.out, /forked into session \S+ \(\d+ messages\)/);
  const last = srv.requests.at(-1);
  assert.ok(userTexts(last).some((t: string) => t.includes('second line')) && userTexts(last).at(-1) === 'after fork', 'the fork carries the conversation');
});

test('N49 AC1 --home isolates config, sessions and state (Cline --data-dir); tug version / -V', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const iso = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-iso-')));
  const srv = await mock(() => ({ content: 'ok' }));
  await runCli([...base(srv, ws), '-p', 'x', '--home', iso, '--session-id', 'iso-1'], { HOME: h });
  assert.ok(fs.existsSync(path.join(iso, 'sessions')), 'sessions written under --home');
  assert.ok(!fs.existsSync(path.join(h, '.tugline', 'sessions')), 'nothing under ~/.tugline');
  assert.equal((await runCli(['--version'], { HOME: h })).out.trim(), PKG_VERSION);
  assert.equal((await runCli(['-V'], { HOME: h })).out.trim(), PKG_VERSION);
  assert.equal((await runCli(['version'], { HOME: h })).out.trim(), PKG_VERSION);
});

// slash commands added for parity: each tested through the shared registry (same in VS Code and tug serve)
async function slashCtx(script: Parameters<typeof startMockServer>[0] = () => ({ content: 'side answer' }), files: Record<string, string> = {}) {
  const ws = tmpWorkspace(files);
  const srv = await mock(script);
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { agent: { repoMapTokens: 0, harnessCheck: 'off' } }), mcp: false });
  let out = '';
  const answers: string[] = [];
  const ctx: SlashContext = { agent, config: agent.config, workspace: ws, write: (t) => (out += t + '\n'), ask: async () => answers.shift() ?? 'no', surface: 'cli' };
  const run = async (name: string, args = '') => {
    out = '';
    const r = await getSlashCommand(name)!.run(args, ctx);
    return { out, prompt: (r as any)?.prompt as string | undefined };
  };
  return { ws, srv, agent, run, answers, dispose: () => agent.dispose() };
}

test('N49 AC1 /export writes md/json/html of the conversation (html escaped, no scripts)', { timeout: 60_000 }, async () => {
  const s = await slashCtx(() => ({ content: 'hello <script>alert(1)</script>' }));
  await s.agent.run('say hi');
  const r = await s.run('export', 'html out.html');
  assert.match(r.out, /exported \d+ messages/);
  const html = fs.readFileSync(path.join(s.ws, 'out.html'), 'utf8');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !html.includes('<script>'));
  await s.run('export', 'json');
  const j = JSON.parse(fs.readFileSync(path.join(s.ws, '.tugline', 'exports', `${s.agent.sessionId}.json`), 'utf8'));
  assert.equal(j.messages.at(-1).content, 'hello <script>alert(1)</script>');
  await s.dispose();
});

test('N49 AC1 /copy uses the OS clipboard tool, else OSC 52, else prints', () => {
  const ran: string[] = [];
  assert.equal(copyToClipboard('abc', () => undefined, { run: (cmd, _a, input) => void ran.push(`${cmd}:${input}`) }), process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : 'wl-copy');
  assert.equal(ran.length, 1);
  const printed: string[] = [];
  assert.equal(copyToClipboard('xyz', (t) => printed.push(t), { tty: false, run: () => { throw new Error('none'); } }), 'printed');
  assert.deepEqual(printed, ['xyz']);
});

test('N49 AC1 /diff, /permissions, /rename, /history, /stats, /tasks, /about, /settings (redacted), /trust, /docs', { timeout: 60_000 }, async () => {
  const s = await slashCtx(() => ({ content: 'ok' }), { 'f.txt': 'one\n' });
  spawnSync('git', ['init', '-q'], { cwd: s.ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: s.ws });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'b'], { cwd: s.ws });
  fs.writeFileSync(path.join(s.ws, 'f.txt'), 'two\n');
  assert.match((await s.run('diff')).out, /f\.txt \| 2 \+-/);
  assert.match((await s.run('permissions')).out, /mode: ask\b/);
  await s.agent.run('first prompt here');
  await s.run('rename', 'My named session');
  assert.match((await s.run('history')).out, new RegExp(`${s.agent.sessionId} .* My named session`));
  assert.match((await s.run('stats')).out, /llm calls 1 · prompt \d+ \+ completion \d+ tokens/);
  assert.match((await s.run('tasks')).out, /no tasks|no background subagents/);
  assert.match((await s.run('about')).out, new RegExp(`Tugline ${VRE}[\\s\\S]*model mock-model @ 127\\.0\\.0\\.1`));
  const settings = (await s.run('settings')).out;
  assert.ok(!settings.includes('sk-test-1234567890abcdef') && settings.includes('"apiKey": "***"'));
  assert.equal(JSON.parse((await s.run('settings', 'permissionMode')).out), 'ask');
  assert.match((await s.run('trust')).out, /trust|available/);
  assert.match((await s.run('docs')).out, /USER_GUIDE/);
  await s.dispose();
});

test('N49 AC1 /plan and /approval-mode switch the permission mode; /effort changes the next request', { timeout: 60_000 }, async () => {
  const s = await slashCtx(() => ({ content: 'ok' }));
  await s.run('plan');
  assert.equal(s.agent.policy.opts.mode, 'plan');
  await s.run('approval-mode', 'acceptEdits');
  assert.equal(s.agent.policy.opts.mode, 'acceptEdits');
  await s.run('effort', 'high');
  await s.agent.run('think');
  assert.equal(s.srv.requests.at(-1).reasoning_effort ?? s.srv.requests.at(-1).chat_template_kwargs?.enable_thinking, s.srv.requests.at(-1).reasoning_effort ? 'high' : true);
  await s.dispose();
});

test('N49 AC1 /btw answers a side question without adding it to the conversation (and is admitted like any call)', { timeout: 60_000 }, async () => {
  const s = await slashCtx((body) => ({ content: userTexts(body).at(-1) === 'what is 2+2?' ? 'four' : 'main answer' }));
  await s.agent.run('main task');
  const before = s.agent.messages.length;
  const r = await s.run('btw', 'what is 2+2?');
  assert.equal(r.out.trim(), 'four');
  assert.equal(s.agent.messages.length, before, 'history untouched');
  assert.ok(s.srv.requests.at(-1).messages.some((m: any) => m.content === 'main task'), 'the side question sees the conversation');
  assert.equal(s.agent.totals.llmCalls >= 1, true);
  await s.dispose();
});

test('N49 AC1 /recap, /commit and /language hand a prompt to the agent (its git commands are asked like any other)', { timeout: 60_000 }, async () => {
  const s = await slashCtx();
  assert.match((await s.run('recap')).prompt!, /Recap this session/);
  const c = (await s.run('commit', 'mention the ticket ABC-1')).prompt!;
  assert.match(c, /stage only files that belong to this task/);
  assert.match(c, /ABC-1/);
  assert.match(c, /Do not push/);
  assert.match((await s.run('language', 'German')).prompt!, /write your replies in German/);
  await s.dispose();
});

test('N49 AC1 /bug prints a prefilled report URL without prompts, keys or paths; /directory add asks the human first', { timeout: 60_000 }, async () => {
  const s = await slashCtx();
  await s.agent.run('secret project prompt');
  const bug = decodeURIComponent((await s.run('bug', 'it crashed')).out);
  assert.match(bug, new RegExp(`Tugline ${VRE}`));
  assert.ok(!bug.includes('secret project prompt') && !bug.includes('sk-test') && !bug.includes(s.ws));
  const dir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-dir-')));
  s.answers.push('no');
  assert.match((await s.run('directory', `add ${dir}`)).out, /not added/);
  assert.ok(!s.agent.policy.opts.additionalDirectories.includes(fs.realpathSync(dir)));
  s.answers.push('yes');
  assert.match((await s.run('directory', `add ${dir}`)).out, /added/);
  assert.ok(s.agent.policy.opts.additionalDirectories.includes(fs.realpathSync(dir)));
  await s.dispose();
});

// ------------------------------------------------------------------ SAC1

test('N49 SAC1: --yolo and --no-sandbox print a warning, are journaled (and in the security events), and managed policy can forbid them', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const srv = await mock(() => ({ content: 'ok' }));
  const r = await runCli([...base(srv, ws), '-p', 'x', '--yolo', '--no-sandbox', '--session-id', 'loose-1'], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: --yolo: every tool call runs without asking you/);
  assert.match(r.err, /warning: --no-sandbox: commands run directly on your machine/);
  const dir = path.join(h, '.tugline', 'sessions');
  const journal = fs.readdirSync(dir, { recursive: true }).map(String).find((f) => f.includes('loose-1') && f.endsWith('.jsonl'));
  assert.ok(journal, 'journal written');
  const recs = fs.readFileSync(path.join(dir, journal!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recs.filter((x) => x.type === 'cli_flag').map((x) => x.flag), ['--yolo', '--no-sandbox']);
  const sec = fs.readdirSync(path.join(h, '.tugline', 'audit')).map((f) => fs.readFileSync(path.join(h, '.tugline', 'audit', f), 'utf8')).join('');
  assert.match(sec, /cli_flag:yolo/);
  assert.match(sec, /cli_flag:no-sandbox/);
  // managed policy forbids them: typed refusal, exit 2, the model is never called
  const pol = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-'))), 'managed.json');
  fs.writeFileSync(pol, JSON.stringify({ disableAutoMode: true }));
  const srv2 = await mock(() => ({ content: 'ok' }));
  const f1 = await runCli([...base(srv2, ws), '-p', 'x', '--yolo'], { HOME: h, TUG_MANAGED_POLICY: pol });
  assert.equal(f1.code, 2);
  assert.match(f1.err, /error \[forbidden_by_managed_policy\]: --yolo is forbidden by your organisation's managed policy \(disableAutoMode\)/);
  fs.writeFileSync(pol, JSON.stringify({ forceSandbox: true }));
  const f2 = await runCli([...base(srv2, ws), '-p', 'x', '--no-sandbox'], { HOME: h, TUG_MANAGED_POLICY: pol });
  assert.equal(f2.code, 2);
  assert.match(f2.err, /--no-sandbox is forbidden .*\(forceSandbox\)/);
  assert.equal(srv2.requests.length, 0, 'no model call when a forbidden flag is refused');
  // without the flags nothing is recorded
  const srv3 = await mock(() => ({ content: 'ok' }));
  const plain = await runCli([...base(srv3, ws), '-p', 'x', '--session-id', 'plain-1'], { HOME: h });
  assert.ok(!/warning: --/.test(plain.err));
});

test('N49 RF14: -y, --yes and --mode yolo are --yolo: warned, journaled, and refused (typed, exit 2) under a managed disableAutoMode; --include-directories is warned and journaled', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const pol = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-'))), 'managed.json');
  fs.writeFileSync(pol, JSON.stringify({ disableAutoMode: true }));
  for (const [given, flags] of [['-y', ['-y']], ['--yes', ['--yes']], ['--mode yolo', ['--mode', 'yolo']]] as const) {
    const srv = await mock(() => ({ content: 'ok' }));
    const sid = `rf14-${given.replace(/\W+/g, '')}`;
    const r = await runCli([...base(srv, ws), '-p', 'x', ...flags, '--session-id', sid], { HOME: h });
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, new RegExp(`warning: --yolo \\(given as ${given.replace(/[-]/g, '\\-')}\\): every tool call runs without asking you`), r.err);
    const dir = path.join(h, '.tugline', 'sessions');
    const jf = fs.readdirSync(dir, { recursive: true }).map(String).find((f) => f.includes(sid) && f.endsWith('.jsonl'))!;
    const recs = fs.readFileSync(path.join(dir, jf), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recs.filter((x) => x.type === 'cli_flag').map((x) => [x.flag, x.given]), [['--yolo', given]]);
    const srv2 = await mock(() => ({ content: 'ok' }));
    const m = await runCli([...base(srv2, ws), '-p', 'x', ...flags], { HOME: h, TUG_MANAGED_POLICY: pol });
    assert.equal(m.code, 2, `${given} under disableAutoMode: ${m.err}`);
    assert.match(m.err, new RegExp(`error \\[forbidden_by_managed_policy\\]: ${given.replace(/[-]/g, '\\-')} is forbidden .*\\(disableAutoMode\\)`));
    assert.equal(srv2.requests.length, 0, 'refused, not silently clamped to ask');
  }
  const srv = await mock(() => ({ content: 'ok' }));
  const inc = await runCli([...base(srv, ws), '-p', 'x', '--include-directories', os.tmpdir(), '--session-id', 'rf14-inc'], { HOME: h });
  assert.match(inc.err, /warning: --include-directories \(given as --include-directories \S+\): the agent may read and write these directories too/);
  const dir = path.join(h, '.tugline', 'sessions');
  const jf = fs.readdirSync(dir, { recursive: true }).map(String).find((f) => f.includes('rf14-inc') && f.endsWith('.jsonl'))!;
  assert.match(fs.readFileSync(path.join(dir, jf), 'utf8'), /"type":"cli_flag","flag":"--include-directories"/);
});

test('N49 RF4: `tug board … --yes` confirms only the merge: card agents still ask (denied without a terminal), the merge approval is journaled by cli_flag, and managed disableAutoMode refuses it', { timeout: 240_000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const srv = await mock((b: any) => {
    const tools = b.messages.filter((m: any) => m.role === 'tool').length;
    if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo ran-without-asking > proof.txt && rm -rf build' } }] };
    if (tools === 1) return { toolCalls: [{ name: 'write_file', arguments: { path: 'NOTE.md', content: 'note\n' } }] };
    return { content: 'done' };
  });
  const h = home();
  fs.mkdirSync(path.join(h, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.tugline', 'config.json'), JSON.stringify({ profiles: { default: { baseUrl: srv.url, model: 'm1', apiKey: 'x', toolMode: 'native' } }, permissionMode: 'acceptEdits', agent: { harnessCheck: 'off' }, shell: { sandbox: 'none' }, worktree: { verifyBeforeMerge: false } }));
  const ws = tmpWorkspace({ 'a.txt': 'a\n', 'build/keep.txt': 'k\n' });
  g(ws, 'init', '-q', '-b', 'main');
  g(ws, 'add', '-A');
  g(ws, 'commit', '-qm', 'base');
  const r = await runCli(['--cwd', ws, 'board', 'run', 'do the thing', '--yes'], { HOME: h });
  assert.match(r.out + r.err, /warning: --yes approves the board's merge step/);
  assert.ok(!fs.existsSync(path.join(ws, 'proof.txt')), 'nothing ran in the user tree');
  const wt = fs.readdirSync(path.join(h, '.tugline', 'worktrees'), { recursive: true }).map(String).find((f) => f.endsWith('proof.txt'));
  assert.equal(wt, undefined, `the card's command did not run without approval (no terminal → denied): ${r.out}`);
  const m = await runCli(['--cwd', ws, 'board', 'merge', 'do-the-thing', '--yes'], { HOME: h });
  assert.equal(m.code, 0, m.out + m.err);
  assert.ok(fs.existsSync(path.join(ws, 'build', 'keep.txt')), 'the deletion never happened');
  assert.ok(fs.existsSync(path.join(ws, 'NOTE.md')), 'the merge itself was confirmed by --yes');
  const sd = path.join(h, '.tugline', 'sessions');
  const journals = fs.readdirSync(sd, { recursive: true }).map(String).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(sd, f), 'utf8')).join('\n');
  assert.match(journals, /"type":"merge","tool":"worktree_merge".*"decision":"allow","by":"cli_flag"/);
  // managed policy: refused with a typed error
  const pol = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-'))), 'managed.json');
  fs.writeFileSync(pol, JSON.stringify({ disableAutoMode: true }));
  const f = await runCli(['--cwd', ws, 'board', 'run', 'again', '--yes'], { HOME: h, TUG_MANAGED_POLICY: pol });
  assert.equal(f.code, 2, f.out + f.err);
  assert.match(f.out + f.err, /error \[forbidden_by_managed_policy\]: --yes/);
});

// ------------------------------------------------------------------ review F13: missing CLI capabilities, built

test('N49 RF13: --mcp-config starts the servers in a file (warned, journaled; managed policy still filters), --disable-mcp-server removes one', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const fixture = path.resolve('test/fixtures/mcp-server.mjs');
  const f = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mcpcfg-'))), 'mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { calc: { command: 'node', args: [fixture] } } }));
  const srv = await mock((b: any) => ({ content: `tools: ${[...(b.tools ?? []).map((t: any) => t.function?.name).filter((n: string) => /^mcp__/.test(n)), ...[...sys(b).matchAll(/^- MCP server (\w+): (.*)$/gm)].flatMap((m) => m[2]!.split(', ').map((t) => `mcp__${m[1]}__${t}`))].join(',')}` }));
  const r = await runCli([...base(srv, ws), '-p', 'x', '--mcp-config', f, '--session-id', 'rf13-mcp'], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /tools: mcp__calc__/);
  assert.match(r.err, /warning: --mcp-config \(given as --mcp-config .*\): the MCP servers in this file start as programs/);
  const sd = path.join(h, '.tugline', 'sessions');
  const jf = fs.readdirSync(sd, { recursive: true }).map(String).find((x) => x.includes('rf13-mcp') && x.endsWith('.jsonl'))!;
  assert.match(fs.readFileSync(path.join(sd, jf), 'utf8'), /"type":"cli_flag","flag":"--mcp-config"/);
  const srv2 = await mock((b: any) => ({ content: `tools: ${[...(b.tools ?? []).map((t: any) => t.function?.name).filter((n: string) => /^mcp__/.test(n)), ...[...sys(b).matchAll(/^- MCP server (\w+): (.*)$/gm)].flatMap((m) => m[2]!.split(', ').map((t) => `mcp__${m[1]}__${t}`))].join(',')}` }));
  const d = await runCli([...base(srv2, ws), '-p', 'x', '--mcp-config', f, '--disable-mcp-server', 'calc'], { HOME: h });
  assert.match(d.out, /^tools:\s*$/m, 'disabled');
  const pol = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-'))), 'managed.json');
  fs.writeFileSync(pol, JSON.stringify({ allowMcpServers: ['other'] }));
  const srv3 = await mock((b: any) => ({ content: `tools: ${[...(b.tools ?? []).map((t: any) => t.function?.name).filter((n: string) => /^mcp__/.test(n)), ...[...sys(b).matchAll(/^- MCP server (\w+): (.*)$/gm)].flatMap((m) => m[2]!.split(', ').map((t) => `mcp__${m[1]}__${t}`))].join(',')}` }));
  const m = await runCli([...base(srv3, ws), '-p', 'x', '--mcp-config', f], { HOME: h, TUG_MANAGED_POLICY: pol });
  assert.match(m.out, /^tools:\s*$/m, 'managed allowMcpServers filters servers from --mcp-config too');
  const bad = await runCli([...base(srv3, ws), '-p', 'x', '--mcp-config', path.join(ws, 'missing.json')], { HOME: h });
  assert.equal(bad.code, 2);
  assert.ok(!/\n\s+at /.test(bad.err), `no stack trace: ${bad.err}`);
});

test('N49 RF13: --hooks-dir adds the hooks in <dir>/hooks.json (warned); --disabled-slash-commands switches /commands off in the REPL', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const h = home();
  const hd = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-hooksdir-')));
  const marker = path.join(hd, 'ran');
  fs.writeFileSync(path.join(hd, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'read_file', command: `touch ${marker}` }] } }));
  const srv = await mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'ok' }));
  const r = await runCli([...base(srv, ws), '-p', 'read it', '--hooks-dir', hd], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(marker), 'the hook from --hooks-dir ran');
  assert.match(r.err, /warning: --hooks-dir .*the hooks in this directory run as programs/);
  const srv2 = await mock(() => ({ content: 'ok' }));
  const repl = await runCli([...base(srv2, ws), '--disabled-slash-commands', 'about,stats'], { HOME: h }, '/about\n/exit\n');
  assert.match(repl.out, /\/about is disabled for this session \(--disabled-slash-commands\)/);
  assert.ok(!/Tugline \S+ · node/.test(repl.out), '/about did not run');
});

test('N49 RC3: --hooks-dir adds to the user\'s hooks for the same event, never replaces them', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const h = home();
  const mine = path.join(h, 'mine-ran');
  fs.mkdirSync(path.join(h, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.tugline', 'config.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'read_file', command: `touch ${mine}` }] } }));
  const hd = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-hooksdir-')));
  const theirs = path.join(hd, 'dir-ran');
  fs.writeFileSync(path.join(hd, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'read_file', command: `touch ${theirs}` }] } }));
  const srv = await mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'ok' }));
  const r = await runCli([...base(srv, ws), '-p', 'read it', '--hooks-dir', hd], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(theirs), 'the hook from --hooks-dir ran');
  assert.ok(fs.existsSync(mine), "the user's own PreToolUse hook still ran");
});

test('N49 RC4: --mcp-config ignores "trusted" (tools still ask) and adds to the user\'s mcpServers instead of replacing them', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const fixture = path.resolve('test/fixtures/mcp-server.mjs');
  fs.mkdirSync(path.join(h, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(h, '.tugline', 'config.json'), JSON.stringify({ mcpServers: { mine: { command: 'node', args: [fixture] } } }));
  const f = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mcpcfg-'))), 'mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { calc: { command: 'node', args: [fixture], trusted: true }, mine: { command: 'false', trusted: true } } }));
  const names = (b: any) => [...(b.tools ?? []).map((t: any) => t.function?.name).filter((n: string) => /^mcp__/.test(n)), ...[...sys(b).matchAll(/^- MCP server (\w+): (.*)$/gm)].flatMap((m) => m[2]!.split(', ').map((t) => `mcp__${m[1]}__${t}`))];
  let seen: string[] = [];
  let result = '';
  const srv = await mock((b: any, i) => {
    if (i === 0) {
      seen = names(b);
      return { toolCalls: [{ name: 'mcp__calc__add', arguments: { a: 2, b: 3 } }] };
    }
    result = JSON.stringify(b.messages?.at(-1) ?? '');
    return { content: 'done' };
  });
  const r = await runCli([...base(srv, ws), '-p', 'add', '--mcp-config', f], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.ok(seen.some((n) => n.startsWith('mcp__calc__')), `the file's server started: ${seen}`);
  assert.ok(seen.some((n) => n.startsWith('mcp__mine__')), `the user's own server is still there (merged, not replaced): ${seen}`);
  assert.ok(!/"5"|:\s*5\b|\\n5\\n|"content":"5"/.test(result) && /denied|permission|approv|ask/i.test(result), `the call was not auto-allowed as trusted: ${result}`);
  assert.match(r.err, /"calc" asks to be trusted/);
  assert.match(r.err, /"mine" is already one of your servers/);
});

test('N49 RC5: --hooks-dir inside the workspace needs the project-hook approval before its hooks run', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const h = home();
  const hd = path.join(ws, 'hooks');
  fs.mkdirSync(hd);
  const marker = path.join(h, 'ws-hook-ran');
  const hook = { matcher: 'read_file', command: `touch ${marker}` };
  fs.writeFileSync(path.join(hd, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [hook] } }));
  const call = () => mock((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] } : { content: 'ok' }));
  const r = await runCli([...base(await call(), ws), '-p', 'read it', '--hooks-dir', hd], { HOME: h });
  assert.equal(r.code, 0, r.err);
  assert.ok(!fs.existsSync(marker), 'an unapproved hook from a directory inside the workspace did not run');
  assert.match(r.err, /--hooks-dir is inside the workspace: 1 hook\(s\) from it wait for your approval/);
  const { approveHookHashes, hookHash } = await import('../src/core/agent/hooks.js');
  approveHookHashes(path.join(h, '.tugline'), ws, [hookHash('PreToolUse', hook)]);
  const r2 = await runCli([...base(await call(), ws), '-p', 'read it', '--hooks-dir', hd], { HOME: h });
  assert.equal(r2.code, 0, r2.err);
  assert.ok(fs.existsSync(marker), 'once approved, it runs');
});

test('N49 RF13: the OS certificate store is trusted with the bundled roots and NODE_EXTRA_CA_CERTS (merged, never replaced); --no-system-ca turns it off', async () => {
  const { applySystemCa } = await import('../src/cli/certs.js');
  let set: string[] | undefined;
  const fake: any = { getCACertificates: (k: string) => (k === 'system' ? ['S1', 'B1'] : ['B1', 'X1']), setDefaultCACertificates: (c: string[]) => (set = c) };
  assert.deepEqual(applySystemCa(true, fake), { applied: true, system: 2, total: 3 });
  assert.deepEqual(set, ['B1', 'X1', 'S1'], 'bundled + extra first, the system store added');
  set = undefined;
  assert.equal(applySystemCa(false, fake).applied, false);
  assert.equal(set, undefined);
  assert.match(applySystemCa(true, {} as any).reason ?? '', /cannot read the system store/);
});

test('N49 RC7: `tug doctor` shows whether the OS certificate store is trusted', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const srv = await mock(() => ({ content: 'ok' }));
  const on = await runCli([...base(srv, ws), 'doctor'], { HOME: h });
  assert.match(on.out, /certificates +OS certificate store (trusted \(\d+ system root\(s\); \d+ in all|NOT trusted: (this Node\.js|the system store))/, on.out + on.err);
  const srv2 = await mock(() => ({ content: 'ok' }));
  const off = await runCli([...base(srv2, ws), 'doctor', '--no-system-ca'], { HOME: h });
  assert.match(off.out, /certificates +OS certificate store NOT trusted: turned off \(--no-system-ca/, off.out + off.err);
});

test('N49 RF13: runtime log (TUG_LOG_ENABLED / TUG_LOG_LEVEL / TUG_LOG_PATH, secrets redacted), `tug doctor log`, and `tug doctor fix` removes only stale state', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const srv = await mock(() => ({ content: 'ok' }));
  const key = 'sk-rf13-log-0123456789abcdef';
  await runCli([...base(srv, ws), '-p', 'x'], { HOME: h, TUG_API_KEY: key });
  const log = path.join(h, '.tugline', 'logs', 'oh.log');
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, /"level":"info".*"msg":"start"/);
  assert.ok(!text.includes(key), 'secrets redacted');
  const alt = path.join(trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-log-'))), 'x.log');
  await runCli([...base(srv, ws), '-p', 'x'], { HOME: h, TUG_LOG_PATH: alt, TUG_LOG_LEVEL: 'warn' });
  assert.ok(!fs.existsSync(alt) || !/"msg":"start"/.test(fs.readFileSync(alt, 'utf8')), 'info lines below the warn level are not written');
  const h2 = home();
  await runCli([...base(srv, ws), '-p', 'x'], { HOME: h2, TUG_LOG_ENABLED: '0' });
  assert.ok(!fs.existsSync(path.join(h2, '.tugline', 'logs', 'oh.log')), 'logging off');
  const dl = await runCli(['--cwd', ws, 'doctor', 'log'], { HOME: h });
  assert.match(dl.out, /oh\.log \(\d+ line\(s\), level info\)/);
  // doctor fix: a dead process's lease and server.json go; a live one stays
  const oh = path.join(h, '.tugline');
  fs.mkdirSync(path.join(oh, 'workspaces'), { recursive: true });
  const dead = 2 ** 22 + 12345;
  fs.writeFileSync(path.join(oh, 'workspaces', 'dead.lease.json'), JSON.stringify({ pid: dead, host: os.hostname(), workspace: '/x', heartbeatAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(oh, 'workspaces', 'live.lease.json'), JSON.stringify({ pid: process.pid, host: os.hostname(), workspace: '/y', heartbeatAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(oh, 'server.json'), JSON.stringify({ url: 'ws://127.0.0.1:1', token: 't', pid: dead }));
  const fx = await runCli(['--cwd', ws, 'doctor', 'fix'], { HOME: h });
  assert.match(fx.out, /removed the workspace lease of dead process/);
  assert.match(fx.out, /removed server\.json of the stopped `tug serve`/);
  assert.ok(!fs.existsSync(path.join(oh, 'workspaces', 'dead.lease.json')));
  assert.ok(fs.existsSync(path.join(oh, 'workspaces', 'live.lease.json')), 'a live holder is never touched');
});

test('N49 RF13: `tug attach` joins a session running in `tug serve`: it streams the events, sends prompts, and answers approvals at this terminal', { timeout: 120_000 }, async () => {
  const { startServer } = await import('../src/server/server.js');
  const { OhClient } = await import('../src/server/client.js');
  const { attach } = await import('../src/cli/attach.js');
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n' });
  const llm = await mock((b: any) => {
    const tools = b.messages.filter((m: any) => m.role === 'tool').length;
    return tools === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo attached-run' } }] } : { content: 'ATTACH-REPLY done' };
  });
  const config = { ...testConfig(llm.url, { checkpoints: { enabled: false } }), homeDir: trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-attach-home-'))) };
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (_ws: string, o: any) => ({ ...testConfig(llm.url, { checkpoints: { enabled: false }, permissionMode: 'ask', ...o }), homeDir: config.homeDir }) } as any);
  try {
    const owner = await OhClient.connect(srv.url, srv.token);
    const s = await owner.createSession({ workspace: ws });
    const out: string[] = [];
    const asked: string[] = [];
    async function* lines() {
      yield 'please run it';
    }
    const code = await attach({ url: srv.url, token: srv.token, io: { write: (t) => out.push(t), lines: lines(), ask: async (q) => (asked.push(q), true) } });
    assert.equal(code, 0, out.join(''));
    const text = out.join('');
    assert.match(text, new RegExp(`attached to ${s.sessionId}`));
    assert.match(text, /⏺ .*echo attached-run/);
    assert.match(text, /ATTACH-REPLY done/);
    assert.ok(asked.some((q) => /echo attached-run/.test(q)), 'the approval was asked at the attached terminal');
    assert.match(text, /detached .*keeps running/);
    owner.close();
  } finally {
    await srv.close();
  }
});

test('N49 RF13: `tug batch` runs a plan over items with a ledger written first; dry run digest, --expect, status, retry of failed items, cancel, clean', { timeout: 240_000 }, async () => {
  const ws = tmpWorkspace({ 'src/a.txt': 'alpha\n', 'src/b.txt': 'beta\n', 'plan.json': JSON.stringify({ prompt: 'Copy {{source}} to {{target}} in upper case (item {{id}})', items: [{ id: 'a', source: 'src/a.txt', target: 'out/a.txt' }, { id: 'b', source: 'src/b.txt', target: 'out/b.txt' }], parallel: 2 }) });
  const h = home();
  let failB = true;
  const srv = await mock((b: any) => {
    const user = b.messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n');
    const tools = b.messages.filter((m: any) => m.role === 'tool').length;
    const it = /\(item (\w+)\)/.exec(user)?.[1];
    if (it === 'b' && failB) return { content: 'I could not do it' };
    return tools === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: `out/${it}.txt`, content: it === 'a' ? 'ALPHA\n' : 'BETA\n' } }] } : { content: 'done' };
  });
  const dry = await runCli([...base(srv, ws), 'batch', 'run', 'plan.json', '--dry-run'], { HOME: h });
  assert.equal(dry.code, 0, dry.err);
  const digest = /digest ([0-9a-f]{16})/.exec(dry.out)?.[1];
  assert.ok(digest, dry.out);
  assert.equal(srv.requests.length, 0, 'a dry run calls no model');
  const wrong = await runCli([...base(srv, ws), 'batch', 'run', 'plan.json', '--expect', '0000000000000000'], { HOME: h });
  assert.equal(wrong.code, 1);
  assert.match(wrong.out, /changed since the dry run/);
  const r = await runCli([...base(srv, ws), '--mode', 'acceptEdits', 'batch', 'run', 'plan.json', '--expect', digest!], { HOME: h });
  assert.equal(r.code, 1, 'item b failed');
  const task = /batch task (b[0-9a-z]+)/.exec(r.out)?.[1]!;
  assert.equal(fs.readFileSync(path.join(ws, 'out/a.txt'), 'utf8'), 'ALPHA\n');
  const ledger = JSON.parse(fs.readFileSync(path.join(h, '.tugline', 'batch', `${task}.json`), 'utf8'));
  assert.equal(ledger.items.a.state, 'done');
  assert.equal(ledger.items.b.state, 'failed');
  assert.match(ledger.items.b.error, /target out\/b\.txt was not written/);
  failB = false;
  const before = srv.requests.length;
  const rt = await runCli([...base(srv, ws), '--mode', 'acceptEdits', 'batch', 'retry', task], { HOME: h });
  assert.equal(rt.code, 0, rt.out + rt.err);
  assert.ok(srv.requests.slice(before).every((b: any) => /\(item b\)/.test(JSON.stringify(b.messages))), 'only the failed item ran again');
  const st = await runCli([...base(srv, ws), 'batch', 'status', task], { HOME: h });
  assert.match(st.out, /2 done/);
  assert.equal((await runCli([...base(srv, ws), 'batch', 'cancel', task], { HOME: h })).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.tugline', 'batch', `${task}.json`), 'utf8')).state, 'cancelled');
  assert.equal((await runCli([...base(srv, ws), 'batch', 'clean', task], { HOME: h })).code, 0);
  assert.ok(!fs.existsSync(path.join(h, '.tugline', 'batch', `${task}.json`)));
  const badPlan = path.join(ws, 'bad.json');
  fs.writeFileSync(badPlan, JSON.stringify({ prompt: 'x', items: [{ id: '../x', source: '../../etc/passwd', target: '/tmp/x' }] }));
  const bad = await runCli([...base(srv, ws), 'batch', 'run', 'bad.json'], { HOME: h });
  assert.match(bad.out + bad.err, /invalid batch plan[\s\S]*id must be[\s\S]*source must be a path inside the workspace[\s\S]*target must be a path inside the workspace/);
});

test('N49 RF13: `tug memory` lists records and imports Codex memories only by explicit selection (preview otherwise; secrets refused)', { timeout: 60_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  const src = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-codexmem-')));
  fs.writeFileSync(path.join(src, 'MEMORY.md'), '# Build\n- run `make test` before committing\n- the API lives in api/\n\n# Secrets\n- token sk-abcdefghijklmnopqrstuvwx1234\n');
  const prev = await runCli(['--cwd', ws, 'memory', 'import', 'codex', '--source', src], { HOME: h });
  assert.equal(prev.code, 0, prev.err);
  assert.match(prev.out, /3 item\(s\) .*preview; nothing is written/);
  assert.match(prev.out, /1\. \[MEMORY\.md › Build\] run `make test` before committing/);
  assert.ok(!fs.existsSync(path.join(h, '.tugline', 'MEMORY.md')), 'a preview writes nothing');
  const imp = await runCli(['--cwd', ws, 'memory', 'import', 'codex', '--source', src, '--select', '1,3'], { HOME: h });
  assert.equal(imp.code, 1, 'item 3 was refused');
  assert.match(imp.out, /imported 1 item\(s\)[\s\S]*3: memory text looks like it contains a credential/);
  const list = await runCli(['--cwd', ws, 'memory', 'list'], { HOME: h });
  assert.match(list.out, /\[fact\] .*: run `make test` before committing/);
});

test('N49 RF17: wrong flag values print the message without a stack trace (exit 2); `tug sessions` with none says so', { timeout: 60_000 }, async () => {
  const ws = tmpWorkspace({});
  const h = home();
  for (const flags of [['--output-format', 'xml'], ['--effort', 'extreme'], ['--theme', 'nope']]) {
    const r = await runCli(['--cwd', ws, '-p', 'hi', ...flags], { HOME: h });
    assert.equal(r.code, 2, `${flags}: ${r.err}`);
    assert.match(r.err, /^error: --\w[\w-]* must be/m);
    assert.ok(!/\n\s+at /.test(r.err), `no stack trace for ${flags}: ${r.err}`);
  }
  const s = await runCli(['--cwd', ws, 'sessions'], { HOME: h });
  assert.match(s.out, /no saved sessions for /);
});

test('N49 RF15: headless output (text, json, stream-json, including streamed chunks and tool events) goes through the journal\'s redaction', { timeout: 120_000 }, async () => {
  const KEY = 'sk-rf15CANARY0123456789abcdef';
  const ws = tmpWorkspace({ 'creds.txt': `key=${KEY}\n` });
  const h = home();
  const ajv = new (Ajv2020 as any)({ strict: false });
  const published = JSON.parse(fs.readFileSync('docs/schemas/headless-output.schema.json', 'utf8'));
  ajv.compile(published);
  const validateLine = ajv.getSchema(`${published.$id}#/$defs/line`);
  for (const fmt of ['text', 'json', 'stream-json']) {
    const srv = await mock((b: any) => {
      const tools = b.messages.filter((m: any) => m.role === 'tool').length;
      if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'cat creds.txt' } }] };
      return { content: `here is the key ${KEY} done` };
    });
    const r = await runCli([...base(srv, ws), '-p', 'show it', '--output-format', fmt, '--mode', 'auto'], { HOME: h, TUG_API_KEY: KEY });
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(KEY), `${fmt} stdout leaks the key:\n${r.out.slice(0, 600)}`);
    assert.ok(!r.err.includes(KEY), `${fmt} stderr leaks the key`);
    assert.match(r.out, /\[REDACTED\]/, `${fmt}: redacted, not dropped`);
    if (fmt === 'stream-json') for (const l of r.out.trim().split('\n').map((x) => JSON.parse(x))) assert.ok(validateLine(l), JSON.stringify(l).slice(0, 200));
    if (fmt === 'stream-json') assert.match(r.out, /"type":"text_delta"/, 'text is still streamed');
  }
});
