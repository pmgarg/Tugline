/**
 * V0.1 driver: an arena contestant (v1.2 N47 SAC1). The scenario runs as contestant A of a two-contestant arena;
 * contestant B is a bystander model on its own endpoint (so the scenario model sees exactly one conversation).
 * Each contestant has its own worktree, budget, sandbox and protected paths; the human answers A's prompts; then
 * the user picks A, and its work is applied through the board merge (D2 ask path).
 */
import http from 'node:http';
import { deepMerge, loadConfig } from '../../../src/core/config.js';
import { applyArenaWinner, runArena } from '../../../src/core/eval/arena.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';
import { gitInit } from './board-card.js';

async function bystander(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Nothing to do.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/v1`, close: () => new Promise((r) => srv.close(() => r())) };
}

export const driver: SurfaceDriver = {
  id: 'arena-contestant',
  label: 'Arena contestant (parallel worktrees)',
  async run(ctx) {
    gitInit(ctx.workspace);
    const by = await bystander();
    ctx.defer(() => by.close());
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const base = loadConfig({ workspace: ctx.workspace });
    const config = deepMerge(base, { profiles: { bystander: { baseUrl: by.url, model: 'bystander', apiKey: 'sk-bystander-000000', contextWindow: 32768, maxOutputTokens: 256, toolMode: 'native' } } });
    const human = async (req: any) => {
      const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
      prompts.push(p);
      return { decision: await ctx.human(p) };
    };
    const r = await runArena({
      config,
      workspace: ctx.workspace,
      models: [ctx.llm.model, 'bystander'],
      prompt: ctx.prompt,
      mode: config.permissionMode,
      requestPermission: (req, who) => (who === 'A' ? human(req) : Promise.resolve({ decision: 'deny' as const })),
      onEvent: (label, e) => {
        if (label !== 'A') return;
        if (e.type === 'text_delta') out.push(e.text);
        else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
        else if (e.type === 'notice') out.push(e.message);
      },
    });
    const a = r.entries.find((e) => e.label === 'A')!;
    out.push(a.finalText);
    if (a.branch) {
      const m = await applyArenaWinner({ config, workspace: ctx.workspace, run: r, pick: 'A', ui: { requestPermission: (req) => human(req) } });
      out.push(m.message);
    }
    return { stopReason: a.stopReason, finalText: a.finalText, output: out.join('\n'), prompts };
  },
};
