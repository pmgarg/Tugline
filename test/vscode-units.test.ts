/**
 * WS2 (SPEC B): unit tests for the VS Code extension's pure modules (no `vscode`
 * import): hunks/review logic, inline-edit prompt and parser, @-mention
 * resolvers, image messages, context meter, visible terminal runner, config
 * editing, notifications, FIM autocomplete and chat history.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { applyEdits, computeHunks, countChanges, keepHunk, minimalEdits, rebaseUserChanges, revertHunk, splitKeep } from '../vscode/src/hunks.js';
import { buildInlineEditPrompt, buildReplacement, dedent, parseReplacement, reindent } from '../vscode/src/inlinePrompt.js';
import { CAPS, fuzzyScore, rankFiles, resolveMentions, type MentionEnv } from '../vscode/src/mentions.js';
import { buildUserMessage, validateImage, MAX_IMAGE_BYTES } from '../vscode/src/images.js';
import { emptyMeter, meterReduce, meterView, withBreakdown } from '../vscode/src/meter.js';
import { ansiCQuote, cmdEscape, cmdInnerLine, commandLineFor, commandLineForShell, msvcQuote, psQuote, pwshScript, shellKindOf, stripAnsi, VisibleTerminalRunner, windowsCommandLine, type TermApi, type TermLike } from '../vscode/src/terminalRunner.js';
import { addMcpServer, applyMcpToggles, mcpToggleKey, parseRegistry, readConfigFile, setHooks, setMcpToggle, setPermissionRules, setProtectedPaths, setSkillEnabled } from '../vscode/src/configEdit.js';
import { Notifier } from '../vscode/src/notify.js';
import { sandboxBadge } from '../vscode/src/sandboxBadge.js';
import { sandboxStatus } from '../src/core/sandbox/index.js';
import { buildCompletionsBody, buildFimPrompt, buildInfillBody, completeFim, fimUrl, postProcess, registerAutocomplete } from '../vscode/src/fim.js';
import { deleteSession, listSessions, loadSessionMessages, renameSession, searchSessions, titleFromPrompt } from '../vscode/src/sessions.js';
import { Journal } from '../src/core/agent/journal.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { loadConfig } from '../src/core/config.js';
import { DEFAULT_IDE, ideConfig } from '../src/core/host/vscode-contract.js';
import type { AgentEvent, RunStats } from '../src/core/types.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';
import { admittedComplete, completionBadge, flushDocuments, historyWithState, saveDocumentsReport, type DocLike } from '../vscode/src/coreBridge.js';
import { Agent } from '../src/core/agent/agent.js';
import { LLMClient, LLMError } from '../src/core/llm/client.js';
import { resolveProfile } from '../src/core/config.js';

// ------------------------------------------------------------ B2 AC4: hunks and revert logic

const BASE = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((x) => x + '\n').join('');
const CUR = BASE.replace('b\n', 'B1\nB2\n').replace('e\n', '').replace('i\n', 'I\n');

test('B2 AC4: hunk computation finds the 3 changed regions with +/- counts', () => {
  const hs = computeHunks(BASE, CUR);
  assert.equal(hs.length, 3);
  assert.deepEqual(hs[0], { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 });
  assert.deepEqual(hs[1], { oldStart: 4, oldLines: 1, newStart: 5, newLines: 0 });
  assert.deepEqual(hs[2], { oldStart: 8, oldLines: 1, newStart: 8, newLines: 1 });
  assert.deepEqual(countChanges(BASE, CUR), { added: 3, removed: 3, hunks: 3 });
  assert.deepEqual(computeHunks(BASE, BASE), []);
});

test('B2 AC4: reverting hunk #2 of 3 restores only that hunk; reverting all restores the baseline byte-exactly', () => {
  const hs = computeHunks(BASE, CUR);
  const r2 = revertHunk(BASE, CUR, hs[1]);
  assert.equal(r2, CUR.replace('d\nf\n', 'd\ne\nf\n'));
  assert.equal(computeHunks(BASE, r2).length, 2, 'two hunks remain');
  let cur = CUR;
  for (const h of [...hs].reverse()) cur = revertHunk(BASE, cur, h);
  assert.equal(cur, BASE);
  // CRLF and no final newline survive a revert
  const b = 'one\r\ntwo\r\nthree';
  const c = 'one\r\nTWO\r\nthree';
  assert.equal(revertHunk(b, c, computeHunks(b, c)[0]), b);
});

test('B2 AC4: keeping a hunk advances the baseline so only the other hunks stay pending', () => {
  const hs = computeHunks(BASE, CUR);
  const base2 = keepHunk(BASE, CUR, hs[0]);
  const left = computeHunks(base2, CUR);
  assert.equal(left.length, 2);
  assert.ok(base2.startsWith('a\nB1\nB2\nc\n'));
  let base = BASE;
  for (const h of [...hs].reverse()) base = keepHunk(base, CUR, h);
  assert.equal(base, CUR, 'keeping every hunk = keep all');
});

test('B1/B2: minimal edits touch only changed lines and reproduce the target', () => {
  const from = 'x\ny\nz\n';
  const to = 'x\nY\nz\nw\n';
  const e = minimalEdits(from, to);
  assert.equal(e.length, 2);
  assert.deepEqual(e[0], { start: 2, end: 4, text: 'Y\n' });
  assert.equal(applyEdits(from, e), to);
  assert.deepEqual(splitKeep('a\nb'), ['a\n', 'b']);
});

test('B2: user typing outside agent hunks is folded into the baseline (Undo never reverts the user)', () => {
  const base = 'l1\nl2\nl3\nl4\n';
  const cur = 'l1\nAGENT\nl3\nl4\n';
  // user edits l4 (unchanged region) → baseline follows
  const off = cur.indexOf('l4');
  const after = cur.slice(0, off) + 'USER4' + cur.slice(off + 2);
  const nb = rebaseUserChanges(base, cur, [{ rangeOffset: off, rangeLength: 2, text: 'USER4' }]);
  assert.equal(nb, 'l1\nl2\nl3\nUSER4\n');
  const hs = computeHunks(nb, after);
  assert.equal(hs.length, 1);
  assert.equal(revertHunk(nb, after, hs[0]), 'l1\nl2\nl3\nUSER4\n', 'undo keeps the user edit');
  // user edits inside the agent hunk → merged into the hunk, baseline unchanged
  const o2 = cur.indexOf('AGENT');
  assert.equal(rebaseUserChanges(base, cur, [{ rangeOffset: o2, rangeLength: 5, text: 'AGENT+user' }]), base);
});

// ------------------------------------------------------------ B3 AC2: inline prompt builder and reply parser

test('B3 AC2: prompt builder uses markers, caps prefix/suffix and dedents the selection', () => {
  const prefix = Array.from({ length: 200 }, (_, i) => `p${i}`).join('\n') + '\n';
  const suffix = Array.from({ length: 100 }, (_, i) => `s${i}`).join('\n') + '\n';
  const msgs = buildInlineEditPrompt({ path: 'a.py', language: 'python', prefix, selection: '    def f(x):\n        return x\n', suffix, instruction: 'rename x to y', diagnostics: ['line 3: error: boom'] });
  const u = String(msgs[1].content);
  for (const tag of ['<prefix>', '</prefix>', '<selection>', '</selection>', '<suffix>', '</suffix>', '<instruction>', '<diagnostics>']) assert.ok(u.includes(tag), tag);
  assert.ok(u.includes('p199') && !u.includes('p49\n') && u.includes('p50'), 'last 150 prefix lines');
  assert.ok(u.includes('s59') && !u.includes('s60'), 'first 60 suffix lines');
  assert.ok(u.includes('<selection>\ndef f(x):\n    return x\n</selection>'), 'selection dedented');
  assert.match(String(msgs[0].content), /<replacement>/);
});

test('B3 AC2: dedent / re-indent round trip (spaces and tabs)', () => {
  assert.deepEqual(dedent('    a\n      b\n'), { text: 'a\n  b\n', indent: '    ' });
  assert.equal(reindent('a\n  b\n', '    '), '    a\n      b\n');
  assert.equal(reindent('\tc\n', '\t'), '\tc\n', 'already indented: left alone');
  assert.equal(reindent('x\n\ny\n', '  '), '  x\n\n  y\n', 'blank lines stay empty');
});

test('B3 AC2: reply parser handles tags, fences, plain replies and English chatter', () => {
  assert.equal(parseReplacement('<replacement>\ndef f(y):\n    return y\n</replacement>'), 'def f(y):\n    return y');
  assert.equal(parseReplacement('Here is the updated code:\n```python\ndef f(y):\n    return y\n```\nThis renames x to y.'), 'def f(y):\n    return y');
  assert.equal(parseReplacement('def f(y):\n    return y'), 'def f(y):\n    return y');
  assert.equal(parseReplacement('Sure! Here is the code:\n<replacement>\n```py\nz = 1\n```\n</replacement>'), 'z = 1');
  assert.equal(parseReplacement('<think>hmm</think><replacement>q = 2</replacement>'), 'q = 2');
  assert.equal(parseReplacement('Here is the code:'), undefined);
});

test('B3 AC2: buildReplacement re-indents to the selection and keeps its trailing newline and CRLF', () => {
  const sel = '    def f(x):\n        return x\n';
  assert.equal(buildReplacement('<replacement>\ndef f(y):\n    return y\n</replacement>', sel), '    def f(y):\n        return y\n');
  const crlf = '  a = 1\r\n';
  assert.equal(buildReplacement('a = 2', crlf), '  a = 2\r\n');
  assert.equal(buildReplacement('x', 'y'), 'x', 'no trailing newline when the selection had none');
});

// ------------------------------------------------------------ B4: mentions

function fakeEnv(ws: string, over: Partial<MentionEnv> = {}): MentionEnv & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    workspace: ws,
    diagnostics: (abs) => {
      calls.push(`diag:${abs ?? '*'}`);
      return [
        { path: path.join(ws, 'a.ts'), line: 3, col: 5, severity: 'warning', message: 'unused x', source: 'ts' },
        { path: path.join(ws, 'b.ts'), line: 1, col: 1, severity: 'error', message: "Cannot find name 'foo'", source: 'ts', context: '    1> foo()' },
      ].filter((d) => !abs || d.path === abs) as any;
    },
    terminalOutput: async () => ({ command: 'npm test', exitCode: 1, output: 'FAIL src/a.test.ts\n  expected 1 got 2', via: 'shell-integration' }),
    git: async (args) => {
      calls.push(`git:${args.join(' ')}`);
      if (args[0] === 'status') return { code: 0, output: '## main\n M a.ts' };
      if (args[0] === 'diff') return { code: 0, output: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y' };
      if (args[0] === 'show') return { code: 0, output: `commit ${args[args.length - 1]}\n\n    fix things` };
      return { code: 1, output: 'unknown' };
    },
    fetchUrl: async (url) => `<untrusted_web_content source="${url}">page</untrusted_web_content>`,
    skill: (n) => (n === 'tdd' ? '# Skill: tdd\nWrite the test first.' : undefined),
    ...over,
  };
}

test('B4 AC1: @problems resolver (workspace and one file), errors first, with code context', async () => {
  const ws = tmpWorkspace({ 'a.ts': 'x', 'b.ts': 'foo()' });
  const env = fakeEnv(ws);
  const r = await resolveMentions('why does it fail? @problems', env);
  assert.equal(r.attached[0].source, '@problems');
  const block = r.text.slice(r.text.indexOf('<attached_context'));
  assert.match(block, /source="@problems" kind="problems"/);
  assert.ok(block.indexOf("b.ts:1:1 error: Cannot find name 'foo'") < block.indexOf('a.ts:3:5 warning'), 'errors first');
  assert.match(block, /1> foo\(\)/);
  const one = await resolveMentions('@problems:b.ts', env);
  assert.doesNotMatch(one.text, /unused x/);
  assert.ok(env.calls.includes(`diag:${path.join(ws, 'b.ts')}`));
});

test('B4 AC1: @terminal, @git, @git:<hash>, @skill resolvers; caps per provider; failures are skipped, not fatal', async () => {
  const ws = tmpWorkspace({});
  const env = fakeEnv(ws);
  const r = await resolveMentions('see @terminal and @git and @git:abc1234 and @skill:tdd and @skill:nope', env);
  assert.match(r.text, /source="@terminal" kind="terminal" id="[0-9a-f]{16}">\n\$ npm test {2}\[exit code 1\]\nFAIL/);
  assert.match(r.text, /git status:\n## main/);
  assert.match(r.text, /git diff HEAD:\n--- a\/a.ts/);
  assert.match(r.text, /source="@git:abc1234"[\s\S]*commit abc1234/);
  assert.match(r.text, /Write the test first/);
  assert.deepEqual(r.skipped.map((s) => s.source), ['@skill:nope']);
  assert.ok(env.calls.includes('git:show --stat --patch --no-color abc1234'));
  const bad = await resolveMentions('@git:;rm -rf', env);
  assert.equal(bad.skipped.length, 1, 'non-commit args never reach git');
  const big = fakeEnv(ws, { terminalOutput: async () => ({ output: 'y\n'.repeat(20000), via: 'selection' }) });
  const capped = await resolveMentions('@terminal', big);
  assert.ok(capped.attached[0].chars <= CAPS.terminal + 60);
  const none = fakeEnv(ws, { terminalOutput: async () => undefined });
  assert.equal((await resolveMentions('@terminal', none)).skipped.length, 1);
});

test('B4 AC1: @file / @folder use the core resolver with the permission policy (secrets are not attached)', async () => {
  const ws = tmpWorkspace({ 'src/calc.py': 'def f():\n    return 1\n', '.env': 'KEY=sekret', 'docs/a.md': '# a' });
  const policy = new PermissionPolicy({ workspace: ws, mode: 'ask', allow: [], deny: [], protectedPaths: [], additionalDirectories: [] });
  const r = await resolveMentions('fix @src/calc.py:2 using @docs/ but not @.env', fakeEnv(ws, { policy }));
  assert.match(r.text, /source="@src\/calc.py:2" kind="file" id="[0-9a-f]{16}">\n {4}2\t {4}return 1/);
  assert.match(r.text, /source="@docs\/" kind="folder" id="[0-9a-f]{16}">\na.md/);
  assert.doesNotMatch(r.text, /sekret/);
  assert.ok(r.skipped.some((s) => s.source === '@.env'));
});

test('B4 AC1: @url goes through the fetch adapter and the result stays wrapped as untrusted', async () => {
  const ws = tmpWorkspace({});
  const r = await resolveMentions('summarise @url:https://example.com/docs?x=1.', fakeEnv(ws));
  assert.equal(r.attached[0].source, '@url:https://example.com/docs?x=1');
  assert.match(r.text, /<untrusted_web_content source="https:\/\/example.com\/docs\?x=1">/);
  assert.equal((await resolveMentions('@url:ftp://x', fakeEnv(ws))).skipped.length, 1);
});

test('B4 AC3: @url refuses private IPs (core web_fetch SSRF guard)', async () => {
  const { webFetchTool } = await import('../src/core/tools/web.js');
  const cfg = loadConfig({ workspace: os.tmpdir(), noUserConfig: true });
  let hits = 0;
  const srv = http.createServer((_q, s) => {
    hits++;
    s.end('<html>internal</html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const env = fakeEnv(os.tmpdir(), { fetchUrl: async (url) => (await webFetchTool.run({ url }, { config: cfg, signal: new AbortController().signal } as any)).output });
  for (const url of [`http://127.0.0.1:${port}/`, 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost:1/']) {
    const r = await resolveMentions(`@url:${url}`, env);
    assert.equal(r.attached.length, 0, url);
    assert.match(r.skipped[0].reason, /SSRF guard/, url);
  }
  srv.close();
  assert.equal(hits, 0, 'nothing was fetched');
});

test('B4: composer autocomplete ranks files fuzzily (basename prefix first)', () => {
  const files = ['src/core/agent/agent.ts', 'vscode/src/chat.ts', 'src/core/config.ts', 'test/agent.test.ts'];
  assert.equal(rankFiles('chat', files)[0], 'vscode/src/chat.ts');
  assert.equal(rankFiles('agent', files)[0], 'src/core/agent/agent.ts');
  assert.equal(fuzzyScore('zzz', 'abc'), -1);
});

// ------------------------------------------------------------ B5: images

const PNG = 'data:image/png;base64,' + Buffer.from('\x89PNG\r\n\x1a\nfakepng').toString('base64');

test('B5 AC1: the message for a vision profile contains image_url parts', () => {
  const m = buildUserMessage('what is in this screenshot?', [{ name: 'shot.png', dataUrl: PNG }], { vision: true });
  assert.ok(Array.isArray(m.content));
  const parts = m.content as any[];
  assert.deepEqual(parts[0], { type: 'text', text: 'what is in this screenshot?' });
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, PNG);
});

test('B5 AC2: a text-only profile never sends image parts (OCR/description become untrusted text; otherwise refused)', () => {
  const refused = buildUserMessage('look', [{ name: 'a.png', dataUrl: PNG }], { vision: false });
  assert.equal(typeof refused.content, 'string');
  assert.doesNotMatch(String(refused.content), /data:image/);
  assert.match(refused.notices[0], /no vision/);
  const ocr = buildUserMessage('look', [{ name: 'a.png', dataUrl: PNG }], { vision: false, imageTexts: [{ name: 'a.png', via: 'ocr', text: 'Error: 42' }] });
  assert.equal(typeof ocr.content, 'string');
  assert.match(String(ocr.content), /<attached_context source="image:a.png" kind="ocr" id="[0-9a-f]{16}">\n<untrusted_image_text>\nError: 42/);
  assert.doesNotMatch(String(ocr.content), /image_url|base64/);
});

test('B5: only png/jpg/webp up to 5 MB are accepted', () => {
  assert.equal(validateImage({ name: 'a.png', dataUrl: PNG }), undefined);
  assert.match(validateImage({ name: 'a.gif', dataUrl: 'data:image/gif;base64,R0lG' })!, /not supported/);
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 10) * 4) / 3));
  assert.match(validateImage({ name: 'b.jpg', dataUrl: big })!, /over the 5 MB limit/);
  const m = buildUserMessage('x', [{ name: 'a.gif', dataUrl: 'data:image/gif;base64,R0lG' }], { vision: true });
  assert.equal(m.content, 'x', 'invalid images are dropped even for vision models');
});

// ------------------------------------------------------------ B9: meter

const stats = (): RunStats => ({ turns: 1, llmCalls: 1, successfulLlmCalls: 1, unparseableReplies: 0, toolCalls: 0, toolErrors: 0, refusals: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, durationMs: 1, filesChanged: [], commandsRun: [] });
const usage = (p: number, c: number, cost: number, role?: string): AgentEvent => ({ type: 'usage', usage: { promptTokens: p, completionTokens: c }, costUsd: cost, latencyMs: 5, model: 'm', role });

test('B9 AC1: meter values from synthetic events (context, amber at compactAt, red near the window, costs)', () => {
  let s = emptyMeter();
  s = withBreakdown(s, { system: 1000, tools: 2000, history: 500, attachments: 0, total: 3500, window: 32000, compactAt: 20000, messages: 2, toolCount: 10, deferredTools: 0 });
  let v = meterView(s);
  assert.equal(v.used, 3500, 'estimate before any call');
  assert.equal(v.level, 'ok');
  s = meterReduce(s, { type: 'run_start', runId: 'r', prompt: 'p', model: 'm' });
  s = meterReduce(s, usage(9000, 500, 0.01));
  v = meterView(s);
  assert.equal(v.used, 9500, 'server-reported prompt+completion of the last main call');
  assert.equal(v.pct, 29.7);
  assert.equal(v.label, '9.5k / 32.0k');
  s = meterReduce(s, usage(21500, 600, 0.02));
  assert.equal(meterView(s).level, 'amber', 'messages (used - tools) ≥ compactAt');
  s = meterReduce(s, usage(30500, 200, 0.03));
  assert.equal(meterView(s).level, 'red');
  s = meterReduce(s, { type: 'compaction', beforeTokens: 28000, afterTokens: 4000, strategy: 'summary' });
  assert.equal(meterView(s).used, 6000, 'after compaction: estimate until the next call');
  assert.match(meterView(s).cost, /\$0\.030 req · \$0\.060 task · \$0\.060 chat/);
  s = meterReduce(s, { type: 'run_end', stopReason: 'end_turn', finalText: '', stats: stats() });
  s = meterReduce(s, { type: 'run_start', runId: 'r2', prompt: 'p', model: 'm' });
  assert.equal(s.task.cost, 0, 'task cost resets per run');
  assert.equal(s.session.cost.toFixed(2), '0.06', 'chat cost accumulates');
});

test('B9 AC3: task cost includes subagent usage (explore/validator roles), without moving the context gauge', () => {
  let s = emptyMeter(32000);
  s = meterReduce(s, { type: 'run_start', runId: 'r', prompt: 'p', model: 'm' });
  s = meterReduce(s, usage(5000, 100, 0.005, 'main'));
  s = meterReduce(s, usage(15000, 300, 0.02, 'explore'));
  s = meterReduce(s, usage(800, 50, 0.001, 'summarizer'));
  assert.equal(s.reported, 5100, 'subagent calls do not count as the main context');
  assert.equal(s.task.cost.toFixed(3), '0.026');
  assert.equal(s.task.subagentCalls, 1);
  assert.equal(s.task.subagentCost, 0.02);
  assert.match(meterView(s).title, /subagents: 1 call\(s\), \$0\.020/);
});

// ------------------------------------------------------------ B10: visible terminal runner

class FakeTerm implements TermLike {
  shellIntegration?: { executeCommand(c: string): any };
  exitStatus?: unknown;
  sent: string[] = [];
  shown = 0;
  disposed = false;
  constructor(readonly name: string, readonly opts: any) {}
  show(): void {
    this.shown++;
  }
  sendText(t: string): void {
    this.sent.push(t);
  }
  dispose(): void {
    this.disposed = true;
  }
}

function fakeTermApi(behaviour: { integration: boolean; output?: string[]; exitCode?: number; hang?: boolean; startEvents?: 'fire' | 'never' }) {
  const ends: ((e: any) => void)[] = [];
  const starts: ((e: any) => void)[] = [];
  const integ: ((e: any) => void)[] = [];
  const terms: FakeTerm[] = [];
  const executed: string[] = [];
  const api: TermApi = {
    createTerminal(o) {
      const t = new FakeTerm(o.name, o);
      terms.push(t);
      if (behaviour.integration)
        setTimeout(() => {
          t.shellIntegration = {
            executeCommand(line: string) {
              executed.push(line);
              const ex = {
                async *read() {
                  for (const o of behaviour.output ?? []) yield o;
                },
              };
              if (behaviour.startEvents === 'fire') setTimeout(() => starts.forEach((f) => f({ terminal: t, execution: ex })), 2);
              if (!behaviour.hang) setTimeout(() => ends.forEach((f) => f({ terminal: t, execution: ex, exitCode: behaviour.exitCode ?? 0 })), 10);
              return ex;
            },
          };
          integ.forEach((f) => f({ terminal: t, shellIntegration: t.shellIntegration }));
        }, 5);
      return t;
    },
    onDidChangeTerminalShellIntegration(cb) {
      integ.push(cb);
      return { dispose: () => integ.splice(integ.indexOf(cb), 1) };
    },
    onDidEndTerminalShellExecution(cb) {
      ends.push(cb);
      return { dispose: () => ends.splice(ends.indexOf(cb), 1) };
    },
    onDidCloseTerminal() {
      return { dispose() {} };
    },
    ...(behaviour.startEvents
      ? {
          onDidStartTerminalShellExecution(cb: (e: any) => void) {
            starts.push(cb);
            return { dispose: () => starts.splice(starts.indexOf(cb), 1) };
          },
        }
      : {}),
  };
  return { api, terms, executed };
}

test('B10 (CI): a command the terminal accepts but never starts is cancelled after the start timeout, not waited on; later commands run hidden', async () => {
  const f = fakeTermApi({ integration: true, hang: true, startEvents: 'never' });
  const r = new VisibleTerminalRunner(f.api, { name: 'Tugline', integrationTimeoutMs: 500, startTimeoutMs: 200 });
  const t0 = Date.now();
  const res = await r.run({ ...CMD, timeoutMs: 60_000 });
  assert.ok(res && Date.now() - t0 < 5000, 'returned promptly, not after the 60 s timeout');
  assert.equal(res!.exitCode, null);
  assert.match(res!.output, /did not start the command .*cancelled and did not run/);
  assert.ok(f.terms[0].sent.includes('\x03'), 'the typed line was interrupted');
  assert.equal(await r.run(CMD), undefined, 'the next command runs hidden (the caller spawns it)');
  // control: a terminal that reports the start runs normally
  const g = fakeTermApi({ integration: true, output: ['hi\r\n'], startEvents: 'fire' });
  const ok = await new VisibleTerminalRunner(g.api, { name: 'Tugline', integrationTimeoutMs: 500, startTimeoutMs: 200 }).run(CMD);
  assert.equal(ok!.exitCode, 0);
  assert.equal(ok!.output, 'hi');
});

const CMD = { file: '/bin/bash', args: ['-c', 'echo hi'], cwd: '/ws', env: { PATH: '/usr/bin', TUGLINE: '1' }, command: 'echo hi', timeoutMs: 5000 };

test('B10: with shell integration the exact wrapped spec runs in the terminal (strict env, cwd) and returns output + exit code', async () => {
  const f = fakeTermApi({ integration: true, output: ['\x1b]633;C\x07hi\r\n', '\x1b[32mgreen\x1b[0m\r\n'], exitCode: 0 });
  const r = new VisibleTerminalRunner(f.api, { name: 'Tugline', integrationTimeoutMs: 500 });
  const res = await r.run({ ...CMD, file: 'bwrap', args: ['--ro-bind', '/', '/', '/bin/bash', '-c', "echo 'hi there'"] });
  assert.ok(res);
  assert.equal(res!.exitCode, 0);
  assert.equal(res!.output, 'hi\ngreen');
  assert.equal(f.executed[0], "/usr/bin/env -i PATH=/usr/bin TUGLINE=1 bwrap --ro-bind / / /bin/bash -c 'echo '\\''hi there'\\'''", 'the wrapper (sandbox) is what runs, with exactly the spec env');
  assert.equal(f.terms[0].opts.strictEnv, true);
  assert.deepEqual(f.terms[0].opts.env, { PATH: '/usr/bin', TUGLINE: '1' }, 'scrubbed env, nothing inherited');
  assert.equal(f.terms[0].opts.cwd, '/ws');
  assert.equal(f.terms[0].shown, 1);
  const again = await r.run({ ...CMD, cwd: '/ws/sub' });
  assert.equal(f.executed[1], "cd /ws/sub && /usr/bin/env -i PATH=/usr/bin TUGLINE=1 /bin/bash -c 'echo hi'");
  assert.equal(f.terms.length, 1, 'same env → same terminal');
  await r.run({ ...CMD, env: { PATH: '/x' } });
  assert.equal(f.terms.length, 2, 'a different env (e.g. sandbox proxy) gets a fresh terminal');
  assert.ok(f.terms[0].disposed);
  assert.equal(again!.exitCode, 0);
});

test('B10 AC2: without shell integration run() resolves undefined before sending anything (fallback to the hidden process)', async () => {
  const f = fakeTermApi({ integration: false });
  const r = new VisibleTerminalRunner(f.api, { name: 'Tugline', integrationTimeoutMs: 50 });
  const t0 = Date.now();
  assert.equal(await r.run(CMD), undefined);
  assert.deepEqual(f.terms[0].sent, [], 'nothing typed into the terminal');
  assert.equal(f.executed.length, 0);
  assert.equal(await r.run(CMD), undefined, 'known-unavailable terminal: no second wait');
  assert.ok(Date.now() - t0 < 1000);
});

test('B10: timeout sends Ctrl+C and reports timedOut', async () => {
  const f = fakeTermApi({ integration: true, hang: true, output: ['partial\n'] });
  const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 500, killGraceMs: 50 });
  const res = await r.run({ ...CMD, timeoutMs: 100 });
  assert.equal(res!.timedOut, true);
  assert.equal(res!.exitCode, null);
  assert.deepEqual(f.terms[0].sent, ['\x03']);
});

test('B10: ANSI/OSC stripping and command lines', () => {
  assert.equal(stripAnsi('\x1b]633;D;0\x07a\x1b[1mb\x1b[0m\r\nprogress 10%\rprogress 100%\n'), 'ab\nprogress 100%\n');
  assert.equal(commandLineFor({ file: '/bin/bash', args: ['-c', "it's"], cwd: '/a', env: { A: 'x y' } }, '/a'), "/usr/bin/env -i 'A=x y' /bin/bash -c 'it'\\''s'");
});

test('B10 review fix 1: a secret exported by the shell rc file does not reach a visible-terminal command (env -i with the scrubbed spec env)', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-rc-'));
  const rc = path.join(dir, 'fake.bashrc');
  fs.writeFileSync(rc, 'export TUG_FAKE_RC_KEY=sk-from-bashrc-123456\n');
  const spec = { file: '/bin/bash', args: ['-c', 'echo "[${TUG_FAKE_RC_KEY:-}] [$KEEP]"'], cwd: dir, env: { PATH: process.env.PATH, KEEP: 'kept', TUGLINE: '1' } };
  // what the interactive terminal shell does: source the rc file, then run the line it was sent
  const run = (line: string) => execFileSync('/bin/bash', ['-c', `source ${rc}; ${line}`], { cwd: dir, encoding: 'utf8' }).trim();
  assert.equal(run(commandLineFor(spec, dir)), '[] [kept]', 'the command sees exactly the spec env');
  // control: the old command line (no env -i) leaked the rc export
  assert.equal(run(`KEEP=kept ${[spec.file, ...spec.args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')}`), '[sk-from-bashrc-123456] [kept]');
});

test('B10 review fix 2: a broken output stream after the command started still resolves a result (sent once)', async () => {
  const f = fakeTermApi({ integration: true, exitCode: 0 });
  const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 500 });
  // make the output stream fail after the command was sent
  const orig = f.api.createTerminal;
  f.api.createTerminal = (o) => {
    const t = orig(o) as FakeTerm;
    setTimeout(() => {
      const si = t.shellIntegration!;
      t.shellIntegration = {
        executeCommand(line: string) {
          const ex = si.executeCommand(line);
          return {
            async *read() {
              yield 'partial\n';
              throw new Error('stream broke');
            },
            __inner: ex,
          } as any;
        },
      };
    }, 10);
    return t;
  };
  await new Promise((res) => setTimeout(res, 0));
  const res = await r.run({ ...CMD, timeoutMs: 300 });
  assert.ok(res, 'resolved with a result');
  assert.equal(f.executed.length, 1, 'sent once');
});

// ------------------------------------------------------------ B11 / B12: config editing

test('B12 AC1: writing the protected-paths list updates the config JSON and keeps everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cfg-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '// my config\n{\n  "profile": "x",\n  "permissions": { "allow": ["bash(npm test)"], "protectedPaths": ["old/**"] },\n  "mcpServers": { "a": { "command": "a" } }\n}\n');
  setProtectedPaths(f, ['tests/**', ' .github/** ', '', 'tests/**']);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(j.permissions.protectedPaths, ['tests/**', '.github/**']);
  assert.deepEqual(j.permissions.allow, ['bash(npm test)']);
  assert.equal(j.profile, 'x');
  assert.deepEqual(j.mcpServers, { a: { command: 'a' } });
  // and loadConfig sees it (project scope)
  const ws = tmpWorkspace({});
  const pf = path.join(ws, '.tugline', 'config.json');
  setProtectedPaths(pf, ['secret/**']);
  const cfg = loadConfig({ workspace: ws, noUserConfig: true });
  assert.ok(cfg.permissions.protectedPaths.includes('secret/**'), 'protected paths apply even from untrusted project config');
  setPermissionRules(pf, { allow: ['bash(ls)'], deny: ['bash(rm *)'] });
  setHooks(pf, 'PreToolUse', [{ matcher: 'bash', command: ' ./check.sh ' }]);
  const pj = readConfigFile(pf);
  assert.deepEqual(pj.permissions, { protectedPaths: ['secret/**'], allow: ['bash(ls)'], deny: ['bash(rm *)'] });
  assert.deepEqual(pj.hooks, { PreToolUse: [{ matcher: 'bash', command: './check.sh' }] });
  setHooks(pf, 'PreToolUse', []);
  assert.deepEqual(readConfigFile(pf).hooks, {});
  assert.throws(() => setHooks(pf, 'bad event', []));
});

test('B11 AC1 (unit): toggling a server writes the user config; toggles apply by name (user) or name@workspace (project)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cfg-'));
  const f = path.join(dir, 'config.json');
  addMcpServer(f, 'calc', { command: 'node', args: ['calc.mjs'] });
  setMcpToggle(f, mcpToggleKey('calc', 'user'), { disabled: true });
  setMcpToggle(f, mcpToggleKey('proj', 'project', '/ws'), { trusted: true });
  const j = readConfigFile(f);
  assert.deepEqual(j.ide.mcp, { calc: { disabled: true }, 'proj@/ws': { trusted: true } });
  const eff = applyMcpToggles({ calc: { command: 'node' }, proj: { command: 'p' } }, j.ide.mcp, { calc: 'user', proj: 'project' }, '/ws');
  assert.equal(eff.calc.disabled, true);
  assert.equal(eff.proj.trusted, true);
  const other = applyMcpToggles({ proj: { command: 'p' } }, j.ide.mcp, { proj: 'project' }, '/elsewhere');
  assert.equal(other.proj.trusted, undefined, 'a same-named server in another workspace is not trusted');
  setSkillEnabled(f, 'web-pages', false);
  setSkillEnabled(f, 'tdd', false);
  setSkillEnabled(f, 'web-pages', true);
  assert.deepEqual(readConfigFile(f).skills.disabled, ['tdd']);
});

test('B11: MCP registry replies become install suggestions', () => {
  const r = parseRegistry({
    servers: [
      { server: { name: 'io.github.x/fs-mcp', description: 'files', version: '1.2.0', packages: [{ registryType: 'npm', identifier: '@x/fs-mcp', version: '1.2.0' }] } },
      { server: { name: 'com.y/remote', description: 'remote', remotes: [{ type: 'streamable-http', url: 'https://y.com/mcp' }] } },
      { server: { name: 'py', packages: [{ registryType: 'pypi', identifier: 'mcp-py' }] } },
      { nothing: true },
    ],
  });
  assert.equal(r.length, 3);
  assert.deepEqual(r[0].config, { command: 'npx', args: ['-y', '@x/fs-mcp@1.2.0'] });
  assert.deepEqual(r[1].config, { url: 'https://y.com/mcp' });
  assert.deepEqual(r[2].config, { command: 'uvx', args: ['mcp-py'] });
});

// ------------------------------------------------------------ B13: notifications

test('B13 AC1: a run longer than 30 s notifies when it ends; a permission request notifies only when the panel is hidden', async () => {
  const shown: string[] = [];
  let now = 0;
  let visible = true;
  let revealed = 0;
  const win = { showInformationMessage: async (m: string) => (shown.push(m), 'Show') };
  const n = new Notifier(win, { enabled: () => true, afterMs: () => DEFAULT_IDE.notifyAfterMs, panelVisible: () => visible, reveal: () => revealed++, now: () => now });
  n.onEvent('chat', { type: 'run_start', runId: 'r', prompt: 'p', model: 'm' });
  now = 10_000;
  n.onEvent('chat', { type: 'run_end', stopReason: 'end_turn', finalText: 'quick', stats: stats() });
  assert.equal(shown.length, 0, 'short runs are quiet');
  n.onEvent('chat', { type: 'run_start', runId: 'r2', prompt: 'p', model: 'm' });
  now = 45_000;
  n.onEvent('chat', { type: 'run_end', stopReason: 'end_turn', finalText: 'Fixed the bug.', stats: stats() });
  assert.equal(shown.length, 1);
  assert.match(shown[0], /finished after 35s.*Fixed the bug/);
  n.onRequest('chat', 'Run: npm publish');
  assert.equal(shown.length, 1, 'panel visible: no popup');
  visible = false;
  n.onRequest('chat', 'Run: npm publish');
  assert.equal(shown.length, 2);
  assert.match(shown[1], /waiting for you.*npm publish/);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(revealed, 2, '"Show" reveals the panel');
  const off = new Notifier(win, { enabled: () => false, afterMs: () => 0, panelVisible: () => false, reveal: () => {} });
  off.onRequest('c', 'x');
  assert.equal(off.shown.length, 0);
});

// ------------------------------------------------------------ B14: FIM autocomplete

test('B14 AC1: FIM prompt builder for the Qwen and llama.cpp formats', () => {
  const i = { prefix: 'def add(a, b):\n    ', suffix: '\n\nprint(add(1, 2))\n', path: 'm.py', extra: [{ filename: 'util.py', text: 'X = 1' }] };
  assert.equal(buildFimPrompt('qwen', { prefix: 'a', suffix: 'b' }), '<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>');
  assert.equal(buildFimPrompt('qwen', i), '<|repo_name|>workspace\n<|file_sep|>util.py\nX = 1\n<|file_sep|>m.py\n<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\n\nprint(add(1, 2))\n<|fim_middle|>');
  const infill = buildInfillBody(i, 128);
  assert.deepEqual(infill, { input_prefix: i.prefix, input_suffix: i.suffix, input_extra: [{ filename: 'util.py', text: 'X = 1' }], n_predict: 128, temperature: 0.1, stream: false, cache_prompt: true });
  const c = buildCompletionsBody('qwen2.5-coder', 'qwen', i, 64) as any;
  assert.equal(c.max_tokens, 64);
  assert.ok(c.stop.includes('<|endoftext|>'));
  assert.equal((buildCompletionsBody('m', 'suffix', i, 64) as any).suffix, i.suffix);
  assert.equal(fimUrl('http://h:8080/v1', 'llama-infill'), 'http://h:8080/infill');
  assert.equal(fimUrl('http://h:8080/v1/', 'completions'), 'http://h:8080/v1/completions');
  assert.equal(postProcess('return a + b<|endoftext|>junk', i), 'return a + b');
  assert.equal(postProcess('x = 1\ny = 2', { prefix: 'z = ', suffix: '' }), 'x = 1', 'single line mid-line');
  assert.equal(postProcess('    return 1\n', { prefix: 'def f():\n', suffix: '' }), '    return 1', 'block after an opener');
});

test('B14 AC2: the provider is not registered when disabled; when enabled it completes against a mock /infill and is cancellable', async () => {
  const calls: unknown[] = [];
  const languages = { registerInlineCompletionItemProvider: (sel: unknown, p: unknown) => (calls.push(p), { dispose() {} }) };
  assert.equal(registerAutocomplete(languages, false, {}), undefined);
  assert.equal(calls.length, 0);
  assert.ok(ideConfig({}).autocomplete.enabled === false, 'off by default');
  assert.ok(registerAutocomplete(languages, true, {}));
  assert.equal(calls.length, 1);
  const bodies: any[] = [];
  const srv = http.createServer((q, s) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', () => {
      bodies.push({ url: q.url, body: JSON.parse(b) });
      s.end(JSON.stringify({ content: 'a + b\nmore' }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const baseUrl = `http://127.0.0.1:${(srv.address() as any).port}/v1`;
  const deps = { fetch, config: () => ({ ...ideConfig({}).autocomplete, enabled: true, endpoint: 'llama-infill' as const, debounceMs: 20, baseUrl, model: 'm' }) };
  const out = await completeFim(deps, { prefix: 'return ', suffix: '' }, { isCancellationRequested: false });
  assert.equal(out, 'a + b');
  assert.equal(bodies[0].url, '/infill');
  assert.equal(bodies[0].body.n_predict, 128);
  const cancelled = await completeFim(deps, { prefix: 'x', suffix: '' }, { isCancellationRequested: true });
  assert.equal(cancelled, '');
  assert.equal(bodies.length, 1, 'a request cancelled during the debounce is never sent');
  srv.close();
});

// ------------------------------------------------------------ B6: history

function fakeJournal(home: string, ws: string, id: string, prompt: string, answer: string): string {
  const j = new Journal(home, ws, id);
  j.write({ type: 'event', event: { type: 'run_start', runId: 'r', prompt, model: 'm' } });
  j.write({ type: 'message', message: { role: 'system', content: 'sys' } });
  j.write({ type: 'message', message: { role: 'user', content: prompt } });
  j.write({ type: 'message', message: { role: 'assistant', content: answer } });
  j.write({ type: 'event', event: { type: 'run_end', stopReason: 'end_turn', finalText: answer, stats: stats() } });
  return j.file;
}

test('B6 AC2: resume restores the messages; rename and delete (to trash/) keep the hash-chained journal intact', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  const ws = tmpWorkspace({});
  const f = fakeJournal(home, ws, 's1', 'fix the parser <attached_context source="@a">x</attached_context>', 'Done: the tokenizer now handles quotes.');
  fakeJournal(home, ws, 's2', 'add a flag', 'Added --verbose.');
  const list = listSessions(home, ws);
  assert.deepEqual(list.map((s) => s.id).sort(), ['s1', 's2']);
  assert.equal(list.find((s) => s.id === 's1')!.title, 'fix the parser');
  const msgs = loadSessionMessages(f);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.equal(msgs[1].content, 'Done: the tokenizer now handles quotes.');
  renameSession(home, ws, 's1', 'Parser quotes');
  assert.equal(listSessions(home, ws).find((s) => s.id === 's1')!.title, 'Parser quotes');
  assert.equal(Journal.verify(f), 0, 'journal untouched by rename');
  const trashed = deleteSession(home, ws, 's2');
  assert.ok(trashed.includes(`${path.sep}trash${path.sep}`) && fs.existsSync(trashed));
  assert.deepEqual(listSessions(home, ws).map((s) => s.id), ['s1']);
  assert.throws(() => deleteSession(home, ws, '../x'));
  assert.equal(titleFromPrompt('a'.repeat(100)).length, 58);
});

test('B6 AC3: search finds a session by a word in its answer (and in prompts)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-'));
  const ws = tmpWorkspace({});
  fakeJournal(home, ws, 's1', 'fix the parser', 'Done: the tokenizer now handles quotes.');
  fakeJournal(home, ws, 's2', 'add a flag', 'Added --verbose.');
  const hits = searchSessions(home, ws, 'TOKENIZER');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].session.id, 's1');
  assert.equal(hits[0].where, 'answer');
  assert.match(hits[0].snippet, /tokenizer now handles/);
  assert.equal(searchSessions(home, ws, 'flag')[0].session.id, 's2');
  assert.deepEqual(searchSessions(home, ws, 'nomatch'), []);
});

test('B: ide config defaults (risky features off)', () => {
  const d = ideConfig({});
  assert.equal(d.visibleTerminal, false);
  assert.equal(d.autocomplete.enabled, false);
  assert.equal(d.ocr, false);
  assert.equal(d.autoSave, true);
  assert.equal(ideConfig({ ide: { autocomplete: { maxTokens: 64 } } }).autocomplete.debounceMs, 250);
});

test('B14 review fix 5 / R2: settings that move code, keys or authority are application-scoped (a repo .vscode/settings.json cannot set them)', () => {
  const props = JSON.parse(fs.readFileSync(path.join('vscode', 'package.json'), 'utf8')).contributes.configuration.properties;
  for (const k of ['baseUrl', 'extraHeaders', 'mcpServers', 'permissionMode', 'shellMode', 'visibleTerminal', 'browser.enabled', 'approver.enabled', 'approver.profile', 'autocomplete.enabled', 'autocomplete.profile', 'autocomplete.endpoint', 'autocomplete.template'])
    assert.equal(props[`tugline.${k}`]?.scope, 'application', k);
});


// ------------------------------------------------------------ v1.1 Q3: Windows terminals (pwsh, cmd) and the decline path

/** Every character that a Windows or POSIX shell treats specially, in one value. */
const TRICKY = `a"b'c%PATH%d\`e$HOME f&g|h<i>(j)^k‘l’ %SECRET% 100%^x\\"y\\`;

/** PowerShell's tokenizer for single-quoted literals: any of the five single-quote characters ends one, two in a row are one literal quote. */
function psLiterals(script: string): { skeleton: string; literals: string[] } {
  const isQ = (c: string | undefined) => c !== undefined && "'\u2018\u2019\u201a\u201b".includes(c);
  let skeleton = '';
  const literals: string[] = [];
  for (let i = 0; i < script.length; i++) {
    if (!isQ(script[i])) {
      skeleton += script[i];
      continue;
    }
    let lit = '';
    for (i++; ; i++) {
      assert.ok(i < script.length, 'unterminated literal');
      if (isQ(script[i]) && isQ(script[i + 1])) lit += script[++i];
      else if (isQ(script[i])) break;
      else lit += script[i];
    }
    literals.push(lit);
    skeleton += '<L>';
  }
  return { skeleton, literals };
}

/** CommandLineToArgvW / MSVC argument parsing (the arguments part, after the program name). */
function msvcSplit(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    let cur = '';
    let q = false;
    for (; i < s.length && (q || (s[i] !== ' ' && s[i] !== '\t')); i++) {
      let bs = 0;
      while (s[i] === '\\') bs++, i++;
      if (s[i] === '"') {
        cur += '\\'.repeat(bs >> 1);
        if (bs % 2) cur += '"';
        else q = !q;
      } else {
        cur += '\\'.repeat(bs);
        i--;
        if (bs === 0) cur += s[++i];
      }
    }
    out.push(cur);
  }
  return out;
}

/**
 * A model of cmd.exe parsing one command line in command-line context (not a
 * batch file), after dbenham's phase description: phase 1 expands %VAR% (it
 * ignores quotes and carets; an undefined name is left as is and parsing goes
 * on either at the second % or after it: both are modelled); phase 2 handles
 * quotes, carets and & / &&. `expanded` lists every lookup that hit a defined
 * variable (%VAR:~…% and %VAR:a=b% included), `bare` every unescaped special.
 */
function cmdParse(line: string, env: Record<string, string>, resume: 'at-second' | 'after-second') {
  const expanded: string[] = [];
  let s = '';
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '%') {
      s += line[i++];
      continue;
    }
    const j = line.indexOf('%', i + 1);
    if (j < 0) {
      s += line.slice(i);
      break;
    }
    const name = line.slice(i + 1, j);
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.split(':')[0].toLowerCase());
    if (name && key !== undefined) {
      expanded.push(name);
      s += env[key];
      i = j + 1;
    } else if (resume === 'at-second') {
      s += line.slice(i, j);
      i = j;
    } else {
      s += line.slice(i, j + 1);
      i = j + 1;
    }
  }
  const cmds: string[] = [];
  const seps: string[] = [];
  const bare: string[] = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '"') quote = false;
    } else if (c === '"') {
      quote = true;
      cur += c;
    } else if (c === '^') {
      assert.ok(i + 1 < s.length, 'a caret at the end of the line would make cmd prompt "More?"');
      cur += s[++i];
    } else if (c === '&') {
      cmds.push(cur.trimStart());
      seps.push(s[i + 1] === '&' ? (i++, '&&') : '&');
      cur = '';
    } else {
      if ('|<>()!'.includes(c)) bare.push(c);
      cur += c;
    }
  }
  assert.equal(quote, false, 'quotes balanced');
  cmds.push(cur.trimStart());
  return { cmds, seps, bare, expanded };
}

/** The interactive terminal's env: everything a profile might have exported, and names the escaping must never hit. */
const USER_ENV: Record<string, string> = { PATH: 'C:\\Users\\me\\bin', SECRET: 'sk-live-123456789', HOME: 'C:\\Users\\me', V: 'user-v', A: 'user-a', x: 'user-x', y: 'user-y', d: 'user-d' };

test('Q3: shell kind from the terminal shell path; unknown shells and POSIX shells on Windows are declined', () => {
  assert.equal(shellKindOf('/bin/bash', 'linux'), 'posix');
  assert.equal(shellKindOf('/usr/bin/zsh', 'darwin'), 'posix');
  assert.equal(shellKindOf(undefined, 'linux'), 'posix');
  assert.equal(shellKindOf('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32'), 'pwsh');
  assert.equal(shellKindOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'pwsh');
  assert.equal(shellKindOf('/usr/local/bin/pwsh', 'linux'), 'pwsh');
  assert.equal(shellKindOf('C:\\Windows\\System32\\cmd.exe', 'win32'), 'cmd');
  assert.equal(shellKindOf('C:\\WINDOWS\\system32\\CMD.EXE', 'win32'), 'cmd');
  assert.equal(shellKindOf('/usr/bin/fish', 'linux'), undefined);
  assert.equal(shellKindOf('C:\\Program Files\\Git\\bin\\bash.exe', 'win32'), undefined, 'Git Bash on Windows: declined');
  assert.equal(shellKindOf('C:\\tools\\nu.exe', 'win32'), undefined);
  assert.equal(shellKindOf(undefined, 'win32'), undefined);
});

test('Q3: bash command line keeps values with " \' % ` $ & ^ exact (real bash, rc file sourced)', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-q3-'));
  const rc = path.join(dir, 'rc');
  fs.writeFileSync(rc, 'export LEAK=sk-rc-123456789\n');
  const spec = { file: '/bin/bash', args: ['-c', 'printf "%s|%s|%s" "$V" "${LEAK:-none}" "$1"', 'x', TRICKY], cwd: dir, env: { PATH: process.env.PATH, V: TRICKY } };
  const line = commandLineForShell('posix', spec, { terminalCwd: dir })!;
  assert.equal(line, commandLineFor(spec, dir));
  const out = execFileSync('/bin/bash', ['-c', `source ${rc}; ${line}`], { cwd: dir, encoding: 'utf8' });
  assert.equal(out, `${TRICKY}|none|${TRICKY}`, 'values exact, and the rc-exported secret is gone');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Q3: PowerShell command line: -NoProfile -NonInteractive, & { } block clears inherited env, sets the spec env, runs the command verbatim; " \' % ` $ & ^ quoted correctly', () => {
  const spec = { file: 'C:\\WINDOWS\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'echo "x" %v% `y` $z & ver ^| more'], cwd: "C:\\work dir\\o'neil ‘q’", env: { PATH: 'C:\\Windows', V: TRICKY, 'ProgramFiles(x86)': 'C:\\PF86', "BAD NAME": 'dropped' } };
  const line = commandLineForShell('pwsh', spec, { shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })!;
  const m = /^& 'C:\\Program Files\\PowerShell\\7\\pwsh\.exe' -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
  assert.ok(m, line);
  const script = Buffer.from(m![1], 'base64').toString('utf16le');
  assert.equal(script, pwshScript(spec));
  const { skeleton, literals } = psLiterals(script);
  // Every value is inside a literal: the code around them is exactly this.
  assert.equal(
    skeleton,
    '& { $keep = @(<L>, <L>, <L>); ' +
      'foreach ($n in @(Get-ChildItem Env: | ForEach-Object Name)) { if ($keep -cnotcontains $n) { [Environment]::SetEnvironmentVariable($n, $null) } }; ' +
      '[Environment]::SetEnvironmentVariable(<L>, <L>); [Environment]::SetEnvironmentVariable(<L>, <L>); [Environment]::SetEnvironmentVariable(<L>, <L>); ' +
      '$psi = [System.Diagnostics.ProcessStartInfo]::new(<L>, <L>); $psi.UseShellExecute = $false; $psi.WorkingDirectory = <L>; ' +
      '$p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode }',
  );
  assert.deepEqual(literals, [
    'PATH', 'ProgramFiles(x86)', 'V',
    'PATH', 'C:\\Windows', 'ProgramFiles(x86)', 'C:\\PF86', 'V', TRICKY,
    'C:\\WINDOWS\\system32\\cmd.exe', '/d /s /c "echo "x" %v% `y` $z & ver ^| more"',
    "C:\\work dir\\o'neil ‘q’",
  ]);
  // A program other than cmd.exe gets MSVC-quoted arguments that split back exactly.
  const other = { file: 'C:\\Program Files\\Docker\\docker.exe', args: ['run', TRICKY, '', 'a b\\', 'c\\\\"d'], cwd: 'C:\\', env: {} };
  const lits = psLiterals(pwshScript(other)).literals;
  assert.equal(lits[0], 'C:\\Program Files\\Docker\\docker.exe');
  assert.deepEqual(msvcSplit(lits[1]), other.args);
  assert.equal(psLiterals(pwshScript(other)).skeleton.startsWith('& { $keep = @(); '), true, 'empty spec env: everything inherited is cleared');
  assert.equal(psQuote("it's"), "'it''s'");
});

test('Q3: cmd.exe command line: cmd /d /v:off /c with setlocal, inherited env cleared, explicit sets; " \' % ` $ & ^ survive both cmd parses and no %VAR% ever expands', () => {
  const spec = { file: 'C:\\WINDOWS\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'echo %SECRET% & echo "a & b" 100%'], cwd: 'C:\\w (1)\\50%^off', env: { PATH: 'C:\\Windows;C:\\Program Files (x86)\\x', V: TRICKY, 'ProgramFiles(x86)': 'C:\\PF86', E: '%A%%PATH%%%' + '^' } };
  const shellPath = 'C:\\Windows\\System32\\cmd.exe';
  const line = commandLineForShell('cmd', spec, { shellPath })!;
  assert.ok(line);
  for (const resume of ['at-second', 'after-second'] as const) {
    // 1) the interactive shell parses the typed line: one command, nothing expanded, nothing unescaped
    const outer = cmdParse(line, USER_ENV, resume);
    assert.deepEqual(outer.expanded, [], `${resume}: the interactive shell expands nothing`);
    assert.deepEqual(outer.bare, []);
    assert.equal(outer.cmds.length, 1, 'the interactive shell runs exactly one command');
    const prefix = `${shellPath} /d /v:off /c `;
    assert.ok(outer.cmds[0].startsWith(prefix), outer.cmds[0]);
    const child = outer.cmds[0].slice(prefix.length);
    assert.equal(child, cmdInnerLine(spec));
    // 2) the child cmd.exe parses its line (before any of its sets ran: it still has the user's env)
    const inner = cmdParse(child, USER_ENV, resume);
    assert.deepEqual(inner.expanded, [], `${resume}: the child expands nothing either (the secret never reaches the command)`);
    assert.deepEqual(inner.bare, ['(', ')'], "the only bare specials are the for loop's ('set')");
    assert.deepEqual(inner.cmds, [
      'setlocal',
      `for /f "delims==" %A in ('set') do @set "%A="`,
      'set E=%A%%PATH%%%^',
      'set PATH=C:\\Windows;C:\\Program Files (x86)\\x',
      'set ProgramFiles(x86)=C:\\PF86',
      `set V=${TRICKY}`,
      'cd /d C:\\w (1)\\50%^off',
      'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "echo %SECRET% & echo "a & b" 100%"',
    ]);
    assert.deepEqual(inner.seps, ['&', '&', '&', '&', '&', '&', '&&'], 'the command runs only if cd succeeded');
  }
  // the program gets exactly the command line the hidden path would give it
  assert.equal(windowsCommandLine(spec.file, spec.args), 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "echo %SECRET% & echo "a & b" 100%"');
  assert.equal(windowsCommandLine('C:\\x.exe', ['a b', 'c"d', '']), 'C:\\x.exe "a b" "c\\"d" ""');
  assert.equal(msvcQuote('a\\\\"b\\'), '"a\\\\\\\\\\"b\\\\"');
  assert.deepEqual(msvcSplit(['a\\\\"b\\', TRICKY, '', 'x'].map(msvcQuote).join(' ')), ['a\\\\"b\\', TRICKY, '', 'x']);
  assert.equal(cmdEscape('%&'), '%^&', 'a % before a special shares its caret (not %^^& , which would leave & bare)');
  assert.equal(cmdEscape('%%x'), '%^%^x');
  assert.equal(cmdEscape('100%'), '100%', 'a trailing % has nothing to pair with, and a trailing caret would prompt More?');
  // an odd shell path falls back to plain cmd.exe; a path with spaces is quoted
  assert.ok(commandLineForShell('cmd', spec, { shellPath: 'C:\\odd%dir\\cmd.exe' })!.startsWith('cmd.exe /d /v:off /c '));
  assert.ok(commandLineForShell('cmd', spec, { shellPath: 'C:\\My Tools\\cmd.exe' })!.startsWith('"C:\\My Tools\\cmd.exe" /d /v:off /c '));
});

test('Q3: lines a shell cannot express are declined (cmd: ! newlines, quoted program, UNC cwd, trailing %, length; pwsh: NUL, length)', () => {
  const base = { file: 'C:\\x.exe', args: ['a'], cwd: 'C:\\', env: { PATH: 'C:\\' } };
  assert.ok(commandLineForShell('cmd', base));
  assert.equal(commandLineForShell('cmd', { ...base, env: { V: 'two\nlines' } }), undefined);
  assert.equal(commandLineForShell('cmd', { ...base, args: ['wow!'] }), undefined, "the interactive shell's delayed expansion is unknown");
  assert.equal(commandLineForShell('cmd', { ...base, file: 'C:\\Program Files\\x.exe' }), undefined, 'cmd would split a caret-escaped quoted path');
  assert.equal(commandLineForShell('cmd', { ...base, cwd: '\\\\server\\share' }), undefined, 'cmd cannot cd to a UNC path');
  assert.equal(commandLineForShell('cmd', { ...base, env: { V: '100%' } }), undefined);
  assert.equal(commandLineForShell('cmd', { ...base, cwd: 'C:\\50%' }), undefined);
  assert.equal(commandLineForShell('cmd', { ...base, env: { V: 'x'.repeat(9000) } }), undefined);
  assert.equal(commandLineForShell('pwsh', { ...base, env: { V: 'x'.repeat(20000) } }), undefined);
  assert.equal(commandLineForShell('pwsh', { ...base, env: { V: 'nul\0' } }), undefined);
  assert.ok(commandLineForShell('pwsh', { ...base, env: { V: 'two\nlines' }, file: 'C:\\Program Files\\x.exe', cwd: '\\\\server\\share' }), 'pwsh carries all of these inside its encoded script');
});

test('Q3: the runner resolves undefined (decline) for unknown shells and inexpressible lines BEFORE creating or sending anything; pwsh and cmd terminals on Windows run their lines', async () => {
  const cases: [string | undefined, NodeJS.Platform, typeof CMD][] = [
    ['/usr/bin/fish', 'linux', CMD],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32', CMD],
    [undefined, 'win32', CMD],
    ['C:\\Windows\\System32\\cmd.exe', 'linux', CMD],
    ['C:\\Windows\\System32\\cmd.exe', 'win32', { ...CMD, env: { V: 'two\nlines' } }],
  ];
  for (const [shell, platform, cmd] of cases) {
    const f = fakeTermApi({ integration: true });
    const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 200, shellPath: () => shell, platform });
    assert.equal(await r.run(cmd), undefined, `${shell} on ${platform}: declined`);
    assert.equal(f.terms.length, 0, 'no terminal was even created');
    assert.equal(f.executed.length, 0, 'nothing was sent');
  }
  const winCmd = { ...CMD, file: 'C:\\WINDOWS\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'echo hi'], cwd: 'C:\\ws', env: { Path: 'C:\\Windows' } };
  {
    const f = fakeTermApi({ integration: true, output: ['hi\r\n'], exitCode: 0 });
    const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 500, shellPath: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', platform: 'win32' });
    const res = await r.run(winCmd);
    assert.equal(res!.output, 'hi');
    assert.equal(res!.exitCode, 0);
    assert.equal(f.executed[0], commandLineForShell('pwsh', winCmd, { shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }));
    assert.doesNotMatch(f.executed[0], /env -i/);
  }
  {
    const f = fakeTermApi({ integration: true, output: ['hi\r\n'], exitCode: 0 });
    const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 500, shellPath: () => 'C:\\Windows\\System32\\cmd.exe', platform: 'win32' });
    const res = await r.run(winCmd);
    assert.equal(res!.output, 'hi');
    assert.equal(f.executed[0], 'C:\\Windows\\System32\\cmd.exe /d /v:off /c setlocal^& for /f ^"delims==^" %^A in ^(\'set\'^) do @set ^"%^A=^"^& set Path=C:\\Windows^& cd /d C:\\ws^&^& C:\\WINDOWS\\system32\\cmd.exe /d /s /c ^^^"echo hi^^^"');
  }
});

// ------------------------------------------------------------ v1.1 N30: sandbox state in the VS Code status bar

test('N30 (VS Code): the status bar shows sandboxStatus(cfg).summary; warning when unsandboxed in auto mode, error when a required sandbox is missing', () => {
  const cfg = (over: Record<string, unknown>) => {
    const c = testConfig('http://unused', over);
    if ((over.shell as { requireSandbox?: boolean } | undefined)?.requireSandbox === undefined) delete (c.shell as { requireSandbox?: boolean }).requireSandbox;
    return c;
  };
  const off = sandboxStatus(cfg({ shell: { sandbox: 'auto' } }), () => false);
  const warn = sandboxBadge(off, 'auto');
  assert.equal(warn.level, 'warn');
  assert.match(warn.text, /unsandboxed \(auto mode\)/);
  assert.ok(warn.tooltip.includes(off.summary), 'the same summary as the CLI banner');
  assert.match(warn.tooltip, /UNSANDBOXED/);
  for (const mode of ['ask', 'acceptEdits', 'plan']) assert.equal(sandboxBadge(off, mode).level, 'info', `${mode}: commands still ask, no warning`);
  const on = sandboxStatus(cfg({ shell: { sandbox: 'auto' } }), () => true);
  if (on.runner !== 'none') {
    const ok = sandboxBadge(on, 'auto');
    assert.equal(ok.level, 'ok');
    assert.equal(ok.text, `$(shield) sandbox: ${on.runner}`);
    assert.equal(ok.tooltip, `Tugline ${on.summary}`);
  }
  const req = sandboxStatus(cfg({ shell: { sandbox: 'auto', requireSandbox: true } }), () => false);
  const err = sandboxBadge(req, 'ask');
  assert.equal(err.level, 'error');
  assert.match(err.tooltip, /REQUIRED but unavailable/);
});

test('B10 / N30: a value with newlines (the sandbox bridge script) stays on ONE typed line via $\'…\' and arrives exact in real bash; sh/dash decline it before sending', async () => {
  const { execFileSync } = await import('node:child_process');
  const script = "const a='x';\n\tconsole.log(a + \"\\\\\");\r\x01end";
  const spec = { file: '/bin/bash', args: ['-c', 'printf "%s" "$1"', 'x', script], cwd: '/tmp', env: { PATH: process.env.PATH, MULTI: 'one\ntwo' } };
  const line = commandLineForShell('posix', spec, { terminalCwd: '/tmp', shellPath: '/bin/bash' })!;
  assert.ok(line);
  assert.doesNotMatch(line, /[\n\r\x01]/, 'one line: no continuation prompt in the terminal');
  assert.equal(execFileSync('/bin/bash', ['-c', line], { encoding: 'utf8' }), script, 'exact bytes');
  assert.equal(execFileSync('/bin/bash', ['-c', commandLineFor({ ...spec, args: ['-c', 'printf "%s" "$MULTI"'] }, '/tmp')], { encoding: 'utf8' }), 'one\ntwo');
  assert.equal(ansiCQuote("it's\\\n"), "$'it\\'s\\\\\\n'");
  assert.equal(commandLineForShell('posix', spec, { terminalCwd: '/tmp', shellPath: '/bin/dash' }), undefined, 'dash has no $\'…\'');
  assert.equal(commandLineForShell('posix', spec, { terminalCwd: '/tmp' }), undefined, 'unknown shell: declined');
  assert.ok(commandLineForShell('posix', { ...spec, args: ['-c', 'echo hi'], env: { PATH: '/usr/bin' } }, { shellPath: '/bin/sh' }), 'plain lines still run in sh');
  // the runner declines before creating a terminal
  const f = fakeTermApi({ integration: true });
  const r = new VisibleTerminalRunner(f.api, { name: 'OH', integrationTimeoutMs: 200, shellPath: () => '/bin/sh', platform: 'linux' });
  assert.equal(await r.run({ ...CMD, args: ['-c', 'echo "a\nb"'] }), undefined);
  assert.equal(f.terms.length, 0);
});

// ------------------------------------------------------------ v1.1 WS4 follow-ups (R4, R8, R2, R14)

test('R4 (VS Code): image description and inline edit calls go through admission: refused before sending when a limit is exhausted, metered in the chat agent otherwise', async () => {
  const srv = await startMockServer(() => ({ content: 'a screenshot of a login form' }));
  after(() => srv.close());
  const req = { messages: [{ role: 'user' as const, content: 'describe' }], maxTokens: 100, noStream: true };
  // no chat agent (inline edit before any chat): a scope of its own for the governed config
  const exhausted = testConfig(srv.url, { limits: { maxTokensPerDay: 0 } });
  await assert.rejects(admittedComplete(new LLMClient(resolveProfile(exhausted)), req, { config: exhausted, kind: 'inline', role: 'editor' }), (e: unknown) => e instanceof LLMError && e.kind === 'budget');
  // inside a chat agent whose run budget is exhausted
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { agent: { repoMapTokens: 0, maxTokens: 0 } }), mcp: false, journal: false });
  await assert.rejects(admittedComplete(new LLMClient(resolveProfile(a.config)), req, { agent: a, config: a.config, kind: 'vision', role: 'vision' }), /run budget is exhausted/);
  assert.equal(srv.requests.length, 0, 'nothing was sent');
  // unlimited: the call goes through and is metered under the chat agent (usage event with the role)
  const roles: string[] = [];
  const b = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { agent: { repoMapTokens: 0 } }), mcp: false, journal: false, ui: { onEvent: (e) => e.type === 'usage' && roles.push(e.role ?? '') } });
  const r = await admittedComplete(new LLMClient(resolveProfile(b.config)), req, { agent: b, config: b.config, kind: 'vision', role: 'vision' });
  assert.equal(r.text, 'a screenshot of a login form');
  assert.deepEqual(roles, ['vision']);
  assert.equal(b.totals.llmCalls, 1);
});

function fakeDoc(fsPath: string, o: Partial<DocLike> & { saveResult?: boolean | Error } = {}): DocLike & { saves: number } {
  const d: any = { key: `file://${fsPath}`, fsPath, isDirty: true, isClosed: false, saves: 0, ...o };
  d.save = async () => {
    d.saves++;
    if (o.saveResult instanceof Error) throw o.saveResult;
    return o.saveResult ?? true;
  };
  return d;
}

test('R8 (VS Code): flushForShell reports saved / skipped (the user\'s unsaved changes) / failed; saveDocuments saves exactly the chosen documents', async () => {
  const ws = '/work';
  const agentEdit = fakeDoc('/work/a.ts');
  const userDirtyTouched = fakeDoc('/work/b.ts');
  const userDirtyOther = fakeDoc('/work/c.ts');
  const outside = fakeDoc('/elsewhere/d.ts');
  const cannotSave = fakeDoc('/work/e.ts', { saveResult: false });
  const throws = fakeDoc('/work/f.ts', { saveResult: new Error('read-only file system') });
  const clean = fakeDoc('/work/g.ts', { isDirty: false });
  const touched = new Map([[agentEdit.key, false], [userDirtyTouched.key, true], [cannotSave.key, false], [throws.key, false], [clean.key, false]]);
  const r = await flushDocuments([agentEdit, userDirtyTouched, userDirtyOther, outside, cannotSave, throws, clean], touched, (p) => p.startsWith(ws + '/'));
  assert.deepEqual(r.saved, ['/work/a.ts']);
  assert.deepEqual(r.skipped, ['/work/b.ts', '/work/c.ts'], 'the user\'s unsaved documents are reported, not silently skipped');
  assert.deepEqual(r.failed, [{ path: '/work/e.ts', error: 'the editor did not save it' }, { path: '/work/f.ts', error: 'read-only file system' }]);
  assert.equal(userDirtyTouched.saves + userDirtyOther.saves + outside.saves, 0, 'never saved without a decision');
  const docs = new Map([userDirtyTouched, userDirtyOther, clean].map((d) => [d.fsPath, d]));
  const s = await saveDocumentsReport(['/work/b.ts', '/work/g.ts', '/work/missing.ts'], (p) => docs.get(p));
  assert.deepEqual(s, { saved: ['/work/b.ts'], skipped: [], failed: [] });
  assert.equal(userDirtyOther.saves, 0, 'only the chosen documents');
});

test('R2 (VS Code): the run_end completion badge', () => {
  assert.deepEqual(completionBadge({ state: 'verified', summary: '`npm test` passed after the last edit', check: { command: 'npm test', exitCode: 0, ts: 't' } }), { state: 'verified', cls: 'ok', label: 'Verified', title: '`npm test` passed after the last edit', why: '`npm test` passed after the last edit.' });
  assert.equal(completionBadge({ state: 'failed', summary: 'x' })?.cls, 'fail');
  assert.equal(completionBadge({ state: 'unverified', summary: 'no check ran' })?.label, 'Not verified');
  assert.equal(completionBadge({ state: 'unverified', summary: 'no check ran' })?.why, 'No check ran after the last edit.');
  // UI tour: the line under an answer says what happened in plain words; config keys stay in the tooltip
  const off = completionBadge({ state: 'unverified', summary: 'the harness check is off (agent.harnessCheck: "off") (the agent\'s own commands are evidence only: …)' });
  assert.ok(off && !/harnessCheck/.test(off.why) && /Automatic checks are off/.test(off.why) && /harnessCheck/.test(off.title));
  assert.equal(completionBadge({ state: 'unverified', summary: 'x', declaredUnverifiable: true })?.why, 'The agent said it could not check this.');
  assert.equal(completionBadge({ state: 'not_applicable', summary: 'no files changed' }), undefined);
  assert.equal(completionBadge(undefined), undefined);
  const js = fs.readFileSync(path.join(process.cwd(), 'vscode', 'media', 'main.js'), 'utf8');
  assert.match(js, /if \(e\.badge\) add\(cid, `completion \$\{e\.badge\.cls\}`/, 'the webview renders it on run_end');
});

test('R14 (VS Code): re-creating the agent of a live chat carries the durable session state (brief, tasks, evidence)', async () => {
  const ws = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }) });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'todo_write', arguments: { todos: [{ content: 'port parser', status: 'in_progress' }] } }] };
    if (i === 1) return { toolCalls: [{ name: 'write_file', arguments: { path: 'p.ts', content: 'x\n' } }] };
    if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] };
    return { content: 'Tests pass.' };
  });
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0 } });
  const old = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await old.run('Port the parser. CRITICAL_CONSTRAINT_KEEP_API');
  // what chat.ts did before: the plain message list loses the evidence and tasks
  const plain = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  plain.loadHistory(old.messages.filter((m) => m.role !== 'system'));
  assert.equal(plain.sessionState().evidence.length, 0);
  // now: historyWithState(old)
  const next = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  next.loadHistory(historyWithState(old));
  const st = next.sessionState();
  assert.deepEqual(st.requests.map((e) => e.text), ['Port the parser. CRITICAL_CONSTRAINT_KEEP_API']);
  assert.deepEqual(st.tasks.map((t) => t.content), ['port parser']);
  assert.equal(st.evidence.at(-1)?.command, 'npm test');
  assert.equal(st.completions.at(-1)?.state, 'verified');
  assert.deepEqual(st.resumedFrom, [old.sessionId]);
  await old.dispose();
  await plain.dispose();
  await next.dispose();
  await srv.close();
});
