/**
 * V0.1 driver: the generic signed webhook channel (H3). The secret is in the vault, the sender pairs as owner, then
 * the prompt arrives as an HMAC-signed POST; the reply comes back in the HTTP response.
 */
import http from 'node:http';
import { ChannelGateway } from '../../../src/channels/gateway.js';
import { createAdapters, createChannelsHandler } from '../../../src/channels/cli.js';
import { signBody } from '../../../src/core/schedule/webhook.js';
import { SecretVault } from '../../../src/core/secrets/vault.js';
import { loadConfig } from '../../../src/core/config.js';
import { withChannelConfig } from './channel-telegram.js';
import fs from 'node:fs';
import path from 'node:path';
import type { SurfaceDriver } from '../types.js';

const SECRET = 'conformance-webhook-channel-secret';

export const driver: SurfaceDriver = {
  id: 'channel-webhook',
  label: 'Signed webhook channel (HMAC)',
  async run(ctx) {
    withChannelConfig(ctx);
    const file = path.join(ctx.ohHome, 'config.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.channels = { ...c.channels, webhook: { enabled: true } };
    fs.writeFileSync(file, JSON.stringify(c, null, 2));
    const config = loadConfig({ workspace: ctx.workspace });
    new SecretVault(config.homeDir).set('channel-webhook', SECRET);
    const { adapters, problems } = await createAdapters(config);
    if (problems.length) throw new Error(problems.join('; '));
    const gw = new ChannelGateway({ config, workspace: ctx.workspace, adapters, secrets: [SECRET] });
    ctx.defer(() => gw.close());
    const handler = createChannelsHandler(gw, adapters);
    const srv = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    ctx.defer(() => new Promise<void>((r) => srv.close(() => r())));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/channels/webhook`;
    const post = async (text: string) => {
      const body = JSON.stringify({ sender: 'svc-77', text });
      const r = await fetch(url, { method: 'POST', body, headers: { 'x-oh-signature': signBody(SECRET, body) } });
      const j: any = await r.json();
      return (j.replies ?? []) as string[];
    };
    await post(`/pair ${gw.pairing.createCode('webhook', 'owner', 60_000)}`);
    if (gw.pairing.trustOf('webhook', 'svc-77') !== 'owner') throw new Error('pairing failed');
    const replies = await post(ctx.prompt);
    return { output: replies.join('\n'), prompts: [] };
  },
};
