/**
 * Slack adapter: Events API (an HTTP endpoint Slack posts to) for inbound
 * messages, Web API `chat.postMessage` / `chat.update` for streamed replies.
 *
 * Inbound requests are verified with Slack's signing secret
 * (`X-Slack-Signature: v0=HMAC_SHA256(secret, "v0:<ts>:<body>")`), and requests
 * older than five minutes are refused (replay). Slack retries deliveries, so
 * events are deduplicated on `event_id` in the same ledger the scheduler uses.
 * The bot's own messages (bot_id / subtype) are ignored, so it never answers itself.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import { markSeen } from '../core/schedule/store.js';
import type { ChannelAdapter, ChannelMessage, SentRef } from './types.js';

export function slackSignature(signingSecret: string, ts: string, body: string): string {
  return `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

export function verifySlack(signingSecret: string, headers: Record<string, string | string[] | undefined>, body: string, nowS = Math.floor(Date.now() / 1000)): boolean {
  const ts = String(headers['x-slack-request-timestamp'] ?? '');
  const sig = String(headers['x-slack-signature'] ?? '');
  if (!/^\d+$/.test(ts) || Math.abs(nowS - Number(ts)) > 300 || !sig.startsWith('v0=')) return false;
  const want = Buffer.from(slackSignature(signingSecret, ts, body));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export interface SlackOptions {
  token: string;
  signingSecret: string;
  apiBase?: string;
  /** For dedupe of retried deliveries (the scheduler's ledger). */
  homeDir: string;
}

export class SlackAdapter implements ChannelAdapter {
  readonly name = 'slack' as const;
  readonly canEdit = true;
  constructor(private o: SlackOptions) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const base = (this.o.apiBase ?? 'https://slack.com/api').replace(/\/$/, '');
    const r = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${this.o.token}` }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`slack ${method}: ${j.error ?? `HTTP ${r.status}`}`);
    return j as T;
  }

  async send(to: { chatId: string; threadId?: string }, text: string): Promise<SentRef> {
    const r = await this.call<any>('chat.postMessage', { channel: to.chatId, text: text.trim() || '…', unfurl_links: false, unfurl_media: false, ...(to.threadId ? { thread_ts: to.threadId } : {}) });
    return { chatId: to.chatId, messageId: String(r.ts), threadId: to.threadId };
  }

  async edit(ref: SentRef, text: string): Promise<void> {
    await this.call('chat.update', { channel: ref.chatId, ts: ref.messageId, text: text.trim() || '…', unfurl_links: false, unfurl_media: false });
  }

  /**
   * Handle one Events API request. Returns the HTTP response to send and, when
   * the request carried a user message, the message (processed after the 200,
   * because Slack wants an answer within 3 seconds).
   */
  handleEvent(headers: Record<string, string | string[] | undefined>, body: string): { status: number; body: unknown; message?: ChannelMessage } {
    if (!verifySlack(this.o.signingSecret, headers, body)) return { status: 401, body: { error: 'bad signature' } };
    let j: any;
    try {
      j = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'bad json' } };
    }
    if (j.type === 'url_verification') return { status: 200, body: { challenge: j.challenge } };
    if (j.type !== 'event_callback' || !j.event) return { status: 200, body: { ok: true } };
    if (j.event_id && !markSeen(this.o.homeDir, `slack/${j.event_id}`)) return { status: 200, body: { ok: true, duplicate: true } };
    const e = j.event;
    if ((e.type !== 'message' && e.type !== 'app_mention') || e.bot_id || e.subtype || typeof e.text !== 'string' || !e.user) return { status: 200, body: { ok: true } };
    return {
      status: 200,
      body: { ok: true },
      message: {
        channel: 'slack',
        userId: String(e.user),
        chatId: String(e.channel),
        threadId: String(e.thread_ts ?? e.ts),
        messageId: String(e.ts),
        text: String(e.text).replace(/^<@[A-Z0-9]+>\s*/, ''),
        arrivedAt: new Date().toISOString(),
      },
    };
  }
}

export async function readRequestBody(req: http.IncomingMessage, max = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
