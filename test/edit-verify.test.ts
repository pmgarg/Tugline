/**
 * A6: post-edit verification feedback (syntax check, diagnostics diff, formatter).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { editFileTool, readFileTool, writeFileTool } from '../src/core/tools/fs.js';
import { afterEdit, changeSnippet, MAX_FEEDBACK_CHARS, setTreeSitterLoader, syntaxProblems } from '../src/core/edit/verify.js';
import { diffLines } from '../src/core/edit/diff.js';
import { diskHost, type Diagnostic, type WorkspaceHost } from '../src/core/host/workspace.js';
import { tmpWorkspace } from './helpers.js';
import { editCtx } from './edit-helpers.js';

test('A6 AC1: an edit that introduces a Python syntax error reports it in the same tool result', async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def avg(xs):\n    return sum(xs) / len(xs)\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'calc.py' }, ctx);
  const r = await editFileTool.run({ path: 'calc.py', old_string: '    return sum(xs) / len(xs)', new_string: '    if not xs\n        return 0\n    return sum(xs) / len(xs)' }, ctx);
  assert.match(r.output, /New problems after this edit/);
  assert.match(r.output, /L2: SyntaxError: expected ':' \[py_compile\]/);
  assert.match(r.output, /\s2\t {4}if not xs/, 'snippet of the final text with line numbers');
  assert.ok(r.output.length < 2000);
  // fixing it reports no problems, just the snippet
  const r2 = await editFileTool.run({ path: 'calc.py', old_string: '    if not xs\n', new_string: '    if not xs:\n' }, ctx);
  assert.doesNotMatch(r2.output, /New problems/);
  assert.match(r2.output, /Text around the change now/);
});

test('A6 AC1: JSON and JavaScript fallbacks catch syntax errors', async () => {
  const ws = tmpWorkspace({ 'cfg.json': '{\n  "a": 1,\n  "b": 2\n}\n', 'app.js': 'function f() {\n  return 1;\n}\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'cfg.json' }, ctx);
  const r = await editFileTool.run({ path: 'cfg.json', old_string: '  "a": 1,', new_string: '  "a": 1' }, ctx);
  assert.match(r.output, /New problems after this edit.*\nL3: Expected .* \[json\]/);
  await readFileTool.run({ path: 'app.js' }, ctx);
  const r2 = await editFileTool.run({ path: 'app.js', old_string: '  return 1;\n}', new_string: '  return 1;\n' }, ctx);
  assert.match(r2.output, /SyntaxError.*\[node --check\]/);
  // write_file is verified too
  const r3 = await writeFileTool.run({ path: 'new.py', content: 'x = (\n' }, ctx);
  assert.match(r3.output, /New problems after this edit/);
});

test('A6 AC2: a pre-existing error is not repeated', async () => {
  const broken = 'def ok():\n    return 1\n\n\ndef bad(:\n    pass\n';
  const ws = tmpWorkspace({ 'm.py': broken });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'm.py' }, ctx);
  const r = await editFileTool.run({ path: 'm.py', old_string: '    return 1', new_string: '    value = 1\n    return value' }, ctx);
  assert.doesNotMatch(r.output, /New problems/, 'the error at def bad( existed before');
  assert.deepEqual((await syntaxProblems('m.py', fs.readFileSync(path.join(ws, 'm.py'), 'utf8'))).map((p) => p.line), [6]);
});

class DiagHost implements WorkspaceHost {
  readonly kind = 'disk';
  calls: { waitMs?: number }[] = [];
  constructor(private pre: Diagnostic[], private post: Diagnostic[]) {}
  readText = diskHost.readText.bind(diskHost);
  writeText = diskHost.writeText.bind(diskHost);
  exists = diskHost.exists.bind(diskHost);
  delete = diskHost.delete.bind(diskHost);
  async diagnostics(_abs?: string, opts?: { waitMs?: number }) {
    this.calls.push({ waitMs: opts?.waitMs });
    return opts?.waitMs ? this.post : this.pre;
  }
}

test('A6 AC3 (core side): host diagnostics are diffed against the pre-edit set and waited on with the configured timeout', async () => {
  const ws = tmpWorkspace({ 'a.ts': 'const a: number = 1;\nconst b: string = "x";\n' });
  const abs = path.join(ws, 'a.ts');
  const old: Diagnostic = { path: abs, line: 2, col: 7, severity: 'error', message: "Type 'string' is not assignable", source: 'ts' };
  const fresh: Diagnostic = { path: abs, line: 1, col: 7, severity: 'error', message: "Type 'boolean' is not assignable to type 'number'", source: 'ts' };
  const warn: Diagnostic = { ...fresh, severity: 'warning', message: 'unused' };
  const host = new DiagHost([old], [{ ...old, line: 3 }, fresh, warn]);
  const ctx = editCtx(ws, { host, cfg: { edit: { diagnosticsWaitMs: 1234 } } });
  await readFileTool.run({ path: 'a.ts' }, ctx);
  const r = await editFileTool.run({ path: 'a.ts', old_string: 'const a: number = 1;', new_string: 'const a: number = true;' }, ctx);
  assert.match(r.output, /New problems after this edit.*\nL1: Type 'boolean' is not assignable to type 'number' \[ts\]/s);
  assert.doesNotMatch(r.output, /Type 'string'/, 'pre-existing diagnostic (shifted line) not repeated');
  assert.doesNotMatch(r.output, /unused/, 'warnings are not reported');
  assert.deepEqual(host.calls, [{ waitMs: undefined }, { waitMs: 1234 }], 'snapshot before, then one bounded wait (no fixed sleep)');
  // with host diagnostics the syntax fallback is not used
  const ws2 = tmpWorkspace({ 'b.py': 'x = 1\n' });
  const ctx2 = editCtx(ws2, { host: new DiagHost([], []) });
  await readFileTool.run({ path: 'b.py' }, ctx2);
  const r2 = await editFileTool.run({ path: 'b.py', old_string: 'x = 1', new_string: 'x = (' }, ctx2);
  assert.doesNotMatch(r2.output, /New problems/);
});

test('A6 AC4: missing or failing tree-sitter degrades gracefully; a present one is used', async () => {
  try {
    setTreeSitterLoader(async () => undefined);
    assert.deepEqual(await syntaxProblems('x.ts', 'const = ;'), [], 'no tree-sitter, no TS fallback: skip');
    assert.equal((await syntaxProblems('x.py', 'def f(:\n'))[0].source, 'py_compile', 'Python falls back to py_compile');
    setTreeSitterLoader(async () => {
      throw new Error('Cannot find module web-tree-sitter');
    });
    assert.deepEqual(await syntaxProblems('x.ts', 'const = ;'), []);
    assert.equal((await syntaxProblems('x.py', 'def f(:\n'))[0].source, 'py_compile');
    const seen: string[] = [];
    setTreeSitterLoader(async () => ({
      async parse(lang, text) {
        seen.push(lang);
        return { problems: () => (text.includes('const = ') ? [{ line: 1, col: 7, severity: 'error' as const, message: 'syntax error', source: 'tree-sitter' }] : []) };
      },
    }));
    assert.equal((await syntaxProblems('x.ts', 'const = ;'))[0].source, 'tree-sitter');
    assert.deepEqual(await syntaxProblems('y.ts', 'const a = 1;'), []);
    assert.deepEqual(seen, ['typescript', 'typescript']);
  } finally {
    setTreeSitterLoader(undefined);
  }
  // the default loader (the real optional web-tree-sitter when installed) must not throw
  assert.ok(Array.isArray(await syntaxProblems('z.ts', 'let x = ;')));
});

test('A6: the formatter runs when configured (off by default) and the next anchor matches the formatted text', async () => {
  // perl, not `sed -i 's/[a-z]/\U&/g'`: BSD sed (macOS) has neither GNU `-i` nor `\U` (R7).
  const ws = tmpWorkspace({ 'n.txt': 'alpha\nbeta\n' });
  const ctx = editCtx(ws, { cfg: { edit: { format: { '*.txt': "perl -pi -e 's/[a-z]/\\U$&/g' {file}" } } } });
  await readFileTool.run({ path: 'n.txt' }, ctx);
  const r = await editFileTool.run({ path: 'n.txt', old_string: 'beta', new_string: 'gamma' }, ctx);
  assert.match(r.output, /Formatted with/);
  assert.match(r.output, /\s2\tGAMMA/);
  assert.equal(fs.readFileSync(path.join(ws, 'n.txt'), 'utf8'), 'ALPHA\nGAMMA\n');
  await editFileTool.run({ path: 'n.txt', old_string: 'GAMMA', new_string: 'delta' }, ctx); // no re-read needed
  const plain = editCtx(ws);
  await readFileTool.run({ path: 'n.txt' }, plain);
  const r2 = await editFileTool.run({ path: 'n.txt', old_string: 'ALPHA', new_string: 'zeta' }, plain);
  assert.doesNotMatch(r2.output, /Formatted/);
  assert.equal(fs.readFileSync(path.join(ws, 'n.txt'), 'utf8'), 'zeta\nDELTA\n');
});

test('A6: feedback is capped at 1.5k chars and snippets cover only changed regions', async () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = before.replace('line 10\n', 'LINE 10\n').replace('line 150\n', 'LINE 150\n');
  const snip = changeSnippet(before, after);
  assert.match(snip, /\s11\tLINE 10/);
  assert.match(snip, /\s151\tLINE 150/);
  assert.doesNotMatch(snip, /line 100/);
  const huge = 'x'.repeat(5000);
  const out = await afterEdit('/tmp/none.txt', '', `${huge}\n${huge}\n`, diskHost);
  assert.ok(out.length <= MAX_FEEDBACK_CHARS);
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]);
  assert.deepEqual(diffLines(['a', 'b', 'c', 'd'], ['b', 'c', 'e', 'd']), [{ oldStart: 0, oldLines: 1, newStart: 0, newLines: 0 }, { oldStart: 3, oldLines: 0, newStart: 2, newLines: 1 }]);
});
