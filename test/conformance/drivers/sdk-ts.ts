/** V0.1 driver: the TypeScript SDK (`createAgent` from src/sdk), in process. */
import { createAgent } from '../../../src/sdk/index.js';
import type { SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'sdk-ts',
  label: 'TypeScript SDK (createAgent)',
  async run(ctx) {
    const out: string[] = [];
    const prompts: { tool?: string; title?: string; detail?: string; reason?: string }[] = [];
    // The SDK builds its config with loadConfig (user config from $HOME, workspace trust, managed policy).
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
    const r = await agent.run(ctx.prompt);
    out.push(r.finalText ?? '');
    return { stopReason: r.stopReason, finalText: r.finalText, output: out.join('\n'), prompts };
  },
};
