/**
 * v1.2 WS17 CLI surfaces, end to end through `tug` with the mock model:
 * `tug team run <file>` (N34), `tug workflow run <file>` / `list` (N18), `tug goal "<condition>"` (N35).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockServer, tmpWorkspace, type MockReply } from './helpers.js';

function oh(args: string[], home: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...args], { cwd: process.cwd(), env: { ...process.env, HOME: home, TUG_API_KEY: '', OPENAI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}
const sys = (b: any) => String(b.messages[0]?.content ?? '');
const toolN = (b: any) => b.messages.filter((m: any) => m.role === 'tool').length;
const lastTool = (b: any) => String(b.messages.filter((m: any) => m.role === 'tool').at(-1)?.content ?? '');

test('N34 CLI: `tug team run team.json` runs the lead and members on the board and prints the disband summary', async () => {
  const ws = tmpWorkspace({ 'team.json': JSON.stringify({ name: 'cli', goal: 'two tasks', members: [{ name: 'w1', isolation: 'shared' }], tasks: [{ id: 'a', title: 'first' }, { id: 'b', title: 'second', deps: ['a'] }] }) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-'));
  const srv = await startMockServer((b): MockReply => {
    if (/a member of the agent team/.test(sys(b))) {
      const out = lastTool(b);
      const ready = out.match(/^(\w+) \[ready\]/m)?.[1];
      if (/^claimed (\w+)/.test(out)) return { toolCalls: [{ name: 'team_task_update', arguments: { id: out.match(/^claimed (\w+)/)![1], status: 'done', result: 'ok' } }] };
      if (ready) return { toolCalls: [{ name: 'team_task_claim', arguments: { id: ready } }] };
      if (/is done|^\(the board|\[done/.test(out) || toolN(b) === 0) return toolN(b) > 6 ? { content: 'nothing ready' } : { toolCalls: [{ name: 'team_task_list', arguments: {} }] };
      return { content: 'nothing ready' };
    }
    if (toolN(b) === 0) return { toolCalls: [{ name: 'team_wait', arguments: { timeout_s: 30 } }] };
    if (toolN(b) === 1) return { toolCalls: [{ name: 'team_disband', arguments: {} }] };
    return { content: 'LEAD REPORT: all done' };
  });
  const r = await oh(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', '--native-tools', 'team', 'run', 'team.json'], home);
  await srv.close();
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Team "cli" disbanded[\s\S]*Tasks: 2\/2 done/);
  assert.match(r.out, /LEAD REPORT: all done/);
});

test('N18 CLI: `tug workflow run wf.json` fans out and reports; `tug workflow list` shows the run; a bad spec exits 2 with the problems', async () => {
  const ws = tmpWorkspace({ 'wf.json': JSON.stringify({ name: 'cliwf', items: ['x', 'y', 'z'], task: { prompt: 'ITEM {{item}}' }, concurrency: 2 }), 'bad.json': JSON.stringify({ name: 'b', items: [1], task: {} }) });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-'));
  const srv = await startMockServer(() => ({ content: 'item ok' }));
  const r = await oh(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', 'workflow', 'run', 'wf.json'], home);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /Workflow "cliwf" \(wf_\w+\): done\. 3\/3 items ok, at most 2 at once/);
  const l = await oh(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', 'workflow', 'list'], home);
  assert.match(l.out, /wf_\w+ {2}cliwf {2}done {2}3\/3 ok/);
  const bad = await oh(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', 'workflow', 'run', 'bad.json'], home);
  await srv.close();
  assert.equal(bad.code, 2);
  assert.match(bad.out, /Refused \(invalid_spec\): .*task\.prompt/);
});

test('N35 CLI: `tug goal "<condition>"` runs until the independent verifier judges it met, labelled as such', async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def add(a, b):\n    return a + b\n' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cli-home-'));
  const srv = await startMockServer((b) => (sys(b).includes('independent goal verifier') ? { content: JSON.stringify({ met: true, reasons: ['ok'], evidence: [{ file: 'calc.py', line: 2, quote: 'return a + b' }] }) } : { content: 'done' }));
  const r = await oh(['--cwd', ws, '--base-url', srv.url, '--model', 'mock-model', 'goal', 'calc.py adds two numbers', '--max-turns', '3', '--json'], home);
  await srv.close();
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
  assert.deepEqual([j.status, j.label, j.iterations], ['met', 'judged met (independent verifier)', 1]);
});
