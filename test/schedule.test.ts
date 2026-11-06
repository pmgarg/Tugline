/**
 * SPEC H1: scheduled tasks and event triggers (WS8).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult, type MockServer } from './helpers.js';
import { cronMatches, nextRun, parseCron, CronError, minuteKey } from '../src/core/schedule/cron.js';
import { addSchedule, loadSchedules, readActivity, readWindow, wasSeen, type ScheduledRunRecord } from '../src/core/schedule/store.js';
import { Intake } from '../src/core/schedule/intake.js';
import { createHookHandler, signBody, startHookServer, verifySignature, webhookSecretName } from '../src/core/schedule/webhook.js';
import { SecretVault } from '../src/core/secrets/vault.js';
import { listWaiting, findWaitingFor } from '../src/core/schedule/parked.js';
import { runConfigFor, runScheduled } from '../src/core/schedule/run.js';
import { Daemon } from '../src/core/schedule/daemon.js';
import { beat, liveness } from '../src/core/schedule/heartbeat.js';
import { morningReport } from '../src/core/schedule/report.js';
import { launchdPlist, systemdUnit } from '../src/core/schedule/service.js';
import { getCliCommand } from '../src/core/commands.js';
import type { Schedule, TriggerEvent } from '../src/core/schedule/types.js';
import '../src/core/schedule/cli.js';

const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const U = (s: string) => new Date(s);

function schedule(over: Partial<Schedule> & { workspace: string }): Schedule {
  return { id: `s_${Math.random().toString(16).slice(2, 10)}`, trigger: { type: 'webhook' }, prompt: 'Summarise the event.', enabled: true, createdAt: new Date().toISOString(), ...over };
}

const ev = (over: Partial<TriggerEvent>): TriggerEvent => ({ id: Math.random().toString(16).slice(2), source: 'cron', type: 'cron.tick', receivedAt: new Date().toISOString(), ...over });

/** A run function that records calls without a model (for governor/dedupe plumbing tests). */
function fakeRun(calls: string[]) {
  return async (o: { schedule: Schedule; event?: TriggerEvent }): Promise<ScheduledRunRecord> => {
    calls.push(`${o.schedule.id}:${o.event?.id}`);
    return { runId: `r${calls.length}`, scheduleId: o.schedule.id, sessionId: 'x', mode: 'ask', startedAt: '', status: 'done', costUsd: 0.01, refusals: [], stopReason: 'end_turn' };
  };
}

// ------------------------------------------------------------ AC1 cron

test('H1 AC1: cron parsing — fields, ranges, steps, lists, names, macros, Sunday as 0 or 7', () => {
  const c = parseCron('0 9 * * 1-5');
  assert.deepEqual([...c.minute], [0]);
  assert.deepEqual([...c.hour], [9]);
  assert.deepEqual([...c.dow].sort(), [1, 2, 3, 4, 5]);
  assert.equal(c.domRestricted, false);
  assert.deepEqual([...parseCron('*/15 * * * *').minute], [0, 15, 30, 45]);
  assert.deepEqual([...parseCron('5-20/5 * * * *').minute], [5, 10, 15, 20]);
  assert.deepEqual([...parseCron('50/5 * * * *').minute], [50, 55]);
  assert.deepEqual([...parseCron('1,2,30-31 * * * *').minute], [1, 2, 30, 31]);
  assert.deepEqual([...parseCron('0 0 * jan,MAR-may *').month], [1, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * mon-fri').dow].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]); // 7 is Sunday
  assert.deepEqual([...parseCron('0 0 * * 5-7').dow].sort(), [0, 5, 6]);
  assert.deepEqual([...parseCron('* * * * *').dow].sort(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(parseCron('@daily').source, '@daily');
  assert.deepEqual([...parseCron('@hourly').minute], [0]);
  assert.equal(parseCron('@weekly').dowRestricted, true);
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '* * * * * *', '@reboot', '@sometimes', '1,,2 * * * *'])
    assert.throws(() => parseCron(bad), CronError, `"${bad}" should be rejected`);
});

test('H1 AC1: cron matching and next run (weekday 9am, Vixie day-of-month OR day-of-week, Feb 29, impossible dates)', () => {
  const wk = parseCron('0 9 * * 1-5');
  assert.equal(cronMatches(wk, U('2026-10-26T09:00:30Z')), true); // Monday
  assert.equal(cronMatches(wk, U('2026-10-25T09:00:00Z')), false); // Sunday
  assert.equal(cronMatches(wk, U('2026-10-26T09:01:00Z')), false);
  // From Friday after 9 → next Monday 09:00 UTC
  assert.equal(nextRun(wk, U('2026-10-30T09:00:00Z'))?.toISOString(), '2026-11-02T09:00:00.000Z');
  assert.equal(nextRun(wk, U('2026-10-30T08:59:59Z'))?.toISOString(), '2026-10-30T09:00:00.000Z');
  // both day fields restricted: the 1st of the month OR any Friday
  const or = parseCron('0 0 1 * 5');
  assert.equal(cronMatches(or, U('2026-11-01T00:00:00Z')), true); // Sunday the 1st
  assert.equal(cronMatches(or, U('2026-11-06T00:00:00Z')), true); // a Friday
  assert.equal(cronMatches(or, U('2026-11-07T00:00:00Z')), false);
  // only day-of-month restricted: weekday ignored
  assert.equal(cronMatches(parseCron('0 0 13 * *'), U('2026-11-13T00:00:00Z')), true);
  // leap day
  assert.equal(nextRun(parseCron('0 0 29 2 *'), U('2026-10-27T00:00:00Z'))?.toISOString(), '2028-02-29T00:00:00.000Z');
  // never
  assert.equal(nextRun(parseCron('0 0 31 2 *'), U('2026-01-01T00:00:00Z')), undefined);
  // every 15 minutes, across an hour boundary
  assert.equal(nextRun(parseCron('*/15 * * * *'), U('2026-10-27T10:50:00Z'))?.toISOString(), '2026-10-27T11:00:00.000Z');
  assert.equal(minuteKey(U('2026-10-27T10:50:42.123Z')), '2026-10-27T10:50Z');
});

// ------------------------------------------------------------ AC5 HMAC (+ fail closed)

async function hookSetup(trigger: Schedule['trigger'] = { type: 'webhook' }, opts: { secret?: boolean; mock?: MockServer } = {}) {
  const ws = tmpWorkspace({ 'README.md': 'hello\n' });
  const mock = opts.mock ?? (await startMockServer(() => ({ content: 'Handled the event.' })));
  if (!opts.mock) servers.push(mock);
  const config = testConfig(mock.url);
  const s = addSchedule(config.homeDir, schedule({ workspace: ws, trigger }));
  const secret = 'whsec-test-0123456789abcdef';
  if (opts.secret !== false) new SecretVault(config.homeDir).set(webhookSecretName(s.id), secret);
  const intake = new Intake({ config });
  const srv = await startHookServer(createHookHandler({ config, intake }), 0);
  const post = (body: string, headers: Record<string, string>) => fetch(`${srv.url}/hooks/${s.id}`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
  return { ws, mock, config, s, secret, intake, srv, post };
}

test('H1 AC5: HMAC is verified — a bad or missing signature is rejected before dedupe; a valid one is accepted', async () => {
  const h = await hookSetup();
  try {
    const body = JSON.stringify({ type: 'deploy.finished', id: 'd-1' });
    assert.equal(verifySignature(h.secret, Buffer.from(body), signBody(h.secret, body)), true);
    assert.equal(verifySignature(h.secret, Buffer.from(body), signBody('wrong-secret', body)), false);
    assert.equal(verifySignature(h.secret, Buffer.from(body + ' '), signBody(h.secret, body)), false);
    assert.equal(verifySignature(h.secret, Buffer.from(body), 'sha256=zz'), false);

    const bad = await h.post(body, { 'x-oh-signature': signBody('wrong-secret', body) });
    assert.equal(bad.status, 401);
    const none = await h.post(body, {});
    assert.equal(none.status, 401);
    // forged deliveries did not burn the real delivery id and started nothing
    assert.equal(wasSeen(h.config.homeDir, `webhook:${h.s.id}/d-1`), false);
    assert.equal(h.mock.requests.length, 0);
    const refused = readActivity(h.config.homeDir).filter((a) => a.reason === 'bad_signature');
    assert.equal(refused.length, 2);

    const ok = await h.post(body, { 'x-oh-signature': signBody(h.secret, body) });
    assert.equal(ok.status, 202);
    const j = await ok.json();
    assert.equal(j.status, 'accepted');
    await h.intake.idle();
    assert.ok(h.mock.requests.length >= 1, 'the signed delivery ran the agent');
    // the event's data went in as untrusted context
    assert.match(JSON.stringify(h.mock.requests[0].messages), /<untrusted_trigger_event source=\\"webhook:/);
  } finally {
    await h.srv.close();
  }
});

test('H1 AC5: a webhook schedule without a secret fails closed (503); unknown ids are 404', async () => {
  const h = await hookSetup({ type: 'webhook' }, { secret: false });
  try {
    const body = '{}';
    const r = await h.post(body, { 'x-oh-signature': signBody('anything', body) });
    assert.equal(r.status, 503);
    const r2 = await fetch(`${h.srv.url}/hooks/s_doesnotexist`, { method: 'POST', body });
    assert.equal(r2.status, 404);
    assert.equal(h.mock.requests.length, 0);
  } finally {
    await h.srv.close();
  }
});

// ------------------------------------------------------------ AC2 dedupe

test('H1 AC2: a duplicate webhook delivery (same X-GitHub-Delivery) runs once', async () => {
  const h = await hookSetup({ type: 'github', events: ['pull_request.opened'] });
  try {
    const body = JSON.stringify({ action: 'opened', number: 12, pull_request: { number: 12, title: 'Fix the parser' }, sender: { login: 'alice' } });
    const headers = { 'x-github-event': 'pull_request', 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958', 'x-hub-signature-256': signBody(h.secret, body) };
    const r1 = await h.post(body, headers);
    const r2 = await h.post(body, headers); // GitHub redelivery
    assert.equal(r1.status, 202);
    assert.equal((await r1.json()).status, 'accepted');
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { event: `github:${h.s.id}/72d3162e-cc78-11e3-81ab-4c9367dc0958`, type: 'pull_request.opened', status: 'refused', reason: 'duplicate' });
    await h.intake.idle();
    const runs = fs.readdirSync(path.join(h.config.homeDir, 'schedule', 'runs'));
    assert.equal(runs.length, 1, 'exactly one run');
    const calls = h.mock.requests.length;
    // a different delivery of the same event type is a new event
    const r3 = await h.post(body, { ...headers, 'x-github-delivery': 'another-delivery' });
    assert.equal((await r3.json()).status, 'accepted');
    await h.intake.idle();
    assert.equal(fs.readdirSync(path.join(h.config.homeDir, 'schedule', 'runs')).length, 2);
    assert.ok(h.mock.requests.length > calls);
    // an event type the schedule did not subscribe to is ignored (recorded)
    const other = JSON.stringify({ action: 'closed', sender: { login: 'alice' } });
    const r4 = await h.post(other, { 'x-github-event': 'issues', 'x-github-delivery': 'd-iss', 'x-hub-signature-256': signBody(h.secret, other) });
    assert.equal((await r4.json()).reason, 'no_match');
    // the dedupe ledger survives a new process (a fresh Intake on the same home)
    const fresh = new Intake({ config: h.config, run: fakeRun([]) });
    assert.equal(fresh.handle({ id: '72d3162e-cc78-11e3-81ab-4c9367dc0958', source: `github:${h.s.id}`, type: 'pull_request.opened', scheduleId: h.s.id, receivedAt: '' }).status, 'refused');
  } finally {
    await h.srv.close();
  }
});

// ------------------------------------------------------------ AC3 governor

test('H1 AC3: the window governor stops the 4th run when the max is 3 per day', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), trigger: { type: 'cron', cron: '* * * * *' }, maxRunsPerDay: 3 }));
  const calls: string[] = [];
  const intake = new Intake({ config, run: fakeRun(calls) });
  const outs = [1, 2, 3, 4].map((i) => intake.handle(ev({ id: `${s.id}@tick${i}`, scheduleId: s.id })));
  await intake.idle();
  assert.deepEqual(outs.map((o) => o.status), ['accepted', 'accepted', 'accepted', 'refused']);
  assert.equal((outs[3] as any).reason, 'governor_runs');
  assert.equal(calls.length, 3);
  assert.deepEqual(readWindow(config.homeDir, s.id), { runs: 3, costUsd: 0.03 });
  const refusal = readActivity(config.homeDir).find((a) => a.reason === 'governor_runs');
  assert.match(refusal?.detail ?? '', /3\/3 runs today/);
});

test('H1 AC3: the daily budget governor refuses once the window is spent, and each run ceiling shrinks to what is left', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), trigger: { type: 'cron', cron: '* * * * *' }, dailyBudgetUsd: 0.025 }));
  const ceilings: (number | undefined)[] = [];
  const intake = new Intake({
    config,
    run: async (o) => {
      ceilings.push(o.costCeilingUsd);
      return { runId: 'r', scheduleId: s.id, sessionId: 'x', mode: 'ask', startedAt: '', status: 'done', costUsd: 0.01, refusals: [] };
    },
  });
  for (let i = 0; i < 3; i++) {
    intake.handle(ev({ id: `b${i}`, scheduleId: s.id }));
    await intake.idle();
  }
  const fourth = intake.handle(ev({ id: 'b4', scheduleId: s.id }));
  assert.equal(fourth.status, 'refused');
  assert.equal((fourth as any).reason, 'governor_budget');
  assert.deepEqual(ceilings.map((c) => Math.round((c ?? 0) * 1000) / 1000), [0.025, 0.015, 0.005]);
  // the ceiling reaches the agent as agent.maxCostUsd
  assert.equal(runConfigFor(config, s, 0.005).agent.maxCostUsd, 0.005);
});

// ------------------------------------------------------------ headless runs

test('H1: scheduled runs are headless — "ask" becomes deny-with-record, and auto applies only when the schedule says so', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const mock = await startMockServer((body, i) => (i % 2 === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'touch created-by-run.txt' } }] } : { content: 'tried to touch a file' }));
  servers.push(mock);
  // The user's config says auto; the schedule does not, so the run is NOT auto.
  const config = testConfig(mock.url, { permissionMode: 'yolo' });
  const s = addSchedule(config.homeDir, schedule({ workspace: ws }));
  const rec = await runScheduled({ config, schedule: s, event: ev({ source: `webhook:${s.id}`, type: 'webhook', scheduleId: s.id, data: { hello: 'world' } }) });
  assert.equal(rec.mode, 'ask');
  assert.equal(rec.status, 'done');
  assert.equal(rec.refusals.length, 1);
  assert.match(rec.refusals[0].reason, /no user is available/);
  assert.equal(fs.existsSync(path.join(ws, 'created-by-run.txt')), false);
  assert.ok(readActivity(config.homeDir).some((a) => a.kind === 'denied' && a.runId === rec.runId), 'the denial is in the activity log');
  assert.ok(fs.readFileSync(rec.journal!, 'utf8').includes('"type":"refusal"'), 'and in the run journal');
  // With mode yolo on the schedule, the same action runs.
  const s2 = addSchedule(config.homeDir, schedule({ workspace: ws, mode: 'yolo' }));
  const rec2 = await runScheduled({ config, schedule: s2 });
  assert.equal(rec2.mode, 'yolo');
  assert.equal(rec2.refusals.length, 0);
  assert.equal(fs.existsSync(path.join(ws, 'created-by-run.txt')), true);
});

// ------------------------------------------------------------ AC4 parked waits

test('H1 AC4: a parked wait resumes after the event, from its journal', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const mock = await startMockServer((body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'wait_until', arguments: { event_type: 'check_suite.completed', source: 'github', subject: '7', reason: 'CI for PR #7 has to finish' } }] };
    // resumed run: answer from the event data
    const ci = /conclusion[^a-z]+(\w+)/.exec(JSON.stringify(body.messages))?.[1];
    return { content: `CI finished with ${ci ?? 'unknown'}; PR #7 can be merged.` };
  });
  servers.push(mock);
  const config = testConfig(mock.url);
  const s = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'github', events: ['pull_request.opened', 'check_suite.completed'] } }));
  const intake = new Intake({ config });
  const first = intake.handle({ id: 'gh-1', source: `github:${s.id}`, type: 'pull_request.opened', subject: '7', scheduleId: s.id, actor: 'alice', data: { number: 7 }, receivedAt: '' });
  assert.equal(first.status, 'accepted');
  const [rec] = await (first as any).done;
  assert.equal(rec.status, 'parked');
  assert.match(rec.handle, /^wait_/);
  assert.equal(mock.requests.length, 1, 'the run parked: no further model call');
  assert.equal(listWaiting(config.homeDir).length, 1);
  assert.match(morningReport(config.homeDir), /Still waiting[\s\S]*CI for PR #7/);
  // an unrelated event does not resume it
  const other = intake.handle({ id: 'gh-2', source: `github:${s.id}`, type: 'check_suite.completed', subject: '8', scheduleId: s.id, actor: 'github-actions', data: {}, receivedAt: '' });
  assert.notEqual(other.status, 'resumed');
  await intake.idle();
  const before = mock.requests.length;
  // the awaited event arrives: the same run resumes
  const done = intake.handle({ id: 'gh-3', source: `github:${s.id}`, type: 'check_suite.completed', subject: '7', scheduleId: s.id, actor: 'github-actions', data: { check_suite: { conclusion: 'success' } }, receivedAt: '' });
  assert.equal(done.status, 'resumed');
  const [rec2] = await (done as any).done;
  assert.equal(rec2.runId, rec.runId, 'same logical run');
  assert.equal(rec2.status, 'done');
  assert.equal(rec2.resumes, 1);
  assert.match(rec2.finalText, /CI finished with success/);
  const resumedReq = mock.requests[before];
  const transcript = JSON.stringify(resumedReq.messages);
  assert.match(transcript, /wait_until/, 'history from the first journal is back');
  assert.match(transcript, /Parked as wait_/);
  assert.match(lastToolResult(resumedReq), /The wait wait_\w+ is over/);
  assert.equal(listWaiting(config.homeDir).length, 0);
  // the same event redelivered does not resume twice
  assert.equal(intake.handle({ id: 'gh-3', source: `github:${s.id}`, type: 'check_suite.completed', subject: '7', scheduleId: s.id, receivedAt: '' }).status, 'refused');
});

test('H1 AC4: index miss falls back to a scan; a time wait resumes from the daemon tick', async () => {
  const ws = tmpWorkspace();
  const mock = await startMockServer((body, i) => (i === 0 ? { toolCalls: [{ name: 'wait_until', arguments: { time: '30m', reason: 'check again later' } }] } : { content: 'Checked again.' }));
  servers.push(mock);
  const config = testConfig(mock.url);
  const s = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'cron', cron: '0 0 1 1 *' } }));
  const rec = await runScheduled({ config, schedule: s });
  assert.equal(rec.status, 'parked');
  // event-type lookup through a deleted index still finds event waits by scan
  const evWs = schedule({ workspace: ws });
  void evWs;
  fs.rmSync(path.join(config.homeDir, 'schedule', 'parked', 'index.json'));
  assert.equal(findWaitingFor(config.homeDir, ev({ type: 'nothing' })).via, 'scan');
  const d = new Daemon({ config });
  d.tick(new Date(Date.now() + 10 * 60_000)); // not yet due
  await d.intake.idle();
  assert.equal(listWaiting(config.homeDir).length, 1);
  d.tick(new Date(Date.now() + 31 * 60_000));
  await d.intake.idle();
  assert.equal(listWaiting(config.homeDir).length, 0);
  assert.equal(mock.requests.length, 2);
  assert.match(lastToolResult(mock.requests[1]), /is over \(check again later\)/);
});

// ------------------------------------------------------------ AC6 self-trigger

test('H1 AC6: a self-triggered event is refused (actor identity), and so are file changes made while its own run is working', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = tmpWorkspace();
  const s = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'github', events: ['push'] } }));
  const calls: string[] = [];
  const intake = new Intake({ config, run: fakeRun(calls) });
  const self = intake.handle({ id: 'p1', source: `github:${s.id}`, type: 'push', scheduleId: s.id, actor: 'Tugline[bot]', receivedAt: '' });
  assert.deepEqual({ status: self.status, reason: (self as any).reason }, { status: 'refused', reason: 'self_trigger' });
  const human = intake.handle({ id: 'p2', source: `github:${s.id}`, type: 'push', scheduleId: s.id, actor: 'alice', receivedAt: '' });
  assert.equal(human.status, 'accepted');
  await intake.idle();
  assert.equal(calls.length, 1);
  assert.ok(readActivity(config.homeDir).some((a) => a.reason === 'self_trigger'));
  // schedule-level ignore list
  const s2 = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'github', events: ['push'] }, ignoreActors: ['dependabot[bot]'] }));
  assert.equal((intake.handle({ id: 'p3', source: `github:${s2.id}`, type: 'push', scheduleId: s2.id, actor: 'dependabot[bot]', receivedAt: '' }) as any).reason, 'ignored_actor');

  // File watch: changes in the workspace while the schedule's own run is working are the runtime's own doing.
  const w = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'watch', glob: 'src/**' } }));
  let release!: () => void;
  const daemon = new Daemon({
    config,
    run: async (o) => {
      await new Promise<void>((r) => (release = r));
      return { runId: 'rw', scheduleId: o.schedule.id, sessionId: 'x', mode: 'ask', startedAt: '', status: 'done', costUsd: 0, refusals: [] };
    },
  });
  const firstChange = daemon.handle({ id: 'src/a.ts@1', source: 'watch', type: 'file.changed', subject: 'src/a.ts', scheduleId: w.id, receivedAt: '' });
  assert.equal(firstChange.status, 'accepted');
  const own = daemon.handle({ id: 'src/a.ts@2', source: 'watch', type: 'file.changed', subject: 'src/a.ts', scheduleId: w.id, receivedAt: '' });
  assert.deepEqual({ status: own.status, reason: (own as any).reason }, { status: 'refused', reason: 'self_trigger' });
  await new Promise((r) => setTimeout(r, 20));
  release();
  await daemon.intake.idle();
});

// ------------------------------------------------------------ daemon: cron tick, leases, heartbeat, report

test('H1: the daemon fires a cron schedule once per matching minute, skips while the lease is held, and records missed ticks', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const s = addSchedule(config.homeDir, schedule({ workspace: tmpWorkspace(), trigger: { type: 'cron', cron: '*/5 * * * *' } }));
  const calls: string[] = [];
  let release!: () => void;
  const d = new Daemon({
    config,
    run: async (o) => {
      calls.push(o.event!.id);
      if (calls.length === 2) await new Promise<void>((r) => (release = r));
      return { runId: `r${calls.length}`, scheduleId: o.schedule.id, sessionId: 'x', mode: 'ask', startedAt: '', status: 'done', costUsd: 0, refusals: [] };
    },
  });
  d.tick(U('2026-10-27T10:04:00Z')); // no match
  d.tick(U('2026-10-27T10:05:10Z'));
  d.tick(U('2026-10-27T10:05:40Z')); // same minute again: nothing
  await d.intake.idle();
  assert.deepEqual(calls, [`${s.id}@2026-10-27T10:05Z`]);
  // A second daemon (another process) ticking the same minute is deduped by the ledger.
  const d2 = new Daemon({ config, run: async () => assert.fail('must not run') });
  d2.tick(U('2026-10-27T10:05:50Z'));
  // A run still going when the next tick fires → recorded skip (lease held).
  d.tick(U('2026-10-27T10:10:00Z'));
  await new Promise((r) => setTimeout(r, 20));
  d.tick(U('2026-10-27T10:15:00Z'));
  assert.ok(readActivity(config.homeDir).some((a) => a.kind === 'skipped' && a.reason === 'lease_held'));
  release();
  await d.intake.idle();
  // Missed ticks while the daemon was down are recorded, not silently lost.
  beat(config.homeDir, { pid: 1, startedAt: '' }, U('2026-10-27T10:16:00Z'));
  const missed = d.recordMissedTicks(U('2026-10-27T10:31:00Z'));
  assert.equal(missed, 3); // 10:20, 10:25, 10:30
});

test('H1: heartbeat liveness (200 alive / 503 stale) and the morning report lists ignored and refused events with reasons', async () => {
  const h = await hookSetup();
  try {
    let r = await fetch(`${h.srv.url}/hooks/_liveness`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).status, 'never');
    beat(h.config.homeDir, { pid: process.pid, startedAt: new Date().toISOString() });
    r = await fetch(`${h.srv.url}/hooks/_liveness`);
    assert.equal(r.status, 200);
    beat(h.config.homeDir, { pid: process.pid, startedAt: '' }, new Date(Date.now() - 10 * 60_000));
    assert.equal(liveness(h.config.homeDir, 120_000).status, 'stale');
    assert.equal((await fetch(`${h.srv.url}/hooks/_liveness`)).status, 503);
    // some traffic
    const body = JSON.stringify({ id: 'x1', actor: 'tugline' });
    await h.post(body, { 'x-oh-signature': signBody(h.secret, body) }); // self-trigger
    await h.post(body, { 'x-oh-signature': signBody('nope', body) }); // bad signature
    const rep = morningReport(h.config.homeDir);
    assert.match(rep, /Daemon: \*\*STALE\*\*/);
    assert.match(rep, /Stopped by a rule[\s\S]*self_trigger[\s\S]*bad_signature/);
    assert.match(rep, /\| arrived \| acted \| ignored \| refused/);
  } finally {
    await h.srv.close();
  }
});

// ------------------------------------------------------------ install-service, CLI

test('H1: install-service generates a launchd plist and a systemd user unit (text only)', () => {
  const spec = { node: '/usr/local/bin/node', cli: '/opt/oh/dist/cli/main.js', args: ['--port', '7878'], homeDir: '/Users/me/.tugline', env: { PATH: '/usr/bin:/bin' } };
  const plist = launchdPlist(spec);
  assert.match(plist, /^<\?xml version="1.0"/);
  assert.match(plist, /<key>Label<\/key>\s*<string>dev\.tugline\.daemon<\/string>/);
  assert.match(plist, /<array>\s*<string>\/usr\/local\/bin\/node<\/string>\s*<string>\/opt\/oh\/dist\/cli\/main\.js<\/string>\s*<string>daemon<\/string>\s*<string>--port<\/string>\s*<string>7878<\/string>\s*<\/array>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/Users\/me\/\.tugline\/schedule\/daemon\.log<\/string>/);
  assert.equal((plist.match(/<dict>/g) ?? []).length, (plist.match(/<\/dict>/g) ?? []).length);
  const unit = systemdUnit({ ...spec, cli: '/opt/my oh/main.js' });
  assert.match(unit, /^\[Unit\]/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/bin\/node "\/opt\/my oh\/main\.js" daemon --port 7878$/m);
  assert.match(unit, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('H1: tug schedule add / list / remove / report / install-service --print through the CLI registry', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = tmpWorkspace();
  const out: string[] = [];
  const run = (argv: string[]) => getCliCommand('schedule')!.run(argv, { config, workspace: ws, write: (t) => out.push(t) });
  assert.equal(await run(['add', '--cron', '0 9 * * 1-5', '--prompt', 'Triage new issues', '--name', 'triage', '--max-runs', '3']), 0);
  assert.match(out.join('\n'), /added s_\w+ \(triage\): cron "0 9 \* \* 1-5" \(UTC\)/);
  assert.match(out.join('\n'), /next runs: \d{4}-/);
  assert.equal(await run(['add', '--cron', '61 * * * *', '--prompt', 'x']), 2);
  assert.equal(await run(['add', '--webhook', '--prompt', 'Handle deploys', '--mode', 'yolo']), 0);
  const all = out.join('\n');
  assert.match(all, /webhook: POST http:\/\/127\.0\.0\.1:7880\/hooks\/s_\w+/);
  assert.match(all, /binds 127\.0\.0\.1 only \(also with `tug serve --with-daemon`\)[\s\S]*TLS reverse proxy[\s\S]*tunnel/);
  assert.match(all, /warning: WARNING: yolo mode/);
  const secret = all.match(/shown once[^:]*: ([0-9a-f]{64})/)?.[1];
  assert.ok(secret);
  const list = loadSchedules(config.homeDir);
  assert.equal(list.length, 2);
  assert.equal(list[0].maxRunsPerDay, 3);
  // the secret is in the vault, not in schedules.json
  assert.ok(!fs.readFileSync(path.join(config.homeDir, 'schedule', 'schedules.json'), 'utf8').includes(secret!));
  assert.equal(await new SecretVault(config.homeDir).resolve(webhookSecretName(list[1].id)), secret);
  out.length = 0;
  await run(['list']);
  assert.match(out.join('\n'), /triage +on +cron "0 9 \* \* 1-5" \(UTC\) next \d{4}/);
  assert.equal(await run(['remove', 'triage']), 0);
  assert.equal(loadSchedules(config.homeDir).length, 1);
  out.length = 0;
  await run(['report']);
  assert.match(out.join('\n'), /# Scheduled agent report/);
  out.length = 0;
  await run(['install-service', '--print']);
  assert.match(out.join('\n'), process.platform === 'darwin' ? /<plist/ : /\[Service\][\s\S]*daemon/);
  assert.equal(await run(['status']), 1, 'no daemon running → non-zero');
});

test('H1: tug daemon end to end — webhook listener, heartbeat, and a file-watch trigger (debounced, glob-filtered)', async () => {
  const config = testConfig('http://127.0.0.1:9/v1');
  const ws = tmpWorkspace({ 'src/a.ts': 'export const a = 1;\n', 'docs/x.md': '# x\n' });
  const w = addSchedule(config.homeDir, schedule({ workspace: ws, trigger: { type: 'watch', glob: 'src/**/*.ts', debounceMs: 100 } }));
  const calls: string[] = [];
  const d = new Daemon({ config, run: fakeRun(calls) });
  const { url } = await d.start({ port: 0 });
  try {
    assert.ok(url);
    assert.equal((await fetch(`${url}/hooks/_liveness`)).status, 200);
    assert.equal((await fetch(`${url}/elsewhere`)).status, 404);
    fs.writeFileSync(path.join(ws, 'docs', 'x.md'), '# changed\n'); // outside the glob
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(ws, 'src', 'a.ts'), 'export const a = 3;\n'); // debounced into one event
    for (let i = 0; i < 50 && !calls.length; i++) await new Promise((r) => setTimeout(r, 50));
    await d.intake.idle();
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.match(calls[0], new RegExp(`^${w.id}:src/a\\.ts@\\d+$`));
  } finally {
    await d.stop();
  }
});

test('H1: the webhook listener binds loopback only; `tug daemon` and `tug schedule` help say a TLS proxy or tunnel is needed', async () => {
  const { startHookServer, isLoopbackHost } = await import('../src/core/schedule/webhook.js');
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  await assert.rejects(startHookServer(async () => false, 0, '0.0.0.0'), /only binds a loopback address[\s\S]*TLS reverse proxy/);
  const config = testConfig('http://127.0.0.1:9/v1', { schedule: { host: '0.0.0.0', port: 0 } });
  const out: string[] = [];
  assert.equal(await getCliCommand('daemon')!.run([], { config, workspace: tmpWorkspace(), write: (t) => out.push(t) }), 1);
  assert.match(out.join('\n'), /only binds a loopback address, not "0\.0\.0\.0"/);
  assert.match(getCliCommand('daemon')!.usage ?? '', /127\.0\.0\.1 only.*TLS reverse proxy or tunnel/);
  const help: string[] = [];
  await getCliCommand('schedule')!.run([], { config, workspace: tmpWorkspace(), write: (t) => help.push(t) });
  assert.match(help.join('\n'), /default 7880[\s\S]*tug serve --with-daemon[\s\S]*binds 127\.0\.0\.1 only/);
});
