/**
 * Webhook routes for triggers (SPEC H1). Written as a mountable handler so
 * server mode (WS7 `tug serve`) can put them on its own port, plus a standalone
 * listener used by `tug daemon`:
 *
 *   POST /hooks/<scheduleId>     generic webhook or GitHub delivery, HMAC-SHA256 signed
 *   GET  /hooks/_liveness        200 while the daemon's heartbeat is fresh, 503 when stale
 *
 * Mounting (server mode):
 *   const hooks = createHookHandler({ config, intake });
 *   http.createServer(async (req, res) => { if (await hooks(req, res)) return; …own routes… });
 *
 * Authentication: each webhook schedule has its own secret in the secrets vault
 * (`schedule-<id>`, created by `tug schedule add --webhook`). The signature is
 * `X-Hub-Signature-256: sha256=<hex>` (GitHub's header) or `X-OH-Signature`.
 * A schedule without a secret FAILS CLOSED (503): an unsigned endpoint would let
 * anyone schedule the agent, spend the budget and pick the moment (S16).
 * Signatures are checked before the dedupe ledger is touched, so forged
 * deliveries cannot burn real delivery ids.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { HarnessConfig } from '../config.js';
import { SecretVault } from '../secrets/vault.js';
import { liveness } from './heartbeat.js';
import type { Intake, IntakeOutcome } from './intake.js';
import { loadSchedules, recordActivity } from './store.js';
import { scheduleConfig, type TriggerEvent } from './types.js';

export const webhookSecretName = (scheduleId: string) => `schedule-${scheduleId}`;

export function signBody(secret: string, body: string | Buffer): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Constant-time check of a `sha256=<hex>` signature. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header || !secret) return false;
  const m = header.trim().match(/^sha256=([0-9a-fA-F]{64})$/);
  if (!m) return false;
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new BodyTooLarge());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parsePayload(body: Buffer, contentType: string | undefined): any {
  const text = body.toString('utf8');
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    const p = new URLSearchParams(text).get('payload');
    if (p) return JSON.parse(p);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const header = (req: http.IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Normalise a delivery into a TriggerEvent (GitHub or generic). */
export function eventFromDelivery(scheduleId: string, req: { headers: Record<string, string | string[] | undefined> }, body: Buffer, payload: any): TriggerEvent {
  const h = (n: string) => {
    const v = req.headers[n];
    return Array.isArray(v) ? v[0] : v;
  };
  const gh = h('x-github-event');
  const receivedAt = new Date().toISOString();
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
  if (gh) {
    const action = payload && typeof payload === 'object' && typeof payload.action === 'string' ? `.${payload.action}` : '';
    const num = payload?.pull_request?.number ?? payload?.issue?.number ?? payload?.check_suite?.pull_requests?.[0]?.number;
    return {
      id: h('x-github-delivery') || bodyHash,
      source: `github:${scheduleId}`,
      type: `${gh}${action}`,
      subject: num !== undefined ? String(num) : typeof payload?.ref === 'string' ? payload.ref : undefined,
      actor: payload?.sender?.login,
      scheduleId,
      data: payload,
      receivedAt,
    };
  }
  const obj = payload && typeof payload === 'object' ? payload : {};
  return {
    id: h('x-oh-delivery') || h('idempotency-key') || (typeof obj.id === 'string' || typeof obj.id === 'number' ? String(obj.id) : bodyHash),
    source: `webhook:${scheduleId}`,
    type: typeof obj.type === 'string' ? obj.type : 'webhook',
    subject: typeof obj.subject === 'string' ? obj.subject : undefined,
    actor: h('x-oh-actor') || (typeof obj.actor === 'string' ? obj.actor : undefined),
    scheduleId,
    data: payload,
    receivedAt,
  };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function statusFor(o: IntakeOutcome): number {
  if (o.status === 'refused') return o.reason === 'rate_limited' ? 429 : o.reason === 'duplicate' ? 200 : 202;
  return 202;
}

export interface HookHandlerOptions {
  config: HarnessConfig;
  intake: Intake;
  vault?: SecretVault;
  /** Route prefix (default /hooks). */
  prefix?: string;
}

export type HookHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export function createHookHandler(o: HookHandlerOptions): HookHandler {
  const prefix = (o.prefix ?? '/hooks').replace(/\/$/, '');
  const home = o.config.homeDir;
  const vault = o.vault ?? new SecretVault(home);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    const rest = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (rest === '_liveness' && req.method === 'GET') {
      const l = liveness(home, scheduleConfig(o.config).staleMs);
      send(res, l.ok ? 200 : 503, l);
      return true;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rest)) {
      send(res, 404, { error: 'not found' });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'POST only' });
      return true;
    }
    const s = loadSchedules(home).find((x) => x.id === rest || x.name === rest);
    if (!s || (s.trigger.type !== 'webhook' && s.trigger.type !== 'github')) {
      send(res, 404, { error: 'no webhook schedule with this id' });
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req, scheduleConfig(o.config).maxBodyBytes);
    } catch (e) {
      send(res, e instanceof BodyTooLarge ? 413 : 400, { error: e instanceof BodyTooLarge ? 'body too large' : 'bad request' });
      return true;
    }
    let secret = '';
    try {
      secret = await vault.resolve(webhookSecretName(s.id));
    } catch {
      /* no secret: fail closed below */
    }
    if (!secret) {
      recordActivity(home, { kind: 'refused', scheduleId: s.id, reason: 'no_secret', detail: 'webhook secret is not set; deliveries are refused' });
      send(res, 503, { error: `webhook secret not configured (set it with: tug schedule secret ${s.id})` });
      return true;
    }
    if (!verifySignature(secret, body, header(req, 'x-hub-signature-256') ?? header(req, 'x-oh-signature'))) {
      recordActivity(home, { kind: 'refused', scheduleId: s.id, reason: 'bad_signature', detail: `from ${req.socket.remoteAddress ?? '?'}` });
      send(res, 401, { error: 'bad signature' });
      return true;
    }
    let payload: unknown;
    try {
      payload = parsePayload(body, header(req, 'content-type'));
    } catch {
      send(res, 400, { error: 'unparseable payload' });
      return true;
    }
    if (header(req, 'x-github-event') === 'ping') {
      send(res, 200, { status: 'pong' });
      return true;
    }
    const ev = eventFromDelivery(s.id, req, body, payload);
    const out = o.intake.handle(ev);
    const { done: _done, ...shown } = out as IntakeOutcome & { done?: unknown };
    send(res, statusFor(out), { event: `${ev.source}/${ev.id}`, type: ev.type, ...shown });
    return true;
  };
}

/** Shown by `tug schedule add`, `tug daemon` and their help: the listener is local only. */
export const LOOPBACK_NOTICE =
  'The webhook listener binds 127.0.0.1 only (also with `tug serve --with-daemon`). External senders such as GitHub need a TLS reverse proxy (Caddy, nginx) or a tunnel (cloudflared, ngrok, tailscale funnel) that forwards to it.';

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * Standalone listener for `tug daemon`. Loopback only: the routes are HMAC-checked,
 * but exposing them directly would put an unauthenticated HTTP parser and the
 * liveness route on the network. Publish them through a TLS proxy or tunnel instead.
 */
export async function startHookServer(handler: HookHandler, port: number, host = '127.0.0.1'): Promise<{ server: http.Server; url: string; close: () => Promise<void> }> {
  if (!isLoopbackHost(host)) throw new Error(`the webhook listener only binds a loopback address, not "${host}". ${LOOPBACK_NOTICE}`);
  const server = http.createServer((req, res) => {
    handler(req, res)
      .then((handled) => {
        if (!handled) send(res, 404, { error: 'not found' });
      })
      .catch(() => {
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address() as { port: number };
  return { server, url: `http://${host}:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) };
}
