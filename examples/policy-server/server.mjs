#!/usr/bin/env node
/**
 * Reference company policy server for Tugline (N22/N23). Small on purpose:
 * a starting point and a test fixture, not a product. Put it behind your SSO
 * proxy or gateway in real use.
 *
 *   GET  /policy   the signed managed policy: { policy, issuedAt, expiresAt?, signature }
 *                  (Ed25519 over the canonical JSON of everything but `signature`)
 *   POST /usage    a client's daily totals { client, user, date, tokens, costUsd, calls }
 *                  → { user, date, used: {tokens, costUsd}, quota }  (sum over the user's clients)
 *   POST /audit    external anchor for audit.sink: journal and security-event records
 *   GET  /audit    the anchors received (for inspection and tests)
 *   GET  /public-key  the public key to pin in the local managed file (base64 raw 32 bytes)
 *
 * Run:   node examples/policy-server/server.mjs --port 8787 --policy policy.json \
 *          [--key private.pem] [--quota-tokens 200000] [--quota-usd 5] [--ttl 3600]
 * Without --key a fresh key pair is generated and the public key printed.
 * --json prints one JSON line {url, publicKey} instead (scripts, tests). --control enables
 * POST /_control {policy?, quota?, quotas?, tamper?: 'policy'|'unsigned'|null, down?} for tests: never in production.
 * Use from code: `const s = await startPolicyServer({ policy, quota })`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
    .join(',')}}`;
}

export function rawPublicKey(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

export function signDocument(policy, privateKey, { ttlSeconds, now = new Date() } = {}) {
  const doc = { policy, issuedAt: now.toISOString(), ...(ttlSeconds ? { expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() } : {}) };
  return { ...doc, signature: crypto.sign(null, Buffer.from(canonicalJson(doc)), privateKey).toString('base64') };
}

/**
 * @param {{ policy?: object, privateKey?: crypto.KeyObject, quota?: {tokensPerDay?: number, costUsdPerDay?: number},
 *           quotas?: Record<string, {tokensPerDay?: number, costUsdPerDay?: number}>, ttlSeconds?: number, port?: number, host?: string }} o
 */
export async function startPolicyServer(o = {}) {
  const pair = o.privateKey ? { privateKey: o.privateKey, publicKey: crypto.createPublicKey(o.privateKey) } : crypto.generateKeyPairSync('ed25519');
  const state = {
    policy: o.policy ?? {},
    /** set to tamper with the served document (tests) */
    tamper: undefined,
    usage: new Map(), // `${user}\0${date}` → Map(client → {tokens, costUsd, calls})
    anchors: [],
    requests: { policy: 0, usage: 0, audit: 0 },
    down: false,
  };
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (state.down) {
        res.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/policy') {
        state.requests.policy++;
        let doc = signDocument(state.policy, pair.privateKey, { ttlSeconds: o.ttlSeconds });
        if (state.tamper) doc = state.tamper(doc);
        return json(res, 200, doc);
      }
      if (req.method === 'GET' && url.pathname === '/public-key') return json(res, 200, { publicKey: rawPublicKey(pair.publicKey) });
      if (req.method === 'POST' && url.pathname === '/usage') {
        state.requests.usage++;
        let r;
        try {
          r = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'bad json' });
        }
        if (typeof r.user !== 'string' || typeof r.date !== 'string' || typeof r.client !== 'string') return json(res, 400, { error: 'user, date and client are required' });
        const key = `${r.user}\0${r.date}`;
        const per = state.usage.get(key) ?? new Map();
        per.set(r.client, { tokens: Number(r.tokens) || 0, costUsd: Number(r.costUsd) || 0, calls: Number(r.calls) || 0 });
        state.usage.set(key, per);
        const used = [...per.values()].reduce((a, x) => ({ tokens: a.tokens + x.tokens, costUsd: a.costUsd + x.costUsd }), { tokens: 0, costUsd: 0 });
        return json(res, 200, { user: r.user, date: r.date, used, quota: o.quotas?.[r.user] ?? o.quota });
      }
      if (req.method === 'POST' && url.pathname === '/audit') {
        state.requests.audit++;
        try {
          state.anchors.push(JSON.parse(raw));
        } catch {
          return json(res, 400, { error: 'bad json' });
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/audit') return json(res, 200, state.anchors);
      if (o.control && req.method === 'POST' && url.pathname === '/_control') {
        const c = JSON.parse(raw || '{}');
        if ('policy' in c) state.policy = c.policy;
        if ('quota' in c) o.quota = c.quota;
        if ('quotas' in c) o.quotas = c.quotas;
        if ('down' in c) state.down = !!c.down;
        if ('tamper' in c) state.tamper = c.tamper === 'policy' ? (d) => ({ ...d, policy: { ...d.policy, deny: [] } }) : c.tamper === 'unsigned' ? (d) => ({ policy: d.policy, issuedAt: d.issuedAt }) : undefined;
        return json(res, 200, { ok: true });
      }
      json(res, 404, { error: 'not found' });
    });
  });
  await new Promise((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://${o.host ?? '127.0.0.1'}:${port}`;
  return {
    url: base,
    policyUrl: `${base}/policy`,
    usageUrl: `${base}/usage`,
    auditUrl: `${base}/audit`,
    publicKey: rawPublicKey(pair.publicKey),
    state,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const policy = arg('--policy') ? JSON.parse(fs.readFileSync(arg('--policy'), 'utf8')) : {};
  const privateKey = arg('--key') ? crypto.createPrivateKey(fs.readFileSync(arg('--key'), 'utf8')) : undefined;
  const quota = arg('--quota-tokens') || arg('--quota-usd') ? { tokensPerDay: Number(arg('--quota-tokens')) || undefined, costUsdPerDay: Number(arg('--quota-usd')) || undefined } : undefined;
  const port = arg('--port') === undefined ? 8787 : Number(arg('--port'));
  const s = await startPolicyServer({ policy, privateKey, quota, ttlSeconds: Number(arg('--ttl')) || undefined, port, host: arg('--host') ?? '127.0.0.1', control: process.argv.includes('--control') });
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ url: s.url, publicKey: s.publicKey }) + '\n');
  else process.stdout.write(`policy server on ${s.url}\n  pin this key in the managed file: "remote": { "url": "${s.policyUrl}", "publicKey": "${s.publicKey}" }\n  usage: "usage": { "url": "${s.usageUrl}" }   audit: "audit": { "sink": "${s.auditUrl}" }\n`);
}
