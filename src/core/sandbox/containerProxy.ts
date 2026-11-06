/**
 * N36: the egress proxy and model relay of a container session, run with node inside the sidecar container
 * (container.ts):
 *   node containerProxy.js --socket-dir /oh-sock --allow '["host",…]'     (relay routes in $TUG_RELAY_ROUTES)
 * It listens on unix sockets in a volume shared with the agent container, which has no network at all
 * (`--network none`): /oh-sock/proxy.sock (the egress proxy) and /oh-sock/relay.sock (the model relay).
 * The proxy is the same DomainProxy the per-command sandbox uses: CONNECT and plain HTTP, allowlist, private-address
 * block, DNS pinned once.
 * The relay (review findings 7 and 8) forwards `/m<i>/<path>` to the configured model endpoint i only (its origin and
 * base path, nothing else on that host) and adds the API key and profile headers, which live only in this process:
 * the agent container never holds them. Every decision is printed as one JSON line (`docker logs` shows them).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DomainProxy } from './proxy.js';
import { relayHandler, type RelayRoute } from './container.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = Number(arg('port') ?? 3128);
const allow = JSON.parse(arg('allow') ?? '[]') as string[];
const privateOk = JSON.parse(arg('trusted-private') ?? '[]') as string[];
const upstream = arg('upstream');
const proxy = new DomainProxy({ allowDomains: allow, privateOk, upstream, noProxy: privateOk });
let seen = 0;
setInterval(() => {
  for (const e of proxy.log.slice(seen)) process.stdout.write(JSON.stringify(e) + '\n');
  seen = proxy.log.length;
}, 500).unref();
const sockDir = arg('socket-dir');
if (sockDir) proxy.listenUnix(path.join(sockDir, 'proxy.sock'));
else proxy.listenTcpOn(port, '0.0.0.0');
process.stdout.write(JSON.stringify({ listening: sockDir ? path.join(sockDir, 'proxy.sock') : port, allow }) + '\n');

const relayPort = Number(arg('relay-port') ?? 0);
if (relayPort || sockDir) {
  const routes = JSON.parse(process.env.TUG_RELAY_ROUTES ?? '[]') as RelayRoute[];
  delete process.env.TUG_RELAY_ROUTES;
  const relay = http.createServer(relayHandler(routes, (e) => process.stdout.write(JSON.stringify(e) + '\n')));
  const where = sockDir ? path.join(sockDir, 'relay.sock') : undefined;
  if (where) fs.rmSync(where, { force: true });
  const ready = () => process.stdout.write(JSON.stringify({ relayListening: where ?? relayPort, routes: routes.map((r) => `${r.origin}${r.basePath}`) }) + '\n');
  if (where) relay.listen(where, ready);
  else relay.listen(relayPort, '0.0.0.0', ready);
}
for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => (proxy.close(), process.exit(0)));
setInterval(() => undefined, 1 << 30);
