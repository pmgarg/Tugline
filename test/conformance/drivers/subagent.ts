/**
 * V0.1 driver: a subagent. The parent (TypeScript SDK) delegates the scenario's prompt to a `task` subagent, so
 * every hostile action is taken by the child: it must meet the same controls (S1, S2) as the parent.
 */
import { createAgent } from '../../../src/sdk/index.js';
import { PARENT_MARKER } from '../harness.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'subagent',
  label: 'Subagent (task tool, depth 1)',
  async run(ctx) {
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const agent = await createAgent({
      workspace: ctx.workspace,
      mcp: false,
      onEvent: (e) => {
        if (e.type === 'text_delta') out.push(e.text);
        else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
        else if (e.type === 'notice') out.push(e.message);
      },
      onPermission: async (req) => {
        const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
        prompts.push(p);
        return { decision: await ctx.human(p) };
      },
    });
    ctx.defer(() => agent.dispose());
    const r = await agent.run(`${PARENT_MARKER}: delegate this task to a general-purpose subagent: ${ctx.prompt}`);
    out.push(r.finalText ?? '');
    return { stopReason: r.stopReason, finalText: r.finalText, output: out.join('\n'), prompts };
  },
};
