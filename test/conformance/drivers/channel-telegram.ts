/**
 * V0.1 driver: Telegram (H3), against a mocked Bot API. The owner pairs with a one-time code, then sends the prompt;
 * the gateway runs it through the real long-poll loop. Channel runs have no approval buttons: asks are denied and
 * reported in the reply. The owner's permission mode is set to the scenario's (channels.ownerMode), as a user would.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { TelegramAdapter } from '../../../src/channels/telegram.js';
import { ChannelGateway } from '../../../src/channels/gateway.js';
import { loadConfig } from '../../../src/core/config.js';
import type { SurfaceDriver } from '../types.js';

const TOKEN = '424242:conformance-telegram-token';

export function withChannelConfig(ctx: { ohHome: string; userConfig: Record<string, unknown> }): void {
  const mode = String(ctx.userConfig.permissionMode ?? 'ask');
  const cfg = { ...ctx.userConfig, channels: { ownerMode: mode, pairedMode: mode, editIntervalMs: 0 } };
  fs.writeFileSync(path.join(ctx.ohHome, 'config.json'), JSON.stringify(cfg, null, 2));
}

export const driver: SurfaceDriver = {
  id: 'channel-telegram',
  label: 'Telegram channel (mocked Bot API, long-poll)',
  async run(ctx) {
    const sent: string[] = [];
    const queue: any[] = [];
    let msgId = 100;
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const m = req.url!.match(/^\/bot([^/]+)\/(\w+)$/);
        const body = raw ? JSON.parse(raw) : {};
        res.writeHead(200, { 'content-type': 'application/json' });
        if (!m || m[1] !== TOKEN) return void res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
        if (m[2] === 'getUpdates') {
          const out = queue.filter((u) => u.update_id >= (body.offset ?? 0));
          return void setTimeout(() => res.end(JSON.stringify({ ok: true, result: out })), out.length ? 0 : 20);
        }
        if (m[2] === 'sendMessage' || m[2] === 'editMessageText') sent.push(String(body.text ?? ''));
        res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId, chat: { id: body.chat_id }, text: body.text } }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    ctx.defer(() => new Promise<void>((r) => api.close(() => r())));
    withChannelConfig(ctx);
    const config = loadConfig({ workspace: ctx.workspace });
    const adapter = new TelegramAdapter({ token: TOKEN, apiBase: `http://127.0.0.1:${(api.address() as any).port}`, pollTimeoutS: 0 });
    const gw = new ChannelGateway({ config, workspace: ctx.workspace, adapters: { telegram: adapter }, secrets: [TOKEN] });
    ctx.defer(() => gw.close());
    const handled: Promise<void>[] = [];
    adapter.start((m) => handled.push(gw.handle(m)));
    ctx.defer(() => adapter.stop());
    let uid = 1;
    const push = (text: string) => queue.push({ update_id: uid++, message: { message_id: uid * 10, from: { id: 77, username: 'owner' }, chat: { id: 77, type: 'private' }, date: Math.floor(Date.now() / 1000), text } });
    const settle = async (n: number) => {
      for (let i = 0; i < 500 && handled.length < n; i++) await new Promise((r) => setTimeout(r, 20));
      await Promise.all(handled);
    };
    push(`/pair ${gw.pairing.createCode('telegram', 'owner', 60_000)}`);
    await settle(1);
    if (gw.pairing.trustOf('telegram', '77') !== 'owner') throw new Error('pairing failed');
    push(ctx.prompt);
    await settle(2);
    return { output: sent.join('\n'), prompts: [] };
  },
};
