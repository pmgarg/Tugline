/** WS4 v1.1 R5: durable task brief, re-inserted after every compaction; R6: journal chain on reopen. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Agent } from '../src/core/agent/agent.js';
import { assembleCompacted } from '../src/core/agent/compaction.js';
import { Journal } from '../src/core/agent/journal.js';
import { BRIEF_FULL_CHARS, briefFromMessages, briefToolText, renderBrief } from '../src/core/context/brief.js';
import { readState, stateFileFor } from '../src/core/context/sessionState.js';
import type { ChatMessage } from '../src/core/types.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const NO_MAP = { repoMapTokens: 0, backgroundCompaction: false };
/** a small window so compactNow really summarises */
const SMALL = { profiles: { default: { contextWindow: 8000 } } };
const CRIT = 'CRITICAL_CONSTRAINT_DO_NOT_DEPLOY';
const text = (msgs: ChatMessage[]) => JSON.stringify(msgs);
const has = (msgs: ChatMessage[], s: string) => text(msgs).includes(s);

test('R5 probe 6: a constraint after the first 200 chars survives assembleCompacted', () => {
  const original = 'A'.repeat(220) + ` ${CRIT}`;
  const msgs: ChatMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: original }, { role: 'assistant', content: 'working' }, { role: 'user', content: 'continue' }];
  const out = assembleCompacted(msgs, 3, original.slice(0, 200) + ' summary');
  assert.ok(has(out, CRIT), 'kept: ' + CRIT);
});

/** A mock model that summarises badly (drops everything) and otherwise answers 'ok'. */
async function lossyServer() {
  return startMockServer((body) => {
    const sys = String(body.messages[0]?.content ?? '');
    if (sys.startsWith('You are compressing')) return { content: '## User requests\n(lost)\n## Progress so far\nsome work' };
    return { content: 'ok' };
  });
}

function longHistory(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < n; i++) out.push({ role: 'assistant', content: `step ${i} ${'x'.repeat(3000)}` }, { role: 'user', content: `[continue ${i}]`, _meta: { synthetic: true } });
  return out;
}

test('R5: repeated compactions keep the original request and a later correction (verbatim, authoritative)', async () => {
  const srv = await lossyServer();
  const ws = tmpWorkspace({});
  const a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...SMALL, agent: NO_MAP }), mcp: false });
  await a.run(`Refactor the parser. ${'Detail. '.repeat(40)} ${CRIT}: never run the deploy script.`);
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  assert.ok(has(a.messages, CRIT), 'after the first compaction');
  await a.run('Correction: keep the public API names unchanged.');
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  const t = text(a.messages);
  assert.ok(t.includes(CRIT), 'after the third compaction');
  assert.ok(a.messages.filter((m) => m._meta?.compactedSummary).length === 1 && a.messages.length < 20, 'compacted');
  assert.ok(t.includes('Correction: keep the public API names unchanged.'), 'correction kept');
  assert.match(t, /<task_brief>[\s\S]*### original[\s\S]*### correction/);
  assert.equal((t.match(/<task_brief>/g) ?? []).length, 1, 'one brief, not one per compaction');
  assert.deepEqual(a.brief.entries.map((e) => e.kind), ['original', 'correction']);
  await srv.close();
});

test('R5: a steer during a run is part of the brief and survives compaction', async () => {
  const ws = tmpWorkspace({});
  let a!: Agent;
  const srv = await startMockServer((body, i) => {
    if (String(body.messages[0]?.content ?? '').startsWith('You are compressing')) return { content: 'summary' };
    if (i === 0) {
      a.steer('Only touch files under src/parser.');
      return { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] };
    }
    return { content: 'ok' };
  });
  a = await Agent.create({ workspace: ws, config: testConfig(srv.url, { ...SMALL, permissionMode: 'yolo', agent: NO_MAP }), mcp: false });
  await a.run('Clean up the parser.');
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  assert.deepEqual(a.brief.entries.map((e) => [e.kind, e.text]), [['original', 'Clean up the parser.'], ['steer', 'Only touch files under src/parser.']]);
  assert.ok(has(a.messages, 'Only touch files under src/parser.'), 'kept: ' + 'Only touch files under src/parser.');
  await srv.close();
});

test('R5: resuming from a journal restores the brief; compaction after resume still carries the constraint', async () => {
  const srv = await lossyServer();
  const ws = tmpWorkspace({});
  const cfg = testConfig(srv.url, { ...SMALL, agent: NO_MAP });
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await a.run(`Upgrade the dependencies. ${CRIT}`);
  await a.run('Also: do not touch the lockfile by hand.');
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  const file = a.journalFile!;
  await a.dispose();
  const b = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  b.loadHistory(Journal.loadMessages(file));
  assert.deepEqual(b.brief.entries.map((e) => e.text), [`Upgrade the dependencies. ${CRIT}`, 'Also: do not touch the lockfile by hand.']);
  b.messages.push(...longHistory(6));
  await b.compactNow(true);
  assert.ok(has(b.messages, CRIT), 'kept: ' + CRIT);
  assert.ok(has(b.messages, 'do not touch the lockfile'), 'kept: ' + 'do not touch the lockfile');
  // older journals without brief records: rebuilt from the compaction note's brief
  const msgsOnly = JSON.parse(JSON.stringify(Journal.loadMessages(file)));
  assert.deepEqual(briefFromMessages(msgsOnly).entries.map((e) => e.text), [`Upgrade the dependencies. ${CRIT}`, 'Also: do not touch the lockfile by hand.']);
  await srv.close();
});

test('R5: a long brief is bounded (excerpt + constraint lines + pointer), and task_brief returns the full text', async () => {
  const long = `Migrate the build. ${'Background sentence about the build system. '.repeat(150)}You must keep Node 18 support. ${'More background. '.repeat(50)}`;
  const r = renderBrief({ entries: [{ kind: 'original', text: long, ts: '' }] });
  assert.ok(r.truncated);
  assert.ok(r.text.length < BRIEF_FULL_CHARS + 600);
  assert.match(r.text, /Goal: Migrate the build\./);
  assert.match(r.text, /Constraints \(verbatim\):\n- You must keep Node 18 support\./);
  assert.match(r.text, /call task_brief with \{"entry": 1\} for the source text/);
  assert.equal(briefToolText({ entries: [{ kind: 'original', text: long, ts: '' }] }, 0, 20_000, 1).split('\n').slice(1).join('\n'), long, 'the source text is retrievable verbatim');
  // in an agent: compaction activates the task_brief tool, which returns everything
  const srv = await startMockServer((body, i) => {
    if (String(body.messages[0]?.content ?? '').startsWith('You are compressing')) return { content: 'summary' };
    return i === 0 ? { content: 'ok' } : { toolCalls: [{ name: 'task_brief', arguments: {} }] };
  });
  const a = await Agent.create({ workspace: tmpWorkspace({}), config: testConfig(srv.url, { ...SMALL, permissionMode: 'yolo', agent: { ...NO_MAP, maxTurns: 2 } }), mcp: false });
  await a.run(long);
  a.messages.push(...longHistory(6));
  await a.compactNow(true);
  assert.ok(JSON.stringify(a.toolSpecs()).includes('"task_brief"'), 'task_brief activated');
  await a.run('continue');
  const out = srv.requests.map((b) => lastToolResult(b)).find((t) => t.includes('Node 18'));
  assert.ok(out && out.includes(long.trim()), 'the tool returns the full original text');
  await srv.close();
});

// ------------------------------------------------------------------ R6

test('R6 probe 5: reopening a session id continues the chain (verify clean)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-j-'));
  const ws = tmpWorkspace({});
  const j = new Journal(home, ws, 'same-session');
  j.write({ type: 'first' });
  assert.equal(Journal.verify(j.file), 0);
  new Journal(home, ws, 'same-session').write({ type: 'second' });
  assert.equal(Journal.verify(j.file), 0);
  assert.equal(fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean).length, 2);
});

test('R6: two writers on one file (in-process) interleave without breaking the chain; another process appending is re-synced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-j-'));
  const ws = tmpWorkspace({});
  const a = new Journal(home, ws, 's');
  const b = new Journal(home, ws, 's');
  for (let i = 0; i < 20; i++) (i % 2 ? a : b).write({ type: 'x', i });
  assert.equal(Journal.verify(a.file), 0);
  // simulate another process appending a valid record behind our back
  const c = new Journal(home, ws, 's', [], { isolated: true });
  c.write({ type: 'from-elsewhere' });
  a.write({ type: 'after' });
  assert.equal(Journal.verify(a.file), 0);
});

test('R6: a tampered journal is refused on reopen; the agent continues under a new session id', async () => {
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const ws = tmpWorkspace({});
  const cfg = testConfig(srv.url, { agent: NO_MAP });
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: 'tamper-me' });
  await a.run('hi');
  const file = a.journalFile!;
  await a.dispose();
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"hi"', '"HI"');
  fs.writeFileSync(file, lines.join('\n'));
  assert.throws(() => new Journal(cfg.homeDir, ws, 'tamper-me'), /chain is broken at line 2/);
  const notices: string[] = [];
  const b = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: 'tamper-me', ui: { onEvent: (e) => e.type === 'notice' && notices.push(e.message) } });
  assert.notEqual(b.sessionId, 'tamper-me');
  assert.match(b.sessionId, /^tamper-me-/);
  assert.ok(notices.some((m) => /journal tamper-me failed verification at line 2/.test(m)));
  await b.run('again');
  assert.equal(Journal.verify(b.journalFile!), 0);
  await srv.close();
});

test('R6: audit.sink receives each record hash (file outside the workspace, or HTTP); a sink inside the workspace is refused', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-j-'));
  const ws = tmpWorkspace({});
  const sinkFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-audit-')), 'anchor.jsonl');
  const j = new Journal(home, ws, 'aud', [], { auditSink: sinkFile });
  j.write({ type: 'a' });
  j.write({ type: 'b' });
  const anchors = fs.readFileSync(sinkFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hashes = fs.readFileSync(j.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)._h);
  assert.deepEqual(anchors.map((x) => x.hash), hashes);
  assert.deepEqual(anchors.map((x) => [x.session, x.line]), [['aud', 1], ['aud', 2]]);
  assert.throws(() => new Journal(home, ws, 'aud2', [], { auditSink: path.join(ws, 'audit.jsonl') }), /outside the workspace/);
  // HTTP sink
  const got: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      got.push(JSON.parse(raw));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as any).port}/anchor`;
  const h = new Journal(home, ws, 'aud3', [], { auditSink: url });
  h.write({ type: 'c' });
  await h.flushAudit();
  server.closeAllConnections();
  server.close();
  assert.equal(got.length, 1);
  assert.equal(got[0].hash, JSON.parse(fs.readFileSync(h.file, 'utf8').trim())._h);
});

// ------------------------------------------------------------------ R14 durable session state

test('R14: requests, constraints, tasks and evidence live in a state file next to the journal and survive a restart (same session id)', async () => {
  const ws = tmpWorkspace({ 'package.json': JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } }) });
  const srv = await startMockServer((body, i) => {
    if (String(body.messages[0]?.content ?? '').startsWith('You are compressing')) return { content: 'summary' };
    if (i === 0) return { toolCalls: [{ name: 'todo_write', arguments: { todos: [{ content: 'fix parser', status: 'in_progress' }] } }] };
    if (i === 1) return { toolCalls: [{ name: 'write_file', arguments: { path: 'p.ts', content: 'x\n' } }] };
    if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'npm test' } }] };
    return { content: 'Tests pass.' };
  });
  const cfg = testConfig(srv.url, { ...SMALL, permissionMode: 'yolo', agent: NO_MAP });
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: 'restart-me' });
  await a.run(`Fix the parser. ${CRIT}`);
  await a.dispose();
  const file = stateFileFor(a.journalFile!);
  const st = readState(file)!;
  assert.equal(st.sessionId, 'restart-me');
  assert.deepEqual(st.requests.map((e) => e.text), [`Fix the parser. ${CRIT}`]);
  assert.deepEqual(st.tasks.map((t) => t.content), ['fix parser']);
  assert.equal(st.evidence.at(-1)?.command, 'npm test');
  assert.equal(st.completions.at(-1)?.state, 'verified');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // "restart": a new process creates the agent with the same id and no history
  const b = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: 'restart-me' });
  assert.deepEqual(b.brief.entries.map((e) => e.text), [`Fix the parser. ${CRIT}`]);
  assert.deepEqual(b.todos.map((t) => t.content), ['fix parser']);
  assert.equal(b.sessionState().evidence.at(-1)?.command, 'npm test');
  b.messages.push(...longHistory(6));
  await b.compactNow(true);
  assert.ok(has(b.messages, CRIT), 'the restarted session still carries the constraint after compaction');
  await srv.close();
});

test('R14: multi-session recovery: A → B (another surface, new id) → C keeps requests, corrections, tasks and evidence; sessions do not mix', async () => {
  const srv = await lossyServer();
  const ws = tmpWorkspace({});
  const cfg = testConfig(srv.url, { ...SMALL, agent: NO_MAP });
  const A = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await A.run(`Port the CLI to Deno. ${CRIT}`);
  A.todos = [{ content: 'port args parser', status: 'pending' } as any];
  await A.dispose();
  // B: resumed the way the server / VS Code / ACP do it (new session, loadHistory from A's journal)
  const B = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  B.loadHistory(Journal.loadMessages(A.journalFile!));
  await B.run('Correction: keep Node 18 support as well.');
  B.messages.push(...longHistory(6));
  await B.compactNow(true);
  await B.dispose();
  // C: resumes B after B compacted
  const C = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  C.loadHistory(Journal.loadMessages(B.journalFile!));
  assert.deepEqual(C.brief.entries.map((e) => [e.kind, e.text]), [['original', `Port the CLI to Deno. ${CRIT}`], ['correction', 'Correction: keep Node 18 support as well.']]);
  assert.deepEqual(C.sessionState().resumedFrom, [A.sessionId, B.sessionId]);
  C.messages.push(...longHistory(6));
  await C.compactNow(true);
  assert.ok(has(C.messages, CRIT) && has(C.messages, 'keep Node 18 support'), 'after the third session compacted');
  // an unrelated session in the same workspace has its own, empty state
  const D = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await D.run('What is 2+2?');
  assert.deepEqual(D.sessionState().requests.map((e) => e.text), ['What is 2+2?']);
  assert.deepEqual(readState(stateFileFor(A.journalFile!))!.requests.map((e) => e.text), [`Port the CLI to Deno. ${CRIT}`]);
  await srv.close();
});

test('R14: a corrupt or missing state file is rebuilt from the journal records', async () => {
  const srv = await lossyServer();
  const ws = tmpWorkspace({});
  const cfg = testConfig(srv.url, { ...SMALL, agent: NO_MAP });
  const a = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  await a.run(`Rename the module. ${CRIT}`);
  await a.dispose();
  fs.writeFileSync(stateFileFor(a.journalFile!), '{ torn');
  const b = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  b.loadHistory(Journal.loadMessages(a.journalFile!));
  assert.deepEqual(b.brief.entries.map((e) => e.text), [`Rename the module. ${CRIT}`]);
  fs.rmSync(stateFileFor(a.journalFile!));
  const c = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: a.sessionId });
  assert.deepEqual(c.brief.entries.map((e) => e.text), [`Rename the module. ${CRIT}`]);
  await srv.close();
});
