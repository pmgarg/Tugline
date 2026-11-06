/**
 * `tug channels …` (SPEC H3) and the mountable HTTP routes for Slack and the
 * generic webhook channel:
 *
 *   POST /channels/slack/events   Slack Events API (signing-secret verified)
 *   POST /channels/webhook        generic signed webhook (reply in the response)
 *
 * Server mode can mount `createChannelsHandler(...)` the same way as the
 * trigger hooks; `tug channels start` runs its own 127.0.0.1 listener.
 */
import http from 'node:http';
import { registerCliCommand } from '../core/commands.js';
import type { HarnessConfig } from '../core/config.js';
import { SecretVault } from '../core/secrets/vault.js';
import { parseFlags } from '../core/schedule/cli.js';
import { ChannelGateway } from './gateway.js';
import { PairingStore } from './pairing.js';
import { readRequestBody, SlackAdapter } from './slack.js';
import { TelegramAdapter } from './telegram.js';
import { channelsConfig, type ChannelAdapter, type ChannelName } from './types.js';
import { WebhookChannelAdapter } from './webhook.js';

const CHANNELS: ChannelName[] = ['telegram', 'slack', 'webhook'];

/** Build the enabled adapters, with tokens from the secrets vault (never from config files). */
export async function createAdapters(config: HarnessConfig, vault = new SecretVault(config.homeDir)): Promise<{ adapters: Partial<Record<ChannelName, ChannelAdapter>>; secrets: string[]; problems: string[] }> {
  const cc = channelsConfig(config);
  const adapters: Partial<Record<ChannelName, ChannelAdapter>> = {};
  const secrets: string[] = [];
  const problems: string[] = [];
  const get = async (name: string) => {
    try {
      const v = await vault.resolve(name);
      secrets.push(v);
      return v;
    } catch {
      problems.push(`secret "${name}" is not set (tug channels token ${name})`);
      return undefined;
    }
  };
  if (cc.telegram.enabled) {
    const token = await get(cc.telegram.tokenSecret);
    if (token) adapters.telegram = new TelegramAdapter({ token, apiBase: cc.telegram.apiBase, pollTimeoutS: cc.telegram.pollTimeoutS });
  }
  if (cc.slack.enabled) {
    const token = await get(cc.slack.tokenSecret);
    const signing = await get(cc.slack.signingSecret);
    if (token && signing) adapters.slack = new SlackAdapter({ token, signingSecret: signing, apiBase: cc.slack.apiBase, homeDir: config.homeDir });
  }
  if (cc.webhook.enabled) {
    const secret = await get(cc.webhook.secret);
    if (secret) adapters.webhook = new WebhookChannelAdapter(secret);
  }
  return { adapters, secrets, problems };
}

export type ChannelsHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createChannelsHandler(gw: ChannelGateway, adapters: Partial<Record<ChannelName, ChannelAdapter>>): ChannelsHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method !== 'POST' || !url.pathname.startsWith('/channels/')) return false;
    let body: string;
    try {
      body = await readRequestBody(req);
    } catch {
      send(res, 413, { error: 'body too large' });
      return true;
    }
    if (url.pathname === '/channels/slack/events' && adapters.slack instanceof SlackAdapter) {
      const r = adapters.slack.handleEvent(req.headers, body);
      if (r.status === 401 || r.status === 403) gw.authFailure('slack', `${r.status} ${JSON.stringify(r.body ?? {})}`);
      send(res, r.status, r.body);
      if (r.message) void gw.handle(r.message); // Slack wants the 200 within 3 s
      return true;
    }
    if (url.pathname === '/channels/webhook' && adapters.webhook instanceof WebhookChannelAdapter) {
      const sig = req.headers['x-oh-signature'] ?? req.headers['x-hub-signature-256'];
      const p = adapters.webhook.parse(Buffer.from(body), Array.isArray(sig) ? sig[0] : sig);
      if (!p.message) {
        if (p.status === 401 || p.status === 403) gw.authFailure('webhook', `${p.status} ${p.error ?? ''}`);
        send(res, p.status, { error: p.error });
        return true;
      }
      await gw.handle(p.message);
      send(res, 200, { replies: adapters.webhook.take(p.message.chatId) });
      return true;
    }
    send(res, 404, { error: 'channel not enabled' });
    return true;
  };
}

const USAGE = `tug channels pair <telegram|slack|webhook> [--owner]   show a one-time pairing code
tug channels list                                     paired accounts
tug channels unpair <channel> <userId>
tug channels token <secret-name>                      store a bot token / signing secret in the vault (read from stdin)
tug channels start [--port N]                         run the enabled channels (Telegram long-poll; Slack/webhook on 127.0.0.1)`;

registerCliCommand({
  name: 'channels',
  description: 'chat with the agent from Telegram, Slack or a signed webhook (pairing, trust levels)',
  usage: 'pair|list|unpair|token|start …',
  help: () => USAGE,
  needsModel: false,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['owner']);
    const sub = f._[0];
    const cc = channelsConfig(ctx.config);
    const store = new PairingStore(ctx.config.homeDir);
    switch (sub) {
      case 'pair': {
        const ch = f._[1] as ChannelName;
        if (!CHANNELS.includes(ch)) {
          ctx.write(`usage: tug channels pair <${CHANNELS.join('|')}> [--owner]`);
          return 2;
        }
        const role = f.owner ? 'owner' : 'paired';
        const code = store.createCode(ch, role, cc.pairingTtlMs);
        ctx.write(`Pairing code for ${ch} (${role}), valid for ${Math.round(cc.pairingTtlMs / 60_000)} minutes, single use:\n\n    /pair ${code}\n\nSend that message to the bot from the account you want to pair.`);
        return 0;
      }
      case 'list': {
        const list = store.list();
        if (!list.length) ctx.write('no paired accounts');
        for (const p of list) ctx.write(`${p.channel}  ${p.userId}${p.userName ? ` (${p.userName})` : ''}  ${p.role}  since ${p.pairedAt}`);
        return 0;
      }
      case 'unpair': {
        const ok = store.unpair(f._[1] as ChannelName, f._[2] ?? '');
        ctx.write(ok ? 'unpaired' : 'no such pairing');
        return ok ? 0 : 1;
      }
      case 'token': {
        const name = f._[1];
        if (!name) {
          ctx.write('usage: echo "$TOKEN" | tug channels token <secret-name>');
          return 2;
        }
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const value = Buffer.concat(chunks).toString('utf8').trim();
        if (!value) {
          ctx.write('no value on stdin');
          return 2;
        }
        new SecretVault(ctx.config.homeDir).set(name, value);
        ctx.write(`stored ${name} in the secrets vault`);
        return 0;
      }
      case 'start': {
        const { adapters, secrets, problems } = await createAdapters(ctx.config);
        for (const p of problems) ctx.write(`warning: ${p}`);
        if (!Object.keys(adapters).length) {
          ctx.write('no channel is enabled and configured (set channels.telegram.enabled / slack / webhook in config, and the tokens with tug channels token).');
          return 1;
        }
        const gw = new ChannelGateway({ config: ctx.config, workspace: ctx.workspace, adapters, secrets, log: (s) => ctx.write(s) });
        adapters.telegram?.start?.((m) => void gw.handle(m));
        let server: http.Server | undefined;
        if (adapters.slack || adapters.webhook) {
          const handler = createChannelsHandler(gw, adapters);
          server = http.createServer((req, res) => {
            handler(req, res)
              .then((h) => {
                if (!h) send(res, 404, { error: 'not found' });
              })
              .catch(() => !res.headersSent && send(res, 500, { error: 'internal error' }));
          });
          const port = f.port ? Number(f.port) : cc.port;
          await new Promise<void>((r) => server!.listen(port, cc.host, () => r()));
          ctx.write(`channel endpoints on http://${cc.host}:${port}/channels/… (put a TLS reverse proxy in front for Slack)`);
        }
        ctx.write(`channels running: ${Object.keys(adapters).join(', ')}. Untrusted senders: ${cc.untrusted}. Ctrl-C to stop.`);
        await new Promise<void>((r) => {
          process.once('SIGINT', r);
          process.once('SIGTERM', r);
        });
        await adapters.telegram?.stop?.();
        server?.close();
        await gw.close();
        return 0;
      }
      default:
        ctx.write(USAGE);
        return sub ? 2 : 0;
    }
  },
});
