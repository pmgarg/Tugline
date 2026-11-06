/**
 * R16: per-client tokens for `tug serve`.
 *
 * v1.0 had one shared token, so any authenticated client could address any
 * session by id. Now every connection authenticates as a *principal*:
 *   - the server token (printed at start, or TUG_SERVER_TOKEN) is the `owner`:
 *     the person who started the server. It may address every session and
 *     manage client tokens (`tokens/issue`, `tokens/list`, `tokens/revoke`);
 *   - a client token (issued by the owner, `tug serve tokens add <label>`) is
 *     the principal `client:<id>`: it sees and addresses only the sessions it
 *     created or loaded, through any number of connections (reconnects keep
 *     access). Other sessions answer "unknown session", so ids are not even
 *     confirmed.
 *
 * Client tokens are stored hashed (sha256) in `<home>/server-tokens.json`
 * (mode 0600) and compared in constant time. Revoking one makes the next auth
 * fail; open connections of that client are closed by the server.
 *
 * Honest boundary: this separates clients of one single-user server. It is not
 * multi-user authorisation (no SSO/RBAC); model access and shared budgets that
 * must hold belong behind the company's model gateway.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OWNER = 'owner';

export interface ClientTokenRecord {
  id: string;
  label: string;
  /** sha256 of the token, hex */
  hash: string;
  createdAt: string;
}

const sha = (t: string) => crypto.createHash('sha256').update(t).digest();

export class TokenStore {
  constructor(readonly file: string) {}

  static forHome(homeDir: string): TokenStore {
    return new TokenStore(path.join(homeDir, 'server-tokens.json'));
  }

  list(): ClientTokenRecord[] {
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(r?.tokens) ? r.tokens : [];
    } catch {
      return [];
    }
  }

  private save(tokens: ClientTokenRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify({ tokens }, null, 2), { mode: 0o600 });
  }

  /** A new client token: returned once, stored only as a hash. */
  issue(label: string): { id: string; token: string; label: string } {
    const id = crypto.randomBytes(4).toString('hex');
    const token = `ohc_${crypto.randomBytes(32).toString('base64url')}`;
    this.save([...this.list(), { id, label: label || id, hash: sha(token).toString('hex'), createdAt: new Date().toISOString() }]);
    return { id, token, label: label || id };
  }

  revoke(idOrLabel: string): boolean {
    const all = this.list();
    const keep = all.filter((t) => t.id !== idOrLabel && t.label !== idOrLabel);
    if (keep.length === all.length) return false;
    this.save(keep);
    return true;
  }

  /** The client id for a token, or undefined. Constant time per stored token. */
  verify(token: unknown): string | undefined {
    if (typeof token !== 'string' || !token) return undefined;
    const h = sha(token);
    let found: string | undefined;
    for (const t of this.list()) {
      const stored = Buffer.from(t.hash, 'hex');
      if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) found = t.id;
    }
    return found;
  }
}

/** The principal of a client token id. */
export const clientPrincipal = (id: string) => `client:${id}`;
