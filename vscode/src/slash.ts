/**
 * Slash commands in the VS Code chat (SPEC S0.6). Same semantics as the CLI:
 * registered commands (core registry: /rewind, /usage, /context, /goal, /jobs,
 * /memory, /hooks, /browser, MCP prompts …) override the built-ins except the
 * essentials, and `/<skill> args` runs a skill. Pure: the editor actions are
 * injected, so this is unit-tested with a real Agent.
 */
import { invalidModeMessage, isPermissionMode, PERMISSION_MODES, YOLO_WARNING } from '../../src/core/approver/modes.js';
import { getSlashCommand, slashCommands, type SlashContext } from '../../src/core/commands.js';
import type { PermissionMode } from '../../src/core/types.js';
import { costReport } from '../../src/core/cache/meter.js'; // WS10 N10

export interface SlashDeps {
  /** the chat's agent (built) */
  agent: any;
  write(text: string): void;
  ask?: SlashContext['ask'];
  /** `/clear`: start a new chat */
  newChat(): void;
  /** `/model <profile|model id>` from the picker logic */
  setModel(choice: string): Promise<void> | void;
  /** the core registry (default: the import; tests pass their own module instance) */
  registry?: { get: typeof getSlashCommand; list: typeof slashCommands };
}

export interface SlashResult {
  /** false: not a command, send the text to the model unchanged */
  handled: boolean;
  /** a prompt to send to the model after the command ran */
  prompt?: string;
}

/** Built-ins the registry cannot replace (as in the CLI, plus /clear which means "new chat" here). */
const ESSENTIAL = new Set(['help', 'clear']);

export const BUILTINS: { name: string; usage?: string; description: string }[] = [
  { name: 'help', description: 'list commands' },
  { name: 'clear', description: 'start a new chat' },
  { name: 'mode', usage: '<ask|acceptEdits|plan|auto|yolo>', description: 'show or change the permission mode' },
  { name: 'model', usage: '[profile|model id]', description: 'show or switch the model of this chat' },
  { name: 'models', description: 'list models at the endpoint' },
  { name: 'compact', usage: '[focus]', description: 'compact the conversation now' },
  { name: 'cost', description: 'token and cost totals for this chat' },
  { name: 'tools', description: 'list the tools the agent can use' },
  { name: 'skills', description: 'list skills (run one with /<skill> [args])' },
  { name: 'mcp', description: 'MCP server status' },
  { name: 'todos', description: 'show the task list' },
];

/** Commands for the composer's "/" autocomplete: built-ins, registered commands, then skills. */
export function slashItems(agent: any | undefined, q: string, list: typeof slashCommands = slashCommands): { label: string; insert: string; detail?: string }[] {
  const all = new Map<string, { label: string; insert: string; detail?: string }>();
  for (const b of BUILTINS) all.set(b.name, { label: `/${b.name}${b.usage ? ` ${b.usage}` : ''}`, insert: `/${b.name} `, detail: b.description });
  for (const c of list()) if (!ESSENTIAL.has(c.name)) all.set(c.name, { label: `/${c.name}${c.usage ? ` ${c.usage}` : ''}`, insert: `/${c.name} `, detail: c.description });
  for (const s of agent?.skills?.list?.() ?? []) if (!all.has(s.name)) all.set(s.name, { label: `/${s.name}`, insert: `/${s.name} `, detail: `skill: ${String(s.description).slice(0, 80)}` });
  const lq = q.toLowerCase();
  return [...all.entries()].filter(([n]) => n.toLowerCase().startsWith(lq)).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

export function helpText(agent: any | undefined, list: typeof slashCommands = slashCommands): string {
  const reg = list().filter((c) => !ESSENTIAL.has(c.name));
  const lines = [...BUILTINS.filter((b) => !reg.some((r) => r.name === b.name)).map((b) => `/${b.name}${b.usage ? ` ${b.usage}` : ''} — ${b.description}`), ...reg.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ''} — ${c.description}`)];
  const skills = (agent?.skills?.list?.() ?? []).map((s: any) => s.name);
  return `${lines.join('\n')}${skills.length ? `\n/<skill> [args] — run a skill: ${skills.join(', ')}` : ''}\n@file @folder/ @problems @terminal @git @url: @skill: — attach context`;
}

export async function dispatchSlash(text: string, d: SlashDeps): Promise<SlashResult> {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  // "/usr/bin/foo is broken" is a message, not a command
  if (!m || m[1].includes('/')) return { handled: false };
  const name = m[1];
  const arg = m[2].trim();
  const a = d.agent;
  const registry = d.registry ?? { get: getSlashCommand, list: slashCommands };
  const reg = ESSENTIAL.has(name) ? undefined : registry.get(name);
  if (reg) {
    try {
      const r = await reg.run(arg, { agent: a, config: a.config, workspace: a.workspace, write: (t) => d.write(t.replace(/\n$/, '')), ask: d.ask, surface: 'vscode' });
      return { handled: true, prompt: r && r.prompt ? r.prompt : undefined };
    } catch (e) {
      d.write(`/${name} failed: ${(e as Error).message}`);
      return { handled: true };
    }
  }
  switch (name) {
    case 'help':
      d.write(helpText(a, registry.list));
      return { handled: true };
    case 'clear':
      d.newChat();
      return { handled: true };
    case 'mode':
      if (isPermissionMode(arg)) {
        a.setMode(arg);
        d.write(arg === 'yolo' ? `mode: yolo. ${YOLO_WARNING}` : `mode: ${arg}`);
      } else d.write(`${arg ? invalidModeMessage(arg) + '\n' : ''}mode: ${a.policy.mode}  (${PERMISSION_MODES.join(' | ')})`);
      return { handled: true };
    case 'model':
      if (arg) {
        try {
          await d.setModel(a.config.profiles[arg] ? `profile:${arg}` : `model:${arg}`);
          d.write(`model: ${a.llm.profile.model} @ ${a.llm.profile.baseUrl}`);
        } catch (e) {
          d.write((e as Error).message);
        }
      } else d.write(`model: ${a.llm.profile.model} @ ${a.llm.profile.baseUrl} (tool mode ${a.llm.dialect})\nprofiles: ${Object.keys(a.config.profiles).join(', ')}`);
      return { handled: true };
    case 'models':
      try {
        d.write((await a.llm.listModels()).map((x: string) => `- ${x}`).join('\n') || '(none)');
      } catch (e) {
        d.write((e as Error).message);
      }
      return { handled: true };
    case 'compact':
      if (a.isRunning) d.write('the agent is running; compact after it finishes');
      else {
        await a.compactNow(true, arg || undefined);
        d.write('conversation compacted');
      }
      return { handled: true };
    case 'cost':
      d.write(costReport(a)); // N10: + prompt-cache hit rate
      return { handled: true };
    case 'tools':
      d.write(a.toolList.map((t: any) => `- ${t.name} (${t.kind})`).join('\n'));
      return { handled: true };
    case 'skills':
      d.write(a.skills.list().map((s: any) => `- ${s.name} [${s.source}]: ${s.description}`).join('\n') || '(no skills)');
      return { handled: true };
    case 'mcp':
      d.write((a.mcp?.status() ?? []).map((s: any) => `- ${s.name}: ${s.status} (${s.tools} tools)${s.error ? ' ' + s.error : ''}`).join('\n') || '(no MCP servers configured)');
      return { handled: true };
    case 'todos':
      d.write(a.todos.map((t: any) => `[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`).join('\n') || '(no tasks)');
      return { handled: true };
  }
  const sk = a.skills.get(name);
  if (sk) return { handled: true, prompt: `Use the "${sk.name}" skill (call load_skill first). ${arg}`.trim() };
  d.write(`unknown command /${name}. /help for the list`);
  return { handled: true };
}
