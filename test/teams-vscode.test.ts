/**
 * v1.2 N34 AC4 [VSC]: the agent-manager view (N12) shows team members, tasks and messages live.
 * Pure parts (vscode/src/agents.ts), unit-tested like the N12 view tests; fed by a real team run's events.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newRow, rowView, teamReduce, teamRows, type TeamView } from '../vscode/src/agents.js';
import { Agent } from '../src/core/agent/agent.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';
import type { AgentEvent } from '../src/core/types.js';

const BASE = { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, requireVerification: false, harnessCheck: 'off' }, checkpoints: { enabled: false }, team: { idleTimeoutMs: 3000 } };

test('N34 AC4: the team reducer turns team events into member, task and message rows under the lead chat', () => {
  const ev = (e: Partial<Extract<AgentEvent, { type: 'team' }>>): AgentEvent => ({ type: 'team', teamId: 'T1', name: 'crew', phase: 'member', ...e }) as AgentEvent;
  let t: TeamView | undefined;
  for (const e of [
    ev({ phase: 'created' }),
    ev({ member: { name: 'alice', role: 'tests', status: 'starting', model: 'qwen3.5:9b', worktree: 'oh/abc-1' } }),
    ev({ member: { name: 'alice', role: 'tests', status: 'working', model: 'qwen3.5:9b', worktree: 'oh/abc-1' } }),
    ev({ member: { name: 'bob', status: 'idle', model: 'qwen3.5:9b' } }),
    ev({ phase: 'task', task: { id: 't1', title: 'write tests', status: 'pending', deps: [] } }),
    ev({ phase: 'task', task: { id: 't2', title: 'fix bug', status: 'pending', deps: ['t1'] } }),
    ev({ phase: 'task', task: { id: 't1', title: 'write tests', status: 'in_progress', owner: 'alice' } }),
    ev({ phase: 'message', message: { from: 'alice', to: 'bob', text: 'tests are in', tainted: true } }),
  ])
    t = teamReduce(t, e);
  const rows = teamRows('chat1', t!);
  const by = (id: string) => rows.find((r) => r.id === id)!;
  assert.deepEqual(rows.map((r) => r.kind), ['member', 'member', 'task', 'task', 'message']);
  assert.ok(rows.every((r) => r.parent === 'chat1'));
  assert.equal(by('team:T1:m:alice').status, 'running');
  assert.equal(rowView(by('team:T1:m:alice')).description, 'running · qwen3.5:9b · oh/abc-1');
  assert.equal(rowView(by('team:T1:m:alice')).contextValue, 'oh.member.running');
  assert.equal(by('team:T1:m:bob').status, 'idle');
  assert.equal(rowView(by('team:T1:t:t1')).description, 'running · @alice');
  assert.equal(rowView(by('team:T1:t:t2')).description, 'queued · after t1');
  assert.equal(rowView(by('team:T1:msg:0')).label, 'alice → bob');
  assert.equal(rowView(by('team:T1:msg:0')).description, '⚠ untrusted · tests are in');
  // disbanding stops every member row; other events leave the view alone
  const after = teamReduce(teamReduce(t, { type: 'notice', level: 'info', message: 'x' }), ev({ phase: 'disbanded', summary: 's' }))!;
  assert.ok(teamRows('chat1', after).filter((r) => r.kind === 'member').every((r) => r.status === 'stopped'));
  // chat rows are unchanged by the new fields
  assert.equal(rowView(newRow('c', 't')).description, 'idle');
});

test('N34 AC4: live: the rows follow a real team run (members, tasks and messages appear as the lead\'s events arrive)', async () => {
  const ws = tmpWorkspace({});
  const sys = (b: any) => String(b.messages[0]?.content ?? '');
  const toolN = (b: any) => b.messages.filter((m: any) => m.role === 'tool').length;
  const srv = await startMockServer((b) => {
    const me = sys(b).match(/You are "(\w+)", a member/)?.[1];
    if (me) return toolN(b) ? { content: 'ok' } : { toolCalls: [{ name: 'team_send', arguments: { to: 'lead', text: `${me} ready` } }] };
    const steps = [
      { name: 'team_create', arguments: { name: 'view', members: [{ name: 'ann', role: 'ui', isolation: 'shared' }] } },
      { name: 'team_task_add', arguments: { id: 'k1', title: 'draw it' } },
      { name: 'team_wait', arguments: { timeout_s: 10 } },
    ];
    return toolN(b) < steps.length ? { toolCalls: [steps[toolN(b)]!] } : { content: 'done' };
  });
  let view: TeamView | undefined;
  const snapshots: string[][] = [];
  const lead = await Agent.create({
    workspace: ws,
    config: testConfig(srv.url, BASE),
    mcp: false,
    ui: {
      onEvent: (e) => {
        view = teamReduce(view, e);
        if (e.type === 'team' && view) snapshots.push(teamRows('lead', view).map((r) => `${r.kind}:${r.title}:${r.status}`));
      },
    },
  });
  try {
    await lead.run('go');
    const { teamOf } = await import('../src/core/agent/team/runtime.js');
    await teamOf(lead.sessionId)!.team.disband();
    assert.ok(snapshots.some((s) => s.includes('member:ann (ui):running')), `the member row went live: ${JSON.stringify(snapshots)}`);
    assert.ok(snapshots.some((s) => s.some((x) => x.startsWith('task:k1: draw it'))), 'the task row appeared');
    assert.ok(snapshots.some((s) => s.includes('message:ann → lead:done')), 'the message row appeared');
    assert.ok(snapshots.at(-1)!.includes('member:ann (ui):stopped'), 'and the member stopped on disband');
  } finally {
    await lead.dispose();
    await srv.close();
  }
});
