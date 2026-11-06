/**
 * WS12 N9: `tug docs check` catches each class — broken links and anchors, stale
 * path and symbol references, CLI flags that `--help` no longer lists, and
 * snippets that don't parse — and exits 1 naming the doc line (AC1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cliInvocations, docsCheck, formatFindings, headingSlugs, parseHelp, snippetError } from '../src/core/docs/check.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { testConfig } from './helpers.js';
import { fixtureRepo, git } from './docs-helpers.js';

/** A tiny CLI whose --help lists the flags; `tug` in the docs maps to it. */
const CLI = (flag: string) => `const a = process.argv.slice(2);\nif (a.includes('--help')) { console.log('Usage\\n  tug run ${flag} <text> [--verbose]\\n  tug index [--rebuild]\\nOptions\\n  --cwd <dir>'); process.exit(0); }\n`;

function repo(docs: Record<string, string>, flag = '--prompt') {
  const ws = fixtureRepo({ 'tools/cli.mjs': CLI(flag), ...docs });
  const config = testConfig('http://127.0.0.1:9/v1', { docs: { check: { cli: ['node', 'tools/cli.mjs'] } } });
  return { ws, config };
}

test('N9 AC1: renaming a CLI flag without updating the README makes `tug docs check` exit 1, naming the README line', async () => {
  const { ws, config } = repo({ 'README.md': '# Fixture\n\nQuick start:\n\n```bash\ntug run --prompt "hello" --verbose\n```\n' });
  const out: string[] = [];
  const cmd = getCliCommand('docs')!;
  assert.equal(await cmd.run(['check'], { config, workspace: ws, write: (t) => out.push(t) }), 0, out.join('\n'));
  // the flag is renamed in the CLI, the README is not updated
  fs.writeFileSync(path.join(ws, 'tools/cli.mjs'), CLI('--input'));
  git(ws, 'commit', '-qam', 'rename --prompt to --input');
  out.length = 0;
  assert.equal(await cmd.run(['check'], { config, workspace: ws, write: (t) => out.push(t) }), 1);
  assert.match(out.join('\n'), /README\.md:6: \[cli-flag\] tug run: unknown flag --prompt/);
  out.length = 0;
  await cmd.run(['check', '--format', 'github'], { config, workspace: ws, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /::error file=README\.md,line=6,title=docs cli-flag::tug run: unknown flag --prompt/);
});

test('N9: docs check catches broken links/anchors, stale paths and symbols, and broken snippets', async () => {
  const { ws, config } = repo({
    'docs/guide.md': [
      '# Guide',
      '## Setup steps',
      'See [setup](#setup-steps), [missing](#nope), [other](other.md) and [gone](gone.md#x).',
      'The loop is `src/agent/loop.ts`; the old one was `src/agent/old_loop.ts`.',
      'Call `runLoop()` (exists) or `startEngine()` (removed). `JSON.parse()` is fine.',
      'External: [site](https://example.com) is never fetched.',
      '```json',
      '{ "a": 1, }',
      '```',
      '```jsonc',
      '{ "a": 1, // ok in jsonc',
      '}',
      '```',
      '```ts',
      'export function f(: number) {}',
      '```',
      '```python',
      'def f(:',
      '```',
      '```bash',
      'if then fi (',
      '```',
      '<!-- docs-check: skip -->',
      '```ts',
      'this is skipped {',
      '```',
      '```ts',
      'const x = foo(…);',
      '```',
    ].join('\n'),
    'docs/other.md': '# Other\n## Section A\n',
  });
  const r = await docsCheck({ config, workspace: ws });
  const at = (kind: string) => r.findings.filter((f) => f.kind === kind && f.file === 'docs/guide.md');
  assert.deepEqual(at('anchor').map((f) => f.message), ['broken anchor: #nope (no heading "#nope" in docs/guide.md)']);
  assert.deepEqual(at('link').map((f) => f.line), [3], 'gone.md');
  assert.deepEqual(at('code-ref').map((f) => f.message), ['stale path reference: `src/agent/old_loop.ts` does not exist']);
  assert.deepEqual(at('symbol').map((f) => f.message), ['stale symbol reference: `startEngine()` — no source file defines or uses startEngine']);
  const snips = at('snippet').map((f) => `${f.line}:${f.message.split(' ')[0]}`);
  assert.ok(snips.includes('8:json'), `json: ${snips}`);
  assert.ok(snips.some((s) => s.startsWith('15:ts')), `ts: ${snips}`);
  assert.ok(snips.some((s) => /:python$/.test(s)) || !fs.existsSync('/usr/bin/python3'), `python: ${snips}`);
  assert.ok(snips.some((s) => /:bash$/.test(s)), `bash: ${snips}`);
  assert.ok(!snips.some((s) => s.startsWith('11:')), 'valid JSONC passes');
  assert.ok(!r.findings.some((f) => /skipped|foo\(…\)/.test(f.message)), 'skip marker and partial snippets');
  assert.ok(!r.findings.some((f) => f.file === 'README.md' && f.kind !== 'cli-flag'), 'README links resolve');
  assert.match(formatFindings(r, 'text'), /problem\(s\) in \d+ file\(s\)/);
});

test('N9: helpers — heading slugs, help parsing, invocations, snippets', async () => {
  assert.ok(headingSlugs('# Hello, World!\n## Hello, World!\n```\n# not a heading\n```').has('hello-world-1'));
  const h = parseHelp('  tug wiki build [--force]\n  -y, --yes   auto\n  tug docs check', 'tug');
  assert.ok(h.flags.has('--force') && h.flags.has('--yes') && h.flags.has('-y'));
  assert.deepEqual([...h.subcommands].sort(), ['docs', 'wiki']);
  assert.deepEqual(cliInvocations('run `tug wiki build --force --out=x` then tug -y', 'tug').map((i) => [i.sub, i.flags]), [['wiki', ['--force', '--out']], [undefined, ['-y']]]);
  assert.equal(await snippetError('json', '{"a": 1}'), undefined);
  assert.equal(await snippetError('jsonc', '"key": { "x": 1 }, // fragment'), undefined);
  assert.notEqual(await snippetError('json', '{a: 1}'), undefined);
});

test('N9: links inside inline code are examples; paths into a top-level directory the repo lacks describe another tree', async () => {
  const { ws, config } = repo({ 'docs/x.md': '# X\nA citation looks like `[a.ts:1](…#L1)`.\nThe vsix ships `extension/test/run.mjs`; fixtures write `tests/judge.txt`.\nBut `src/gone.ts` is stale.\n' });
  const r = await docsCheck({ config, workspace: ws, files: ['docs/x.md'] });
  assert.deepEqual(r.findings.map((f) => `${f.line}:${f.kind}`), ['4:code-ref']);
});

test('N9: `tug <sub> --help` prints the registered command\'s full help, so documented subcommand flags are checked against it', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'schedule', '--help'], { encoding: 'utf8', timeout: 60_000 });
  assert.match(out, /tug schedule add \(--cron/);
  assert.match(out, /--max-runs N/);
});
