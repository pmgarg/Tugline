/** WS4 v1.1 R2 (verification evidence, completion status) and R8 (IDE truth vs disk truth). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { Journal } from '../src/core/agent/journal.js';
import { diskHost, type WorkspaceHost } from '../src/core/host/workspace.js';
import type { AgentEvent } from '../src/core/types.js';
import { agentsMdVerifyCommands, claimsSuccess, classifyCheck, completionStatus } from '../src/core/context/verification.js';
import { scoreRun } from '../src/core/eval/scorer.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const NO_MAP = { agent: { repoMapTokens: 0, backgroundCompaction: false } };
const notices = (ev: AgentEvent[]) => ev.filter((e) => e.type === 'notice').map((e) => (e as any).message as string);

/** write a file, run `command`, then always answer `final` */
function script(command: string | undefined, final: string) {
  return (_b: any, i: number) => {
    if (i === 0) return { toolCalls: [{ name: 'write_file', arguments: { path: 'answer.txt', content: 'wrong answer\n' } }] };
    if (i === 1 && command) return { toolCalls: [{ name: 'bash', arguments: { command } }] };
    return { content: final };
  };
}

async function runWith(command: string | undefined, final: string, over: any = {}, files: Record<string, string> = {}) {
  const ws = tmpWorkspace(files);
  const srv = await startMockServer(script(command, final));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { requireVerification: true, repoMapTokens: 0, backgroundCompaction: false }, ...over }), mcp: false, ui: { onEvent: (e) => events.push(e) } });
  const r = await agent.run('Fix the bug and verify the result');
  await agent.dispose();
  await srv.close();
  return { r, events, srv, ws, agent };
}

test('R2 probe 2: `echo checked` after an edit + "All tests pass. Fixed." → one nudge with the evidence, ends unverified', async () => {
  const { r, events, srv } = await runWith('echo checked', 'All tests pass. Fixed.');
  const nudges = notices(events).filter((m) => m.includes('without a check'));
  assert.equal(nudges.length, 1);
  assert.match(lastToolResult(srv.requests[3]), /did not run any check after your last edit[\s\S]*`echo checked` → exit 0 \(not a check: `echo` is not a check\)/);
  assert.equal(r.completion.state, 'unverified');
  assert.equal(r.completion.claimedSuccess, true);
  assert.equal(r.stats.evidence?.[0].trusted, false);
  const end = events.find((e) => e.type === 'run_end') as any;
  assert.equal(end.completion.state, 'unverified', 'run_end carries the status');
});

test('R2 probe 2: `false` after an edit + a success claim → one nudge naming the failed check, ends failed', async () => {
  // `false` only counts as a check when the project says it is its test command; otherwise it is unverified
  const plain = await runWith('false', 'All tests pass. Fixed.');
  assert.equal(notices(plain.events).filter((m) => m.includes('without a check')).length, 1);
  assert.equal(plain.r.completion.state, 'unverified');
  const listed = await runWith('false', 'All tests pass. Fixed.', { agent: { requireVerification: true, repoMapTokens: 0, verifyCommands: ['false'] } });
  const nudges = notices(listed.events).filter((m) => m.includes('without a check'));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0], /`false` exited 1 after the last edit/);
  assert.match(lastToolResult(listed.srv.requests[3]), /the last check after your last edit failed/);
  assert.equal(listed.r.completion.state, 'failed');
  assert.deepEqual(listed.r.completion.check && { c: listed.r.completion.check.command, x: listed.r.completion.check.exitCode }, { c: 'false', x: 1 });
});

test('R2: a trusted check that passed after the last edit → verified, no nudge; evidence holds file versions', async () => {
  const pkg = JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } });
  const { r, events } = await runWith('npm test', 'All tests pass.', {}, { 'package.json': pkg });
  assert.equal(notices(events).filter((m) => m.includes('without a check')).length, 0);
  assert.equal(r.completion.state, 'verified');
  const ev = r.stats.evidence!.at(-1)!;
  assert.equal(ev.trusted, true);
  assert.equal(ev.exitCode, 0);
  assert.match(ev.ts, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(ev.files.map((f) => f.path), ['answer.txt']);
  assert.match(ev.files[0].version, /^[0-9a-f]{16}$/);
});

test('R2: a trusted check that failed, then the model claims success → nudge; status failed', async () => {
  const pkg = JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e "process.exit(3)"' } });
  const { r, events } = await runWith('npm test', 'Fixed, all tests pass.', {}, { 'package.json': pkg });
  assert.equal(notices(events).filter((m) => m.includes('without a check')).length, 1);
  assert.equal(r.completion.state, 'failed');
});

test('R2: no files changed → not_applicable and no nudge, even with a success claim (explanations)', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const srv = await startMockServer(() => ({ content: 'It works now: the function is fixed and verified.' }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, ui: { onEvent: (e) => events.push(e) } });
  const r = await agent.run('explain a.txt');
  await srv.close();
  assert.equal(r.completion.state, 'not_applicable');
  assert.equal(srv.requests.length, 1);
});

test('R2: the explicit "could not verify" exit ends unverified without a nudge', async () => {
  const { r, events, srv } = await runWith(undefined, 'I changed answer.txt but could not verify it: no test runner is available here.');
  assert.equal(notices(events).filter((m) => m.includes('without a check')).length, 0);
  assert.equal(srv.requests.length, 2);
  assert.equal(r.completion.state, 'unverified');
  assert.equal(r.completion.declaredUnverifiable, true);
});

test('R2: an edit after the check makes the agent\'s run of it stale; the harness runs the check again after the last edit (batch 4)', async () => {
  const ws = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }) });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: '1\n' } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] };
    if (i === 2) return { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: '2\n' } }] };
    return { content: 'Done, I could not re-run the tests after the last change.' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false });
  const r = await agent.run('go');
  await srv.close();
  assert.equal(r.stats.evidence![0].afterLastEdit, false, 'the agent\'s npm test saw an older state');
  const harness = r.stats.evidence!.filter((e) => e.byHarness);
  assert.deepEqual(harness.map((e) => [e.command, e.afterLastEdit, e.exitCode]), [['npm test', true, 0]]);
  assert.equal(r.completion.state, 'verified');
  // with the harness check off, nothing ran after the last edit
  const ws2 = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }) });
  const srv2 = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'a.txt', content: '1\n' } }] } : i === 1 ? { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] } : i === 2 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'b.txt', content: '2\n' } }] } : { content: 'Done.' }));
  const off = await Agent.create({ workspace: ws2, config: testConfig(srv2.url, { permissionMode: 'yolo', agent: { ...NO_MAP.agent, harnessCheck: 'off' } }), mcp: false });
  const r2 = await off.run('go');
  await srv2.close();
  assert.equal(r2.completion.state, 'unverified');
});

test('R2: trusted checks: known runners, verifyCommands, AGENTS.md, acceptance; echo/true/masked exit codes never count', () => {
  for (const c of ['npm test', 'npm run test', 'pnpm test -- --run', 'yarn build', 'npx tsc --noEmit -p .', 'node --import tsx --test test/a.test.ts', 'pytest -q', 'python3 -m pytest tests/', 'go test ./...', 'cargo test', 'mvn -q test', './gradlew build', 'tsc -p .', 'cd pkg && npm test', 'CI=1 npm test', 'make test', 'set -o pipefail; npm test | tail -5', "cat > a.js <<'EOF'\nmodule.exports = 1;\nEOF\nnode --test"])
    assert.equal(classifyCheck(c).trusted, true, c);
  for (const c of ['echo checked', 'true', ':', 'false', 'cat out.txt', 'ls', 'npm test || true', 'pytest; true', 'npm test | tail -5', 'npm test; echo done', 'python3 a.py', 'npm install', 'git status'])
    assert.equal(classifyCheck(c).trusted, false, c);
  assert.equal(classifyCheck('./check.sh', { verifyCommands: ['./check.sh'] }).trusted, true);
  assert.equal(classifyCheck('bash scripts/judge.sh', { acceptance: ['bash scripts/judge.sh'] }).trusted, true);
  assert.equal(classifyCheck('bash scripts/judge.sh || true', { acceptance: ['bash scripts/judge.sh'] }).trusted, false);
  const ws = tmpWorkspace({ 'AGENTS.md': '# x\n## Commands\n- Typecheck: `npx tsc --noEmit -p .`\n- Tests: `npm test` (must stay green)\n- Build: `npm run build` (CLI)\n- Style: `prettier`\n' });
  assert.deepEqual(agentsMdVerifyCommands(ws), ['npx tsc --noEmit -p .', 'npm test', 'npm run build']);
  assert.ok(claimsSuccess('All tests pass. Fixed.'));
  assert.ok(!claimsSuccess('I could not run the tests, so this is unverified.'));
  assert.equal(completionStatus({ filesChanged: ['a'], evidence: [], finalText: 'ok' }).state, 'unverified');
});

test('R2: a project verify command from config counts (agent.verifyCommands), and the journal records evidence', async () => {
  const ws = tmpWorkspace({ 'check.sh': '#!/bin/sh\nexit 0\n' });
  fs.chmodSync(path.join(ws, 'check.sh'), 0o755);
  const srv = await startMockServer(script('./check.sh', 'Fixed and verified.'));
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, verifyCommands: ['./check.sh'] } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const r = await agent.run('go');
  await srv.close();
  assert.equal(r.completion.state, 'verified');
  const lines = fs.readFileSync(Journal.listSessions(cfg.homeDir, ws)[0].file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.type === 'evidence' && l.evidence.command === './check.sh' && l.evidence.trusted));
  assert.ok(lines.some((l) => l.type === 'event' && l.event.type === 'run_end' && l.event.completion.state === 'verified'));
});

test('R2: the eval scorer prefers the completion status over substring matching', () => {
  const base: any = { runId: 'r', manifest: { task: 't', arm: 'a', repeat: 1 }, stopReason: 'end_turn', finalText: 'All tests pass.', stats: { llmCalls: 1, successfulLlmCalls: 1, unparseableReplies: 0, toolCalls: 1, promptTokens: 1, completionTokens: 1, costUsd: 0, durationMs: 1, filesChanged: ['a'], commandsRun: [{ command: 'echo pytest', exitCode: 0, afterLastEdit: true }] }, events: [], protectedBefore: {}, protectedAfter: {}, acceptance: [{ command: 'pytest', exitCode: 0, output: '' }], verificationCommands: ['pytest'] };
  assert.equal(scoreRun(base).verification, 'verified_pass', 'legacy record: substring match');
  assert.equal(scoreRun({ ...base, completion: { state: 'unverified' } }).verification, 'unverified_pass', '`echo pytest` no longer counts');
  assert.equal(scoreRun({ ...base, completion: { state: 'verified' } }).verification, 'verified_pass');
  // files changed through bash (the agent saw no edit): its trusted evidence decides
  const viaBash = { ...base, completion: { state: 'not_applicable' }, stats: { ...base.stats, evidence: [{ command: 'pytest', exitCode: 0, trusted: true, afterLastEdit: true }] } };
  assert.equal(scoreRun(viaBash).verification, 'verified_pass');
  assert.equal(scoreRun({ ...viaBash, stats: { ...viaBash.stats, evidence: [{ command: 'echo ok', exitCode: 0, trusted: false, afterLastEdit: true }] } }).verification, 'unverified_pass');
});

// ------------------------------------------------------------------ R8

function mockHost(flush: () => Promise<any>): WorkspaceHost {
  return Object.assign(Object.create(diskHost), { kind: 'mock-ide', flushForShell: flush }) as WorkspaceHost;
}

test('R8: a failing flushForShell is surfaced in the tool result and as a notice (no longer swallowed)', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, host: mockHost(async () => { throw new Error('save rejected by the editor'); }), ui: { onEvent: (e) => events.push(e) } });
  await agent.run('go');
  await srv.close();
  assert.match(lastToolResult(srv.requests[1]), /hi[\s\S]*\[harness\] saving editor buffers before this command failed \(save rejected by the editor\); the command ran against the files on disk/);
  assert.ok(notices(events).some((m) => /saving editor buffers before this command failed/.test(m)));
});

test('R8: documents the user had dirty are reported (model + user) and recorded as disk-only in the evidence', async () => {
  const ws = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }) });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'write_file', arguments: { path: 'src/a.ts', content: 'export const a = 1;\n' } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] };
    return { content: 'Tests pass.' };
  });
  const events: AgentEvent[] = [];
  const host = mockHost(async () => ({ saved: [], skipped: [path.join(ws, 'src/a.ts')], failed: [{ path: path.join(ws, 'src/b.ts'), error: 'read-only' }] }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, host, ui: { onEvent: (e) => events.push(e) } });
  const r = await agent.run('go');
  await srv.close();
  const result = lastToolResult(srv.requests[2]);
  assert.match(result, /could not save src\/b\.ts \(read-only\): the command saw the disk version/);
  assert.match(result, /src\/a\.ts has unsaved changes in the editor that were not saved; the command ran against the disk version/);
  assert.ok(notices(events).some((m) => /src\/a\.ts has unsaved changes/.test(m)));
  const ev = r.stats.evidence!.at(-1)!;
  assert.deepEqual(ev.unsavedInEditor, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(ev.files, [{ path: 'src/a.ts', version: ev.files[0].version, diskOnly: true }]);
  assert.equal(r.completion.state, 'verified');
  assert.match(r.completion.summary, /against the disk version; unsaved editor changes in src\/a\.ts, src\/b\.ts/);
});

test('R8: a host that returns the v1.0 string[] still works and adds no note', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, host: mockHost(async () => [path.join(ws, 'x.ts')]) });
  await agent.run('go');
  await srv.close();
  assert.doesNotMatch(lastToolResult(srv.requests[1]), /\[harness\]/);
});

test('R8: explicit save decision: asked once, "save" saves the user-dirty file first and the check runs against the editor version', async () => {
  const ws = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }), 'src/a.ts': 'old\n' });
  const dirty = path.join(ws, 'src/a.ts');
  const saved: string[][] = [];
  let isDirty = true;
  const host = Object.assign(Object.create(diskHost), {
    kind: 'mock-ide',
    flushForShell: async () => ({ saved: [], skipped: isDirty ? [dirty] : [], failed: [] }),
    saveDocuments: async (p: string[]) => (saved.push(p), (isDirty = false), { saved: p, skipped: [], failed: [] }),
  }) as WorkspaceHost;
  const srv = await startMockServer((_b, i) => (i < 2 ? { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] } : { content: 'Tests pass.' }));
  const questions: string[] = [];
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...NO_MAP }), mcp: false, host, ui: { askUser: async (q) => (questions.push(q), 'save') } });
  const r = await agent.run('go');
  await srv.close();
  assert.equal(questions.length, 1, 'asked once');
  assert.match(questions[0], /src\/a\.ts has unsaved changes in the editor that the agent did not make\. Save before running `npm test`\?/);
  assert.deepEqual(saved, [[dirty]]);
  assert.match(lastToolResult(srv.requests[1]), /saved src\/a\.ts \(unsaved editor changes\) before the command, as decided; it ran against the editor version/);
  assert.equal(r.stats.evidence![0].unsavedDecision, 'saved');
  assert.equal(r.stats.evidence![0].unsavedInEditor, undefined);
});

test('R8: "disk" (or agent.unsavedBuffers: "disk", or no user) runs against the disk version and records the decision', async () => {
  for (const [over, ui] of [[{}, { askUser: async () => 'disk' }], [{ unsavedBuffers: 'disk' }, {}], [{}, {}]] as const) {
    const ws = tmpWorkspace({});
    const dirty = path.join(ws, 'b.ts');
    let saves = 0;
    const host = Object.assign(Object.create(diskHost), { kind: 'mock-ide', flushForShell: async () => ({ saved: [], skipped: [dirty], failed: [] }), saveDocuments: async () => (saves++, { saved: [], skipped: [], failed: [] }) }) as WorkspaceHost;
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] } : { content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { ...NO_MAP.agent, ...over } }), mcp: false, host, ui: ui as any });
    const r = await agent.run('go');
    await srv.close();
    assert.equal(saves, 0);
    assert.match(lastToolResult(srv.requests[1]), /b\.ts has unsaved changes in the editor that were not saved; the command ran against the disk version/);
    assert.equal(r.stats.evidence![0].unsavedDecision, 'disk');
  }
});
