/**
 * v1.1 R3 (parked-wait lifecycle), R4 (scheduler budgets) and R9 (workspace ownership), WS8.
 * Probes 3, 4 and 8 of docs/evidence/2026-10-28-gap-review/probes.mts are reproduced here as regressions.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startMockServer, testConfig, tmpWorkspace, type MockServer } from './helpers.js';
import { addSchedule, loadSchedules, readActivity, readWindow, saveSchedules, updateWindow, type ScheduledRunRecord } from '../src/core/schedule/store.js';
import { Intake } from '../src/core/schedule/intake.js';
import { claim, confirmClaim, listWaiting, loadParked, park, readClaim, staleClaims, type ParkedWait } from '../src/core/schedule/parked.js';
import { BudgetExhaustedError, runConfigFor, runScheduled, type ScheduledRunOptions } from '../src/core/schedule/run.js';
import { Daemon } from '../src/core/schedule/daemon.js';
import { getCliCommand } from '../src/core/commands.js';
import { Agent } from '../src/core/agent/agent.js';
import { tryAcquireWorkspaceLease, workspaceLeaseStatus, leaseFile, newLeaseToken, releaseWorkspaceLease } from '../src/core/workspace/lease.js';
import type { Schedule, TriggerEvent } from '../src/core/schedule/types.js';
import '../src/core/schedule/register.js';

const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

function schedule(over: Partial<Schedule> & { workspace: string }): Schedule {
  return { id: `s_${Math.random().toString(16).slice(2, 10)}`, trigger: { type: 'webhook' }, prompt: 'job', enabled: true, createdAt: new Date().toISOString(), ...over };
}
const ev = (over: Partial<TriggerEvent>): TriggerEvent => ({ id: Math.random().toString(16).slice(2), source: 'github', type: 'ci.finished', receivedAt: new Date().toISOString(), ...over });
const record = (o: ScheduledRunOptions, over: Partial<ScheduledRunRecord> = {}): ScheduledRunRecord => ({ runId: o.resume?.runId ?? `r_${Math.random().toString(16).slice(2, 8)}`, scheduleId: o.schedule.id, sessionId: 'x', mode: 'ask', startedAt: '', status: 'done', costUsd: 0, refusals: [], stopReason: 'end_turn', ...over });
const wait = (s: Schedule, over: Partial<ParkedWait> = {}): ParkedWait => ({ handle: `wait_${Math.random().toString(16).slice(2, 10)}`, runId: `sr_${Math.random().toString(16).slice(2, 8)}`, scheduleId: s.id, workspace: s.workspace, journals: [], waitFor: { event: { type: 'ci.finished' } }, reason: 'wait for CI', createdAt: new Date().toISOString(), ...over });
const setEnabled = (home: string, id: string, on: boolean) => saveSchedules(home, loadSchedules(home).map((x) => (x.id === id ? { ...x, enabled: on } : x)));

// ------------------------------------------------------------ R3

test('R3: a paused schedule never resumes parked work (probe 3); its event waits for enable, then resumes once', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), enabled: false }));
  const w = wait(s);
  park(config.homeDir, w);
  const resumed: string[] = [];
  const intake = new Intake({ config, run: async (o) => (resumed.push(`${o.resume?.handle}:${o.event?.id}`), record(o)) });
  // Probe 3: the disabled schedule's ci.finished wait used to come back as "resumed" and run.
  const out = intake.handle(ev({ id: 'evt1' }));
  assert.equal(out.status, 'deferred');
  assert.equal((out as any).reason, 'paused');
  await intake.idle();
  assert.equal(resumed.length, 0, 'nothing ran while paused');
  assert.equal(readClaim(config.homeDir, w.handle), undefined, 'the wait was not claimed');
  assert.equal(loadParked(config.homeDir, w.handle)?.pending?.event.id, 'evt1', 'the event is kept on the dormant wait');
  // A later event while still paused replaces the kept one; the daemon's retry does nothing while paused.
  intake.handle(ev({ id: 'evt2' }));
  assert.deepEqual(intake.retryDeferred(), []);
  assert.equal(loadParked(config.homeDir, w.handle)?.pending?.event.id, 'evt2');
  // Enable → reactivated: the kept event resumes the run exactly once.
  setEnabled(config.homeDir, s.id, true);
  assert.deepEqual(intake.retryDeferred(), [w.handle]);
  await intake.idle();
  assert.deepEqual(resumed, [`${w.handle}:evt2`]);
  assert.equal(readClaim(config.homeDir, w.handle)?.durable, true);
  assert.deepEqual(intake.retryDeferred(), []);
  assert.equal(intake.handle(ev({ id: 'evt3' })).status, 'ignored', 'a resumed wait is gone; the next event is an ordinary (unmatched) event');
  const kinds = readActivity(config.homeDir).filter((a) => a.handle === w.handle).map((a) => `${a.kind}:${a.reason ?? ''}`);
  assert.deepEqual(kinds.slice(0, 3), ['deferred:paused', 'deferred:paused', 'reactivated:paused']);
});

test('R3: a paused schedule\'s time wait stays dormant across daemon ticks and resumes on the first tick after enable', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), enabled: false }));
  const w = wait(s, { waitFor: { time: new Date(Date.now() - 60_000).toISOString() } });
  park(config.homeDir, w);
  const resumed: string[] = [];
  const d = new Daemon({ config, run: async (o) => (resumed.push(o.resume!.handle), record(o)) });
  d.tick();
  d.tick(new Date(Date.now() + 60_000));
  await d.intake.idle();
  assert.equal(resumed.length, 0);
  assert.equal(listWaiting(config.homeDir).length, 1, 'still waiting (dormant), not consumed');
  // The CLI says what pause/enable did to the wait.
  const out: string[] = [];
  await getCliCommand('schedule')!.run(['enable', s.id], { config, workspace: s.workspace, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /enabled; 1 parked wait\(s\) active again/);
  d.tick(new Date(Date.now() + 120_000));
  await d.intake.idle();
  assert.deepEqual(resumed, [w.handle]);
  d.tick(new Date(Date.now() + 180_000));
  await d.intake.idle();
  assert.equal(resumed.length, 1, 'once');
  // Disabling while a wait is pending says so.
  const s2 = addSchedule(config.homeDir, schedule({ workspace: s.workspace }));
  park(config.homeDir, wait(s2));
  out.length = 0;
  await getCliCommand('schedule')!.run(['disable', s2.id], { config, workspace: s.workspace, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /disabled; 1 parked wait\(s\) dormant until enabled/);
});

test('R3: remove and cancel invalidate parked waits; an event for a removed schedule cancels its wait instead of running it', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = tmpWorkspace();
  const a = addSchedule(config.homeDir, schedule({ workspace: ws }));
  const b = addSchedule(config.homeDir, schedule({ workspace: ws }));
  const wa = wait(a);
  const wb = wait(b, { waitFor: { event: { type: 'review.done' } } });
  const wc = wait(b, { waitFor: { event: { type: 'deploy.done' } } });
  for (const w of [wa, wb, wc]) park(config.homeDir, w);
  const ran: string[] = [];
  const intake = new Intake({ config, run: async (o) => (ran.push(o.resume?.handle ?? 'new'), record(o)) });
  const out: string[] = [];
  const cli = (args: string[]) => getCliCommand('schedule')!.run(args, { config, workspace: ws, write: (t) => out.push(t) });
  assert.equal(await cli(['cancel', wb.handle]), 0);
  assert.equal(await cli(['cancel', wb.handle]), 1, 'already cancelled');
  assert.equal(intake.handle(ev({ type: 'review.done' })).status, 'ignored');
  assert.equal(await cli(['remove', a.id]), 0);
  assert.match(out.join('\n'), /cancelled 1 parked wait/);
  assert.equal(intake.handle(ev({ type: 'ci.finished' })).status, 'ignored');
  // A schedule removed by editing schedules.json directly: the next matching event cancels the orphan.
  saveSchedules(config.homeDir, loadSchedules(config.homeDir).filter((x) => x.id !== b.id));
  assert.equal(intake.handle(ev({ type: 'deploy.done' })).status, 'ignored');
  await intake.idle();
  assert.deepEqual(ran, []);
  assert.deepEqual(listWaiting(config.homeDir), []);
  assert.ok(loadParked(config.homeDir, wc.handle)?.cancelled, 'the orphaned wait is closed');
  assert.ok(readActivity(config.homeDir).some((x) => x.kind === 'cancelled' && x.handle === wc.handle && x.reason === 'schedule_removed'));
});

test('R3: authorisation before claiming — an event addressed to another schedule or from an ignored actor does not resume a wait', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = tmpWorkspace();
  const mine = addSchedule(config.homeDir, schedule({ workspace: ws, ignoreActors: ['mallory'] }));
  const other = addSchedule(config.homeDir, schedule({ workspace: ws }));
  const w = wait(mine);
  park(config.homeDir, w);
  const ran: string[] = [];
  const intake = new Intake({ config, run: async (o) => (ran.push(o.resume?.handle ?? `new:${o.schedule.id}`), record(o)) });
  intake.handle(ev({ source: `github:${other.id}`, scheduleId: other.id, type: 'ci.finished' }));
  intake.handle(ev({ actor: 'mallory' }));
  await intake.idle();
  assert.equal(readClaim(config.homeDir, w.handle), undefined);
  assert.ok(!ran.includes(w.handle));
  intake.handle(ev({ source: `github:${mine.id}`, scheduleId: mine.id }));
  await intake.idle();
  assert.ok(ran.includes(w.handle));
});

test('R3: a claim whose resumed run never became durable is re-claimable after the lease; a durable claim is not', async () => {
  const config = testConfig('http://127.0.0.1:9/v1', { schedule: { claimLeaseMs: 40 } });
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace() }));
  const crashed = wait(s);
  const finished = wait(s, { waitFor: { event: { type: 'other' } } });
  park(config.homeDir, crashed);
  park(config.homeDir, finished);
  // A process claimed both, then "crashed" before the first resumed run was durable.
  const e1 = ev({ id: 'the-ci-event' });
  assert.ok(claim(config.homeDir, crashed.handle, 'github/the-ci-event', { leaseMs: 40, event: e1 }));
  assert.ok(claim(config.homeDir, finished.handle, 'github/x', { leaseMs: 40 }));
  confirmClaim(config.homeDir, finished.handle);
  assert.equal(claim(config.homeDir, crashed.handle, 'someone-else', { leaseMs: 40 }), false, 'a live lease cannot be taken');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(staleClaims(config.homeDir).map((c) => c.wait.handle), [crashed.handle]);
  const resumed: string[] = [];
  let durableCalls = 0;
  const intake = new Intake({ config, run: async (o) => (o.onDurable?.(), durableCalls++, resumed.push(`${o.resume?.handle}:${o.event?.id}`), record(o)) });
  // The daemon's retry recovers it, with the event stored in the claim.
  assert.deepEqual(intake.retryDeferred(), [crashed.handle]);
  await intake.idle();
  assert.deepEqual(resumed, [`${crashed.handle}:the-ci-event`]);
  assert.equal(durableCalls, 1);
  assert.equal(readClaim(config.homeDir, crashed.handle)?.durable, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(intake.retryDeferred(), [], 'durable claims are final');
  assert.ok(readActivity(config.homeDir).some((a) => a.kind === 'reactivated' && a.reason === 'claim_expired'));
});

test('R3: a resume with an exhausted budget is deferred (not claimed) and resumes once the window has room', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyBudgetUsd: 0.5 }));
  updateWindow(config.homeDir, s.id, (w) => ({ ...w, costUsd: 0.5 }));
  const w = wait(s);
  park(config.homeDir, w);
  const ceilings: (number | undefined)[] = [];
  const intake = new Intake({ config, run: async (o) => (ceilings.push(o.costCeilingUsd), record(o, { costUsd: 0.1 })) });
  const out = intake.handle(ev({}));
  assert.equal(out.status, 'deferred');
  assert.equal((out as any).reason, 'budget');
  assert.equal(readClaim(config.homeDir, w.handle), undefined);
  // The budget is raised (a new day, or the owner changed it): the next retry delivers it.
  saveSchedules(config.homeDir, loadSchedules(config.homeDir).map((x) => ({ ...x, dailyBudgetUsd: 1 })));
  assert.deepEqual(intake.retryDeferred(), [w.handle]);
  await intake.idle();
  assert.deepEqual(ceilings, [0.5]);
});

// ------------------------------------------------------------ R4

test('R4: two queued events for a $1/day schedule cannot both get the full ceiling (probe 4); runBudgetUsd splits it', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyBudgetUsd: 1 }));
  const ceilings: (number | undefined)[] = [];
  const intake = new Intake({ config, run: async (o) => (ceilings.push(o.costCeilingUsd), record(o, { costUsd: 0.75 })) });
  const outs = [1, 2].map((i) => intake.handle(ev({ id: String(i), source: `webhook:${s.id}`, type: 'event', scheduleId: s.id })));
  await intake.idle();
  assert.deepEqual(outs.map((o) => o.status), ['accepted', 'refused']);
  assert.match((outs[1] as any).detail, /\$1\.0000 reserved by runs in flight of \$1\.0000/);
  assert.deepEqual(ceilings, [1]);
  assert.equal(readWindow(config.homeDir, s.id).costUsd, 0.75, 'spend never exceeds the window');
  assert.equal(readWindow(config.homeDir, s.id).reservations, undefined, 'reservations are reconciled away');
  // With a per-run cap, several runs can queue, and together they stay within the day.
  const s2 = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyBudgetUsd: 1, runBudgetUsd: 0.4 }));
  const c2: (number | undefined)[] = [];
  const i2 = new Intake({ config, run: async (o) => (c2.push(o.costCeilingUsd), record(o, { costUsd: o.costCeilingUsd })) });
  const outs2 = [1, 2, 3].map((i) => i2.handle(ev({ id: `b${i}`, source: `webhook:${s2.id}`, type: 'event', scheduleId: s2.id })));
  await i2.idle();
  assert.deepEqual(outs2.map((o) => o.status), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual(c2.map((c) => Math.round((c ?? 0) * 100) / 100), [0.4, 0.4, 0.2]);
  assert.ok(readWindow(config.homeDir, s2.id).costUsd <= 1 + 1e-9);
});

test('R4: an exhausted ceiling is refused, never unlimited (probe 8) — runConfigFor(…, ≤0) throws and the run is a typed budget outcome', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = schedule({ workspace: tmpWorkspace() });
  assert.throws(() => runConfigFor(config, s, 0), BudgetExhaustedError);
  assert.throws(() => runConfigFor(config, s, -1), BudgetExhaustedError);
  assert.throws(() => runConfigFor(config, s, Number.NaN), BudgetExhaustedError);
  assert.equal(runConfigFor(config, s, undefined).agent.maxCostUsd, config.agent.maxCostUsd, 'undefined = no window ceiling');
  assert.equal(runConfigFor(config, s, 0.2).agent.maxCostUsd, 0.2);
  const mock = await startMockServer(() => ({ content: 'should not be called' }));
  servers.push(mock);
  const cfg = testConfig(mock.url);
  addSchedule(cfg.homeDir, s);
  for (const over of [{ costCeilingUsd: 0 }, { tokenCeiling: 0 }, { gpuSecondsCeiling: -1 }]) {
    const rec = await runScheduled({ config: cfg, schedule: s, ...over });
    assert.equal(rec.status, 'budget');
    assert.equal(rec.stopReason, 'budget');
  }
  assert.equal(mock.requests.length, 0, 'no model call for an exhausted window');
});

test('R4: the budget is re-checked at execution time (spend by another process while the run queued)', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyBudgetUsd: 1, runBudgetUsd: 0.5 }));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const ceilings: (number | undefined)[] = [];
  const intake = new Intake({
    config,
    run: async (o) => {
      ceilings.push(o.costCeilingUsd);
      if (ceilings.length === 1) await gate;
      return record(o, { costUsd: 0.1 });
    },
  });
  const outs = [1, 2, 3].map((i) => intake.handle(ev({ id: `q${i}`, source: `webhook:${s.id}`, type: 'event', scheduleId: s.id })));
  assert.deepEqual(outs.map((o) => o.status), ['accepted', 'accepted', 'refused'], 'two runs of $0.50 fill the window');
  while (ceilings.length < 1) await new Promise((r) => setTimeout(r, 10)); // run 1 is executing
  // Another daemon (another process) spends $0.6 on this schedule's window meanwhile.
  updateWindow(config.homeDir, s.id, (w) => ({ ...w, costUsd: w.costUsd + 0.6 }));
  release();
  const recs = (await (outs[1] as any).done) as ScheduledRunRecord[];
  await intake.idle();
  // Run 2's reservation was 0.5, but only 1 − 0.6 − 0.1 = 0.3 is left when it starts.
  assert.deepEqual(ceilings.map((c) => Math.round((c ?? 0) * 100) / 100), [0.5, 0.3]);
  assert.equal(recs[0].status, 'done');
  // With nothing left at execution time, the run does not start: typed budget record.
  const s2 = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyBudgetUsd: 1, runBudgetUsd: 0.5 }));
  let r2!: () => void;
  const g2 = new Promise<void>((r) => (r2 = r));
  let n = 0;
  const i2 = new Intake({ config, run: async (o) => (++n === 1 && (await g2), record(o, { costUsd: 0.5 })) });
  const o2 = [1, 2].map((i) => i2.handle(ev({ id: `z${i}`, source: `webhook:${s2.id}`, type: 'event', scheduleId: s2.id })));
  while (n < 1) await new Promise((r) => setTimeout(r, 10));
  updateWindow(config.homeDir, s2.id, (w) => ({ ...w, costUsd: w.costUsd + 0.5 }));
  r2();
  const second = ((await (o2[1] as any).done) as ScheduledRunRecord[])[0];
  assert.equal(second.status, 'budget');
  assert.equal(n, 1, 'the second run function never ran');
  assert.ok(readActivity(config.homeDir).some((a) => a.scheduleId === s2.id && a.reason === 'governor_budget' && /at execution/.test(a.detail ?? '')));
});

test('R4: token and GPU-second budgets for local endpoints (reserve, enforce in the run, reconcile measured use)', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), dailyTokens: 100, dailyGpuSeconds: 10, gpuShare: 0.5 }));
  const seen: [number | undefined, number | undefined, number | undefined][] = [];
  const intake = new Intake({ config, run: async (o) => (seen.push([o.tokenCeiling, o.gpuSecondsCeiling, o.gpuShare]), record(o, { tokens: 80, gpuSeconds: 6 })) });
  for (let i = 0; i < 3; i++) {
    intake.handle(ev({ id: `t${i}`, source: `webhook:${s.id}`, type: 'event', scheduleId: s.id }));
    await intake.idle();
  }
  assert.deepEqual(seen, [
    [100, 10, 0.5],
    [20, 4, 0.5],
  ]);
  assert.deepEqual({ tokens: readWindow(config.homeDir, s.id).tokens, gpu: readWindow(config.homeDir, s.id).gpuSeconds }, { tokens: 160, gpu: 12 });
  assert.match(readActivity(config.homeDir).filter((a) => a.reason === 'governor_budget').at(-1)?.detail ?? '', /160 tokens spent of 100 tokens|12\.0 GPU-s spent/);
  // In a real run, the token ceiling stops the agent before its next model call, and the record carries the measured use.
  const mock = await startMockServer((_b, i) => (i < 5 ? { toolCalls: [{ name: 'list_dir', arguments: { path: '.' } }] } : { content: 'done' }));
  servers.push(mock);
  const cfg = testConfig(mock.url);
  const s2 = addSchedule(cfg.homeDir, schedule({ workspace: tmpWorkspace({ 'a.txt': 'x' }) }));
  const rec = await runScheduled({ config: cfg, schedule: s2, tokenCeiling: 1, gpuShare: 0.5 });
  assert.equal(rec.stopReason, 'budget');
  assert.equal(mock.requests.length, 1, 'stopped before the second model call');
  assert.ok((rec.tokens ?? 0) > 1);
  assert.ok((rec.gpuSeconds ?? -1) >= 0 && (rec.gpuSeconds ?? 0) < 60);
  const rec2 = await runScheduled({ config: cfg, schedule: s2, gpuSecondsCeiling: 0.0001, gpuShare: 1 });
  assert.equal(rec2.stopReason, 'budget');
});

// ------------------------------------------------------------ R9

function gitRepo(): string {
  const ws = tmpWorkspace({ 'README.md': 'hello\n' });
  const g = (args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: ws, stdio: 'ignore' });
  g(['init', '-q']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return ws;
}

test('R9: two schedules on one repo — the second waits for the first one\'s workspace lease', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = gitRepo();
  const a = addSchedule(config.homeDir, schedule({ workspace: ws, name: 'A' }));
  const b = addSchedule(config.homeDir, schedule({ workspace: ws, name: 'B' }));
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  const timeline: string[] = [];
  const intake = new Intake({
    config,
    run: async (o) => {
      timeline.push(`${o.schedule.name}:start`);
      if (o.schedule.name === 'A') {
        const st = workspaceLeaseStatus(config.homeDir, ws);
        timeline.push(`lease:${st.lease?.kind}:${st.lease?.label}`);
        await gateA;
      }
      timeline.push(`${o.schedule.name}:end`);
      return record(o);
    },
  });
  intake.handle(ev({ id: 'a1', source: `webhook:${a.id}`, type: 'event', scheduleId: a.id }));
  await new Promise((r) => setTimeout(r, 50));
  intake.handle(ev({ id: 'b1', source: `webhook:${b.id}`, type: 'event', scheduleId: b.id }));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(timeline, ['A:start', 'lease:schedule:schedule A'], 'B has not started while A holds the workspace');
  assert.ok(readActivity(config.homeDir).some((x) => x.scheduleId === b.id && x.reason === 'workspace_busy' && /schedule A/.test(x.detail ?? '')));
  releaseA();
  await intake.idle();
  assert.deepEqual(timeline.slice(2), ['A:end', 'B:start', 'B:end']);
  assert.equal(workspaceLeaseStatus(config.homeDir, ws).held, false, 'released after both');
});

test('R9: with isolation: worktree the second writer runs in its own worktree, and its changes land on an oh/sched-* branch', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = gitRepo();
  const b = addSchedule(config.homeDir, schedule({ workspace: ws, name: 'B', isolation: 'worktree' }));
  // An interactive session (another process, say VS Code) holds the workspace.
  const held = tryAcquireWorkspaceLease(config.homeDir, ws, { kind: 'vscode', id: 'chat-1', token: newLeaseToken(), label: 'VS Code chat' });
  assert.ok(held.ok);
  let where = '';
  const intake = new Intake({
    config,
    run: async (o) => {
      where = o.schedule.workspace;
      fs.writeFileSync(path.join(o.schedule.workspace, 'from-b.txt'), 'b\n');
      return record(o);
    },
  });
  const out = intake.handle(ev({ id: 'b1', source: `webhook:${b.id}`, type: 'event', scheduleId: b.id }));
  const [rec] = (await (out as any).done) as ScheduledRunRecord[];
  assert.notEqual(where, ws);
  assert.equal(fs.existsSync(path.join(ws, 'from-b.txt')), false, "the user's tree is untouched");
  assert.match(rec.worktreeBranch ?? '', /^oh\/sched-/);
  const show = execFileSync('git', ['show', '--stat', '--format=%s', rec.worktreeBranch!], { cwd: ws }).toString();
  assert.match(show, /from-b\.txt/);
  assert.equal(fs.existsSync(where), false, 'the worktree directory is removed');
  assert.ok(held.ok && workspaceLeaseStatus(config.homeDir, ws).lease?.id === 'chat-1', 'the other holder keeps its lease');
});

test('R9: an interactive agent is warned (not blocked) when another writer holds the workspace; it takes and releases the lease itself otherwise', async () => {
  const mock = await startMockServer(() => ({ content: 'hi' }));
  servers.push(mock);
  const config = testConfig(mock.url, { agent: { repoMapTokens: 0, backgroundCompaction: false } });
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const notices: string[] = [];
  const statusDuring: string[] = [];
  const agent = await Agent.create({ workspace: ws, config, mcp: false, ui: { onEvent: (e) => {
    if (e.type === 'notice') notices.push(e.message);
    if (e.type === 'turn_start') statusDuring.push(String(workspaceLeaseStatus(config.homeDir, ws).lease?.kind));
  } } });
  await agent.run('hello');
  assert.deepEqual(statusDuring, ['session'], 'held during the run');
  assert.equal(workspaceLeaseStatus(config.homeDir, ws).held, false, 'released at the end of the run');
  const token = newLeaseToken();
  assert.ok(tryAcquireWorkspaceLease(config.homeDir, ws, { kind: 'schedule', id: 'sr_1', token, label: 'schedule nightly' }).ok);
  const r = await agent.run('again');
  assert.equal(r.stopReason, 'end_turn');
  assert.ok(notices.some((n) => /Another writer holds this workspace: schedule nightly/.test(n)), notices.join('\n'));
  assert.equal(workspaceLeaseStatus(config.homeDir, ws).lease?.token, token, "the schedule's lease is untouched");
  await agent.dispose();
  // interactive: 'wait' gives up after waitMs and stops the run with a clear reason.
  const cfg2 = testConfig(mock.url, { agent: { repoMapTokens: 0, backgroundCompaction: false }, workspaceLease: { interactive: 'wait', waitMs: 200 } });
  assert.ok(tryAcquireWorkspaceLease(cfg2.homeDir, ws, { kind: 'schedule', id: 'sr_2', token: newLeaseToken(), label: 'schedule nightly' }).ok);
  const before = mock.requests.length;
  const a2 = await Agent.create({ workspace: ws, config: cfg2, mcp: false });
  const r2 = await a2.run('hello');
  assert.equal(r2.stopReason, 'aborted');
  assert.match(r2.finalText, /still in use by schedule nightly/);
  assert.equal(mock.requests.length, before, 'no model call');
  await a2.dispose();
  releaseWorkspaceLease(config.homeDir, ws, token);
});

test('R9: a session keeps the lease while its background jobs run; a dead holder\'s lease is taken over', async () => {
  const mock = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 1.5', run_in_background: true } }] } : { content: 'started' }));
  servers.push(mock);
  const config = testConfig(mock.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, backgroundJobs: true } });
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const agent = await Agent.create({ workspace: ws, config, mcp: false });
  await agent.run('start the server');
  assert.equal(workspaceLeaseStatus(config.homeDir, ws).held, true, 'the job keeps the workspace');
  const deadline = Date.now() + 8000;
  while (workspaceLeaseStatus(config.homeDir, ws).held && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(workspaceLeaseStatus(config.homeDir, ws).held, false, 'released when the job exits');
  await agent.dispose();
  // A lease whose holder process is gone (same host) is stale and is taken over.
  const file = leaseFile(config.homeDir, ws);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ kind: 'cli', id: 'old', token: 'lt_old', pid: 2 ** 22 + 12345, host: (await import('node:os')).hostname(), workspace: ws, since: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
  const r = tryAcquireWorkspaceLease(config.homeDir, ws, { kind: 'schedule', id: 'new', token: newLeaseToken() });
  assert.ok(r.ok && !r.reentered);
  // `tug lease status` names the holder.
  const out: string[] = [];
  await getCliCommand('lease')!.run(['status'], { config, workspace: ws, write: (t) => out.push(t) });
  assert.match(out.join('\n'), /schedule new \(pid \d+/);
});
