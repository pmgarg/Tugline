/**
 * Telegram adapter: Bot API long polling (`getUpdates`), `sendMessage`,
 * `editMessageText` for streamed replies. `apiBase` is configurable so tests
 * (and Telegram's local Bot API server) can stand in for api.telegram.org.
 */
import type { ChannelAdapter, ChannelMessage, SentRef } from './types.js';

const MAX = 4096;

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  pollTimeoutS?: number;
  /** Called when a poll fails (network); polling continues with backoff. */
  onError?: (e: Error) => void;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram' as const;
  readonly canEdit = true;
  private offset = 0;
  private abort?: AbortController;
  private loop?: Promise<void>;
  constructor(private o: TelegramOptions) {}

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const base = (this.o.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
    const r = await fetch(`${base}/bot${this.o.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(`telegram ${method}: ${j.description ?? `HTTP ${r.status}`}`);
    return j.result as T;
  }

  /** One getUpdates round. Exposed for tests; start() loops over it. */
  async pollOnce(signal?: AbortSignal): Promise<ChannelMessage[]> {
    const updates = await this.call<any[]>('getUpdates', { offset: this.offset, timeout: this.o.pollTimeoutS ?? 25, allowed_updates: ['message'] }, signal);
    const out: ChannelMessage[] = [];
    for (const u of updates ?? []) {
      if (typeof u.update_id === 'number') this.offset = Math.max(this.offset, u.update_id + 1);
      const m = u.message;
      if (!m || typeof m.text !== 'string' || !m.from || m.from.is_bot) continue;
      out.push({
        channel: 'telegram',
        userId: String(m.from.id),
        userName: m.from.username,
        chatId: String(m.chat.id),
        threadId: m.message_thread_id !== undefined ? String(m.message_thread_id) : undefined,
        messageId: String(m.message_id),
        text: m.text,
        arrivedAt: new Date((m.date ?? Date.now() / 1000) * 1000).toISOString(),
      });
    }
    return out;
  }

  start(onMessage: (m: ChannelMessage) => void): void {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.loop = (async () => {
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          for (const m of await this.pollOnce(signal)) onMessage(m);
          backoff = 1000;
        } catch (e) {
          if (signal.aborted) break;
          this.o.onError?.(e as Error);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 60_000);
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.loop?.catch(() => undefined);
  }

  async send(to: { chatId: string; threadId?: string; replyTo?: string }, text: string): Promise<SentRef> {
    // link previews off: a model-written URL must not be fetched by the platform (zero-click exfiltration)
    const body: Record<string, unknown> = { chat_id: to.chatId, text: clip(text), link_preview_options: { is_disabled: true } };
    if (to.threadId) body.message_thread_id = Number(to.threadId);
    if (to.replyTo) body.reply_parameters = { message_id: Number(to.replyTo) };
    const r = await this.call<any>('sendMessage', body);
    return { chatId: to.chatId, messageId: String(r.message_id), threadId: to.threadId };
  }

  async edit(ref: SentRef, text: string): Promise<void> {
    try {
      await this.call('editMessageText', { chat_id: ref.chatId, message_id: Number(ref.messageId), text: clip(text), link_preview_options: { is_disabled: true } });
    } catch (e) {
      // "message is not modified" is not an error for a streamed reply
      if (!/not modified/i.test((e as Error).message)) throw e;
    }
  }
}

function clip(s: string): string {
  const t = s.trim() || '…';
  return t.length > MAX ? `${t.slice(0, MAX - 20)}\n… [truncated]` : t;
}
