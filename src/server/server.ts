/**
 * `tug serve` (SPEC G2): JSON-RPC 2.0 over WebSocket (127.0.0.1 only) or stdio.
 *
 * Security:
 *  - binds 127.0.0.1, always. To use it from another machine (H5), put it behind
 *    an SSH tunnel or a TLS reverse proxy (wss://); the token still applies;
 *  - a random 256-bit token is printed at start (or taken from TUG_SERVER_TOKEN);
 *    the first message must be `auth {token}`, compared in constant time; the
 *    socket is closed on a wrong or missing token, and after 10 s without auth;
 *  - R16: that token is the owner's. Client tokens (tokens.ts) authenticate as
 *    their own principal and can address only the sessions they created;
 *  - browser pages cannot drive it: a request with an Origin header is refused
 *    unless listed in server.allowedOrigins, and the Host header must be the
 *    loopback address (DNS-rebinding defence);
 *  - every tool call still goes through the session agent's permission engine;
 *    unanswered approvals are denied and recorded (sessions.ts).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { ERR, RpcError, RpcPeer, type Channel } from './rpc.js';
import { DEFAULT_SERVER, SessionHost, type ClientConn, type HostOptions } from './sessions.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { remoteRun } from './remote.js';
import { rpcMethods, upgradeHandlerFor } from '../core/serverHooks.js';
import { clientPrincipal, OWNER, TokenStore } from './tokens.js';

export const SERVER_VERSION = '1.0.0';

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time token comparison (hash first so lengths never leak through timing). */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const NO_AUTH_METHODS = new Set(['auth']);

/** Wire every protocol method of one connection to the session host. */
export function bindConnection(host: SessionHost, conn: ClientConn, opts: { requireAuth: boolean; token?: string; tokens?: TokenStore; onAuthFail?: () => void; source?: string }): { authed: () => boolean; verified: () => boolean; closed: () => void; dead: () => boolean } {
  const peer = conn.peer;
  let authed = !opts.requireAuth;
  // v1.2 G3: a connection whose `auth: 'self'` credential checked out (A2A); its work stops when it closes
  let selfVerified = false;
  // G2: after a failed self-authenticating credential the connection is dead: nothing more it sends is read
  let dead = false;
  const life = new AbortController();
  // R16: without auth (stdio: the process owner's own pipe) the connection is the owner
  if (!opts.requireAuth) conn.principal = OWNER;
  peer.gate = (method) => {
    if (!authed && !NO_AUTH_METHODS.has(method) && rpcMethods().get(method)?.auth !== 'self') {
      opts.onAuthFail?.();
      throw new RpcError(ERR.UNAUTHORIZED, 'unauthorized: the first message must be auth {token}');
    }
  };
  peer.handle('auth', (p) => {
    if (!opts.requireAuth) return { ok: true, principal: conn.principal };
    // R16: the server token is the owner; an issued client token is its own principal
    const client = tokenMatches(p?.token, opts.token ?? '') ? undefined : opts.tokens?.verify(p?.token);
    if (!tokenMatches(p?.token, opts.token ?? '') && !client) {
      opts.onAuthFail?.();
      throw new RpcError(ERR.UNAUTHORIZED, 'invalid token');
    }
    conn.principal = client ? clientPrincipal(client) : OWNER;
    host.connections.add(conn); // so a revocation can close it
    authed = true;
    return { ok: true, principal: conn.principal };
  });
  const ownerOnly = () => {
    if (conn.principal !== OWNER) throw new RpcError(ERR.FORBIDDEN, 'only the server owner (the server token) can manage client tokens');
  };
  peer.handle('tokens/issue', (p) => (ownerOnly(), (opts.tokens ?? TokenStore.forHome(host.opts.config.homeDir)).issue(typeof p?.label === 'string' ? p.label : '')));
  peer.handle('tokens/list', () => (ownerOnly(), { tokens: (opts.tokens ?? TokenStore.forHome(host.opts.config.homeDir)).list().map(({ hash: _h, ...t }) => t) }));
  peer.handle('tokens/revoke', (p) => {
    ownerOnly();
    const ok = (opts.tokens ?? TokenStore.forHome(host.opts.config.homeDir)).revoke(String(p?.id ?? ''));
    if (ok) host.revokePrincipal(clientPrincipal(String(p?.id)));
    return { revoked: ok };
  });
  peer.handle('initialize', () => ({
    server: 'tugline',
    version: SERVER_VERSION,
    protocol: PROTOCOL_VERSION,
    capabilities: { sessions: true, steer: true, checkpoints: true, jobs: true, commands: true, elicitation: true, remote: !!host.settings.remote?.enabled },
  }));
  // R16: every session-addressed method goes through the principal check (other sessions look unknown)
  const S = (p: any) => host.get(p?.sessionId, conn);
  peer.handle('session/create', async (p) => host.info(await host.create(conn, { workspace: p?.workspace, mode: p?.mode, profile: p?.profile })));
  peer.handle('session/list', (p) => ({ live: [...host.sessions.values()].filter((s) => host.mayAddress(s, conn)).map((s) => host.info(s)), saved: host.listSaved(p?.workspace, conn) }));
  peer.handle('session/load', async (p) => host.info(await host.load(conn, p)));
  peer.handle('session/delete', async (p) => ({ deleted: await host.remove(S(p).id, !!p?.purge) }));
  peer.handle('session/subscribe', (p) => (S(p).subscribers.add(conn), { ok: true }));
  peer.handle('session/unsubscribe', (p) => (S(p).subscribers.delete(conn), { ok: true }));
  peer.handle('session/prompt', (p) => host.prompt(S(p), p?.text));
  peer.handle('session/steer', (p) => {
    const s = S(p);
    if (typeof p?.text !== 'string' || !p.text.trim()) throw new RpcError(ERR.INVALID_PARAMS, 'text is required');
    s.agent.steer(p.text);
    return { queued: !s.agent.isRunning };
  });
  peer.handle('session/enqueue', (p) => {
    if (typeof p?.text !== 'string' || !p.text.trim()) throw new RpcError(ERR.INVALID_PARAMS, 'text is required');
    return { queued: S(p).agent.enqueue(p.text) };
  });
  peer.handle('session/abort', (p) => (host.abort(S(p)), { aborted: true }));
  peer.handle('session/permissionReply', (p) => {
    const answer = p?.decision === 'allow' ? { decision: 'allow' as const, always: !!p.always } : { decision: 'deny' as const, feedback: typeof p?.feedback === 'string' ? p.feedback : undefined };
    return { ok: host.reply(S(p), 'permission', p?.requestId, answer) };
  });
  peer.handle('session/askReply', (p) => ({ ok: host.reply(S(p), 'ask', p?.requestId, typeof p?.answer === 'string' ? p.answer : '') }));
  peer.handle('session/planReply', (p) => ({ ok: host.reply(S(p), 'plan', p?.requestId, p?.approved === true) }));
  peer.handle('session/elicitReply', (p) => {
    const action = p?.action === 'accept' || p?.action === 'cancel' ? p.action : 'decline';
    return { ok: host.reply(S(p), 'elicit', p?.requestId, action === 'accept' ? { action, content: p?.content && typeof p.content === 'object' ? p.content : {} } : { action }) };
  });
  peer.handle('session/command', (p) => host.command(S(p), p?.name, p?.args));
  peer.handle('config/get', (p) => host.redactedConfig(p?.sessionId ? S(p).agent.config : host.opts.config));
  peer.handle('config/set', (p) => host.setConfig(S(p), p?.key, p?.value));
  peer.handle('checkpoints/list', async (p) => ({ checkpoints: await host.checkpoints(S(p)) }));
  peer.handle('checkpoints/restore', (p) => host.restoreCheckpoint(S(p), p?.id, p?.scope));
  peer.handle('jobs/list', (p) => ({ jobs: host.jobs(S(p)) }));
  peer.handle('remote/run', (p) => remoteRun(host, conn, p ?? {}));
  // v1.2 F12: methods core modules add (A2A inbound); 'self' methods check their own credential
  for (const [name, m] of rpcMethods()) {
    peer.handle(name, async (p) => {
      if (m.auth === 'owner' && conn.principal !== OWNER) throw new RpcError(ERR.FORBIDDEN, `only the server owner (the server token) can call ${name}`);
      try {
        return await m.run(p ?? {}, { config: host.opts.config, principal: authed ? conn.principal : undefined, source: opts.source, signal: life.signal, verified: () => (selfVerified = true) });
      } catch (e) {
        const c = (e as { code?: unknown }).code;
        // G2: a failed self-authenticating credential closes the connection, like a failed `auth`
        if (m.auth === 'self' && !authed && (c === 'unauthorized' || c === 'rate_limited')) {
          dead = true;
          opts.onAuthFail?.();
        }
        throw new RpcError(c === 'rate_limited' ? ERR.BUSY : c === 'unauthorized' ? ERR.UNAUTHORIZED : typeof c === 'string' ? ERR.INVALID_PARAMS : ERR.INTERNAL, (e as Error).message);
      }
    });
  }
  return { authed: () => authed, verified: () => selfVerified, closed: () => life.abort(), dead: () => dead };
}

/** Plain-HTTP routes mounted on the server port (webhooks, channels). Return true when handled. */
export type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean> | boolean;

export interface ServeOptions extends HostOptions {
  /** R16: client tokens (default `<home>/server-tokens.json`). */
  tokens?: TokenStore;
  /** Extra HTTP routes (e.g. H1 /hooks/<id> from `tug serve --with-daemon`). They do their own auth (HMAC). */
  httpHandlers?: HttpHandler[];
  port?: number;
  token?: string;
  log?: (s: string) => void;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  host: SessionHost;
  close(): Promise<void>;
}

function loopbackHost(h: string | undefined, port: number): boolean {
  if (!h) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h.toLowerCase());
}

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const token = opts.token ?? newToken();
  const tokens = opts.tokens ?? TokenStore.forHome(opts.config.homeDir);
  const host = new SessionHost(opts);
  const allowedOrigins = new Set(host.settings.allowedOrigins ?? []);
  const httpServer = http.createServer(async (req, res) => {
    for (const h of opts.httpHandlers ?? []) {
      try {
        if (await h(req, res)) return;
      } catch (e) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('internal error');
        opts.log?.(`http route failed: ${(e as Error).message}`);
        return;
      }
    }
    res.writeHead(426, { 'Content-Type': 'text/plain' }).end('Tugline server: connect with a WebSocket client');
  });
  let port = opts.port ?? host.settings.port ?? DEFAULT_SERVER.port;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
  });
  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    // Core-mounted routes (e.g. /browser-extension): loopback Host only; they check Origin and their own token.
    const mounted = upgradeHandlerFor(req.url);
    if (mounted && loopbackHost(req.headers.host, port) && mounted(req, socket, head, { port, config: opts.config })) return;
    if ((origin && !allowedOrigins.has(origin)) || !loopbackHost(req.headers.host, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    sockets.add(ws);
    const channel: Channel = { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
    const conn: ClientConn = { id: crypto.randomBytes(6).toString('hex'), peer: new RpcPeer(channel) };
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      // let the error response go out, then close
      setTimeout(() => ws.close(4401, 'unauthorized'), 20);
    };
    const state = bindConnection(host, conn, { requireAuth: true, token, tokens, onAuthFail: fail, source: req?.socket?.remoteAddress ?? 'unknown' });
    conn.close = () => ws.close(4403, 'token revoked');
    const authTimer = setTimeout(() => {
      if (!state.authed() && !state.verified()) ws.close(4401, 'authentication timeout');
    }, 10_000);
    ws.on('message', (data) => {
      if (!state.dead()) void conn.peer.receive(String(data));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      state.closed();
      sockets.delete(ws);
      conn.peer.dispose();
      host.detach(conn);
    });
    ws.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });
  port = (httpServer.address() as { port: number }).port;
  const url = `ws://127.0.0.1:${port}`;
  opts.log?.(`Tugline server listening on ${url}`);
  return {
    url,
    port,
    token,
    host,
    async close() {
      for (const s of sockets) s.terminate();
      await host.close();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}

/** `tug serve --stdio`: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only. */
export async function serveStdio(opts: HostOptions & { input?: Readable; output?: Writable }): Promise<SessionHost> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const host = new SessionHost(opts);
  const channel: Channel = { send: (t) => void output.write(t + '\n'), close: () => undefined };
  const conn: ClientConn = { id: 'stdio', peer: new RpcPeer(channel) };
  bindConnection(host, conn, { requireAuth: false });
  let buf = '';
  input.setEncoding?.('utf8');
  input.on('data', (d: string | Buffer) => {
    buf += String(d);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) void conn.peer.receive(line);
    }
  });
  await new Promise<void>((resolve) => input.on('end', () => resolve()));
  conn.peer.dispose();
  host.detach(conn);
  await host.close();
  return host;
}
