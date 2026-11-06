/**
 * WS12 N9: the doc-sync agent (AC2: only doc paths are written — a source edit
 * is refused by the policy — and the PR goes through a fake forge) and
 * Markdown check files as status checks in GitHub format (AC3).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { docsSync, removedSymbols, setDocsForge, type PullRequestRequest } from '../src/core/docs/sync.js';
import { parseCheckFile } from '../src/core/docs/checks.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, type MockServer } from './helpers.js';
import { fixtureRepo, git } from './docs-helpers.js';

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
  setDocsForge(undefined);
});

/** main: the fixture; feature: runLoop renamed to runAgent in code, docs not updated. */
function renamedRepo(): string {
  const ws = fixtureRepo();
  git(ws, 'checkout', '-q', '-b', 'feature');
  for (const f of ['src/agent/loop.ts', 'src/cli/main.ts']) fs.writeFileSync(path.join(ws, f), fs.readFileSync(path.join(ws, f), 'utf8').replace(/runLoop/g, 'runAgent'));
  git(ws, 'commit', '-qam', 'rename runLoop to runAgent');
  return ws;
}

test('N9 AC2: policy writeOnly refuses a source edit (hard deny) and allows doc paths', () => {
  const ws = fixtureRepo();
  const p = new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: ['edit_file'], deny: [], protectedPaths: [], additionalDirectories: [], writeOnly: ['docs/**', 'README.md'] });
  const src = p.check({ tool: 'edit_file', kind: 'edit', paths: [{ path: path.join(ws, 'src/agent/loop.ts'), write: true }] });
  assert.equal(src.decision, 'deny');
  assert.equal((src as any).hard, true, 'no rule or mode lifts it');
  assert.match(src.reason, /may only write docs\/\*\*, README\.md/);
  assert.equal(p.check({ tool: 'edit_file', kind: 'edit', paths: [{ path: path.join(ws, 'docs/guide.md'), write: true }] }).decision, 'allow');
  assert.equal(p.check({ tool: 'read_file', kind: 'read', paths: [{ path: path.join(ws, 'src/agent/loop.ts'), write: false }] }).decision, 'allow', 'reads are unaffected');
});

test('N9 AC2: tug docs sync edits only doc paths in a worktree and opens a PR through a fake forge', async () => {
  const ws = renamedRepo();
  assert.deepEqual(removedSymbols(ws, 'main', ['src/agent/loop.ts']).map((r) => r.name), ['runLoop']);
  // The scripted agent: read both files, try a source edit (must be refused), edit the guide, finish.
  const srv: MockServer = await startMockServer((body) => {
    const toolMsgs = body.messages.filter((m: any) => m.role === 'tool').length;
    const editName = (body.tools ?? []).map((t: any) => t.function.name).find((n: string) => n === 'edit_file') ?? 'edit_file';
    if (toolMsgs === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'docs/guide.md' } }, { name: 'read_file', arguments: { path: 'src/agent/loop.ts' } }] };
    if (toolMsgs === 2) return { toolCalls: [{ name: editName, arguments: { path: 'src/agent/loop.ts', old_string: 'runAgent', new_string: 'runLoop' } }, { name: editName, arguments: { path: 'docs/guide.md', old_string: '`runLoop()`', new_string: '`runAgent()`' } }] };
    return { content: '- docs/guide.md: runLoop() → runAgent()' };
  });
  closers.push(srv.close);
  const prs: PullRequestRequest[] = [];
  setDocsForge({ name: 'fake', openPullRequest: async (r) => (prs.push(r), { url: 'https://forge.example/acme/fixture/pull/7' }) });
  const config = testConfig(srv.url, { docs: { check: { cli: [] } } });
  const headBefore = git(ws, 'rev-parse', 'HEAD');
  const r = await docsSync({ config, workspace: ws, base: 'main', pr: true });
  // candidates came from the deterministic pass
  assert.ok(r.candidates.some((c) => c.file === 'docs/guide.md' && /runLoop/.test(c.message)), JSON.stringify(r.candidates));
  // the source edit was refused by the policy, the doc edit made
  assert.ok(r.refusals.some((x) => /src\/agent\/loop\.ts.*may only write/.test(x)), `refusals: ${r.refusals}`);
  assert.deepEqual(r.edited, ['docs/guide.md']);
  assert.match(r.patch, /^\+.*`runAgent\(\)`/m);
  // the PR: one call to the forge, a branch with only the doc change, the user's checkout untouched
  assert.equal(prs.length, 1);
  assert.equal(prs[0].base, 'main');
  assert.match(prs[0].title, /docs: sync/);
  assert.equal(r.pr?.url, 'https://forge.example/acme/fixture/pull/7');
  assert.deepEqual(git(ws, 'show', '--name-only', '--format=', prs[0].branch).split('\n').filter(Boolean), ['docs/guide.md']);
  assert.equal(git(ws, 'rev-parse', 'HEAD'), headBefore);
  assert.match(fs.readFileSync(path.join(ws, 'docs/guide.md'), 'utf8'), /runLoop/, 'the working tree is not modified');
  assert.equal(git(ws, 'status', '--porcelain'), '');
  // no shell, no network tools were offered to the agent
  const names = (srv.requests[0].tools ?? []).map((t: any) => t.function.name);
  assert.ok(!names.includes('bash') && !names.includes('web_fetch'), `tools: ${names}`);
});

test('N9: docs sync --dry-run lists candidates without calling the model; nothing to do → in sync', async () => {
  const ws = renamedRepo();
  const out: string[] = [];
  const config = testConfig('http://127.0.0.1:9/v1', { docs: { check: { cli: [] } } });
  assert.equal(await getCliCommand('docs')!.run(['sync', '--base', 'main', '--dry-run'], { config, workspace: ws, write: (t) => out.push(t) }), 0);
  assert.match(out.join('\n'), /docs\/guide\.md:3: \[symbol\] .*runLoop.*\(runLoop removed or renamed in src\/agent\/loop\.ts\)/);
  const clean = fixtureRepo();
  git(clean, 'checkout', '-q', '-b', 'f2');
  const r = await docsSync({ config, workspace: clean, base: 'main' });
  assert.match(r.summary, /in sync/);
});

test('N9 AC3: a check file .tugline/checks/no-todo.md produces pass/fail output in GitHub format', async () => {
  const ws = fixtureRepo({ '.tugline/checks/no-todo.md': '---\nname: No TODO comments\nseverity: error\n---\nFail if the change adds a TODO or FIXME comment to source code.\n' });
  git(ws, 'checkout', '-q', '-b', 'pr');
  const srv = await startMockServer((body) => {
    const p = String(body.messages[1].content);
    return { content: /^\+.*TODO/m.test(p) ? 'Verdict:\n{"pass": false, "findings": [{"file": "src/agent/tools.ts", "line": 5, "message": "adds a TODO comment"}, {"file": "src/unchanged.ts", "line": 1, "message": "not in the diff"}]}' : '{"pass": true, "findings": []}' };
  });
  closers.push(srv.close);
  const config = testConfig(srv.url);
  const review = getCliCommand('review')!;
  // passing change
  fs.appendFileSync(path.join(ws, 'src/fs/read.ts'), '// reads text\n');
  git(ws, 'commit', '-qam', 'comment');
  let out: string[] = [];
  assert.equal(await review.run(['--checks', '--base', 'main', '--format', 'github'], { config, workspace: ws, write: (t) => out.push(t) }), 0);
  assert.match(out.join('\n'), /::notice title=Check%3A No TODO comments::pass/);
  // failing change
  fs.writeFileSync(path.join(ws, 'src/agent/tools.ts'), fs.readFileSync(path.join(ws, 'src/agent/tools.ts'), 'utf8').replace('return readText(call);', '// TODO: validate the call\n  return readText(call);'));
  git(ws, 'commit', '-qam', 'todo');
  out = [];
  assert.equal(await review.run(['--checks', '--base', 'main', '--format', 'github'], { config, workspace: ws, write: (t) => out.push(t) }), 1);
  const text = out.join('\n');
  assert.match(text, /::error file=src\/agent\/tools\.ts,line=5,title=Check%3A No TODO comments::adds a TODO comment/);
  assert.match(text, /::notice title=Check%3A No TODO comments::fail/);
  assert.ok(!/unchanged\.ts/.test(text), 'findings outside the diff are dropped');
  // parsing
  const c = parseCheckFile('x.md', '---\nname: N\nseverity: warning\npaths: [src/**, "lib/**"]\n---\nRule text\n');
  assert.deepEqual([c.name, c.severity, c.paths, c.rule], ['N', 'warning', ['src/**', 'lib/**'], 'Rule text']);
});
