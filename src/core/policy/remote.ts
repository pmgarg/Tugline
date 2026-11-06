/**
 * N22: centrally delivered, signed managed policy.
 *
 * A company serves its managed policy at a URL. The local managed file (put in
 * place by MDM, so the user cannot change it) names the URL and pins the
 * Ed25519 public key:
 *
 *   "remote": { "url": "https://policy.corp/tugline", "publicKey": "<PEM or base64 raw 32 bytes>",
 *               "refreshSeconds": 3600, "maxStaleSeconds": 604800, "failClosed": true }
 *
 * `TUG_MANAGED_POLICY_URL` + `TUG_MANAGED_POLICY_PUBLIC_KEY` do the same for
 * deployments that set the environment instead (MDM profiles).
 *
 * The server returns a signed document:
 *   { "policy": { …managed fields… }, "issuedAt": ISO, "expiresAt"?: ISO, "signature": base64 }
 * where `signature` is Ed25519 over canonicalJson(document without `signature`).
 * Canonical JSON: object keys sorted, no whitespace, arrays in order (RFC 8785
 * style for the JSON values a policy uses).
 *
 * The remote policy can only add restrictions: it is combined with the local
 * file by `combinePolicies` (union of denies, intersection of allowlists …).
 *
 * Caching: the last verified document is kept in `<homeDir>/managed-cache/`.
 * It is re-verified on every load, so editing the cache gains nothing. A fetch
 * is attempted when the cache is older than `refreshSeconds`; when the fetch
 * fails, the cache is used offline until its signed `expiresAt`, and never
 * longer than signed `issuedAt + maxStaleSeconds`. The unsigned `fetchedAt` is
 * clamped to now (a future value is not "fresh forever"). Rollback: the newest
 * verified `issuedAt` is persisted (`managed-state/<key>.hwm`, apart from the cache, and
 * `remote.highWaterFile` when set), and an older document, served or cached,
 * is refused. Past that, or with no cache, `failClosed: true` refuses to start
 * and `false` continues with the local file only (reported as a violation).
 *
 * loadConfig is synchronous, so the fetch runs in a short child process (Node's
 * own `fetch`, a hard timeout) only when the cache is stale.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RemotePolicyConfig {
  url: string;
  /** Ed25519 public key: SPKI PEM, or base64 of the raw 32 bytes. */
  publicKey: string;
  /** Refetch when the cache is older than this (default 3600). 0 = every load. */
  refreshSeconds?: number;
  /** Without a signed `expiresAt`, how long a cached document stays usable offline (default 7 days). */
  maxStaleSeconds?: number;
  /** No valid (fresh or unexpired cached) policy → refuse to start (default false). */
  failClosed?: boolean;
  /** Extra request headers (an auth token for the policy server). */
  headers?: Record<string, string>;
  /** Fetch timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Where the newest verified issuedAt is also kept (e.g. a path MDM manages and the user cannot write). */
  highWaterFile?: string;
}

export interface SignedPolicyDocument {
  policy: Record<string, unknown>;
  issuedAt: string;
  expiresAt?: string;
  signature: string;
}

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function publicKeyFrom(s: string): crypto.KeyObject {
  const t = s.trim();
  if (t.startsWith('-----BEGIN')) return crypto.createPublicKey(t);
  const raw = Buffer.from(t, 'base64');
  if (raw.length !== 32) throw new Error('managed remote.publicKey must be an SPKI PEM or base64 of a 32-byte Ed25519 key');
  // SPKI DER prefix for Ed25519 (RFC 8410)
  return crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
}

function signedPart(doc: Partial<SignedPolicyDocument>): string {
  const { signature: _s, ...rest } = doc;
  return canonicalJson(rest);
}

/** Sign a policy (reference server, tests). */
export function signPolicyDocument(policy: Record<string, unknown>, privateKey: crypto.KeyObject | string, opts: { issuedAt?: Date; expiresAt?: Date } = {}): SignedPolicyDocument {
  const doc: Partial<SignedPolicyDocument> = { policy, issuedAt: (opts.issuedAt ?? new Date()).toISOString(), ...(opts.expiresAt ? { expiresAt: opts.expiresAt.toISOString() } : {}) };
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  return { ...(doc as SignedPolicyDocument), signature: crypto.sign(null, Buffer.from(signedPart(doc)), key).toString('base64') };
}

/** Throws unless `doc` is a well-formed document signed by `publicKey`. */
export function verifyPolicyDocument(doc: unknown, publicKey: string): SignedPolicyDocument {
  const d = doc as SignedPolicyDocument;
  if (!d || typeof d !== 'object' || typeof d.signature !== 'string' || !d.policy || typeof d.policy !== 'object' || Array.isArray(d.policy) || typeof d.issuedAt !== 'string') throw new Error('not a signed policy document (expected {policy, issuedAt, signature})');
  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(signedPart(d)), publicKeyFrom(publicKey), Buffer.from(d.signature, 'base64'));
  } catch (e) {
    throw new Error(`signature check failed: ${(e as Error).message}`);
  }
  if (!ok) throw new Error('signature does not match the pinned public key');
  return d;
}

const FETCH_JS = `const [url,headers,ms]=process.argv.slice(1);const c=new AbortController();setTimeout(()=>c.abort(),Number(ms));
fetch(url,{headers:JSON.parse(headers),signal:c.signal}).then(async r=>{const t=await r.text();if(!r.ok){process.stderr.write('HTTP '+r.status+' '+t.slice(0,200));process.exit(2)}process.stdout.write(t)}).catch(e=>{process.stderr.write(String(e&&e.message||e));process.exit(3)});`;

/** Synchronous GET (loadConfig is synchronous). Returns the body or throws. */
export function fetchTextSync(url: string, headers: Record<string, string> = {}, timeoutMs = 5000): string {
  if (!/^https?:\/\//.test(url)) throw new Error(`policy URL must be http(s): ${url}`);
  const r = spawnSync(process.execPath, ['-e', FETCH_JS, url, JSON.stringify(headers), String(timeoutMs)], { encoding: 'utf8', timeout: timeoutMs + 3000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `exit ${r.status}`).trim());
  return r.stdout;
}

export interface RemoteResult {
  /** The verified remote policy, or undefined when none could be used (and failClosed is false). */
  policy?: Record<string, unknown>;
  source: string;
  from: 'network' | 'cache' | 'none';
  /** Problems to report (refused documents, stale cache …). */
  problems: string[];
}

interface CacheFile {
  fetchedAt: string;
  url: string;
  document: SignedPolicyDocument;
}

function cachePath(homeDir: string, url: string): string {
  return path.join(homeDir, 'managed-cache', `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}.json`);
}

/** The newest signed issuedAt ever verified for this URL (a cached document older than it is a rollback); kept apart from the cache. */
function highWaterPath(homeDir: string, url: string): string {
  return path.join(homeDir, 'managed-state', path.basename(cachePath(homeDir, url)).replace(/\.json$/, '.hwm'));
}
function readHighWater(homeDir: string, url: string, extra?: string): number {
  let hwm = 0;
  for (const f of [highWaterPath(homeDir, url), extra].filter((x): x is string => !!x)) {
    try {
      const t = Date.parse(fs.readFileSync(f, 'utf8').trim());
      if (Number.isFinite(t)) hwm = Math.max(hwm, t);
    } catch {
      /* none yet */
    }
  }
  return hwm;
}

/** Fetch (or reuse the cache of) the remote managed policy. Throws when `failClosed` and nothing usable is left. */
export function loadRemotePolicy(rc: RemotePolicyConfig, homeDir: string, now = new Date(), fetchText: typeof fetchTextSync = fetchTextSync): RemoteResult {
  const problems: string[] = [];
  const file = cachePath(homeDir, rc.url);
  const nowMs = now.getTime();
  const maxStaleMs = (rc.maxStaleSeconds ?? 7 * 86400) * 1000;
  // The high-water mark: never accept a document (served or cached) older than the newest one verified.
  // `rc.highWaterFile` may point somewhere the user cannot write (an MDM-managed path).
  const hwm = readHighWater(homeDir, rc.url, rc.highWaterFile);
  let cached: (CacheFile & { valid: boolean }) | undefined;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheFile;
    verifyPolicyDocument(c.document, rc.publicKey);
    if (Date.parse(c.document.issuedAt) < hwm) throw new Error(`it is older (issued ${c.document.issuedAt}) than a policy already verified (${new Date(hwm).toISOString()}): a rollback`);
    cached = { ...c, valid: true };
  } catch (e) {
    if (fs.existsSync(file)) problems.push(`cached remote policy ignored: ${(e as Error).message}`);
  }
  // fetchedAt is not signed: a value in the future is clamped to now, never "fresh forever".
  const fetchedAt = (c: CacheFile) => Math.min(Date.parse(c.fetchedAt) || 0, nowMs);
  // Offline lifetime from signed fields only: the signed expiresAt, and at most issuedAt + maxStaleSeconds.
  const usable = (c: CacheFile) => {
    const issued = Date.parse(c.document.issuedAt);
    const signedExp = c.document.expiresAt ? Date.parse(c.document.expiresAt) : Infinity;
    return nowMs <= Math.min(signedExp, issued + maxStaleMs);
  };
  const fresh = cached && nowMs - fetchedAt(cached) < (rc.refreshSeconds ?? 3600) * 1000 && usable(cached);
  if (cached && fresh) return { policy: cached.document.policy, source: `${rc.url} (cached)`, from: 'cache', problems };
  try {
    const doc = verifyPolicyDocument(JSON.parse(fetchText(rc.url, rc.headers, rc.timeoutMs ?? 5000)), rc.publicKey);
    if (doc.expiresAt && Date.parse(doc.expiresAt) < nowMs) throw new Error(`the served policy expired at ${doc.expiresAt}`);
    if (Date.parse(doc.issuedAt) > nowMs + 5 * 60_000) throw new Error(`the served policy is issued in the future (${doc.issuedAt})`);
    // Never go back to an older document than one already verified (replay of an old, looser policy).
    const newest = Math.max(hwm, cached ? Date.parse(cached.document.issuedAt) : 0);
    if (Date.parse(doc.issuedAt) < newest) throw new Error(`the served policy (issued ${doc.issuedAt}) is older than one already verified (${new Date(newest).toISOString()})`);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: now.toISOString(), url: rc.url, document: doc } satisfies CacheFile, null, 2), { mode: 0o600 });
    fs.mkdirSync(path.dirname(highWaterPath(homeDir, rc.url)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(highWaterPath(homeDir, rc.url), doc.issuedAt, { mode: 0o600 });
    if (rc.highWaterFile)
      try {
        fs.writeFileSync(rc.highWaterFile, doc.issuedAt, { mode: 0o600 });
      } catch {
        /* an MDM path may be read-only for the user; MDM keeps it current */
      }
    return { policy: doc.policy, source: rc.url, from: 'network', problems };
  } catch (e) {
    problems.push(`remote managed policy ${rc.url} refused or unreachable: ${(e as Error).message}`);
  }
  if (cached && usable(cached)) return { policy: cached.document.policy, source: `${rc.url} (cached ${new Date(fetchedAt(cached)).toISOString()})`, from: 'cache', problems };
  if (cached) problems.push(`the cached remote policy expired (${cached.document.expiresAt ?? `issued ${cached.document.issuedAt}, maxStaleSeconds ${maxStaleMs / 1000}`})`);
  if (rc.failClosed) throw new Error(`managed policy: ${problems.join('; ')}. remote.failClosed is set, so Tugline will not start without a valid company policy.`);
  return { from: 'none', source: rc.url, problems };
}

// ------------------------------------------------------------ version pinning

function parts(v: string): number[] {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) throw new Error(`not a version: ${v}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** -1, 0 or 1 (major.minor.patch; pre-release tags are ignored). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** Why this version may not run under the policy, or null. */
export function versionRefusal(version: string, p: { minVersion?: string; maxVersion?: string; allowedVersions?: string[] }): string | null {
  if (p.minVersion && compareVersions(version, p.minVersion) < 0) return `Tugline ${version} is older than the minimum version ${p.minVersion} required by the managed policy; update Tugline`;
  if (p.maxVersion && compareVersions(version, p.maxVersion) > 0) return `Tugline ${version} is newer than the maximum version ${p.maxVersion} allowed by the managed policy; install an allowed version`;
  if (p.allowedVersions?.length && !p.allowedVersions.some((a) => compareVersions(version, a) === 0)) return `Tugline ${version} is not one of the versions allowed by the managed policy (${p.allowedVersions.join(', ')})`;
  return null;
}
