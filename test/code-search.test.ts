/**
 * WS1 v1.1 N2: local semantic code search (`code_search`, `tug index`), with a
 * deterministic mock /embeddings server (test/code-search-helpers.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { codebaseMention, codeSearchTool, updateIndex } from '../src/core/context/index/tool.js';
import { toolsForAgentType } from '../src/core/tools/index.js';
import { codeIndexFor, forgetIndexes, indexDir } from '../src/core/context/index/codeIndex.js';
import { chunkFile } from '../src/core/context/index/chunker.js';
import { embedderSpec, searchEnabled } from '../src/core/context/index/config.js';
import { formatEvalReport, runLocalisationEval } from '../src/core/context/index/evalLocalisation.js';
import { providerTools } from '../src/core/tools/registry.js';
import '../src/core/tools/providers.js';
import { getCliCommand } from '../src/core/commands.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { Agent } from '../src/core/agent/agent.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';
import { lastToolResult, startMockServer, testConfig, tmpWorkspace } from './helpers.js';
import { startMockEmbeddings, type MockEmbedServer } from './code-search-helpers.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oh-idx-home-'));
const cfgWith = (h: string, srv?: MockEmbedServer, over: any = {}) => deepMerge(defaultConfig(), deepMerge({ homeDir: h, ...(srv ? { profiles: { embed: { baseUrl: srv.url, model: 'mock-embed' } }, search: { embeddings: { profile: 'embed' } } } : {}) }, over));
const policy = (ws: string, extra: any = {}) => new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: [], additionalDirectories: [], ...extra } as any);

/** Copy this repository's sources (tracked + untracked, not ignored) into a temp dir. */
function copyOfRepo(): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-idx-repo-'));
  for (const d of ['src', 'docs', 'vscode/src', 'scripts', 'test', 'evals/editing', 'research']) if (fs.existsSync(d)) fs.cpSync(d, path.join(dst, d), { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}evidence${path.sep}`) });
  for (const f of ['README.md', 'AGENTS.md', 'package.json']) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dst, f));
  return dst;
}

test('N2 AC1: with a mock embedding server the index of this repo builds in < 60 s and updates in < 2 s after one file changes', { timeout: 180_000 }, async () => {
  const srv = await startMockEmbeddings();
  try {
    const ws = copyOfRepo();
    const cfg = cfgWith(home(), srv);
    const t0 = Date.now();
    const st = await updateIndex(cfg, ws, policy(ws));
    const buildMs = Date.now() - t0;
    assert.ok(st.files > 300 && st.chunks > 2000, JSON.stringify(st));
    assert.equal(st.vectors, st.chunks, 'every chunk embedded');
    assert.ok(buildMs < 60_000, `built in ${buildMs} ms`);
    const embeddedBefore = srv.requests.reduce((a, r) => a + r.inputs, 0);
    // one file changes
    const f = path.join(ws, 'src/core/edit/diff.ts');
    fs.appendFileSync(f, '\n/** a new helper for the test */\nexport function lineCountForIndexTest(s: string): number {\n  return s.split("\\n").length;\n}\n');
    forgetIndexes(); // also proves the index reloads from disk
    const t1 = Date.now();
    const up = await updateIndex(cfg, ws, policy(ws));
    const updateMs = Date.now() - t1;
    assert.ok(updateMs < 2000, `updated in ${updateMs} ms`);
    assert.equal(up.changedFiles, 1);
    const embeddedNow = srv.requests.reduce((a, r) => a + r.inputs, 0) - embeddedBefore;
    assert.ok(embeddedNow >= 1 && embeddedNow <= 5, `only the changed chunks are re-embedded (${embeddedNow})`);
    const idx = codeIndexFor(cfg.homeDir, ws);
    const r = await idx.search('lineCountForIndexTest', { k: 3, embedder: embedderSpec(cfg) });
    assert.equal(r.engine, 'hybrid', `${r.note}; update ${JSON.stringify(up)}`);
    assert.equal(r.hits[0].chunk.rel, 'src/core/edit/diff.ts');
    assert.match(r.hits[0].chunk.symbol ?? '', /lineCountForIndexTest/);
    console.log(`N2 AC1: ${st.files} files, ${st.chunks} chunks, build ${buildMs} ms, update ${updateMs} ms`);
  } finally {
    await srv.close();
  }
});

test('N2: chunks follow definition boundaries (with their comments), headers and Markdown sections', async () => {
  const ts = "import fs from 'node:fs';\nimport path from 'node:path';\n\n/** Adds. */\nexport function add(a: number, b: number) {\n  return a + b;\n}\n\nexport class Box {\n  // opens it\n  open() {\n    return 1;\n  }\n\n  close() {\n    return 2;\n  }\n}\n";
  const { chunks } = await chunkFile('src/x.ts', ts);
  // the 2-line import header is too short to stand alone and joins `add` (with its doc comment); a class header joins its first method
  assert.deepEqual(chunks.map((c) => [c.startLine, c.endLine, c.symbol]), [[1, 7, 'add'], [9, 13, 'Box, Box.open'], [15, 18, 'Box.close']]);
  assert.match(chunks[0].text, /\/\*\* Adds\. \*\/\nexport function add/);
  const withHeader = await chunkFile('src/y.ts', `${"import x from 'x';\n".repeat(6)}\n// helper\nexport function y() {\n  return x;\n}\n`);
  assert.deepEqual(withHeader.chunks.map((c) => [c.startLine, c.endLine, c.symbol]), [[1, 6, undefined], [8, 11, 'y']], 'a real header is its own chunk; the comment above a definition belongs to it');
  const md = await chunkFile('docs/a.md', '# Title\nintro\n\n## Install\nnpm i\n\n## Use\nrun it\n');
  assert.deepEqual(md.chunks.map((c) => c.symbol), ['Title', 'Install', 'Use']);
  const long = await chunkFile('src/big.py', `def big():\n${'    x = 1\n'.repeat(200)}`);
  assert.ok(long.chunks.length >= 3 && long.chunks.every((c) => c.endLine - c.startLine < 80));
  assert.match(long.chunks[1].symbol!, /big \(part 2\)/);
});

test('N2 AC3: secret, .tuglineignore-d and policy-hidden files never enter the index (asserted on the stored chunks)', async () => {
  const srv = await startMockEmbeddings();
  try {
    const ws = tmpWorkspace({
      'src/app.ts': 'export function connectDatabase() {\n  return 1;\n}\n',
      'src/.env.local': 'DB_PASSWORD=hunter2-very-long-password\n',
      'src/credentials.ts': "export const AWS_SECRET = 'AKIAABCDEFGHIJKLMNOP';\n",
      'config/id_rsa.pem': '-----BEGIN PRIVATE KEY-----\nabc\n',
      'private/vault.ts': 'export function openVaultSecretly() {}\n',
      'blocked/b.ts': 'export function blockedByPolicy() {}\n',
      'build/out.js': 'function builtArtifact() {}\n',
      'src/inline.ts': "export const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';\nexport function useToken() {\n  return token;\n}\n",
      '.tuglineignore': 'private/\n',
    });
    const cfg = cfgWith(home(), srv);
    // the policy denies reads under blocked/ (a deny rule)
    const pol = policy(ws, { deny: ['read(blocked/**)'] });
    await updateIndex(cfg, ws, pol);
    const stored = codeIndexFor(cfg.homeDir, ws).storedChunks();
    const files = [...new Set(stored.map((c) => c.rel))].sort();
    assert.deepEqual(files, ['src/app.ts', 'src/inline.ts']);
    const disk = fs.readdirSync(indexDir(cfg.homeDir, ws)).map((f) => fs.readFileSync(path.join(indexDir(cfg.homeDir, ws), f)).toString('latin1')).join('\n');
    for (const leak of ['hunter2', 'AKIA', 'PRIVATE KEY', 'openVaultSecretly', 'blockedByPolicy', 'builtArtifact', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) assert.ok(!disk.includes(leak), `index must not contain ${leak}`);
    // nor what was sent to the embedder: secrets in visible files are redacted first
    // (the request log only counts inputs, so check the chunk text that is embedded)
    assert.match(stored.find((c) => c.rel === 'src/inline.ts')!.text, /\[REDACTED\]/);
    // a file that becomes ignored later is dropped on the next update
    fs.appendFileSync(path.join(ws, '.tuglineignore'), 'src/inline.ts\n');
    const st = await updateIndex(cfg, ws, pol);
    assert.equal(st.removedFiles, 1);
    assert.deepEqual([...new Set(codeIndexFor(cfg.homeDir, ws).storedChunks().map((c) => c.rel))], ['src/app.ts']);
    // C5 policy-hidden (gitignored) paths too
    const ws2 = tmpWorkspace({ '.gitignore': 'gen/\n', 'gen/schema.ts': 'export function generatedSchema() {}\n', 'src/ok.ts': 'export function visibleOne() {}\n' });
    await updateIndex(cfg, ws2, policy(ws2));
    assert.deepEqual(codeIndexFor(cfg.homeDir, ws2).storedChunks().map((c) => c.rel), ['src/ok.ts'], 'gitignored files are hidden by the policy (C5 isHidden)');
  } finally {
    await srv.close();
  }
});

test('N2 AC5: code_search is exposed only with an embedder or opt-in BM25 mode; an unreachable embedder degrades to BM25', async () => {
  const srv = await startMockEmbeddings();
  try {
    const ws = tmpWorkspace({ 'src/retry.ts': '/** exponential backoff for flaky calls */\nexport async function withBackoff(fn: () => Promise<number>) {\n  return fn();\n}\n', 'src/cart.ts': 'export class Cart {\n  add() {}\n}\n' });
    const env = { workspace: ws, homeDir: ws, depth: 0 };
    const has = async (cfg: any) => (await providerTools(cfg, env)).some((t) => t.name === 'code_search');
    assert.equal(await has(cfgWith(home())), false, 'no embedder: hidden');
    assert.equal(searchEnabled(cfgWith(home())), undefined);
    assert.equal(await has(cfgWith(home(), undefined, { search: { mode: 'bm25' } })), true, 'BM25-only is opt-in');
    assert.equal(await has(cfgWith(home(), srv)), true, 'embedder configured: hybrid');
    assert.equal(await has(cfgWith(home(), srv, { search: { mode: 'off' } })), false);
    assert.equal(await has(cfgWith(home(), undefined, { search: { embeddings: { profile: 'missing' } } })), false, 'a profile that does not exist is not an embedder');
    // hybrid result
    const cfg = cfgWith(home(), srv);
    const ctx: any = { workspace: ws, config: cfg, policy: policy(ws), emit: () => undefined, signal: new AbortController().signal };
    const r = await codeSearchTool.run({ query: 'retry with exponential backoff' }, ctx);
    assert.match(r.output, /^code_search \(hybrid: BM25 \+ mock-embed embeddings; 2 files, \d+ chunks, 2 re-indexed\)\n1\. src\/retry\.ts:1-4 {2}withBackoff\n/, r.output);
    // the embedder goes down: same answer by keywords, with a note
    srv.failWith = 503;
    const r2 = await codeSearchTool.run({ query: 'retry with exponential backoff' }, ctx);
    assert.match(r2.output, /^code_search \(keyword \(BM25\)[^\n]*\n\(note: embeddings endpoint .* answered 503[^\n]*keyword \(BM25\) ranking only\)\n1\. src\/retry\.ts:1-4/, r2.output);
    // path scoping
    srv.failWith = 0;
    const r3 = await codeSearchTool.run({ query: 'add', path: 'src/cart.ts' }, ctx);
    assert.doesNotMatch(r3.output, /retry\.ts/);
  } finally {
    await srv.close();
  }
});

test('N2: code_search through the agent loop, and `tug index status|rebuild`', async () => {
  const srv = await startMockEmbeddings();
  try {
    const ws = tmpWorkspace({ 'billing/invoice.py': 'def total_with_vat(items, rate):\n    """Sum line items and add VAT."""\n    return sum(items) * (1 + rate)\n', 'auth/login.py': 'def login(user, password):\n    return check(user, password)\n' });
    const llm = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'code_search', arguments: { query: 'where is VAT added to the total', k: 3 } }] } : { content: 'found it' }));
    const config = testConfig(llm.url, { permissionMode: 'ask', agent: { repoMapTokens: 0 }, profiles: { embed: { baseUrl: srv.url, model: 'mock-embed' } }, search: { embeddings: { profile: 'embed' } } });
    const agent = await Agent.create({ workspace: ws, config, mcp: false });
    await agent.run('find the VAT code');
    await llm.close();
    assert.ok(llm.requests[0].tools.some((t: any) => t.function.name === 'code_search'));
    assert.match(lastToolResult(llm.requests[1]), /code_search \(hybrid[^\n]*\n1\. billing\/invoice\.py:1-3 {2}total_with_vat/, 'read-only: runs without a permission prompt');
    const out: string[] = [];
    const cmd = getCliCommand('index')!;
    assert.equal(await cmd.run(['status'], { config, workspace: ws, write: (t) => out.push(t) }), 0);
    assert.match(out.join('\n'), /mode: hybrid \(embedder mock-embed[\s\S]*files: 2 {2}chunks: 2 {2}vectors: 2 × 256/);
    // @codebase mention text (VS Code wiring is WS2's): only with search enabled
    assert.match((await codebaseMention(config, ws, 'VAT total'))!, /^<codebase query="VAT total" ranking="hybrid">\n1\. billing\/invoice\.py:1-3/);
    assert.equal(await codebaseMention(testConfig(llm.url), ws, 'VAT total'), undefined);
    // explore subagents get it (read-only)
    assert.ok(toolsForAgentType(await providerTools(config, { workspace: ws, homeDir: ws, depth: 1 }), 'explore').some((t) => t.name === 'code_search'));
    out.length = 0;
    assert.equal(await cmd.run(['rebuild'], { config, workspace: ws, write: (t) => out.push(t) }), 0);
    assert.match(out.join('\n'), /indexed 2 files → 2 chunks \(2 vectors\)/);
  } finally {
    await srv.close();
  }
});

test('N2 AC2 (CI part): the file-localisation eval (30 queries, this repo + a fixture repo) reports recall@5 for BM25 and hybrid', { timeout: 180_000 }, async () => {
  const srv = await startMockEmbeddings();
  try {
    const cfg = cfgWith(home(), srv);
    const r = await runLocalisationEval(cfg, 'evals/localisation/queries.json');
    assert.equal(r.queries, 30);
    assert.deepEqual(Object.keys(r.perRepo), ['self', 'fixture']);
    assert.ok(r.perRepo.self.queries >= 10 && r.perRepo.fixture.queries >= 10);
    assert.ok(r.recallAt5.hybrid !== undefined && r.mrr.hybrid !== undefined);
    // the keyword ranker must stay useful on its own (it is the always-available baseline)
    assert.ok(r.recallAt5.bm25 >= 0.75, `BM25 recall@5 ${r.recallAt5.bm25}`);
    const md = formatEvalReport(r);
    assert.match(md, /\| BM25 \| \d+ % \| \d\.\d\d \|\n\| hybrid \(BM25 \+ embeddings, RRF\) \| \d+ % \| \d\.\d\d \|/);
    console.log(md);
    // every expected file exists (the queries stay valid as the repo changes)
    for (const q of JSON.parse(fs.readFileSync('evals/localisation/queries.json', 'utf8')).queries) {
      const root = q.repo === 'self' ? '.' : 'evals/localisation/fixture';
      assert.ok(q.expect.some((f: string) => fs.existsSync(path.join(root, f))), `${q.query}: ${q.expect}`);
    }
  } finally {
    await srv.close();
  }
});

test('N2 AC4 (suite validity): evals/find-the-code has tasks that fail unfixed, never name the file, and two arms', () => {
  const suite = JSON.parse(fs.readFileSync('evals/find-the-code/suite.json', 'utf8'));
  assert.deepEqual(Object.keys(suite.arms), ['with_search', 'without_search']);
  assert.equal(suite.arms.without_search.search.mode, 'off');
  const tasks = fs.readdirSync('evals/find-the-code/tasks');
  assert.ok(tasks.length >= 6);
  for (const t of tasks) {
    const spec = JSON.parse(fs.readFileSync(path.join('evals/find-the-code/tasks', t, 'task.json'), 'utf8'));
    const file = spec.reachability.editable[0] as string;
    // unfixed, the acceptance command fails (run in a copy; no __pycache__ left in the suite)
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ftc-'));
    fs.cpSync(path.join('evals/find-the-code/tasks', t, 'repo'), copy, { recursive: true });
    const r = spawnSync('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider'], { cwd: copy, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.notEqual(r.status, 0, `${t} must fail before the fix:\n${r.stdout}`);
    assert.ok(!spec.prompt.includes(file) && !spec.prompt.includes(file.replace(/\.py$/, '').replace('/', '.')) && !/[a-z]+_[a-z_]+\(|\.py\b/.test(spec.prompt), `${t}: the prompt must not name ${file} or a function`);
  }
});
