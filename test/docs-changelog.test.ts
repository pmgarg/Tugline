/**
 * WS12 N17: `tug changelog` (AC1: every bullet links to a sha in range; the
 * coverage list names every omitted commit; breaking changes from the diff)
 * and `/doc` (AC2: a Python docstring is inserted and every other byte is
 * unchanged; refresh, JSDoc, CRLF, the guard).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildChangelog, classify, coverage, formatChangelog } from '../src/core/docs/changelog.js';
import { applyDocs, onlyDocsChanged, parseDocArgs, selectTargets } from '../src/core/docs/docstring.js';
import { getCliCommand, getSlashCommand } from '../src/core/commands.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { DiskHost } from '../src/core/host/workspace.js';
import { LLMClient } from '../src/core/llm/client.js';
import { resolveProfile } from '../src/core/config.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig } from './helpers.js';
import { fixtureRepo, git, promptOf } from './docs-helpers.js';

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});

function historyRepo(): string {
  const ws = fixtureRepo();
  git(ws, 'tag', 'v1.0.0');
  const edit = (f: string, fn: (s: string) => string) => fs.writeFileSync(path.join(ws, f), fn(fs.readFileSync(path.join(ws, f), 'utf8')));
  edit('src/cli/args.ts', (s) => s.replace("argv.includes('--verbose')", "argv.includes('--verbose'), json: argv.includes('--json')").replace('verbose: boolean }', 'verbose: boolean; json: boolean }'));
  git(ws, 'commit', '-qam', 'feat(cli): add --json output (#12)');
  edit('src/agent/tools.ts', (s) => s.replace('return readText(call);', "return call ? readText(call) : '';"));
  git(ws, 'commit', '-qam', 'fix: handle an empty tool call');
  fs.rmSync(path.join(ws, 'src/fs/write.ts'));
  git(ws, 'commit', '-qam', 'Drop the legacy writer');
  for (const f of ['src/agent/loop.ts', 'src/cli/main.ts']) edit(f, (s) => s.replace(/runLoop/g, 'runAgent'));
  git(ws, 'commit', '-qam', 'refactor(agent)!: rename the loop entry point');
  edit('docs/guide.md', (s) => s + '\nMore.\n');
  git(ws, 'commit', '-qam', 'docs: more guide [skip changelog]');
  edit('src/llm/client.ts', (s) => s.replace('`echo ${prompt}`', 'JSON.stringify(prompt)'));
  git(ws, 'commit', '-qam', 'Escape prompts to prevent shell injection');
  git(ws, 'checkout', '-qb', 'topic');
  edit('src/config/defaults.ts', (s) => s.replace('16384', '32768'));
  git(ws, 'commit', '-qam', 'perf: larger default context');
  git(ws, 'checkout', '-q', 'main');
  git(ws, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #15 from acme/topic', 'topic');
  git(ws, 'commit', '--allow-empty', '-qm', 'chore(release): 1.1.0');
  return ws;
}

test('N17 AC1: every bullet links to a sha in range, and the coverage list names every omitted commit', async () => {
  const ws = historyRepo();
  const c = await buildChangelog({ workspace: ws, since: 'v1.0.0', repoUrl: 'https://github.com/acme/fixture' });
  const inRange = new Set(git(ws, 'log', '--format=%h', 'v1.0.0..HEAD').split('\n'));
  const md = formatChangelog(c, 'keepachangelog', '1.1.0', '2026-10-29');
  const bullets = md.split('\n').filter((l) => /^- /.test(l));
  const notIncluded = md.slice(md.indexOf('coverage'));
  for (const b of bullets) {
    const shas = [...b.matchAll(/\/commit\/([0-9a-f]{7,})\)/g)].map((m) => m[1]);
    assert.ok(shas.length >= 1, `bullet without a commit link: ${b}`);
    for (const s of shas) assert.ok(inRange.has(s), `${s} is in v1.0.0..HEAD`);
  }
  assert.deepEqual(coverage(c).missing, [], 'every commit is either a bullet or listed');
  for (const why of ['merge commit', 'marked [skip changelog]', 'release commit']) assert.match(notIncluded, new RegExp(why.replace(/[[\]]/g, '\\$&')));
  assert.match(notIncluded, /Merge pull request #15/);
  // sections
  const section = (name: string) => md.split(`### ${name}\n`)[1]?.split('\n### ')[0] ?? '';
  assert.match(section('Added'), /\*\*cli:\*\* Add --json output .*\[#12\]\(https:\/\/github\.com\/acme\/fixture\/pull\/12\)/);
  assert.match(section('Fixed'), /Handle an empty tool call/);
  assert.match(section('Removed'), /Drop the legacy writer/);
  assert.match(section('Security'), /Escape prompts to prevent shell injection/);
  assert.match(section('Changed'), /Larger default context/);
  // breaking: from `!` and from the diff (exports gone since the tag)
  const br = section('Breaking');
  assert.match(br, /Rename the loop entry point/);
  assert.match(br, /`runLoop` is no longer exported from `src\/agent\/loop\.ts`/);
  assert.match(br, /`writeText` is no longer exported from `src\/fs\/write\.ts`/);
  // GitHub format through the CLI
  const out: string[] = [];
  assert.equal(await getCliCommand('changelog')!.run(['--since', 'v1.0.0', '--format', 'github', '--repo-url', 'https://github.com/acme/fixture'], { config: testConfig('http://127.0.0.1:9/v1'), workspace: ws, write: (t) => out.push(t) }), 0);
  assert.match(out.join('\n'), /### 🚀 Features[\s\S]*<details><summary>Not included<\/summary>/);
  // classification units
  assert.equal(classify({ sha: 'x', short: 'x', subject: 'feat!: drop node 18', body: '', author: '', date: '', parents: 1 }).entry?.breaking, true);
  assert.equal(classify({ sha: 'x', short: 'x', subject: 'tweak', body: 'BREAKING CHANGE: config key renamed', author: '', date: '', parents: 1 }).entry?.breaking, true);
});

test('N17: --summarize adds one model sentence per busy section (subjects wrapped as untrusted)', async () => {
  const ws = historyRepo();
  for (let i = 0; i < 3; i++) {
    fs.appendFileSync(path.join(ws, 'src/agent/tools.ts'), `// fix ${i}\n`);
    git(ws, 'commit', '-qam', `fix: corner case ${i}`);
  }
  const srv = await startMockServer(() => ({ content: 'Several edge cases in tool handling were fixed.' }));
  closers.push(srv.close);
  const c = await buildChangelog({ config: testConfig(srv.url), workspace: ws, since: 'v1.0.0', summarize: true });
  assert.equal(c.summaries.Fixed, 'Several edge cases in tool handling were fixed.');
  assert.ok(srv.requests.map(promptOf).some((p) => /<untrusted_commit_subjects section="Fixed">\n- Handle an empty tool call/.test(p)));
});

const PY = 'from .greet import greet\n\n\ndef shout_all(names, sep=", "):\n    return sep.join(n.upper() for n in names)\n\n\nclass Greeter:\n    """Old docstring."""\n\n    def hello(self, name):\n        return greet(name)\n';

test('N17 AC2: /doc on a Python function inserts a docstring and every other byte is unchanged', async () => {
  const ws = fixtureRepo({ 'py/tool/shout.py': PY });
  const srv = await startMockServer(() => ({ content: 'Shout every name and join them.\n\nArgs:\n    names: the names to shout.\n    sep: the separator.\n\nReturns:\n    The joined, upper-cased names.' }));
  closers.push(srv.close);
  const config = testConfig(srv.url);
  const out: string[] = [];
  const agent = { llm: new LLMClient(resolveProfile(config)), policy: new PermissionPolicy({ workspace: ws, mode: 'ask', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] }), host: new DiskHost() };
  const asked: string[] = [];
  await getSlashCommand('doc')!.run('py/tool/shout.py#shout_all', { agent, config, workspace: ws, write: (t) => out.push(t), ask: async (q) => (asked.push(q), 'Apply'), surface: 'cli' });
  assert.equal(asked.length, 1, 'ask mode: the edit is reviewed before it is written');
  const after = fs.readFileSync(path.join(ws, 'py/tool/shout.py'), 'utf8');
  const inserted = '    """Shout every name and join them.\n\n    Args:\n        names: the names to shout.\n        sep: the separator.\n\n    Returns:\n        The joined, upper-cased names.\n    """\n';
  assert.ok(after.includes(inserted), after);
  assert.equal(after.replace(inserted, ''), PY, 'byte diff: only the docstring was added');
  assert.match(out.join('\n'), /added\/refreshed docstrings for shout_all/);
  // the model saw the function source wrapped as untrusted
  assert.match(promptOf(srv.requests[0]), /<untrusted_source path="py\/tool\/shout\.py">\ndef shout_all/);
  // a cancelled review writes nothing
  fs.writeFileSync(path.join(ws, 'py/tool/shout.py'), PY);
  await getSlashCommand('doc')!.run('py/tool/shout.py:5', { agent, config, workspace: ws, write: () => {}, ask: async () => 'Cancel', surface: 'cli' });
  assert.equal(fs.readFileSync(path.join(ws, 'py/tool/shout.py'), 'utf8'), PY);
  // a protected file is refused by the policy before the model is asked
  const n = srv.requests.length;
  const prot = { ...agent, policy: new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: ['py/**'], additionalDirectories: [] }) };
  const o2: string[] = [];
  await getSlashCommand('doc')!.run('py/tool/shout.py#shout_all', { agent: prot, config, workspace: ws, write: (t) => o2.push(t), surface: 'cli' });
  assert.match(o2.join('\n'), /^refused: /);
  assert.equal(srv.requests.length, n);
});

test('N17 AC2: refresh replaces an existing docstring or JSDoc; CRLF is kept; the guard rejects code changes', () => {
  const py = applyDocs('py', PY, [{ target: selectTargets('py', PY, { symbol: 'Greeter' })[0], text: 'Greets people.' }]);
  assert.equal(py.after, PY.replace('"""Old docstring."""', '"""Greets people."""'));
  assert.ok(onlyDocsChanged('py', py));
  const ts = '/** Reads a text file. */\nexport function readText(p: string): string {\r\n  return p;\r\n}\r\n'.replace(/\n/g, '\r\n').replace(/\r\r/g, '\r');
  const e = applyDocs('ts', ts, [{ target: selectTargets('ts', ts, { symbol: 'readText' })[0], text: 'Read a UTF-8 file.\n@param p the path\n@returns the text' }]);
  assert.equal(e.after, '/**\r\n * Read a UTF-8 file.\r\n * @param p the path\r\n * @returns the text\r\n */\r\nexport function readText(p: string): string {\r\n  return p;\r\n}\r\n');
  assert.ok(onlyDocsChanged('ts', e));
  // nested method with decorator, Go style
  const go = 'package x\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n';
  const g = applyDocs('go', go, [{ target: selectTargets('go', go, { symbol: 'Add' })[0], text: 'adds two numbers.' }]);
  assert.match(g.after, /^\/\/ Add adds two numbers\.\nfunc Add/m);
  // guard
  assert.equal(onlyDocsChanged('py', { ...py, after: py.after.replace('return greet(name)', 'return greet(name) + "!"') }), false);
  assert.deepEqual(parseDocArgs('src/a.ts:12', '/w'), { rel: 'src/a.ts', line: 12, symbol: undefined, all: false });
  assert.deepEqual(parseDocArgs('src/a.ts', '/w'), { rel: 'src/a.ts', line: undefined, symbol: undefined, all: true });
  assert.equal(parseDocArgs('../etc/passwd', '/w'), undefined);
});
