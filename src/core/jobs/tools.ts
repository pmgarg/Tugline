/**
 * Model-facing tools for background jobs (SPEC D5): job_output, job_kill,
 * monitor. They are registered only when `agent.backgroundJobs` is on, and the
 * agent keeps them out of the tool list until a background job is started
 * (bash activates them), so they cost no prompt tokens otherwise.
 */
import { registerToolProvider } from '../tools/registry.js';
import { ToolError, type ToolContext, type ToolDef } from '../tools/types.js';
import { coreSettings } from '../context/settings.js';
import { describeJob, getJob, jobVisibleTo, killJob, monitorJob, readJobLog, type Job } from './manager.js';

function jobFor(id: unknown, ctx: ToolContext): Job {
  const j = getJob(String(id ?? ''));
  if (!j || !jobVisibleTo(j, ctx.sessionId)) throw new ToolError(`no background job "${id}" in this session`);
  return j;
}

export const jobOutputTool: ToolDef<{ job_id: string; tail?: number; since?: number }> = {
  name: 'job_output',
  kind: 'read',
  readOnly: true,
  description: 'Read the output of a background job started with bash run_in_background. Use `tail` for the last N lines, or `since` (the `next` offset from a previous call) to get only new output.',
  parameters: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      tail: { type: 'integer', description: 'Only the last N lines' },
      since: { type: 'integer', description: 'Byte offset returned as next by an earlier call' },
    },
    required: ['job_id'],
  },
  title: (a) => `Job output ${a.job_id}`,
  async run(a, ctx) {
    const j = jobFor(a.job_id, ctx);
    const r = readJobLog(j, { since: a.since, tail: a.tail });
    // R2: an exited job reports its real exit code, so its result can count as verification evidence
    return { output: `${describeJob(j)}\n${r.text.trimEnd() || '(no new output)'}\n[next: ${r.next}]`, meta: j.status === 'exited' && typeof j.exitCode === 'number' ? { jobResult: { command: j.command, exitCode: j.exitCode, startedAt: j.startedAt } } : undefined };
  },
};

export const jobKillTool: ToolDef<{ job_id: string }> = {
  name: 'job_kill',
  kind: 'meta',
  description: 'Stop a background job (its whole process group).',
  parameters: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
  title: (a) => `Kill job ${a.job_id}`,
  async run(a, ctx) {
    const j = jobFor(a.job_id, ctx);
    const was = j.status;
    await killJob(j);
    ctx.emit({ type: 'job', jobId: j.id, phase: 'end', command: j.command, exitCode: j.exitCode ?? null, text: 'killed' });
    return { output: was === 'running' ? `Killed ${j.id} ($ ${j.command}).` : `${j.id} had already ${j.status} (exit ${j.exitCode ?? '?'}).` };
  },
};

export const monitorTool: ToolDef<{ job_id: string; pattern: string; timeout_ms?: number; since?: number }> = {
  name: 'monitor',
  kind: 'read',
  readOnly: true,
  description: 'Wait until a regex appears in a background job\'s output (e.g. "Serving|listening on"), the job exits, or the timeout passes. Returns the matching lines. Use it instead of sleep loops.',
  parameters: {
    type: 'object',
    properties: {
      job_id: { type: 'string' },
      pattern: { type: 'string', description: 'JavaScript regular expression, matched per line' },
      timeout_ms: { type: 'integer', description: 'Default 30000, max 600000' },
      since: { type: 'integer', description: 'Only look at output after this byte offset' },
    },
    required: ['job_id', 'pattern'],
  },
  title: (a) => `Monitor ${a.job_id} for /${a.pattern}/`,
  async run(a, ctx) {
    const j = jobFor(a.job_id, ctx);
    let re: RegExp;
    try {
      re = new RegExp(String(a.pattern));
    } catch (e) {
      throw new ToolError(`invalid regex: ${(e as Error).message}`);
    }
    const timeoutMs = Math.max(100, Math.min(Number(a.timeout_ms) || 30_000, 600_000));
    const r = await monitorJob(j, re, { timeoutMs, since: a.since, signal: ctx.signal });
    if (r.matched) return { output: `Matched /${a.pattern}/ in ${j.id}:\n${r.lines.join('\n')}\n[next: ${r.next}]` };
    const tail = readJobLog(j, { tail: 15 }).text.trimEnd();
    const why = r.reason === 'exited' ? `the job exited (code ${j.exitCode ?? '?'}) before /${a.pattern}/ appeared` : r.reason === 'aborted' ? 'cancelled' : `/${a.pattern}/ did not appear within ${timeoutMs} ms (job still ${j.status})`;
    return { output: `No match: ${why}.\nLast output:\n${tail || '(none)'}\n[next: ${r.next}]` };
  },
};

export { JOB_TOOL_NAMES } from './manager.js';

registerToolProvider({
  id: 'ws4-jobs',
  tools: (cfg) => (coreSettings(cfg).backgroundJobs ? [jobOutputTool, jobKillTool, monitorTool] : []),
});
