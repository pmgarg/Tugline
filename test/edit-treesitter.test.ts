/**
 * WS1 v1.1 G6: real syntax checking with the optional tree-sitter runtime
 * (src/core/edit/treesitter.ts), used by A6 post-edit verification and by the
 * D7 repo-map extractor. These tests need the optional packages installed
 * (they are in optionalDependencies); the last ones stub them away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { editFileTool, readFileTool } from '../src/core/tools/fs.js';
import { setTreeSitterLoader, syntaxProblems } from '../src/core/edit/verify.js';
import { BUNDLED_GRAMMARS, configureTreeSitter, grammarFile, setTreeSitterImport, treeSitterAvailable } from '../src/core/edit/treesitter.js';
import { buildRepoMap, clearRepoMapCache, extractDefsRegex, setDefExtractorLoader } from '../src/core/context/repomap.js';
import { tmpWorkspace } from './helpers.js';
import { editCtx } from './edit-helpers.js';

const req = createRequire(import.meta.url);

/** Back to the real default loaders (after a test stubbed or configured them). */
function resetAll() {
  setTreeSitterImport(undefined);
  configureTreeSitter({});
  setTreeSitterLoader(undefined);
  setDefExtractorLoader(undefined);
  clearRepoMapCache();
}

const absent = () => {
  setTreeSitterImport(async () => {
    throw Object.assign(new Error("Cannot find package 'web-tree-sitter'"), { code: 'ERR_MODULE_NOT_FOUND' });
  });
  setTreeSitterLoader(undefined);
  setDefExtractorLoader(undefined);
  clearRepoMapCache();
};

test('G6: the optional runtime and every listed grammar are installed and load', async () => {
  resetAll();
  assert.ok(await treeSitterAvailable(), 'web-tree-sitter + grammar packages (optionalDependencies) are installed');
  for (const g of BUNDLED_GRAMMARS) assert.ok(grammarFile(g), `grammar ${g}`);
  // one clean file per language parses without problems
  const clean: Record<string, string> = {
    'a.ts': 'export class A {\n  m(): number {\n    return 1;\n  }\n}\n',
    'a.tsx': 'export const A = () => <div>hi</div>;\n',
    'a.jsx': 'export const A = () => <b>x</b>;\n',
    'a.go': 'package main\n\nfunc main() {\n\tprintln(1)\n}\n',
    'a.rs': 'fn main() {\n    let x = 1;\n    println!("{}", x);\n}\n',
    'A.java': 'class A {\n  int size() {\n    return 1;\n  }\n}\n',
    'a.css': 'a { color: red; }\n',
    'a.html': '<!doctype html>\n<p>hi</p>\n',
    'a.yaml': 'a: 1\nb:\n  - x\n',
    'a.sh': 'if true; then\n  echo hi\nfi\n',
  };
  for (const [f, t] of Object.entries(clean)) assert.deepEqual(await syntaxProblems(f, t), [], f);
});

test('G6 A6: a TS edit that leaves an unclosed brace reports the error line via tree-sitter', async () => {
  resetAll();
  const src = 'export function total(xs: number[]): number {\n  let sum = 0;\n  for (const x of xs) {\n    sum += x;\n  }\n  return sum;\n}\n';
  const ws = tmpWorkspace({ 'sum.ts': src });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'sum.ts' }, ctx);
  // drop the brace that closes the for loop
  const r = await editFileTool.run({ path: 'sum.ts', old_string: '    sum += x;\n  }\n', new_string: '    sum += x;\n' }, ctx);
  assert.match(r.output, /New problems after this edit/);
  // the file now has 6 lines; the parser runs out of input on line 6 with the function's block still open
  assert.match(r.output, /\nL6: missing "\}" \(unclosed from L1\) \[tree-sitter\]/, r.output);
  // fixing it clears the report
  const r2 = await editFileTool.run({ path: 'sum.ts', old_string: '    sum += x;\n', new_string: '    sum += x;\n  }\n' }, ctx);
  assert.doesNotMatch(r2.output, /New problems/);
  // a pre-existing tree-sitter error is not repeated (A6 AC2 holds with tree-sitter too)
  const ws2 = tmpWorkspace({ 'b.ts': 'export const a = 1;\nconst broken = ;\n' });
  const ctx2 = editCtx(ws2);
  await readFileTool.run({ path: 'b.ts' }, ctx2);
  const r3 = await editFileTool.run({ path: 'b.ts', old_string: 'export const a = 1;', new_string: 'export const a = 2;\nexport const b = 3;' }, ctx2);
  assert.doesNotMatch(r3.output, /New problems/, r3.output);
});

test('G6 A6: Go and Java syntax errors are caught (the fallbacks cannot)', async () => {
  resetAll();
  const go = 'package main\n\nfunc main() {\n\tx := 1 +\n}\n';
  const java = 'class Svc {\n  int size() {\n    int n = 1\n    return n;\n  }\n}\n';
  const goP = await syntaxProblems('main.go', go);
  assert.deepEqual(goP.map((p) => [p.line, p.source]), [[4, 'tree-sitter']], JSON.stringify(goP));
  assert.match(goP[0].message, /syntax error near "\+"/);
  const javaP = await syntaxProblems('Svc.java', java);
  assert.deepEqual(javaP.map((p) => [p.line, p.message, p.source]), [[3, 'missing ";"', 'tree-sitter']]);
  // through edit_file
  const ws = tmpWorkspace({ 'main.go': 'package main\n\nfunc main() {\n\tx := 1\n\t_ = x\n}\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'main.go' }, ctx);
  const r = await editFileTool.run({ path: 'main.go', old_string: '\t_ = x\n', new_string: '\t_ = x)\n' }, ctx);
  assert.match(r.output, /\nL5: syntax error near "\)" \[tree-sitter\]/, r.output);
  // without tree-sitter there is no Go/Java check at all
  try {
    absent();
    assert.deepEqual(await syntaxProblems('main.go', go), []);
    assert.deepEqual(await syntaxProblems('Svc.java', java), []);
  } finally {
    resetAll();
  }
});

test('G6 A6: YAML, CSS, Rust and bash errors are caught; .py/.js stay on their compilers', async () => {
  resetAll();
  assert.equal((await syntaxProblems('c.yaml', 'a: [1, 2\nb: c\n'))[0]?.source, 'tree-sitter');
  assert.deepEqual((await syntaxProblems('x.css', 'a { color: red;\n')).map((p) => p.message), ['missing "}"']);
  assert.equal((await syntaxProblems('x.rs', 'fn main() {\n    let x = ;\n}\n'))[0]?.line, 2);
  assert.match((await syntaxProblems('s.sh', 'if true; then\n  echo hi\n'))[0]?.message ?? '', /missing "fi"/);
  // a real compiler beats a grammar where one is installed
  assert.equal((await syntaxProblems('x.py', 'def f(:\n'))[0].source, 'py_compile');
  assert.equal((await syntaxProblems('x.js', 'function f( {\n'))[0].source, 'node --check');
});

const TS_CLASS = [
  'export class Panel {',
  '  render(): string {',
  '    return `',
  '<html>',
  '<body>${this.title()}</body>',
  '</html>`;',
  '  }',
  '  title(): string {',
  "    return 'x';",
  '  }',
  '  async refresh(force = false): Promise<void> {',
  '    await this.load(force);',
  '  }',
  '  private load(_f: boolean) {',
  '    return Promise.resolve();',
  '  }',
  '}',
  '',
].join('\n');
const JAVA_CLASS = 'package app;\n\npublic class Store {\n    int size() {\n        return 0;\n    }\n\n    String get(String key) {\n        return key;\n    }\n}\n';

test('G6 D7: the repo map via tree-sitter finds class methods the regex misses', async () => {
  resetAll();
  const ws = tmpWorkspace({
    'src/panel.ts': TS_CLASS,
    'src/main.ts': "import { Panel } from './panel';\nconst p = new Panel();\np.render(); p.title(); p.refresh();\n",
    'app/Store.java': JAVA_CLASS,
    'app/Main.java': 'package app;\n\npublic class Main {\n    public static void main(String[] a) {\n        Store s = new Store();\n        s.size(); s.get("k");\n    }\n}\n',
  });
  // what the regexes see: a column-0 template literal ends the class; package-private Java methods have no modifier
  const rx = (lang: any, t: string) => extractDefsRegex(lang, t).map((d) => `${d.parent ?? ''}.${d.name}`);
  assert.deepEqual(rx('ts', TS_CLASS), ['.Panel', 'Panel.render']);
  assert.deepEqual(rx('java', JAVA_CLASS), ['.Store']);
  const m = await buildRepoMap(ws, { tokens: 800 });
  assert.equal(m.engine, 'tree-sitter');
  assert.match(m.text, /src\/panel\.ts:\n {2}⋮ export class Panel\n {2}⋮ {3}render\(\): string\n {2}⋮ {3}title\(\): string\n {2}⋮ {3}async refresh\(force = false\): Promise<void>/, m.text);
  assert.match(m.text, /app\/Store\.java:\n {2}⋮ public class Store\n {2}⋮ {3}int size\(\)\n {2}⋮ {3}String get\(String key\)/, m.text);
  // the regex engine on the same tree misses them
  setDefExtractorLoader(async () => undefined);
  try {
    const r = await buildRepoMap(ws, { tokens: 800 });
    assert.equal(r.engine, 'regex');
    assert.doesNotMatch(r.text, /title\(\)|int size\(\)/);
  } finally {
    resetAll();
  }
});

test('G6 D7: tree-sitter extraction keeps the regex outline (arrow fns, exports, Go receivers, Rust impls, Python) and the security rules', async () => {
  resetAll();
  const ws = tmpWorkspace({
    'lib.ts': "export const LIMIT = 3;\nexport const helper = (x: number) => x + 1;\nconst local = () => 1;\nexport interface Opts {\n  a: number;\n}\nexport type Id = string;\ntest('x', () => {\n  function insideCallback() {}\n});\nexport class Box {\n  #secret = 1;\n  open = () => this.#secret;\n  static make(): Box {\n    function nested() {}\n    return new Box();\n  }\n}\n",
    'srv.go': 'package srv\n\ntype Srv struct {\n}\n\nfunc (s *Srv) Run() error {\n\treturn nil\n}\n\nfunc New() *Srv {\n\treturn &Srv{}\n}\n',
    'p.rs': 'pub struct P;\nimpl P {\n    pub fn new() -> Self {\n        P\n    }\n}\nfn main() {}\n',
    'core.py': 'import functools\n\nclass Engine:\n    @functools.cache\n    def start(self):\n        def inner():\n            pass\n\ndef helper():\n    return Engine()\n',
    'src/config.ts': "export const API_KEY: string = 'sk-live-0123456789abcdefghijklmnop';\nexport function connect(url = 'postgres://admin:hunter2-very-long-password@db') {\n  return url;\n}\n",
    'src/credentials.ts': 'export function awsLogin() {}\n',
  });
  const m = await buildRepoMap(ws, { tokens: 2000 });
  assert.equal(m.engine, 'tree-sitter');
  for (const line of ['⋮ export const LIMIT', '⋮ export const helper = (x: number) =>', '⋮ const local = () =>', '⋮ export interface Opts', '⋮ export type Id = string;', '⋮ export class Box', '⋮   open = () =>', '⋮   static make(): Box', '⋮ type Srv struct', '⋮   func (s *Srv) Run() error', '⋮ func New() *Srv', '⋮ pub struct P;', '⋮   pub fn new() -> Self', '⋮ class Engine:', '⋮   def start(self):', '⋮ def helper():', "⋮ export function connect(url = '…')", '⋮ export const API_KEY: string']) {
    assert.ok(m.text.includes(line), `missing ${JSON.stringify(line)} in:\n${m.text}`);
  }
  for (const no of ['insideCallback', 'nested', 'inner', 'sk-live', 'hunter2', 'awsLogin', '#secret']) assert.ok(!m.text.includes(no), `${no} must not be mapped:\n${m.text}`);
  resetAll();
});

test('G6: everything degrades cleanly when web-tree-sitter is absent (import stubbed)', async () => {
  try {
    absent();
    assert.equal(await treeSitterAvailable(), false);
    // A6: TS/Go have no fallback and are skipped; Python/JSON/JS keep theirs
    assert.deepEqual(await syntaxProblems('a.ts', 'function f( {\n'), []);
    assert.deepEqual(await syntaxProblems('a.go', 'package x\nfunc f( {\n'), []);
    assert.equal((await syntaxProblems('a.py', 'def f(:\n'))[0].source, 'py_compile');
    assert.equal((await syntaxProblems('a.json', '{"a": }'))[0].source, 'json');
    assert.equal((await syntaxProblems('a.js', 'function f( {\n'))[0].source, 'node --check');
    // edits still apply and report a snippet
    const ws = tmpWorkspace({ 'sum.ts': 'export function f() {\n  return 1;\n}\n' });
    const ctx = editCtx(ws);
    await readFileTool.run({ path: 'sum.ts' }, ctx);
    const r = await editFileTool.run({ path: 'sum.ts', old_string: '  return 1;\n}', new_string: '  return 1;\n' }, ctx);
    assert.doesNotMatch(r.output, /New problems/);
    assert.match(r.output, /Text around the change now/);
    assert.equal(fs.readFileSync(path.join(ws, 'sum.ts'), 'utf8'), 'export function f() {\n  return 1;\n\n');
    // D7: regex engine, same outline as before
    const m = await buildRepoMap(tmpWorkspace({ 'm.ts': 'export class Store {\n  get(key: string): number {\n    return 1;\n  }\n}\n' }), { tokens: 300 });
    assert.equal(m.engine, 'regex');
    assert.match(m.text, /⋮ export class Store\n {2}⋮ {3}get\(key: string\): number/);
  } finally {
    resetAll();
  }
  assert.ok(await treeSitterAvailable(), 'restored');
});

test('G6: a directory carrying the runtime and grammars works without node_modules (the VS Code bundle layout)', async () => {
  // resources/tree-sitter/ as vscode/scripts/build.mjs lays it out
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ts-bundle-'));
  const rt = path.dirname(req.resolve('web-tree-sitter'));
  for (const f of ['web-tree-sitter.cjs', 'web-tree-sitter.wasm']) fs.copyFileSync(path.join(rt, f), path.join(dir, f));
  fs.copyFileSync(grammarFile('go')!, path.join(dir, 'tree-sitter-go.wasm'));
  try {
    absent();
    configureTreeSitter({ dirs: [dir] });
    setTreeSitterLoader(undefined);
    assert.ok(await treeSitterAvailable(), 'runtime loaded from the directory');
    assert.equal((await syntaxProblems('m.go', 'package main\nfunc main() {\n\tx := 1 +\n}\n'))[0]?.line, 3);
  } finally {
    resetAll();
  }
  // and the real thing: an esbuild CJS bundle like the extension's, run from a directory with no node_modules
  const esbuild = await import('esbuild');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ts-ext-'));
  const entry = path.join(out, 'entry.ts');
  fs.writeFileSync(entry, `import { configureTreeSitter } from ${JSON.stringify(path.resolve('src/core/edit/treesitter.ts'))};\nimport { syntaxProblems } from ${JSON.stringify(path.resolve('src/core/edit/verify.ts'))};\nconfigureTreeSitter({ dirs: [process.argv[2]] });\nsyntaxProblems('m.go', 'package main\\nfunc main() {\\n\\tx := 1 +\\n}\\n').then((p) => console.log(JSON.stringify(p)));\n`);
  await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: path.join(out, 'dist', 'extension.js'), external: ['web-tree-sitter'], define: { 'import.meta.url': 'importMetaUrl' }, banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" }, logLevel: 'silent' });
  const res = JSON.parse(execFileSync(process.execPath, [path.join(out, 'dist', 'extension.js'), dir], { cwd: out, encoding: 'utf8' }).trim());
  assert.equal(res[0]?.source, 'tree-sitter', JSON.stringify(res));
  assert.equal(res[0]?.line, 3);
});

test('G6: the VS Code build bundles exactly BUNDLED_GRAMMARS', () => {
  const build = fs.readFileSync(path.join('vscode', 'scripts', 'build.mjs'), 'utf8');
  const list = /const TS_GRAMMARS = \[([^\]]*)\]/.exec(build)?.[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.deepEqual(list, BUNDLED_GRAMMARS);
});
