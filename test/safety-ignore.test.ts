/** SPEC C5: ignore files with full gitignore semantics; .tuglineignore hides and gates reads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IgnoreIndex, parseIgnoreLine, rebaseIgnoreLines } from '../src/core/permissions/ignore.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { Agent } from '../src/core/agent/agent.js';
import { grepTool, globTool, listDirTool } from '../src/core/tools/fs.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const FIXTURE: Record<string, string> = {
  '.gitignore': ['# comment', '*.log', '!keep.log', '/build', 'docs/**/*.tmp', 'logs/', '**/cache', 'a/**/b', 'node_modules/', '!node_modules/reinclude.js', '\\#hash.txt', 'foo[0-9].c', '?.md', 'trailing.txt   ', 'esc\\ ', 'sub/deep/', 'only/root/*.cfg', ''].join('\n'),
  'keep.log': '', 'app.log': '', 'nested/x.log': '', 'nested/keep.log': '',
  'build/out.js': '', 'src/build/inner.js': '',
  'docs/a.tmp': '', 'docs/x/y/z.tmp': '', 'other/a.tmp': '',
  'logs/today.txt': '', 'src/logs/l.txt': '', 'logsfile': '',
  'cache/c.bin': '', 'src/deep/cache/c.bin': '',
  'a/b': '', 'a/x/y/b': '', 'a/c': '',
  'node_modules/pkg/index.js': '', 'node_modules/reinclude.js': '',
  '#hash.txt': '', 'foo1.c': '', 'fooX.c': '', 'x.md': '', 'xy.md': '', 'trailing.txt': '', 'esc ': '',
  'sub/deep/file.txt': '', 'sub/deeper.txt': '',
  'only/root/a.cfg': '', 'only/root/n/b.cfg': '',
  // nested .gitignore files with negation
  'pkg/.gitignore': '*.txt\n!important.txt\n/local-only\n',
  'pkg/notes.txt': '', 'pkg/important.txt': '', 'pkg/inner/more.txt': '', 'pkg/local-only': '', 'pkg/inner/local-only': '',
  'pkg/inner/.gitignore': '!more.txt\n',
};

function gitCheckIgnore(ws: string, rels: string[]): Set<string> {
  spawnSync('git', ['init', '-q'], { cwd: ws, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: ws, input: rels.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return new Set(r.stdout.split('\n').filter(Boolean));
}

test('C5 AC1: nested, negated, anchored and dir-only patterns match git exactly (fixture vs git check-ignore)', () => {
  const ws = tmpWorkspace(FIXTURE);
  const files = Object.keys(FIXTURE).filter((f) => !f.endsWith('.gitignore'));
  const expected = gitCheckIgnore(ws, files);
  const ix = new IgnoreIndex(ws);
  const mismatches = files.filter((f) => ix.gitIgnored(f, false) !== expected.has(f)).map((f) => `${f}: ours=${ix.gitIgnored(f, false)} git=${expected.has(f)}`);
  assert.deepEqual(mismatches, []);
  // spot checks that the fixture exercises what it claims
  const ign = (f: string) => ix.gitIgnored(f, false);
  assert.equal(ign('app.log'), true);
  assert.equal(ign('keep.log'), false, 'negation');
  assert.equal(ign('build/out.js'), true);
  assert.equal(ign('src/build/inner.js'), false, 'anchored /build');
  assert.equal(ign('src/logs/l.txt'), true, 'dir-only at any depth');
  assert.equal(ign('logsfile'), false);
  assert.equal(ign('node_modules/reinclude.js'), true, 'cannot re-include inside an excluded dir');
  assert.equal(ign('pkg/notes.txt'), true, 'nested .gitignore');
  assert.equal(ign('pkg/important.txt'), false, 'nested negation');
  assert.equal(ign('pkg/inner/more.txt'), false, 'deeper file re-includes');
  assert.equal(ign('pkg/inner/local-only'), false, 'anchored to the nested file dir');
  assert.equal(ign('a/x/y/b'), true, 'a/**/b');
  assert.equal(ign('esc '), true, 'escaped trailing space');
  assert.equal(ign('#hash.txt'), true, 'escaped #');
});

test('C5 AC1: .tuglineignore uses the same semantics and nests', () => {
  const ws = tmpWorkspace({ '.tuglineignore': 'secrets/\n*.pem\n!public.pem\n', 'secrets/db.txt': 'pw', 'src/k.pem': '', 'src/public.pem': '', 'svc/.tuglineignore': '/fixtures\n', 'svc/fixtures/f.json': '', 'svc/src/fixtures/g.json': '' });
  const ix = new IgnoreIndex(ws);
  assert.equal(ix.harnessIgnored('secrets/db.txt'), true);
  assert.equal(ix.harnessIgnored('secrets', true), true);
  assert.equal(ix.harnessIgnored('src/k.pem'), true);
  assert.equal(ix.harnessIgnored('src/public.pem'), false);
  assert.equal(ix.harnessIgnored('svc/fixtures/f.json'), true);
  assert.equal(ix.harnessIgnored('svc/src/fixtures/g.json'), false);
  assert.equal(ix.gitIgnored('secrets/db.txt'), false, 'layers are separate');
  // rebasing nested files to root-level excludes (used by the checkpoint store)
  assert.deepEqual(rebaseIgnoreLines('/fixtures\n*.snap\n!keep.snap\n', 'svc'), ['/svc/fixtures', '/svc/**/*.snap', '!/svc/**/keep.snap']);
  assert.equal(parseIgnoreLine('# c'), undefined);
  assert.equal(parseIgnoreLine('   '), undefined);
});

test('C5: ignore files are re-read when they change', async () => {
  const ws = tmpWorkspace({ '.tuglineignore': 'a.txt\n', 'a.txt': '', 'b.txt': '' });
  const ix = new IgnoreIndex(ws, 0);
  assert.equal(ix.harnessIgnored('b.txt'), false);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(ws, '.tuglineignore'), 'a.txt\nb.txt\n');
  assert.equal(ix.harnessIgnored('b.txt'), true);
});

const policy = (ws: string, extra: any = {}) => new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: [], additionalDirectories: [], ...extra });

test('C5: reads of .tuglineignore-d paths ask (even in auto) or deny with ignoreMode; isHidden covers both layers', () => {
  const ws = tmpWorkspace({ '.tuglineignore': 'private/\n', '.gitignore': 'dist/\n', 'private/keys.txt': 'x', 'dist/out.js': '', 'src/a.ts': '' });
  const read = (p: PermissionPolicy, f: string) => p.check({ tool: 'read_file', kind: 'read', paths: [{ path: path.join(ws, f), write: false }] });
  const p = policy(ws);
  assert.equal(read(p, 'private/keys.txt').decision, 'ask');
  assert.match(read(p, 'private/keys.txt').reason, /\.tuglineignore/);
  assert.equal(read(p, 'src/a.ts').decision, 'allow');
  assert.equal(read(p, 'dist/out.js').decision, 'allow', 'git-ignored reads are allowed by default');
  assert.equal(read(policy(ws, { gitignoreReads: 'ask' }), 'dist/out.js').decision, 'ask');
  assert.equal(read(policy(ws, { ignoreMode: 'deny' }), 'private/keys.txt').decision, 'deny');
  assert.equal(read(policy(ws, { allow: ['read_file(private/keys.txt)'] }), 'private/keys.txt').decision, 'allow', 'an explicit rule naming the file lifts the ask');
  assert.equal(p.isHidden(path.join(ws, 'private/keys.txt')), true);
  assert.equal(p.isHidden(path.join(ws, 'private')), true);
  assert.equal(p.isHidden(path.join(ws, 'dist/out.js')), true);
  assert.equal(policy(ws, { hideGitignored: false }).isHidden(path.join(ws, 'dist/out.js')), false);
  assert.equal(p.isHidden(path.join(ws, 'src/a.ts')), false);
  assert.equal(p.isHidden('/etc/passwd'), false, 'outside the workspace is not governed by workspace ignore files');
  // a symlink into the hidden dir is hidden too (resolved path)
  fs.symlinkSync(path.join(ws, 'private'), path.join(ws, 'src/alias'));
  assert.equal(p.isHidden(path.join(ws, 'src/alias/keys.txt')), true);
  assert.equal(read(p, 'src/alias/keys.txt').decision, 'ask');
});

test('C5: permissions.ignoreMode from config reaches the policy; the agent cannot read an ignored file without approval', async () => {
  const ws = tmpWorkspace({ '.tuglineignore': 'private/\n', 'private/keys.txt': 'TOP-SECRET-VALUE' });
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: 'private/keys.txt' } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', permissions: { ignoreMode: 'deny' } }), mcp: false });
  await agent.run('read it');
  await srv.close();
  const r = lastToolResult(srv.requests[1]);
  assert.match(r, /Refused: .*\.tuglineignore \(permissions\.ignoreMode = deny\)/);
  assert.doesNotMatch(JSON.stringify(srv.requests), /TOP-SECRET-VALUE/);
});

test('C5 AC2: an .tuglineignore-d secret dir does not appear in grep results (real grep, glob, list_dir)', async () => {
  const ws = tmpWorkspace({ '.tuglineignore': 'secret-dir/\n', 'secret-dir/creds.txt': 'NEEDLE password=hunter2', 'src/app.ts': '// NEEDLE in code' });
  const pol = policy(ws);
  let consulted = 0;
  const spy = Object.create(pol, { isHidden: { value: (abs: string) => (consulted++, pol.isHidden(abs)) } });
  const ctx: any = { workspace: ws, config: testConfig('http://x/v1'), policy: spy, signal: new AbortController().signal, ledger: { record() {}, has: () => true, forget() {}, mtime: () => undefined, list: () => [] }, emit() {}, host: undefined };
  const out = await grepTool.run({ pattern: 'NEEDLE', output_mode: 'content' } as any, ctx);
  assert.ok(consulted > 0, 'grep must consult policy.isHidden');
  assert.match(out.output, /src\/app\.ts/);
  assert.doesNotMatch(out.output, /secret-dir|hunter2/);
  const files = await grepTool.run({ pattern: 'NEEDLE', output_mode: 'files' } as any, ctx);
  assert.doesNotMatch(files.output, /secret-dir/);
  consulted = 0;
  const g = await globTool.run({ pattern: '**/*.txt' } as any, ctx);
  assert.ok(consulted > 0, 'glob must consult policy.isHidden');
  assert.doesNotMatch(g.output, /secret-dir/);
  consulted = 0;
  const l = await listDirTool.run({ path: '.' } as any, ctx);
  assert.ok(consulted > 0, 'list_dir must consult policy.isHidden');
  assert.doesNotMatch(l.output, /secret-dir/);
  assert.match(l.output, /src/);
});

test('C5 AC2 (contract): the S0.8 consumer contract (ctx.policy.isHidden?.(abs)) hides every file under the ignored dir', () => {
  // A stub search tool that consumes the policy exactly as S0.8 specifies, over a deep tree.
  const ws = tmpWorkspace({ '.tuglineignore': 'secret-dir/\n*.key\n!public.key\n', 'secret-dir/a.txt': 'x', 'secret-dir/deep/b/c.txt': 'x', 'src/k.key': 'x', 'src/public.key': 'x', 'src/app.ts': 'x', 'docs/secret-dir-notes.md': 'x' });
  const ctx = { policy: policy(ws) as { isHidden?: (abs: string) => boolean } };
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const visible = walk(ws).filter((abs) => !ctx.policy.isHidden?.(abs)).map((abs) => path.relative(ws, abs)).sort();
  assert.deepEqual(visible, ['.tuglineignore', 'docs/secret-dir-notes.md', 'src/app.ts', 'src/public.key']);
});
