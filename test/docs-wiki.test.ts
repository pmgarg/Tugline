/**
 * WS12 N8: `tug wiki` on a fixture repository with a scripted mock model:
 * pages + nav, citations validated (an invalid one dropped, a repairable one
 * repaired), invalid Mermaid removed with a note, secrets and ignored files
 * never cited, incremental update touching only the changed module's pages,
 * and the static server.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWiki, clusterModules, wikiCitations } from '../src/core/docs/wiki.js';
import { buildInventory } from '../src/core/docs/inventory.js';
import { parseCitations, validateCitation, validateDocument } from '../src/core/docs/cite.js';
import { stripInvalidMermaid, validateMermaid } from '../src/core/docs/mermaid.js';
import { serveWiki } from '../src/core/docs/render.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, type MockServer } from './helpers.js';
import { citesIn, fixtureRepo, git, promptOf } from './docs-helpers.js';

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});

/**
 * The scripted documentation model:
 *  - per file: two cited bullets; for retry.ts also a bullet citing a line that does not exist,
 *    and for read.ts a bullet citing .env (a secret file) — both must be dropped;
 *  - per module: a page using the facts' citations; the llm module gets an INVALID Mermaid block,
 *    the agent module a valid sequence diagram;
 *  - overview: one cited sentence.
 */
function docModel(): Promise<MockServer> {
  return startMockServer((body) => {
    const p = promptOf(body);
    const file = /^File: (\S+) \((\d+) lines/m.exec(p);
    if (file) {
      const [, rel, n] = file;
      const end = Math.min(Number(n), 3);
      const extra = rel.endsWith('retry.ts') ? `\n- It also caches results forever (${rel}:900-950)` : rel.endsWith('read.ts') ? '\n- The API key is in the environment file (.env:1)' : '';
      return { content: `- ${path.basename(rel)} implements part of the ${rel.split('/')[1]} module (${rel}:1-${end})\n- It exports its main function (${rel}:${Math.max(1, Number(n) - 2)}-${n})${extra}` };
    }
    const mod = /^Module: (\S+)/m.exec(p);
    if (mod) {
      const cites = citesIn(p);
      const diagram = mod[1] === 'src/llm'
        ? '\n```mermaid\nsequenceDiagram\n  this is not mermaid at all\n```\n'
        : mod[1] === 'src/agent'
          ? '\n```mermaid\nsequenceDiagram\n  participant Loop\n  participant Client\n  Loop->>Client: complete(prompt)\n  Client-->>Loop: reply\n```\n'
          : '';
      return { content: `## Purpose\nThe ${mod[1]} module groups related code (${cites[0]}).\n\n## Key components\n${cites.map((c) => `- See ${c.split(':')[0]} (${c})`).join('\n')}\n\n## How it works\nIt is called by other modules, as the code shows (${cites[1] ?? cites[0]}).\nThis sentence has no citation and must be removed.\n${diagram}` };
    }
    if (/architecture overview/.test(p)) {
      const cites = citesIn(p);
      return { content: `The repository is a small agent with a CLI, a loop and an LLM client (${cites[0]}). Its configuration has defaults (${cites[cites.length - 1]}).` };
    }
    return { content: 'unexpected prompt' };
  });
}

async function setup() {
  const ws = fixtureRepo();
  const srv = await docModel();
  closers.push(srv.close);
  const config = testConfig(srv.url, { docs: { wiki: { maxPages: 30 } } });
  return { ws, srv, config };
}

test('N8 AC1: build produces ≥ 8 pages and a valid nav tree; every citation resolves to an existing line range', async () => {
  const { ws, config } = await setup();
  const r = await buildWiki({ config, workspace: ws });
  assert.ok(r.pages.length >= 8, `pages: ${r.pages.map((p) => p.path)}`);
  for (const p of r.pages) assert.ok(fs.existsSync(path.join(r.outDir, p.path)), `${p.path} exists`);
  // nav: every node points at a written page
  const nav = JSON.parse(fs.readFileSync(path.join(r.outDir, 'nav.json'), 'utf8'));
  const flat = (ns: any[]): any[] => ns.flatMap((n) => [n, ...flat(n.children ?? [])]);
  for (const n of flat(nav)) assert.ok(fs.existsSync(path.join(r.outDir, n.path.split('#')[0])), `nav → ${n.path}`);
  assert.ok(flat(nav).some((n) => n.path === 'modules/src-agent.md'));
  // citations: present, with @sha, all resolving
  const cites = wikiCitations(r.outDir);
  assert.ok(cites.length >= 20, `citations: ${cites.length}`);
  const sha = git(ws, 'rev-parse', '--short=7', 'HEAD');
  assert.ok(fs.readFileSync(path.join(r.outDir, 'modules/src-agent.md'), 'utf8').includes(`@${sha}`), 'citations carry the commit sha');
  for (const c of cites) {
    const abs = path.join(ws, c.path);
    assert.ok(fs.existsSync(abs), `${c.page}: ${c.path} exists`);
    const n = fs.readFileSync(abs, 'utf8').split('\n').length - 1;
    assert.ok(c.start >= 1 && c.start <= c.end && c.end <= n, `${c.page}: ${c.path}:${c.start}-${c.end} within 1..${n}`);
  }
  // the invalid citation was dropped (and its claim removed), the uncited sentence too
  assert.ok(r.stats.dropped >= 2, `dropped ${r.stats.dropped}`);
  assert.ok(r.stats.droppedRefs.some((d) => /retry\.ts:900-950/.test(d)), r.stats.droppedRefs.join('\n'));
  const all = fs.readdirSync(path.join(r.outDir, 'modules')).map((f) => fs.readFileSync(path.join(r.outDir, 'modules', f), 'utf8')).join('\n');
  assert.ok(!/caches results forever/.test(all), 'the claim with the invalid citation is gone');
  assert.ok(!/has no citation and must be removed/.test(all), 'uncited claims are removed');
  assert.ok(/statement\(s\) were removed/.test(all), 'with a note');
  // deterministic architecture graph from the import edges
  const arch = fs.readFileSync(path.join(r.outDir, 'architecture.md'), 'utf8');
  assert.match(arch, /src_agent --> src_llm/);
  assert.match(arch, /src_cli --> src_agent/);
  assert.ok(validateMermaid(/```mermaid\n([\s\S]*?)```/.exec(arch)![1]).ok);
  // glossary with definition citations
  assert.match(fs.readFileSync(path.join(r.outDir, 'glossary.md'), 'utf8'), /\*\*runLoop\*\* \(function, \[src\/agent\]\(modules\/src-agent\.md\)\): Runs the agent loop/);
});

test('N8 AC2: invalid Mermaid is detected and removed with a note; a valid diagram is kept', async () => {
  const { ws, config } = await setup();
  const r = await buildWiki({ config, workspace: ws });
  assert.equal(r.mermaidRemoved, 1);
  const llm = fs.readFileSync(path.join(r.outDir, 'modules/src-llm.md'), 'utf8');
  assert.ok(!/this is not mermaid/.test(llm));
  assert.match(llm, /Note: a generated diagram was removed because it is not valid Mermaid/);
  const agent = fs.readFileSync(path.join(r.outDir, 'modules/src-agent.md'), 'utf8');
  assert.match(agent, /```mermaid\nsequenceDiagram\n {2}participant Loop/);
  // unit: the validator
  assert.equal(validateMermaid('graph TD\n  A[x] --> B(y)').ok, true);
  assert.equal(validateMermaid('graph TD\n  A --> B[unclosed').ok, false);
  assert.equal(validateMermaid('pie\n  "a": 1').ok, false);
  assert.equal(stripInvalidMermaid('x\n```mermaid\nflowchart LR\n  a -> b\n```\n').removed.length, 1);
});

test('N8 AC3: after a commit touching one module, update regenerates only that module\'s pages', async () => {
  const { ws, srv, config } = await setup();
  const first = await buildWiki({ config, workspace: ws });
  const dir = first.outDir;
  const snap = () => Object.fromEntries(['index.md', 'architecture.md', ...fs.readdirSync(path.join(dir, 'modules')).map((f) => `modules/${f}`)].map((p) => [p, fs.readFileSync(path.join(dir, p), 'utf8')]));
  const before = snap();
  // a no-op update touches nothing and calls no model
  const n0 = srv.requests.length;
  const noop = await buildWiki({ config, workspace: ws });
  assert.equal(srv.requests.length, n0, 'no model calls when nothing changed');
  assert.deepEqual(noop.written, []);
  // change one file of src/llm and commit
  fs.appendFileSync(path.join(ws, 'src/llm/retry.ts'), '\n/** Backoff in milliseconds. */\nexport const BACKOFF_MS = 250;\n');
  git(ws, 'commit', '-qam', 'retry: backoff constant');
  const n1 = srv.requests.length;
  const upd = await getCliCommand('wiki')!.run(['update'], { config, workspace: ws, write: () => {} });
  assert.equal(upd ?? 0, 0);
  const prompts = srv.requests.slice(n1).map(promptOf);
  assert.ok(prompts.length >= 2, 'the changed file was re-summarised and its module page rewritten');
  assert.ok(prompts.every((p) => /src\/llm/.test(p)), `only src/llm prompts: ${prompts.map((p) => p.split('\n')[0])}`);
  assert.ok(prompts.some((p) => /^File: src\/llm\/retry\.ts/m.test(p)) && !prompts.some((p) => /^File: src\/llm\/client\.ts/m.test(p)), 'only the changed file is re-summarised');
  const after = snap();
  for (const [p, text] of Object.entries(before)) {
    if (p === 'modules/src-llm.md') assert.notEqual(after[p], text, 'the changed module page was regenerated');
    else assert.equal(after[p], text, `${p} unchanged`);
  }
  assert.match(after['modules/src-llm.md'], /retry\.ts/);
  // the glossary cites the changed file, so it is refreshed (BACKOFF_MS appears)
  assert.match(fs.readFileSync(path.join(dir, 'glossary.md'), 'utf8'), /BACKOFF_MS/);
});

test('N8 AC4: secret and ignored files are never cited or quoted', async () => {
  const { ws, srv, config } = await setup();
  const r = await buildWiki({ config, workspace: ws });
  const sent = srv.requests.map(promptOf).join('\n');
  assert.ok(!sent.includes('sk-secret-env') && !sent.includes('sk-live-not-for-docs'), 'secret and ignored contents never reach the model');
  assert.ok(!/src\/private\/keys\.ts/.test(sent), 'the ignored file is not even listed');
  const cites = wikiCitations(r.outDir);
  assert.ok(!cites.some((c) => c.path === '.env' || c.path.startsWith('src/private/')));
  const pages = fs.readdirSync(r.outDir, { recursive: true }).filter((f) => String(f).endsWith('.md')).map((f) => fs.readFileSync(path.join(r.outDir, String(f)), 'utf8')).join('\n');
  assert.ok(!/sk-secret-env|sk-live-not-for-docs|\.env:1/.test(pages));
  assert.ok(r.stats.droppedRefs.some((d) => /^\.env:1/.test(d)), 'the model\'s citation of .env was dropped');
  // inventory rule, directly
  const inv = buildInventory(ws);
  assert.ok(!inv.byRel.has('.env') && !inv.byRel.has('src/private/keys.ts'));
});

test('N8: citation validation units — repair by unique basename, end past EOF, symbol in claim; drop unknown files', () => {
  const ws = fixtureRepo();
  const inv = buildInventory(ws);
  assert.deepEqual(validateCitation({ path: 'retry.ts', start: 1, end: 2 }, inv).cite, { path: 'src/llm/retry.ts', start: 1, end: 2 });
  assert.equal(validateCitation({ path: 'src/llm/retry.ts', start: 2, end: 99 }, inv).cite?.end, 6);
  assert.equal(validateCitation({ path: 'src/llm/retry.ts', start: 300, end: 310 }, inv, 'withRetry retries').cite?.start, 2);
  assert.equal(validateCitation({ path: 'src/nope.ts', start: 1, end: 1 }, inv).cite, undefined);
  assert.equal(validateCitation({ path: '.env', start: 1, end: 1 }, inv).cite, undefined);
  assert.deepEqual(parseCitations('see (src/a.ts:3-5) and `b.py:7` and c.go#L2-L4').map((c) => `${c.cite.path}:${c.cite.start}-${c.cite.end}`), ['src/a.ts:3-5', 'b.py:7-7', 'c.go:2-4']);
  assert.equal(parseCitations('listening on 127.0.0.1:8080 and example.com:443').length, 0, 'hosts are not citations');
  const v = validateDocument('- good (src/fs/read.ts:1-2)\n- bad (src/fs/read.ts:50-60)\n## Heading\nLead-in:', inv);
  assert.equal(v.text, '- good (`src/fs/read.ts:1-2`)\n## Heading\nLead-in:');
});

test('N8: modules are clustered from directories (≤ maxPages) and steered by .tugline/wiki.json', () => {
  const ws = fixtureRepo({ '.tugline/wiki.json': JSON.stringify({ pages: [{ title: 'Runtime', paths: ['src/agent/**', 'src/llm/**'], notes: 'the core' }] }) });
  const inv = buildInventory(ws);
  const steering = JSON.parse(fs.readFileSync(path.join(ws, '.tugline/wiki.json'), 'utf8'));
  const mods = clusterModules(inv.files, steering, 30);
  const rt = mods.find((m) => m.title === 'Runtime')!;
  assert.deepEqual(rt.files, ['src/agent/loop.ts', 'src/agent/tools.ts', 'src/llm/client.ts', 'src/llm/retry.ts']);
  assert.equal(rt.notes, 'the core');
  assert.ok(clusterModules(inv.files, {}, 3).length <= 3);
});

test('N8: tug wiki serve renders pages on 127.0.0.1 and shows only readable cited sources', async () => {
  const { ws, config } = await setup();
  const r = await buildWiki({ config, workspace: ws });
  const s = await serveWiki(ws, r.outDir);
  closers.push(s.close);
  assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const home = await (await fetch(s.url)).text();
  assert.match(home, /<nav>/);
  assert.match(home, /href="\/modules\/src-agent\.md"/);
  const page = await (await fetch(`${s.url}modules/src-agent.md`)).text();
  const src = /href="(\/__source\/src\/agent\/loop\.ts[^"]*)"/.exec(page);
  assert.ok(src, 'source links go to the source viewer');
  const view = await (await fetch(new URL(src![1], s.url))).text();
  assert.match(view, /runLoop/);
  assert.equal((await fetch(`${s.url}__source/.env`)).status, 404, 'secret files are not served');
  assert.equal((await fetch(`${s.url}__source/src/private/keys.ts`)).status, 404, 'ignored files are not served');
  assert.equal((await fetch(`${s.url}..%2f..%2fetc/passwd`)).status, 404);
});

test('N8 AC1: on THIS repository (src/), build produces ≥ 8 pages and a valid nav tree; every citation resolves', async () => {
  const ws = process.cwd();
  const srv = await docModel();
  closers.push(srv.close);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-wiki-self-'));
  const r = await buildWiki({ config: testConfig(srv.url), workspace: ws, outDir, steering: { include: ['src/**'] } });
  assert.ok(r.pages.length >= 8, `${r.pages.length} pages`);
  const nav = JSON.parse(fs.readFileSync(path.join(outDir, 'nav.json'), 'utf8'));
  const flat = (ns: any[]): any[] => ns.flatMap((n) => [n, ...flat(n.children ?? [])]);
  for (const n of flat(nav)) assert.ok(fs.existsSync(path.join(outDir, n.path.split('#')[0])), `nav → ${n.path}`);
  assert.ok(r.pages.filter((p) => p.kind === 'module').length <= 30, 'at most 30 module pages');
  const cites = wikiCitations(outDir);
  assert.ok(cites.length > 100, `${cites.length} citations`);
  for (const c of cites) {
    const n = fs.readFileSync(path.join(ws, c.path), 'utf8').split('\n').length;
    assert.ok(c.start >= 1 && c.start <= c.end && c.end <= n, `${c.page}: ${c.path}:${c.start}-${c.end}`);
  }
});

test('N8 (VS Code): the wiki webview HTML maps page links to #wiki: and citations to #src:, under a nonce CSP', async () => {
  const { ws, config } = await setup();
  const r = await buildWiki({ config, workspace: ws });
  const { wikiWebviewHtml } = await import('../vscode/src/wikiHtml.js');
  const html = wikiWebviewHtml(ws, r.outDir, 'modules/src-agent.md', 'N0NCE', 'vscode-resource:');
  assert.match(html, /script-src 'nonce-N0NCE'/);
  assert.match(html, /<script nonce="N0NCE">/);
  assert.match(html, /href="#wiki:modules\/src-llm\.md"/, 'wiki links stay in the panel');
  assert.match(html, /href="#src:src\/agent\/loop\.ts#L1"/, 'citations open the source');
  assert.match(html, /href="#wiki:index\.md"/, 'nav');
  assert.match(wikiWebviewHtml(ws, r.outDir, '../../../etc/passwd', 'n', 'x'), /Not found/);
});

test('N8 AC5 (harness): tug wiki judge scores each page against its cited source, anonymised, strict JSON; fails below the threshold', async () => {
  const { ws, config } = await setup();
  await buildWiki({ config, workspace: ws });
  const prompts: string[] = [];
  const judge = await startMockServer((b) => {
    const p = promptOf(b);
    prompts.push(p);
    if (/page="modules\/src-fs\.md"/.test(p)) return { content: 'not json at all' };
    return { content: /page="index\.md"/.test(p) ? '{"accuracy": 3, "coverage": 4, "unsupported": ["the CLI claim"]}' : 'Verdict: {"accuracy": 5, "coverage": 4, "unsupported": [], "notes": "ok"}' };
  });
  closers.push(judge.close);
  const cfg = testConfig(judge.url, { profiles: { judge: { baseUrl: judge.url, model: 'judge-model', contextWindow: 32768, maxOutputTokens: 512, toolMode: 'text' } } });
  const out: string[] = [];
  const code = await getCliCommand('wiki')!.run(['judge', '--judge', 'judge'], { config: cfg, workspace: ws, write: (t) => out.push(t) });
  const rep = out.join('\n');
  assert.equal(code, 1, 'an unparseable verdict means the run cannot pass');
  assert.match(rep, /\| modules\/src-fs\.md \| unparseable \|/);
  assert.match(rep, /\| index\.md \| 3 \| 4 \| the CLI claim \|/);
  assert.match(rep, /Judge: judge-model/);
  // anonymised and wrapped: the page and its cited lines are data; no model name of the writer
  assert.ok(prompts.every((p) => /<untrusted_wiki_page page=/.test(p) && !/mock-model/.test(p)));
  assert.ok(prompts.some((p) => /<untrusted_source path="src\/agent\/loop\.ts"/.test(p)));
  // all parseable and ≥ 4 → pass
  const { judgeWiki } = await import('../src/core/docs/judge.js');
  const good = await startMockServer(() => ({ content: '{"accuracy": 4.5, "coverage": 4, "unsupported": []}' }));
  closers.push(good.close);
  const j = await judgeWiki({ config: testConfig(good.url), workspace: ws });
  assert.equal(j.pass, true);
  assert.equal(j.meanAccuracy, 4.5);
});
