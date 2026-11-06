/**
 * Tugline SDK (SPEC G6): the stable surface for embedding the harness.
 *
 * ```ts
 * import { createAgent, defineTool, defineSkill } from 'tugline/sdk';
 *
 * const weather = defineTool({
 *   name: 'get_weather', kind: 'network', description: 'Current weather for a city',
 *   parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
 *   permission: (a) => ({ url: `https://wttr.in/${a.city}` }),
 *   run: async ({ city }) => ({ output: `Sunny in ${city}` }),
 * });
 * const agent = await createAgent({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder:30b', tools: [weather] });
 * const result = await agent.run('Weather in Paris?');
 * await agent.dispose();
 * ```
 *
 * Everything the CLI enforces applies here too: the config is built with
 * loadConfig (workspace trust, managed policy), every tool call goes through
 * the permission engine, and without an `onPermission` handler an "ask" is a
 * recorded denial. Remote use: `connect()` returns a client for `tug serve`.
 *
 * Semver: names exported from this file are the public API. Anything imported
 * from deeper paths may change between minor versions.
 */
import { invalidModeMessage, isPermissionMode } from '../core/approver/modes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, type AgentOptions, type AgentUI, type RunResult } from '../core/agent/agent.js';
import { deepMerge, loadConfig, type HarnessConfig } from '../core/config.js';
import type { ToolContext, ToolDef, ToolOutput } from '../core/tools/types.js';
import type { CheckInput } from '../core/permissions/policy.js';
import type { AgentEvent, ModelProfile, PermissionAnswer, PermissionMode, PermissionRequest, ToolKind } from '../core/types.js';
import { OhClient, type ClientHandlers } from '../server/client.js';
import '../core/tools/providers.js';

export type { Agent, RunResult, AgentUI } from '../core/agent/agent.js';
export { PERMISSION_MODES, MODE_INFO, isPermissionMode } from '../core/approver/modes.js';
export type { AgentEvent, PermissionRequest, PermissionAnswer, PermissionMode, RunStats, StopReason, ToolKind, ModelProfile, TodoItem, Usage } from '../core/types.js';
export type { HarnessConfig } from '../core/config.js';
export type { ToolDef, ToolContext, ToolOutput } from '../core/tools/types.js';
export { ToolError } from '../core/tools/types.js';
export { OhClient, type ClientHandlers } from '../server/client.js';
export type { SessionInfo, RunSummary, RemoteResult } from '../server/protocol.js';
export { startServer } from '../server/server.js';

export const SDK_VERSION = '1.2.0-beta.5';

// ------------------------------------------------------------ tools

export interface ToolDefinition<A = Record<string, unknown>> {
  /** Unique tool name (letters, digits, _ and -). */
  name: string;
  /** What it does and when to use it: the model reads this. */
  description: string;
  /** JSON schema of the arguments. */
  parameters: Record<string, unknown>;
  /**
   * Required: what the tool touches. 'read' | 'edit' | 'execute' | 'network' | 'meta' | 'mcp'.
   * It decides how the permission engine treats the call (e.g. 'execute' asks in "ask" mode).
   */
  kind: ToolKind;
  /** Inputs for the permission engine (paths, command, url) derived from the arguments. */
  permission?: (args: A, ctx: ToolContext) => Omit<CheckInput, 'tool' | 'kind'>;
  /** One-line label for UIs (default: the tool name and arguments). */
  title?: (args: A) => string;
  /** Safe to run in parallel with other read-only calls. */
  readOnly?: boolean;
  run: (args: A, ctx: ToolContext) => Promise<ToolOutput | string> | ToolOutput | string;
}

/** Define a model-facing tool. Returning a string is shorthand for `{ output }`. */
export function defineTool<A = Record<string, unknown>>(d: ToolDefinition<A>): ToolDef<A> {
  if (!/^[A-Za-z][\w-]{0,63}$/.test(d.name)) throw new Error(`invalid tool name "${d.name}"`);
  if (!['read', 'edit', 'execute', 'network', 'meta', 'mcp'].includes(d.kind)) throw new Error(`tool ${d.name}: kind must be read|edit|execute|network|meta|mcp`);
  return {
    name: d.name,
    description: d.description,
    parameters: d.parameters,
    kind: d.kind,
    readOnly: d.readOnly,
    permissionInput: d.permission,
    title: d.title ?? ((a) => `${d.name}(${JSON.stringify(a ?? {}).slice(0, 120)})`),
    run: async (a, ctx) => {
      const r = await d.run(a, ctx);
      return typeof r === 'string' ? { output: r } : r;
    },
  };
}

// ------------------------------------------------------------ skills

export interface SkillDefinition {
  name: string;
  description: string;
  /** The SKILL.md body (markdown instructions). */
  instructions: string;
  /** Extra files next to SKILL.md (level-3 disclosure), relative path → content. */
  files?: Record<string, string>;
}

/** Define a skill in code. It is written as a SKILL.md to a private temp dir when the agent is created. */
export function defineSkill(s: SkillDefinition): SkillDefinition {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.name)) throw new Error(`invalid skill name "${s.name}" (lowercase letters, digits, -)`);
  for (const f of Object.keys(s.files ?? {})) if (f.includes('..') || path.isAbsolute(f)) throw new Error(`skill ${s.name}: file path ${f} must stay inside the skill`);
  return s;
}

function materializeSkills(skills: SkillDefinition[]): string | undefined {
  if (!skills.length) return undefined;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-sdk-skills-'));
  for (const s of skills) {
    const dir = path.join(root, s.name);
    fs.mkdirSync(dir, { recursive: true });
    const desc = s.description.replace(/\n/g, ' ');
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${s.name}\ndescription: ${JSON.stringify(desc)}\n---\n${s.instructions.trim()}\n`);
    for (const [f, c] of Object.entries(s.files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), c);
    }
  }
  return root;
}

// ------------------------------------------------------------ agents

export interface CreateAgentOptions {
  /** Workspace directory (default: process.cwd()). */
  workspace?: string;
  /** Endpoint shorthand for the active profile. */
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  toolMode?: ModelProfile['toolMode'];
  permissionMode?: PermissionMode;
  /** Extra config, deep-merged over the loaded config. */
  config?: Record<string, unknown>;
  /** Read ~/.tugline/config.json and the workspace config (default true). */
  loadUserConfig?: boolean;
  tools?: ToolDef<any>[];
  skills?: SkillDefinition[];
  /** Connect configured MCP servers (default true). */
  mcp?: boolean;
  onEvent?: (e: AgentEvent) => void;
  /** Approve or deny "ask" decisions. Without it they are denied and recorded. */
  onPermission?: (req: PermissionRequest) => Promise<PermissionAnswer> | PermissionAnswer;
  onAsk?: (question: string, options?: string[]) => Promise<string> | string;
  onPlan?: (plan: string) => Promise<boolean> | boolean;
  /** Advanced: anything else Agent.create accepts. */
  agentOptions?: Partial<AgentOptions>;
}

/** Build the harness config for SDK options (loadConfig, so trust and managed policy apply). */
export function sdkConfig(o: CreateAgentOptions = {}): HarnessConfig {
  const workspace = path.resolve(o.workspace ?? process.cwd());
  const prof: Record<string, unknown> = {};
  if (o.baseUrl) prof.baseUrl = o.baseUrl;
  if (o.apiKey !== undefined) prof.apiKey = o.apiKey;
  if (o.model) prof.model = o.model;
  if (o.contextWindow) prof.contextWindow = o.contextWindow;
  if (o.maxOutputTokens) prof.maxOutputTokens = o.maxOutputTokens;
  if (o.toolMode) prof.toolMode = o.toolMode;
  let overrides: any = o.config ? { ...o.config } : {};
  if (o.permissionMode) {
    // N43: one list of modes on every surface; auto = safety classifier, yolo = no classifier
    if (!isPermissionMode(o.permissionMode)) throw new Error(invalidModeMessage(o.permissionMode));
    overrides.permissionMode = o.permissionMode;
  }
  if (Object.keys(prof).length) {
    const profile = String(overrides.profile ?? 'default');
    overrides = deepMerge(overrides, { profile, profiles: { [profile]: prof } });
  }
  return loadConfig({ workspace, overrides, noUserConfig: o.loadUserConfig === false });
}

export async function createAgent(o: CreateAgentOptions = {}): Promise<Agent> {
  const workspace = path.resolve(o.workspace ?? process.cwd());
  const config = sdkConfig(o);
  const skillRoot = materializeSkills(o.skills ?? []);
  if (skillRoot) config.skills.dirs = [...config.skills.dirs, skillRoot];
  const ui: AgentUI = {
    onEvent: o.onEvent,
    requestPermission: o.onPermission ? async (r) => o.onPermission!(r) : undefined,
    askUser: o.onAsk ? async (q, opts) => o.onAsk!(q, opts) : undefined,
    approvePlan: o.onPlan ? async (p) => o.onPlan!(p) : undefined,
  };
  return Agent.create({ surface: 'application (Tugline SDK)', ...o.agentOptions, workspace, config, ui, mcp: o.mcp, extraTools: [...(o.agentOptions?.extraTools ?? []), ...(o.tools ?? [])] });
}

export interface RunOnceResult extends RunResult {
  events: AgentEvent[];
}

/** One-shot: create an agent, run one prompt, dispose it. Collects the events. */
export async function run(prompt: string, o: CreateAgentOptions = {}): Promise<RunOnceResult> {
  const events: AgentEvent[] = [];
  const agent = await createAgent({ ...o, onEvent: (e) => (events.push(e), o.onEvent?.(e)) });
  try {
    const r = await agent.run(prompt);
    return { ...r, events };
  } finally {
    await agent.dispose();
  }
}

/** Connect to a running `tug serve` (token from the argument or TUG_SERVER_TOKEN). */
export function connect(url: string, token = process.env.TUG_SERVER_TOKEN ?? '', handlers: ClientHandlers = {}): Promise<OhClient> {
  return OhClient.connect(url, token, handlers);
}
