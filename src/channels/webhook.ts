/**
 * Generic webhook channel: any integration that can sign a request.
 *
 *   POST /channels/webhook   {"sender": "u123", "text": "…", "thread": "optional", "name": "optional"}
 *   X-OH-Signature: sha256=<HMAC-SHA256(secret, body)>
 *
 * The reply comes back in the HTTP response ({"replies": ["…"]}). There is no
 * streaming: the response is sent when the run ends. The HMAC proves the caller
 * holds the channel secret; the sender id it names is then looked up in the
 * pairing store like any other channel, so an integration cannot grant trust by
 * itself.
 */
import crypto from 'node:crypto';
import { verifySignature } from '../core/schedule/webhook.js';
import type { ChannelAdapter, ChannelMessage, SentRef } from './types.js';

export class WebhookChannelAdapter implements ChannelAdapter {
  readonly name = 'webhook' as const;
  readonly canEdit = false;
  /** Replies collected per request (chatId is a per-request id). */
  private outbox = new Map<string, string[]>();
  constructor(private secret: string) {}

  parse(body: Buffer, signature: string | undefined): { status: number; error?: string; message?: ChannelMessage } {
    if (!this.secret) return { status: 503, error: 'channel webhook secret is not configured' };
    if (!verifySignature(this.secret, body, signature)) return { status: 401, error: 'bad signature' };
    let j: any;
    try {
      j = JSON.parse(body.toString('utf8'));
    } catch {
      return { status: 400, error: 'bad json' };
    }
    if (typeof j?.sender !== 'string' || !j.sender || typeof j.text !== 'string') return { status: 400, error: 'need {"sender": string, "text": string}' };
    const chatId = `req_${crypto.randomBytes(6).toString('hex')}`;
    this.outbox.set(chatId, []);
    return {
      status: 200,
      message: { channel: 'webhook', userId: j.sender.slice(0, 200), userName: typeof j.name === 'string' ? j.name.slice(0, 100) : undefined, chatId, threadId: typeof j.thread === 'string' ? j.thread.slice(0, 200) : undefined, text: j.text, arrivedAt: new Date().toISOString() },
    };
  }

  async send(to: { chatId: string }, text: string): Promise<SentRef> {
    const box = this.outbox.get(to.chatId);
    if (box) box.push(text);
    return { chatId: to.chatId, messageId: String(box?.length ?? 0) };
  }

  /** Replies for a finished request (and forget them). */
  take(chatId: string): string[] {
    const r = this.outbox.get(chatId) ?? [];
    this.outbox.delete(chatId);
    return r;
  }
}
