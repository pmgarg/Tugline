/**
 * v1.2 N18: run a declarative workflow: map items → task template, bounded concurrency, a shared total
 * budget and per-item caps (hard reservations at the admission point, so in-flight items cannot overshoot
 * the total), optional git-worktree isolation per item, retry-once, a stall watchdog, structured output,
 * and a reduce step that receives every item's result (failed ones included).
 *
 * Each item is a child agent made by `Agent.spawnChild`, so it is narrowed to the caller (S2), inherits
 * and reports taint (SAC3), is depth-limited, and its usage merges into the caller and the ledger.
 *
 * Code fields (`command`, `script`) run only after one human approval of the whole workflow listing every
 * expanded command (SAC2), and then still go through the policy's hard denies and the sandbox wrapper.
 *
 * A run is recorded in `.tugline/workflows/runs/<runId>.jsonl` (one line per finished item), so
 * `tug workflow run … --resume <runId>` re-runs only what did not succeed, and `/workflows` lists runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, RunResult } from '../agent.js';
import type { PermissionRequest } from '../../types.js';
import { newBudgetPool } from '../../llm/admission.js';
import { noteHarnessWrite } from '../../permissions/harnessWrites.js';
import { commandWrapperFor, execCommand, scrubbedEnv } from '../../tools/shell.js';
import { capOutput, shortId, truncateLine } from '../../util/text.js';
import { parseJsonLenient } from '../../util/json.js';
import { wrapUntrusted } from '../../util/untrusted.js';
import { ChildRefusal } from './clamp.js';
import { codeFields, renderCommand, renderTemplate, type WorkflowSpec } from './spec.js';
import { workflowSettings } from './settings.js';

export type ItemStatus = 'ok' | 'failed' | 'skipped';

export interface ItemResult {
  index: number;
  item: unknown;
  status: ItemStatus;
  attempts: number;
  text: string;
  /** why it failed or was skipped */
  reason?: string;
  stopReason?: string;
  output?: Record<string, unknown>;
  branch?: string;
  startedAt?: number;
  endedAt?: number;
  tokens: number;
}

export interface WorkflowReport {
  runId: string;
  name: string;
  status: 'done' | 'partial' | 'stopped';
  stoppedBy?: string;
  items: ItemResult[];
  reduce?: { text: string; status: ItemStatus; reason?: string };
  /** the most items that were in flight at once */
  maxInFlight: number;
  /** one line per failed item (who failed and how) */
  failureLines: string[];
  tokens: number;
  runFile?: string;
}

export interface WorkflowOptions {
  /** re-run only the items of an earlier run that did not succeed */
  resume?: string;
  /** progress lines (CLI) */
  onProgress?: (line: string) => void;
}

/** Remove terminal escape sequences and bidi/control characters from model text shown in reports (Trojan Source). */
export function sanitizeText(s: string): string {
  return String(s ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[‪-‮⁦-⁩‎‏]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function runsDir(workspace: string): string {
  return path.join(workspace, '.tugline', 'workflows', 'runs');
}

/** Item results recorded for a run (for resume and /workflows). */
export function readRun(workspace: string, runId: string): { meta?: Record<string, unknown>; items: ItemResult[] } {
  if (!/^wf_[A-Za-z0-9]+$/.test(runId)) throw new ChildRefusal('invalid_spec', `not a workflow run id: ${runId}`);
  const f = path.join(runsDir(workspace), `${runId}.jsonl`);
  if (!fs.existsSync(f)) throw new ChildRefusal('invalid_spec', `no recorded workflow run ${runId}`);
  const items = new Map<number, ItemResult>();
  let meta: Record<string, unknown> | undefined;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r.type === 'start') meta = r;
      if (r.type === 'item') items.set(r.result.index, r.result);
      if (r.type === 'end') meta = { ...meta, end: r };
    } catch {
      /* torn line */
    }
  }
  return { meta, items: [...items.values()] };
}

export function listRuns(workspace: string): { runId: string; name: string; status: string; items: number; ok: number; ts: string }[] {
  const d = runsDir(workspace);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const id = f.slice(0, -6);
      const r = readRun(workspace, id);
      const end = (r.meta?.end ?? {}) as Record<string, unknown>;
      return { runId: id, name: String(r.meta?.name ?? '?'), status: String(end.status ?? 'running or interrupted'), items: Number(r.meta?.total ?? r.items.length), ok: r.items.filter((i) => i.status === 'ok').length, ts: String(r.meta?.ts ?? '') };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Check a structured output: a JSON object (possibly fenced) with the required keys. */
export function structuredOutput(text: string, required: string[]): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const body = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const p = parseJsonLenient(body || text);
  if (!p.ok || !p.value || typeof p.value !== 'object' || Array.isArray(p.value)) return { ok: false, reason: 'the final answer is not a JSON object' };
  const missing = required.filter((k) => !(k in (p.value as object)));
  return missing.length ? { ok: false, reason: `the JSON answer lacks ${missing.join(', ')}` } : { ok: true, value: p.value as Record<string, unknown> };
}

async function approveCode(agent: Agent, spec: WorkflowSpec): Promise<void> {
  const code = codeFields(spec);
  if (!code.length) return;
  const ask = agent.opts.ui?.requestPermission;
  const detail = code.map((c) => `${c.where}: ${c.command}`).join('\n');
  const request: PermissionRequest = { id: shortId('wf_'), tool: 'workflow_run', kind: 'execute', title: `Run workflow "${spec.name}" (${spec.items.length} items, ${code.length} command(s))`, detail, reason: `the workflow runs these commands; approving it approves all of them, once, for this run` };
  const answer = ask ? await ask(request) : { decision: 'deny' as const, feedback: 'no user is available to approve the workflow commands' };
  agent.journalWrite({ type: 'workflow_approval', name: spec.name, commands: code, decision: answer.decision });
  agent.emitEvent({ type: 'permission', request, answer, auto: false });
  if (answer.decision !== 'allow') throw new ChildRefusal('not_approved', `workflow "${spec.name}" has ${code.length} command(s) and they were not approved${'feedback' in answer && answer.feedback ? ` (${answer.feedback})` : ''}: nothing ran`);
}

async function runCode(agent: Agent, command: string, cwd: string, signal?: AbortSignal): Promise<{ ok: boolean; out: string }> {
  // the human approved the workflow, but hard denies (protected paths, managed deny rules) still win
  const d = agent.policy.check({ tool: 'bash', kind: 'execute', command, cwd });
  if (d.decision === 'deny') {
    agent.journalWrite({ type: 'refusal', tool: 'workflow_run', reason: d.reason, command });
    return { ok: false, out: `refused: ${d.reason}` };
  }
  const r = await execCommand({ shellCommand: command, cwd, timeoutMs: 300_000, env: scrubbedEnv(agent.config.shell.scrubEnv), signal, wrap: commandWrapperFor(agent.config) });
  return { ok: !r.timedOut && r.exitCode === 0, out: capOutput(r.output.trimEnd(), 4000) };
}

export async function runWorkflow(agent: Agent, spec: WorkflowSpec, o: WorkflowOptions = {}): Promise<WorkflowReport> {
  const s = workflowSettings(agent.config);
  if (spec.items.length > s.maxItems) throw new ChildRefusal('workflow_too_large', `workflow "${spec.name}" has ${spec.items.length} items; workflow.maxItems is ${s.maxItems}`);
  await approveCode(agent, spec);
  const runId = shortId('wf_').replace(/[^A-Za-z0-9_]/g, '');
  const say = o.onProgress ?? (() => {});
  const previous = o.resume ? new Map(readRun(agent.workspace, o.resume).items.filter((i) => i.status === 'ok').map((i) => [i.index, i])) : new Map<number, ItemResult>();
  fs.mkdirSync(runsDir(agent.workspace), { recursive: true });
  const runFile = path.join(runsDir(agent.workspace), `${runId}.jsonl`);
  const record = (r: Record<string, unknown>) => {
    fs.appendFileSync(runFile, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n');
    noteHarnessWrite(runFile); // R1: a harness write to an agent-control path, adopted by the guard
  };
  record({ type: 'start', name: spec.name, total: spec.items.length, resumedFrom: o.resume });
  const total = newBudgetPool(`workflow "${spec.name}" total`, spec.budget?.total ?? {});
  const concurrency = Math.max(1, Math.min(spec.concurrency ?? 4, s.maxConcurrency));
  const retries = spec.retry ?? 1;
  const timeoutMs = spec.timeoutMs ?? s.itemTimeoutMs;
  const stallMs = spec.stallMs ?? s.stallMs;
  agent.journalWrite({ type: 'workflow_start', runId, name: spec.name, items: spec.items.length, concurrency, budget: spec.budget ?? {} });
  agent.emitEvent({ type: 'workflow', runId, name: spec.name, phase: 'start', counts: { done: 0, failed: 0, total: spec.items.length } });
  let inFlight = 0;
  let maxInFlight = 0;
  let stoppedBy: string | undefined;
  const results: ItemResult[] = new Array(spec.items.length);
  const counts = { done: 0, failed: 0, total: spec.items.length };
  const signal = agent.abortSignal;

  const runItem = async (item: unknown, index: number): Promise<ItemResult> => {
    const prior = previous.get(index);
    if (prior) return { ...prior, reason: `kept from run ${o.resume}` };
    const base: ItemResult = { index, item, status: 'skipped', attempts: 0, text: '', tokens: 0 };
    if (stoppedBy || signal?.aborted) return { ...base, reason: stoppedBy ?? 'cancelled' };
    let last: ItemResult = base;
    for (let attempt = 1; attempt <= 1 + retries; attempt++) {
      if (stoppedBy || signal?.aborted) return { ...last, status: last.attempts ? last.status : 'skipped', reason: last.reason ?? stoppedBy ?? 'cancelled' };
      const startedAt = Date.now();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      let child: Agent | undefined;
      let timer: NodeJS.Timeout | undefined;
      let stallTimer: NodeJS.Timeout | undefined;
      let stalled = false;
      try {
        // stall watchdog (ported idea, Qwen workflow-stall): progress resets it; it is suspended while a tool runs
        let toolsRunning = 0;
        const arm = () => {
          clearTimeout(stallTimer);
          if (toolsRunning > 0) return;
          stallTimer = setTimeout(() => {
            stalled = true;
            child?.abort();
          }, stallMs);
        };
        const progress = (e: import('../../types.js').AgentEvent) => {
          if (e.type === 'tool_start') toolsRunning++;
          if (e.type === 'tool_end') toolsRunning = Math.max(0, toolsRunning - 1);
          arm();
        };
        const spawned = await agent.spawnChild({
          agentType: spec.task.agentType ?? 'general',
          description: `${spec.name} item ${index + 1}`,
          label: `${spec.name}#${index + 1}`,
          tools: spec.task.tools,
          mode: spec.task.mode,
          roots: spec.task.roots,
          domains: spec.task.domains,
          profile: spec.task.profile,
          mcpServers: spec.task.mcpServers,
          hooks: spec.task.hooks,
          sandbox: spec.task.sandbox,
          isolation: spec.task.isolation,
          maxTurns: spec.task.maxTurns,
          budget: spec.budget?.perItem,
          pools: [total],
          onEvent: progress,
        });
        child = spawned.agent;
        arm();
        const c = child;
        let timedOut = false;
        timer = setTimeout(() => {
          timedOut = true;
          c.abort();
        }, timeoutMs);
        const onAbort = () => c.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        let r: RunResult;
        try {
          r = await c.run(renderTemplate(spec.task.prompt, item, index) + (spec.task.output ? `\n\nEnd your final answer with a JSON object with the keys ${spec.task.output.required.join(', ')}.` : ''));
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        agent.mergeChildStats(c, r);
        const tokens = r.stats.promptTokens + r.stats.completionTokens;
        let status: ItemStatus = r.stopReason === 'end_turn' ? 'ok' : 'failed';
        let reason = status === 'ok' ? undefined : stalled ? `stalled: no progress for ${stallMs} ms` : timedOut ? `timed out after ${timeoutMs} ms` : `stopped: ${r.stopReason}`;
        let output: Record<string, unknown> | undefined;
        if (status === 'ok' && spec.task.output) {
          const so = structuredOutput(r.finalText, spec.task.output.required);
          if (so.ok) output = so.value;
          else [status, reason] = ['failed', so.reason];
        }
        for (const code of [spec.task.command, spec.task.script]) {
          if (status !== 'ok' || !code) continue;
          const res = await runCode(agent, renderCommand(code, item, index), c.workspace, signal);
          if (!res.ok) [status, reason] = ['failed', `check failed: ${truncateLine(res.out, 300)}`];
        }
        let branch: string | undefined;
        let text = sanitizeText(r.finalText);
        if (spawned.worktree) {
          const note = await agent.collectWorktree(spawned.worktree, `${spec.name} item ${index + 1} (Tugline workflow)`);
          branch = note.match(/branch (oh\/\S+?)[\s)]/)?.[1];
          text += note;
        }
        last = { index, item, status, attempts: attempt, text, reason, stopReason: r.stopReason, output, branch, startedAt, endedAt: Date.now(), tokens };
        if (r.stopReason === 'budget') stoppedBy ??= `budget: ${truncateLine(r.finalText, 200)}`;
      } catch (e) {
        last = { index, item, status: 'failed', attempts: attempt, text: '', reason: (e as Error).message, startedAt, endedAt: Date.now(), tokens: 0 };
        if (e instanceof ChildRefusal) stoppedBy ??= (e as Error).message;
      } finally {
        clearTimeout(timer);
        clearTimeout(stallTimer);
        inFlight--;
      }
      agent.emitEvent({ type: 'workflow', runId, name: spec.name, phase: 'item', index, status: last.status, attempt, detail: last.reason });
      if (last.status === 'ok' || stoppedBy) break;
      say(`item ${index + 1} attempt ${attempt} failed: ${last.reason}${attempt <= retries ? ' (retrying once)' : ''}`);
    }
    return last;
  };

  const queue = spec.items.map((x, i) => [x, i] as const);
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const [item, i] = queue[next++]!;
      const r = await runItem(item, i);
      results[i] = r;
      if (r.status === 'ok') counts.done++;
      else counts.failed++;
      record({ type: 'item', result: r });
      agent.journalWrite({ type: 'workflow_item', runId, index: i, status: r.status, attempts: r.attempts, reason: r.reason, branch: r.branch });
      say(`[${counts.done + counts.failed}/${counts.total}] item ${i + 1}: ${r.status}${r.reason ? ` (${truncateLine(r.reason, 120)})` : ''}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  let reduce: WorkflowReport['reduce'];
  if (spec.reduce && !signal?.aborted) {
    const data = results.map((r) => ({ index: r.index + 1, item: r.item, status: r.status, reason: r.reason, output: r.output, text: r.text.slice(0, 4000), branch: r.branch }));
    // item results are agent output: handed to the reducer as data
    const prompt = `${spec.reduce.prompt}\n\nThe results of all ${data.length} items (failed and skipped ones included) are below, as data:\n${wrapUntrusted('workflow_results', { workflow: spec.name }, JSON.stringify(data, null, 2))}`;
    try {
      const spawned = await agent.spawnChild({ agentType: spec.reduce.agentType ?? 'general', description: `${spec.name} reduce`, label: `${spec.name}#reduce`, pools: [total] });
      const r = await spawned.agent.run(prompt);
      agent.mergeChildStats(spawned.agent, r);
      reduce = { text: sanitizeText(r.finalText), status: r.stopReason === 'end_turn' ? 'ok' : 'failed', reason: r.stopReason === 'end_turn' ? undefined : r.stopReason };
      for (const code of [spec.reduce.command, spec.reduce.script]) {
        if (!code || reduce.status !== 'ok') continue;
        const res = await runCode(agent, code, agent.workspace, signal);
        if (!res.ok) reduce = { ...reduce, status: 'failed', reason: `reduce check failed: ${truncateLine(res.out, 300)}` };
        else reduce.text += `\n${res.out}`;
      }
    } catch (e) {
      reduce = { text: '', status: 'failed', reason: (e as Error).message };
    }
    agent.emitEvent({ type: 'workflow', runId, name: spec.name, phase: 'reduce', status: reduce.status, detail: reduce.reason });
  }
  const failureLines = results.filter((r) => r.status !== 'ok').map((r) => `item ${r.index + 1} (${truncateLine(typeof r.item === 'string' ? r.item : JSON.stringify(r.item), 60)}): ${r.status} after ${r.attempts} attempt(s): ${truncateLine(r.reason ?? '', 200)}`);
  const status: WorkflowReport['status'] = stoppedBy || signal?.aborted ? 'stopped' : counts.failed ? 'partial' : 'done';
  const report: WorkflowReport = { runId, name: spec.name, status, stoppedBy, items: results, reduce, maxInFlight, failureLines, tokens: total.used.tokens, runFile };
  record({ type: 'end', status, stoppedBy, done: counts.done, failed: counts.failed });
  agent.journalWrite({ type: 'workflow_end', runId, name: spec.name, status, stoppedBy, done: counts.done, failed: counts.failed, tokens: total.used.tokens });
  agent.emitEvent({ type: 'workflow', runId, name: spec.name, phase: 'end', status, detail: stoppedBy, counts });
  return report;
}

/** The report as the text a model (or the CLI) reads. */
export function formatReport(r: WorkflowReport): string {
  const lines = [`Workflow "${r.name}" (${r.runId}): ${r.status}${r.stoppedBy ? ` (${r.stoppedBy})` : ''}. ${r.items.filter((i) => i.status === 'ok').length}/${r.items.length} items ok, at most ${r.maxInFlight} at once, ${r.tokens} tokens.`];
  for (const i of r.items) lines.push(`- item ${i.index + 1}: ${i.status}${i.attempts > 1 ? ` (${i.attempts} attempts)` : ''}${i.reason ? `: ${truncateLine(i.reason, 160)}` : ''}${i.branch ? ` [branch ${i.branch}]` : ''}${i.status === 'ok' ? `\n  ${truncateLine(i.text.replace(/\s+/g, ' '), 300)}` : ''}`);
  if (r.failureLines.length) lines.push('', 'Failures:', ...r.failureLines.map((l) => `- ${l}`));
  if (r.reduce) lines.push('', `Reduce: ${r.reduce.status}${r.reduce.reason ? ` (${r.reduce.reason})` : ''}`, r.reduce.text);
  lines.push('', `Resume what did not succeed with: tug workflow run <file> --resume ${r.runId}`);
  return lines.join('\n');
}
