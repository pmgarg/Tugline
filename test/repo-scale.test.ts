/**
 * WS1 v1.1 R15: repository understanding at scale — the repo map has no fixed
 * file cap and an incremental, persistent cache; the real-repository
 * file-localisation eval (repo map vs N3 navigation vs N2 search).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildRepoMap, clearRepoMapCache, setDefExtractorLoader } from '../src/core/context/repomap.js';
import { formatRepoEval, instancesFromRows, issueIdentifiers, patchFiles, runRepoEval, selectInstances } from '../src/core/context/index/evalRepos.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';
import { tmpWorkspace } from './helpers.js';
import { startMockEmbeddings } from './code-search-helpers.js';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('R15: the repo map scans past the old 3000-file cap and reparses only changed files across runs (persistent cache)', { timeout: 240_000 }, async () => {
  setDefExtractorLoader(async () => undefined); // regexes: this test is about scale and caching, not the extractor
  try {
    const files: Record<string, string> = {};
    for (let i = 0; i < 3200; i++) files[`pkg${i % 40}/mod${i}.py`] = `def helper_${i}(x):\n    return x + ${i}\n`;
    files['core/central.py'] = 'def central_function(x):\n    return x\n';
    for (let i = 0; i < 30; i++) files[`pkg${i}/user${i}.py`] = `from core.central import central_function\ncentral_function(${i})\n`;
    const ws = tmpWorkspace(files);
    const cacheDir = tmp('oh-rm-cache-');
    const m1 = await buildRepoMap(ws, { tokens: 400, cacheDir });
    assert.equal(m1.totalFiles, 3231, 'every file is mapped (the cap was 3000)');
    assert.equal(m1.scan!.reparsed, 3231);
    assert.match(m1.text, /core\/central\.py:\n {2}⋮ def central_function/);
    assert.ok(fs.statSync(path.join(cacheDir, 'repomap.json')).size > 0);
    // a new process: the in-memory cache is gone, the disk cache is not
    clearRepoMapCache();
    const m2 = await buildRepoMap(ws, { tokens: 400, cacheDir });
    assert.equal(m2.scan!.reparsed, 0, 'nothing reparsed from a warm disk cache');
    assert.equal(m2.text, m1.text);
    // one file's content changes; another is only touched (mtime moves, content does not)
    fs.writeFileSync(path.join(ws, 'pkg1/mod1.py'), 'def helper_1(x):\n    return x * 2\n\ndef added_later(y):\n    return y\n');
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(ws, 'pkg2/mod2.py'), t, t);
    clearRepoMapCache();
    const m3 = await buildRepoMap(ws, { tokens: 400, cacheDir, focusText: 'added_later' });
    assert.equal(m3.scan!.reparsed, 1, 'only the changed file is reparsed (the touched one matches its hash)');
    assert.match(m3.text, /pkg1\/mod1\.py:[\s\S]*def added_later/);
    // a cap can still be set explicitly
    const capped = await buildRepoMap(ws, { tokens: 200, maxFiles: 100 });
    assert.equal(capped.totalFiles, 100);
  } finally {
    setDefExtractorLoader(undefined);
    clearRepoMapCache();
  }
});

test('R15: gold-patch files, issue identifiers and instance selection', () => {
  const patch = 'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/pkg/b.go b/pkg/b.go\n';
  assert.deepEqual(patchFiles(patch), ['src/a.py', 'pkg/b.go']);
  const ids = issueIdentifiers('Calling `QuerySet.bulk_create()` with ignore_conflicts fails; see django.db.models.query and the RenderContext class. This is the issue.');
  for (const w of ['QuerySet', 'bulk_create', 'ignore_conflicts', 'query', 'RenderContext']) assert.ok(ids.includes(w), `${w} in ${ids}`);
  assert.ok(!ids.includes('This') && !ids.includes('issue'));
  const rows = [1, 2, 3].map((n) => ({ instance_id: `o__r-${n}`, repo: 'o/r', base_commit: 'abc', problem_statement: 'p', patch }));
  assert.equal(selectInstances(instancesFromRows([...rows, { ...rows[0], repo: 'o/s', instance_id: 's-1' }]), ['o/r'], 2).length, 2);
});

test('R15: the real-repository localisation eval runs end to end (local git repo, mock embedder) and scores every method', { timeout: 240_000 }, async () => {
  // a small multi-package repository with history: the "issue" is fixed in the second commit
  const src = tmpWorkspace({
    'packages/billing/src/invoice.ts': 'export function computeInvoiceTotal(lines: number[], vatRate: number) {\n  return lines.reduce((a, b) => a + b, 0) * (1 + vatRate);\n}\n',
    'packages/billing/src/currency.ts': 'export function convertCurrency(amount: number, rate: number) {\n  return amount * rate;\n}\n',
    'packages/auth/src/session.ts': 'export class SessionStore {\n  expire(token: string) {\n    return token;\n  }\n}\n',
    'packages/auth/src/password.ts': 'export function hashPassword(p: string) {\n  return p;\n}\n',
    'packages/web/src/cart.ts': "import { computeInvoiceTotal } from '../../billing/src/invoice';\nexport const total = computeInvoiceTotal([1, 2], 0.2);\n",
    'README.md': '# shop\n',
  });
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src, stdio: 'pipe' }).toString().trim();
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(src, 'packages/auth/src/session.ts'), 'export class SessionStore {\n  expire(token: string) {\n    return token.trim();\n  }\n}\n');
  g('commit', '-qam', 'fix');
  const patch = g('diff', `${base}`, 'HEAD');
  const rows = [
    { instance_id: 'shop-1', repo: 'acme/shop', base_commit: base, patch, problem_statement: 'Sessions are not expired when the token has trailing whitespace: `SessionStore.expire` keeps them alive.' },
    { instance_id: 'shop-2', repo: 'acme/shop', base_commit: base, patch: 'diff --git a/packages/billing/src/invoice.ts b/packages/billing/src/invoice.ts\n', problem_statement: 'The VAT in computeInvoiceTotal is applied to every line twice in the cart total.' },
  ];
  const srv = await startMockEmbeddings();
  try {
    const home = tmp('oh-r15-home-');
    const cfg = deepMerge(defaultConfig(), { homeDir: home, search: { embeddings: { baseUrl: srv.url, model: 'mock-embed' } } });
    const r = await runRepoEval(cfg, instancesFromRows(rows), { sources: { 'acme/shop': src }, dataset: 'local fixture' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.instances, 2);
    assert.deepEqual(r.methods, ['repomap', 'nav', 'bm25', 'hybrid', 'fused']);
    for (const m of r.methods) assert.equal(r.hit[m]![10], 1, `${m} finds the file in the top 10`);
    assert.equal(r.results[0].ranked.nav![0], 'packages/auth/src/session.ts', 'navigation resolves SessionStore.expire');
    assert.equal(r.results[1].ranked.repomap![0], 'packages/billing/src/invoice.ts', 'the personalised repo map ranks the definer of computeInvoiceTotal first');
    assert.equal(r.results[1].reparsed, 0, 'the second instance at the same commit reparses nothing');
    const md = formatRepoEval(r);
    assert.match(md, /\| repo map \(D7, personalised\) \| \d+ % \| \d+ % \| 100 % \|/);
    assert.match(md, /\| hybrid BM25 \+ embeddings \(N2\) \|/);
    // the working copy is a checkout of the base commit (the fix is not visible)
    const ws = path.join(home, 'eval-repos', 'acme__shop');
    assert.doesNotMatch(fs.readFileSync(path.join(ws, 'packages/auth/src/session.ts'), 'utf8'), /trim/);
  } finally {
    await srv.close();
  }
});
