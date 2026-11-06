/**
 * Spend limits and usage export (SPEC C7).
 *
 * Ledger: one JSON line per LLM call in `<homeDir>/usage/<YYYY-MM-DD>.jsonl`
 * (local date): model, tokens, cost, session, run, depth. Every agent writes
 * its own calls (the extension runs at every depth), so subagent spend is
 * counted once, under the parent's session id. Classifier-approver calls are
 * recorded too.
 *
 * Admission: before each LLM call the extension projects the worst case of the
 * next call (estimated prompt tokens + the profile's maxOutputTokens) and stops
 * the run with a typed `budget` stop if it could cross a limit:
 *   limits.maxCostUsdPerDay / maxTokensPerDay  (all sessions today, from the ledger)
 *   limits.maxCostUsdPerSession                (this session incl. subagents)
 * Cost limits need `pricing` on the profile (local models cost $0, so use the
 * token limit for them).
 *
 * v1.1 R4: the check runs for EVERY model request, not only main-loop turns:
 * `LLMClient.complete()` asks `llm/admission.ts`, which calls the policy
 * registered here with the worst case of the call plus what other in-flight
 * calls have reserved, and reconciles the actual usage into the ledger after
 * the call. A limit that is absent means unlimited; 0 (or less) means
 * exhausted, so no call is admitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { Usage } from '../types.js';
import { costOf } from '../llm/client.js';
import { registerAgentExtension, type AgentApi, type TurnGate } from '../agent/extensions.js';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { estimateMessagesTokens, estimateTokens } from '../util/text.js';
import { limitState, setAdmissionPolicy, type AdmissionScope, type CallEstimate, type Reserved } from '../llm/admission.js';
import { orgAdmission, orgQuotaCheck, orgUsagePolicy, syncOrgUsage } from '../policy/orgUsage.js';

export interface LimitsConfig {
  /** undefined = unlimited; 0 = exhausted (v1.1 R4) */
  maxCostUsdPerSession?: number;
  maxCostUsdPerDay?: number;
  maxTokensPerDay?: number;
  /** Write the usage ledger (default true). */
  ledger: boolean;
}
export const DEFAULT_LIMITS: LimitsConfig = { ledger: true };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC C7 (WS3). */
    limits?: Partial<LimitsConfig>;
  }
}

export function limitsConfig(cfg: HarnessConfig): LimitsConfig {
  return { ...DEFAULT_LIMITS, ...(cfg.limits ?? {}) };
}

export interface LedgerLine {
  ts: string;
  session: string;
  run?: string;
  depth: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  estimated?: boolean;
  /** 'agent' (default) or 'approver' */
  kind?: string;
}

export function localDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ledgerDir(homeDir: string): string {
  return path.join(homeDir, 'usage');
}

/** Root session id: subagents run as `<session>-sub` (v0.1) or `<session>-sub-<n>` (parallel subagents, D1). */
export function rootSession(id: string): string {
  return id.replace(/(?:-sub(?:-\d+)?)+$/, '');
}

export function recordUsage(homeDir: string, line: LedgerLine, date = localDate()): void {
  fs.mkdirSync(ledgerDir(homeDir), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(ledgerDir(homeDir), `${date}.jsonl`), JSON.stringify(line) + '\n', { mode: 0o600 });
}

export function readLedger(homeDir: string, date: string): LedgerLine[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(ledgerDir(homeDir), `${date}.jsonl`), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerLine[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* skip a torn line (concurrent writers) */
    }
  }
  return out;
}

export function spentOn(homeDir: string, date = localDate()): { costUsd: number; tokens: number; calls: number } {
  let costUsd = 0;
  let tokens = 0;
  const lines = readLedger(homeDir, date);
  for (const l of lines) {
    costUsd += Number(l.costUsd) || 0;
    tokens += (Number(l.promptTokens) || 0) + (Number(l.completionTokens) || 0);
  }
  return { costUsd, tokens, calls: lines.length };
}

// ------------------------------------------------------------ admission

const sessionTotals = new Map<string, { costUsd: number; tokens: number }>();
export function sessionSpend(sessionId: string): { costUsd: number; tokens: number } {
  return sessionTotals.get(rootSession(sessionId)) ?? { costUsd: 0, tokens: 0 };
}

/** Worst case of the next call: estimated prompt + the full output budget. */
export function projectNextCall(a: AgentApi): { tokens: number; costUsd: number } {
  const profile = a.llm.profile;
  let toolTokens = 0;
  try {
    const specs = (a.agent as { toolSpecs?: () => unknown }).toolSpecs?.();
    if (specs) toolTokens = estimateTokens(JSON.stringify(specs));
  } catch {
    /* estimate without tools */
  }
  const prompt = estimateMessagesTokens(a.messages) + toolTokens;
  const usage: Usage = { promptTokens: prompt, completionTokens: profile.maxOutputTokens };
  return { tokens: prompt + profile.maxOutputTokens, costUsd: costOf(usage, profile) };
}

const usd = (n: number) => `$${n.toFixed(4)}`;

const NONE: Reserved = { tokens: 0, costUsd: 0 };

/**
 * The limits decision for one call's worst case (`next`), with what other in-flight calls
 * have reserved. A refusal message, or undefined. Shared by the turn gate and every request.
 */
export function limitsCheck(cfg: HarnessConfig, sessionId: string, next: { tokens: number; costUsd: number }, reserved: { day: Reserved; session: Reserved } = { day: NONE, session: NONE }, when = 'the next model call'): string | undefined {
  const lim = limitsConfig(cfg);
  const day = limitState(lim.maxCostUsdPerDay);
  const tok = limitState(lim.maxTokensPerDay);
  const ses = limitState(lim.maxCostUsdPerSession);
  if (day === 'unlimited' && tok === 'unlimited' && ses === 'unlimited') return undefined;
  for (const [k, st] of [['maxCostUsdPerDay', day], ['maxTokensPerDay', tok], ['maxCostUsdPerSession', ses]] as const)
    if (st === 'exhausted') return `Stopped before ${when}: limits.${k} is ${lim[k]} (exhausted; remove the key for no limit). See /usage.`;
  if (day === 'limited' || tok === 'limited') {
    const today = spentOn(cfg.homeDir);
    const held = reserved.day;
    const pending = held.tokens || held.costUsd ? ` (plus ${held.tokens} tokens / ${usd(held.costUsd)} reserved by calls in flight)` : '';
    if (day === 'limited' && today.costUsd + held.costUsd + next.costUsd > lim.maxCostUsdPerDay!)
      return `Stopped before ${when}: it could cost up to ${usd(next.costUsd)} and today's spend is ${usd(today.costUsd)}${pending} of the ${usd(lim.maxCostUsdPerDay!)} daily limit (limits.maxCostUsdPerDay). See /usage.`;
    if (tok === 'limited' && today.tokens + held.tokens + next.tokens > lim.maxTokensPerDay!)
      return `Stopped before ${when}: it could use up to ${next.tokens} tokens and today's usage is ${today.tokens}${pending} of the ${lim.maxTokensPerDay} daily limit (limits.maxTokensPerDay). See /usage.`;
  }
  if (ses === 'limited') {
    const s = sessionSpend(sessionId);
    if (s.costUsd + reserved.session.costUsd + next.costUsd > lim.maxCostUsdPerSession!)
      return `Stopped before ${when}: it could cost up to ${usd(next.costUsd)} and this session has spent ${usd(s.costUsd)} of its ${usd(lim.maxCostUsdPerSession!)} limit (limits.maxCostUsdPerSession).`;
  }
  return undefined;
}

/** The admission decision of the turn gate (exported for tests and other surfaces). */
export function admission(a: AgentApi): TurnGate | undefined {
  const lim = limitsConfig(a.config);
  if ([lim.maxCostUsdPerDay, lim.maxTokensPerDay, lim.maxCostUsdPerSession].every((v) => limitState(v) === 'unlimited')) return undefined;
  const msg = limitsCheck(a.config, a.sessionId, projectNextCall(a));
  return msg ? { stop: 'budget', message: msg } : undefined;
}

/** Reconcile one call: session totals and the ledger line (one per request, whoever made it). */
export function recordCall(scope: AdmissionScope, usage: Usage, model: string, costUsd: number): void {
  const root = rootSession(scope.sessionId);
  const t = sessionTotals.get(root) ?? { costUsd: 0, tokens: 0 };
  t.costUsd += costUsd;
  t.tokens += usage.promptTokens + usage.completionTokens;
  sessionTotals.set(root, t);
  if (!limitsConfig(scope.config).ledger) return;
  recordUsage(scope.config.homeDir, { ts: new Date().toISOString(), session: root, run: scope.runId, depth: scope.depth, model, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, costUsd, estimated: usage.estimated || undefined, ...(scope.kind && scope.kind !== 'agent' ? { kind: scope.kind } : {}) });
}

// Every model request is admitted here (llm/admission.ts calls it from LLMClient.complete).
setAdmissionPolicy({
  cost: costOf,
  check: (scope: AdmissionScope, est: CallEstimate, reserved) => {
    const when = `this model call (${scope.role ?? scope.kind ?? 'agent'})`;
    // N22: the org quota covers every request too (helper calls included), from the last known org answer
    return limitsCheck(scope.config, scope.sessionId, est, reserved, when) ?? orgQuotaCheck(scope.config, est, reserved.day, when);
  },
  settle: (scope, usage, model, profile) => recordCall(scope, usage, model, costOf(usage, profile)),
});

registerAgentExtension({
  id: 'ws3-limits',
  // No `depths`: runs inside subagents too. The ledger and session totals are written per request by the
  // admission settle (v1.1 R4), so helper calls (summaries, approver, apply model …) are counted exactly once.
  // The org quota (N22) is checked per request in the admission policy above; the turn gate also awaits a
  // fresh org answer when the last one is stale, so a turn never starts on an outdated quota.
  async beforeTurn(a) {
    const local = admission(a);
    if (local) return local;
    // N22: the company's per-user quota (managed policy `usage`), from the last known org aggregate plus the local delta.
    return orgUsagePolicy(a.config) ? orgAdmission(a, projectNextCall(a)) : undefined;
  },
  async onRunEnd(a) {
    // N22: report the day's totals when a top-level run ends (the next admission also re-syncs).
    if (a.depth === 0 && orgUsagePolicy(a.config)) await syncOrgUsage(a.config).catch(() => undefined);
  },
});

// ------------------------------------------------------------ report (tug usage, /usage)

export function parseSince(since: string | undefined, now = new Date()): string {
  if (!since) {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return localDate(d);
  }
  const rel = since.match(/^(\d+)d$/);
  if (rel) {
    const d = new Date(now);
    d.setDate(d.getDate() - (Number(rel[1]) - 1));
    return localDate(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(since)) return since;
  if (since === 'today') return localDate(now);
  throw new Error(`--since expects YYYY-MM-DD, Nd (e.g. 7d) or today, got "${since}"`);
}

interface Agg {
  calls: number;
  prompt: number;
  completion: number;
  cost: number;
}
const add = (a: Agg, l: LedgerLine) => {
  a.calls++;
  a.prompt += Number(l.promptTokens) || 0;
  a.completion += Number(l.completionTokens) || 0;
  a.cost += Number(l.costUsd) || 0;
};
const zero = (): Agg => ({ calls: 0, prompt: 0, completion: 0, cost: 0 });

/** Per-day and per-model usage summary since a date (inclusive). */
export function usageReport(homeDir: string, opts: { since?: string; now?: Date; json?: boolean } = {}): string {
  const since = parseSince(opts.since, opts.now);
  let files: string[] = [];
  try {
    files = fs.readdirSync(ledgerDir(homeDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) >= since).sort();
  } catch {
    files = [];
  }
  const byDay = new Map<string, Map<string, Agg>>();
  const byModel = new Map<string, Agg>();
  const total = zero();
  for (const f of files) {
    const day = f.slice(0, 10);
    const m = new Map<string, Agg>();
    for (const l of readLedger(homeDir, day)) {
      const model = l.kind === 'approver' ? `${l.model} (approver)` : l.model;
      if (!m.has(model)) m.set(model, zero());
      add(m.get(model)!, l);
      if (!byModel.has(model)) byModel.set(model, zero());
      add(byModel.get(model)!, l);
      add(total, l);
    }
    if (m.size) byDay.set(day, m);
  }
  if (opts.json) return JSON.stringify({ since, days: Object.fromEntries([...byDay].map(([d, m]) => [d, Object.fromEntries(m)])), models: Object.fromEntries(byModel), total }, null, 2);
  if (!total.calls) return `No usage recorded since ${since} (ledger: ${ledgerDir(homeDir)}).`;
  const w = Math.max(18, ...[...byModel.keys()].map((k) => k.length));
  const row = (a: string, b: string, g: Agg) => `${a.padEnd(10)}  ${b.padEnd(w)}  ${String(g.calls).padStart(6)}  ${String(g.prompt).padStart(10)}  ${String(g.completion).padStart(10)}  ${usd(g.cost).padStart(10)}`;
  const head = `${'date'.padEnd(10)}  ${'model'.padEnd(w)}  ${'calls'.padStart(6)}  ${'prompt'.padStart(10)}  ${'completion'.padStart(10)}  ${'cost'.padStart(10)}`;
  const lines = [`Usage since ${since} (ledger: ${ledgerDir(homeDir)})`, '', 'Per day', head];
  for (const [day, m] of byDay) {
    let first = true;
    for (const [model, g] of [...m].sort((x, y) => x[0].localeCompare(y[0]))) {
      lines.push(row(first ? day : '', model, g));
      first = false;
    }
  }
  lines.push('', 'Per model', head);
  for (const [model, g] of [...byModel].sort((x, y) => y[1].cost - x[1].cost || x[0].localeCompare(y[0]))) lines.push(row('', model, g));
  lines.push(row('total', '', total));
  return lines.join('\n');
}

function limitsLine(cfg: HarnessConfig, sessionId?: string): string {
  const l = limitsConfig(cfg);
  const today = spentOn(cfg.homeDir);
  const parts = [`today: ${usd(today.costUsd)} / ${today.tokens} tokens in ${today.calls} calls`];
  if (sessionId) parts.push(`this session: ${usd(sessionSpend(sessionId).costUsd)}`);
  const show = (v: number | undefined, f: (n: number) => string) => (limitState(v) === 'unlimited' ? '' : limitState(v) === 'exhausted' ? `${f(0)} (exhausted)` : f(v!));
  const lim = [show(l.maxCostUsdPerDay, (n) => `${usd(n)}/day`), show(l.maxTokensPerDay, (n) => `${n} tokens/day`), show(l.maxCostUsdPerSession, (n) => `${usd(n)}/session`)].filter(Boolean);
  parts.push(`limits: ${lim.length ? lim.join(', ') : 'none'}`);
  return parts.join(' · ');
}

registerSlashCommand({
  name: 'usage',
  description: 'spend and token usage per day and per model (ledger), and the active limits',
  usage: '[--since YYYY-MM-DD|Nd]',
  run(args, ctx) {
    const m = args.match(/--since(?:=|\s+)(\S+)/);
    ctx.write(`${usageReport(ctx.config.homeDir, { since: m?.[1] ?? '7d' })}\n\n  ${limitsLine(ctx.config, ctx.agent?.sessionId)}`);
  },
});

/** `tug usage [--since YYYY-MM-DD|Nd|today] [--json]` */
export function usageCommand(argv: string[], ctx: { config: HarnessConfig; write: (t: string) => void }): number {
  const i = argv.findIndex((x) => x === '--since' || x.startsWith('--since='));
  const since = i < 0 ? undefined : argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  try {
    ctx.write(usageReport(ctx.config.homeDir, { since, json: argv.includes('--json') }));
    if (!argv.includes('--json')) ctx.write(`\n${limitsLine(ctx.config)}`);
    return 0;
  } catch (e) {
    ctx.write((e as Error).message);
    return 2;
  }
}

registerCliCommand({ name: 'usage', description: 'usage and spend per day and per model', usage: '[--since YYYY-MM-DD|Nd|today] [--json]', needsModel: false, run: (argv, ctx) => usageCommand(argv, ctx) });
