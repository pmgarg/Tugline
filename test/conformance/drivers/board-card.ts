/**
 * V0.1 driver: a task-board card (v1.2 N48). The scenario's prompt becomes a card; the card's agent runs in its
 * own git worktree (same core: Agent, permission engine, sandbox, journal); the human answers its prompts and the
 * merge (D2 ask path) through the board's UI hook. The workspace is made a git repository first, as a board needs.
 */
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../../../src/core/config.js';
import { Board } from '../../../src/core/context/worktreeBoard.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

export function gitInit(ws: string): void {
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: ws, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '--allow-empty', '-m', 'conformance base');
}

export const driver: SurfaceDriver = {
  id: 'board-card',
  label: 'Task board card (one worktree per card)',
  async run(ctx) {
    gitInit(ctx.workspace);
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const config = loadConfig({ workspace: ctx.workspace });
    const board = await Board.open(config, ctx.workspace);
    const ui = {
      onEvent: (_id: string, e: any) => {
        if (e.type === 'text_delta') out.push(e.text);
        else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
        else if (e.type === 'notice') out.push(e.message);
      },
      requestPermission: async (req: any) => {
        const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
        prompts.push(p);
        return { decision: await ctx.human(p) };
      },
    };
    const card = await board.add({ prompt: ctx.prompt, title: `conformance ${ctx.scenario}` });
    ctx.defer(() => board.discard(card.id).catch(() => undefined));
    const done = await board.start(card.id, { ui });
    // whatever the card produced is offered for merge like a user would: conflict check, permission, verify
    if (done.state === 'review') {
      const m = await board.merge(card.id, { ui });
      out.push(m.message);
    }
    out.push(done.activity ?? '');
    return { stopReason: done.stopReason, finalText: done.activity, output: out.join('\n'), prompts };
  },
};
