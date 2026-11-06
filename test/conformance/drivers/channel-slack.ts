/**
 * V0.1 driver: Slack (H3). A signed Events API request reaches the channels HTTP handler (signature verified), the
 * gateway runs the owner's message, replies go to a mocked Slack Web API.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { SlackAdapter, slackSignature } from '../../../src/channels/slack.js';
import { ChannelGateway } from '../../../src/channels/gateway.js';
import { createChannelsHandler } from '../../../src/channels/cli.js';
import { loadConfig } from '../../../src/core/config.js';
import { withChannelConfig } from './channel-telegram.js';
import type { SurfaceDriver } from '../types.js';

const SIGNING = 'conformance-slack-signing-secret';
const BOT = 'xoxb-conformance-slack-token';

export const driver: SurfaceDriver = {
  id: 'channel-slack',
  label: 'Slack channel (signed Events API, mocked Web API)',
  async run(ctx) {
    const sent: string[] = [];
    let ts = 1;
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (typeof body.text === 'string') sent.push(body.text);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ts: `1700000000.0000${ts++}`, channel: body.channel }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    ctx.defer(() => new Promise<void>((r) => api.close(() => r())));
    withChannelConfig(ctx);
    const config = loadConfig({ workspace: ctx.workspace });
    const slack = new SlackAdapter({ token: BOT, signingSecret: SIGNING, apiBase: `http://127.0.0.1:${(api.address() as any).port}`, homeDir: config.homeDir });
    const gw = new ChannelGateway({ config, workspace: ctx.workspace, adapters: { slack }, secrets: [BOT, SIGNING] });
    ctx.defer(() => gw.close());
    // the handler answers Slack within 3 s and processes the message after; keep the promise to wait for it
    const pending: Promise<void>[] = [];
    const handle = gw.handle.bind(gw);
    gw.handle = (m) => {
      const p = handle(m);
      pending.push(p);
      return p;
    };
    const handler = createChannelsHandler(gw, { slack });
    const srv = http.createServer((req, res) => void handler(req, res).then((done) => done || res.writeHead(404).end()));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    ctx.defer(() => new Promise<void>((r) => srv.close(() => r())));
    const port = (srv.address() as any).port;
    const post = async (text: string) => {
      const body = JSON.stringify({ type: 'event_callback', event_id: `Ev${crypto.randomBytes(6).toString('hex')}`, event: { type: 'message', user: 'U77', channel: 'D77', ts: `${Date.now() / 1000}`, text } });
      const t = String(Math.floor(Date.now() / 1000));
      const r = await fetch(`http://127.0.0.1:${port}/channels/slack/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': t, 'x-slack-signature': slackSignature(SIGNING, t, body) }, body });
      if (r.status !== 200) throw new Error(`slack event refused: ${r.status}`);
      for (let i = 0; i < 100 && !pending.length; i++) await new Promise((res) => setTimeout(res, 10));
      await Promise.all(pending.splice(0));
    };
    await post(`/pair ${gw.pairing.createCode('slack', 'owner', 60_000)}`);
    if (gw.pairing.trustOf('slack', 'U77') !== 'owner') throw new Error('pairing failed');
    await post(ctx.prompt);
    return { output: sent.join('\n'), prompts: [] };
  },
};
