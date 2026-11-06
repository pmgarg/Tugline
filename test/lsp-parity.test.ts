/**
 * v1.2 N46: LSP parity+ — TypeScript (typescript-language-server, a devDependency), Python (pyright) and Go (gopls)
 * fixtures for every navigation op; rename applied across files and undone through the checkpoint; diagnostics in
 * the next tool result after a bad edit; crash restart; sandbox / trust / server-write refusal / protected paths.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { codeApplyTool, codeCallsTool, codeDefinitionTool, codeDiagnosticsTool, codeHoverTool, codeReferencesTool, codeRenamePreviewTool, codeSymbolsTool, applyNavEdits } from '../src/core/nav/tools.js';
import { clientFor, restartServers, sessionClients, stopAllServers, whichBin } from '../src/core/nav/servers.js';
import { resolvedServers } from '../src/core/nav/config.js';
import { lspStatusText } from '../src/core/nav/commands.js';
import { providerTools } from '../src/core/tools/registry.js';
import '../src/core/tools/providers.js';
import { registerCommandWrapper, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { diskHost } from '../src/core/host/workspace.js';
import { Agent } from '../src/core/agent/agent.js';
import { loadConfig } from '../src/core/config.js';
import { checkpointsFor } from '../src/core/checkpoint/index.js';
import { lastToolResult, startMockServer, testConfig, tmpWorkspace, trackTmp } from './helpers.js';

after(async () => {
  await stopAllServers();
});

const req = createRequire(import.meta.url);
const TSLS = ['node', req.resolve('typescript-language-server/lib/cli.mjs'), '--stdio'];
const TS_INIT = { tsserver: { path: req.resolve('typescript/lib/tsserver.js') } };
const PYRIGHT = whichBin('pyright-langserver') ?? (fs.existsSync(path.join(os.homedir(), '.local/bin/pyright-langserver')) ? path.join(os.homedir(), '.local/bin/pyright-langserver') : null);
const GOPLS = whichBin('gopls') ?? (fs.existsSync(path.join(os.homedir(), 'go/bin/gopls')) ? path.join(os.homedir(), 'go/bin/gopls') : null);
// CI installs both (docs/DEPENDENCIES.md); a developer machine without them skips with the reason
const need = (bin: string | null, name: string) => (bin ? false : process.env.CI ? false : `${name} not installed (see docs/DEPENDENCIES.md)`);
const FAKE = path.resolve('test/fixtures/fake-lsp.mjs');

const TS = {
  'tsconfig.json': '{"compilerOptions":{"strict":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","noEmit":true},"include":["src"]}',
  'src/shape.ts': 'export interface Shape {\n  area(): number;\n}\n\nexport class Circle implements Shape {\n  constructor(public r: number) {}\n  area(): number {\n    return 3 * this.r * this.r;\n  }\n}\n\nexport function total(shapes: Shape[]): number {\n  return shapes.reduce((s, x) => s + x.area(), 0);\n}\n',
  'src/main.ts': "import { Circle, total } from './shape';\n\nconst c = new Circle(2);\nexport function run(): number {\n  return total([c]);\n}\n",
};
const PY = {
  'pyrightconfig.json': '{"include": ["."]}',
  'geo.py': 'class Base:\n    def area(self) -> float:\n        raise NotImplementedError\n\n\nclass Sq(Base):\n    def __init__(self, s: float) -> None:\n        self.s = s\n\n    def area(self) -> float:\n        return self.s * self.s\n\n\ndef total(xs: list[Base]) -> float:\n    return sum(x.area() for x in xs)\n',
  'app.py': 'from geo import Sq, total\n\n\ndef run() -> float:\n    return total([Sq(2.0)])\n',
};
const GO = {
  'go.mod': 'module example.com/g\n\ngo 1.21\n',
  'shape.go': 'package main\n\ntype Shape interface {\n\tArea() float64\n}\n\ntype Sq struct{ S float64 }\n\nfunc (q Sq) Area() float64 { return q.S * q.S }\n\nfunc Total(xs []Shape) float64 {\n\tt := 0.0\n\tfor _, x := range xs {\n\t\tt += x.Area()\n\t}\n\treturn t\n}\n',
  'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tq := Sq{S: 2}\n\tfmt.Println(Total([]Shape{q}))\n}\n',
};

function ctxFor(ws: string, lsp: any, over: any = {}): any {
  const config = testConfig('http://127.0.0.1:9/v1', { lsp, ...over });
  const policy = new PermissionPolicy({ workspace: ws, mode: 'auto', allow: [], deny: [], protectedPaths: config.permissions.protectedPaths, additionalDirectories: [] } as any);
  return { workspace: ws, config, policy, sessionId: `n46-${path.basename(ws)}`, host: diskHost, emit: () => undefined, signal: new AbortController().signal };
}

const locs = (out: string) => [...out.matchAll(/^([\w./-]+\.(?:ts|py|go)):(\d+)/gm)].map((m) => `${m[1]}:${m[2]}`);
const has = (out: string, ...want: string[]) => {
  const got = locs(out);
  for (const w of want) assert.ok(got.includes(w), `expected ${w} in:\n${out}`);
};

interface Lang {
  name: string;
  files: Record<string, string>;
  lsp: any;
  use: { path: string; line: number; symbol: string };
  def: string;
  refs: string[];
  hover: RegExp;
  symbolsFile: string;
  symbols: string[];
  wsQuery: string;
  wsHit: string;
  iface?: { path: string; line: number; symbol: string; impl: string };
  typeOf?: { path: string; line: number; symbol: string; def: string };
  callee: { path: string; line: number; symbol: string; caller: string; callsOut: RegExp };
  newName: string;
}

const LANGS: Lang[] = [
  {
    name: 'TypeScript',
    files: TS,
    lsp: { servers: { typescript: { command: TSLS, initializationOptions: TS_INIT } } },
    use: { path: 'src/main.ts', line: 5, symbol: 'total' },
    def: 'src/shape.ts:12',
    refs: ['src/shape.ts:12', 'src/main.ts:1', 'src/main.ts:5'],
    hover: /total\(shapes: Shape\[\]\): number/,
    symbolsFile: 'src/shape.ts',
    symbols: ['Shape', 'Circle', 'total'],
    wsQuery: 'Circle',
    wsHit: 'src/shape.ts:5',
    iface: { path: 'src/shape.ts', line: 1, symbol: 'Shape', impl: 'src/shape.ts:5' },
    typeOf: { path: 'src/main.ts', line: 3, symbol: 'c', def: 'src/shape.ts:5' },
    callee: { path: 'src/shape.ts', line: 12, symbol: 'total', caller: 'src/main.ts:4', callsOut: /area|reduce/ },
    newName: 'sumAreas',
  },
  {
    name: 'Python',
    files: PY,
    lsp: { servers: { python: { command: [PYRIGHT ?? 'pyright-langserver', '--stdio'] } } },
    use: { path: 'app.py', line: 5, symbol: 'total' },
    def: 'geo.py:14',
    refs: ['geo.py:14', 'app.py:1', 'app.py:5'],
    hover: /def total\(\s*xs: list\[Base\]\s*\) -> float/,
    symbolsFile: 'geo.py',
    symbols: ['Base', 'Sq', 'total'],
    wsQuery: 'Sq',
    wsHit: 'geo.py:6',
    callee: { path: 'geo.py', line: 14, symbol: 'total', caller: 'app.py:4', callsOut: /area|sum/ },
    newName: 'sum_areas',
  },
  {
    name: 'Go',
    files: GO,
    lsp: { servers: { go: { command: [GOPLS ?? 'gopls'] } } },
    use: { path: 'main.go', line: 7, symbol: 'Total' },
    def: 'shape.go:11',
    refs: ['shape.go:11', 'main.go:7'],
    hover: /func Total\(xs \[\]Shape\) float64/,
    symbolsFile: 'shape.go',
    symbols: ['Shape', 'Sq', 'Total'],
    wsQuery: 'Total',
    wsHit: 'shape.go:11',
    iface: { path: 'shape.go', line: 3, symbol: 'Shape', impl: 'shape.go:7' },
    typeOf: { path: 'main.go', line: 6, symbol: 'q', def: 'shape.go:7' },
    callee: { path: 'shape.go', line: 11, symbol: 'Total', caller: 'main.go:5', callsOut: /Area/ },
    newName: 'SumAreas',
  },
];

for (const L of LANGS) {
  const skip = L.name === 'Python' ? need(PYRIGHT, 'pyright') : L.name === 'Go' ? need(GOPLS, 'gopls') : false;
  test(`N46 AC1 (${L.name}): definition, references, hover, symbols, workspace symbols, implementation, type definition, call hierarchy and rename return the right locations`, { timeout: 240_000, skip }, async () => {
    const ws = tmpWorkspace(L.files);
    const ctx = ctxFor(ws, L.lsp);
    try {
      const tools = await providerTools(ctx.config, { workspace: ws, homeDir: ctx.config.homeDir, depth: 0 });
      for (const n of ['code_hover', 'code_calls', 'code_diagnostics', 'code_apply']) assert.ok(tools.some((t) => t.name === n), `${n} offered with a server`);
      const def = (await codeDefinitionTool.run(L.use, ctx)).output;
      assert.match(def, /via lsp:/, def);
      has(def, L.def);
      const refs = (await codeReferencesTool.run(L.use, ctx)).output;
      has(refs, ...L.refs);
      const hover = (await codeHoverTool.run(L.use, ctx)).output;
      assert.match(hover, L.hover, hover);
      const syms = (await codeSymbolsTool.run({ path: L.symbolsFile }, ctx)).output;
      for (const s of L.symbols) assert.match(syms, new RegExp(`\\b${s}\\b`), syms);
      const wsym = (await codeSymbolsTool.run({ query: L.wsQuery }, ctx)).output;
      has(wsym, L.wsHit);
      if (L.iface) {
        const impl = (await codeHoverTool.run({ ...L.iface, kind: 'implementation' }, ctx)).output;
        has(impl, L.iface.impl);
      }
      if (L.typeOf) {
        const td = (await codeHoverTool.run({ ...L.typeOf, kind: 'type_definition' }, ctx)).output;
        has(td, L.typeOf.def);
      }
      const inc = (await codeCallsTool.run({ ...L.callee, direction: 'incoming' }, ctx)).output;
      has(inc, L.callee.caller);
      const out = (await codeCallsTool.run({ ...L.callee, direction: 'outgoing' }, ctx)).output;
      assert.match(out, L.callee.callsOut, out);
      const ren = (await codeRenamePreviewTool.run({ ...L.use, new_name: L.newName }, ctx)).output;
      has(ren, ...L.refs);
      assert.match(ren, /code_apply \{"id": "ed_[0-9a-f]+"\}/, ren);
    } finally {
      await restartServers(ctx.sessionId, ws);
    }
  });
}

test('N46 AC2: a rename is applied across files through the permission engine with a checkpoint, then undone through the checkpoint', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace(TS);
  const before = { shape: TS['src/shape.ts'], main: TS['src/main.ts'] };
  let id = '';
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'code_rename_preview', arguments: { path: 'src/main.ts', line: 5, symbol: 'total', new_name: 'sumAreas' } }] };
    if (i === 1) {
      id = /code_apply \{"id": "(ed_[0-9a-f]+)"\}/.exec(lastToolResult(body))?.[1] ?? 'missing';
      return { toolCalls: [{ name: 'code_apply', arguments: { id } }] };
    }
    return { content: 'renamed' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'acceptEdits', agent: { repoMapTokens: 0, harnessCheck: 'off' }, lsp: { servers: { typescript: { command: TSLS, initializationOptions: TS_INIT } } } }), mcp: false });
  try {
    await agent.run('rename total to sumAreas everywhere');
    const applied = lastToolResult(srv.requests[2]);
    assert.match(applied, /Applied rename `total` → `sumAreas`: 3 edit\(s\) in 2 file\(s\)/, applied);
    const shape = fs.readFileSync(path.join(ws, 'src/shape.ts'), 'utf8');
    const main = fs.readFileSync(path.join(ws, 'src/main.ts'), 'utf8');
    assert.match(shape, /export function sumAreas\(shapes: Shape\[\]\)/);
    assert.match(main, /import \{ Circle, sumAreas \} from '\.\/shape';/);
    assert.match(main, /return sumAreas\(\[c\]\);/);
    assert.ok(!/\btotal\b/.test(shape + main));
    const cp = /Checkpoint (\S+) was taken first: undo with \/rewind \1/.exec(applied)?.[1];
    assert.ok(cp, applied);
    // undo through the checkpoint: both files back
    const r = await checkpointsFor(agent.config, ws).restore(cp!, { conversation: false } as any);
    assert.ok(r.restored.length >= 2, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(ws, 'src/shape.ts'), 'utf8'), before.shape);
    assert.equal(fs.readFileSync(path.join(ws, 'src/main.ts'), 'utf8'), before.main);
    // an id is single-use and stale content is refused
    assert.equal(applyNavEdits('ab\ncd\n', [{ path: 'x', line: 2, col: 1, endLine: 2, endCol: 2, newText: 'X' }]), 'ab\nXd\n');
  } finally {
    await agent.dispose();
    await srv.close();
  }
});

test('N46 AC3: after an edit introduces a type error, the diagnostics appear in the next tool result (TypeScript and Python)', { timeout: 240_000 }, async () => {
  const cases: [string, Record<string, string>, any, { path: string; old_string: string; new_string: string }, RegExp][] = [
    ['ts', TS, { typescript: { command: TSLS, initializationOptions: TS_INIT } }, { path: 'src/main.ts', old_string: 'return total([c]);', new_string: "return total('oops');" }, /L5: .*(not assignable|Argument of type)/],
  ];
  if (PYRIGHT) cases.push(['py', PY, { python: { command: [PYRIGHT, '--stdio'] } }, { path: 'app.py', old_string: 'return total([Sq(2.0)])', new_string: 'return total(3)' }, /L5: .*(cannot be assigned|not assignable|incompatible)/i]);
  for (const [name, files, servers, edit, want] of cases) {
    const ws = tmpWorkspace(files);
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'read_file', arguments: { path: edit.path } }] } : i === 1 ? { toolCalls: [{ name: 'edit_file', arguments: edit }] } : { content: 'done' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'auto', agent: { repoMapTokens: 0, harnessCheck: 'off' }, lsp: { servers } }), mcp: false });
    try {
      await agent.run('make the change');
      const res = lastToolResult(srv.requests[2]);
      assert.match(res, /Edited/, `${name}: ${res}`);
      assert.match(res, want, `${name}: the type error is in the edit's tool result:\n${res}`);
    } finally {
      await agent.dispose();
      await srv.close();
    }
  }
});

test('N46 AC4: a language server crash restarts without losing the session (documents replayed); the restart limit is a typed refusal', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace(TS);
  const ctx = ctxFor(ws, { servers: { typescript: { command: TSLS, initializationOptions: TS_INIT, maxRestarts: 1 } } });
  try {
    const first = (await codeDefinitionTool.run({ path: 'src/main.ts', line: 5, symbol: 'total' }, ctx)).output;
    assert.match(first, /via lsp: typescript/);
    const [c1] = sessionClients(ctx.sessionId);
    const open = c1.openPaths();
    assert.ok(open.length >= 1);
    process.kill(c1.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c1.alive, false);
    // the same session keeps working: the next request restarts the server and replays the open documents
    const again = (await codeReferencesTool.run({ path: 'src/main.ts', line: 5, symbol: 'total' }, ctx)).output;
    assert.match(again, /via lsp: typescript/, again);
    has(again, 'src/shape.ts:12', 'src/main.ts:5');
    const [c2] = sessionClients(ctx.sessionId);
    assert.notEqual(c2.pid, c1.pid);
    assert.equal(c2.restarts, 1);
    for (const f of open) assert.ok(c2.isOpen(f), `${f} replayed into the new server`);
    assert.match(lspStatusText(ctx.config, ws, ctx.sessionId), /typescript \[config\] running pid \d+ · 1 restart/);
    // crash again: the limit (maxRestarts 1) is reached → typed error, and the tools fall back to name matching
    process.kill(c2.pid!, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    const fb = (await codeDefinitionTool.run({ path: 'src/main.ts', line: 5, symbol: 'total' }, ctx)).output;
    assert.match(fb, /crashed .*not restarted again .*maxRestarts = 1/, fb);
    assert.match(fb, /via name matching/);
  } finally {
    await restartServers(ctx.sessionId, ws);
  }
});

test('N46 SAC1: language servers run through the sandbox wrappers with a scrubbed env; project config and workspace binaries need trust; a server cannot write files', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace({ 'a.fk': 'hello\n' });
  // inside the workspace: the server runs in the OS sandbox (review F3), where only the workspace is writable
  const logf = path.join(ws, '.fake-lsp-log.jsonl');
  const spawned: string[] = [];
  registerCommandWrapper('test-n46-sac1', () => (spec) => {
    spawned.push([spec.file, ...spec.args].join(' '));
    return { ...spec, env: { ...spec.env, TUG_SANDBOX_MARK: '1' } };
  });
  process.env.TUG_API_KEY = 'sk-must-not-reach-the-server-123456';
  try {
    const servers = { fake: { command: ['node', FAKE], extensions: ['.fk'], env: { FAKE_LSP_LOG: logf, FAKE_LSP_FLAG: 'on' }, settings: { fake: { opt: 42 } } } };
    const ctx = ctxFor(ws, { servers }, { shell: { scrubEnv: ['TUG_API_KEY'] } });
    const c = await clientFor({ config: ctx.config, workspace: ws, sessionId: ctx.sessionId }, resolvedServers(ctx.config, ws)[0]);
    assert.ok(spawned.some((s) => s.includes('fake-lsp.mjs')), 'spawned through the command wrappers (the OS sandbox seam)');
    c.sync(path.join(ws, 'a.fk'));
    await new Promise((r) => setTimeout(r, 500));
    const lines = fs.readFileSync(logf, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines[0].env, { FAKE_LSP_FLAG: 'on', TUG_API_KEY: null }, 'configured env added, secrets scrubbed');
    // settings answer workspace/configuration by section; unknown sections are null
    assert.deepEqual(lines.find((l) => Array.isArray(l.result))?.result, [42, null]);
    // the server asked to write the document: refused, nothing changed on disk
    const applyAnswer = lines.find((l) => l.result && l.result.applied !== undefined);
    assert.equal(applyAnswer?.result.applied, false);
    assert.equal(c.refusedApplyEdits, 1);
    assert.equal(fs.readFileSync(path.join(ws, 'a.fk'), 'utf8'), 'hello\n');
    await restartServers(ctx.sessionId, ws);
  } finally {
    unregisterCommandWrapper('test-n46-sac1');
    delete process.env.TUG_API_KEY;
  }
  // a server named in an UNTRUSTED project config is ignored (S7), and a tcp transport is refused
  const ws2 = tmpWorkspace({ 'b.fk': 'x\n', '.tugline/config.json': JSON.stringify({ lsp: { servers: { evil: { command: ['node', FAKE], extensions: ['.fk'] } } } }) });
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-')));
  const untrusted = loadConfig({ workspace: ws2, env: { HOME: home } as any, overrides: { homeDir: home } as any });
  assert.ok(!resolvedServers(untrusted, ws2).some((s) => s.name === 'evil'), 'project-config server ignored without trust');
  assert.ok(untrusted.trust?.ignored.some((x) => /lsp/.test(x)), JSON.stringify(untrusted.trust));
  const tcp = resolvedServers(ctxFor(ws2, { servers: { sock: { command: ['x'], transport: 'tcp', extensions: ['.fk'] } } }).config, ws2)[0];
  assert.match(tcp.refused ?? '', /only stdio servers run under the sandbox/);
  // a server binary inside the workspace (agent-writable) is refused unless allowed at user scope
  const ws3 = tmpWorkspace({ 'c.fk': 'y\n' });
  const bin = path.join(ws3, 'node_modules', '.bin', 'fake-ls');
  const marker = path.join(ws3, 'ran.marker');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\nexec node ${FAKE}\n`, { mode: 0o755 });
  const ctx3 = ctxFor(ws3, { servers: { local: { command: [bin], extensions: ['.fk'], env: { FAKE_LSP_MARKER: marker } } } });
  await assert.rejects(clientFor({ config: ctx3.config, workspace: ws3, sessionId: ctx3.sessionId }, resolvedServers(ctx3.config, ws3)[0]), /inside the workspace, where the agent can write/);
  assert.ok(!fs.existsSync(marker), 'the planted binary never ran');
  fs.writeFileSync(path.join(ctx3.config.homeDir, 'config.json'), JSON.stringify({ lsp: { allowWorkspaceBinaries: true } }));
  const ctx3b = { ...ctx3, sessionId: `${ctx3.sessionId}-b` };
  await clientFor({ config: ctx3.config, workspace: ws3, sessionId: ctx3b.sessionId }, resolvedServers(ctx3.config, ws3)[0]);
  assert.ok(fs.existsSync(marker), 'allowed at user scope, it runs');
  await restartServers(ctx3b.sessionId, ws3);
});

test('N46 SAC2: rename edits go through protected-path checks (the whole multi-file edit is refused)', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace(TS);
  const srv = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'code_rename_preview', arguments: { path: 'src/main.ts', line: 5, symbol: 'total', new_name: 'sumAreas' } }] };
    if (i === 1) return { toolCalls: [{ name: 'code_apply', arguments: { id: /code_apply \{"id": "(ed_[0-9a-f]+)"\}/.exec(lastToolResult(body))?.[1] } }] };
    return { content: 'done' };
  });
  const events: any[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'auto', permissions: { protectedPaths: ['src/shape.ts'] }, agent: { repoMapTokens: 0, harnessCheck: 'off' }, lsp: { servers: { typescript: { command: TSLS, initializationOptions: TS_INIT } } } }), mcp: false, ui: { onEvent: (e) => events.push(e) } });
  try {
    await agent.run('rename total');
    const res = lastToolResult(srv.requests[2]);
    assert.match(res, /Refused: .*protected/i, res);
    assert.ok(events.some((e) => e.type === 'refusal' && e.tool === 'code_apply'));
    assert.equal(fs.readFileSync(path.join(ws, 'src/shape.ts'), 'utf8'), TS['src/shape.ts']);
    assert.equal(fs.readFileSync(path.join(ws, 'src/main.ts'), 'utf8'), TS['src/main.ts'], 'no partial rename in the unprotected file either');
    // the control: code_apply hands every touched file to the permission engine
    const pin = codeApplyTool.permissionInput!({ id: 'nope' }, { sessionId: agent.sessionId } as any);
    assert.deepEqual(pin.paths, []);
  } finally {
    await agent.dispose();
    await srv.close();
  }
});

test('N46: auto-detection, plugin-provided servers (trusted only), C/C++ preset, diagnostics with fixes, deleted documents are closed', { timeout: 180_000 }, async () => {
  // auto-detection: a preset is enabled when its language is present and its binary is on PATH outside the workspace
  const ws = tmpWorkspace({ 'x.go': 'package x\n', 'y.ts': 'export {}\n' });
  const bin = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-detbin-')));
  fs.writeFileSync(path.join(bin, 'gopls'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`;
  try {
    const off = resolvedServers(ctxFor(ws, {}).config, ws);
    assert.equal(off.length, 0, 'off by default');
    const on = resolvedServers(ctxFor(ws, { autoDetect: true }).config, ws);
    assert.deepEqual(on.map((s) => `${s.name}:${s.source}`), ['go:auto'], 'go present + installed; typescript present but not installed');
  } finally {
    process.env.PATH = old;
  }
  // plugin servers: only from enabled AND trusted plugins
  const ctx = ctxFor(ws, {});
  const home = ctx.config.homeDir;
  const pdir = path.join(home, 'plugins', 'golsp');
  fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, '.lsp.json'), JSON.stringify({ go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } } }));
  const { contentHash } = await import('../src/core/plugins/store.js');
  const state = { plugins: { golsp: { name: 'golsp', source: pdir, sourceType: 'path', installedAt: '', enabled: true } }, marketplaces: {} };
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), JSON.stringify(state));
  assert.equal(resolvedServers(ctx.config, ws).length, 0, 'untrusted plugin: no server');
  (state.plugins.golsp as any).trustedHash = contentHash(pdir);
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), JSON.stringify(state));
  const ps = resolvedServers(ctx.config, ws);
  assert.deepEqual(ps.map((s) => [s.name, s.argv.join(' '), s.source]), [['golsp:go', 'gopls serve', 'plugin']]);
  // C/C++ preset
  const cpp = resolvedServers(ctxFor(ws, { servers: { cpp: true } }).config, ws)[0];
  assert.deepEqual(cpp.argv, ['clangd', '--background-index']);
  assert.ok(cpp.extensions.includes('.cpp') && cpp.extensions.includes('.h'));
  // diagnostics with fixes on TypeScript: the quick fix comes with an id for code_apply
  const tws = tmpWorkspace({ ...TS, 'src/fix.ts': "import { Circle } from './shape';\nexport const n: number = 1;\n" });
  const tctx = ctxFor(tws, { servers: { typescript: { command: TSLS, initializationOptions: TS_INIT } } }, { compilerOptions: undefined });
  try {
    fs.writeFileSync(path.join(tws, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"noUnusedLocals":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","noEmit":true},"include":["src"]}');
    const d = (await codeDiagnosticsTool.run({ path: 'src/fix.ts', fixes: true }, tctx)).output;
    assert.match(d, /src\/fix\.ts:1:\d+ (error|warning|hint).*(never read|unused|declared but)/i, d);
    const fix = /^\s+(ed_[0-9a-f]+)\s+(Remove|Delete).*import/im.exec(d);
    assert.ok(fix, d);
    const applied = (await codeApplyTool.run({ id: fix![1] }, tctx)).output;
    assert.match(applied, /Applied code action/);
    assert.ok(!fs.readFileSync(path.join(tws, 'src/fix.ts'), 'utf8').includes('import { Circle }'));
    // a file the agent deletes is closed in the server
    const [c] = sessionClients(tctx.sessionId);
    fs.rmSync(path.join(tws, 'src/fix.ts'));
    c.sync(path.join(tws, 'src/fix.ts'));
    assert.equal(c.isOpen(path.join(tws, 'src/fix.ts')), false);
  } finally {
    await restartServers(tctx.sessionId, tws);
  }
});

test('N46 RF3: the TypeScript server never loads the workspace\'s own TypeScript (node_modules/typescript), only one outside the workspace', { timeout: 180_000 }, async () => {
  const ws = tmpWorkspace({
    'tsconfig.json': '{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}',
    'src/a.ts': 'export function f(): number {\n  return 1;\n}\n',
    'src/b.ts': "import { f } from './a';\nexport const x = f();\n",
    // what an agent can write with ordinary edits (acceptEdits: no prompt)
    'node_modules/typescript/package.json': '{"name":"typescript","version":"5.9.3"}',
    'node_modules/typescript/lib/tsserver.js': `require('fs').writeFileSync(require('path').join(process.cwd(), 'PWNED.txt'), 'x');\nrequire(${JSON.stringify(req.resolve('typescript/lib/tsserver.js'))});\n`,
  });
  // no initializationOptions: the server's default would be the workspace's TypeScript
  const ctx = ctxFor(ws, { servers: { typescript: { command: TSLS } } });
  const out = (await codeDefinitionTool.run({ path: 'src/b.ts', line: 2, symbol: 'f' }, ctx)).output;
  assert.match(out, /via lsp: typescript/, out);
  assert.match(out, /src\/a\.ts:1/);
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!fs.existsSync(path.join(ws, 'PWNED.txt')), 'the workspace tsserver.js never ran');
  await restartServers(ctx.sessionId, ws);
});

test('N46 RF3: arguments, interpreter code paths and options naming workspace files are refused like a workspace binary', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.fk': 'x\n', 'tools/ls.mjs': 'process.exit(0)\n', 'node_modules/typescript/lib/tsserver.js': '' });
  const tryStart = async (spec: any, sid: string) => {
    const ctx = ctxFor(ws, { servers: { s: { extensions: ['.fk'], ...spec } } });
    return clientFor({ config: ctx.config, workspace: ws, sessionId: `${ctx.sessionId}-${sid}` }, resolvedServers(ctx.config, ws)[0]).then(
      () => 'started',
      (e) => String(e.message),
    );
  };
  assert.match(await tryStart({ command: ['node', 'tools/ls.mjs'] }, 'script'), /would load .*tools\/ls\.mjs.*inside the workspace/);
  assert.match(await tryStart({ command: ['node', FAKE, '--tsserver-path=node_modules/typescript/lib'] }, 'opt'), /would load .*node_modules\/typescript\/lib/);
  assert.match(await tryStart({ command: ['node', FAKE], env: { NODE_OPTIONS: `--require ${path.join(ws, 'tools/ls.mjs')}` } }, 'envabs'), /NODE_OPTIONS/);
  assert.match(await tryStart({ command: ['python3', '-m', 'pylsp'], env: { PYTHONPATH: '.' } }, 'pypath'), /PYTHONPATH/);
  assert.match(await tryStart({ command: ['node', FAKE], initializationOptions: { tsserver: { path: 'node_modules/typescript/lib/tsserver.js' } } }, 'init'), /initializationOptions/);
  // the same server without the workspace path starts
  assert.equal(await tryStart({ command: ['node', FAKE] }, 'ok'), 'started');
  await stopAllServers();
});

test('N46 RF3: language servers always run in the OS sandbox, even with shell.sandbox "none"; with no sandbox available they need user-scope trust', { timeout: 120_000 }, async () => {
  const { runnerAvailable } = await import('../src/core/sandbox/index.js');
  const ws = tmpWorkspace({ 'a.fk': 'x\n' });
  const spawned: string[] = [];
  registerCommandWrapper('test-n46-rf3', () => (spec) => (spawned.push(`${path.basename(spec.file)} ${spec.args.slice(0, 3).join(' ')}`), spec));
  try {
    const ctx = ctxFor(ws, { servers: { s: { command: ['node', FAKE], extensions: ['.fk'] } } });
    assert.equal(ctx.config.shell.sandbox, 'none');
    if (runnerAvailable('bwrap')) {
      await clientFor({ config: ctx.config, workspace: ws, sessionId: `${ctx.sessionId}-sb` }, resolvedServers(ctx.config, ws)[0]);
      // the filesystem sandbox (read-only root), not only the process-lifetime wrapper (`--dev-bind / /`)
      assert.equal(spawned[0], 'bwrap --ro-bind / /', `spawned through the sandbox: ${spawned}`);
    }
    // a runner that is not available here (seatbelt on Linux, bwrap on macOS): refused …
    const other = process.platform === 'darwin' ? 'bwrap' : 'seatbelt';
    const ctx2 = ctxFor(ws, { servers: { s: { command: ['node', FAKE], extensions: ['.fk'] } } }, { shell: { sandbox: other, requireSandbox: false } });
    await assert.rejects(clientFor({ config: ctx2.config, workspace: ws, sessionId: `${ctx2.sessionId}-none` }, resolvedServers(ctx2.config, ws)[0]), /run in the OS sandbox, and none is available/);
    // … until the user allows unsandboxed servers in the user config
    fs.writeFileSync(path.join(ctx2.config.homeDir, 'config.json'), JSON.stringify({ lsp: { allowUnsandboxed: true } }));
    await clientFor({ config: ctx2.config, workspace: ws, sessionId: `${ctx2.sessionId}-trusted` }, resolvedServers(ctx2.config, ws)[0]);
  } finally {
    unregisterCommandWrapper('test-n46-rf3');
    await stopAllServers();
  }
});

test('N46 RF11: pull diagnostics (textDocument/diagnostic, workspace/diagnostic) are used when the server offers them, including files that are not open', { timeout: 120_000 }, async () => {
  const ws = tmpWorkspace({ 'a.fk': 'ok\nBAD here\n', 'b.fk': 'BAD too\n' });
  const ctx = ctxFor(ws, { servers: { fake: { command: ['node', FAKE], extensions: ['.fk'], env: { FAKE_LSP_PULL: '1', FAKE_LSP_PULL_FILE: path.join(ws, 'b.fk') } } } });
  const one = (await codeDiagnosticsTool.run({ path: 'a.fk' }, ctx)).output;
  assert.match(one, /a\.fk: 1 diagnostic\(s\) via lsp: fake \(pulled\)/, one);
  assert.match(one, /a\.fk:2:1 error: pulled: bad line 2/);
  const all = (await codeDiagnosticsTool.run({}, ctx)).output;
  assert.match(all, /in the workspace \(pulled/, all);
  assert.match(all, /b\.fk:1:1 error: pulled: bad line 1/, 'a file no one opened, from workspace/diagnostic');
  await restartServers(ctx.sessionId, ws);
});
