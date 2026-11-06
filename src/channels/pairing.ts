/**
 * Pairing (SPEC H3). The CLI shows a one-time code; the person sends
 * `/pair <code>` to the bot from their account; from then on that account is
 * `paired` (or `owner`). Codes:
 *  - are stored only as hashes, expire (10 minutes by default) and work once;
 *  - are bound to one channel;
 *  - have 8 characters from a 32-character alphabet (~10^12), and a sender gets a
 *    few wrong guesses before its attempts are ignored (S11 "ClawJacked": a
 *    weak pairing token brute-forced into a trusted device).
 *
 * Stored in `<homeDir>/channels/pairing.json` (mode 0600).
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../core/schedule/store.js';
import type { ChannelName, TrustLevel } from './types.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

export interface Pairing {
  channel: ChannelName;
  userId: string;
  userName?: string;
  role: 'owner' | 'paired';
  pairedAt: string;
}

interface PendingCode {
  hash: string;
  channel: ChannelName;
  role: 'owner' | 'paired';
  expiresAt: string;
}

interface PairingFile {
  pairings: Pairing[];
  codes: PendingCode[];
  /** failed attempts per channel:user */
  failures: Record<string, number>;
}

const hash = (code: string) => crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');

export class PairingStore {
  readonly file: string;
  constructor(homeDir: string) {
    this.file = path.join(homeDir, 'channels', 'pairing.json');
  }

  private read(): PairingFile {
    return { pairings: [], codes: [], failures: {}, ...readJson<Partial<PairingFile>>(this.file, {}) };
  }

  private write(f: PairingFile): void {
    writeJsonAtomic(this.file, f);
  }

  /** Make a one-time code (returned once, stored hashed). */
  createCode(channel: ChannelName, role: 'owner' | 'paired', ttlMs: number, now = new Date()): string {
    const bytes = crypto.randomBytes(8);
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    const f = this.read();
    f.codes = f.codes.filter((c) => new Date(c.expiresAt) > now);
    f.codes.push({ hash: hash(code), channel, role, expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
    this.write(f);
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  trustOf(channel: ChannelName, userId: string): TrustLevel {
    const p = this.read().pairings.find((x) => x.channel === channel && x.userId === userId);
    return p ? p.role : 'untrusted';
  }

  list(): Pairing[] {
    return this.read().pairings;
  }

  unpair(channel: ChannelName, userId: string): boolean {
    const f = this.read();
    const n = f.pairings.length;
    f.pairings = f.pairings.filter((p) => !(p.channel === channel && p.userId === userId));
    this.write(f);
    return f.pairings.length !== n;
  }

  /**
   * Redeem a code for a sender. Returns the role on success; 'locked' once the
   * sender used up its attempts; 'invalid' for a wrong, expired, reused or
   * other-channel code.
   */
  redeem(channel: ChannelName, userId: string, userName: string | undefined, code: string, maxAttempts: number, now = new Date()): 'owner' | 'paired' | 'invalid' | 'locked' {
    const f = this.read();
    const key = `${channel}:${userId}`;
    if ((f.failures[key] ?? 0) >= maxAttempts) return 'locked';
    const h = hash(code);
    const i = f.codes.findIndex((c) => c.channel === channel && new Date(c.expiresAt) > now && crypto.timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(h, 'hex')));
    if (i < 0) {
      f.failures[key] = (f.failures[key] ?? 0) + 1;
      this.write(f);
      return (f.failures[key] ?? 0) >= maxAttempts ? 'locked' : 'invalid';
    }
    const [c] = f.codes.splice(i, 1); // one-time
    f.pairings = f.pairings.filter((p) => !(p.channel === channel && p.userId === userId));
    f.pairings.push({ channel, userId, userName, role: c.role, pairedAt: now.toISOString() });
    delete f.failures[key];
    this.write(f);
    return c.role;
  }
}
