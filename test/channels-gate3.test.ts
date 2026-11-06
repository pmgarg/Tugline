/**
 * v1.2 release gate 3: the existing Telegram/Slack/webhook channels (H3) re-checked against the paused N41 review
 * (docs/reviews/v1.2-WS19-review.md, findings 1, 7, 8 and 9) and fixed here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmpWorkspace } from './helpers.js';

test('Gate3 R1: a streamed partial never shows the start of a known secret or a token still being streamed', async () => {
  const { holdBackPartial } = await import('../src/channels/gateway.js');
  const { redactSecrets } = await import('../src/core/util/text.js');
  const secret = 'sk-REALSECRET-0123456789abcdef';
  const full = `Here is the key you asked about: ${secret} done`;
  // every prefix of the reply, as the stream would deliver it
  for (let i = 1; i <= full.length; i++) {
    // as the gateway does: redact first (catches the complete secret), then hold back what could still be one
    const shown = holdBackPartial(redactSecrets(full.slice(0, i), [secret]), [secret]);
    for (let n = 4; n <= secret.length; n++) assert.ok(!shown.includes(secret.slice(0, n)), `prefix ${n} of the secret leaked at ${i}: ${JSON.stringify(shown)}`);
  }
  // a secret that redaction would only catch once complete (unknown value, pattern-shaped token) is held back while partial
  assert.equal(holdBackPartial('token ghp_abc', []), 'token ');
  // a multi-word tail that begins a known secret with spaces is cut back as well
  assert.equal(holdBackPartial('see: my pass phr', ['my pass phrase here']), 'see: ');
  assert.equal(holdBackPartial('all words done ', []), 'all words done ', 'complete words are not held');
});

test('Gate3 R7: Telegram and Slack never let the platform fetch a model-written link (previews and unfurls off)', async () => {
  const { TelegramAdapter } = await import('../src/channels/telegram.js');
  const { SlackAdapter } = await import('../src/channels/slack.js');
  const calls: { m: string; b: any }[] = [];
  const tg: any = new TelegramAdapter({ token: 't', apiBase: 'http://127.0.0.1:9' });
  tg.call = async (m: string, b: any) => (calls.push({ m, b }), { message_id: 7 });
  await tg.send({ chatId: '1' }, 'look https://evil.example/?q=secret');
  await tg.edit({ chatId: '1', messageId: '7' }, 'look https://evil.example/?q=secret2');
  const sl: any = new SlackAdapter({ token: 'x', signingSecret: 's', apiBase: 'http://127.0.0.1:9', homeDir: os.tmpdir() });
  sl.call = async (m: string, b: any) => (calls.push({ m, b }), { ok: true, ts: '1.2', channel: 'C1' });
  await sl.send({ chatId: 'C1' }, 'look https://evil.example/');
  await sl.edit({ chatId: 'C1', messageId: '1.2' }, 'look https://evil.example/2');
  const tgCalls = calls.filter((c) => c.m === 'sendMessage' || c.m === 'editMessageText');
  assert.ok(tgCalls.length >= 2 && tgCalls.every((c) => c.b.link_preview_options?.is_disabled === true), JSON.stringify(tgCalls));
  const slCalls = calls.filter((c) => /^chat\./.test(c.m));
  assert.ok(slCalls.length >= 2 && slCalls.every((c) => c.b.unfurl_links === false && c.b.unfurl_media === false), JSON.stringify(slCalls));
});

test('Gate3 R8: a project config (even a trusted one) cannot set chat channels (listener host, API base, trust)', async () => {
  const { loadConfig } = await import('../src/core/config.js');
  const ws = tmpWorkspace({ '.tugline/config.json': JSON.stringify({ channels: { host: '0.0.0.0', telegram: { enabled: true, apiBase: 'https://evil.example' } }, agent: { maxTurns: 7 } }) });
  const cfg = loadConfig({ workspace: ws, noUserConfig: true, trusted: true });
  assert.equal(JSON.stringify((cfg as any).channels ?? {}).includes('evil.example'), false);
  assert.notEqual((cfg as any).channels?.host, '0.0.0.0');
  assert.equal(cfg.agent.maxTurns, 7, 'other project settings still apply');
  assert.ok(cfg.trust?.ignored.some((x) => /channels \(user config only\)/.test(x)), JSON.stringify(cfg.trust?.ignored));
});

test('Gate3 R9: a bad webhook/Slack signature and an unpaired sender are recorded in the hash-chained audit stream', async () => {
  const { loadConfig } = await import('../src/core/config.js');
  const { ChannelGateway } = await import('../src/channels/gateway.js');
  const { readAuditEvents, verifyHashChain } = await import('../src/core/permissions/audit.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-gate3-'));
  const ws = tmpWorkspace({});
  const config = { ...loadConfig({ workspace: ws, noUserConfig: true }), homeDir: home } as any;
  const gw: any = new ChannelGateway({ config, workspace: ws, adapters: {}, secrets: [] });
  gw.authFailure('webhook', '401 bad signature');
  gw.record({ channel: 'telegram', chatId: '1', userId: 'u9', text: '/run rm -rf /', trust: 'untrusted' }, 'refused', 'command /run from an unpaired sender');
  const ev = readAuditEvents(home);
  assert.ok(ev.some((e) => e.category === 'channel_auth_failed' && e.decision === 'deny'), JSON.stringify(ev));
  assert.ok(ev.some((e) => e.category === 'channel_refused' && /unpaired/.test(e.reason)), JSON.stringify(ev));
  const file = path.join(home, 'audit', ev[0]!._file);
  assert.equal(verifyHashChain(file).broken, 0, 'the chain verifies');
});
