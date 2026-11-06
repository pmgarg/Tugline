/**
 * N22: org-wide usage and per-user quotas (opt-in by managed policy `usage`).
 *
 * Each client POSTs its own totals for the day (from the C7 ledger) to the
 * company endpoint:
 *   → { client, user, date, tokens, costUsd, calls, version }
 *   ← { user, date, used: { tokens, costUsd }, quota?: { tokensPerDay?, costUsdPerDay? } }
 * `used` is the server's aggregate for the user across all their clients
 * (including this report). The server is the authority: it decides the quota.
 *
 * Admission (before each model call, from the C7 limits extension): the last
 * known org aggregate + this client's spend since that report + the projected
 * worst case of the next call must stay within the quota, else the run stops
 * with the typed `budget` reason. The server is asked again when its answer is
 * older than `intervalSeconds`. If it cannot be reached, the last answer is
 * used; with no answer at all, `failClosed: true` stops and false continues.
 *
 * Honest boundary: this is defence in depth on a machine the user controls (a
 * user can stop the client from reporting). Shared model budgets that must hold
 * belong in the company's model gateway, which sees every request.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { AgentApi, TurnGate } from '../agent/extensions.js';
import { localDate, spentOn } from '../permissions/limits.js';
import { TUGLINE_VERSION, type OrgUsagePolicy } from './managed.js';

export interface OrgAnswer {
  user: string;
  date: string;
  used: { tokens: number; costUsd: number };
  quota?: { tokensPerDay?: number; costUsdPerDay?: number };
}

interface State {
  answer?: OrgAnswer;
  /** Local totals at the time of the last answer (the server's `used` includes them). */
  reported: { tokens: number; costUsd: number };
  at: number;
  lastError?: string;
}
const states = new Map<string, State>();

export function orgUsagePolicy(cfg: HarnessConfig): OrgUsagePolicy | undefined {
  return cfg.managed?.policy.usage;
}

/** A stable random id for this client (per home directory). */
export function clientId(homeDir: string): string {
  const f = path.join(homeDir, 'client-id');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    const id = crypto.randomUUID();
    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(f, id, { mode: 0o600 });
    } catch {
      /* in-memory id */
    }
    return id;
  }
}

export function orgUser(u: OrgUsagePolicy, env: NodeJS.ProcessEnv = process.env): string {
  if (u.user) return u.user;
  if (env.TUG_USER) return env.TUG_USER;
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** Report today's local totals and read back the org aggregate and quota. */
export async function syncOrgUsage(cfg: HarnessConfig, timeoutMs = 3000): Promise<OrgAnswer | undefined> {
  const u = orgUsagePolicy(cfg);
  if (!u) return undefined;
  const key = `${cfg.homeDir}\0${u.url}`;
  const st = states.get(key) ?? { reported: { tokens: 0, costUsd: 0 }, at: 0 };
  states.set(key, st);
  const date = localDate();
  const local = spentOn(cfg.homeDir, date);
  try {
    const res = await fetch(u.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(u.headers ?? {}) },
      body: JSON.stringify({ client: clientId(cfg.homeDir), user: orgUser(u), date, tokens: local.tokens, costUsd: local.costUsd, calls: local.calls, version: TUGLINE_VERSION }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = (await res.json()) as OrgAnswer;
    if (!a || typeof a.used?.tokens !== 'number' || typeof a.used?.costUsd !== 'number') throw new Error('malformed answer (expected {used: {tokens, costUsd}, quota?})');
    st.answer = a;
    st.reported = { tokens: local.tokens, costUsd: local.costUsd };
    st.at = Date.now();
    st.lastError = undefined;
    return a;
  } catch (e) {
    st.lastError = (e as Error).message;
    return undefined;
  }
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const NO_HOLD = { tokens: 0, costUsd: 0 };
const refreshing = new Map<string, Promise<unknown>>();

/** Re-sync in the background when the last answer is stale (per-request admission is synchronous). */
function refreshIfStale(cfg: HarnessConfig, u: OrgUsagePolicy): void {
  const key = `${cfg.homeDir}\0${u.url}`;
  const st = states.get(key);
  if (st?.answer && st.answer.date === localDate() && Date.now() - st.at < (u.intervalSeconds ?? 30) * 1000) return;
  if (refreshing.has(key)) return;
  const p = syncOrgUsage(cfg).finally(() => refreshing.delete(key));
  refreshing.set(key, p);
}

/**
 * The org-quota decision for one call from the last known answer (synchronous, so it can run in the
 * per-request admission point, llm/admission.ts). `held` = what other in-flight calls of this home reserved.
 * Quota values follow R4: absent = no quota, 0 = exhausted.
 */
export function orgQuotaCheck(cfg: HarnessConfig, next: { tokens: number; costUsd: number }, held: { tokens: number; costUsd: number } = NO_HOLD, when = 'the next model call'): string | undefined {
  const u = orgUsagePolicy(cfg);
  if (!u) return undefined;
  refreshIfStale(cfg, u);
  const st = states.get(`${cfg.homeDir}\0${u.url}`);
  if (!st?.answer || st.answer.date !== localDate()) {
    if (u.failClosed && st && !st.answer) return `Stopped before ${when}: the company usage server (${u.url}) could not be reached (${st.lastError ?? 'no answer'}) and the managed policy requires it (usage.failClosed).`;
    return undefined;
  }
  const q = st.answer.quota;
  if (!q) return undefined;
  const local = spentOn(cfg.homeDir);
  const tokens = st.answer.used.tokens + Math.max(0, local.tokens - st.reported.tokens) + held.tokens;
  const costUsd = st.answer.used.costUsd + Math.max(0, local.costUsd - st.reported.costUsd) + held.costUsd;
  const who = st.answer.user;
  // R4 semantics, failing closed: absent = no quota; a non-number (null, a string) or ≤ 0 = exhausted
  for (const [k, v] of [['tokensPerDay', q.tokensPerDay], ['costUsdPerDay', q.costUsdPerDay]] as const)
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) return `Stopped before ${when}: ${who}'s org-wide ${k === 'tokensPerDay' ? 'token' : 'spend'} quota for today is exhausted (0, set by the company usage policy).`;
  if (q.tokensPerDay && tokens + next.tokens > q.tokensPerDay)
    return `Stopped before ${when}: it could use up to ${next.tokens} tokens and ${who}'s org-wide usage today is ${tokens} of the ${q.tokensPerDay}-token daily quota set by the company (managed usage policy).`;
  if (q.costUsdPerDay && costUsd + next.costUsd > q.costUsdPerDay)
    return `Stopped before ${when}: it could cost up to ${usd(next.costUsd)} and ${who}'s org-wide spend today is ${usd(costUsd)} of the ${usd(q.costUsdPerDay)} daily quota set by the company (managed usage policy).`;
  return undefined;
}

/** The org-quota part of the turn gate: re-sync (awaited) when stale, then decide. */
export async function orgAdmission(a: AgentApi, next: { tokens: number; costUsd: number }): Promise<TurnGate | undefined> {
  const u = orgUsagePolicy(a.config);
  if (!u) return undefined;
  const key = `${a.config.homeDir}\0${u.url}`;
  const st = states.get(key);
  if (!st?.answer || st.answer.date !== localDate() || Date.now() - st.at >= (u.intervalSeconds ?? 30) * 1000) await (refreshing.get(key) ?? syncOrgUsage(a.config));
  if (!states.get(key)) states.set(key, { reported: { tokens: 0, costUsd: 0 }, at: 0, lastError: 'no answer' });
  const msg = orgQuotaCheck(a.config, next);
  return msg ? { stop: 'budget', message: msg } : undefined;
}

/** Tests: forget cached answers. */
export function resetOrgUsage(): void {
  states.clear();
}
