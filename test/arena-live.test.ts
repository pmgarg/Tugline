/**
 * v1.2 N47: arena parity+ — parallel contestants in worktrees, live tagged streams, external agents as
 * contestants, per-contestant budget/sandbox/protected paths, pick + apply through the D2 ask path, bench feed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockServer, testConfig, tmpWorkspace, trackTmp, type MockServer } from './helpers.js';
import { applyArenaWinner, ARENA_MAX_CONTESTANTS, runArena, type ArenaControl, type ArenaStreamEvent } from '../src/core/eval/arena.js';
import { StreamPrinter, arenaCli } from '../src/core/eval/arenaCommands.js';
import { loadRecords, summarizeArms } from '../src/core/eval/compare.js';
import { registerCommandWrapper, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { getSlashCommand } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import '../src/core/eval/commands.js';

const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function repo(): string {
  const ws = tmpWorkspace({ 'mathx.py': 'def add(a, b):\n    return a - b\n', 'tests/test_x.py': 'import mathx\n', 'README.md': '# m\n' });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-qm', 'base');
  return ws;
}

const CHECK = 'python3 -c "import mathx; assert mathx.add(2, 3) == 5"';
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** model "good" fixes add(), "meh" writes a note, "slow" fixes it too but slowly; all read first. */
function arenaModel(delay = 0) {
  return (body: any) => {
    const tools = body.messages.filter((m: any) => m.role === 'tool').length;
    if (delay) sleep(delay);
    if (body.model === 'good' || body.model === 'slow') {
      if (body.model === 'slow') sleep(150);
      if (tools === 0) return { content: 'Reading.\n', toolCalls: [{ name: 'read_file', arguments: { path: 'mathx.py' } }] };
      if (tools === 1) return { toolCalls: [{ name: 'edit_file', arguments: { path: 'mathx.py', old_string: 'return a - b', new_string: 'return a + b' } }] };
      return { content: `fixed by ${body.model}` };
    }
    if (body.model === 'meh') {
      if (tools === 0) return { toolCalls: [{ name: 'write_file', arguments: { path: 'NOTE.md', content: 'not sure\n' } }] };
      return { content: 'wrote a note' };
    }
    if (body.model === 'greedy') return { content: `step ${tools}`, toolCalls: [{ name: 'bash', arguments: { command: `echo greedy-step-${tools}` } }] }; // never stops
    if (body.model === 'sleeper') {
      if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 3 && echo survived-the-other-contestant' } }] };
      return { content: 'slept' };
    }
    if (body.model === 'quick') {
      // ends (run end: the stray-process sweep) while the sleeper's command is still running
      if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 1 && echo quick' } }] };
      return { content: 'nothing to do' };
    }
    if (body.model === 'sneaky') {
      // reads first, so only the protected-path rule (not read-before-write) can refuse the write (review F10)
      if (tools === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'tests/test_x.py' } }] };
      if (tools === 1) return { toolCalls: [{ name: 'write_file', arguments: { path: 'tests/test_x.py', content: 'pass\n' } }] };
      if (tools === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo contestant-cmd' } }] };
      return { content: 'done' };
    }
    return { content: 'ok' };
  };
}

async function mock(delay = 0): Promise<MockServer> {
  const s = await startMockServer(arenaModel(delay));
  servers.push(s);
  return s;
}

test('N47 AC1: 3 mock models run in parallel worktrees; streams are tagged and interleaved; the winner\'s diff is applied; the others are cleaned up', { timeout: 180_000 }, async () => {
  const ws = repo();
  const m = await mock(40);
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, worktree: { verifyBeforeMerge: false } });
  const stream: { label: string; e: ArenaStreamEvent; t: number }[] = [];
  const r = await runArena({ config, workspace: ws, models: ['good', 'meh', 'slow'], prompt: 'Fix add() in mathx.py', check: CHECK, mode: 'yolo', onEvent: (label, e) => stream.push({ label, e, t: Date.now() }) });
  // tagged: every event belongs to a known contestant, each contestant's stream is complete and in order
  for (const label of ['A', 'B', 'C']) {
    const own = stream.filter((x) => x.label === label).map((x) => x.e);
    assert.equal(own[0].type, 'arena_status');
    assert.equal((own[0] as any).state, 'running');
    assert.equal(own[own.length - 1].type, 'arena_status');
    assert.equal((own[own.length - 1] as any).state, 'done');
    const runEnd = own.findIndex((e) => e.type === 'run_end');
    assert.ok(runEnd > 0 && own.slice(0, runEnd).some((e) => e.type === 'tool_start'), `${label}: tools before run_end`);
  }
  // parallel: B and C started before A finished (their streams interleave with A's)
  const aDone = stream.findIndex((x) => x.label === 'A' && x.e.type === 'arena_status' && (x.e as any).state === 'done');
  const bStart = stream.findIndex((x) => x.label === 'B' && x.e.type === 'arena_status' && (x.e as any).state === 'running');
  const cStart = stream.findIndex((x) => x.label === 'C' && x.e.type === 'arena_status' && (x.e as any).state === 'running');
  assert.ok(bStart < aDone && cStart < aDone, 'contestants ran at the same time');
  const firstA = stream.findIndex((x) => x.label === 'A');
  assert.ok(stream.slice(firstA, aDone).some((x) => x.label !== 'A'), 'streams interleave');
  // the text deltas of one contestant are printed as whole lines, never mixed mid-line
  const lines: string[] = [];
  const pr = new StreamPrinter((l) => lines.push(l), { A: 'good', B: 'meh' });
  pr.event('A', { type: 'text_delta', text: 'hel' } as any);
  pr.event('B', { type: 'text_delta', text: 'other line\n' } as any);
  pr.event('A', { type: 'text_delta', text: 'lo world\n' } as any);
  assert.deepEqual(lines, ['[B meh] other line', '[A good] hello world']);
  const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
  assert.equal(by.good.outcome, 'pass');
  assert.equal(by.slow.outcome, 'pass');
  assert.equal(by.meh.outcome, 'fail');
  assert.equal(r.ranking[r.ranking.length - 1].model, 'meh');
  // no worktree left while waiting for the pick; branches remain
  assert.equal(git(ws, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(git(ws, 'branch', '--list', 'oh/arena-*').trim().split('\n').length, 3);
  // the user picks B? no: picks A (good). Applied through the board merge; others' branches deleted
  const res = await applyArenaWinner({ config, workspace: ws, run: r, pick: 'A' });
  assert.equal(res.merged, true, res.message);
  assert.equal(fs.readFileSync(path.join(ws, 'mathx.py'), 'utf8'), 'def add(a, b):\n    return a + b\n');
  assert.ok(!fs.existsSync(path.join(ws, 'NOTE.md')), 'losers are not applied');
  assert.equal(git(ws, 'branch', '--list', 'oh/*').trim(), '', 'every arena branch cleaned up');
  assert.equal(git(ws, 'worktree', 'list').trim().split('\n').length, 1);
  // results feed `tug bench --compare`: one arm per contestant, Wilson intervals
  const { arms } = summarizeArms({ records: loadRecords([r.outDir!]) });
  const armNames = arms.map((a) => a.arm).sort();
  assert.deepEqual(armNames, ['model:good', 'model:meh', 'model:slow']);
  const good = arms.find((a) => a.arm === 'model:good')!;
  assert.equal(good.resolved, 1);
  assert.ok(Array.isArray(good.resolvedCi) && good.resolvedCi.length === 2);
});

/**
 * A stand-in `cline` binary speaking the preset's command lines: `auth -b <url>` records the endpoint (the
 * arena's metering proxy) in the --config dir; a run calls that endpoint once, prints progress and edits the file.
 */
/** RC2: outside /tmp (bwrap mounts a fresh /tmp), with a marker file it tries to write outside the workspace on every invocation. */
function fakeCline(outside = path.join(os.homedir(), `.oh-rc2-outside-${process.pid}`)): string {
  const bin = trackTmp(fs.mkdtempSync(path.join(os.homedir(), '.oh-test-fakecline-')));
  const js = path.join(bin, 'cline.mjs');
  fs.writeFileSync(
    js,
    `import fs from 'node:fs';
const a = process.argv.slice(2);
try { fs.appendFileSync(${JSON.stringify(outside)}, (a[0] === '--version' ? 'version' : a[0] === 'auth' ? 'setup' : 'main') + '\\n'); } catch {}
const get = (f) => (a.indexOf(f) >= 0 ? a[a.indexOf(f) + 1] : undefined);
if (a[0] === '--version') { console.log('3.0.74-fake'); process.exit(0); }
const conf = get('--config');
if (a[0] === 'auth') { fs.mkdirSync(conf, { recursive: true }); fs.writeFileSync(conf + '/base.txt', get('-b')); process.exit(0); }
const base = fs.readFileSync(conf + '/base.txt', 'utf8');
await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + get('-k') }, body: JSON.stringify({ model: get('-m'), messages: [{ role: 'user', content: a[a.length - 1] }] }) });
console.log('cline: planning the fix');
fs.writeFileSync(get('-c') + '/mathx.py', 'def add(a, b):\\n    return a + b\\n');
console.log('cline: edited mathx.py');
`,
  );
  fs.writeFileSync(path.join(bin, 'cline'), `#!/bin/sh\nexec node ${js} "$@"\n`, { mode: 0o755 });
  return bin;
}

test('N47 AC2: an external agent (Cline preset) is an arena contestant, sandboxed and metered', { timeout: 180_000 }, async () => {
  const ws = repo();
  const m = await mock();
  // RC2: an external agent runs only inside the OS sandbox (bwrap here); without one, only with the user's opt-in
  const { runnerAvailable } = await import('../src/core/sandbox/index.js');
  const bwrap = runnerAvailable('bwrap');
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, ...(bwrap ? { shell: { sandbox: 'bwrap', requireSandbox: true } } : {}) });
  if (!bwrap) fs.writeFileSync(path.join(config.homeDir, 'config.json'), JSON.stringify({ external: { allowUnsandboxed: true } }));
  const bin = fakeCline();
  const wrapped: string[] = [];
  registerCommandWrapper('test-n47-ac2', () => (spec) => (wrapped.push(`${spec.file} ${spec.args.join(' ')}`), spec));
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const events: string[] = [];
    const r = await runArena({ config, workspace: ws, models: ['meh'], agents: ['cline'], prompt: 'Fix add() in mathx.py', check: CHECK, mode: 'yolo', onEvent: (l, e) => e.type === 'text_delta' && events.push(`${l}:${e.text}`) });
    const cline = r.entries.find((e) => e.kind === 'agent')!;
    assert.equal(cline.model, 'cline');
    assert.equal(cline.label, 'B');
    assert.equal(cline.outcome, 'pass', cline.error ?? cline.finalText);
    assert.ok(cline.branch?.startsWith('oh/arena-'));
    assert.ok(events.some((x) => x.startsWith('B:') && /edited mathx\.py/.test(x)), 'the external agent\'s output streams live');
    // the external agent process ran under the command wrappers (our sandbox seam), unlike Cline's own runs
    assert.ok(wrapped.some((w) => /\/bin\/bash -c [\s\S]*cline --json --auto-approve true/.test(w)), wrapped.join('\n'));
    if (bwrap) assert.ok(wrapped.some((w) => /^bwrap --ro-bind \/ \/ [\s\S]*cline --json --auto-approve true/.test(w)), 'in the filesystem sandbox');
    assert.equal(r.ranking[0].model, 'cline');
    // and it can win: applied like any contestant
    const res = await applyArenaWinner({ config: { ...config, worktree: { verifyBeforeMerge: false } } as any, workspace: ws, run: r, pick: 'cline' });
    assert.equal(res.merged, true, res.message);
    assert.match(fs.readFileSync(path.join(ws, 'mathx.py'), 'utf8'), /a \+ b/);
  } finally {
    process.env.PATH = oldPath;
    unregisterCommandWrapper('test-n47-ac2');
  }
});

test('N47 SAC1: each contestant has its own budget, sandbox and protected paths', { timeout: 180_000 }, async () => {
  const ws = repo();
  const m = await mock();
  // review F10: the OS sandbox actually on (bwrap where it is available), so the test sees the contestant's sandbox
  const { runnerAvailable } = await import('../src/core/sandbox/index.js');
  const bwrap = runnerAvailable('bwrap');
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, permissions: { protectedPaths: ['tests/**'] }, ...(bwrap ? { shell: { sandbox: 'bwrap', requireSandbox: true } } : {}) });
  const wrapped: string[] = [];
  registerCommandWrapper('test-n47-sac1', () => (spec) => (wrapped.push(`${path.basename(spec.file)} ${spec.args.join(' ')}`), spec));
  try {
    // the worst-case size of one call (admission reserves it): measured, so the test does not depend on the tool set
    const probe = await runArena({ config, workspace: ws, models: ['good', 'meh'], prompt: 'Fix add() in mathx.py', mode: 'yolo', budget: { maxTokens: 1 }, discard: true });
    const perCall = Number(/up to (\d+) tokens/.exec(probe.entries[0].finalText)?.[1]);
    assert.ok(perCall > 0, probe.entries[0].finalText);
    // greedy never stops: it exhausts ITS budget; good finishes within its own (a shared budget would starve it)
    const cap = perCall + 1100;
    const r = await runArena({ config, workspace: ws, models: ['greedy', 'good', 'sneaky'], prompt: 'Fix add() in mathx.py', check: CHECK, mode: 'yolo', budget: { maxTokens: cap } });
    const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
    assert.equal(by.greedy.stopReason, 'budget', `greedy: ${by.greedy.stopReason}`);
    assert.equal(by.good.stopReason, 'end_turn');
    assert.equal(by.good.outcome, 'pass');
    assert.ok(by.greedy.tokens <= cap, `greedy stopped at its own cap (${by.greedy.tokens} of ${cap})`);
    assert.ok(by.greedy.tokens + by.good.tokens > cap || by.good.tokens > 0, 'each contestant spent from its own budget');
    // protected path: sneaky's write to tests/ was refused in its worktree; its command ran under the wrapper
    assert.ok(!by.sneaky.diff.includes('tests/test_x.py'), 'protected test file untouched');
    const sneakyLast = m.requests.filter((b: any) => b.model === 'sneaky').map((b: any) => b.messages.filter((x: any) => x.role === 'tool').map((x: any) => String(x.content))).sort((a: string[], b: string[]) => b.length - a.length)[0] ?? [];
    assert.match(sneakyLast[1] ?? '', /protected pattern 'tests\/\*\*'/, `the write (after a read) was refused as a protected path: ${sneakyLast.join(' | ').slice(0, 400)}`);
    assert.ok(wrapped.some((w) => /echo contestant-cmd/.test(w)), 'contestant command wrapped (sandbox seam)');
    if (bwrap) assert.ok(wrapped.some((w) => /^bwrap --ro-bind \/ \/ [\s\S]*echo contestant-cmd/.test(w)), `the contestant's command ran in the OS sandbox: ${wrapped.filter((w) => /contestant-cmd/.test(w)).join('\n').slice(0, 300)}`);
    assert.ok(wrapped.some((w) => /import mathx/.test(w)), 'the harness check ran wrapped too');
  } finally {
    unregisterCommandWrapper('test-n47-sac1');
  }
});

test('N47 SAC1: a contestant that finishes never kills another contestant\'s running command (R1 stray-process sweep is per workspace)', { timeout: 120_000 }, async () => {
  const ws = repo();
  const m = await mock();
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
  const r = await runArena({ config, workspace: ws, models: ['sleeper', 'quick'], prompt: 'Wait for it', mode: 'yolo', discard: true });
  assert.equal(r.entries.length, 2);
  const results = m.requests.filter((b) => b.model === 'sleeper').flatMap((b) => b.messages.filter((x: any) => x.role === 'tool').map((x: any) => String(x.content)));
  assert.ok(results.some((t) => /survived-the-other-contestant/.test(t) && /exit code 0/.test(t)), `the sleeper's command was killed when "quick" ended:\n${results.join('\n')}`);
});

test('N47 SAC2: applying the winner goes through the D2 ask path (permission engine), never around it', { timeout: 180_000 }, async () => {
  const ws = repo();
  const m = await mock();
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, worktree: { verifyBeforeMerge: false } });
  const r = await runArena({ config, workspace: ws, models: ['good', 'meh'], prompt: 'Fix add() in mathx.py', check: CHECK, mode: 'yolo' });
  const head = git(ws, 'rev-parse', 'HEAD').trim();
  // ask mode, nobody to ask → refused
  const askCfg = { ...config, permissionMode: 'ask' as const };
  const r1 = await applyArenaWinner({ config: askCfg, workspace: ws, run: r, pick: 'A' });
  assert.equal(r1.merged, false);
  assert.equal(r1.reason, 'denied');
  // the human says no → refused; the prompt is the merge command, asked by the permission engine
  const asked: any[] = [];
  const r2 = await applyArenaWinner({ config: askCfg, workspace: ws, run: r, pick: 'A', ui: { requestPermission: async (req) => (asked.push(req), { decision: 'deny' }) } });
  assert.equal(r2.merged, false);
  assert.equal(asked[0].tool, 'worktree_merge');
  assert.match(asked[0].detail, /^git merge --no-ff oh\/arena-/);
  // a deny rule on git merge wins even in auto mode
  const denyCfg = { ...config, permissions: { ...config.permissions, deny: ['Bash(git merge*)'] } };
  const r3 = await applyArenaWinner({ config: denyCfg, workspace: ws, run: r, pick: 'A' });
  assert.equal(r3.merged, false);
  assert.equal(r3.reason, 'denied');
  assert.equal(git(ws, 'rev-parse', 'HEAD').trim(), head, 'nothing landed');
  // the human approves → applied
  const r4 = await applyArenaWinner({ config: askCfg, workspace: ws, run: r, pick: 'A', ui: { requestPermission: async () => ({ decision: 'allow' }) } });
  assert.equal(r4.merged, true, r4.message);
});

test('N47: limits and control: duplicates, too many contestants, unknown agents refused; steer, stop and status; pick later from the CLI', { timeout: 180_000 }, async () => {
  const ws = repo();
  const m = await mock();
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, worktree: { verifyBeforeMerge: false } });
  await assert.rejects(runArena({ config, workspace: ws, models: ['good', 'good'], prompt: 'x' }), /listed twice/);
  await assert.rejects(runArena({ config, workspace: ws, models: Array.from({ length: ARENA_MAX_CONTESTANTS + 1 }, (_, i) => `m${i}`), prompt: 'x' }), /at most 8/);
  await assert.rejects(runArena({ config, workspace: ws, models: ['good'], agents: ['nosuchagent'], prompt: 'x' }), /unknown external agent|nosuchagent/);
  // control: stop the greedy contestant while good finishes
  const control: ArenaControl = {};
  const p = runArena({ config, workspace: ws, models: ['greedy', 'good'], prompt: 'Fix add() in mathx.py', check: CHECK, mode: 'yolo', control });
  await new Promise((res) => setTimeout(res, 400));
  const st = control.status!();
  assert.deepEqual(st.map((x) => x.label), ['A', 'B']);
  assert.equal(control.steer!('A', 'please stop looping'), true);
  control.stop!('A');
  const r = await p;
  assert.equal(r.entries[0].stopReason, 'aborted');
  assert.equal(r.entries[1].outcome, 'pass');
  // pick later from the CLI by run id
  const out: string[] = [];
  const code = await arenaCli(['pick', r.run!, 'B', '--yes'], { config, workspace: ws, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join('\n'));
  assert.match(fs.readFileSync(path.join(ws, 'mathx.py'), 'utf8'), /a \+ b/);
  assert.ok(getSlashCommand('arena'), '/arena registered for chat surfaces');
});

test('N47: an arena started from a chat carries the conversation to every contestant (Qwen chatHistory)', { timeout: 120_000 }, async () => {
  const ws = repo();
  const m = await mock();
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
  const history = [{ role: 'user' as const, content: 'Earlier: the tests live in tests/.' }, { role: 'assistant' as const, content: 'Noted.' }];
  await runArena({ config, workspace: ws, models: ['meh', 'good'], prompt: 'Fix add() in mathx.py', mode: 'yolo', history, discard: true });
  const firsts = m.requests.filter((b) => b.messages.filter((x: any) => x.role === 'tool').length === 0);
  assert.ok(firsts.length >= 2);
  for (const b of firsts) assert.ok(b.messages.some((x: any) => x.role === 'user' && String(x.content).includes('Earlier: the tests live in tests/.')), 'history given to each contestant');
});

test('N47 RF5: the judge check is planned and fingerprinted in the base tree: a contestant that rewrites the test script is "altered" and ranks last; an honest fix passes', { timeout: 180_000 }, async () => {
  const PKG = '{"name":"m","version":"1.0.0","scripts":{"test":"node test.js"}}\n';
  const ws = tmpWorkspace({ 'package.json': PKG, 'math.js': 'exports.add = (a, b) => a - b;\n', 'test.js': "const m = require('./math'); if (m.add(2, 3) !== 5) { console.error('add is wrong'); process.exit(1); }\n" });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-qm', 'base');
  const s = await startMockServer((b: any) => {
    const tools = b.messages.filter((m: any) => m.role === 'tool').length;
    if (b.model === 'cheat') return tools === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'package.json' } }] } : tools === 1 ? { toolCalls: [{ name: 'edit_file', arguments: { path: 'package.json', old_string: '"test":"node test.js"', new_string: '"test":"node -e 0"' } }] } : { content: 'all tests pass now' };
    if (b.model === 'honest') return tools === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'math.js' } }] } : tools === 1 ? { toolCalls: [{ name: 'edit_file', arguments: { path: 'math.js', old_string: 'a - b', new_string: 'a + b' } }] } : { content: 'fixed' };
    if (b.model === 'newtest') return tools === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'test2.js', content: "require('./math');\n" } }] } : { content: 'added a test' };
    return { content: 'done' };
  });
  servers.push(s);
  const config = testConfig(s.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
  for (const check of [undefined, 'npm test']) {
    const r = await runArena({ config, workspace: ws, models: ['cheat', 'honest', 'newtest'], prompt: 'Fix add() so the tests pass', mode: 'yolo', discard: true, check });
    const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
    assert.equal(by.cheat.outcome, 'altered', `${check}: ${by.cheat.checkNote}`);
    assert.match(by.cheat.checkNote ?? '', /changed the check's own inputs \(package\.json/);
    assert.equal(by.honest.outcome, 'pass', `${check}: ${by.honest.checkNote} ${by.honest.checkOutput}`);
    assert.equal(by.newtest.outcome, 'fail', 'a new test file is not "altering" the check (the bug is still there)');
    assert.deepEqual(r.ranking.map((e) => e.model), ['honest', 'newtest', 'cheat']);
  }
});

test('N47 RF19: the N35 goal-verifier stage runs per contestant after the harness check (mock verifier); an unmet goal ranks lower; a registered verifier is used by default', { timeout: 180_000 }, async () => {
  const { setArenaGoalVerifier, N35_GOAL_VERIFIER } = await import('../src/core/eval/arena.js');
  const ws = repo();
  const m = await mock();
  const config = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
  const seen: any[] = [];
  const verifier = {
    async verify(o: any) {
      seen.push(o);
      return /return a \+ b/.test(o.diff) ? { verdict: 'met' as const, reason: 'add() fixed' } : { verdict: 'unmet' as const, reason: 'add() still wrong' };
    },
  };
  // both 'good' and 'meh' are unchecked without a check command: the verifier decides between them
  const r = await runArena({ config, workspace: ws, models: ['meh', 'good'], prompt: 'Fix add() in mathx.py', mode: 'yolo', discard: true, goalVerifier: verifier });
  const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
  assert.equal(by.good.goal?.verdict, 'met');
  assert.equal(by.meh.goal?.verdict, 'unmet');
  assert.deepEqual(r.ranking.map((e) => e.model), ['good', 'meh']);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.check && typeof s.check.outcome === 'string' && s.prompt === 'Fix add() in mathx.py'), 'it runs after the harness check, with its result');
  assert.match(r.report, /goal met/);
  setArenaGoalVerifier({ verify: async () => ({ verdict: 'unknown', reason: 'registered' }) });
  try {
    const r2 = await runArena({ config, workspace: ws, models: ['good', 'meh'], prompt: 'Fix add() in mathx.py', mode: 'yolo', discard: true, verifyGoal: true });
    assert.ok(r2.entries.every((e) => e.goal?.reason === 'registered'), 'the registered verifier runs with verifyGoal');
  } finally {
    setArenaGoalVerifier(N35_GOAL_VERIFIER);
  }
});

test('N47 RC0 (F19 wired): `--verify-goal` runs WS17\'s N35 goal verifier per contestant (a read-only session that must cite the lines showing the goal met)', { timeout: 180_000 }, async () => {
  const ws = repo();
  const base = arenaModel();
  let verifierCalls = 0;
  const s = await startMockServer((body: any) => {
    const sys = String(body.messages.find((m: any) => m.role === 'system')?.content ?? '');
    if (/independent goal verifier/.test(sys)) {
      verifierCalls++;
      const user = body.messages.filter((m: any) => m.role === 'user').map((m: any) => String(m.content)).join('\n');
      return /\+\s+return a \+ b/.test(user)
        ? { content: JSON.stringify({ met: true, reasons: [], evidence: [{ file: 'mathx.py', line: 2, quote: 'return a + b' }] }) }
        : { content: JSON.stringify({ met: false, reasons: ['add() still subtracts'], evidence: [] }) };
    }
    return base(body);
  });
  servers.push(s);
  const config = testConfig(s.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
  const r = await runArena({ config, workspace: ws, models: ['meh', 'good'], prompt: 'Fix add() in mathx.py', mode: 'yolo', discard: true, verifyGoal: true });
  const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
  assert.equal(by.good.goal?.verdict, 'met', JSON.stringify(by.good.goal));
  assert.match(by.good.goal?.reason ?? '', /mathx\.py:2/);
  assert.equal(by.meh.goal?.verdict, 'unmet', JSON.stringify(by.meh.goal));
  assert.equal(verifierCalls >= 2, true);
  // without --verify-goal no verifier session runs
  const before = verifierCalls;
  await runArena({ config, workspace: ws, models: ['meh', 'good'], prompt: 'Fix add() in mathx.py', mode: 'yolo', discard: true });
  assert.equal(verifierCalls, before);
});

test('N47 RC2: external contestants pass the shared gate: refused under managed disableAutoMode and without an OS sandbox (unless the user opts in); version, setup and run all happen inside the sandbox', { timeout: 240_000 }, async () => {
  const { runnerAvailable } = await import('../src/core/sandbox/index.js');
  const ws = repo();
  const m = await mock();
  const outside = path.join(os.homedir(), `.oh-rc2-arena-${process.pid}`);
  fs.rmSync(outside, { force: true });
  const bin = fakeCline(outside);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const run = (config: any) => runArena({ config, workspace: ws, models: ['meh'], agents: ['cline'], prompt: 'Fix add() in mathx.py', mode: 'yolo', discard: true });
    // managed policy: refused, nothing ran
    const managed = { ...testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } }), managed: { policy: { disableAutoMode: true } } } as any;
    await assert.rejects(run(managed), /arena mode "yolo" is forbidden/);
    const managedAccept = { ...managed, permissionMode: 'acceptEdits' };
    const r1 = await runArena({ config: managedAccept, workspace: ws, models: ['meh'], agents: ['cline'], prompt: 'x', mode: 'acceptEdits', discard: true });
    assert.match(r1.entries.find((e) => e.kind === 'agent')!.error ?? '', /managed policy forbids \(disableAutoMode\)/);
    // no sandbox: refused …
    const none = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' } });
    const r2 = await run(none);
    assert.match(r2.entries.find((e) => e.kind === 'agent')!.error ?? '', /only runs inside the OS sandbox, and shell\.sandbox is "none"/);
    assert.ok(!fs.existsSync(outside), 'refused before any of its commands ran');
    // … unless the user opts in (user config)
    fs.writeFileSync(path.join(none.homeDir, 'config.json'), JSON.stringify({ external: { allowUnsandboxed: true } }));
    const r3 = await run(none);
    assert.equal(r3.entries.find((e) => e.kind === 'agent')!.error, undefined);
    fs.rmSync(outside, { force: true });
    // sandboxed: version, setup and the run itself cannot write outside the workspace; the model is still reached
    if (runnerAvailable('bwrap')) {
      const before = m.requests.length;
      const sb = testConfig(m.url, { permissionMode: 'yolo', agent: { harnessCheck: 'off' }, shell: { sandbox: 'bwrap', requireSandbox: true } });
      const r4 = await run(sb);
      const e = r4.entries.find((x) => x.kind === 'agent')!;
      assert.equal(e.error, undefined, e.finalText);
      assert.ok(e.diff.includes('mathx.py'), 'it worked in its worktree');
      assert.ok(m.requests.length > before, 'its model call reached the endpoint through the bridge and the metering proxy');
      assert.ok(!fs.existsSync(outside), `nothing outside the workspace was written (version/setup/run): ${fs.existsSync(outside) ? fs.readFileSync(outside, 'utf8') : ''}`);
    }
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(outside, { force: true });
  }
});
