/**
 * R1 guard, v1.2 UI tour: a `.git/config` edit is kept only when it touches branch tracking or identity (any source)
 * or remote URLs (the user's own edits); every other key is restored as before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { judgeGitConfigChange } from '../src/core/permissions/gitConfigAdopt.js';
import { setGitConfigSandboxedHook } from '../src/core/permissions/protect.js';
import { Agent } from '../src/core/agent/agent.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const BASE = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/me/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
const j = (after: string, userEdit = false) => judgeGitConfigChange(Buffer.from(BASE), Buffer.from(after), { userEdit });

test('git config: tracking and identity edits are kept from any source', () => {
  assert.equal(j(BASE + '[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n\tvscode-merge-base = origin/main\n').keep, true);
  assert.equal(j(BASE + '[user]\n\tname = Me\n\temail = me@x.dev\n').keep, true);
  assert.equal(j(BASE + '# a comment\n').keep, true, 'comments only');
  assert.equal(j(BASE + '[branch "f"]\n\trebase = true\n').keep, true);
});

test('git config: remote URLs are kept only for the user\'s own edits', () => {
  const evil = BASE.replace('https://github.com/me/app.git', 'https://evil.example/app.git');
  assert.equal(j(evil, false).keep, false, 'an agent command re-pointing origin is restored');
  assert.equal(j(evil, true).keep, true);
  assert.equal(j(BASE + '[remote "fork"]\n\turl = git@github.com:me/fork.git\n\tfetch = +refs/heads/*:refs/remotes/fork/*\n', true).keep, true);
});

test('git config (review H1): a branch\'s remote/pushremote must be "." or an existing remote, from any source', () => {
  for (const v of ['https://evil.example/x.git', 'git@evil.example:x.git', 'ssh://evil.example/x', 'file:///tmp/evil.git', '../evil.git', './evil.git', 'evil'])
    for (const userEdit of [false, true]) {
      assert.equal(j(BASE + `[branch "main"]\n\tpushremote = ${v}\n`, userEdit).keep, false, `pushremote ${v} (${userEdit})`);
      assert.equal(j(BASE + `[branch "main"]\n\tremote = ${v}\n`, userEdit).keep, false, `remote ${v} (${userEdit})`);
    }
  assert.equal(j(BASE + '[branch.main]\n\tpushremote = https://evil.example/x.git\n').keep, false, 'old-style section');
  assert.equal(j(BASE + '[branch "main"]\n\tremote = .\n\tmerge = refs/heads/dev\n').keep, true, 'tracking a local branch');
  assert.equal(j(BASE + '[branch "main"]\n\tpushremote = origin\n').keep, true);
  const fork = '[remote "fork"]\n\turl = https://github.com/me/fork.git\n[branch "main"]\n\tpushremote = fork\n';
  assert.equal(j(BASE + fork, true).keep, true, "the user's new remote, used in the same change");
  assert.equal(j(BASE + fork, false).keep, false);
});

test('git config: keys that run programs, and unsafe values, are never kept', () => {
  for (const add of ['[core]\n\thooksPath = /tmp/h\n', '[core]\n\tfsmonitor = /tmp/x\n', '[core]\n\tsshCommand = sh -c x\n', '[alias]\n\tst = !sh x\n', '[include]\n\tpath = /tmp/x\n', '[includeIf "gitdir:/"]\n\tpath = /tmp/x\n', '[filter "a"]\n\tclean = sh x\n', '[diff "a"]\n\ttextconv = sh x\n', '[remote "origin"]\n\tuploadpack = sh x\n', '[remote "origin"]\n\tvcs = x\n', '[credential]\n\thelper = !sh x\n', '[url "ext::sh -c x"]\n\tinsteadOf = https://\n'])
    assert.equal(j(BASE + add, true).keep, false, add);
  assert.equal(j(BASE + '[branch "main"]\n\tremote = origin\n[core]\n\tfsmonitor = /tmp/x\n', true).keep, false, 'one unsafe key spoils the whole change');
  assert.equal(j(BASE.replace('https://github.com/me/app.git', 'ext::sh -c touch% /tmp/pwned'), true).keep, false, 'ext:: transport');
  assert.equal(j(BASE.replace('https://github.com/me/app.git', 'fd::17'), true).keep, false, 'helper transport');
  assert.equal(j(BASE + '[branch "main"]\n\tremote = ext::sh -c x\n').keep, false, 'branch remote as an ext:: URL');
  assert.equal(j(BASE + '[branch "main"]\n\tmerge = --upload-pack=x\n').keep, false, 'option injection');
  assert.equal(j(BASE + '[branch "main"]\n\trebase = interactive\n').keep, false);
  assert.equal(j('[core\n\tbroken').keep, false, 'unparseable');
});

async function session(edit: (g: (...a: string[]) => string) => void, agentCommand?: string) {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i');
  g('remote', 'add', 'origin', 'https://github.com/me/app.git');
  const cmd = agentCommand ?? 'ls';
  const srv = await startMockServer((_b: any, i: number) => (i % 2 === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: cmd } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo' } as any), mcp: false, ui: {} });
  try {
    await agent.run('one');
    edit(g);
    await agent.run('two');
  } finally {
    await agent.dispose();
    await srv.close();
  }
  return fs.readFileSync(path.join(ws, '.git/config'), 'utf8');
}

test('git config in a session: the user\'s "Publish Branch" tracking is kept; a new remote only when the OS sandbox keeps .git/config from agent commands (review H2); core.hooksPath is restored', async () => {
  const userEdits = (g: (...a: string[]) => string) => {
    g('config', 'branch.main.remote', 'origin');
    g('config', 'branch.main.merge', 'refs/heads/main');
    g('remote', 'add', 'fork', 'https://github.com/me/fork.git');
  };
  await import('../src/core/sandbox/index.js'); // registers the real hook; restored below
  const real = setGitConfigSandboxedHook(() => false);
  try {
    const noSandbox = await session((g) => {
      g('config', 'branch.main.remote', 'origin');
      g('config', 'branch.main.merge', 'refs/heads/main');
    });
    assert.match(noSandbox, /\[branch "main"\]/, 'tracking is kept without a sandbox');
    const remoteNoSandbox = await session(userEdits);
    assert.doesNotMatch(remoteNoSandbox, /\[remote "fork"\]/, 'without a sandbox an agent process could have added it: restored');
    setGitConfigSandboxedHook(() => true);
    const kept = await session(userEdits);
    assert.match(kept, /\[branch "main"\]/);
    assert.match(kept, /\[remote "fork"\]/);
  } finally {
    setGitConfigSandboxedHook(real);
  }
  const restored = await session((g) => g('config', 'core.hooksPath', '/tmp/hooks'));
  assert.doesNotMatch(restored, /hooksPath/);
});

test('git config in a session: an agent command that re-points origin is restored', async () => {
  const cfg = await session(() => undefined, 'git remote set-url origin https://evil.example/app.git');
  assert.match(cfg, /github\.com\/me\/app\.git/);
  assert.doesNotMatch(cfg, /evil\.example/);
});

test('git config (review): the user tier needs every open session sandboxed with .git/config read-only (bwrap); a second unsandboxed session, or Landlock, restores it', { skip: process.platform !== 'linux' && 'bwrap/Linux only' }, async (t) => {
  const { runnerAvailable } = await import('../src/core/sandbox/index.js');
  if (!runnerAvailable('bwrap')) return t.skip('bwrap is not available');
  const run = async (first: string, second?: string) => {
    const ws = tmpWorkspace({ 'a.txt': 'x\n' });
    const g = (...a: string[]) => execFileSync('git', a, { cwd: ws, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i');
    g('remote', 'add', 'origin', 'https://github.com/me/app.git');
    const srv = await startMockServer((_b: any, i: number) => (i % 2 === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }] } : { content: 'ok' }));
    const mk = (sb: string) => Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', shell: { sandbox: sb, requireSandbox: false }, sandbox: { network: 'host' } } as any), mcp: false, ui: {} });
    const a = await mk(first);
    const b = second ? await mk(second) : undefined;
    try {
      await a.run('one');
      if (b) await b.run('one');
      g('remote', 'set-url', 'origin', 'https://github.com/me/moved.git');
      await a.run('two');
    } finally {
      await a.dispose();
      await b?.dispose();
      await srv.close();
    }
    return /moved/.test(fs.readFileSync(path.join(ws, '.git/config'), 'utf8'));
  };
  assert.equal(await run('bwrap'), true, "one bwrap session: the user's own remote edit is kept");
  assert.equal(await run('bwrap', 'none'), false, 'a second session without a sandbox: restored');
  if (runnerAvailable('landlock')) assert.equal(await run('landlock'), false, 'Landlock cannot make .git/config read-only: restored');
});
