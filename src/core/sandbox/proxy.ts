/**
 * Network allowlist proxy for sandboxed commands (SPEC C2).
 *
 * Sandboxed processes have no direct network (bwrap `--unshare-net`, Seatbelt
 * `(deny network*)`); their only way out is this HTTP proxy, reached through
 * HTTP(S)_PROXY. It accepts:
 *   - `CONNECT host:port` (HTTPS and any TLS protocol), tunnelled after the check;
 *   - absolute-form plain HTTP requests (`GET http://host/path`), forwarded.
 * Every request's host must match `sandbox.allowDomains` (exact names,
 * `*.example.com` for subdomains, `*` for anything). Hosts that are not listed
 * literally (as an IP or `localhost`) must not resolve to private, loopback or
 * link-local addresses: that blocks cloud-metadata grabs (169.254.169.254)
 * through an allowed name.
 *
 * DNS is resolved ONCE: the proxy connects to the exact address it checked
 * (never re-resolving the name), so a rebinding DNS server cannot answer the
 * check with a public IP and the connection with an internal one. TLS is
 * unaffected (CONNECT is a byte tunnel; the client's SNI and certificate check
 * still use the hostname) and plain HTTP keeps the original Host header.
 *
 * When the harness itself sits behind a corporate proxy (HTTPS_PROXY in its own
 * environment), allowed traffic is chained through it.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { isPrivateAddress } from '../tools/web.js';

export interface ProxyOptions {
  allowDomains: string[];
  /** DNS resolver (injectable for tests). Default: dns.lookup(host, {all: true}). */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Private-address test (injectable for tests). Default: the SSRF guard's isPrivateAddress. */
  isPrivate?: (ip: string) => boolean;
  /** Upstream proxy URL (http://host:port) for allowed traffic, or undefined for direct. */
  upstream?: string;
  /** Hosts reached directly even when an upstream is set (NO_PROXY). */
  noProxy?: string[];
  /**
   * N36: names that may resolve to a private address (the model endpoint on the host, seen from a container session
   * as host.docker.internal). Exact names only; everything else keeps the private-address block.
   */
  privateOk?: string[];
}

export interface ProxyLogEntry {
  ts: number;
  host: string;
  port: number;
  allowed: boolean;
  reason?: string;
  /** The address the connection was pinned to. */
  address?: string;
}

export interface CheckResult {
  ok: boolean;
  reason?: string;
  /** Connect to this address (the one that was checked), not to the name. */
  address?: string;
}

/** An allowlist entry split into host and optional port (`host:port`, `[v6]:port`; review finding 8). */
function splitEntry(entry: string): { e: string; port?: number } {
  const t = entry.trim().toLowerCase().replace(/\.$/, '');
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(t) ?? /^([^:\[\]]+):(\d+)$/.exec(t);
  return m ? { e: m[1]!, port: Number(m[2]) } : { e: t.replace(/^\[|\]$/g, '') };
}

/** Does `host` (and `port`, when the entry names one) match one allowlist entry? */
function entryMatches(entry: string, host: string, port?: number): boolean {
  const { e, port: p } = splitEntry(entry);
  if (!e) return false;
  if (p !== undefined && port !== undefined && p !== port) return false;
  if (e === '*') return true;
  if (e.startsWith('*.')) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
  if (e.startsWith('.')) return host === e.slice(1) || host.endsWith(e);
  return host === e;
}

/** The allowlist entry that admits `host` (on `port`, for `host:port` entries), if any. */
export function matchDomain(host: string, allow: string[], port?: number): string | undefined {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return allow.find((e) => entryMatches(e, h, port));
}

function isLiteralEntry(entry: string, host: string): boolean {
  const e = splitEntry(entry).e;
  return e === host.toLowerCase() && (e === 'localhost' || net.isIP(e) !== 0);
}

/** Parse "host:port" with IPv6 brackets. */
export function splitHostPort(s: string, defPort: number): { host: string; port: number } {
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? s.match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return { host: s, port: defPort };
  return { host: m[1], port: m[2] ? Number(m[2]) : defPort };
}

function noProxyMatch(host: string, list: string[]): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.startsWith('127.') || h === '::1') return true;
  return list.some((raw) => {
    const e = raw.trim().toLowerCase();
    if (!e || e.includes('/')) return false;
    if (e === '*') return true;
    if (e.startsWith('*.')) return h.endsWith(e.slice(1));
    if (e.startsWith('.')) return h === e.slice(1) || h.endsWith(e);
    return h === e || h.endsWith('.' + e);
  });
}

export class DomainProxy {
  readonly log: ProxyLogEntry[] = [];
  private server: http.Server;
  private listeners: net.Server[] = [];
  private tcpPort?: number;
  private sockets = new Set<net.Socket>();

  constructor(readonly opts: ProxyOptions) {
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on('connect', (req, sock: net.Socket, head) => void this.onConnect(req, sock, head));
    this.server.on('clientError', (_e, sock) => sock.destroy());
  }

  /** Decide whether a host may be reached, and pin the address to connect to. */
  async check(host: string, port: number): Promise<CheckResult> {
    const entry = matchDomain(host, this.opts.allowDomains, port);
    const isPrivate = this.opts.isPrivate ?? isPrivateAddress;
    const record = (ok: boolean, reason?: string, address?: string): CheckResult => {
      this.log.push({ ts: Date.now(), host, port, allowed: ok, reason, address });
      if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
      return { ok, reason, address };
    };
    if (!entry) return record(false, 'not in sandbox.allowDomains');
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) return isLiteralEntry(entry, bare) || !isPrivate(bare) ? record(true, undefined, bare) : record(false, 'private address');
    let addrs: { address: string; family: number }[] = [];
    try {
      addrs = await (this.opts.lookup ?? ((h: string) => dns.lookup(h, { all: true })))(host);
    } catch {
      addrs = [];
    }
    if (!addrs.length) {
      // Unresolvable here: only an upstream proxy can reach it (it resolves names itself).
      return this.useUpstream(host) ? record(true) : record(false, 'cannot resolve');
    }
    const privateOk = (this.opts.privateOk ?? []).some((h) => h.toLowerCase() === host.toLowerCase());
    if (!isLiteralEntry(entry, host) && !privateOk && addrs.some((a) => isPrivate(a.address))) return record(false, 'resolves to a private address');
    const pick = addrs.find((a) => a.family === 4) ?? addrs[0]!;
    return record(true, undefined, pick.address);
  }

  private useUpstream(host: string): boolean {
    return !!this.opts.upstream && !noProxyMatch(host, this.opts.noProxy ?? []);
  }

  /**
   * Open a raw TCP tunnel to host:port. Direct connections go to the address
   * pinned by check(); through an upstream proxy the name is sent (corporate
   * proxies filter by host name, and resolve it on their side of the network).
   */
  private tunnel(host: string, port: number, address?: string): Promise<{ sock: net.Socket; head: Buffer }> {
    if (!this.useUpstream(host)) {
      return new Promise((resolve, reject) => {
        if (!address) return reject(new Error(`no checked address for ${host}`));
        const s = net.connect(port, address, () => resolve({ sock: s, head: Buffer.alloc(0) }));
        s.once('error', reject);
      });
    }
    const up = new URL(this.opts.upstream!);
    return new Promise((resolve, reject) => {
      const s = net.connect(Number(up.port || 80), up.hostname, () => {
        const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString('base64')}\r\n` : '';
        s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      });
      let buf = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        s.off('data', onData);
        const status = buf.subarray(0, buf.indexOf('\r\n')).toString();
        if (!/^HTTP\/1\.[01] 200/.test(status)) {
          s.destroy();
          reject(new Error(`upstream proxy refused: ${status}`));
          return;
        }
        resolve({ sock: s, head: buf.subarray(i + 4) });
      };
      s.on('data', onData);
      s.once('error', reject);
    });
  }

  private async onConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    const { host, port } = splitHostPort(req.url ?? '', 443);
    client.on('error', () => undefined);
    const v = await this.check(host, port);
    if (!v.ok) {
      client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nTugline sandbox: ${host} is blocked (${v.reason}). Add it to sandbox.allowDomains to allow it.\n`);
      return;
    }
    try {
      const { sock, head: upHead } = await this.tunnel(host, port, v.address);
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      sock.on('error', () => client.destroy());
      client.on('close', () => sock.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (upHead.length) client.write(upHead);
      if (head.length) sock.write(head);
      sock.pipe(client);
      client.pipe(sock);
    } catch (e) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${(e as Error).message}\n`);
    }
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error('only http:// is proxied as a plain request; use CONNECT for TLS');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Tugline sandbox proxy: ${(e as Error).message}\n`);
      return;
    }
    const port = Number(url.port || 80);
    const v = await this.check(url.hostname, port);
    if (!v.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end(`Tugline sandbox: ${url.hostname} is blocked (${v.reason}). Add it to sandbox.allowDomains to allow it.\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const viaUp = this.useUpstream(url.hostname);
    const up = viaUp ? new URL(this.opts.upstream!) : undefined;
    if (!up && !v.address) {
      res.writeHead(502, { 'Content-Type': 'text/plain' }).end(`Tugline sandbox: no checked address for ${url.hostname}\n`);
      return;
    }
    // Direct: connect to the checked address, keep the original Host header.
    headers.host = req.headers.host ?? url.host;
    const fwd = http.request(
      up ? { host: up.hostname, port: Number(up.port || 80), method: req.method, path: url.href, headers } : { host: v.address, port, method: req.method, path: url.pathname + url.search, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    fwd.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`proxy error: ${e.message}\n`);
    });
    req.pipe(fwd);
  }

  /** Listen on a unix socket (bwrap bridge). The bind is synchronous. */
  listenUnix(sockPath: string): void {
    const s = net.createServer((c) => this.server.emit('connection', c));
    s.listen(sockPath);
    s.unref();
    this.listeners.push(s);
  }

  /**
   * Listen on 127.0.0.1 (Seatbelt shares the host loopback). Synchronous: the
   * port is chosen here so a command can be wrapped without awaiting.
   */
  listenTcpSync(): number {
    if (this.tcpPort) return this.tcpPort;
    const port = 20000 + Math.floor(Math.random() * 40000);
    const s = net.createServer((c) => this.server.emit('connection', c));
    s.on('error', () => {
      // port taken: the next wrap picks another
      if (this.tcpPort === port) this.tcpPort = undefined;
    });
    s.listen(port, '127.0.0.1');
    s.unref();
    this.listeners.push(s);
    this.tcpPort = port;
    return port;
  }

  /** N36: listen on a fixed address and port (the container session's sidecar). */
  listenTcpOn(port: number, host: string): void {
    const s = net.createServer((c) => this.server.emit('connection', c));
    s.listen(port, host);
    this.listeners.push(s);
    this.tcpPort = port;
  }

  close(): void {
    for (const l of this.listeners) l.close();
    for (const s of this.sockets) s.destroy();
    this.server.close();
  }
}
