/**
 * The morning report (`tug schedule report`, EAG S16). It answers "what did the
 * agent do while I was away?" including what it chose NOT to do: the safest
 * behaviour is the least visible, so ignored events and refusals are listed
 * with their reasons, next to what it did and what it cost.
 */
import { liveness } from './heartbeat.js';
import { listWaiting } from './parked.js';
import { loadSchedules, readActivity } from './store.js';
import type { ActivityRecord } from './types.js';

export function morningReport(home: string, opts: { since?: Date; staleMs?: number; now?: Date } = {}): string {
  const now = opts.now ?? new Date();
  const since = opts.since ?? new Date(now.getTime() - 24 * 3600_000);
  const acts = readActivity(home, since);
  const by = (k: ActivityRecord['kind']) => acts.filter((a) => a.kind === k);
  const names = new Map(loadSchedules(home).map((s) => [s.id, s.name ? `${s.name} (${s.id})` : s.id]));
  const sched = (id?: string) => (id ? names.get(id) ?? id : '-');
  const live = liveness(home, opts.staleMs ?? 120_000, now);
  const lines: string[] = [];
  lines.push(`# Scheduled agent report`, '', `Window: ${since.toISOString()} → ${now.toISOString()}`, '');
  lines.push(
    `Daemon: ${live.status === 'alive' ? `alive (last beat ${Math.round((live.ageMs ?? 0) / 1000)}s ago, pid ${live.heartbeat?.pid}, up since ${live.heartbeat?.startedAt})` : live.status === 'stale' ? `**STALE**: last beat ${Math.round((live.ageMs ?? 0) / 1000)}s ago (pid ${live.heartbeat?.pid}). It may have died.` : '**never started** (no heartbeat)'}`,
    '',
  );
  const acted = by('acted');
  const cost = acted.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  lines.push(`| arrived | acted | ignored | refused | denied actions | parked | errors | spend |`, '|---|---|---|---|---|---|---|---|');
  lines.push(`| ${by('arrived').length} | ${acted.length} | ${by('ignored').length} | ${by('refused').length} | ${by('denied').length} | ${by('parked').length} | ${by('error').length} | $${cost.toFixed(4)} |`, '');
  const section = (title: string, rows: ActivityRecord[], fmt: (r: ActivityRecord) => string) => {
    lines.push(`## ${title}`, '');
    if (!rows.length) lines.push('_none_');
    else for (const r of rows.slice(-50)) lines.push(`- ${r.ts.slice(0, 19)}Z ${fmt(r)}`);
    if (rows.length > 50) lines.push(`- … ${rows.length - 50} earlier`);
    lines.push('');
  };
  section('Acted', acted, (r) => `${sched(r.scheduleId)}: run ${r.runId} → ${r.stopReason ?? '?'} (${r.detail ?? ''}), $${(r.costUsd ?? 0).toFixed(4)}`);
  section('Ignored (with reasons)', by('ignored'), (r) => `${r.key ?? ''} → ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  section('Stopped by a rule', by('refused'), (r) => `${r.key ?? sched(r.scheduleId)} → **${r.reason}**${r.detail ? `: ${r.detail}` : ''}`);
  section('Actions denied inside runs (needed approval)', by('denied'), (r) => `${sched(r.scheduleId)} run ${r.runId}: ${r.detail ?? ''}`);
  section('Skipped ticks', by('skipped'), (r) => `${sched(r.scheduleId)}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  section('Errors', by('error'), (r) => `${sched(r.scheduleId)}: ${r.detail ?? ''}`);
  // v1.1 R3: parked work that a pause or the budget held back, and waits that were invalidated.
  section('Parked work held back (paused schedule or no budget)', by('deferred'), (r) => `${sched(r.scheduleId)} ${r.handle}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  section('Parked work reactivated', by('reactivated'), (r) => `${sched(r.scheduleId)} ${r.handle}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  section('Parked work cancelled', by('cancelled'), (r) => `${sched(r.scheduleId)} ${r.handle} (run ${r.runId}): ${r.reason}`);
  const waiting = listWaiting(home);
  lines.push('## Still waiting', '');
  if (!waiting.length) lines.push('_none_');
  const enabled = new Map(loadSchedules(home).map((x) => [x.id, x.enabled]));
  for (const w of waiting) lines.push(`- ${w.handle} (${sched(w.scheduleId)}, run ${w.runId})${enabled.get(w.scheduleId) === false ? ' **DORMANT (schedule disabled)**' : ''}${w.pending ? ` [event kept: ${w.pending.key}]` : ''}: ${w.reason} — waiting for ${w.waitFor.event ? `event ${w.waitFor.event.type}${w.waitFor.event.subject ? ` #${w.waitFor.event.subject}` : ''}` : `time ${w.waitFor.time}`}, since ${w.createdAt}${w.expiresAt && new Date(w.expiresAt) < now ? ' **EXPIRED**' : ''}`);
  lines.push('');
  return lines.join('\n');
}
