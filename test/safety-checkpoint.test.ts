/** SPEC C1: checkpoints (shadow git + content-addressed fallback). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand } from '../src/core/commands.js';
import { CheckpointManager, checkpointsFor, DEFAULT_CHECKPOINTS } from '../src/core/checkpoint/index.js';
import type { AgentEvent, ChatMessage } from '../src/core/types.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const read = (ws: string, f: string) => fs.readFileSync(path.join(ws, f), 'utf8');

/**
 * In-place edit by a shell command. `sed -i 's/…/' f` is GNU-only (BSD sed on
 * macOS takes the next argument as a backup suffix, so the file was silently
 * left unchanged, R7); `perl -pi -e` behaves the same on Linux, macOS and Git Bash.
 */
const INPLACE = "perl -pi -e 's/beta/BETA-SED/' b.txt";

/** turn 1: read+edit a.txt; turn 2: in-place shell edit of b.txt; turn 3: create c.txt; turn 4: answer. */
async function editingRun(ws: string, over: any = {}) {
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }, { name: 'edit_file', arguments: { path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA-EDITED' } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: INPLACE } }] };
    if (i === 2) return { toolCalls: [{ name: 'write_file', arguments: { path: 'c.txt', content: 'created later\n' } }] };
    return { content: 'done' };
  });
  const events: AgentEvent[] = [];
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: false }, ...over });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { onEvent: (e) => events.push(e) } });
  const res = await agent.run('make the edits');
  await srv.close();
  return { agent, cfg, events, res };
}

function slash(name: string, agent: Agent, args: string): Promise<string> {
  let out = '';
  return Promise.resolve(getSlashCommand(name)!.run(args, { agent, config: agent.config, workspace: agent.workspace, write: (t) => (out += t + '\n'), surface: 'cli' })).then(() => out);
}

for (const backend of ['git', 'copy'] as const) {
  test(`C1 AC1+AC4 (${backend}): rewind 3 turns restores edit_file and bash in-place (sed -i style) changes in a non-git workspace`, async () => {
    const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
    assert.equal(fs.existsSync(path.join(ws, '.git')), false, 'workspace is not a git repo');
    const { agent, events, res } = await editingRun(ws, { checkpoints: { backend } });
    assert.equal(res.stopReason, 'end_turn');
    assert.equal(read(ws, 'a.txt'), 'ALPHA-EDITED\n');
    assert.equal(read(ws, 'b.txt'), 'BETA-SED\n');
    assert.equal(read(ws, 'c.txt'), 'created later\n');
    const cps = events.filter((e) => e.type === 'checkpoint');
    assert.ok(cps.length >= 4, `checkpoint events emitted (${cps.length})`);
    const out = await slash('rewind', agent, '3 files');
    assert.match(out, /rewound to/);
    assert.equal(read(ws, 'a.txt'), 'alpha\n', 'edit_file change reverted');
    assert.equal(read(ws, 'b.txt'), 'beta\n', 'bash in-place change reverted');
    assert.equal(fs.existsSync(path.join(ws, 'c.txt')), false, 'file created later removed');
    // the rewind itself is undoable
    const undoId = out.match(/\/rewind ([0-9a-f]+)/)![1];
    await slash('rewind', agent, `${undoId} files`);
    assert.equal(read(ws, 'a.txt'), 'ALPHA-EDITED\n');
    assert.equal(read(ws, 'c.txt'), 'created later\n');
  });
}

test('C1 AC1: a checkpoint is taken before each bash command (mid-turn rewind point)', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  // one turn: edit, then a shell command; the turn checkpoint alone could not separate them
  const srv = await startMockServer((_b, i) =>
    i === 0
      ? { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }, { name: 'edit_file', arguments: { path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA-EDITED' } }, { name: 'bash', arguments: { command: INPLACE } }] }
      : { content: 'done' },
  );
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: false } }), mcp: false });
  await agent.run('go');
  await srv.close();
  const m = checkpointsFor(agent.config, ws);
  const shell = (await m.list()).filter((c) => c.kind === 'shell');
  assert.equal(shell.length, 1);
  assert.match(shell[0].label, /perl -pi/);
  assert.equal(shell[0].files, 1);
  assert.equal(read(ws, 'b.txt'), 'BETA-SED\n', 'the shell command really changed the file');
  // that checkpoint already contains the edit_file change but not the in-place change
  await m.restore(shell[0].id, { files: true });
  assert.equal(read(ws, 'a.txt'), 'ALPHA-EDITED\n');
  assert.equal(read(ws, 'b.txt'), 'beta\n');
});

for (const backend of ['git', 'copy'] as const) {
  test(`C1 AC2 (${backend}): files created after the checkpoint are removed; ignored files are untouched`, async () => {
    const ws = tmpWorkspace({ 'src/x.ts': 'x1', '.gitignore': '*.log\nbuild/\n', 'keep.log': 'log v1', '.tuglineignore': 'private/\n', 'private/p.txt': 'p1' });
    const cfg = testConfig('http://127.0.0.1:9/v1', { checkpoints: { backend } });
    const m = new CheckpointManager(ws, cfg.homeDir, { ...DEFAULT_CHECKPOINTS, backend });
    const cp = (await m.snapshot({ label: 'base', kind: 'manual' }))!;
    fs.writeFileSync(path.join(ws, 'src/x.ts'), 'x2');
    fs.mkdirSync(path.join(ws, 'src/new/deep'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src/new/deep/n.ts'), 'new');
    fs.writeFileSync(path.join(ws, 'top-new.txt'), 'new');
    fs.writeFileSync(path.join(ws, 'keep.log'), 'log v2');
    fs.mkdirSync(path.join(ws, 'build'));
    fs.writeFileSync(path.join(ws, 'build/out.js'), 'built');
    fs.writeFileSync(path.join(ws, 'private/p.txt'), 'p2');
    const d = await m.diff(cp.id);
    assert.deepEqual(d.files.map((f) => `${f.status} ${f.path}`).sort(), ['A src/new/deep/n.ts', 'A top-new.txt', 'M src/x.ts']);
    const r = await m.restore(cp.id);
    assert.deepEqual(r.removed.sort(), ['src/new/deep/n.ts', 'top-new.txt']);
    assert.deepEqual(r.restored, ['src/x.ts']);
    assert.equal(read(ws, 'src/x.ts'), 'x1');
    assert.equal(fs.existsSync(path.join(ws, 'top-new.txt')), false);
    assert.equal(fs.existsSync(path.join(ws, 'src/new')), false, 'empty directories created later are removed');
    assert.equal(read(ws, 'keep.log'), 'log v2', '.gitignore-d file untouched');
    assert.equal(read(ws, 'build/out.js'), 'built', '.gitignore-d dir untouched');
    assert.equal(read(ws, 'private/p.txt'), 'p2', '.tuglineignore-d file untouched (and never copied into the store)');
  });
}

test('C1: files over checkpoints.maxFileMB are not snapshotted and survive a restore', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'a' });
  const cfg = testConfig('http://127.0.0.1:9/v1');
  const m = new CheckpointManager(ws, cfg.homeDir, { ...DEFAULT_CHECKPOINTS, maxFileMB: 0.001 });
  const cp = (await m.snapshot({ label: 'base', kind: 'manual' }))!;
  fs.writeFileSync(path.join(ws, 'big.bin'), Buffer.alloc(4096, 1));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'b');
  await m.snapshot({ label: 'second', kind: 'manual' });
  const r = await m.restore(cp.id);
  assert.deepEqual(r.restored, ['a.txt']);
  assert.ok(fs.existsSync(path.join(ws, 'big.bin')), 'oversized file left alone');
  assert.equal(execFileSync('git', ['--git-dir', path.join(m.storeDir, '.git'), 'cat-file', '-p', 'refs/heads/checkpoints:']).toString().includes('big.bin'), false);
});

/** Hash every file under .git plus the refs listing. */
function gitFingerprint(ws: string): { refs: string; files: string } {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const refs = execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)'], { cwd: ws, env }).toString() + execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws, env }).toString();
  const h = crypto.createHash('sha256');
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        h.update(path.relative(ws, p) + '\0');
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(path.join(ws, '.git'));
  return { refs, files: h.digest('hex') };
}

test("C1 AC3: the user's real .git (refs, index, every file) is never modified", async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n', '.gitignore': '*.log\n' });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q'], { cwd: ws, env });
  execFileSync('git', ['add', '-A'], { cwd: ws, env });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: ws, env });
  // a staged-but-uncommitted change makes the index distinctive
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha staged\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: ws, env });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'alpha\n');
  const before = gitFingerprint(ws);
  const { agent } = await editingRun(ws);
  await slash('rewind', agent, '3 both');
  await slash('checkpoints', agent, '');
  const after = gitFingerprint(ws);
  assert.equal(after.refs, before.refs, 'refs unchanged');
  assert.equal(after.files, before.files, '.git contents (index, objects, config, hooks) unchanged');
  assert.equal(read(ws, 'b.txt'), 'beta\n');
  // and the shadow repo lives under the harness home, not in the workspace
  const m = checkpointsFor(agent.config, ws);
  assert.ok(m.storeDir.startsWith(agent.config.homeDir));
  assert.equal(fs.statSync(m.storeDir).mode & 0o077, 0, 'store is private (0700)');
});

test('C1 AC5: restoring the conversation truncates history to a valid message sequence', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const { agent } = await editingRun(ws);
  const full = agent.messages.length;
  const m = checkpointsFor(agent.config, ws);
  const turns = await m.turns(agent.sessionId);
  const t2 = turns.find((c) => c.turn === 2)!;
  const out = await slash('rewind', agent, `${t2.id} chat`);
  assert.match(out, /conversation truncated to \d+ messages/);
  assert.equal(agent.messages.length, t2.messageIndex);
  assert.ok(agent.messages.length < full);
  const last = agent.messages.at(-1) as ChatMessage;
  assert.equal(last.role, 'tool', 'ends after the tool results of turn 1');
  // every assistant tool call still has its result
  const ids = new Set(agent.messages.filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
  for (const msg of agent.messages) for (const tc of msg.tool_calls ?? []) assert.ok(ids.has(tc.id));
  assert.equal(read(ws, 'a.txt'), 'ALPHA-EDITED\n', 'chat-only rewind leaves files');
  // rewinding to turn 1 also removes the prompt
  const t1 = turns.find((c) => c.turn === 1)!;
  await slash('rewind', agent, `${t1.id} chat`);
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.messages[0].role, 'system');
});

test('C1 AC6: a snapshot of a 5k-file repo takes < 2 s after the first (incremental)', async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5000; i++) files[`pkg${i % 50}/mod${Math.floor(i / 50)}/f${i}.ts`] = `export const v${i} = ${i};\n`;
  const ws = tmpWorkspace(files);
  const cfg = testConfig('http://127.0.0.1:9/v1');
  const m = new CheckpointManager(ws, cfg.homeDir, DEFAULT_CHECKPOINTS);
  const t0 = Date.now();
  const first = (await m.snapshot({ label: 'first', kind: 'turn' }))!;
  const firstMs = Date.now() - t0;
  assert.equal(first.files, 5000);
  for (const i of [1, 2500, 4999]) fs.writeFileSync(path.join(ws, `pkg${i % 50}/mod${Math.floor(i / 50)}/f${i}.ts`), 'changed\n');
  const t1 = Date.now();
  const second = (await m.snapshot({ label: 'second', kind: 'turn' }))!;
  const secondMs = Date.now() - t1;
  assert.equal(second.files, 3);
  assert.ok(secondMs < 2000, `incremental snapshot took ${secondMs} ms (first ${firstMs} ms)`);
  console.log(`# C1 AC6: first snapshot ${firstMs} ms, incremental ${secondMs} ms (5000 files)`);
});

test('C1: checkpoints can be turned off; home directory is refused', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const { events } = await editingRun(ws, { checkpoints: { enabled: false } });
  assert.equal(events.filter((e) => e.type === 'checkpoint').length, 0);
  const m = new CheckpointManager(process.env.HOME ?? '/root', '/nonexistent-home', DEFAULT_CHECKPOINTS);
  assert.match(m.disabledReason ?? '', /home directory/);
});

test('C1: /undo is implemented on checkpoints and also reverts shell changes', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'alpha\n', 'b.txt': 'beta\n' });
  const { agent } = await editingRun(ws);
  const out = await slash('undo', agent, '');
  assert.match(out, /rewound to/);
  assert.equal(read(ws, 'a.txt'), 'alpha\n');
  assert.equal(read(ws, 'b.txt'), 'beta\n', 'in-place shell change reverted (the v0.1 undo could not)');
  assert.equal(fs.existsSync(path.join(ws, 'c.txt')), false);
});
