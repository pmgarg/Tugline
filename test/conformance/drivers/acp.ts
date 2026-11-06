/** V0.1 driver: ACP (`tug --acp`, the Zed / JetBrains protocol), spawned, with a scripted ACP client playing the editor. */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { CLI, TSX } from '../harness.js';
import type { HumanPrompt, SurfaceDriver } from '../types.js';

export const driver: SurfaceDriver = {
  id: 'acp',
  label: 'ACP (tug --acp)',
  async run(ctx) {
    const child = spawn(process.execPath, ['--import', TSX, CLI, '--acp'], { cwd: ctx.workspace, env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    ctx.defer(async () => {
      child.stdin!.end();
      await new Promise<void>((r) => {
        const t = setTimeout(() => (child.kill('SIGKILL'), r()), 5000);
        child.once('exit', () => (clearTimeout(t), r()));
      });
    });
    const out: string[] = [];
    const prompts: HumanPrompt[] = [];
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as any, Readable.toWeb(child.stdout!) as any);
    const conn = new acp.ClientSideConnection(
      () => ({
        async sessionUpdate(p) {
          const u: any = p.update;
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') out.push(u.content.text);
          for (const c of u.content && Array.isArray(u.content) ? u.content : []) if (c?.content?.type === 'text') out.push(c.content.text);
          if (u.rawOutput) out.push(JSON.stringify(u.rawOutput));
        },
        async requestPermission(p) {
          const h = { tool: String(p.toolCall.kind ?? ''), title: p.toolCall.title ?? undefined, reason: JSON.stringify(p.toolCall.content ?? '') };
          prompts.push(h);
          const answer = await ctx.human(h);
          const pick = p.options.find((o) => (answer === 'allow' ? o.kind === 'allow_once' : o.kind === 'reject_once'));
          return { outcome: { outcome: 'selected', optionId: pick!.optionId } };
        },
        async readTextFile() {
          throw acp.RequestError.resourceNotFound('client fs not offered');
        },
        async writeTextFile() {
          throw acp.RequestError.resourceNotFound('client fs not offered');
        },
      }),
      stream,
    );
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const s = await conn.newSession({ cwd: ctx.workspace, mcpServers: [] });
    const res = await conn.prompt({ sessionId: s.sessionId, prompt: [{ type: 'text', text: ctx.prompt }] });
    out.push(err);
    return { output: out.join('\n'), prompts, finalText: res.stopReason };
  },
};
