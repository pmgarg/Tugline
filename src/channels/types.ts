/**
 * Channels (SPEC H3; EAG S11 "the channel adapter contract"). An adapter turns
 * a chat platform's wire format into typed ChannelMessages and sends replies;
 * the runtime never sees a native payload. Every inbound message carries a
 * trust level assigned in code, from the pairing store, before anything reads
 * the text:
 *
 *   owner      paired with `tug channels pair <channel> --owner`
 *   paired     paired with `tug channels pair <channel>`
 *   untrusted  everyone else: no tool authority, ever
 */
import type { PermissionMode } from '../core/types.js';
import type { HarnessConfig } from '../core/config.js';

export type TrustLevel = 'owner' | 'paired' | 'untrusted';
export type ChannelName = 'telegram' | 'slack' | 'webhook';

export interface ChannelMessage {
  channel: ChannelName;
  /** Platform user id (Telegram from.id, Slack user, webhook sender). */
  userId: string;
  userName?: string;
  /** Where to reply (Telegram chat id, Slack channel id). */
  chatId: string;
  /** Slack thread_ts / Telegram message_thread_id. */
  threadId?: string;
  messageId?: string;
  text: string;
  arrivedAt: string;
  /** Assigned by the gateway from the pairing store; adapters leave it unset. */
  trust?: TrustLevel;
}

export interface SentRef {
  chatId: string;
  messageId: string;
  threadId?: string;
}

export interface ChannelAdapter {
  readonly name: ChannelName;
  /** Can a sent message be edited (streamed replies)? */
  readonly canEdit: boolean;
  send(to: { chatId: string; threadId?: string; replyTo?: string }, text: string): Promise<SentRef>;
  edit?(ref: SentRef, text: string): Promise<void>;
  /** Long-poll adapters start a loop; webhook adapters are driven by an HTTP handler. */
  start?(onMessage: (m: ChannelMessage) => void): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface ChannelsConfig {
  telegram: { enabled: boolean; tokenSecret: string; apiBase: string; pollTimeoutS: number };
  slack: { enabled: boolean; tokenSecret: string; signingSecret: string; apiBase: string };
  webhook: { enabled: boolean; secret: string };
  /** What untrusted senders get: nothing ('ignore', default) or a tool-less answer ('readonly'). */
  untrusted: 'ignore' | 'readonly';
  /** Permission mode for owners' and paired users' runs (headless: 'ask' = deny-with-record). */
  ownerMode: PermissionMode;
  pairedMode: PermissionMode;
  /** Workspace the channel agent works in (default: where `tug channels start` runs). */
  workspace?: string;
  /** Streamed replies: minimum ms between edits. */
  editIntervalMs: number;
  pairingTtlMs: number;
  /** Wrong pairing codes per sender before further attempts are ignored. */
  maxPairingAttempts: number;
  host: string;
  port: number;
}

export const DEFAULT_CHANNELS: ChannelsConfig = {
  telegram: { enabled: false, tokenSecret: 'telegram-bot', apiBase: 'https://api.telegram.org', pollTimeoutS: 25 },
  slack: { enabled: false, tokenSecret: 'slack-bot', signingSecret: 'slack-signing', apiBase: 'https://slack.com/api' },
  webhook: { enabled: false, secret: 'channel-webhook' },
  untrusted: 'ignore',
  ownerMode: 'ask',
  pairedMode: 'ask',
  editIntervalMs: 1200,
  pairingTtlMs: 10 * 60_000,
  maxPairingAttempts: 5,
  host: '127.0.0.1',
  port: 7879,
};

declare module '../core/config.js' {
  interface HarnessConfigExtensions {
    /** SPEC H3 (WS8). Tokens live in the secrets vault; these are vault names. */
    channels?: Partial<Omit<ChannelsConfig, 'telegram' | 'slack' | 'webhook'>> & {
      telegram?: Partial<ChannelsConfig['telegram']>;
      slack?: Partial<ChannelsConfig['slack']>;
      webhook?: Partial<ChannelsConfig['webhook']>;
    };
  }
}

export function channelsConfig(cfg: HarnessConfig): ChannelsConfig {
  const c = cfg.channels ?? {};
  return {
    ...DEFAULT_CHANNELS,
    ...c,
    telegram: { ...DEFAULT_CHANNELS.telegram, ...(c.telegram ?? {}) },
    slack: { ...DEFAULT_CHANNELS.slack, ...(c.slack ?? {}) },
    webhook: { ...DEFAULT_CHANNELS.webhook, ...(c.webhook ?? {}) },
  };
}
