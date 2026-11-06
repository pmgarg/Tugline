/**
 * v1.2 N49 (review F13, Qwen `qwen batch`): run one agent task over many items from a plan, with a task ledger written
 * BEFORE anything runs, so a crash or a closed terminal never loses which items are done, and `retry` reruns only the
 * failed ones.
 *
 *   tug batch run <plan.json> [--dry-run] [--expect <digest>] [--parallel N]
 *   tug batch status <task>    tug batch retry <task>    tug batch cancel <task>    tug batch clean <task> [--force]
 *   tug batch check            (the endpoint answers; nothing is billed beyond one tiny request)
 *
 * plan.json: {"prompt": "Translate {{source}} into {{target}} …", "items": [{"id": "a1", "source": "docs/a.md",
 * "target": "docs/fr/a.md"}], "parallel": 2}. Each item is an ordinary Tugline session in this workspace (same
 * permission mode, protected paths, sandbox and journal; no approver, so asks are denied — use --mode acceptEdits).
 * An item is done when its session ended normally and its target exists. Qwen submits items through the provider's
 * Batch API instead; that path is not offered (see docs/parity/inventory/N49.md: items there are plain completions
 * outside the permission engine, and their content waits in provider-side storage).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerCliCommand } from '../core/commands.js';
import type { HarnessConfig } from '../core/config.js';

export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

export interface BatchItem {
  id: string;
  source: string;
  target: string;
}
export interface BatchPlan {
  prompt: string;
  items: BatchItem[];
  parallel?: number;
}
export type ItemState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export interface BatchTask {
  id: string;
  workspace: string;
  createdAt: string;
  digest: string;
  plan: BatchPlan;
  state: 'running' | 'finished' | 'cancelled';
  items: Record<string, { state: ItemState; attempts: number; sessionId?: string; error?: string; stopReason?: string }>;
}

const inside = (ws: string, p: string) => {
  const r = path.relative(ws, path.resolve(ws, p));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
};

/** Validate a plan against the workspace; returns it normalised or throws with every problem. */
export function validatePlan(raw: unknown, workspace: string): BatchPlan {
  const p = raw as BatchPlan;
  const problems: string[] = [];
  if (!p || typeof p !== 'object') throw new Error('the plan must be a JSON object with "prompt" and "items"');
  if (typeof p.prompt !== 'string' || !p.prompt.trim()) problems.push('"prompt" must be a non-empty string');
  if (!Array.isArray(p.items) || !p.items.length) problems.push('"items" must be a non-empty array');
  const seen = new Set<string>();
  for (const [i, it] of (Array.isArray(p.items) ? p.items : []).entries()) {
    if (!it || typeof it.id !== 'string' || !ITEM_ID.test(it.id)) problems.push(`item ${i}: id must be 1-60 characters of [A-Za-z0-9_-]`);
    else if (seen.has(it.id)) problems.push(`item ${i}: duplicate id ${it.id}`);
    else seen.add(it.id);
    if (typeof it?.source !== 'string' || !inside(workspace, it.source)) problems.push(`item ${i}: source must be a path inside the workspace`);
    else if (!fs.existsSync(path.resolve(workspace, it.source))) problems.push(`item ${i}: source ${it.source} does not exist`);
    if (typeof it?.target !== 'string' || !inside(workspace, it.target)) problems.push(`item ${i}: target must be a path inside the workspace`);
  }
  if (p.parallel !== undefined && (!Number.isInteger(p.parallel) || p.parallel < 1 || p.parallel > 8)) problems.push('"parallel" must be 1-8');
  if (problems.length) throw new Error(`invalid batch plan:\n  ${problems.join('\n  ')}`);
  return { prompt: p.prompt, items: p.items.map((x) => ({ id: x.id, source: x.source, target: x.target })), ...(p.parallel ? { parallel: p.parallel } : {}) };
}

/** A digest of the plan and the sources it reads: `--expect` refuses to run if either changed since `--dry-run`. */
export function planDigest(plan: BatchPlan, workspace: string): string {
  const h = crypto.createHash('sha256').update(JSON.stringify(plan));
  for (const it of plan.items) h.update(`\0${it.id}\0`).update(fs.readFileSync(path.resolve(workspace, it.source)));
  return h.digest('hex').slice(0, 16);
}

export function itemPrompt(plan: BatchPlan, it: BatchItem): string {
  return plan.prompt.replace(/\{\{(id|source|target)\}\}/g, (_m, k: 'id' | 'source' | 'target') => it[k]);
}

function taskDir(homeDir: string): string {
  return path.join(homeDir, 'batch');
}
export function taskFile(homeDir: string, id: string): string {
  if (!ITEM_ID.test(id)) throw new Error(`not a batch task id: ${id}`);
  return path.join(taskDir(homeDir), `${id}.json`);
}
export function loadTask(homeDir: string, id: string): BatchTask {
  const f = taskFile(homeDir, id);
  if (!fs.existsSync(f)) throw new Error(`no batch task ${id} (tug batch status lists none; tasks live in ${taskDir(homeDir)})`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function saveTask(homeDir: string, t: BatchTask): void {
  fs.mkdirSync(taskDir(homeDir), { recursive: true, mode: 0o700 });
  const f = taskFile(homeDir, t.id);
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(t, null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
}

/** Run the pending (or failed, on retry) items of a task; the ledger is updated after every item. */
export async function runTask(cfg: HarnessConfig, t: BatchTask, o: { which: 'pending' | 'failed'; write: (s: string) => void; parallel?: number }): Promise<BatchTask> {
  const { Agent } = await import('../core/agent/agent.js');
  const todo = t.plan.items.filter((it) => (o.which === 'failed' ? t.items[it.id]!.state === 'failed' : t.items[it.id]!.state === 'pending'));
  t.state = 'running';
  saveTask(cfg.homeDir, t);
  const one = async (it: BatchItem) => {
    // a `cancel` from another terminal is seen before each item starts
    if (loadTask(cfg.homeDir, t.id).state === 'cancelled') {
      t.items[it.id] = { ...t.items[it.id]!, state: 'cancelled' };
      return;
    }
    t.items[it.id] = { ...t.items[it.id]!, state: 'running', attempts: t.items[it.id]!.attempts + 1, error: undefined };
    saveTask(cfg.homeDir, t);
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    try {
      agent = await Agent.create({ workspace: t.workspace, config: cfg, surface: `batch task ${t.id}, item ${it.id} (headless)` });
      const before = fs.existsSync(path.resolve(t.workspace, it.target)) ? fs.readFileSync(path.resolve(t.workspace, it.target)) : undefined;
      const r = await agent.run(itemPrompt(t.plan, it));
      const after = fs.existsSync(path.resolve(t.workspace, it.target)) ? fs.readFileSync(path.resolve(t.workspace, it.target)) : undefined;
      const ok = r.stopReason === 'end_turn' && after !== undefined && (before === undefined || !before.equals(after));
      t.items[it.id] = { ...t.items[it.id]!, state: ok ? 'done' : 'failed', sessionId: agent.sessionId, stopReason: r.stopReason, error: ok ? undefined : after === undefined ? `the target ${it.target} was not written` : before && after && before.equals(after) ? `the target ${it.target} did not change` : `the session ended with ${r.stopReason}` };
    } catch (e) {
      t.items[it.id] = { ...t.items[it.id]!, state: 'failed', error: (e as Error).message };
    } finally {
      await agent?.dispose().catch(() => undefined);
      saveTask(cfg.homeDir, t);
      o.write(`  ${it.id}: ${t.items[it.id]!.state}${t.items[it.id]!.error ? ` (${t.items[it.id]!.error})` : ''}`);
    }
  };
  const n = Math.max(1, Math.min(8, o.parallel ?? t.plan.parallel ?? 2));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, todo.length) }, async () => {
    while (next < todo.length) await one(todo[next++]!);
  }));
  const latest = loadTask(cfg.homeDir, t.id);
  t.state = latest.state === 'cancelled' ? 'cancelled' : 'finished';
  saveTask(cfg.homeDir, t);
  return t;
}

export function statusText(t: BatchTask): string {
  const counts: Record<string, number> = {};
  for (const s of Object.values(t.items)) counts[s.state] = (counts[s.state] ?? 0) + 1;
  return `batch ${t.id} (${t.state}; ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})\n${t.plan.items.map((it) => `  ${it.id}  ${t.items[it.id]!.state}  ${it.source} → ${it.target}${t.items[it.id]!.error ? `  (${t.items[it.id]!.error})` : ''}`).join('\n')}`;
}

export const BATCH_USAGE = `tug batch run <plan.json> [--dry-run] [--expect <digest>] [--parallel N]
tug batch status <task> | retry <task> | cancel <task> | clean <task> [--force] | check`;

registerCliCommand({
  name: 'batch',
  description: 'one agent task over many items from a plan, with a crash-safe task ledger (status, retry, cancel)',
  usage: 'run <plan.json> [--dry-run] [--expect digest] | status|retry|cancel|clean <task> | check',
  help: () => BATCH_USAGE,
  needsModel: true,
  async run(argv, ctx) {
    const [sub, arg] = argv.filter((a) => !a.startsWith('--'));
    const flag = (k: string) => {
      const i = argv.indexOf(`--${k}`);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    switch (sub) {
      case 'run': {
        if (!arg) throw new Error(`usage: ${BATCH_USAGE}`);
        const plan = validatePlan(JSON.parse(fs.readFileSync(path.resolve(ctx.workspace, arg), 'utf8')), ctx.workspace);
        const digest = planDigest(plan, ctx.workspace);
        if (argv.includes('--dry-run')) {
          ctx.write(`${plan.items.length} item(s), parallel ${plan.parallel ?? 2}, mode ${ctx.config.permissionMode}\n${plan.items.map((it) => `  ${it.id}  ${it.source} → ${it.target}`).join('\n')}\nfirst prompt: ${itemPrompt(plan, plan.items[0]!).slice(0, 300)}\ndigest ${digest} (run with --expect ${digest} to run exactly this)`);
          return 0;
        }
        const expect = flag('expect');
        if (expect && expect !== digest) {
          ctx.write(`the plan or its sources changed since the dry run (digest ${digest}, expected ${expect}); nothing ran`);
          return 1;
        }
        const id = `b${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
        const t: BatchTask = { id, workspace: ctx.workspace, createdAt: new Date().toISOString(), digest, plan, state: 'running', items: Object.fromEntries(plan.items.map((it) => [it.id, { state: 'pending' as ItemState, attempts: 0 }])) };
        saveTask(ctx.config.homeDir, t); // the ledger exists before anything runs
        ctx.write(`batch task ${id}: ${plan.items.length} item(s)`);
        const done = await runTask(ctx.config, t, { which: 'pending', write: ctx.write, parallel: flag('parallel') ? Number(flag('parallel')) : undefined });
        ctx.write(statusText(done));
        return Object.values(done.items).every((s) => s.state === 'done') ? 0 : 1;
      }
      case 'status':
      case 'collect':
        ctx.write(statusText(loadTask(ctx.config.homeDir, String(arg))));
        return 0;
      case 'retry': {
        const t = loadTask(ctx.config.homeDir, String(arg));
        const failed = Object.values(t.items).filter((s) => s.state === 'failed').length;
        if (!failed) {
          ctx.write(`batch ${t.id} has no failed items`);
          return 0;
        }
        ctx.write(`retrying ${failed} failed item(s) of ${t.id}`);
        const done = await runTask(ctx.config, t, { which: 'failed', write: ctx.write });
        ctx.write(statusText(done));
        return Object.values(done.items).every((s) => s.state === 'done') ? 0 : 1;
      }
      case 'cancel': {
        const t = loadTask(ctx.config.homeDir, String(arg));
        t.state = 'cancelled';
        for (const s of Object.values(t.items)) if (s.state === 'pending') s.state = 'cancelled';
        saveTask(ctx.config.homeDir, t);
        ctx.write(`batch ${t.id} cancelled: items not yet started will not run (a running item finishes)`);
        return 0;
      }
      case 'clean': {
        const t = loadTask(ctx.config.homeDir, String(arg));
        if (t.state === 'running' && !argv.includes('--force')) {
          ctx.write(`batch ${t.id} is running; cancel it first, or clean with --force`);
          return 1;
        }
        fs.rmSync(taskFile(ctx.config.homeDir, t.id), { force: true });
        ctx.write(`removed the ledger of batch ${t.id} (the item sessions stay in the session history)`);
        return 0;
      }
      case 'check': {
        const { LLMClient } = await import('../core/llm/client.js');
        const { resolveProfile } = await import('../core/config.js');
        const p = resolveProfile(ctx.config);
        const models = await new LLMClient({ ...p, timeoutMs: 10_000 } as any).listModels().catch((e: Error) => e);
        if (models instanceof Error) {
          ctx.write(`the endpoint ${p.baseUrl} did not answer: ${models.message}`);
          return 1;
        }
        ctx.write(`endpoint ${p.baseUrl} answers (${models.length} model(s)); items would run with ${p.model} in mode ${ctx.config.permissionMode}`);
        return 0;
      }
      default:
        ctx.write(BATCH_USAGE);
        return 2;
    }
  },
});
