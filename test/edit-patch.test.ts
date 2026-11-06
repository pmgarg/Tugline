/**
 * A7: V4A apply_patch (Codex scenarios), model-adaptive routing, model stats.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPatchTool, editFileTool, readFileTool, editTools } from '../src/core/tools/fs.js';
import { builtinTools } from '../src/core/tools/index.js';
import { parsePatch, PatchError, seekSequence } from '../src/core/edit/applyPatch.js';
import { autoEditFormat, readModelStats, switchAdvice } from '../src/core/edit/routing.js';
import { defaultConfig, deepMerge } from '../src/core/config.js';
import { Agent } from '../src/core/agent/agent.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';
import { editCtx } from './edit-helpers.js';

const SCENARIOS = path.join(import.meta.dirname, 'edit-fixtures', 'apply-patch');

type Snap = Record<string, string>;
function snapshot(root: string): Snap {
  const out: Snap = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel.startsWith('.tugline')) continue;
      if (e.isDirectory()) {
        out[rel + '/'] = '<dir>';
        walk(abs);
      } else out[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(root);
  return out;
}

async function runScenario(dir: string): Promise<{ actual: Snap; expected: Snap; error?: string }> {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-patch-')));
  if (fs.existsSync(path.join(dir, 'input'))) fs.cpSync(path.join(dir, 'input'), ws, { recursive: true });
  const ctx = editCtx(ws, { cfg: { edit: { verify: false } } });
  // The agent reads before it edits (our read-before-edit invariant); Codex has no such rule.
  for (const f of Object.keys(snapshot(ws)).filter((k) => !k.endsWith('/'))) await readFileTool.run({ path: f }, ctx).catch(() => undefined);
  const patch = fs.readFileSync(path.join(dir, 'patch.txt'), 'utf8');
  let error: string | undefined;
  try {
    applyPatchTool.validate!({ input: patch }, ctx);
    await applyPatchTool.run({ input: patch }, ctx);
  } catch (e) {
    error = (e as Error).message;
  }
  const actual = snapshot(ws);
  fs.rmSync(ws, { recursive: true, force: true });
  return { actual, expected: snapshot(path.join(dir, 'expected')), error };
}

test('A7 AC1: apply_patch passes ≥ 15 scenarios ported from Codex (Add/Update/Delete/Move, chunks, EOF, CRLF, errors)', async () => {
  const dirs = fs.readdirSync(SCENARIOS).filter((d) => fs.statSync(path.join(SCENARIOS, d)).isDirectory()).sort();
  assert.ok(dirs.length >= 15, `${dirs.length} scenarios`);
  let passed = 0;
  const failures: string[] = [];
  for (const d of dirs) {
    const r = await runScenario(path.join(SCENARIOS, d));
    try {
      assert.deepEqual(r.actual, r.expected);
      // scenarios whose name says "rejects"/"fails"/"requires" must surface an error to the model
      if (/rejects|fails|requires|failure/.test(d)) assert.ok(r.error, `${d} should report an error`);
      else assert.equal(r.error, undefined, `${d}: ${r.error}`);
      passed++;
    } catch (e) {
      failures.push(`${d}: ${(e as Error).message.slice(0, 400)}`);
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(passed >= 15);
});

test('A7 AC1: parser errors match Codex and context mismatches are actionable', async () => {
  assert.throws(() => parsePatch('bad'), /The first line of the patch must be '\*\*\* Begin Patch'/);
  assert.throws(() => parsePatch('*** Begin Patch\nbad'), /The last line of the patch must be '\*\*\* End Patch'/);
  assert.throws(() => parsePatch('*** Begin Patch\n*** Update File: test.py\n*** End Patch'), /Update file hunk for path 'test.py' is empty/);
  assert.throws(() => parsePatch('*** Begin Patch\n*** Frobnicate File: x\n*** End Patch'), /is not a valid hunk header/);
  assert.deepEqual(parsePatch("<<'EOF'\n*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\nEOF"), [{ kind: 'add', path: 'a', contents: 'x\n' }]);
  const h = parsePatch('*** Begin Patch\n*** Update File: a.py\n*** Move to: b.py\n@@ def f():\n-    pass\n+    return 1\n*** End Patch');
  assert.deepEqual(h, [{ kind: 'update', path: 'a.py', movePath: 'b.py', chunks: [{ changeContext: 'def f():', oldLines: ['    pass'], newLines: ['    return 1'], contextIdx: [], isEndOfFile: false }] }]);
  // unified-diff style @@ -1,2 +1,2 @@ headers are tolerated as empty context
  assert.equal((parsePatch('*** Begin Patch\n*** Update File: a\n@@ -1,1 +1,1 @@\n-a\n+b\n*** End Patch')[0] as any).chunks[0].changeContext, undefined);
  assert.ok(new PatchError('x') instanceof Error);

  const ws = tmpWorkspace({ 'm.py': 'def f():\n    return 1\n\ndef g():\n    return 2\n' });
  const ctx = editCtx(ws);
  await readFileTool.run({ path: 'm.py' }, ctx);
  await assert.rejects(
    () => applyPatchTool.run({ input: '*** Begin Patch\n*** Update File: m.py\n@@\n def g():\n-    return 3\n+    return 4\n*** End Patch' }, ctx),
    (e: Error) => /Failed to find expected lines in m\.py/.test(e.message) && /Did you mean/.test(e.message) && /No files were changed/.test(e.message),
  );
  // the A1 indent tier: hunk written with the wrong indentation still applies, re-indented
  await applyPatchTool.run({ input: '*** Begin Patch\n*** Update File: m.py\n@@ def g():\n-  return 2\n+  return 20\n*** End Patch' }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'm.py'), 'utf8'), 'def f():\n    return 1\n\ndef g():\n    return 20\n');
  assert.equal(seekSequence(['a  ', 'b'], ['a', 'b'], 0, false)?.tier, 'trailing_ws');
});

test('A7: apply_patch keeps read-before-edit and is all-or-nothing across files', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const ctx = editCtx(ws);
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** Update File: b.txt\n@@\n-two\n+TWO\n*** End Patch';
  assert.throws(() => applyPatchTool.validate!({ input: patch }, ctx), /before reading it/);
  await readFileTool.run({ path: 'a.txt' }, ctx);
  await assert.rejects(() => applyPatchTool.run({ input: patch }, ctx), /before reading it/);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'one\n', 'a.txt untouched when b.txt is refused');
  await readFileTool.run({ path: 'b.txt' }, ctx);
  const bad = patch.replace('-two', '-zwei');
  await assert.rejects(() => applyPatchTool.run({ input: bad }, ctx), /Failed to find expected lines in b\.txt/);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'one\n');
  const r = await applyPatchTool.run({ input: patch }, ctx);
  assert.match(r.output, /M a\.txt\nM b\.txt/);
  // permission input names every file the patch touches
  const pin = applyPatchTool.permissionInput!({ input: patch.replace('*** Update File: b.txt', '*** Update File: b.txt\n*** Move to: c/d.txt') }, ctx);
  assert.deepEqual(pin.paths!.map((p) => path.relative(ws, p.path)).sort(), ['a.txt', 'b.txt', path.join('c', 'd.txt')]);
  assert.ok(pin.paths!.every((p) => p.write));
});

test('A7 AC2: auto exposes exactly one edit family per model', () => {
  const fam = (model: string, over: any = {}) => {
    const cfg = deepMerge(defaultConfig(), deepMerge({ profiles: { default: { model } } }, over));
    return builtinTools(cfg).map((t) => t.name).filter((n) => ['edit_file', 'multi_edit', 'apply_patch', 'write_file'].includes(n));
  };
  assert.deepEqual(fam('qwen3-coder:30b'), ['edit_file', 'multi_edit', 'write_file']);
  assert.deepEqual(fam('gpt-oss:20b'), ['apply_patch', 'write_file']);
  assert.deepEqual(fam('openai/gpt-4.1'), ['apply_patch', 'write_file']);
  assert.deepEqual(fam('gpt-5-codex'), ['apply_patch', 'write_file']);
  assert.deepEqual(fam('GLM-4.6'), ['edit_file', 'multi_edit', 'write_file']);
  // profile editFormat and edit.editFormat override auto; profile wins
  assert.deepEqual(fam('gpt-oss:20b', { profiles: { default: { editFormat: 'replace' } } }), ['edit_file', 'multi_edit', 'write_file']);
  assert.deepEqual(fam('qwen3', { edit: { editFormat: 'whole' } }), ['write_file']);
  assert.deepEqual(fam('qwen3', { edit: { editFormat: 'apply_patch' }, profiles: { default: { editFormat: 'replace' } } }), ['edit_file', 'multi_edit', 'write_file']);
  assert.equal(autoEditFormat('llama3.1:8b'), 'replace');
  assert.equal(editTools(defaultConfig()).length, 3);
});

test('A7 AC2: the tool list sent to a gpt-oss endpoint has apply_patch and no edit_file, and stays fixed across turns', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'one\n' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'a.txt' } }] };
    if (i === 1) return { toolCalls: [{ name: 'apply_patch', arguments: { input: '*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+uno\n*** End Patch' } }] };
    return { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', profiles: { default: { model: 'gpt-oss:20b' } } }), mcp: false });
  const res = await agent.run('change one to uno');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  for (const req of srv.requests) {
    const names = req.tools.map((t: any) => t.function.name);
    assert.ok(names.includes('apply_patch') && !names.includes('edit_file') && !names.includes('multi_edit'));
  }
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'uno\n');
  assert.match(lastToolResult(srv.requests[2]), /Applied patch:\nM a\.txt/);
});

test('A7 AC3: model-stats.json is updated per model and tool (match failures only), with switch advice', async () => {
  const ws = tmpWorkspace({ 'a.py': 'x = 1\n' });
  const ctx = editCtx(ws, { llm: { profile: { model: 'tiny-model' } } as any });
  await readFileTool.run({ path: 'a.py' }, ctx);
  await editFileTool.run({ path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' }, ctx);
  await assert.rejects(() => editFileTool.run({ path: 'a.py', old_string: 'y = 1', new_string: 'x' }, ctx));
  // a read-before-edit refusal is not a match failure
  await assert.rejects(() => editFileTool.run({ path: 'b.py', old_string: 'y', new_string: 'x' }, ctx));
  const stats = readModelStats(ctx.config.homeDir);
  assert.deepEqual(stats['tiny-model'].edit_file, { ok: 1, fail: 1 });
  assert.ok(fs.existsSync(path.join(ctx.config.homeDir, 'model-stats.json')));
  // advice after ≥ 20 attempts below 60 % when apply_patch was never tried; notice only
  assert.equal(switchAdvice({ m: { edit_file: { ok: 5, fail: 5 } } }, 'm'), undefined);
  assert.match(switchAdvice({ m: { edit_file: { ok: 8, fail: 14 } } }, 'm')!, /apply_patch/);
  assert.equal(switchAdvice({ m: { edit_file: { ok: 8, fail: 14 }, apply_patch: { ok: 1, fail: 0 } } }, 'm'), undefined);
  fs.writeFileSync(path.join(ctx.config.homeDir, 'model-stats.json'), JSON.stringify({ 'weak-model': { edit_file: { ok: 2, fail: 30 } } }));
  const ctx2 = editCtx(ws, { llm: { profile: { model: 'weak-model' } } as any, cfg: { homeDir: ctx.config.homeDir } });
  await readFileTool.run({ path: 'a.py' }, ctx2);
  await editFileTool.run({ path: 'a.py', old_string: 'x = 2', new_string: 'x = 3' }, ctx2);
  await editFileTool.run({ path: 'a.py', old_string: 'x = 3', new_string: 'x = 4' }, ctx2);
  const notices = (ctx2 as any).events.filter((e: any) => e.type === 'notice');
  assert.equal(notices.length, 1, 'one notice per session');
  assert.match(notices[0].message, /Consider setting "editFormat": "apply_patch"/);
  // recording can be turned off
  const ctx3 = editCtx(ws, { llm: { profile: { model: 'quiet' } } as any, cfg: { edit: { recordStats: false } } });
  await readFileTool.run({ path: 'a.py' }, ctx3);
  await editFileTool.run({ path: 'a.py', old_string: 'x = 4', new_string: 'x = 5' }, ctx3);
  assert.equal(readModelStats(ctx3.config.homeDir).quiet, undefined);
});

test('A7/A1: an ambiguous hunk is refused (file unchanged); an @@ anchor that disambiguates applies', async () => {
  const src = 'class A:\n    def size(self):\n        return 0\n\n\nclass B:\n    def size(self):\n        return 0\n';
  const ws = tmpWorkspace({ 'shapes.py': src });
  const ctx = editCtx(ws, { cfg: { edit: { verify: false } } });
  await readFileTool.run({ path: 'shapes.py' }, ctx);
  const hunk = '     def size(self):\n-        return 0\n+        return 1\n';
  await assert.rejects(
    () => applyPatchTool.run({ input: `*** Begin Patch\n*** Update File: shapes.py\n@@\n${hunk}*** End Patch` }, ctx),
    (e: Error) => /appear 2 times in shapes\.py \(at lines 2, 7\)/.test(e.message) && /@@ <line>/.test(e.message) && /No files were changed/.test(e.message),
  );
  assert.equal(fs.readFileSync(path.join(ws, 'shapes.py'), 'utf8'), src, 'never applied at the first match');
  // ambiguity is also detected at looser tiers (indentation drift)
  await assert.rejects(() => applyPatchTool.run({ input: '*** Begin Patch\n*** Update File: shapes.py\n@@\n def size(self):\n-    return 0\n+    return 1\n*** End Patch' }, ctx), /appear 2 times/);
  assert.equal(fs.readFileSync(path.join(ws, 'shapes.py'), 'utf8'), src);
  // the @@ anchor narrows the search to after "class B:", where the hunk is unique
  await applyPatchTool.run({ input: `*** Begin Patch\n*** Update File: shapes.py\n@@ class B:\n${hunk}*** End Patch` }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'shapes.py'), 'utf8'), src.replace(/return 0\n$/, 'return 1\n'));
  // more context disambiguates too
  await applyPatchTool.run({ input: '*** Begin Patch\n*** Update File: shapes.py\n@@\n class A:\n     def size(self):\n-        return 0\n+        return 2\n*** End Patch' }, ctx);
  assert.equal(fs.readFileSync(path.join(ws, 'shapes.py'), 'utf8'), src.replace('return 0', 'return 2').replace(/return 0\n$/, 'return 1\n'));
  assert.deepEqual(seekSequence(['x', 'y', 'x', 'y'], ['x', 'y'], 0, false)?.matches, [0, 2]);
  assert.deepEqual(seekSequence(['x', 'y', 'x', 'y'], ['x', 'y'], 1, false)?.matches, [2], 'search starts after the previous hunk/anchor');
});
