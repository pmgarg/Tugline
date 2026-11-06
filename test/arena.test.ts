/**
 * SPEC H6: compare-models arena (WS8). Three mock "models" behind one mock
 * endpoint (routed by the request's model name) and a mock judge.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMockServer, testConfig, tmpWorkspace, type MockServer } from './helpers.js';
import { rank, runArena, scoreVerdict, type ArenaEntry } from '../src/core/eval/arena.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/eval/commands.js';

const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function repo(): string {
  const ws = tmpWorkspace({ 'mathx.py': 'def add(a, b):\n    return a - b\n', 'README.md': '# mathx\n' });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-qm', 'base');
  return ws;
}

const CHECK = 'python3 -c "import mathx; assert mathx.add(2, 3) == 5"';

/** good fixes it, sloppy breaks it differently, lazy does nothing; the judge scores candidates from their diffs. */
const script: Parameters<typeof startMockServer>[0] = (body) => {
  const model = body.model;
  const done = body.messages.some((m: any) => m.role === 'tool');
  if (model === 'judge-model') {
    const user = String(body.messages.at(-1).content);
    const sections = user.split('## Candidate ').slice(1);
    const candidates = sections.map((s) => {
      const id = s[0];
      const good = /\+\s+return a \+ b/.test(s);
      const changed = /<untrusted_candidate_diff[^>]*>\n(?!\(no changes\))/.test(s);
      const v = good ? 4 : changed ? 1 : 0;
      return { id, scores: { correctness: v, completeness: v, quality: good ? 3 : 1, focus: good ? 4 : 2, verification: good ? 3 : 0 }, notes: good ? 'Correct one-line fix.' : changed ? 'Wrong operator.' : 'No change.' };
    });
    return { content: JSON.stringify({ candidates, synthesis: 'Merge the candidate that restores addition; the others do not fix the bug.' }) };
  }
  if (done) return { content: model === 'lazy' ? 'I looked at it; nothing to do.' : 'Fixed add().' };
  if (model === 'good') return { toolCalls: [{ name: 'bash', arguments: { command: "printf 'def add(a, b):\\n    return a + b\\n' > mathx.py" } }] };
  if (model === 'sloppy') return { toolCalls: [{ name: 'bash', arguments: { command: "printf 'def add(a, b):\\n    return a * b\\n' > mathx.py && echo tmp > scratch.txt" } }] };
  return { content: 'Nothing needed.' };
};

test('H6 AC1: mock models produce different results and the report ranks them (check + judge + synthesis)', async () => {
  const ws = repo();
  const mock = await startMockServer(script);
  servers.push(mock);
  const config = testConfig(mock.url, { profiles: { judge: { baseUrl: mock.url, model: 'judge-model', apiKey: 'sk-test-1234567890abcdef' } } });
  const r = await runArena({ config, workspace: ws, models: ['lazy', 'sloppy', 'good'], prompt: 'Fix add() in mathx.py so that add(2, 3) == 5.', check: CHECK, judge: 'judge', mode: 'yolo' });
  const by = Object.fromEntries(r.entries.map((e) => [e.model, e]));
  assert.equal(by.good.outcome, 'pass');
  assert.equal(by.sloppy.outcome, 'fail');
  assert.equal(by.lazy.outcome, 'fail');
  assert.deepEqual([by.good.files, by.good.added, by.good.removed], [1, 1, 1]);
  assert.deepEqual([by.sloppy.files, by.sloppy.added], [2, 2]);
  assert.equal(by.lazy.files, 0);
  assert.equal(by.good.judge?.score, 0.917); // (4×2 + 4 + 3 + 4 + 3) / 24
  assert.equal(by.good.judge?.pass, true);
  assert.equal(by.sloppy.judge?.pass, false);
  assert.deepEqual(r.ranking.map((e) => e.model), ['good', 'sloppy', 'lazy']);
  assert.match(r.report, /\| 1 \| good \| pass \| 0\.92 ✓ \| 1 \| \+1\/-1 \|/);
  assert.match(r.report, /## Synthesis\n\nMerge the candidate that restores addition/);
  assert.match(r.report, /git merge oh\/arena-/);
  // candidates are anonymous to the judge
  const judgeReq = mock.requests.find((b) => b.model === 'judge-model');
  assert.ok(judgeReq);
  assert.ok(!/\b(good|sloppy|lazy)\b/.test(JSON.stringify(judgeReq.messages)), 'model names are hidden from the judge');
  // the user's tree is untouched; the winner's work is on its branch
  assert.equal(fs.readFileSync(path.join(ws, 'mathx.py'), 'utf8'), 'def add(a, b):\n    return a - b\n');
  assert.match(git(ws, 'show', `${by.good.branch}:mathx.py`), /return a \+ b/);
  assert.equal(by.lazy.branch, undefined, 'no branch for a candidate with no changes');
});

test('H6 AC2: worktrees are cleaned up (also when a candidate errors), and --discard deletes the branches', async () => {
  const ws = repo();
  const mock = await startMockServer((body, i) => (body.model === 'broken' ? { status: 500 } : script(body, i)));
  servers.push(mock);
  const config = testConfig(mock.url, { profiles: { default: { timeoutMs: 3000 } } });
  const out: string[] = [];
  const code = await getCliCommand('arena')!.run(['--models', 'good,broken', '--check', CHECK, '--mode', 'yolo', '--discard', '--out', path.join(ws, '..', `arena-${path.basename(ws)}.md`), 'Fix add() in mathx.py'], { config, workspace: ws, write: (t) => out.push(t) });
  assert.equal(code, 0);
  const report = out.join('\n');
  assert.match(report, /\| 1 \| good \| pass/);
  assert.match(report, /\| 2 \| broken \| fail/);
  const list = git(ws, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(list.length, 1, `only the main worktree remains:\n${list.join('\n')}`);
  assert.equal(git(ws, 'branch', '--list', 'oh/*').trim(), '', '--discard removed the arena branches');
  assert.ok(!fs.readdirSync(path.join(ws, '..')).some((d) => d.startsWith('oh-wt-') && fs.existsSync(path.join(ws, '..', d, 'mathx.py'))), 'no worktree directories left');
  // without --discard, branches stay but worktrees still go
  await getCliCommand('arena')!.run(['--models', 'good,lazy', '--mode', 'yolo', 'Fix add() in mathx.py'], { config, workspace: ws, write: () => {} });
  assert.equal(git(ws, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(git(ws, 'branch', '--list', 'oh/arena-*').trim().split('\n').length, 1, 'the good branch is kept for merging');
  assert.ok(fs.readdirSync(path.join(ws, '.tugline', 'arena')).some((f) => f.endsWith('.md')), 'report written');
});

test('H6: rubric scoring (S15) — weighted, floor per criterion, unparseable is null; ranking order', () => {
  assert.deepEqual(scoreVerdict({ correctness: 4, completeness: 4, quality: 4, focus: 4, verification: 4 }).score, 1);
  const fluent = scoreVerdict({ correctness: 1, completeness: 4, quality: 4, focus: 4, verification: 4 });
  assert.equal(fluent.pass, false, 'fluent-but-wrong fails the floor');
  assert.deepEqual(scoreVerdict({ correctness: 'x' } as any), { score: null, pass: null });
  assert.deepEqual(scoreVerdict(undefined), { score: null, pass: null });
  const e = (model: string, outcome: ArenaEntry['outcome'], score: number | null, cost: number): ArenaEntry => ({ model, profile: model, label: 'A', outcome, stopReason: 'end_turn', finalText: '', files: 1, added: 1, removed: 0, diff: '', costUsd: cost, tokens: 0, seconds: 0, judge: { score, pass: null } });
  assert.deepEqual(rank([e('a', 'fail', 0.9, 0), e('b', 'pass', null, 0), e('c', 'pass', 0.5, 0.2), e('d', 'pass', 0.5, 0.1)]).map((x) => x.model), ['d', 'c', 'b', 'a']);
});

test('H6: --suite runs an eval suite with one arm per model (multi-task arena through the eval harness)', async () => {
  const mock = await startMockServer(script);
  servers.push(mock);
  const config = testConfig(mock.url);
  const suite = tmpWorkspace({
    'suite.json': JSON.stringify({ repeats: 1, arms: { ignored: {} } }),
    'tasks/t1/task.json': JSON.stringify({ id: 't1', prompt: 'Fix add() in mathx.py', acceptance: [CHECK] }),
    'tasks/t1/repo/mathx.py': 'def add(a, b):\n    return a - b\n',
  });
  const out: string[] = [];
  const outDir = path.join(suite, 'out');
  assert.equal(await getCliCommand('arena')!.run(['--models', 'good,lazy', '--suite', suite, '--out', outDir], { config, workspace: suite, write: (t) => out.push(t) }), 0);
  const report = fs.readFileSync(path.join(outDir, 'report.md'), 'utf8');
  assert.match(report, /\| good \| 1 \| 1 \|/);
  assert.match(report, /\| lazy \| 1 \| 0 \|/);
  assert.ok(!/\| ignored \|/.test(report), 'the models replace the suite arms');
});
