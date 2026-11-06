/**
 * v1.2 N18: the declarative workflow spec (JSON or YAML-as-JSON). A workflow is DATA, never model-authored
 * code (SAC2): it maps over items with a task template, with concurrency, budgets, isolation, retry and a
 * reduce step. The only fields that run code are `command` and `script` (a per-item check, a reduce
 * script); a spec that has any of them runs only after the human approved the workflow as a whole, with
 * every expanded command shown (see runner.ts).
 *
 * Validation is strict (zod, unknown keys refused) so a typo cannot silently drop a limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ChildRefusal } from './clamp.js';
import { parseJsonLenient } from '../../util/json.js';

const Budget = z.strictObject({ maxTokens: z.number().nonnegative().optional(), maxCostUsd: z.number().nonnegative().optional() });
const Mode = z.enum(['plan', 'ask', 'acceptEdits', 'auto', 'yolo']);

export const WorkflowSpecSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'name: 1-64 letters, digits, dot, dash or underscore'),
  description: z.string().max(2000).optional(),
  items: z.array(z.union([z.string(), z.number(), z.record(z.string(), z.unknown())])).min(1),
  task: z.strictObject({
    /** template: {{item}}, {{item.<key>}}, {{index}} */
    prompt: z.string().min(1),
    agentType: z.string().optional(),
    tools: z.array(z.string()).optional(),
    mode: Mode.optional(),
    roots: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    profile: z.string().optional(),
    /** a subset of the caller's configured MCP servers */
    mcpServers: z.array(z.string()).optional(),
    /** a subset of the caller's hooks ("Event" or "Event:matcher") */
    hooks: z.array(z.string()).optional(),
    /** run the item's commands in a container (docker runner, no network) */
    sandbox: z.literal('container').optional(),
    isolation: z.enum(['worktree', 'shared']).optional(),
    /** structured output: the item's final answer must be a JSON object with these keys (retried once otherwise) */
    output: z.strictObject({ required: z.array(z.string()).min(1) }).optional(),
    /** CODE: a per-item shell check (template); the item succeeds only when it exits 0 */
    command: z.string().optional(),
    /** CODE: a per-item shell script (template), same rule as command */
    script: z.string().optional(),
    maxTurns: z.number().int().positive().optional(),
  }),
  concurrency: z.number().int().positive().optional(),
  budget: z.strictObject({ total: Budget.optional(), perItem: Budget.optional() }).optional(),
  /** retries per failing item (0 or 1, default 1) */
  retry: z.number().int().min(0).max(1).optional(),
  /** per-attempt wall-clock limit (backstop), ms */
  timeoutMs: z.number().int().positive().optional(),
  /** stall watchdog: no progress for this long (no tool running) stops the attempt, ms */
  stallMs: z.number().int().positive().optional(),
  reduce: z
    .strictObject({
      prompt: z.string().min(1),
      agentType: z.string().optional(),
      command: z.string().optional(),
      script: z.string().optional(),
    })
    .optional(),
});

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** Parse and validate; a bad spec is a typed refusal that names every problem. */
export function parseWorkflowSpec(input: unknown): WorkflowSpec {
  let v = input;
  if (typeof v === 'string') {
    const p = parseJsonLenient(v);
    if (!p.ok) throw new ChildRefusal('invalid_spec', 'the workflow spec is not valid JSON');
    v = p.value;
  }
  const r = WorkflowSpecSchema.safeParse(v);
  if (!r.success) throw new ChildRefusal('invalid_spec', `the workflow spec is invalid: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** `{{item}}`, `{{item.key}}`, `{{index}}` (1-based). Values are inserted as text, never evaluated. */
export function renderTemplate(t: string, item: unknown, index: number): string {
  return t.replace(/\{\{\s*(item(?:\.[A-Za-z0-9_]+)*|index)\s*\}\}/g, (_m, k: string) => {
    if (k === 'index') return String(index + 1);
    let v: unknown = item;
    for (const part of k.split('.').slice(1)) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    return v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Shell-quote a value inserted into a command template (an item can never inject shell syntax). */
export function renderCommand(t: string, item: unknown, index: number): string {
  return t.replace(/\{\{\s*(item(?:\.[A-Za-z0-9_]+)*|index)\s*\}\}/g, (m) => `'${renderTemplate(m, item, index).replace(/'/g, `'\\''`)}'`);
}

/** Every command the workflow would run, expanded, for the one approval that covers them (SAC2). */
export function codeFields(spec: WorkflowSpec): { where: string; command: string }[] {
  const out: { where: string; command: string }[] = [];
  spec.items.forEach((item, i) => {
    if (spec.task.command) out.push({ where: `item ${i + 1} command`, command: renderCommand(spec.task.command, item, i) });
    if (spec.task.script) out.push({ where: `item ${i + 1} script`, command: renderCommand(spec.task.script, item, i) });
  });
  if (spec.reduce?.command) out.push({ where: 'reduce command', command: spec.reduce.command });
  if (spec.reduce?.script) out.push({ where: 'reduce script', command: spec.reduce.script });
  return out;
}

/** Saved workflows: `.tugline/workflows/<name>.json` in the project, then `~/.tugline/workflows/`. */
export function resolveWorkflow(ref: string, workspace: string, homeDir: string): { file: string; spec: WorkflowSpec } {
  // F22: a saved workflow is named, never a path: the tool must not read arbitrary files outside the permission engine
  // (the CLI reads a file the user names itself)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref) || ref.endsWith('.json')) throw new ChildRefusal('invalid_spec', `"${ref}" is not a saved workflow name (letters, digits, . _ -); saved workflows live in .tugline/workflows/ or ~/.tugline/workflows/`);
  const candidates = [path.join(workspace, '.tugline', 'workflows', `${ref}.json`), path.join(homeDir, 'workflows', `${ref}.json`)];
  for (const f of candidates) if (fs.existsSync(f)) return { file: f, spec: parseWorkflowSpec(fs.readFileSync(f, 'utf8')) };
  throw new ChildRefusal('invalid_spec', `no workflow "${ref}" (looked in ${candidates.join(', ')})`);
}

export function listSavedWorkflows(workspace: string, homeDir: string): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  for (const d of [path.join(workspace, '.tugline', 'workflows'), path.join(homeDir, 'workflows')]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json') && !out.some((o) => o.name === f.slice(0, -5))) out.push({ name: f.slice(0, -5), file: path.join(d, f) });
  }
  return out;
}
