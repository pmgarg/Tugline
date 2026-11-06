/**
 * Arena surfaces (v1.2 N47): `tug arena` (live, side by side, then pick a winner) and `/arena` in every chat
 * surface (CLI REPL, VS Code, `tug serve` session/command). The VS Code arena view (vscode/src/arenaView.ts)
 * drives runArena / applyArenaWinner directly.
 */
import { isPermissionMode, invalidModeMessage } from '../approver/modes.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import type { HarnessConfig } from '../config.js';
import { registerSlashCommand } from '../commands.js';
import type { BoardUI } from '../context/worktreeBoard.js';
import { splitArgs } from '../context/worktreeCommands.js';
import type { PermissionMode } from '../types.js';
import { parseFlags } from '../schedule/cli.js';
import { applyArenaWinner, listArenaRuns, loadArenaRun, runArena, writeArenaReport, type ArenaControl, type ArenaResult, type ArenaStreamEvent } from './arena.js';
import { runEval } from './runner.js';
import { summarizeScores } from './scorer.js';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const ARENA_USAGE = `tug arena --models a,b[,c] [--agents cline] "<prompt>"   one task, several contestants in parallel worktrees, live
    [--check "<cmd>"]         the harness check that decides pass/fail (default: the project's detected check)
    [--judge <profile>]       second-stage judge (anonymised rubric) after the check
    [--parallel N]            contestants at once (default: all; 1 for a single-slot local server)
    [--budget-tokens N] [--budget-usd X] [--max-turns N]   per-contestant budget
    [--mode acceptEdits|auto|yolo] [--pick A|<model>|auto|none] [--verify-goal] [--yes] [--discard] [--out report.md] [--quiet]
tug arena list | show <run> | pick <run> <label> [--yes] [--force] | discard <run>
tug arena --models a,b --suite <evalSuiteDir> [--repeats N]   multi-task arena through the eval harness`;

/** Line-buffered, labelled streams: contestants' output interleaves by whole lines, never mid-line. */
export class StreamPrinter {
  private bufs = new Map<string, string>();
  constructor(private write: (line: string) => void, private names: Record<string, string>) {}
  event(label: string, e: ArenaStreamEvent): void {
    const tag = `[${label} ${this.names[label] ?? ''}]`.replace(' ]', ']');
    if (e.type === 'text_delta') {
      const b = (this.bufs.get(label) ?? '') + e.text;
      const lines = b.split('\n');
      this.bufs.set(label, lines.pop()!);
      for (const l of lines) if (l.trim()) this.write(`${tag} ${l}`);
      return;
    }
    this.flush(label);
    if (e.type === 'tool_start') this.write(`${tag} ⏺ ${e.title}`);
    else if (e.type === 'refusal') this.write(`${tag} ⛔ ${e.tool}: ${e.reason}`);
    else if (e.type === 'arena_status') this.write(`${tag} ${e.state}${e.detail ? `: ${e.detail}` : ''}`);
  }
  flush(label?: string): void {
    for (const [l, b] of this.bufs) {
      if (label && l !== label) continue;
      if (b.trim()) this.write(`[${l} ${this.names[l] ?? ''}] ${b}`);
      this.bufs.set(l, '');
    }
  }
}

interface Io {
  write: (t: string) => void;
  ask?: (q: string, options?: string[]) => Promise<string>;
}

function approvalVia(io: Io, yes: boolean): BoardUI['requestPermission'] {
  // review F4: --yes confirms the merge of the pick only; anything else still goes to a person (or is denied)
  if (yes) return async (r, who) => (r.tool === 'worktree_merge' ? { decision: 'allow', by: 'cli_flag' } as any : io.ask ? { decision: /^y/i.test((await io.ask(`[${who}] ${r.title}\nAllow?`, ['yes', 'no'])).trim()) ? 'allow' : 'deny' } : { decision: 'deny', feedback: 'no one is available to approve this (--yes only confirms the merge)' });
  if (!io.ask) return undefined;
  return async (r, who) => ({ decision: /^y/i.test((await io.ask!(`[${who}] ${r.title}${r.reason ? ` (${r.reason})` : ''}\n${(r.detail ?? '').split('\n').slice(0, 12).join('\n')}\nAllow?`, ['yes', 'no'])).trim()) ? 'allow' : 'deny' });
}

async function pickAndApply(cfg: HarnessConfig, workspace: string, r: ArenaResult, pick: string | undefined, io: Io, f: Record<string, unknown>): Promise<number> {
  let choice = pick;
  const withChanges = r.ranking.filter((e) => e.branch);
  if (!choice && io.ask && withChanges.length) {
    choice = (await io.ask(`Pick the winner to apply (${withChanges.map((e) => `${e.label}=${e.model}${e.outcome === 'pass' ? ' ✓' : ''}`).join(', ')}), or "none"`, [...withChanges.map((e) => e.label), 'none'])).trim();
  }
  if (!choice || choice === 'none') {
    if (withChanges.length) io.write(`No winner applied. Later: tug arena pick ${r.run} <label>`);
    return 0;
  }
  if (choice === 'auto') {
    const best = r.ranking.find((e) => e.branch && e.outcome === 'pass');
    if (!best) {
      io.write('auto pick: no contestant passed the check; nothing applied');
      return 1;
    }
    choice = best.label;
  }
  const res = await applyArenaWinner({ config: cfg, workspace, run: r, pick: choice, ui: { requestPermission: approvalVia(io, !!f.yes) }, force: !!f.force });
  io.write(res.winner ? `${res.winner.label} (${res.winner.model}): ${res.message}` : res.message);
  return res.merged ? 0 : 1;
}

export async function arenaCli(argv: string[], ctx: { config: HarnessConfig; workspace: string; write: (t: string) => void }, ask?: Io['ask']): Promise<number> {
  const io: Io = { write: ctx.write, ask };
  const sub = argv[0];
  if (sub === 'list') {
    const runs = listArenaRuns(ctx.config);
    ctx.write(runs.length ? runs.map((x) => `${x.run}  ${new Date(x.when).toISOString().slice(0, 16)}  ${x.prompt}`).join('\n') : 'no arena runs yet');
    return 0;
  }
  if (sub === 'show' || sub === 'pick' || sub === 'discard') {
    const f = parseFlags(argv.slice(1), ['yes', 'force']);
    const r = loadArenaRun(ctx.config, String(f._[0] ?? ''));
    if (!r) {
      ctx.write(`no arena run "${f._[0] ?? ''}" (tug arena list)`);
      return 2;
    }
    if (sub === 'show') {
      const { arenaReport } = await import('./arena.js');
      ctx.write(arenaReport(r));
      return 0;
    }
    if (sub === 'discard') {
      const { safeGit } = await import('../context/worktreeGit.js');
      for (const e of r.entries) if (e.branch) await safeGit(r.repo, ['branch', '-D', e.branch]).catch(() => undefined);
      ctx.write(`discarded the branches of arena ${r.run}`);
      return 0;
    }
    return pickAndApply(ctx.config, ctx.workspace, r, String(f._[1] ?? ''), io, f);
  }
  const f = parseFlags(argv, ['discard', 'yes', 'quiet', 'force', 'verify-goal']);
  const models = typeof f.models === 'string' ? f.models.split(',').map((m) => m.trim()).filter(Boolean) : [];
  const agents = typeof f.agents === 'string' ? f.agents.split(',').map((m) => m.trim()).filter(Boolean) : [];
  if (models.length + agents.length < 2) {
    ctx.write(`usage: ${ARENA_USAGE}`);
    return 2;
  }
  if (typeof f.suite === 'string') {
    // Multi-task comparison through the eval harness: one arm per model.
    const arms: Record<string, unknown> = {};
    for (const [i, m] of models.entries()) arms[m] = ctx.config.profiles[m] ? { profile: m } : { profiles: { [`arena-${i}`]: { ...ctx.config.profiles[ctx.config.profile], model: m } }, profile: `arena-${i}` };
    for (const a of agents) arms[a] = { external: a };
    const src = path.resolve(ctx.workspace, f.suite);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-arena-suite-'));
    fs.cpSync(src, tmp, { recursive: true });
    const suiteJson = path.join(tmp, 'suite.json');
    const prev = fs.existsSync(suiteJson) ? JSON.parse(fs.readFileSync(suiteJson, 'utf8')) : {};
    fs.writeFileSync(suiteJson, JSON.stringify({ ...prev, arms }, null, 2));
    const outDir = path.resolve(typeof f.out === 'string' ? f.out : path.join('eval-results', `arena-${path.basename(src)}-${stamp()}`));
    try {
      const rows = await runEval({ suiteDir: tmp, outDir, baseConfig: ctx.config, repeats: f.repeats ? Number(f.repeats) : undefined, log: (s) => ctx.write(s) });
      ctx.write(`\n${summarizeScores(rows)}\n\nReport: ${outDir}/report.md`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return 0;
  }
  const prompt = f._.join(' ').trim() || (typeof f.prompt === 'string' ? f.prompt : '');
  if (!prompt) {
    ctx.write('give the task as a prompt: tug arena --models a,b "fix the failing test"');
    return 2;
  }
  const names: Record<string, string> = {};
  [...models, ...agents].forEach((m, i) => (names[String.fromCharCode(65 + i)] = m));
  const printer = new StreamPrinter(ctx.write, names);
  const num = (k: string) => (f[k] !== undefined && f[k] !== true ? Number(f[k]) : undefined);
  const r = await runArena({
    config: ctx.config,
    workspace: ctx.workspace,
    models,
    agents,
    prompt,
    judge: typeof f.judge === 'string' ? f.judge : undefined,
    check: typeof f.check === 'string' ? f.check : undefined,
    mode: typeof f.mode === 'string' ? (isPermissionMode(f.mode) ? f.mode : (() => { throw new Error(invalidModeMessage(f.mode)); })()) : undefined,
    discard: !!f.discard,
    verifyGoal: !!f['verify-goal'],
    parallel: num('parallel'),
    budget: { maxTokens: num('budget-tokens'), maxCostUsd: num('budget-usd'), maxTurns: num('max-turns') },
    onEvent: f.quiet ? undefined : (l, e) => printer.event(l, e),
    requestPermission: approvalVia(io, false),
    log: (s) => ctx.write(s),
  });
  printer.flush();
  const out = path.resolve(ctx.workspace, typeof f.out === 'string' ? f.out : path.join('.tugline', 'arena', `${stamp()}.md`));
  writeArenaReport(out, r);
  ctx.write(`\n${r.report}\n\nReport: ${out}\nRun: ${r.run} · bench records: ${r.outDir} (tug bench --compare ${r.outDir})`);
  if (f.discard) return 0;
  return pickAndApply(ctx.config, ctx.workspace, r, typeof f.pick === 'string' ? f.pick : undefined, io, f);
}

/** `tug arena` entry used by the CLI registration (eval/commands.ts). */
export async function arenaCliCommand(argv: string[], ctx: { config: HarnessConfig; workspace: string; write: (t: string) => void }): Promise<number> {
  let rl: readline.Interface | undefined;
  const ask = process.stdin.isTTY
    ? async (q: string, options?: string[]) => {
        rl ??= readline.createInterface({ input: process.stdin, output: process.stderr });
        return rl.question(`${q}${options ? ` [${options.join('/')}]` : ''} `);
      }
    : undefined;
  try {
    return await arenaCli(argv, ctx, ask);
  } catch (e) {
    ctx.write(`arena: ${(e as Error).message}`);
    return 1;
  } finally {
    rl?.close();
  }
}

// ------------------------------------------------------------------ /arena in a chat

interface LiveArena {
  control: ArenaControl;
  abort: AbortController;
  done: Promise<ArenaResult | Error>;
  result?: ArenaResult;
}
const live = new Map<string, LiveArena>();

registerSlashCommand({
  name: 'arena',
  description: 'several models or agents on one task, side by side in parallel worktrees; pick the winner',
  usage: 'start --models a,b [--agents cline] "<prompt>" | status | steer <label> <text> | stop [label] | pick <label> | discard',
  async run(args, ctx) {
    const argv = splitArgs(args);
    const key = ctx.workspace;
    const cur = live.get(key);
    const sub = argv[0] ?? 'status';
    if (sub === 'start') {
      if (cur && !cur.result) return void ctx.write('an arena is already running here: /arena status, /arena stop');
      const f = parseFlags(argv.slice(1), ['quiet']);
      const models = typeof f.models === 'string' ? f.models.split(',').filter(Boolean) : [];
      const agents = typeof f.agents === 'string' ? f.agents.split(',').filter(Boolean) : [];
      const prompt = f._.join(' ').trim();
      if (models.length + agents.length < 2 || !prompt) return void ctx.write('usage: /arena start --models a,b [--agents cline] "<prompt>"');
      const control: ArenaControl = {};
      const abort = new AbortController();
      const names: Record<string, string> = {};
      [...models, ...agents].forEach((m, i) => (names[String.fromCharCode(65 + i)] = m));
      const printer = new StreamPrinter(ctx.write, names);
      const entry: LiveArena = { control, abort, done: undefined as any };
      entry.done = runArena({ config: ctx.config, workspace: ctx.workspace, models, agents, prompt, history: ctx.agent?.messages?.slice(), check: typeof f.check === 'string' ? f.check : undefined, judge: typeof f.judge === 'string' ? f.judge : undefined, mode: 'acceptEdits', control, signal: abort.signal, onEvent: (l, e) => (e.type === 'tool_start' || e.type === 'arena_status' ? printer.event(l, e) : undefined) }).then(
        (r) => {
          entry.result = r;
          ctx.write(`${r.report}\n\nPick the winner with /arena pick <label> (or /arena discard).`);
          return r;
        },
        (e: Error) => {
          live.delete(key);
          ctx.write(`arena failed: ${e.message}`);
          return e;
        },
      );
      live.set(key, entry);
      ctx.write(`arena started: ${Object.entries(names).map(([l, m]) => `${l}=${m}`).join(', ')}`);
      return;
    }
    if (!cur) return void ctx.write('no arena here. /arena start --models a,b "<prompt>"');
    if (sub === 'status') {
      const st = cur.control.status?.() ?? [];
      return void ctx.write(st.map((s) => `${s.label} ${s.model} (${s.kind}): ${s.state}${s.activity ? ` · ${s.activity}` : ''}`).join('\n') + (cur.result ? `\nfinished; run ${cur.result.run}` : ''));
    }
    if (sub === 'steer') return void ctx.write(cur.control.steer?.(argv[1] ?? '', argv.slice(2).join(' ')) ? `steered ${argv[1]}` : `${argv[1]} is not running`);
    if (sub === 'stop') {
      cur.control.stop?.(argv[1]);
      if (!argv[1]) cur.abort.abort();
      return void ctx.write(argv[1] ? `stopping ${argv[1]}` : 'stopping the arena');
    }
    const r = cur.result ?? (await cur.done);
    if (r instanceof Error) return void ctx.write(r.message);
    if (sub === 'discard') {
      live.delete(key);
      return void (await arenaCli(['discard', r.run!], { config: ctx.config, workspace: ctx.workspace, write: ctx.write }));
    }
    if (sub === 'pick') {
      live.delete(key);
      return void (await pickAndApply(ctx.config, ctx.workspace, r, argv[1], { write: ctx.write, ask: ctx.ask }, {}));
    }
    ctx.write('usage: /arena start|status|steer|stop|pick|discard');
  },
});
