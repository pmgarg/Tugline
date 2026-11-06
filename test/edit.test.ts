/**
 * WS1 editing engine: matcher tiers (A1), byte preservation (A2), multi_edit (A3),
 * whole-file fallback (A5), host integration (S0.1) and the C5 hidden filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyEdit, applyEdits, EditMatchError, findMatch, type MatchTier } from '../src/core/edit/match.js';
import { BENCH_CASES, BENCH_FILE } from '../src/core/edit/benchCases.js';
import { detect, findLazyPlaceholders, withRegionEndings } from '../src/core/edit/text.js';
import { applyAnchoredEdit, editFileTool, globTool, grepTool, listDirTool, multiEditTool, readFileTool, setRipgrepAvailable, writeFileTool } from '../src/core/tools/fs.js';
import { ReadLedger, type ToolContext } from '../src/core/tools/types.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';
import type { HostText, WorkspaceHost } from '../src/core/host/workspace.js';
import { tmpWorkspace } from './helpers.js';
import { editCtx } from './edit-helpers.js';

function apply(content: string, o: string, n: string, replaceAll = false) {
  return applyEdit(content, o, n, { replaceAll, file: 'f' });
}

function golden(name: string, tier: MatchTier, content: string, o: string, n: string, expected: string) {
  const r = apply(content, o, n);
  assert.equal(r.updated, expected, `${name}: bytes`);
  assert.equal(r.tier, tier, `${name}: tier`);
}

// ------------------------------------------------------------ A1

test('A1 AC1: edit-bench applies ≥ 8/10 byte-exact and refuses the two genuine ambiguities', () => {
  let applied = 0;
  for (const c of BENCH_CASES) {
    try {
      const r = apply(BENCH_FILE, c.anchor, c.replacement);
      assert.ok(c.shouldApply, `${c.name} should have been refused`);
      assert.equal(r.updated, c.expected, `${c.name}: byte-exact result`);
      applied++;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      assert.ok(!c.shouldApply, `${c.name} should have applied: ${(e as Error).message}`);
      assert.equal((e as EditMatchError).fail.reason, 'not_found');
    }
  }
  assert.ok(applied >= 8, `applied ${applied}/10`);
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/edit-bench.mts'], { encoding: 'utf8' });
  assert.match(out, /8\/10 applied; 10\/10 correct/);
});

test('A1 AC2: exact tier golden tests', () => {
  golden('single line', 'exact', 'a = 1\nb = 2\n', 'b = 2', 'b = 3', 'a = 1\nb = 3\n');
  golden('multi line', 'exact', 'def f():\n    return 1\n\nx = f()\n', 'def f():\n    return 1', 'def f():\n    return 2', 'def f():\n    return 2\n\nx = f()\n');
  golden('$ patterns are literal', 'exact', 'v = 1\n', 'v = 1', "v = '$&$1$$'", "v = '$&$1$$'\n");
});

test('A1 AC2: eol tier golden tests', () => {
  golden('LF anchor in CRLF file', 'eol', 'x\r\ny\r\nz\r\n', 'x\ny', 'x\nY', 'x\r\nY\r\nz\r\n');
  golden('inserted lines get CRLF', 'eol', 'a\r\nb\r\nc\r\n', 'a\nb', 'a\nb1\nb2', 'a\r\nb1\r\nb2\r\nc\r\n');
  golden('CRLF anchor in LF file', 'eol', 'p\nq\nr\n', 'p\r\nq', 'p\r\nQ', 'p\nQ\nr\n');
});

test('A1 AC2: line_numbers tier golden tests', () => {
  golden('tab prefixes', 'line_numbers', 'a = 1\nb = 2\nc = 3\n', '     2\tb = 2\n     3\tc = 3', '     2\tb = 20\n     3\tc = 30', 'a = 1\nb = 20\nc = 30\n');
  golden('arrow prefixes', 'line_numbers', 'one\ntwo\n', '1→one\n2→two', '1→one\n2→TWO', 'one\nTWO\n');
  golden('prefixes on old only', 'line_numbers', 'if x:\n    y()\n', '    10\tif x:\n    11\t    y()', 'if x:\n    z()', 'if x:\n    z()\n');
  // numbers that are not consecutive are code, not prefixes
  assert.throws(() => apply('1\tone\n5\tfive\n', '1\tone\n3\tfive', 'x'), /not found/);
});

test('A1 AC2: unicode tier golden tests', () => {
  golden('smart quotes in anchor', 'unicode', 'print("hi")\n', 'print(\u201Chi\u201D)', 'print(\u201Chello\u201D)', 'print("hello\u201D)\n'.replace('\u201D', '"'));
  golden('em dash', 'unicode', '# a - b\nx = 1\n', '# a \u2014 b\nx = 1', '# a \u2014 b\nx = 2', '# a - b\nx = 2\n');
  golden('NBSP', 'unicode', 'let a = 1;\n', 'let\u00A0a = 1;', 'let\u00A0a = 2;', 'let a = 2;\n');
});

test('A1 AC2: trailing_ws tier golden tests', () => {
  golden('model added trailing spaces', 'trailing_ws', 'a:\n  b\n  c\n', 'a:  \n  b', 'a:  \n  B', 'a:\n  B\n  c\n');
  golden('file has trailing spaces', 'trailing_ws', 'x = 1   \ny = 2\n', 'x = 1\ny = 2', 'x = 1\ny = 3', 'x = 1   \ny = 3\n');
  golden('tabs at line end', 'trailing_ws', 'k: v\t\nz: 1\n', 'k: v\nz: 1', 'k: v\nz: 2', 'k: v\t\nz: 2\n');
});

test('A1 AC2: indent tier golden tests', () => {
  golden('dropped indent', 'indent', 'class A:\n    def f(self):\n        return 1\n', 'def f(self):\n    return 1', 'def f(self):\n    return 2', 'class A:\n    def f(self):\n        return 2\n');
  golden('spaces for tabs', 'indent', 'func f() {\n\tif x {\n\t\ty()\n\t}\n}\n', '    if x {\n        y()\n    }', '    if x {\n        z()\n    }', 'func f() {\n\tif x {\n\t\tz()\n\t}\n}\n');
  golden('added indent, new lines re-indented', 'indent', 'if a:\n  b()\n', '        if a:\n          b()', '        if a:\n          b()\n          c()', 'if a:\n  b()\n  c()\n');
});

test('A1 AC2: escapes tier golden tests', () => {
  golden('over-escaped newlines', 'escapes', 'a = 1\nb = 2\n', 'a = 1\\nb = 2', 'a = 1\\nb = 3', 'a = 1\nb = 3\n');
  golden('over-escaped quotes', 'escapes', 'say("hi")\n', 'say(\\"hi\\")', 'say(\\"bye\\")', 'say("bye")\n');
  golden('escaped backslash stays one backslash', 'escapes', 'p = "a\\\\b"\nq = 1\n', 'p = \\"a\\\\\\\\b\\"\\nq = 1', 'p = \\"a\\\\\\\\b\\"\\nq = 2', 'p = "a\\\\b"\nq = 2\n');
});

test('A1 AC2: blank_lines tier golden tests', () => {
  golden('extra blank line in anchor', 'blank_lines', 'a\nb\nc\n', 'a\n\nb', 'a\n\nB', 'a\nB\nc\n');
  golden('anchor missing a blank line', 'blank_lines', 'a\n\nb\nc\n', 'a\nb\nc', 'a\nb\nC', 'a\n\nb\nC\n');
  golden('leading and trailing blank lines', 'blank_lines', 'x\ny\nz\n', '\n\nx\ny\n\n\n', '\n\nx\nY\n\n\n', 'x\nY\nz\n');
});

test('A1 AC3: two matches at any tier are refused, never applied', () => {
  const cases: [MatchTier, string, string][] = [
    ['exact', 'a = 1\nb\na = 1\n', 'a = 1'],
    ['eol', 'x\r\ny\r\nq\r\nx\r\ny\r\n', 'x\ny'],
    ['line_numbers', 'k\nk\n', '     1\tk'],
    ['unicode', 'say("a")\nsay("a")\n', 'say(\u201Ca\u201D)'],
    ['trailing_ws', 'f:  \nf: \n', 'f:'],
    ['indent', '  g()\n    g()\n', 'g()'],
    ['escapes', 'p\nq\np\nq\n', 'p\\nq'],
    ['blank_lines', 'm\n\nn\nm\nn\n', 'm\n\n\nn'],
  ];
  for (const [tier, content, old] of cases) {
    const r = findMatch(content, old, 'ZZ', { file: 'f' });
    assert.equal(r.ok, false, `${tier}: refused`);
    assert.equal((r as any).reason, 'ambiguous', `${tier}: ambiguous`);
    assert.match((r as any).message, /appears 2 times/, tier);
    assert.throws(() => apply(content, old, 'ZZ'), /appears 2 times/);
  }
  // replace_all applies to every occurrence instead
  assert.equal(apply('a = 1\nb\na = 1\n', 'a = 1', 'a = 2', true).updated, 'a = 2\nb\na = 2\n');
  assert.equal(apply('  g()\n    g()\n', 'g()', 'h()', true).updated, '  h()\n    h()\n');
});

test('A1 AC4: indent tier re-indents new_string so Python still compiles', () => {
  const ws = tmpWorkspace({
    'svc.py': 'class S:\n    def run(self, xs):\n        total = 0\n        for x in xs:\n            total += x\n        return total\n',
  });
  // the model dropped the class-level indentation and adds a nested block
  const old = 'for x in xs:\n    total += x\nreturn total';
  const neu = 'for x in xs:\n    if x < 0:\n        continue\n    total += x\nreturn total';
  const file = path.join(ws, 'svc.py');
  const r = apply(fs.readFileSync(file, 'utf8'), old, neu);
  assert.equal(r.tier, 'indent');
  fs.writeFileSync(file, r.updated);
  execFileSync('python3', ['-m', 'py_compile', file]);
  assert.match(r.updated, /^ {12}if x < 0:\n {16}continue\n {12}total \+= x$/m);
});

test('A1 AC5: the tool result names the tier when it is not exact', async () => {
  const ws = tmpWorkspace({ 'a.py': 'class A:\n    def f(self):\n        return 1\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'a.py' }, ctx);
  const r = await editFileTool.run({ path: 'a.py', old_string: 'def f(self):\n    return 1', new_string: 'def f(self):\n    return 2' }, ctx);
  assert.match(r.output, /matched after normalising indentation/);
  assert.equal(fs.readFileSync(path.join(ws, 'a.py'), 'utf8'), 'class A:\n    def f(self):\n        return 2\n');
  assert.equal((r.meta as any).editTier, 'indent');
  const r2 = await editFileTool.run({ path: 'a.py', old_string: '        return 2', new_string: '        return 3' }, ctx);
  assert.doesNotMatch(r2.output, /matched after/);
});

test('A1 AC6: a failed match lists candidate regions with line numbers', async () => {
  const src = Array.from({ length: 30 }, (_, i) => `line_${i + 1} = compute(${i + 1})`).join('\n') + '\n';
  const ws = tmpWorkspace({ 'm.py': src });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'm.py' }, ctx);
  await assert.rejects(
    () => editFileTool.run({ path: 'm.py', old_string: 'line_17 = compute(71)\nline_18 = compute(18)', new_string: 'x' }, ctx),
    (e: Error) => {
      assert.match(e.message, /was not found in m\.py/);
      assert.match(e.message, /Did you mean/);
      assert.match(e.message, /lines 17-18 \(\d+% similar\)/);
      assert.match(e.message, /^\s+17\tline_17 = compute\(17\)$/m);
      return true;
    },
  );
  // validate() refuses it the same way before the user is ever asked
  assert.throws(() => editFileTool.validate!({ path: 'm.py', old_string: 'line_17 = compute(71)', new_string: 'x' }, ctx), /Did you mean/);
});

test('A1: similarity is never auto-applied, and the v0.1 applyAnchoredEdit API still works', () => {
  assert.throws(() => apply('total = price * qty\n', 'total = price * quantity', 'x'), /not found/);
  assert.equal(applyAnchoredEdit('\uFEFFa\nb\n', 'b', 'c', false, 'f').updated, '\uFEFFa\nc\n');
});

// ------------------------------------------------------------ A2

function byteDiff(a: Buffer, b: Buffer): { start: number; endA: number; endB: number } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { start: s, endA: ea, endB: eb };
}

test('A2 AC1: round trips preserve CRLF, mixed EOL, BOM, tabs and no-final-newline; only targeted bytes change', async () => {
  const fixtures: [string, string, string, string, string][] = [
    ['crlf.ts', 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', 'const b = 2;\nconst c = 3;', 'const b = 20;\nconst c = 3;', 'const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n'],
    // the region between "two" and "three" is LF, so the inserted line break is LF too
    ['mixed.txt', 'one\r\ntwo\nthree\r\nfour\n', 'two\nthree', 'two\n2.5\nthree', 'one\r\ntwo\n2.5\nthree\r\nfour\n'],
    ['mixed2.txt', 'one\r\ntwo\nthree\r\nfour\n', 'three\nfour', 'three\n3.5\nfour', 'one\r\ntwo\nthree\r\n3.5\r\nfour\n'],
    ['bom.cs', '\uFEFFusing System;\r\nclass A {}\r\n', 'class A {}', 'class B {}', '\uFEFFusing System;\r\nclass B {}\r\n'],
    ['tabs.go', 'func f() {\n\tx := 1\n\treturn\n}\n', '    x := 1', '    x := 2\n    y := x', 'func f() {\n\tx := 2\n\ty := x\n\treturn\n}\n'],
    ['nofinal.py', 'a = 1\nb = 2', 'b = 2', 'b = 3', 'a = 1\nb = 3'],
  ];
  for (const [name, content, old, neu, expected] of fixtures) {
    const ws = tmpWorkspace({});
    const file = path.join(ws, name);
    fs.writeFileSync(file, content);
    const ctx = editCtx(ws);
    await readFileTool.run({ path: name }, ctx);
    await editFileTool.run({ path: name, old_string: old, new_string: neu }, ctx);
    const after = fs.readFileSync(file);
    assert.equal(after.toString('utf8'), expected, name);
    // byte diff: the change is confined to the targeted region
    const d = byteDiff(Buffer.from(content), after);
    const region = Buffer.from(content).subarray(d.start, d.endA).toString('utf8');
    assert.ok(region.length <= old.length + 4, `${name}: changed region ${JSON.stringify(region)} stays within the anchor`);
    assert.equal(detect(after.toString('utf8')).bom, detect(content).bom);
    assert.equal(detect(after.toString('utf8')).finalNewline, detect(content).finalNewline);
  }
  // withRegionEndings keeps aligned lines' own endings in a mixed region
  assert.equal(withRegionEndings('a\r\nb\nc', 'a\nX\nc', '\n'), 'a\r\nX\nc');
});

test('A2 AC2: a Latin-1 file is refused for editing with a message', async () => {
  const ws = tmpWorkspace({});
  fs.writeFileSync(path.join(ws, 'legacy.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a])); // "café\nx\n" in Latin-1
  const ctx = editCtx(ws);
  const r = await readFileTool.run({ path: 'legacy.txt' }, ctx);
  assert.match(r.output, /not valid UTF-8/);
  assert.throws(() => editFileTool.validate!({ path: 'legacy.txt', old_string: 'x', new_string: 'y' }, ctx), /not valid UTF-8/);
  await assert.rejects(() => editFileTool.run({ path: 'legacy.txt', old_string: 'x', new_string: 'y' }, ctx), /not valid UTF-8.*Convert it first/s);
  await assert.rejects(() => multiEditTool.run({ path: 'legacy.txt', edits: [{ old_string: 'x', new_string: 'y' }] }, ctx), /not valid UTF-8/);
  await assert.rejects(() => writeFileTool.run({ path: 'legacy.txt', content: 'new' }, ctx), /not valid UTF-8/);
  assert.deepEqual([...fs.readFileSync(path.join(ws, 'legacy.txt'))], [0x63, 0x61, 0x66, 0xe9, 0x0a, 0x78, 0x0a], 'file untouched');
});

test('A2 AC3: a 5k-char line is shown in full and can be edited by anchor; a >20k line is marked and refused', async () => {
  const long = 'const data = [' + Array.from({ length: 900 }, (_, i) => `"k${i}"`).join(', ') + '];';
  assert.ok(long.length > 5000);
  const ws = tmpWorkspace({ 'big.js': `// header\n${long}\nexport default data;\n` });
  const ctx = editCtx(ws, { cfg: { edit: { verify: false } } });
  const r = await readFileTool.run({ path: 'big.js' }, ctx);
  assert.ok(r.output.includes(long), 'full line shown');
  assert.doesNotMatch(r.output, /truncated/);
  await editFileTool.run({ path: 'big.js', old_string: '"k450", "k451"', new_string: '"k450", "NEW", "k451"' }, ctx);
  assert.ok(fs.readFileSync(path.join(ws, 'big.js'), 'utf8').includes('"k450", "NEW", "k451"'));

  const huge = 'x'.repeat(25_000);
  const ws2 = tmpWorkspace({ 'h.txt': `a\n${huge}\nb\n` });
  const ctx2 = editCtx(ws2);
  const r2 = await readFileTool.run({ path: 'h.txt' }, ctx2);
  assert.match(r2.output, /… \[line truncated: 25000 chars/);
  const shownLine = r2.output.split('\n')[1].replace(/^\s*2\t/, '');
  await assert.rejects(() => editFileTool.run({ path: 'h.txt', old_string: shownLine, new_string: 'y' }, ctx2), /read_file truncated.*offset\/limit/s);
});

// ------------------------------------------------------------ A3

test('A3 AC1: three edits in one multi_edit call succeed, in order', async () => {
  const ws = tmpWorkspace({ 'c.py': 'A = 1\nB = 2\nC = 3\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'c.py' }, ctx);
  const r = await multiEditTool.run(
    { path: 'c.py', edits: [{ old_string: 'A = 1', new_string: 'A = 10' }, { old_string: 'B = 2', new_string: 'B = A' }, { old_string: 'B = A\nC = 3', new_string: 'B = A\nC = B' }] },
    ctx,
  );
  assert.match(r.output, /applied 3 edit\(s\)/);
  assert.equal(fs.readFileSync(path.join(ws, 'c.py'), 'utf8'), 'A = 10\nB = A\nC = B\n');
});

test('A3 AC2: if edit 2 fails the file is unchanged and the error names edit #2 with candidates', async () => {
  const src = 'alpha = 1\nbeta = 2\ngamma = 3\n';
  const ws = tmpWorkspace({ 'g.py': src });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'g.py' }, ctx);
  const edits = [{ old_string: 'alpha = 1', new_string: 'alpha = 9' }, { old_string: 'beta = 3', new_string: 'beta = 4' }, { old_string: 'gamma = 3', new_string: 'gamma = 0' }];
  await assert.rejects(() => multiEditTool.run({ path: 'g.py', edits }, ctx), (e: Error) => {
    assert.match(e.message, /^edit #2 of 3 failed; no changes were written/);
    assert.match(e.message, /Did you mean/);
    assert.match(e.message, /\s2\tbeta = 2/);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(ws, 'g.py'), 'utf8'), src);
  assert.throws(() => applyEdits(src, edits), (e: EditMatchError) => e.fail.reason === 'not_found' && /edit #2/.test(e.message));
});

test('A3 AC3: multi_edit enforces read-before-edit, stale reads, and permission/protected paths like edit_file', async () => {
  const { PermissionPolicy } = await import('../src/core/permissions/policy.js');
  const ws = tmpWorkspace({ 'a.py': 'x = 1\n', 'tests/test_a.py': 'assert True\n' });
  const ctx = editCtx(ws);
  const args = { path: 'a.py', edits: [{ old_string: 'x = 1', new_string: 'x = 2' }] };
  await assert.rejects(() => multiEditTool.run(args, ctx), /before reading it/);
  assert.throws(() => multiEditTool.validate!(args, ctx), /before reading it/);
  await readFileTool.run({ path: 'a.py' }, ctx);
  fs.writeFileSync(path.join(ws, 'a.py'), 'x = 1  # user\n');
  fs.utimesSync(path.join(ws, 'a.py'), new Date(), new Date(Date.now() + 5000));
  await assert.rejects(() => multiEditTool.run(args, ctx), /changed on disk/);
  const policy = new PermissionPolicy({ workspace: ws, mode: 'yolo', allow: [], deny: [], protectedPaths: ['tests/**'], additionalDirectories: [] } as any);
  const pin = multiEditTool.permissionInput!({ path: 'tests/test_a.py', edits: [] } as any, ctx);
  assert.equal(policy.check({ tool: 'multi_edit', kind: 'edit', ...pin }).decision, 'deny');
  const pin2 = editFileTool.permissionInput!({ path: 'tests/test_a.py', old_string: 'a', new_string: 'b' }, ctx);
  assert.equal(policy.check({ tool: 'edit_file', kind: 'edit', ...pin2 }).decision, 'deny');
});

// ------------------------------------------------------------ A5

test('A5 AC1+AC3: after 2 failed anchors on a small file the error suggests write_file', async () => {
  const ws = tmpWorkspace({ 's.py': 'def f():\n    return 1\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 's.py' }, ctx);
  await assert.rejects(() => editFileTool.run({ path: 's.py', old_string: 'def g():', new_string: 'x' }, ctx), (e: Error) => !/write_file/.test(e.message));
  await assert.rejects(() => editFileTool.run({ path: 's.py', old_string: 'def h():', new_string: 'x' }, ctx), /failed anchor #2 on s\.py, which has 2 lines: you may instead rewrite the whole file with write_file/);
  // a success resets the count
  await editFileTool.run({ path: 's.py', old_string: 'return 1', new_string: 'return 2' }, ctx);
  await assert.rejects(() => editFileTool.run({ path: 's.py', old_string: 'def g():', new_string: 'x' }, ctx), (e: Error) => !/write_file/.test(e.message));
  // large files are not offered a whole-file rewrite
  const big = Array.from({ length: 500 }, (_, i) => `v${i} = ${i}`).join('\n') + '\n';
  const ws2 = tmpWorkspace({ 'big.py': big });
  const ctx2 = editCtx(ws2);
  await readFileTool.run({ path: 'big.py' }, ctx2);
  for (let i = 0; i < 2; i++) await assert.rejects(() => editFileTool.run({ path: 'big.py', old_string: 'nope = 1', new_string: 'x' }, ctx2), (e: Error) => !/write_file/.test(e.message));
  // write_file over it is refused by the size cap
  await assert.rejects(() => writeFileTool.run({ path: 'big.py', content: 'v = 1\n' }, ctx2), /500 lines; write_file may only overwrite existing files up to 400 lines/);
});

test('A5 AC2+AC3: placeholder content is refused with a message; complete content is allowed', async () => {
  const orig = 'import os\n\ndef a():\n    return 1\n\ndef b():\n    return 2\n';
  const ws = tmpWorkspace({ 'p.py': orig });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'p.py' }, ctx);
  for (const lazy of ['# ... existing code ...', '    # rest of the code unchanged', '# ... (unchanged)', '// ... existing code ...']) {
    const content = `import os\n\n${lazy}\n\ndef b():\n    return 3\n`;
    assert.throws(() => writeFileTool.validate!({ path: 'p.py', content }, ctx), /placeholder line/);
    await assert.rejects(() => writeFileTool.run({ path: 'p.py', content }, ctx), /placeholder line.*Write the complete content/s);
  }
  assert.equal(fs.readFileSync(path.join(ws, 'p.py'), 'utf8'), orig);
  const r = await writeFileTool.run({ path: 'p.py', content: orig.replace('return 2', 'return 3') }, ctx);
  assert.match(r.output, /Overwrote p\.py/);
  // ordinary prose is not a placeholder; a bare "..." that already existed is fine
  assert.deepEqual(findLazyPlaceholders('# the rest of the arguments are optional\nx = 1\n'), []);
  assert.deepEqual(findLazyPlaceholders('def f():\n    ...\n', 'def f():\n    ...\n'), []);
  assert.equal(findLazyPlaceholders('def f():\n    ...\n', 'def f():\n    pass\n').length, 1);
});

test('A2/A5: write_file over a CRLF file with BOM keeps the conventions', async () => {
  const ws = tmpWorkspace({});
  fs.writeFileSync(path.join(ws, 'w.txt'), '\uFEFFa\r\nb\r\n');
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'w.txt' }, ctx);
  await writeFileTool.run({ path: 'w.txt', content: 'a\nB' }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'w.txt'), 'utf8'), '\uFEFFa\r\nB\r\n');
  fs.writeFileSync(path.join(ws, 'n.ts'), 'let a = 1;');
  await readFileTool.run({ path: 'n.ts' }, ctx);
  await writeFileTool.run({ path: 'n.ts', content: 'let a = 2;\n' }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'n.ts'), 'utf8'), 'let a = 2;', 'no final newline stays that way');
});

// ------------------------------------------------------------ host integration (S0.1)

class MemHost implements WorkspaceHost {
  readonly kind = 'vscode';
  files = new Map<string, { text: string; version: number }>();
  writes: string[] = [];
  async readText(abs: string): Promise<HostText | undefined> {
    const f = this.files.get(abs);
    return f ? { text: f.text, version: String(f.version), dirty: true, eol: '\n', utf8: true } : undefined;
  }
  async writeText(abs: string, text: string, opts?: { label?: string }) {
    const f = this.files.get(abs);
    const version = (f?.version ?? 0) + 1;
    this.files.set(abs, { text, version });
    this.writes.push(`${opts?.label}`);
    return { version: String(version) };
  }
  async exists(abs: string) {
    return this.files.has(abs);
  }
  async delete(abs: string) {
    this.files.delete(abs);
  }
}

test('S0.1: file tools read and write through ctx.host and the ledger tracks the host version', async () => {
  const ws = tmpWorkspace({});
  const host = new MemHost();
  const abs = path.join(ws, 'buf.ts');
  host.files.set(abs, { text: 'let a = 1;\nlet b = 2;\n', version: 7 }); // exists only as an unsaved buffer
  const ctx = editCtx(ws, { host });
  const r = await readFileTool.run({ path: 'buf.ts' }, ctx);
  assert.match(r.output, /let a = 1;/);
  const e = await editFileTool.run({ path: 'buf.ts', old_string: 'let b = 2;', new_string: 'let b = 3;' }, ctx);
  assert.match(e.output, /Edited buf\.ts/);
  assert.equal(host.files.get(abs)!.text, 'let a = 1;\nlet b = 3;\n');
  assert.deepEqual(host.writes, ['edit_file buf.ts']);
  assert.ok(!fs.existsSync(abs), 'nothing was written to disk behind the editor');
  // the user types in the buffer → version changes → the next edit is refused until re-read
  host.files.set(abs, { text: 'let a = 1;\nlet b = 3; // user\n', version: 42 });
  await assert.rejects(() => editFileTool.run({ path: 'buf.ts', old_string: 'let a = 1;', new_string: 'let a = 0;' }, ctx), /changed since you read it/);
  await readFileTool.run({ path: 'buf.ts' }, ctx);
  await multiEditTool.run({ path: 'buf.ts', edits: [{ old_string: 'let a = 1;', new_string: 'let a = 0;' }] }, ctx);
  await writeFileTool.run({ path: 'new.ts', content: 'export {};\n' }, ctx);
  assert.equal(host.files.get(path.join(ws, 'new.ts'))!.text, 'export {};\n');
  assert.ok(!fs.existsSync(path.join(ws, 'new.ts')));
});

// ------------------------------------------------------------ C5 seam

test('C5: glob, grep and list_dir hide paths the policy marks hidden (stub isHidden)', async () => {
  const ws = tmpWorkspace({ 'src/a.ts': 'needle\n', 'secret/key.ts': 'needle\n', 'secret-notes.ts': 'needle\n' });
  const isHidden = (abs: string) => abs === path.join(ws, 'secret') || abs.startsWith(path.join(ws, 'secret') + path.sep);
  const ctx = editCtx(ws, { policy: { isHidden } as any });
  const g = await globTool.run({ pattern: '**/*.ts' }, ctx);
  assert.deepEqual(g.output.split('\n').sort(), ['secret-notes.ts', 'src/a.ts']);
  const l = await listDirTool.run({}, ctx);
  assert.doesNotMatch(l.output, /^secret\/$/m);
  for (const rg of [undefined, false]) {
    setRipgrepAvailable(rg);
    for (const mode of ['files', 'content', 'count'] as const) {
      const r = await grepTool.run({ pattern: 'needle', output_mode: mode }, ctx);
      assert.doesNotMatch(r.output, /secret\/key/, `${mode} rg=${rg}`);
      assert.match(r.output, /src\/a\.ts/);
      assert.match(r.output, /secret-notes\.ts/);
    }
  }
  setRipgrepAvailable(undefined);
  // without isHidden (before WS3 merges) nothing is filtered
  const plain = await grepTool.run({ pattern: 'needle' }, editCtx(ws));
  assert.match(plain.output, /secret\/key\.ts/);
});
