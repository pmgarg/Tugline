/** V0.1 driver: `tug serve` JSON-RPC over WebSocket (G2), the server in process with its default config path (loadConfig). */
import { startServer } from '../../../src/server/server.js';
import { OhClient } from '../../../src/server/client.js';
import { loadConfig } from '../../../src/core/config.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'serve-jsonrpc',
  label: 'tug serve (JSON-RPC over WebSocket)',
  async run(ctx) {
    // the server process config, as `tug serve` builds it; sessions use the default configFor (loadConfig per workspace)
    const config = loadConfig({ workspace: ctx.workspace });
    const srv = await startServer({ workspace: ctx.workspace, config, port: 0 });
    ctx.defer(() => srv.close());
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const client = await OhClient.connect(srv.url, srv.token, {
      onEvent: (_s, e) => {
        if (e.type === 'text_delta') out.push(e.text);
        else if (e.type === 'tool_end') out.push(String(e.output ?? ''));
        else if (e.type === 'notice') out.push(e.message);
      },
      onPermission: async (_s, req) => {
        const p = { tool: req.tool, title: req.title, detail: req.detail, reason: req.reason };
        prompts.push(p);
        return { decision: await ctx.human(p) };
      },
    });
    ctx.defer(() => client.close());
    const s = await client.createSession({ workspace: ctx.workspace });
    const r = await client.prompt(s.sessionId, ctx.prompt);
    out.push(r.finalText ?? '');
    return { stopReason: r.stopReason, finalText: r.finalText, output: out.join('\n'), prompts };
  },
};
