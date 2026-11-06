/**
 * WS4 slash commands (SPEC D13), registered through the S0.6 registry so the
 * CLI, VS Code and server mode share them: /context, /goal, /jobs, /memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { contextBreakdown, formatBreakdown } from './breakdown.js';
import { parseGoalArgs, runGoal } from './goal.js';
import { describeJob, getJob, jobVisibleTo, killJob, listJobs, readJobLog } from '../jobs/manager.js';
import { addMemory, listMemories, memoryFile } from '../memory/memory.js';

registerSlashCommand({
  name: 'context',
  description: 'show what fills the context window (system prompt, tools, history, attachments)',
  run(_args, ctx) {
    const a = ctx.agent;
    ctx.write(formatBreakdown(contextBreakdown({ systemPrompt: () => a.systemPrompt(), toolSpecs: () => a.toolSpecs(), messages: a.messages, llm: a.llm, config: ctx.config, deferredToolCount: a.deferredToolNames?.().length ?? 0 })));
  },
});

/** N35: the goal of each agent (for /goal status|pause|resume|clear). Resume after a restart reads the journal. */
const goals = new WeakMap<object, { condition: string; args: ReturnType<typeof parseGoalArgs>; signal: { paused?: boolean }; status: string; label?: string; reason?: string; running: boolean }>();

function lastGoalFromJournal(file: string | undefined): ReturnType<typeof parseGoalArgs> | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  let found: ReturnType<typeof parseGoalArgs> | undefined;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.includes('"type":"goal"')) continue;
    try {
      const r = JSON.parse(l);
      if (r.phase === 'start') found = { condition: r.condition, check: r.check, maxTurns: r.maxTurns, maxTokens: r.maxTokens, ...(r.verify && r.check ? { verify: true } : {}) };
      if (r.phase === 'end' && r.status === 'met') found = undefined;
    } catch {
      /* torn line */
    }
  }
  return found;
}

registerSlashCommand({
  name: 'goal',
  usage: '<condition> [--check "<command>"] [--verify] [--max-turns N] [--max-tokens N] | status | pause | resume | clear',
  description: 'keep working until the goal is met: a check command decides ("verified"), or without --check an independent verifier judges it ("judged met")',
  async run(args, ctx) {
    const sub = args.trim();
    const cur = goals.get(ctx.agent);
    if (sub === 'status') return void ctx.write(cur ? `  [goal] ${cur.condition} — ${cur.running ? 'running' : cur.status}${cur.label ? ` (${cur.label})` : ''}${cur.reason ? `: ${cur.reason}` : ''}` : '  no goal');
    if (sub === 'pause') {
      if (!cur?.running) return void ctx.write('  no running goal');
      cur.signal.paused = true;
      return void ctx.write('  [goal] pausing after the current iteration');
    }
    if (sub === 'clear') {
      if (cur) cur.signal.paused = true;
      goals.delete(ctx.agent);
      ctx.agent.journalWrite?.({ type: 'goal', phase: 'end', condition: cur?.condition ?? '', status: 'cleared', label: 'not met' });
      return void ctx.write('  [goal] cleared');
    }
    let g = sub === 'resume' ? (cur ? cur.args : lastGoalFromJournal(ctx.agent.journalFile)) : parseGoalArgs(args);
    if (sub === 'resume' && !g) return void ctx.write('  no goal to resume');
    if (!g?.condition) {
      ctx.write('usage: /goal <condition> [--check "<command>"] [--verify] [--max-turns N] [--max-tokens N] | status | pause | resume | clear');
      return;
    }
    const state = { condition: g.condition, args: g, signal: {}, status: 'running', running: true } as NonNullable<ReturnType<typeof goals.get>>;
    goals.set(ctx.agent, state);
    try {
      const r = await runGoal(ctx.agent, g.condition, { check: g.check, verify: g.verify, maxTurns: g.maxTurns, maxTokens: g.maxTokens, signal: state.signal, onProgress: (m) => ctx.write(`  [goal] ${m}`) });
      Object.assign(state, { status: r.status, label: r.label, reason: r.reason, running: false });
      ctx.write(`  [goal] ${r.status} after ${r.iterations} iteration(s)${r.status === 'stopped' ? ` (${r.stopReason})` : ''}${r.lastCheck ? `; last check exit ${r.lastCheck.exitCode}` : ''} — ${r.label}${r.reason ? ` (${r.reason})` : ''}`);
      if (r.verdict?.evidence.length) ctx.write(`  [goal] evidence: ${r.verdict.evidence.map((e) => `${e.file}:${e.line}`).join(', ')}`);
      if (r.verdict && !r.verdict.met && r.verdict.reasons.length) ctx.write(`  [goal] verifier reasons: ${r.verdict.reasons.join(' | ')}`);
    } catch (e) {
      Object.assign(state, { status: 'error', reason: (e as Error).message, running: false });
      ctx.write(`  [goal] error: ${(e as Error).message}`);
    }
  },
});

/** N35: `tug goal "<condition>" [--check CMD] [--verify] [--max-turns N] [--max-tokens N] [--json]`, headless. */
registerCliCommand({
  name: 'goal',
  description: 'work toward a goal headless until a check passes ("verified") or the independent verifier judges it met',
  usage: '"<condition>" [--check "<command>"] [--verify] [--max-turns N] [--max-tokens N] [--json]',
  needsModel: true,
  async run(argv, ctx) {
    const json = argv.includes('--json');
    const g = parseGoalArgs(argv.filter((x) => x !== '--json').map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' '));
    if (!g.condition) {
      ctx.write('usage: tug goal "<condition>" [--check "<command>"] [--verify] [--max-turns N] [--max-tokens N] [--json]');
      return 2;
    }
    const { Agent, bundledDirs } = await import('../agent/agent.js');
    const d = bundledDirs(new URL(import.meta.url).pathname);
    const agent = await Agent.create({ workspace: ctx.workspace, config: ctx.config, surface: 'terminal (tug goal)', bundledSkillsDir: d.skills, bundledAgentsDir: d.agents });
    try {
      const r = await runGoal(agent, g.condition, { check: g.check, verify: g.verify, maxTurns: g.maxTurns, maxTokens: g.maxTokens, onProgress: (m) => ctx.write(`[goal] ${m}`) });
      ctx.write(json ? JSON.stringify({ status: r.status, label: r.label, reason: r.reason, iterations: r.iterations, verdict: r.verdict, lastCheck: r.lastCheck, tokens: agent.totals.promptTokens + agent.totals.completionTokens }, null, 2) : `[goal] ${r.status} after ${r.iterations} iteration(s) — ${r.label}${r.reason ? ` (${r.reason})` : ''}`);
      return r.status === 'met' ? 0 : 1;
    } finally {
      await agent.dispose();
    }
  },
});

registerSlashCommand({
  name: 'jobs',
  usage: '[log <id> | kill <id>]',
  description: 'list background jobs of this session, show a log, or kill one',
  async run(args, ctx) {
    const [sub, id] = args.trim().split(/\s+/);
    const sessionId: string = ctx.agent.sessionId;
    if ((sub === 'log' || sub === 'kill') && id) {
      const j = getJob(id);
      if (!j || !jobVisibleTo(j, sessionId)) return void ctx.write(`no job ${id}`);
      if (sub === 'kill') {
        await killJob(j);
        return void ctx.write(`killed ${j.id}`);
      }
      return void ctx.write(`${describeJob(j)}\n${readJobLog(j, { tail: 40 }).text.trimEnd() || '(no output)'}`);
    }
    const js = listJobs().filter((j) => jobVisibleTo(j, sessionId));
    ctx.write(js.length ? js.map((j) => `  ${describeJob(j)}`).join('\n') : '  no background jobs');
  },
});

registerSlashCommand({
  name: 'memory',
  usage: '[add [--user] <text>]',
  description: 'show project and user memory, or add a memory yourself',
  run(args, ctx) {
    const m = args.trim().match(/^add\s+(--user\s+)?([\s\S]+)$/);
    if (m) {
      const scope = m[1] ? 'user' : 'project';
      const r = addMemory(memoryFile(scope, ctx.workspace, ctx.config.homeDir), { kind: 'fact', key: '', text: m[2] });
      return void ctx.write(`  saved (${scope}): ${r.line}${r.superseded.length ? `\n  superseded: ${r.superseded.length}` : ''}`);
    }
    const out: string[] = [];
    for (const scope of ['project', 'user'] as const) {
      const f = memoryFile(scope, ctx.workspace, ctx.config.homeDir);
      const items = listMemories(f);
      out.push(`${scope} memory (${scope === 'project' ? path.relative(ctx.workspace, f) : f}): ${items.filter((x) => !x.superseded).length} active, ${items.filter((x) => x.superseded).length} superseded`);
      for (const x of items.filter((y) => !y.superseded)) out.push(`  - [${x.kind}] ${x.key}: ${x.text}`);
    }
    ctx.write(out.join('\n'));
  },
});
