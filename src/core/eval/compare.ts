/**
 * Paired comparison report (v1.1 R10, `tug bench --compare`, `tug eval --compare`).
 * Reads the RAW records of one or more eval/bench output directories and
 * reports, per arm (Tugline arms and external agents alike):
 *
 *  - resolved: the trusted task check (hidden tests / acceptance) passed. This
 *    is the headline number, because only a check the agent cannot influence
 *    establishes completion;
 *  - false success: the check failed but the agent claimed success;
 *  - self-verified: resolved, and the agent ran the task's own check after its
 *    last edit (Tugline arms only: an external agent's commands are not visible);
 *  - integrity violations (protected file changed, or a write attempt refused)
 *    and edit retries (failed edit tool calls);
 *  - p50/p95 wall time and tokens (tokens are metered at the endpoint for
 *    external arms, so every arm is measured the same way);
 *  - GPU-seconds per resolved task = Σ wall seconds × gpuShare / resolved, so a
 *    local model's "$0" is not read as free;
 *  - 95% Wilson intervals over all runs (tasks × repeats).
 *
 * The paired part compares each arm with a baseline arm task by task (pass
 * rate over repeats), counts wins/losses/ties, and gives a two-sided exact
 * sign test over the tasks that differ.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claimsSuccess, scoreRun, type RawRunRecord, type ScoredRun } from './scorer.js';

/** Wilson score interval for k successes in n trials (z = 1.96 → 95%). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

/** Nearest-rank percentile. */
export function percentile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/** Two-sided exact sign test: probability of a split at least this uneven with p = 0.5. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (!n) return 1;
  const k = Math.min(wins, losses);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binom(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}

function binom(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

const EDIT_TOOLS = /^(edit_file|write_file|apply_patch|multi_edit|str_replace|replace_in_file|search_replace)$/;

export interface ArmSummary {
  arm: string;
  external?: string;
  runs: number;
  evaluable: number;
  resolved: number;
  resolvedCi: [number, number];
  selfVerified: number;
  falseSuccess: number;
  falseSuccessCi: [number, number];
  integrity: number;
  editRetries: number | null;
  p50s: number;
  p95s: number;
  p50Tokens: number;
  p95Tokens: number;
  tokensEstimated: boolean;
  usd: number;
  gpuSeconds: number;
  gpuSecondsPerResolved: number | null;
  version?: string;
}

export interface CompareInput {
  records: RawRunRecord[];
  /** Wall-time share of the GPU an arm's endpoint used (1 = a dedicated GPU); per arm or one for all. */
  gpuShare?: number | Record<string, number>;
  baseline?: string;
  /** R18: the predeclared pilot (fixed conditions, held-out split, target); enables the protocol checks and the decision. */
  pilot?: PilotSpec;
  /** sha256 of the pilot file as read (recorded in the report). */
  pilotSha?: string;
}

export function loadRecords(dirs: string[]): RawRunRecord[] {
  const out: RawRunRecord[] = [];
  for (const d of dirs) {
    const runs = path.join(d, 'runs');
    if (!fs.existsSync(runs)) throw new Error(`${d}: no runs/ directory (not an eval or bench output)`);
    for (const f of fs.readdirSync(runs).filter((x) => x.endsWith('.json')).sort()) out.push(JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8')) as RawRunRecord);
  }
  return out;
}

function shareFor(arm: string, g: CompareInput['gpuShare'], rec?: RawRunRecord): number {
  const fromRecord = (rec?.manifest as { gpuShare?: number } | undefined)?.gpuShare;
  if (typeof g === 'number') return g;
  if (g && arm in g) return g[arm];
  return fromRecord ?? 1;
}

export function summarizeArms(inp: CompareInput): { arms: ArmSummary[]; scored: ScoredRun[] } {
  const scored = inp.records.map(scoreRun);
  const arms = [...new Set(scored.map((s) => s.arm))];
  const out: ArmSummary[] = [];
  for (const arm of arms) {
    const idx = scored.map((s, i) => (s.arm === arm ? i : -1)).filter((i) => i >= 0);
    const rs = idx.map((i) => scored[i]);
    const raws = idx.map((i) => inp.records[i]);
    const ext = raws.find((r) => (r.manifest as { external?: { name: string } }).external)?.manifest as { external?: { name: string; version?: string } } | undefined;
    const runs = rs.length;
    const resolved = rs.filter((r) => r.outcome === 'pass').length;
    // Over all runs: a run that never reached the model counts against the arm, like a failure (no silent drop-outs).
    const falseSuccess = rs.filter((r, i) => r.outcome === 'fail' && claimsSuccess(raws[i].finalText)).length;
    const seconds = rs.map((r) => r.cost.seconds);
    const tokens = rs.map((r) => r.cost.tokens);
    const gpuSeconds = rs.reduce((a, r, i) => a + r.cost.seconds * shareFor(arm, inp.gpuShare, raws[i]), 0);
    const retries = ext?.external ? null : raws.reduce((a, r) => a + r.events.filter((e) => e.type === 'tool_end' && EDIT_TOOLS.test(String(e.name)) && e.ok === false).length, 0);
    out.push({
      arm,
      external: ext?.external?.name,
      version: ext?.external?.version,
      runs,
      evaluable: rs.filter((r) => r.outcome !== 'not_evaluable').length,
      resolved,
      resolvedCi: wilson(resolved, runs),
      selfVerified: rs.filter((r) => r.verification === 'verified_pass').length,
      falseSuccess,
      falseSuccessCi: wilson(falseSuccess, runs),
      integrity: rs.filter((r) => r.integrity !== 'clean').length,
      editRetries: retries,
      p50s: percentile(seconds, 0.5),
      p95s: percentile(seconds, 0.95),
      p50Tokens: percentile(tokens, 0.5),
      p95Tokens: percentile(tokens, 0.95),
      tokensEstimated: raws.some((r) => (r.manifest as { tokensEstimated?: boolean }).tokensEstimated),
      usd: rs.reduce((a, r) => a + r.cost.usd, 0),
      gpuSeconds: Math.round(gpuSeconds * 10) / 10,
      gpuSecondsPerResolved: resolved ? Math.round((gpuSeconds / resolved) * 10) / 10 : null,
    });
  }
  return { arms: out, scored };
}

export interface PairedRow {
  task: string;
  rates: Record<string, number>;
}

export function pairedByTask(scored: ScoredRun[]): PairedRow[] {
  const tasks = [...new Set(scored.map((s) => s.task))].sort();
  const arms = [...new Set(scored.map((s) => s.arm))];
  return tasks.map((task) => ({
    task,
    rates: Object.fromEntries(
      arms.map((arm) => {
        const rs = scored.filter((s) => s.task === task && s.arm === arm);
        return [arm, rs.length ? rs.filter((r) => r.outcome === 'pass').length / rs.length : NaN];
      }),
    ),
  }));
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const ci = (c: [number, number]) => `${pct(c[0])}–${pct(c[1])}`;

function armTables(inp: CompareInput, heading = '# Paired comparison'): string {
  const { arms, scored } = summarizeArms(inp);
  const baseline = inp.baseline && arms.some((a) => a.arm === inp.baseline) ? inp.baseline : arms[0]?.arm;
  const lines: string[] = [heading, ''];
  lines.push(`Runs: ${scored.length} across ${new Set(scored.map((s) => s.task)).size} task(s) and ${arms.length} arm(s). Resolved = the trusted task check passed. Intervals are 95% Wilson over runs (tasks × repeats).`, '');
  lines.push('| arm | agent | runs | resolved | 95% CI | false success | 95% CI | self-verified | integrity | edit retries | p50 s | p95 s | p50 tokens | p95 tokens | $ | GPU-s | GPU-s / resolved |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of arms)
    lines.push(
      `| ${a.arm} | ${a.external ? `${a.external}${a.version ? ` (${a.version})` : ''}` : 'Tugline'} | ${a.runs} | ${a.resolved} (${pct(a.runs ? a.resolved / a.runs : 0)}) | ${ci(a.resolvedCi)} | ${a.falseSuccess} (${pct(a.runs ? a.falseSuccess / a.runs : 0)}) | ${ci(a.falseSuccessCi)} | ${a.external ? 'n/a' : a.selfVerified} | ${a.integrity} | ${a.editRetries ?? 'n/a'} | ${a.p50s} | ${a.p95s} | ${a.p50Tokens}${a.tokensEstimated ? '*' : ''} | ${a.p95Tokens}${a.tokensEstimated ? '*' : ''} | ${a.usd.toFixed(4)} | ${a.gpuSeconds} | ${a.gpuSecondsPerResolved ?? 'n/a'} |`,
    );
  if (arms.some((a) => a.tokensEstimated)) lines.push('', '\\* some responses carried no usage block; their tokens are estimated as characters / 4.');
  const rows = pairedByTask(scored);
  if (arms.length > 1 && baseline) {
    lines.push('', `## Per task (pass rate over repeats; baseline: ${baseline})`, '', `| task | ${arms.map((a) => a.arm).join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
    for (const r of rows) lines.push(`| ${r.task} | ${arms.map((a) => (Number.isNaN(r.rates[a.arm]) ? '–' : pct(r.rates[a.arm]))).join(' | ')} |`);
    lines.push('', '| arm vs baseline | wins | losses | ties | sign test p |', '|---|---|---|---|---|');
    for (const a of arms) {
      if (a.arm === baseline) continue;
      let w = 0;
      let l = 0;
      let t = 0;
      for (const r of rows) {
        const x = r.rates[a.arm];
        const y = r.rates[baseline];
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        if (x > y) w++;
        else if (x < y) l++;
        else t++;
      }
      lines.push(`| ${a.arm} vs ${baseline} | ${w} | ${l} | ${t} | ${signTest(w, l).toFixed(3)} |`);
    }
  }
  const abl = inp.records.some((r) => r.manifest.ablation);
  if (abl) {
    const full = arms.find((a) => a.arm === 'oh-full');
    lines.push('', '## Ablations (vs oh-full)', '', '| arm | planner | reviewer | subagents | code mode | resolved | Δ resolved (pp) | GPU-s / resolved |', '|---|---|---|---|---|---|---|---|');
    for (const a of arms) {
      const ab = inp.records.find((r) => r.manifest.arm === a.arm.split(' @ ')[0] && r.manifest.ablation)?.manifest.ablation;
      if (!ab) continue;
      const rate = a.runs ? a.resolved / a.runs : 0;
      const d = full && full.runs ? ((rate - full.resolved / full.runs) * 100).toFixed(0) : 'n/a';
      lines.push(`| ${a.arm} | ${ab.planner ? 'on' : 'off'} | ${ab.reviewer ? 'on' : 'off'} | ${ab.subagents ? 'on' : 'off'} | ${ab.codeMode ? 'on' : 'off'} | ${a.resolved}/${a.runs} | ${a.arm === 'oh-full' ? '—' : d} | ${a.gpuSecondsPerResolved ?? 'n/a'} |`);
    }
    lines.push('', 'Code Mode (N21) is a switch only once N21 is merged; until then its on/off arms run the same harness.');
  }
  lines.push('', 'GPU-seconds = wall seconds × gpuShare (the fraction of the GPU the endpoint gave this arm; 1 = dedicated). See docs/PILOT.md for the protocol behind a decision-grade comparison.');
  return lines.join('\n');
}

// ------------------------------------------------------------ R18: pilot protocol

export type PilotMetric = 'resolvedRate' | 'falseSuccessRate' | 'integrity' | 'gpuSecondsPerResolved' | 'p95s' | 'p50Tokens';

/**
 * A target rule, evaluated candidate vs baseline on the held-out tasks, per condition:
 *  higher      candidate > baseline + margin
 *  notHigher   candidate ≤ baseline + margin
 *  max         candidate ≤ value
 *  ratioMax    candidate ≤ baseline × value
 *  ciNotBelow  the candidate's 95% Wilson interval does not lie below the baseline's point estimate (rates only)
 */
export interface PilotRule {
  metric: PilotMetric;
  kind: 'higher' | 'notHigher' | 'max' | 'ratioMax' | 'ciNotBelow';
  value?: number;
  margin?: number;
}

export interface PilotSpec {
  name?: string;
  /** When the target was fixed (ISO). Must be before the first run started. */
  declaredAt: string;
  model?: { weights?: string; sha256?: string; quant?: string; chatTemplate?: string; server?: string; contextWindow?: number; maxOutputTokens?: number; temperature?: number };
  arms?: Record<string, { role?: 'candidate' | 'baseline' | 'control' | 'ablation'; tuningHours?: number; tuningNotes?: string; prompts?: string }>;
  heldOut?: string[];
  minTasks?: number;
  targetTasks?: number;
  minRepeats?: number;
  /** Contention conditions every arm must be run under (default quiet + shared). */
  conditions?: string[];
  target: { candidate: string; baseline: string; rules: PilotRule[] };
}

/** The decision rule of docs/PILOT.md §6, as data. */
export const DEFAULT_PILOT_RULES: PilotRule[] = [
  { metric: 'resolvedRate', kind: 'higher' },
  { metric: 'resolvedRate', kind: 'ciNotBelow' },
  { metric: 'falseSuccessRate', kind: 'notHigher' },
  { metric: 'integrity', kind: 'max', value: 0 },
  { metric: 'gpuSecondsPerResolved', kind: 'ratioMax', value: 1.5 },
];

export function loadPilot(file: string): { spec: PilotSpec; sha: string } {
  const text = fs.readFileSync(file, 'utf8');
  const spec = JSON.parse(text) as PilotSpec;
  if (!spec.declaredAt || Number.isNaN(Date.parse(spec.declaredAt))) throw new Error(`${file}: declaredAt (ISO time the target was fixed) is required`);
  if (!spec.target?.candidate || !spec.target?.baseline) throw new Error(`${file}: target.candidate and target.baseline are required`);
  spec.target.rules = spec.target.rules?.length ? spec.target.rules : DEFAULT_PILOT_RULES;
  return { spec, sha: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

/** Arm label: the arm name, plus the model when records span several models (live multi-model runs, R19). */
export function labelRecords(records: RawRunRecord[]): RawRunRecord[] {
  const models = new Set(records.map((r) => r.manifest.model));
  if (models.size < 2) return records;
  return records.map((r) => ({ ...r, manifest: { ...r.manifest, arm: `${r.manifest.arm} @ ${r.manifest.model}` } }));
}

const conditionOf = (r: RawRunRecord) => r.manifest.condition?.name ?? 'unlabelled';

function metricOf(a: ArmSummary, m: PilotMetric): number | null {
  switch (m) {
    case 'resolvedRate':
      return a.runs ? a.resolved / a.runs : null;
    case 'falseSuccessRate':
      return a.runs ? a.falseSuccess / a.runs : null;
    case 'integrity':
      return a.integrity;
    case 'gpuSecondsPerResolved':
      return a.gpuSecondsPerResolved;
    case 'p95s':
      return a.p95s;
    case 'p50Tokens':
      return a.p50Tokens;
  }
}

export function evaluateRule(rule: PilotRule, cand: ArmSummary, base: ArmSummary): { pass: boolean; detail: string } {
  const c = metricOf(cand, rule.metric);
  const b = metricOf(base, rule.metric);
  const f = (x: number | null) => (x === null ? 'n/a' : rule.metric.endsWith('Rate') ? pct(x) : String(Math.round(x * 100) / 100));
  if (c === null) return { pass: false, detail: `${rule.metric}: candidate has no value` };
  const m = rule.margin ?? 0;
  switch (rule.kind) {
    case 'higher':
      return { pass: b !== null && c > b + m, detail: `${f(c)} > ${f(b)}${m ? ` + ${m}` : ''}` };
    case 'notHigher':
      return { pass: b !== null && c <= b + m, detail: `${f(c)} ≤ ${f(b)}${m ? ` + ${m}` : ''}` };
    case 'max':
      return { pass: c <= (rule.value ?? 0), detail: `${f(c)} ≤ ${rule.value ?? 0}` };
    case 'ratioMax':
      return { pass: b === null ? c !== null : c <= b * (rule.value ?? 1), detail: `${f(c)} ≤ ${rule.value ?? 1} × ${f(b)}` };
    case 'ciNotBelow': {
      const ci = rule.metric === 'falseSuccessRate' ? cand.falseSuccessCi : cand.resolvedCi;
      return { pass: b !== null && ci[1] >= b, detail: `candidate 95% CI ${ci_(ci)} vs baseline ${f(b)}` };
    }
  }
}
const ci_ = (c: [number, number]) => `${pct(c[0])}–${pct(c[1])}`;

/** The protocol checks of docs/PILOT.md, from the raw records and the declared pilot. */
export function pilotChecks(records: RawRunRecord[], pilot: PilotSpec, pilotSha?: string): { check: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] {
  const out: { check: string; status: 'ok' | 'warn' | 'fail'; detail: string }[] = [];
  const add = (check: string, status: 'ok' | 'warn' | 'fail', detail: string) => out.push({ check, status, detail });
  const uniq = <T>(xs: T[]) => [...new Set(xs.map((x) => JSON.stringify(x ?? null)))];
  const arms = [...new Set(records.map((r) => r.manifest.arm))];
  for (const [k, label] of [['model', 'same model (weights)'], ['baseUrl', 'same endpoint'], ['contextWindow', 'same context window'], ['maxOutputTokens', 'same generation budget (max output)'], ['temperature', 'same sampling temperature']] as const) {
    const v = uniq(records.map((r) => (r.manifest as Record<string, unknown>)[k]));
    add(label, v.length === 1 ? 'ok' : 'fail', v.length === 1 ? `${v[0]}` : `differs across runs: ${v.join(', ')}`);
  }
  const declared = pilot.model ?? {};
  const missing = (['sha256', 'quant', 'chatTemplate', 'server'] as const).filter((k) => !declared[k]);
  add('weights, quantisation, chat template and server recorded', missing.length ? 'warn' : 'ok', missing.length ? `pilot.model is missing ${missing.join(', ')}` : `${declared.weights ?? ''} sha256 ${declared.sha256} ${declared.quant}, template ${declared.chatTemplate}`);
  if (declared.contextWindow !== undefined) {
    const bad = records.filter((r) => r.manifest.contextWindow !== undefined && r.manifest.contextWindow !== declared.contextWindow).length;
    add('declared context window used', bad ? 'fail' : 'ok', bad ? `${bad} run(s) used another context window` : `${declared.contextWindow}`);
  }
  const noPrompt = arms.filter((a) => !records.some((r) => r.manifest.arm === a && r.manifest.systemPromptSha));
  add('harness prompts recorded', noPrompt.length ? 'warn' : 'ok', noPrompt.length ? `no system prompt captured for ${noPrompt.join(', ')} (the tool sent none through the metering proxy, or the runs predate R18)` : arms.map((a) => `${a} ${records.find((r) => r.manifest.arm === a && r.manifest.systemPromptSha)!.manifest.systemPromptSha}`).join('; '));
  const hours = arms.map((a) => pilot.arms?.[a]?.tuningHours);
  if (hours.some((h) => h === undefined)) add('equal tuning effort', 'warn', `tuningHours not declared for ${arms.filter((_a, i) => hours[i] === undefined).join(', ')}`);
  else {
    const hs = hours as number[];
    const ratio = Math.max(...hs) / Math.max(1e-9, Math.min(...hs));
    add('equal tuning effort', ratio <= 1.25 ? 'ok' : 'fail', `${arms.map((a, i) => `${a} ${hs[i]}h`).join(', ')}${ratio > 1.25 ? ' (more than 25% apart)' : ''}`);
  }
  const tasks = [...new Set(records.map((r) => r.manifest.task))];
  const held = pilot.heldOut?.length ? tasks.filter((t) => pilot.heldOut!.includes(t)) : [];
  const minT = pilot.minTasks ?? 30;
  const target = pilot.targetTasks ?? 100;
  if (!pilot.heldOut?.length) add('held-out split', 'fail', 'no heldOut task list declared: every result is exploratory');
  else add('held-out tasks', held.length >= minT ? (held.length >= target ? 'ok' : 'warn') : 'fail', `${held.length} held-out task(s) ran (minimum ${minT}, target ${target}); ${tasks.length - held.length} development task(s) are reported separately`);
  const minR = pilot.minRepeats ?? 3;
  const reps = new Map<string, number>();
  for (const r of records) reps.set(`${r.manifest.task}|${r.manifest.arm}|${conditionOf(r)}`, (reps.get(`${r.manifest.task}|${r.manifest.arm}|${conditionOf(r)}`) ?? 0) + 1);
  const fewest = Math.min(...reps.values());
  add(`≥ ${minR} repeats per task × arm × condition`, fewest >= minR ? 'ok' : 'fail', `fewest repeats: ${fewest}`);
  const want = pilot.conditions ?? ['quiet', 'shared'];
  const have = new Set(records.map(conditionOf));
  const lacking = want.filter((c) => !have.has(c) || arms.some((a) => !records.some((r) => r.manifest.arm === a && conditionOf(r) === c)));
  add('contention conditions', lacking.length ? 'fail' : 'ok', lacking.length ? `missing for some arm: ${lacking.join(', ')} (tug bench --condition shared --load N)` : [...have].map((c) => `${c}${(() => { const r = records.find((x) => conditionOf(x) === c); return r?.manifest.condition?.loadClients ? ` (${r.manifest.condition.loadClients} load clients)` : ''; })()}`).join(', '));
  const unjudged = records.filter((r) => !r.acceptance.length).length;
  const hostRuns = records.filter((r) => r.manifest.isolation !== 'docker').length;
  add('judges outside the agent runtime', unjudged ? 'warn' : hostRuns ? 'warn' : 'ok', `the hidden acceptance runs in the scorer after the agent ended, against pristine protected files${hostRuns ? `; ${hostRuns} run(s) ran on the host (an unrestricted shell can reach hidden tests: prefer --isolation docker)` : '; every run was docker-isolated'}${unjudged ? `; ${unjudged} run(s) have no acceptance result` : ''}`);
  const first = Math.min(...records.map((r) => Date.parse(r.manifest.startedAt)));
  const pre = Date.parse(pilot.declaredAt) < first;
  add('target predeclared', pre ? 'ok' : 'fail', `declared ${pilot.declaredAt}; first run started ${new Date(first).toISOString()}${pilotSha ? `; pilot file sha256 ${pilotSha}` : ''}`);
  const ext = records.map((r) => r.manifest.external?.name).filter(Boolean);
  const cl = ['cline', 'cline-pinned'].filter((n) => !ext.includes(n));
  if (pilot.target.baseline.startsWith('cline') || ext.some((n) => n?.startsWith('cline'))) add('installed and pinned Cline', cl.length ? 'warn' : 'ok', cl.length ? `missing arm(s): ${cl.join(', ')}` : [...new Set(records.filter((r) => r.manifest.external?.name?.startsWith('cline')).map((r) => `${r.manifest.external!.name} ${r.manifest.external!.version ?? ''}`))].join('; '));
  return out;
}

export function compareReport(inp: CompareInput): string {
  const records = labelRecords(inp.records);
  const conds = [...new Set(records.map(conditionOf))];
  const lines: string[] = [];
  if (!inp.pilot) {
    if (conds.length < 2) return armTables({ ...inp, records });
    lines.push('# Paired comparison', '');
    for (const c of conds) lines.push(armTables({ ...inp, records: records.filter((r) => conditionOf(r) === c) }, `## Condition: ${c}`), '');
    return lines.join('\n');
  }
  const p = inp.pilot;
  lines.push(`# Pilot: ${p.name ?? 'paired comparison'}`, '', `Candidate **${p.target.candidate}** vs baseline **${p.target.baseline}**. Declared ${p.declaredAt}${inp.pilotSha ? ` (pilot file sha256 ${inp.pilotSha})` : ''}.`, '', '## Protocol checks', '', '| check | status | detail |', '|---|---|---|');
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' } as const;
  const checks = pilotChecks(records, p, inp.pilotSha);
  for (const c of checks) lines.push(`| ${c.check} | ${icon[c.status]} | ${c.detail} |`);
  const held = p.heldOut?.length ? records.filter((r) => p.heldOut!.includes(r.manifest.task)) : [];
  const dev = records.filter((r) => !held.includes(r));
  lines.push('', '## Decision (held-out tasks, per condition)', '');
  const verdicts: string[] = [];
  for (const c of conds) {
    const sub = held.filter((r) => conditionOf(r) === c);
    const { arms } = summarizeArms({ ...inp, records: sub });
    const cand = arms.find((a) => a.arm === p.target.candidate);
    const base = arms.find((a) => a.arm === p.target.baseline);
    lines.push(`### ${c}`, '');
    if (!cand || !base) {
      lines.push(`_no held-out runs of ${!cand ? p.target.candidate : p.target.baseline} under this condition_`, '');
      verdicts.push(`${c}: incomplete`);
      continue;
    }
    lines.push('| rule | result | detail |', '|---|---|---|');
    let all = true;
    for (const r of p.target.rules) {
      const e = evaluateRule(r, cand, base);
      all &&= e.pass;
      lines.push(`| ${r.metric} ${r.kind}${r.value !== undefined ? ` ${r.value}` : ''} | ${e.pass ? '✅ met' : '❌ not met'} | ${e.detail} |`);
    }
    lines.push('');
    verdicts.push(`${c}: ${all ? 'target met' : 'target not met'}`);
  }
  const protocolOk = !checks.some((c) => c.status === 'fail');
  const met = conds.length > 0 && verdicts.every((v) => v.endsWith('target met')) && (p.conditions ?? ['quiet', 'shared']).every((c) => conds.includes(c));
  lines.push(`**Verdict:** ${met && protocolOk ? `the predeclared target is met under every condition (${verdicts.join('; ')}).` : `not established: ${[...verdicts, ...(protocolOk ? [] : ['the protocol checks above have failures'])].join('; ')}.`}`, '');
  for (const c of conds) lines.push(armTables({ ...inp, baseline: p.target.baseline, records: held.filter((r) => conditionOf(r) === c) }, `## Held-out results: ${c}`), '');
  if (dev.length) lines.push(armTables({ ...inp, baseline: p.target.baseline, records: dev }, '## Development tasks (tuning set; not used for the decision)'), '');
  return lines.join('\n');
}
