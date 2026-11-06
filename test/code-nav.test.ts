/**
 * WS1 v1.1 N3: code navigation tools (code_definition, code_references,
 * code_symbols, code_rename_preview) over three backends: the host's language
 * features (mock of the VS Code contract), a real language server
 * (typescript-language-server, a devDependency), and name matching.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { codeDefinitionTool, codeReferencesTool, codeRenamePreviewTool, codeSymbolsTool, NAV_TOOLS } from '../src/core/nav/tools.js';
import { sessionClients, stopAllServers } from '../src/core/nav/servers.js';
import { clearNavCache, maskNonCode } from '../src/core/nav/fallback.js';
import { providerTools } from '../src/core/tools/registry.js';
import '../src/core/tools/providers.js';
import { registerCommandWrapper, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { editFileTool, readFileTool } from '../src/core/tools/fs.js';
import { diskHost, type NavRequest, type NavResult, type WorkspaceHost } from '../src/core/host/workspace.js';
import { Agent } from '../src/core/agent/agent.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';
import { lastToolResult, startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const req = createRequire(import.meta.url);
const TSLS = ['node', req.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'];
const TSSERVER = { tsserver: { path: req.resolve('typescript/lib/tsserver.js') } };
const LSP_CFG = { lsp: { servers: { typescript: { command: TSLS, initializationOptions: TSSERVER } } } };

const TS_FILES: Record<string, string> = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","noEmit":true},"include":["src"]}',
  'src/math.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Calc {\n  total = 0;\n  push(n: number): this {\n    this.total = add(this.total, n);\n    return this;\n  }\n}\n',
  'src/a.ts': "import { add } from './math';\nexport const x = add(1, 2);\n",
  'src/b.ts': "import { add, Calc } from './math';\n// add is mentioned in a comment\nexport function twice(n: number) {\n  return add(n, n) + new Calc().push(1).total;\n}\nconst label = 'add';\n",
  'src/private/c.ts': "import { add } from '../math';\nexport const hidden = add(5, 5);\n",
  'src/.env.ts': "import { add } from './math';\nexport const SECRET = add(7, 7);\n",
  '.tuglineignore': 'src/private/\n',
};

function policy(ws: string) {
  return new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] } as any);
}

function ctxFor(ws: string, over: any = {}, host?: WorkspaceHost): any {
  const config = deepMerge(defaultConfig(), over);
  return { workspace: ws, config, policy: policy(ws), sessionId: `nav-${path.basename(ws)}`, host: host ?? diskHost, emit: () => undefined, signal: new AbortController().signal };
}

const rel = (out: string) => [...out.matchAll(/^(src\/[^:]+):(\d+):/gm)].map((m) => `${m[1]}:${m[2]}`);

test('N3: fallback name matching finds definitions and references with scope rules (no LSP configured)', async () => {
  clearNavCache();
  const ws = tmpWorkspace({
    ...TS_FILES,
    'src/other.ts': "function add(x: string) {\n  return x;\n}\nexport const y = add('a');\n",
    'py/lib.py': 'def helper():\n    return 1\n\nclass Store:\n    def get(self, k):\n        return helper()\n',
    'py/use.py': 'from lib import Store\nStore().get(1)\n',
  });
  const ctx = ctxFor(ws);
  const d = await codeDefinitionTool.run({ path: 'src/b.ts', line: 4, symbol: 'add' }, ctx);
  assert.match(d.output, /via name matching/);
  assert.equal(rel(d.output)[0], 'src/math.ts:1', 'the imported definition ranks first');
  const r = await codeReferencesTool.run({ symbol: 'add', path: 'src/a.ts' }, ctx);
  const refs = rel(r.output);
  assert.deepEqual(refs, ['src/math.ts:1', 'src/math.ts:8', 'src/a.ts:1', 'src/a.ts:2', 'src/b.ts:1', 'src/b.ts:4'], r.output);
  assert.ok(!r.output.includes('src/other.ts'), 'a file with its own `add` is shadowed');
  assert.ok(!/b\.ts:2:|b\.ts:6:/.test(r.output), 'comments and strings never count');
  // N3 AC3: ignored (.tuglineignore) and secret files are never even scanned by the fallback
  assert.ok(!r.output.includes('private/') && !r.output.includes('.env'), r.output);
  // methods: qualified uses only, in files that mention the class
  const m = await codeReferencesTool.run({ symbol: 'get', path: 'py/lib.py' }, ctx);
  assert.match(m.output, /py\/lib\.py:5:[\s\S]*py\/use\.py:2:/);
  // python definitions
  const pd = await codeDefinitionTool.run({ symbol: 'helper' }, ctx);
  assert.match(pd.output, /py\/lib\.py:1: def helper\(\):/);
  // outline and workspace symbols
  const sy = await codeSymbolsTool.run({ path: 'src/math.ts' }, ctx);
  assert.match(sy.output, /1 {2}function add[\s\S]*5 {2}class Calc[\s\S]*7 {4}method Calc\.push/);
  const ws2 = await codeSymbolsTool.run({ query: 'tw' }, ctx);
  assert.match(ws2.output, /src\/b\.ts:3: function twice/);
  // rename preview writes nothing
  const before = fs.readFileSync(path.join(ws, 'src/a.ts'), 'utf8');
  const rn = await codeRenamePreviewTool.run({ path: 'src/math.ts', line: 1, symbol: 'add', new_name: 'sum' }, ctx);
  assert.match(rn.output, /preview only[\s\S]*src\/a\.ts:2:\n {2}- export const x = add\(1, 2\);\n {2}\+ export const x = sum\(1, 2\);/);
  assert.equal(fs.readFileSync(path.join(ws, 'src/a.ts'), 'utf8'), before);
  // a masked line keeps its length (positions stay valid)
  const src = "const s = 'a // b'; // add\nx = `t ${add}`;";
  assert.equal(maskNonCode(src, 'ts').length, src.length);
});

test('N3 AC1 (mock of the VS Code contract): host.navigate answers definition and references; results are filtered by policy', async () => {
  const ws = tmpWorkspace(TS_FILES);
  const calls: NavRequest[] = [];
  const p = (f: string) => path.join(ws, f);
  const host: WorkspaceHost = {
    ...diskHost,
    kind: 'vscode',
    readText: diskHost.readText.bind(diskHost),
    writeText: diskHost.writeText.bind(diskHost),
    exists: diskHost.exists.bind(diskHost),
    delete: diskHost.delete.bind(diskHost),
    async navigate(r: NavRequest): Promise<NavResult | undefined> {
      calls.push(r);
      if (r.op === 'definition') return { locations: [{ path: p('src/math.ts'), line: 1, col: 17 }] };
      if (r.op === 'references')
        return { locations: [p('src/math.ts:1'), p('src/math.ts:8'), p('src/a.ts:1'), p('src/a.ts:2'), p('src/b.ts:1'), p('src/b.ts:4'), p('src/private/c.ts:2'), p('src/.env.ts:2')].map((s) => ({ path: s.split(':')[0], line: Number(s.split(':')[1]), col: 1 })) };
      return undefined;
    },
  };
  const ctx = ctxFor(ws, {}, host);
  const d = await codeDefinitionTool.run({ path: 'src/b.ts', line: 4, symbol: 'add' }, ctx);
  assert.match(d.output, /via vscode language features\nsrc\/math\.ts:1: export function add/);
  assert.deepEqual(calls[0], { op: 'definition', path: p('src/b.ts'), line: 4, col: 10 }, 'symbol → column of the use');
  const r = await codeReferencesTool.run({ path: 'src/b.ts', line: 4, col: 10 }, ctx);
  assert.deepEqual(rel(r.output), ['src/math.ts:1', 'src/math.ts:8', 'src/a.ts:1', 'src/a.ts:2', 'src/b.ts:1', 'src/b.ts:4']);
  assert.match(r.output, /\(2 location\(s\) in secret, ignored or unreadable files omitted\)/, 'N3 AC3 for host results');
  // an editor without an answer hands over to name matching
  const s = await codeDefinitionTool.run({ symbol: 'twice' }, ctx);
  assert.match(s.output, /via name matching[\s\S]*src\/b\.ts:3:/);
});

test('N3 AC4: the tools are hidden when no backend covers a workspace language; a missing server is an actionable error', async () => {
  const docs = tmpWorkspace({ 'README.md': '# docs only\n', 'notes.txt': 'x\n' });
  const env = (w: string) => ({ workspace: w, homeDir: w, depth: 0 });
  const names = async (w: string, cfg: any = {}) => (await providerTools(deepMerge(defaultConfig(), cfg), env(w))).map((t) => t.name).filter((n) => n.startsWith('code_') && n !== 'code_search');
  const all = NAV_TOOLS.map((t) => t.name);
  const code = tmpWorkspace(TS_FILES);
  // default "auto": only when a configured server matches a workspace language
  assert.deepEqual(await names(code), [], 'no server configured: hidden (keeps the default session under the tool-search threshold)');
  assert.deepEqual(await names(code, { lsp: { servers: { python: true } } }), [], 'a server for a language the workspace does not have');
  assert.deepEqual(await names(code, { lsp: { servers: { typescript: true } } }), all);
  assert.deepEqual(await names(docs, { lsp: { servers: { markdown: { command: ['mdls'], extensions: ['.md'] } } } }), all, 'a configured server for .md exposes them');
  // explicit opt-in to name matching: any language the fallback understands
  assert.deepEqual(await names(code, { lsp: { enabled: true } }), all);
  assert.deepEqual(await names(docs, { lsp: { enabled: true } }), [], 'no backend understands a docs-only workspace');
  assert.deepEqual(await names(code, { lsp: { enabled: false, servers: { typescript: true } } }), []);
  // the core flag: definition/references stay loaded under tool search, the others are deferred
  assert.deepEqual(NAV_TOOLS.filter((t) => t.core).map((t) => t.name), ['code_definition', 'code_references']);
  // missing binary: actionable message, then the fallback answers
  const ctx = ctxFor(code, { lsp: { servers: { typescript: true } } });
  ctx.config.lsp.servers = { typescript: { command: ['oh-no-such-language-server-xyz', '--stdio'] } };
  const r = await codeDefinitionTool.run({ path: 'src/b.ts', line: 4, symbol: 'add' }, ctx);
  assert.match(r.output, /language server "typescript" \(oh-no-such-language-server-xyz --stdio\) failed: oh-no-such-language-server-xyz not found on PATH\. Install it \(npm i -g typescript-language-server typescript\) or change lsp\.servers\.typescript/);
  assert.match(r.output, /via name matching[\s\S]*src\/math\.ts:1:/);
  await stopAllServers();
});

test('N3 AC2+AC3: with typescript-language-server the CLI returns the same results, under the command wrappers; killed at session end', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace(TS_FILES);
  const spawned: string[][] = [];
  registerCommandWrapper('test-nav-record', () => (spec) => {
    spawned.push([spec.file, ...spec.args]);
    return spec;
  });
  try {
    // through the agent loop: the model asks for references, then for the definition
    const srv = await startMockServer((_b, i) =>
      i === 0 ? { toolCalls: [{ name: 'code_references', arguments: { path: 'src/b.ts', line: 4, symbol: 'add' } }] } : i === 1 ? { toolCalls: [{ name: 'code_definition', arguments: { path: 'src/a.ts', line: 2, symbol: 'add' } }] } : { content: 'done' },
    );
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0 }, ...LSP_CFG }), mcp: false });
    await agent.run('where is add used?');
    const refs = lastToolResult(srv.requests[1]);
    const def = lastToolResult(srv.requests[2]);
    await srv.close();
    assert.match(refs, /via lsp: typescript/, refs);
    // the 3 call sites (a.ts:2 and b.ts:4 twice) plus the declaration, the internal use and the imports — same set as the editor mock
    assert.deepEqual(rel(refs).sort(byFileThenLine), ['src/math.ts:1', 'src/math.ts:8', 'src/a.ts:1', 'src/a.ts:2', 'src/b.ts:1', 'src/b.ts:4']);
    assert.match(refs, /src\/b\.ts:4: return add\(n, n\) \+ new Calc\(\)\.push\(1\)\.total;\s*$/m);
    assert.match(refs, /\(2 location\(s\) in secret, ignored or unreadable files omitted\)/, 'AC3: tsserver found private/c.ts and .env.ts; both are dropped');
    assert.ok(!refs.includes('private/') && !refs.includes('.env'));
    assert.match(def, /via lsp: typescript\nsrc\/math\.ts:1: export function add/, def);
    // spawned through the wrapper chain (the OS sandbox registers there)
    assert.ok(spawned.some((a) => a.includes('--stdio') && a.some((x) => x.includes('typescript-language-server'))), JSON.stringify(spawned));
    const pids = sessionClients(agent.sessionId).map((c) => c.pid!);
    assert.equal(pids.length, 1);
    assert.doesNotThrow(() => process.kill(pids[0], 0), 'running during the session');
    await agent.dispose();
    assert.equal(sessionClients(agent.sessionId).length, 0);
    await waitGone(pids[0]);
  } finally {
    unregisterCommandWrapper('test-nav-record');
    await stopAllServers();
  }
});

test('N3 AC5: with a configured server, CLI A6 reports LSP diagnostics and only new ones', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ ...TS_FILES, 'src/typed.ts': "export const n: number = 1;\nexport const s: string = 2;\n" });
  const ctx = { ...ctxFor(ws, { ...LSP_CFG, edit: { diagnosticsWaitMs: 15_000 } }), ledger: new (await import('../src/core/tools/types.js')).ReadLedger(), llm: { profile: { model: 'm' } } };
  try {
    await readFileTool.run({ path: 'src/typed.ts' }, ctx);
    const r = await editFileTool.run({ path: 'src/typed.ts', old_string: 'export const n: number = 1;', new_string: 'export const n: number = true;' }, ctx);
    assert.match(r.output, /New problems after this edit[^\n]*\nL1: Type 'boolean' is not assignable to type 'number'\. \[typescript\]/, r.output);
    assert.doesNotMatch(r.output, /Type 'number' is not assignable to type 'string'/, 'the pre-existing error on line 2 is not repeated');
    // fixing it reports nothing new
    const r2 = await editFileTool.run({ path: 'src/typed.ts', old_string: 'export const n: number = true;', new_string: 'export const n: number = 3;' }, ctx);
    assert.doesNotMatch(r2.output, /New problems/, r2.output);
    // a syntax error is caught by the server too
    const r3 = await editFileTool.run({ path: 'src/typed.ts', old_string: 'export const n: number = 3;', new_string: 'export const n: number = (3;' }, ctx);
    assert.match(r3.output, /New problems after this edit[^\n]*\nL1: '\)' expected\. \[typescript\]/, r3.output);
  } finally {
    await stopAllServers();
  }
});

function byFileThenLine(a: string, b: string): number {
  const order = ['src/math.ts', 'src/a.ts', 'src/b.ts'];
  const [fa, la] = a.split(':');
  const [fb, lb] = b.split(':');
  return order.indexOf(fa) - order.indexOf(fb) || Number(la) - Number(lb);
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`language server ${pid} still running after session end`);
}
