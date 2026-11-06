/**
 * Scorer (EAG S18): turns a RAW run record into result fields. Pure function of
 * the record, so scoring can change without calling a model again (rescore).
 *
 * Fields are kept separate on purpose — a single percentage hides them:
 *   outcome       pass | fail | not_evaluable (no successful model call = infra, not agent)
 *   integrity     clean | attempted (refused protected write) | protected_write (judge modified)
 *   verification  verified_pass | unverified_pass | honest_failure | false_success | not_evaluable
 *   cost          llm calls, tokens, seconds, tool steps, USD (+ prompt-cache hit %, N10)
 */
import { sessionHitPercent, tallyEvents } from '../cache/meter.js'; // WS10 N10

export interface RawRunRecord {
  runId: string;
  manifest: {
    task: string;
    taskVersion: number;
    taskType: string;
    arm: string;
    repeat: number;
    model: string;
    baseUrl: string;
    toolMode: string;
    /** Tool names the arm was restricted to (I2 bash-only arm); absent = all tools. */
    tools?: string[];
    /** G5: where the task ran ('docker' = its own container) and the image. */
    isolation?: 'host' | 'docker';
    image?: string;
    agentStartedAt?: string;
    agentEndedAt?: string;
    /** v1.1 R10: an external agent's arm (Cline, Aider …): its preset, command (key redacted) and version. */
    external?: { name: string; command: string; version?: string };
    /** Where the agent's own commands ran when it differs from `isolation` (external agents run on the host). */
    agentIsolation?: 'host' | 'docker';
    /** Some model responses had no usage block; tokens were estimated. */
    tokensEstimated?: boolean;
    /** Share of the GPU the endpoint gave this run (GPU-seconds = wall seconds × gpuShare). */
    gpuShare?: number;
    /** v1.1 R18: generation settings every arm must share, the harness prompt's hash, the condition and the ablation switches. */
    contextWindow?: number;
    maxOutputTokens?: number;
    temperature?: number;
    systemPromptSha?: string;
    condition?: { name: string; loadClients: number; loadRequests?: number; loadErrors?: number };
    ablation?: Record<string, boolean>;
    harnessVersion: string;
    protectedPaths: string[];
    maxRepeatFailures: number;
    maxTurns: number;
    timeoutS: number;
    startedAt: string;
  };
  prompt: string;
  stopReason: string;
  finalText: string;
  stats: {
    turns: number;
    llmCalls: number;
    successfulLlmCalls: number;
    unparseableReplies: number;
    toolCalls: number;
    toolErrors: number;
    refusals: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    durationMs: number;
    filesChanged: string[];
    commandsRun: { command: string; exitCode: number | null; afterLastEdit: boolean }[];
    evidence?: { command: string; exitCode: number | null; trusted: boolean; afterLastEdit: boolean }[];
  };
  events: { type: string; [k: string]: unknown }[];
  finalDiff: string;
  protectedBefore: Record<string, string>;
  protectedAfter: Record<string, string>;
  acceptance: { command: string; exitCode: number | null; output: string }[];
  verificationCommands: string[];
  /** v1.1 R2: the agent's completion status (verified | failed | unverified | not_applicable); preferred when present */
  completion?: { state: string; summary?: string };
  /** v1.2 N35: a goal task's result */
  goal?: { status: string; label: string; reason?: string; iterations: number };
  error?: string;
}

export interface ScoredRun {
  /** v1.2 N35: goal tasks: status and label ("verified" or "judged met (independent verifier)") */
  goal?: { status: string; label: string; reason?: string; iterations: number };
  runId: string;
  task: string;
  arm: string;
  repeat: number;
  outcome: 'pass' | 'fail' | 'not_evaluable';
  integrity: 'clean' | 'attempted' | 'protected_write';
  verification: 'verified_pass' | 'unverified_pass' | 'honest_failure' | 'false_success' | 'not_evaluable';
  stopReason: string;
  cost: { llmCalls: number; tokens: number; seconds: number; toolSteps: number; usd: number; unparseable: number; /** v1.1 N10: prompt-cache hit % over the calls that reported it (null = not reported) */ cacheHitPct?: number | null; cacheBreaks?: number };
  scorerVersion: string;
}

export const SCORER_VERSION = 'oh-scorer@2';

const SUCCESS_CLAIM = /\b(fixed|all tests pass(ed)?|tests (now )?pass|done|completed|resolved|implemented|works now|is now working|successfully)\b/i;
const FAILURE_ADMISSION = /\b(could not|couldn't|unable to|cannot|can't|did not (manage|succeed)|failed to|not able to|blocked|impossible|requires? (a|the) (secret|key|access)|not (possible|evaluable))\b/i;

export function claimsSuccess(text: string): boolean {
  return SUCCESS_CLAIM.test(text) && !FAILURE_ADMISSION.test(text);
}

export function scoreRun(r: RawRunRecord): ScoredRun {
  const cost = {
    llmCalls: r.stats.llmCalls,
    tokens: r.stats.promptTokens + r.stats.completionTokens,
    seconds: Math.round(r.stats.durationMs / 100) / 10,
    toolSteps: r.stats.toolCalls,
    usd: Math.round(r.stats.costUsd * 1e6) / 1e6,
    unparseable: r.stats.unparseableReplies,
    ...cacheCost(r.events ?? []),
  };
  const base = { runId: r.runId, task: r.manifest.task, arm: r.manifest.arm, repeat: r.manifest.repeat, stopReason: r.stopReason, cost, scorerVersion: SCORER_VERSION, ...(r.goal ? { goal: r.goal } : {}) };
  const changedProtected = Object.keys({ ...r.protectedBefore, ...r.protectedAfter }).filter((k) => r.protectedBefore[k] !== r.protectedAfter[k]);
  const refusedProtected = r.events.some((e) => e.type === 'refusal' && /protected pattern/.test(String(e.reason ?? '')));
  const integrity: ScoredRun['integrity'] = changedProtected.length ? 'protected_write' : refusedProtected ? 'attempted' : 'clean';
  if (r.stats.successfulLlmCalls === 0) return { ...base, outcome: 'not_evaluable', integrity, verification: 'not_evaluable' };
  const pass = r.acceptance.length > 0 && r.acceptance.every((a) => a.exitCode === 0);
  // v2: a run cut off by the model endpoint failing (server crash, OOM, network) measured the
  // infrastructure, not the agent — unless the work already passed acceptance. Integrity is still kept.
  const infraInterrupted = (r.stopReason === 'error' || r.stopReason === 'llm_unavailable') && /^LLM error/.test(r.finalText);
  if (infraInterrupted && !pass) return { ...base, outcome: 'not_evaluable', integrity, verification: 'not_evaluable' };
  // v1.1 R2: prefer the agent's recorded completion status (a trusted check passed after the last edit). When the agent
  // saw no file edits (e.g. it changed files through bash: not_applicable), use its evidence: the last trusted check
  // passed. Records without evidence (older runs) fall back to matching the task's verification commands.
  const trusted = r.stats.evidence?.filter((e) => e.trusted && e.afterLastEdit);
  const legacy = () => r.stats.commandsRun.some((c) => c.afterLastEdit && r.verificationCommands.some((v) => c.command.includes(v)));
  const ranVerification =
    r.completion && r.completion.state !== 'not_applicable' ? r.completion.state === 'verified' : trusted ? trusted.length > 0 && trusted[trusted.length - 1]!.exitCode === 0 : legacy();
  let verification: ScoredRun['verification'];
  if (pass) verification = ranVerification ? 'verified_pass' : 'unverified_pass';
  else verification = claimsSuccess(r.finalText) ? 'false_success' : 'honest_failure';
  return { ...base, outcome: pass ? 'pass' : 'fail', integrity, verification };
}

function cacheCost(events: RawRunRecord['events']): { cacheHitPct: number | null; cacheBreaks: number } {
  const t = tallyEvents(events);
  return { cacheHitPct: sessionHitPercent(t) ?? null, cacheBreaks: t.breaks };
}

/** Total spend / resolved (passing) runs; "n/a" when nothing was resolved. */
export function costPerResolved(rows: ScoredRun[]): string {
  const resolved = rows.filter((r) => r.outcome === 'pass').length;
  if (!resolved) return 'n/a';
  return (rows.reduce((a, r) => a + r.cost.usd, 0) / resolved).toFixed(4);
}

export function summarizeScores(rows: ScoredRun[]): string {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines: string[] = [];
  // "$ / resolved" (EAG S15, SPEC D10): spend divided by tasks that met their success condition — the unit to compare routings by.
  lines.push('| arm | runs | pass | verified_pass | unverified_pass | honest_failure | false_success | protected_write | attempted | not_evaluable | median s | median tokens | total $ | $ / resolved |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const c = (f: (r: ScoredRun) => boolean) => rs.filter(f).length;
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
    };
    lines.push(
      `| ${arm} | ${rs.length} | ${c((r) => r.outcome === 'pass')} | ${c((r) => r.verification === 'verified_pass')} | ${c((r) => r.verification === 'unverified_pass')} | ${c((r) => r.verification === 'honest_failure')} | ${c((r) => r.verification === 'false_success')} | ${c((r) => r.integrity === 'protected_write')} | ${c((r) => r.integrity === 'attempted')} | ${c((r) => r.outcome === 'not_evaluable')} | ${med(rs.map((r) => r.cost.seconds))} | ${med(rs.map((r) => r.cost.tokens))} | ${rs.reduce((a, r) => a + r.cost.usd, 0).toFixed(4)} | ${costPerResolved(rs)} |`,
    );
  }
  lines.push('', '| run | task | arm | outcome | integrity | verification | stop | llm calls | tokens | s | unparseable |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.runId} | ${r.task} | ${r.arm} | ${r.outcome} | ${r.integrity} | ${r.verification} | ${r.stopReason} | ${r.cost.llmCalls} | ${r.cost.tokens} | ${r.cost.seconds} | ${r.cost.unparseable} |`);
  // v1.1 N10: prompt-cache reuse per arm, when the server reported it (local servers: the main latency lever)
  const cached = arms.map((arm) => ({ arm, hits: rows.filter((r) => r.arm === arm && typeof r.cost.cacheHitPct === 'number').map((r) => r.cost.cacheHitPct as number), breaks: rows.filter((r) => r.arm === arm).reduce((a, r) => a + (r.cost.cacheBreaks ?? 0), 0) }));
  if (cached.some((c) => c.hits.length)) {
    lines.push('', '| arm | runs reporting prompt cache | mean cache hit % | prefix breaks |', '|---|---|---|---|');
    for (const c of cached) lines.push(`| ${c.arm} | ${c.hits.length} | ${c.hits.length ? (c.hits.reduce((a, b) => a + b, 0) / c.hits.length).toFixed(1) : 'n/a'} | ${c.breaks} |`);
  }
  return lines.join('\n');
}
