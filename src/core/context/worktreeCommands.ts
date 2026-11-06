/**
 * Task board surfaces (v1.2 N48): `tug board …` in the CLI, `/board …` in every
 * chat surface (CLI REPL, VS Code, `tug serve` via session/command), and the
 * optional board tools that let an agent decompose a goal into linked cards
 * (Cline Kanban's "ask the sidebar agent to add and link tasks").
 *
 * The VS Code Kanban view (vscode/src/kanban*.ts) drives the same Board class.
 */
import readline from 'node:readline/promises';
import type { HarnessConfig } from '../config.js';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { registerToolProvider } from '../tools/registry.js';
import { ToolError, type ToolDef } from '../tools/types.js';
import type { PermissionAnswer, PermissionRequest } from '../types.js';
import { Board, cardTaint, type Card, type BoardUI } from './worktreeBoard.js';

const COLUMNS: { title: string; states: Card['state'][] }[] = [
  { title: 'Backlog', states: ['backlog', 'interrupted'] },
  { title: 'Running', states: ['running'] },
  { title: 'Review', states: ['review', 'conflict', 'failed'] },
  { title: 'Merged', states: ['merged'] },
];

export function renderBoard(cards: Card[]): string {
  const out: string[] = [];
  for (const col of COLUMNS) {
    const cs = cards.filter((c) => col.states.includes(c.state));
    out.push(`${col.title} (${cs.length})`);
    for (const c of cs) {
      const flag = c.state === 'conflict' ? ` ⚠ conflict: ${(c.conflicts ?? []).join(', ')}` : c.state === 'failed' ? ` ✗ ${c.error ?? 'failed'}` : c.state === 'interrupted' ? ' (interrupted; start to resume)' : '';
      const check = c.check ? ` [check: ${c.check.state}]` : '';
      const deps = c.dependsOn.length ? ` ← after ${c.dependsOn.join(', ')}` : '';
      const taint = cardTaint(c) ? ' ⚠ untrusted input' : '';
      out.push(`  ${c.id}  ${c.title}${deps}${flag}${check}${taint}`);
      out.push(`      base ${c.base.slice(0, 10)} "${c.baseSubject}" on ${c.baseRef} · ${c.branch}${c.activity ? ` · ${c.activity}` : ''}`);
    }
  }
  const trashed = cards.filter((c) => c.state === 'trashed').length;
  if (trashed) out.push(`(${trashed} in trash)`);
  return out.join('\n');
}

function parse(argv: string[]): { _: string[]; f: Record<string, string | true> } {
  const _: string[] = [];
  const f: Record<string, string | true> = {};
  const bool = new Set(['carry-dirty', 'wait', 'force', 'yes', 'json', 'since-last', 'keep-branch']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      // `tug board exec <id> -- <command…>`: everything after `--` is the command
      f['--'] = argv.slice(i + 1).join(' ');
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) f[k] = v;
      else if (bool.has(k)) f[k] = true;
      else f[k] = argv[++i] ?? '';
    } else _.push(a);
  }
  return { _, f };
}

/** Split a slash-command argument line, honouring quotes. */
export function splitArgs(s: string): string[] {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] ?? m[3]));
}

export const BOARD_USAGE = `tug board                          list cards by column (--json for machine output)
tug board add "<prompt>" [--title t] [--issue <n|url>] [--pr <n>] [--after a,b] [--carry-dirty] [--profile p] [--agent cline|claude-code|codex|…]
tug board start <id>… [--wait]      run cards in their worktrees (parallel, up to worktree.maxParallel)
tug board run "<prompt>"            add a card, run it, wait
tug board say <id> "<text>"         follow-up message to a card (resumes its session)
tug board show <id>                 base commit (and how far behind HEAD), state, check, conflicts, diff stat
tug board diff <id> [--since-last]  the card's patch (or only since the last message)
tug board log <id>                  the card's transcript (its agent's conversation or output)
tug board exec <id> -- <command>    run a command in the card's worktree (permission engine, OS sandbox)
tug board check <id>                conflict check against HEAD and your uncommitted files
tug board merge <id> [--force] [--yes]  conflict check → approval → verify in a scratch tree → land
tug board discard <id> [--keep-branch]   trash: remove the worktree (and branch)
tug board link <id> <after-id>      the card starts after <after-id> is merged
tug board pr <id>                   commands to push the card's branch and open a PR
tug board gc                        remove leftover worktrees no card owns`;

interface Io {
  write: (t: string) => void;
  ask?: (q: string, options?: string[]) => Promise<string>;
}

/**
 * Review F4: `--yes` confirms the board's own merge step (`worktree_merge`) and nothing else. Card agents go through
 * the normal permission engine and mode: their questions go to the terminal, or are denied without one.
 */
function permissionVia(io: Io, yes: boolean): BoardUI['requestPermission'] {
  const ask = io.ask;
  if (yes)
    return async (r: PermissionRequest, cardId: string): Promise<PermissionAnswer> => {
      if (r.tool === 'worktree_merge') return { decision: 'allow', by: 'cli_flag' } as PermissionAnswer;
      if (!ask) return { decision: 'deny', feedback: 'no one is available to approve this (--yes only confirms merges)' };
      const a = await ask(`[${cardId}] ${r.title}${r.reason ? ` (${r.reason})` : ''}\n${(r.detail ?? '').split('\n').slice(0, 15).join('\n')}\nAllow?`, ['yes', 'no']);
      return { decision: /^y/i.test(a.trim()) ? 'allow' : 'deny' };
    };
  if (!io.ask) return undefined;
  return async (r: PermissionRequest, cardId: string): Promise<PermissionAnswer> => {
    const a = await io.ask!(`[${cardId}] ${r.title}${r.reason ? ` (${r.reason})` : ''}\n${(r.detail ?? '').split('\n').slice(0, 15).join('\n')}\nAllow?`, ['yes', 'no']);
    return { decision: /^y/i.test(a.trim()) ? 'allow' : 'deny' };
  };
}

export async function boardCommand(argv: string[], config: HarnessConfig, workspace: string, io: Io): Promise<number> {
  const { _, f } = parse(argv);
  const [sub = 'list', ...rest] = _;
  if (f.yes) {
    const mp = config.managed?.policy as { disableAutoMode?: boolean; disableYoloMode?: boolean } | undefined;
    if (mp?.disableAutoMode || mp?.disableYoloMode) {
      io.write(`error [forbidden_by_managed_policy]: --yes (approve merges without asking) is forbidden by your organisation's managed policy (${mp.disableAutoMode ? 'disableAutoMode' : 'disableYoloMode'}); answer the merge prompt instead.`);
      return 2;
    }
    io.write('warning: --yes approves the board\'s merge step without asking (recorded in the journal); card agents still ask you for their commands and edits.');
  }
  const board = await Board.open(config, workspace);
  const ui: BoardUI = {
    onEvent: (id, e) => {
      if (e.type === 'tool_start') io.write(`[${id}] ⏺ ${e.title}`);
      else if (e.type === 'refusal') io.write(`[${id}] ⛔ ${e.tool}: ${e.reason}`);
      else if (e.type === 'run_end') io.write(`[${id}] ■ ${e.stopReason}`);
    },
    requestPermission: permissionVia(io, !!f.yes),
  };
  const show = async (id: string) => {
    const c = board.get(id);
    const b = await board.baseInfo(c.id);
    const d = await board.diff(c.id).catch(() => undefined);
    io.write(`${c.id}: ${c.title}\n  state ${c.state}${c.error ? ` (${c.error})` : ''} · branch ${c.branch}${c.worktree ? ` · worktree ${c.worktree}` : ''}\n  base ${b.base} "${b.subject}" on ${b.ref}${b.behind ? ` · ${b.behind} commit(s) behind HEAD` : ' · up to date with HEAD'}${c.check ? `\n  check: ${c.check.state}${c.check.command ? ` (\`${c.check.command}\`)` : ''}${c.check.reason ? ` — ${c.check.reason}` : ''}` : ''}${c.conflicts?.length ? `\n  conflicts: ${c.conflicts.join(', ')}` : ''}${c.dependsOn.length ? `\n  after: ${c.dependsOn.join(', ')}` : ''}${d?.stat ? `\n${d.stat.split('\n').map((l) => `  ${l}`).join('\n')}` : ''}`);
  };
  switch (sub) {
    case 'list':
    case 'ls':
      if (f.json) io.write(JSON.stringify(board.list(), null, 2));
      else io.write(board.list().length ? renderBoard(board.list()) : 'The board is empty. Add a card: tug board add "<prompt>"');
      return 0;
    case 'add':
    case 'run': {
      const c = await board.add({ prompt: rest.join(' ') || undefined, title: typeof f.title === 'string' ? f.title : undefined, issue: typeof f.issue === 'string' ? f.issue : undefined, pr: f.pr ? Number(f.pr) : undefined, dependsOn: typeof f.after === 'string' ? f.after.split(',').filter(Boolean) : undefined, carryDirty: !!f['carry-dirty'], profile: typeof f.profile === 'string' ? f.profile : undefined, agent: typeof f.agent === 'string' ? f.agent : undefined });
      io.write(`added ${c.id} (base ${c.base.slice(0, 10)} "${c.baseSubject}")`);
      if (sub === 'add') return 0;
      const r = await board.start(c.id, { ui });
      await show(r.id);
      return r.state === 'review' ? 0 : 1;
    }
    case 'start': {
      if (!rest.length) throw new Error('usage: tug board start <id>…');
      const runs = rest.map((id) => board.start(board.get(id).id, { ui }));
      const res = await Promise.all(runs.map((p) => p.catch((e: Error) => e)));
      let code = 0;
      for (const r of res) {
        if (r instanceof Error) {
          io.write(`error: ${r.message}`);
          code = 1;
        } else {
          io.write(`${r.id}: ${r.state}${r.error ? ` (${r.error})` : ''}${r.stats ? ` · ${r.stats.turns} turns · ${r.stats.tokens} tok` : ''}`);
          if (r.state !== 'review') code = 1;
        }
      }
      return code;
    }
    case 'say': {
      const [id, ...text] = rest;
      const r = await board.start(board.get(id).id, { ui, followUp: text.join(' ') });
      io.write(`${r.id}: ${r.state}`);
      return 0;
    }
    case 'show':
      await show(rest[0]);
      return 0;
    case 'diff': {
      const d = await board.diff(board.get(rest[0]).id, { sinceLastRun: !!f['since-last'] });
      io.write(d.patch || '(no changes)');
      return 0;
    }
    case 'log':
    case 'transcript':
      io.write(board.transcript(board.get(rest[0]).id));
      return 0;
    case 'exec': {
      const command = typeof f['--'] === 'string' ? f['--'] : rest.slice(1).join(' ');
      if (!rest[0] || !command.trim()) throw new Error('usage: tug board exec <id> -- <command>');
      const r = await board.exec(board.get(rest[0]).id, command, { ask: io.ask ? async (cmd, reason) => /^y/i.test((await io.ask!(`Run \`${cmd}\` in card ${rest[0]}? (${reason})`, ['yes', 'no'])).trim()) : undefined });
      if (!r.ran) {
        io.write(`not run: ${r.reason}`);
        return 1;
      }
      io.write(`${r.output.trimEnd()}\n[exit code ${r.exitCode}]`);
      return r.exitCode === 0 ? 0 : 1;
    }
    case 'check': {
      const k = await board.conflicts(board.get(rest[0]).id);
      io.write(k.content.length || k.dirty.length ? `conflicts: ${k.content.join(', ') || '-'}; touches your uncommitted files: ${k.dirty.join(', ') || '-'}` : 'no conflicts with HEAD or your uncommitted files');
      return k.content.length || k.dirty.length ? 1 : 0;
    }
    case 'merge': {
      const r = await board.merge(board.get(rest[0]).id, { ui, force: !!f.force });
      io.write(r.message);
      return r.merged ? 0 : 1;
    }
    case 'discard':
    case 'trash': {
      const c = await board.discard(board.get(rest[0]).id, { keepBranch: !!f['keep-branch'] });
      io.write(`${c.id} moved to trash; worktree removed${f['keep-branch'] ? `, branch ${c.branch} kept` : ''}`);
      return 0;
    }
    case 'link': {
      const c = board.link(rest[0], rest[1]);
      io.write(`${c.id} now starts after ${c.dependsOn.join(', ')}`);
      return 0;
    }
    case 'pr':
      io.write(board.prCommands(rest[0]).join('\n'));
      return 0;
    case 'gc': {
      const r = await board.gc();
      io.write(r.length ? `removed ${r.length} leftover worktree(s):\n${r.join('\n')}` : 'nothing to clean');
      return 0;
    }
    default:
      io.write(BOARD_USAGE);
      return 2;
  }
}

registerCliCommand({
  name: 'board',
  description: 'task board: each card is an agent session in its own git worktree (Kanban)',
  usage: '[list|add|start|run|say|show|diff|log|exec|check|merge|discard|link|pr|gc]',
  help: () => BOARD_USAGE,
  needsModel: true,
  async run(argv, ctx) {
    const tty = process.stdin.isTTY;
    let rl: readline.Interface | undefined;
    const ask = tty
      ? async (q: string, options?: string[]) => {
          rl ??= readline.createInterface({ input: process.stdin, output: process.stderr });
          return rl.question(`${q}${options ? ` [${options.join('/')}]` : ''} `);
        }
      : undefined;
    try {
      return await boardCommand(argv, ctx.config, ctx.workspace, { write: ctx.write, ask });
    } catch (e) {
      ctx.write(`error: ${(e as Error).message}`);
      return 1;
    } finally {
      rl?.close();
    }
  },
});

registerSlashCommand({
  name: 'board',
  description: 'task board: cards that each run an agent in their own worktree',
  usage: '[list|add "<prompt>"|start <id>|show <id>|diff <id>|check <id>|merge <id>|discard <id>|link <id> <after>|pr <id>]',
  async run(args, ctx) {
    const argv = splitArgs(args);
    // In a chat, `start` returns at once: the card runs in the background and the board shows its progress.
    if (argv[0] === 'start' && argv[1]) {
      const b = await Board.open(ctx.config, ctx.workspace);
      for (const id of argv.slice(1)) {
        const c = b.get(id);
        void b.start(c.id).then((r) => ctx.write(`card ${r.id}: ${r.state}`), (e: Error) => ctx.write(`card ${c.id}: ${e.message}`));
        ctx.write(`started ${c.id} in ${c.branch}`);
      }
      return;
    }
    try {
      await boardCommand(argv, ctx.config, ctx.workspace, { write: ctx.write, ask: ctx.ask });
    } catch (e) {
      ctx.write(`board: ${(e as Error).message}`);
    }
  },
});

// ------------------------------------------------------------------ agent tools (opt-in)

const addCardTool: ToolDef<{ title: string; prompt: string; after?: string[] }> = {
  name: 'board_add_card',
  kind: 'meta',
  description: 'Add a card to the task board. Each card later runs as its own agent session in its own git worktree, so write the prompt as a complete, self-contained task. Use `after` to start a card only once the listed cards are merged. Cards are not started by this tool; the user starts them.',
  parameters: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, after: { type: 'array', items: { type: 'string' }, description: 'ids of cards this one depends on' } }, required: ['title', 'prompt'] },
  title: (a) => `Add card: ${a.title}`,
  // review F9: a tainted session (it read untrusted content) asks a person before it creates work for another agent
  permissionInput: (_a, ctx) => (ctx.taint ? { alwaysAsk: `this session read untrusted content (${ctx.taint}); the card it adds runs as its own agent (it starts tainted)` } : {}),
  async run(a, ctx) {
    if (ctx.depth > 0) throw new ToolError('only the main session can add cards');
    const b = await Board.open(ctx.config, ctx.workspace);
    const c = await b.add({ title: String(a.title), prompt: String(a.prompt), dependsOn: Array.isArray(a.after) ? a.after.map(String) : undefined, ...(ctx.taint ? { taint: `added by a session that had read untrusted content (${ctx.taint})` } : {}) });
    return { output: `added card ${c.id} (${c.branch})${c.dependsOn.length ? `, after ${c.dependsOn.join(', ')}` : ''}` };
  },
};

const listCardsTool: ToolDef<Record<string, never>> = {
  name: 'board_list',
  kind: 'read',
  readOnly: true,
  description: 'List the task board cards with their state, base commit and dependencies.',
  parameters: { type: 'object', properties: {} },
  title: () => 'List board cards',
  async run(_a, ctx) {
    const b = await Board.open(ctx.config, ctx.workspace);
    return { output: renderBoard(b.list()) || '(empty board)' };
  },
};

registerToolProvider({
  id: 'ws24-board',
  // off by default: two more tools for every session would push sessions over the tool-search threshold
  tools: (cfg, env) => (env.depth === 0 && (cfg as any).worktree?.boardTools === true ? [addCardTool, listCardsTool] : []),
});
