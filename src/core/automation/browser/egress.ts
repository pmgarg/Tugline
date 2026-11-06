/**
 * Egress guard proxy for launched browsers (security, SPEC R3 / S12 "re-check
 * after every redirect").
 *
 * Playwright's `route()` sees only the first request of a redirect chain, so a
 * public page that 302s to http://169.254.169.254/ would slip past a
 * route-based check. Every request a launched Chromium makes therefore goes
 * through this local proxy instead (Playwright forces loopback through a
 * configured proxy too): plain HTTP requests, HTTPS CONNECT tunnels, websocket
 * upgrades and every redirect hop. The proxy resolves the host ONCE, refuses
 * private/loopback/metadata addresses unless the host is in `web.allowHosts`,
 * and connects to the address it checked, so DNS rebinding cannot swap it.
 *
 * Listens on 127.0.0.1 only, on a random port, for the lifetime of one driver.
 * An upstream proxy (HTTPS_PROXY / HTTP_PROXY) is honoured for allowed traffic.
 */
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateAddress } from '../../tools/web.js';

export interface EgressProxy {
  url: string;
  port: number;
  /** Requests refused so far: "host:port: reason" */
  blocked: string[];
  close(): Promise<void>;
}

export interface EgressOptions {
  allowHosts: string[];
  /** Extra check (attached allowlists, tests). Return a reason to refuse. */
  extraCheck?: (host: string, port: number) => string | undefined;
  /** Upstream proxy for allowed traffic; default from HTTPS_PROXY/HTTP_PROXY (not for allowHosts, which are local). */
  upstream?: string | null;
}

function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((h) => host === h || (h.startsWith('*.') && host.endsWith(h.slice(1))));
}

/** Decide and resolve: the address to connect to, or why not. */
export async function resolveGuarded(host: string, port: number, o: EgressOptions): Promise<{ address: string; allowListed: boolean } | { error: string }> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const extra = o.extraCheck?.(h, port);
  if (extra) return { error: extra };
  if (hostAllowed(h, o.allowHosts)) {
    const address = net.isIP(h) ? h : (await dns.lookup(h).catch(() => undefined))?.address;
    return address ? { address, allowListed: true } : { error: `cannot resolve ${h}` };
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return { error: `internal host ${h} (SSRF guard; add it to web.allowHosts if intended)` };
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try {
      addrs = (await dns.lookup(h, { all: true })).map((a) => a.address);
    } catch {
      return { error: `cannot resolve ${h}` };
    }
  }
  if (!addrs.length) return { error: `cannot resolve ${h}` };
  if (addrs.some(isPrivateAddress)) return { error: `${h} resolves to a private/loopback/metadata address (SSRF guard; add it to web.allowHosts if this is a site you trust)` };
  return { address: addrs[0], allowListed: false };
}

function upstreamFor(o: EgressOptions): URL | undefined {
  const u = o.upstream === null ? undefined : o.upstream ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  try {
    return u ? new URL(u) : undefined;
  } catch {
    return undefined;
  }
}

const BLOCK_PAGE = (why: string) => `<!doctype html><html><head><title>Blocked by Tugline</title></head><body><h1>Blocked by the Tugline egress guard</h1><p>${why.replace(/[<>&]/g, '')}</p></body></html>`;

export async function startEgressProxy(o: EgressOptions): Promise<EgressProxy> {
  const blocked: string[] = [];
  const up = upstreamFor(o);
  const sockets = new Set<net.Socket>();

  /** Open a TCP stream to host:port (directly to the checked address, or through the upstream proxy). */
  const openTunnel = (host: string, address: string, port: number, viaUpstream: boolean): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      if (!viaUpstream || !up) {
        const s = net.connect(port, address, () => resolve(s));
        s.once('error', reject);
        return;
      }
      const s = net.connect(Number(up.port || 80), up.hostname, () => {
        const auth = up.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`).toString('base64')}\r\n` : '';
        s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
        let buf = '';
        const onData = (d: Buffer) => {
          buf += d.toString('latin1');
          const end = buf.indexOf('\r\n\r\n');
          if (end < 0) return;
          s.off('data', onData);
          if (!/^HTTP\/1\.[01] 200/.test(buf)) return reject(new Error(`upstream proxy refused CONNECT: ${buf.split('\r\n')[0]}`));
          const rest = Buffer.from(buf.slice(end + 4), 'latin1');
          if (rest.length) s.unshift(rest);
          resolve(s);
        };
        s.on('data', onData);
      });
      s.once('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    // Plain-HTTP proxy request: absolute URI in req.url.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = Number(target.port || 80);
    const g = await resolveGuarded(target.hostname, port, o);
    if ('error' in g) {
      blocked.push(`${target.hostname}:${port}: ${g.error}`);
      res.writeHead(403, { 'Content-Type': 'text/html', 'X-Tugline-Blocked': '1' }).end(BLOCK_PAGE(g.error));
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    try {
      const sock = await openTunnel(target.hostname, g.address, port, !g.allowListed);
      sockets.add(sock);
      // ClientRequest, not http.request: VS Code's extension host replaces http.request with its proxy
      // support, which ignores createConnection and sends the request to the system proxy instead of the
      // guarded socket (the page then gets an empty response).
      const fwd = new http.ClientRequest({ createConnection: () => sock, method: req.method, path: `${target.pathname}${target.search}`, headers: { ...headers, host: target.host } }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      fwd.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
      req.pipe(fwd);
    } catch (e) {
      res.writeHead(502).end(String((e as Error).message));
    }
  });

  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('error', () => undefined);
    const [host, portStr] = (req.url ?? '').split(/:(?=\d+$)/);
    const port = Number(portStr || 443);
    const g = await resolveGuarded(host, port, o);
    if ('error' in g) {
      blocked.push(`${host}:${port}: ${g.error}`);
      client.end('HTTP/1.1 403 Forbidden\r\nX-Tugline-Blocked: 1\r\n\r\n');
      return;
    }
    try {
      const upstream = await openTunnel(host, g.address, port, !g.allowListed);
      sockets.add(upstream);
      upstream.on('error', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
  });

  // ws:// through the proxy arrives as an upgrade request with an absolute URI.
  server.on('upgrade', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    client.on('error', () => undefined);
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      client.destroy();
      return;
    }
    const port = Number(target.port || 80);
    const g = await resolveGuarded(target.hostname, port, o);
    if ('error' in g) {
      blocked.push(`${target.hostname}:${port}: ${g.error}`);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    try {
      const up2 = await openTunnel(target.hostname, g.address, port, !g.allowListed);
      sockets.add(up2);
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`, ...Object.entries(req.headers).filter(([k]) => !k.startsWith('proxy-')).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)];
      up2.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up2.write(head);
      up2.pipe(client);
      client.pipe(up2);
    } catch {
      client.destroy();
    }
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    blocked,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
