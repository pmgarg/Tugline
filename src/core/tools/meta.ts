/**
 * Meta tools: planning state, skills, subagents, user questions, plan mode.
 */
import { ToolError, type ToolDef } from './types.js';
import type { TodoItem } from '../types.js';

export const todoWriteTool: ToolDef<{ todos: TodoItem[] }> = {
  name: 'todo_write',
  kind: 'meta',
  readOnly: true,
  description:
    'Create or update your task list for multi-step work (3+ steps). Send the FULL list every time. Exactly one item should be "in_progress" while you work; ' +
    'mark items "completed" as soon as they are done. The user sees this list as your progress. Skip it for trivial single-step tasks.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  title: () => 'Update task list',
  async run(a, ctx) {
    if (!Array.isArray(a.todos)) throw new ToolError('todos must be an array of {content, status}');
    const todos: TodoItem[] = a.todos.map((t: any) => ({
      content: String(t.content ?? t.task ?? t.title ?? ''),
      status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
    }));
    ctx.setTodos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    return { output: `Task list updated (${done}/${todos.length} done):\n${todos.map((t) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`).join('\n')}` };
  },
};

export const loadSkillTool: ToolDef<{ name: string }> = {
  name: 'load_skill',
  kind: 'meta',
  readOnly: true,
  description: 'Load the full instructions of a skill listed under "Available skills" in your instructions. Load a skill BEFORE starting work its description matches, then follow it.',
  parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name' } }, required: ['name'] },
  title: (a) => `Load skill ${a.name}`,
  async run(a, ctx) {
    const body = ctx.skills.load(String(a.name ?? ''));
    if (!body) throw new ToolError(`no skill named "${a.name}". Available: ${ctx.skills.list().map((s) => s.name).join(', ') || '(none)'}`);
    return { output: body };
  },
};

export const askUserTool: ToolDef<{ question: string; options?: string[] }> = {
  name: 'ask_user',
  kind: 'meta',
  description: 'Ask the user a clarifying question when the request is genuinely ambiguous and a wrong guess would be costly. Offer 2-4 options when possible. Do not ask for things you can find out yourself.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['question'],
  },
  title: (a) => `Ask: ${a.question}`,
  async run(a, ctx) {
    if (!ctx.askUser) return { output: 'No user is available to answer (headless run). Make the most reasonable assumption, state it explicitly in your final answer, and continue.' };
    const answer = await ctx.askUser(String(a.question), Array.isArray(a.options) ? a.options.map(String) : undefined);
    return { output: `User answered: ${answer}` };
  },
};

export const exitPlanModeTool: ToolDef<{ plan: string }> = {
  name: 'exit_plan_mode',
  kind: 'meta',
  description: 'In plan mode: present your implementation plan (markdown) for approval. If the user approves, you may then edit files and run commands.',
  parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
  title: () => 'Present plan for approval',
  async run(a, ctx) {
    if (ctx.policy.mode !== 'plan') return { output: 'Not in plan mode; proceed with the work.' };
    const ok = ctx.approvePlan ? await ctx.approvePlan(String(a.plan)) : false;
    if (ok) {
      ctx.setMode('acceptEdits');
      return { output: 'The user approved the plan. Plan mode is off (edits are auto-approved, commands still ask). Implement the plan now.' };
    }
    return { output: 'The user did not approve the plan. Stay in plan mode; ask what to change or refine the plan.' };
  },
};

export const taskTool: ToolDef<{ agent_type?: string; description: string; prompt: string; run_in_background?: boolean; isolation?: string; fork?: boolean }> = {
  name: 'task',
  kind: 'meta',
  description:
    'Delegate a self-contained sub-task to a subagent that starts with a FRESH context and returns only its final report. Use it to keep your own context small. Types:\n' +
    '- "explore": read-only search of the codebase/web to answer a question ("where is X handled?", "how does Y work?").\n' +
    '- "general": a multi-step task that may edit files and run commands.\n' +
    '- "validator": an independent, skeptical check of finished work. It may read files and run commands but never edit; it tries to prove the work is wrong.\n' +
    'Custom agent types may also be listed in your instructions. Give the subagent a complete, standalone prompt: it cannot see this conversation.\n' +
    'Several task calls in one reply run in parallel. run_in_background returns a handle at once (collect the report later with task_result). ' +
    'isolation "worktree" runs a general subagent in its own git worktree branch (oh/<id>) so parallel edits cannot collide; merge the branch with worktree_merge. ' +
    'For the same task over many items, call workflow_run instead (a declarative fan-out); for several cooperating agents with a shared task board, team_create.',
  parameters: {
    type: 'object',
    properties: {
      agent_type: { type: 'string', description: 'explore | general | validator | <custom>' },
      description: { type: 'string', description: '3-6 word label' },
      prompt: { type: 'string', description: 'Complete instructions for the subagent' },
      run_in_background: { type: 'boolean', description: 'Return a handle immediately; fetch the report with task_result' },
      isolation: { type: 'string', enum: ['worktree'], description: 'Run in a separate git worktree branch' },
      fork: { type: 'boolean', description: 'Start the subagent with a copy of this conversation instead of a fresh context' },
    },
    required: ['description', 'prompt'],
  },
  title: (a) => `Subagent (${a.agent_type ?? 'general'}${a.isolation === 'worktree' ? ', worktree' : ''}${a.run_in_background ? ', background' : ''}): ${a.description}`,
  validate(a) {
    if (a.isolation !== undefined && a.isolation !== null && a.isolation !== '' && a.isolation !== 'worktree') throw new ToolError('isolation must be "worktree" (or omitted)');
  },
  async run(a, ctx) {
    if (!ctx.runSubagent) throw new ToolError('subagents are not available at this depth');
    const isolation = a.isolation === 'worktree' ? ('worktree' as const) : undefined;
    const background = !!a.run_in_background;
    const res = await ctx.runSubagent({ agentType: String(a.agent_type ?? 'general'), description: String(a.description ?? 'subtask'), prompt: String(a.prompt ?? ''), isolation, background, ...(a.fork === true ? { fork: true } : {}) });
    const activate = [...(background ? ['task_result', 'task_stop'] : []), ...(isolation ? ['worktree_merge'] : [])];
    return { output: res, meta: activate.length ? { activateTools: activate } : undefined };
  },
};

/** A subagent started with run_in_background (SPEC D1). */
export interface BackgroundTask {
  handle: string;
  description: string;
  agentType: string;
  status: 'running' | 'done' | 'failed';
  promise: Promise<string>;
  result?: string;
  startedAt: number;
  /** set once task_result has returned the report */
  collected?: boolean;
}

/** `task_result`, bound to one agent's background tasks. */
export function makeTaskResultTool(get: (handle: string) => BackgroundTask | undefined, list: () => BackgroundTask[]): ToolDef<{ handle: string; wait_ms?: number }> {
  return {
    name: 'task_result',
    kind: 'meta',
    readOnly: true,
    description: 'Get the report of a subagent started with task run_in_background. Waits up to wait_ms (default 60000) for it to finish; returns "still running" otherwise.',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string' }, wait_ms: { type: 'integer', description: '0 = do not wait' } },
      required: ['handle'],
    },
    title: (a) => `Subagent result ${a.handle}`,
    async run(a, ctx) {
      const t = get(String(a.handle ?? ''));
      if (!t) throw new ToolError(`no background subagent "${a.handle}". Known: ${list().map((x) => `${x.handle} (${x.status})`).join(', ') || '(none)'}`);
      const wait = Math.max(0, Math.min(a.wait_ms === undefined ? 60_000 : Number(a.wait_ms) || 0, 600_000));
      if (t.status === 'running' && wait > 0) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          t.promise.catch(() => undefined),
          new Promise<void>((r) => {
            timer = setTimeout(r, wait);
            ctx.signal.addEventListener('abort', () => r(), { once: true });
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      if (t.status === 'running') return { output: `Subagent ${t.handle} (${t.description}) is still running after ${Math.round((Date.now() - t.startedAt) / 1000)}s. Do other work and call task_result again later.` };
      t.collected = true;
      return { output: `Subagent ${t.handle} (${t.agentType}: ${t.description}) ${t.status === 'failed' ? 'FAILED' : 'finished'}:\n${t.result ?? ''}` };
    },
  };
}
