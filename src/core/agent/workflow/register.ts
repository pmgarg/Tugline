/**
 * v1.2 N18 surfaces: the `workflow_run` tool, `tug workflow run|list|show`, and `/workflows`.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { Agent, AgentUI } from '../agent.js';
import type { AgentEvent, PermissionAnswer, PermissionRequest } from '../../types.js';
import { registerToolProvider } from '../../tools/registry.js';
import { ToolError, type ToolDef } from '../../tools/types.js';
import { registerCliCommand, registerSlashCommand } from '../../commands.js';
import { agentForSession } from '../team/registry.js';
import { listSavedWorkflows, parseWorkflowSpec, resolveWorkflow } from './spec.js';
import { formatReport, listRuns, readRun, runWorkflow } from './runner.js';

export const workflowRunTool: ToolDef<{ spec?: unknown; name?: string }> = {
  name: 'workflow_run',
  kind: 'meta',
  description:
    'Fan out one task over many items with a declarative workflow (JSON data, not code). Each item runs as a subagent with a fresh context, narrowed to your tools and mode. ' +
    'spec: {"name","items":[...],"task":{"prompt":"... {{item}} ...","agentType"?,"tools"?,"isolation"?:"worktree","output"?:{"required":[keys]}},"concurrency"?:4,"budget"?:{"total"?:{"maxTokens"},"perItem"?:{"maxTokens"}},"retry"?:1,"reduce"?:{"prompt"}}. ' +
    'Or name: a saved workflow in .tugline/workflows/<name>.json. Failed items are retried once; the reduce step receives every result. Commands (task.command, reduce.command) need the user\'s approval of the whole workflow.',
  parameters: { type: 'object', properties: { spec: { type: 'object', description: 'the workflow spec' }, name: { type: 'string', description: 'a saved workflow name instead of spec' } } },
  title: (a) => `Workflow ${a.name ?? (a.spec as { name?: string } | undefined)?.name ?? ''}`,
  async run(a, ctx) {
    const agent = agentForSession(ctx.sessionId);
    if (!agent) throw new ToolError('workflows are not available in this context');
    const spec = a.name ? resolveWorkflow(String(a.name), ctx.workspace, ctx.config.homeDir).spec : parseWorkflowSpec(a.spec);
    const r = await runWorkflow(agent, spec);
    return { output: formatReport(r), meta: { workflow: { runId: r.runId, status: r.status } } };
  },
};

/** v1.2 N18 (Qwen task_stop): stop one background subagent; its partial report stays collectable. */
export const taskStopTool: ToolDef<{ handle: string }> = {
  name: 'task_stop',
  kind: 'meta',
  description: 'Stop a background subagent started with run_in_background (by its handle). task_result then returns what it had.',
  parameters: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
  title: (a) => `Stop ${a.handle}`,
  async run(a, ctx) {
    const agent = agentForSession(ctx.sessionId);
    const t = agent?.backgroundTasks.get(String(a.handle));
    if (!agent || !t) throw new ToolError(`no background subagent ${a.handle}`);
    if (t.status !== 'running') return { output: `${a.handle} already ${t.status}` };
    agent.backgroundStops.get(String(a.handle))?.();
    await t.promise.catch(() => undefined);
    agent.journalWrite({ type: 'task_stop', handle: a.handle });
    return { output: `stopped ${a.handle}; call task_result for its partial report` };
  },
};

/** v1.2 N18: resume a background subagent of this session after a restart (journal and state verified, caps re-clamped). */
export const taskResumeTool: ToolDef<{ handle: string }> = {
  name: 'task_resume',
  kind: 'meta',
  description: 'Resume a background subagent of this session that was interrupted (e.g. by a restart). It continues with its earlier conversation, never with more authority than you have now.',
  parameters: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
  title: (a) => `Resume ${a.handle}`,
  async run(a, ctx) {
    const agent = agentForSession(ctx.sessionId);
    if (!agent) throw new ToolError('not available in this context');
    return { output: await agent.resumeBackground(String(a.handle)), meta: { activateTools: ['task_result', 'task_stop'] } };
  },
};

registerToolProvider({ id: 'ws17-workflow', tools: () => [workflowRunTool, taskStopTool, taskResumeTool] });

registerSlashCommand({
  name: 'tasks',
  usage: '[resume <handle>]',
  description: 'background subagents of this session: running ones, and interrupted ones you can resume',
  async run(args, ctx) {
    const a = ctx.agent as Agent;
    const [sub, h] = args.trim().split(/\s+/);
    if (sub === 'resume' && h) {
      try {
        return void ctx.write(`  ${await a.resumeBackground(h)}`);
      } catch (e) {
        return void ctx.write(`  ${(e as Error).message}`);
      }
    }
    const live = [...a.backgroundTasks.values()].map((t) => `  ${t.handle} [${t.status}] ${t.agentType}: ${t.description}`);
    const resumable = a.resumableBackground().map((r) => `  ${r.handle} [${r.status}, resumable] ${r.description}  (/tasks resume ${r.handle})`);
    ctx.write([...live, ...resumable].join('\n') || '  no background subagents');
  },
});

/** A terminal approval prompt for CLI subcommands (fail closed without a TTY). */
export function terminalApprovals(write: (t: string) => void): AgentUI {
  const ask = async (q: string): Promise<string> => {
    if (!process.stdin.isTTY) return '';
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  };
  return {
    onEvent: (e: AgentEvent) => {
      if (e.type === 'notice' && e.level !== 'info') write(`  [${e.level}] ${e.message}`);
      if (e.type === 'team' && e.phase === 'message' && e.message) write(`  [team] ${e.message.from} → ${e.message.to}: ${e.message.text.slice(0, 160)}`);
      if (e.type === 'team' && e.phase === 'task' && e.task) write(`  [team] task ${e.task.id} ${e.task.status}${e.task.owner ? ` (${e.task.owner})` : ''}: ${e.task.title}`);
    },
    requestPermission: async (r: PermissionRequest): Promise<PermissionAnswer> => {
      if (!process.stdin.isTTY) return { decision: 'deny', feedback: 'no terminal to ask (run interactively to approve)' };
      const a = await ask(`\n${r.title}\n${r.detail ? `${r.detail}\n` : ''}reason: ${r.reason}\nAllow? [y/N] `);
      return /^y/i.test(a.trim()) ? { decision: 'allow' } : { decision: 'deny', feedback: 'denied in the terminal' };
    },
    askUser: async (q, o) => ask(`${q}${o?.length ? ` [${o.join('/')}]` : ''} `),
  };
}

async function headlessAgent(ctx: { config: any; workspace: string; write: (t: string) => void }): Promise<Agent> {
  const { Agent: A, bundledDirs } = await import('../agent.js');
  const d = bundledDirs(new URL(import.meta.url).pathname);
  return A.create({ workspace: ctx.workspace, config: ctx.config, surface: 'terminal (tug workflow)', bundledSkillsDir: d.skills, bundledAgentsDir: d.agents, ui: terminalApprovals(ctx.write) });
}

registerCliCommand({
  name: 'workflow',
  description: 'run a declarative workflow (fan-out of subagents over items), list runs, or show one',
  usage: 'run <file.json|name> [--resume <runId>] [--json] | list | show <runId>',
  needsModel: true,
  async run(argv, ctx) {
    const [sub, ref] = argv;
    if (sub === 'list') {
      const saved = listSavedWorkflows(ctx.workspace, ctx.config.homeDir);
      ctx.write(saved.length ? `Saved workflows:\n${saved.map((s) => `  ${s.name}  ${s.file}`).join('\n')}` : 'No saved workflows (.tugline/workflows/<name>.json).');
      const runs = listRuns(ctx.workspace);
      ctx.write(runs.length ? `Runs:\n${runs.map((r) => `  ${r.runId}  ${r.name}  ${r.status}  ${r.ok}/${r.items} ok  ${r.ts}`).join('\n')}` : 'No workflow runs yet.');
      return 0;
    }
    if (sub === 'show' && ref) {
      const r = readRun(ctx.workspace, ref);
      ctx.write(JSON.stringify(r, null, 2));
      return 0;
    }
    if (sub !== 'run' || !ref) {
      ctx.write('usage: tug workflow run <file.json|name> [--resume <runId>] [--json] | list | show <runId>');
      return 2;
    }
    const resume = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : undefined;
    let spec;
    try {
      spec = fs.existsSync(path.resolve(ctx.workspace, ref)) ? parseWorkflowSpec(fs.readFileSync(path.resolve(ctx.workspace, ref), 'utf8')) : resolveWorkflow(ref, ctx.workspace, ctx.config.homeDir).spec;
    } catch (e) {
      ctx.write(`workflow: ${(e as Error).message}`);
      return 2;
    }
    const agent = await headlessAgent(ctx);
    try {
      const r = await runWorkflow(agent, spec, { resume, onProgress: (l) => ctx.write(`  ${l}`) });
      ctx.write(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return r.status === 'done' ? 0 : 1;
    } catch (e) {
      ctx.write(`workflow: ${(e as Error).message}`);
      return 2;
    } finally {
      await agent.dispose();
    }
  },
});

registerSlashCommand({
  name: 'workflows',
  usage: '[show <runId>]',
  description: 'list workflow runs of this project (status, items ok) or show one',
  run(args, ctx) {
    const [sub, id] = args.trim().split(/\s+/);
    if (sub === 'show' && id) return void ctx.write(formatRunShort(ctx.workspace, id));
    const runs = listRuns(ctx.workspace);
    ctx.write(runs.length ? runs.map((r) => `  ${r.runId}  ${r.name}  ${r.status}  ${r.ok}/${r.items} ok`).join('\n') : '  no workflow runs');
  },
});

function formatRunShort(ws: string, id: string): string {
  const r = readRun(ws, id);
  return r.items.map((i) => `  item ${i.index + 1}: ${i.status}${i.reason ? ` (${i.reason})` : ''}`).join('\n') || '  (no items finished)';
}
