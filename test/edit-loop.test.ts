/**
 * Mock-server loop tests: multi_edit (A3 AC4), the raw-code edit channel (A4),
 * and the optional apply model (A8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { parseEditBlock, parseToolCallsFromText, renderEditBlock, looksLikeTextToolCall } from '../src/core/llm/textProtocol.js';
import { editFileTool, readFileTool, writeFileTool } from '../src/core/tools/fs.js';
import { checkApplyOutput } from '../src/core/edit/applyModel.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';
import { editCtx } from './edit-helpers.js';

const tc = (name: string, args: unknown) => `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`;

test('A3 AC4: multi_edit through the agent loop (mock server, native tools)', async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'calc.py' } }] };
    if (i === 1)
      return {
        toolCalls: [
          {
            name: 'multi_edit',
            arguments: { path: 'calc.py', edits: [{ old_string: 'def add(a, b):\n    return a + b', new_string: 'def add(a: int, b: int) -> int:\n    return a + b' }, { old_string: 'def sub(a, b):', new_string: 'def sub(a: int, b: int) -> int:' }] },
          },
        ],
      };
    return { content: 'Typed both functions.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'acceptEdits' }), mcp: false });
  const res = await agent.run('add type hints');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.ok(srv.requests[0].tools.some((t: any) => t.function.name === 'multi_edit'));
  assert.equal(fs.readFileSync(path.join(ws, 'calc.py'), 'utf8'), 'def add(a: int, b: int) -> int:\n    return a + b\n\ndef sub(a: int, b: int) -> int:\n    return a - b\n');
  assert.match(lastToolResult(srv.requests[2]), /Edited calc\.py: applied 2 edit\(s\)/);
  assert.deepEqual(res.stats.filesChanged, ['calc.py']);
});

const TRICKY = 'import re\nPAT = re.compile(r"\\d+\\.\\d+")\nprint("a\\nb", \'it\\\'s\')\nPATH = "C:\\\\temp\\\\new"\n';

test('A4 AC1: a text-mode <edit> block with quotes, backslashes and \\n literals applies byte-exactly', async () => {
  const ws = tmpWorkspace({ 'r.py': TRICKY });
  const search = 'print("a\\nb", \'it\\\'s\')\nPATH = "C:\\\\temp\\\\new"';
  const replace = 'print("x\\ty", "say \\"hi\\"", \'it\\\'s\')\nPATH = "D:\\\\data\\\\new"  # was C:\\\\temp';
  const block = `I'll fix it.\n<edit path="r.py">\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n</edit>`;
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { content: tc('read_file', { path: 'r.py' }) };
    if (i === 1) return { content: block };
    return { content: 'Done.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'acceptEdits', profiles: { default: { toolMode: 'text' } } }), mcp: false });
  const res = await agent.run('change the print and path');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(fs.readFileSync(path.join(ws, 'r.py'), 'utf8'), TRICKY.replace(search, replace));
  const sys = String(srv.requests[0].messages[0].content);
  assert.match(sys, /# Editing files \(preferred in this mode\)/);
  assert.match(sys, /<<<<<<< SEARCH/);
  // history is rendered back as the same raw block, not escaped JSON
  const assistant = srv.requests[2].messages.find((m: any) => m.role === 'assistant' && String(m.content).includes('<edit'));
  assert.ok(String(assistant.content).includes(`<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`));
  assert.match(lastToolResult(srv.requests[2]), /Edited r\.py/);
});

test('A4 AC1: several pairs map to one multi_edit; an empty SEARCH creates a file; nothing is unescaped', () => {
  const text = 'ok\n<edit path="a.ts">\n<<<<<<< SEARCH\nconst s = "\\n";\n=======\nconst s = "\\t";\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nlet x = 1;\n=======\nlet x = 2;\n>>>>>>> REPLACE\n</edit>\n<edit path=\'new.md\'>\n<<<<<<< SEARCH\n=======\n# Title\n>>>>>>> REPLACE\n</edit>\n' + tc('bash', { command: 'npm test' });
  const { calls, visible } = parseToolCallsFromText(text, ['multi_edit', 'write_file', 'bash']);
  assert.equal(visible, 'ok');
  assert.deepEqual(calls.map((c) => c.name), ['multi_edit', 'write_file', 'bash']);
  assert.deepEqual(calls[0].args, { path: 'a.ts', edits: [{ old_string: 'const s = "\\n";', new_string: 'const s = "\\t";' }, { old_string: 'let x = 1;', new_string: 'let x = 2;' }] });
  assert.deepEqual(calls[1].args, { path: 'new.md', content: '# Title\n' });
  // Cline-style markers are accepted too
  assert.deepEqual(parseEditBlock('b.py', '\n------- SEARCH\na\n=======\nb\n+++++++ REPLACE\n').args, { path: 'b.py', edits: [{ old_string: 'a', new_string: 'b' }] });
  // the history renderer is the inverse of the parser
  const args = calls[0].args!;
  const again = parseToolCallsFromText(renderEditBlock(args)!, []).calls[0].args;
  assert.deepEqual(again, args);
  assert.equal(renderEditBlock({ path: 'x', edits: [{ old_string: 'a', new_string: 'b', replace_all: true }] }), null, 'replace_all stays JSON');
});

test('A4 AC2: malformed blocks produce an actionable error and change nothing', async () => {
  const bad = (body: string, p = 'f.py') => parseEditBlock(p, body).args as any;
  assert.match(bad('<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n').edit_block_error, /pair #1 has no ======= line between SEARCH and REPLACE/);
  assert.match(bad('<<<<<<< SEARCH\na\n=======\nb\n').edit_block_error, /missing >>>>>>> REPLACE/);
  assert.match(bad('a\n=======\nb\n').edit_block_error, /unexpected text outside a SEARCH\/REPLACE pair/);
  assert.match(bad('\n').edit_block_error, /contains no SEARCH\/REPLACE pair/);
  assert.match(bad('<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n<<<<<<< SEARCH\n=======\nc\n>>>>>>> REPLACE\n').edit_block_error, /pair #2 .* empty SEARCH/);
  assert.match(parseToolCallsFromText('<edit>\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n</edit>').calls[0].args!.edit_block_error as string, /no path attribute/);
  assert.match(parseToolCallsFromText('<edit path="f.py">\n<<<<<<< SEARCH\na\n=======\nb').calls[0].args!.edit_block_error as string, /not closed with <\/edit>/);
  for (const e of [bad('<<<<<<< SEARCH\na\n>>>>>>> REPLACE\n').edit_block_error]) assert.match(e, /Expected format:\n<edit path="src\/app.py">/);

  const ws = tmpWorkspace({ 'f.py': 'a = 1\n' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { content: tc('read_file', { path: 'f.py' }) };
    if (i === 1) return { content: '<edit path="f.py">\n<<<<<<< SEARCH\na = 1\n>>>>>>> REPLACE\n</edit>' };
    return { content: 'I will resend it.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask', profiles: { default: { toolMode: 'text' } } }), mcp: false, ui: { requestPermission: async () => assert.fail('a malformed block must not reach the user') } });
  await agent.run('edit');
  await srv.close();
  assert.equal(fs.readFileSync(path.join(ws, 'f.py'), 'utf8'), 'a = 1\n');
  assert.match(lastToolResult(srv.requests[2]), /Error: malformed edit block for f\.py: pair #1 has no ======= line.*Expected format/s);
});

test('A4 AC3: <edit> blocks leaked by a native-mode model are parsed and applied', async () => {
  assert.ok(looksLikeTextToolCall('text <edit path="a">'));
  const ws = tmpWorkspace({ 'n.ts': 'export const n = 1;\n' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'n.ts' } }] };
    if (i === 1) return { content: 'Updating.\n<edit path="n.ts">\n<<<<<<< SEARCH\nexport const n = 1;\n=======\nexport const n = 2;\n>>>>>>> REPLACE\n</edit>' };
    return { content: 'Done.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'acceptEdits', profiles: { default: { toolMode: 'native' } } }), mcp: false });
  const res = await agent.run('bump n');
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.equal(fs.readFileSync(path.join(ws, 'n.ts'), 'utf8'), 'export const n = 2;\n');
});

test('A4: Qwen3-Coder XML code parameters are kept raw, never JSON-parsed or unescaped', () => {
  const xml = '<function=edit_file>\n<parameter=path>\ncfg.json\n</parameter>\n<parameter=old_string>\n{"a": 1, "b": "x\\ny"}\n</parameter>\n<parameter=new_string>\n123\n</parameter>\n<parameter=replace_all>\nfalse\n</parameter>\n</function>';
  const { calls } = parseToolCallsFromText(xml, ['edit_file']);
  assert.deepEqual(calls[0].args, { path: 'cfg.json', old_string: '{"a": 1, "b": "x\\ny"}', new_string: '123', replace_all: false });
});

// ------------------------------------------------------------ A8

const ORIGINAL = 'import os\n\n\ndef load(path):\n    with open(path) as f:\n        return f.read()\n\n\ndef save(path, data):\n    with open(path, "w") as f:\n        f.write(data)\n\n\ndef size(path):\n    return os.path.getsize(path)\n';
const LAZY = 'import os\n\n# ... existing code ...\n\ndef save(path, data):\n    with open(path, "w", encoding="utf-8") as f:\n        f.write(data)\n\n# ... existing code ...\n';
const MERGED = ORIGINAL.replace('open(path, "w")', 'open(path, "w", encoding="utf-8")');

async function applyServer(reply: string) {
  return startMockServer(() => ({ content: `<updated-code>\n${reply}</updated-code>` }));
}

test('A8 AC1: with a mock apply model, a lazy snippet is merged correctly (and verified)', async () => {
  const apply = await applyServer(MERGED);
  const ws = tmpWorkspace({ 'io.py': ORIGINAL });
  const ctx = editCtx(ws, { cfg: { edit: { applyModel: 'apply' }, profiles: { apply: { baseUrl: apply.url, model: 'fastapply-7b', apiKey: 'k', timeoutMs: 10_000 } } } });
  await readFileTool.run({ path: 'io.py' }, ctx);
  const r = await writeFileTool.run({ path: 'io.py', content: LAZY }, ctx);
  await apply.close();
  assert.equal(fs.readFileSync(path.join(ws, 'io.py'), 'utf8'), MERGED);
  assert.match(r.output, /apply model \(fastapply-7b\) merged it/);
  const prompt = String(apply.requests[0].messages[1].content);
  assert.ok(prompt.includes('<original path=') && prompt.includes(ORIGINAL) && prompt.includes('<update>') && prompt.includes('# ... existing code ...'));
  assert.equal(apply.requests[0].temperature, 0);
});

test('A8 AC1: after two failed anchors the apply model merges new_string', async () => {
  const apply = await applyServer(MERGED);
  const ws = tmpWorkspace({ 'io.py': ORIGINAL });
  const ctx = editCtx(ws, { cfg: { edit: { applyModel: 'apply' }, profiles: { apply: { baseUrl: apply.url, model: 'fastapply-7b', apiKey: 'k', timeoutMs: 10_000 } } } });
  await readFileTool.run({ path: 'io.py' }, ctx);
  const edit = { path: 'io.py', old_string: 'def save(path, data):\n    with open(path, mode="w") as f:', new_string: 'def save(path, data):\n    with open(path, "w", encoding="utf-8") as f:' };
  editFileTool.validate!(edit, ctx); // with an apply model configured, validate defers to run()
  await assert.rejects(() => editFileTool.run(edit, ctx), /was not found/);
  assert.equal(apply.requests.length, 0, 'first failure: no rescue yet');
  const r = await editFileTool.run(edit, ctx);
  await apply.close();
  assert.match(r.output, /the apply model \(fastapply-7b\) merged new_string/);
  assert.equal(fs.readFileSync(path.join(ws, 'io.py'), 'utf8'), MERGED);
});

test('A8 AC2: a suspicious apply-model output (deletes > 50 % of the file) is refused', async () => {
  const apply = await applyServer('import os\n\n\ndef save(path, data):\n    with open(path, "w", encoding="utf-8") as f:\n        f.write(data)\n');
  const ws = tmpWorkspace({ 'io.py': ORIGINAL });
  const ctx = editCtx(ws, { cfg: { edit: { applyModel: 'apply' }, profiles: { apply: { baseUrl: apply.url, model: 'm', apiKey: 'k', timeoutMs: 10_000 } } } });
  await readFileTool.run({ path: 'io.py' }, ctx);
  await assert.rejects(() => writeFileTool.run({ path: 'io.py', content: LAZY }, ctx), /apply-model output refused: the merged file deletes \d+ of 15 lines \(more than 50%\)/);
  await apply.close();
  assert.equal(fs.readFileSync(path.join(ws, 'io.py'), 'utf8'), ORIGINAL);
  // the other checks: leftover placeholders, new syntax errors, oversized diffs
  assert.match((await checkApplyOutput('a.py', ORIGINAL, LAZY, ORIGINAL.replace('import os', '# ... existing code ...')))!, /placeholder/);
  assert.match((await checkApplyOutput('a.py', ORIGINAL, LAZY, ORIGINAL.replace('def size(path):', 'def size(path:')))!, /new syntax error/);
  const rewritten = ORIGINAL.split('\n').map((l) => (l.trim() ? l + '  # touched' : l)).join('\n');
  assert.match((await checkApplyOutput('a.py', ORIGINAL, 'x = 1', rewritten))!, /more than 3×/);
  assert.equal(await checkApplyOutput('a.py', ORIGINAL, LAZY, MERGED), undefined);
});

test('A8 AC3: off by default — a lazy write is refused without calling any model', async () => {
  const apply = await applyServer(MERGED);
  const ws = tmpWorkspace({ 'io.py': ORIGINAL });
  const ctx = editCtx(ws, { cfg: { profiles: { apply: { baseUrl: apply.url, model: 'm', apiKey: 'k' } } } });
  assert.equal((ctx.config as any).edit, undefined);
  await readFileTool.run({ path: 'io.py' }, ctx);
  await assert.rejects(() => writeFileTool.run({ path: 'io.py', content: LAZY }, ctx), /placeholder line/);
  for (let i = 0; i < 3; i++) await assert.rejects(() => editFileTool.run({ path: 'io.py', old_string: 'def nope():', new_string: 'x' }, ctx), /not found/);
  await apply.close();
  assert.equal(apply.requests.length, 0);
});
