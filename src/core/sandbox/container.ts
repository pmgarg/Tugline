/**
 * N36: whole-session container mode: `tug --container [docker|podman]` or `sandbox.session: "container"`.
 *
 * The whole agent (loop, tools, every command) runs inside a container:
 *  - the workspace is mounted read-write at its own path; nothing else of the host is: not $HOME, not the
 *    harness home (sessions of container runs live in <homeDir>/containers/<project>/home, mounted as the
 *    container's home /oh-home), not /tmp;
 *  - review finding 2: the host never writes into anything the container can write. The in-container config and
 *    trust file are written to a fresh host-only directory (O_EXCL) and mounted READ-ONLY over the container
 *    home's .tugline/config.json; a link the container plants in its home is never followed by the host;
 *  - the agent container has NO network (`--network none`); its only way out is an allowlist proxy (our
 *    DomainProxy) in a sidecar container on the default network, reached through a unix socket in a volume the two
 *    share (a small bridge in the agent container listens on 127.0.0.1:3128/3129 and forwards to the sockets).
 *    Allowed: sandbox.allowDomains only. HTTP(S)_PROXY points there and NODE_USE_ENV_PROXY=1. (No internal bridge
 *    network: with Docker's br_netfilter and FORWARD DROP on the same host, Podman's internal networks drop
 *    container-to-container traffic);
 *  - review findings 7 and 8: the model is reached through a relay in the same sidecar that forwards only to the
 *    configured endpoint(s) (origin and base path, so a local model's host is reachable on its port alone) and adds
 *    the API key and profile headers itself: the key never enters the agent container (no env, no file), so a
 *    command cannot read it from /proc/1/environ;
 *  - hardened: all capabilities dropped, no-new-privileges, pids/memory/cpu limits, the host user's uid/gid
 *    (rootless Podman: keep-id), the harness code mounted read-only;
 *  - the image comes from .tugline/environment.Dockerfile, else .devcontainer/devcontainer.json (image or
 *    build.dockerfile), else sandbox.container.image, else node:22-bookworm-slim. Repository-provided images
 *    are used only when the workspace is trusted (building one runs the repository's Dockerfile);
 *  - nothing outlives the session: containers carry the host pid in a label and are removed on exit, on a
 *    signal, and by the next session if the host process died (SAC4).
 *
 * Compared with Qwen Code's whole-CLI sandbox (packages/cli/src/serve/sandbox.ts), which mounts ~/.qwen, the
 * gcloud config, the ADC file and the whole os.tmpdir() read-write and passes API keys and the host network by
 * default, no host credential reaches the container and network egress is allowlisted, not optional.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { HarnessConfig } from '../config.js';
import { isWorkspaceTrusted, resolveProfile } from '../config.js';
import { containerLabels } from '../tools/shell.js';
import { buildUpstreamTarget, MODEL_API_PATHS } from '../util/upstream.js';
import http from 'node:http';
import https from 'node:https';
import { projectKey } from '../agent/journal.js';
import { denyReadPaths, expandTilde, within } from './settings.js';

export interface ContainerSettings {
  /** auto = docker if it runs, else podman */
  engine?: 'auto' | 'docker' | 'podman';
  /** image for the session when the repository provides none */
  image?: string;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  /**
   * Extra host directories (Qwen: SANDBOX_MOUNTS), read-only unless `mode: "rw"`. Credential stores and the harness
   * home are refused. User scope only.
   */
  mounts?: { from: string; to?: string; mode?: 'ro' | 'rw' }[];
  /** Extra environment for the session (Qwen: SANDBOX_ENV). Credential-looking names are refused. User scope only. */
  env?: Record<string, string>;
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** N36: container session settings (sandbox.session: "container" turns it on). */
    container?: ContainerSettings;
  }
}

export const DEFAULT_SESSION_IMAGE = 'node:22-bookworm-slim';
export const PROXY_PORT = 3128;
export const SESSION_ENV = 'TUG_CONTAINER_SESSION';

export interface SessionPlan {
  ok: boolean;
  engine?: 'docker' | 'podman';
  image?: string;
  source?: 'environment.Dockerfile' | 'devcontainer' | 'config' | 'default';
  /** a Dockerfile to build first (tag = image) */
  build?: { dockerfile: string; context: string };
  reason?: string;
}

function runs(bin: string): boolean {
  return spawnSync(bin, ['version'], { stdio: 'ignore', timeout: 15_000 }).status === 0;
}

function settingsOf(cfg: HarnessConfig): ContainerSettings {
  return { ...((cfg.sandbox as { container?: ContainerSettings } | undefined)?.container ?? {}), ...(cfg.container ?? {}) };
}

/** Strip // comments from devcontainer.json (JSONC) without touching strings. */
function parseJsonc(text: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

/** Which engine and image a container session would use, or why it cannot start. */
export function containerSessionPlan(cfg: HarnessConfig, workspace: string, engineArg?: string, probe: (bin: string) => boolean = runs): SessionPlan {
  const st = settingsOf(cfg);
  const want = (engineArg && engineArg !== 'true' ? engineArg : st.engine) ?? 'auto';
  if (!['auto', 'docker', 'podman'].includes(want)) return { ok: false, reason: `unknown container engine "${want}" (docker | podman)` };
  let engine: 'docker' | 'podman' | undefined;
  if (want === 'auto') engine = probe('docker') ? 'docker' : probe('podman') ? 'podman' : undefined;
  else engine = probe(want) ? (want as 'docker' | 'podman') : undefined;
  if (!engine) return { ok: false, reason: want === 'auto' ? 'neither docker nor podman can run here (install one, or start the Docker daemon)' : `${want} is not installed or cannot run (\`${want} version\` failed)` };
  const trusted = cfg.trust?.workspaceTrusted ?? isWorkspaceTrusted(cfg.homeDir, workspace);
  const envFile = path.join(workspace, '.tugline', 'environment.Dockerfile');
  if (fs.existsSync(envFile)) {
    if (!trusted) return { ok: false, engine, reason: `.tugline/environment.Dockerfile is provided by the repository and building it runs its commands: trust the workspace first (tug --trust)` };
    const hash = crypto.createHash('sha256').update(fs.readFileSync(envFile)).digest('hex').slice(0, 12);
    return { ok: true, engine, image: `tugline-env:${hash}`, source: 'environment.Dockerfile', build: { dockerfile: envFile, context: workspace } };
  }
  const dc = [path.join(workspace, '.devcontainer', 'devcontainer.json'), path.join(workspace, '.devcontainer.json')].find((f) => fs.existsSync(f));
  if (dc) {
    let spec: any;
    try {
      spec = parseJsonc(fs.readFileSync(dc, 'utf8'));
    } catch (e) {
      return { ok: false, engine, reason: `${path.relative(workspace, dc)} is not valid JSON: ${(e as Error).message}` };
    }
    if (!trusted) return { ok: false, engine, reason: `${path.relative(workspace, dc)} names the image the agent would run in: trust the workspace first (tug --trust)` };
    if (typeof spec?.image === 'string') return { ok: true, engine, image: spec.image, source: 'devcontainer' };
    const df = spec?.build?.dockerfile ?? spec?.dockerFile;
    if (typeof df === 'string') {
      const dir = path.dirname(dc);
      const dockerfile = path.resolve(dir, df);
      const context = path.resolve(dir, typeof spec.build?.context === 'string' ? spec.build.context : '.');
      if (!dockerfile.startsWith(workspace + path.sep) || !(context + path.sep).startsWith(workspace + path.sep)) return { ok: false, engine, reason: `${path.relative(workspace, dc)} points its build outside the workspace` };
      const hash = crypto.createHash('sha256').update(fs.readFileSync(dockerfile)).digest('hex').slice(0, 12);
      return { ok: true, engine, image: `tugline-env:${hash}`, source: 'devcontainer', build: { dockerfile, context } };
    }
    return { ok: false, engine, reason: `${path.relative(workspace, dc)} has neither "image" nor "build.dockerfile"` };
  }
  if (st.image) return { ok: true, engine, image: st.image, source: 'config' };
  return { ok: true, engine, image: DEFAULT_SESSION_IMAGE, source: 'default' };
}

/** The installed harness: its root, and the argv that starts its CLI with node (inside the container, same paths). */
export function harnessEntry(): { root: string; argv: string[] } {
  const here = fileURLToPath(import.meta.url);
  let root = path.dirname(here);
  while (root !== path.dirname(root) && !fs.existsSync(path.join(root, 'package.json'))) root = path.dirname(root);
  if (here.endsWith('.ts')) return { root, argv: ['--import', path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), path.join(root, 'src', 'cli', 'main.ts')] };
  return { root, argv: [path.join(root, 'dist', 'cli', 'main.js')] };
}

function proxyEntry(root: string): string[] {
  const ts = path.join(root, 'src', 'core', 'sandbox', 'containerProxy.ts');
  if (fileURLToPath(import.meta.url).endsWith('.ts')) return ['--import', path.join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'), ts];
  return [path.join(root, 'dist', 'core', 'sandbox', 'containerProxy.js')];
}

/** The host's address as seen from the default container network (Linux: the bridge gateway; Desktop: host.docker.internal). */
export function hostGateway(engine: 'docker' | 'podman'): string {
  if (process.platform !== 'linux') return engine === 'docker' ? 'host.docker.internal' : 'host.containers.internal';
  const net = engine === 'docker' ? 'bridge' : 'podman';
  const r = spawnSync(engine, ['network', 'inspect', net], { encoding: 'utf8', timeout: 15_000 });
  try {
    const j = JSON.parse(r.stdout)[0];
    const gw = j?.IPAM?.Config?.[0]?.Gateway ?? j?.subnets?.[0]?.gateway;
    if (typeof gw === 'string' && gw) return gw;
  } catch {
    /* fall through */
  }
  return engine === 'docker' ? '172.17.0.1' : '10.88.0.1';
}

/** A model endpoint on the host's loopback is rewritten to the host as the containers see it. */
export function rewriteEndpoint(url: string, gateway: string): string {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(u.hostname)) {
      u.hostname = gateway;
      return u.toString().replace(/\/$/, url.endsWith('/') ? '/' : '');
    }
  } catch {
    /* not a URL: leave it */
  }
  return url;
}

function sh(engine: string, args: string[], timeout = 120_000): { ok: boolean; out: string } {
  const r = spawnSync(engine, args, { encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SAC4: remove session containers and networks whose host process is gone (a crash, kill -9). */
export function sweepStale(engine: 'docker' | 'podman'): string[] {
  const removed: string[] = [];
  const sessions = new Set<string>();
  for (const [id, pid, host, session] of containerLabels(engine, 'tugline.session')) {
    if (!id || !pid || host !== os.hostname() || pidAlive(Number(pid))) continue;
    sh(engine, ['rm', '-f', id]);
    removed.push(id);
    if (session) sessions.add(session);
  }
  for (const s of sessions) {
    sh(engine, ['volume', 'rm', '-f', `oh-sock-${s}`]);
    sh(engine, ['network', 'rm', `oh-net-${s}`]); // sessions of earlier versions
  }
  return removed;
}

export interface SessionOptions {
  cfg: HarnessConfig;
  workspace: string;
  /** arguments for the in-container `tug` (the host argv without --container) */
  args: string[];
  engine?: string;
  /** stdio for the agent container (default inherit) */
  stdio?: 'inherit' | 'pipe';
  /** extra env for the in-container harness (tests) */
  env?: Record<string, string>;
  /** called with the agent child when stdio is "pipe" */
  onChild?: (c: ChildProcess) => void;
}

export interface SessionResult {
  code: number;
  id: string;
  engine: 'docker' | 'podman';
  image: string;
}

/** The config the in-container harness runs with: the host's effective config, minus secrets, minus the session switch. */
export function innerConfig(cfg: HarnessConfig, gateway: string, relayUrl?: (baseUrl: string) => string): Record<string, unknown> {
  const profiles: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(cfg.profiles)) profiles[k] = { ...p, apiKey: undefined, headers: undefined, ...(p.baseUrl ? { baseUrl: relayUrl ? relayUrl(p.baseUrl) : rewriteEndpoint(p.baseUrl, gateway) } : {}) };
  const sb = { ...(cfg.sandbox ?? {}) } as Record<string, unknown>;
  delete sb.trustProjectConfig;
  return {
    profile: cfg.profile,
    profiles,
    smallProfile: cfg.smallProfile,
    permissionMode: cfg.permissionMode,
    permissions: cfg.permissions,
    shell: { ...cfg.shell, sandbox: 'none', requireSandbox: false, processLifetime: 'off' },
    web: { ...cfg.web, braveApiKey: undefined, tavilyApiKey: undefined },
    agent: cfg.agent,
    skills: { disabled: cfg.skills.disabled },
    hooks: {},
    mcpServers: {},
    // the container is the sandbox: commands run inside it; the session switch is off so the inner harness does not recurse
    sandbox: { ...sb, session: 'host', runner: 'none', mode: undefined, require: false, required: false, containerSession: true },
    checkpoints: (cfg as { checkpoints?: unknown }).checkpoints,
    securityEvents: cfg.securityEvents,
  };
}

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION)/i;

/** `-v` arguments for sandbox.container.mounts; credential stores and the harness home are refused. */
export function extraMounts(list: { from: string; to?: string; mode?: 'ro' | 'rw' }[], cfg: HarnessConfig): string[] {
  const deny = denyReadPaths({ homeDir: cfg.homeDir, sandbox: cfg.sandbox as { denyRead?: string[] } | undefined });
  const out: string[] = [];
  for (const m of list) {
    const from = path.resolve(expandTilde(m.from));
    if (!path.isAbsolute(m.from) && !m.from.startsWith('~')) throw new Error(`container session: mount ${m.from} must be absolute`);
    if (!fs.existsSync(from)) throw new Error(`container session: mount ${m.from} does not exist`);
    if (deny.some((d) => within(from, d) || within(d, from))) throw new Error(`container session: mount ${m.from} is or contains a credential store or the harness home; it is never mounted`);
    out.push('-v', `${from}:${m.to ?? from}:${m.mode === 'rw' ? 'rw' : 'ro'}`);
  }
  return out;
}

/** Podman: an empty auth file, so the client neither reads nor refreshes registry credentials (Qwen parity). */
function emptyAuthFile(): string {
  const f = path.join(os.tmpdir(), `oh-podman-auth-${process.pid}.json`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, '{}', { mode: 0o600 });
  return f;
}

/**
 * In the agent container: listen on 127.0.0.1 ports and forward each to a unix socket in the shared volume, then run
 * the harness. `node -e BRIDGE sock1 port1 [sock2 port2 …] -- file args…`
 */
export const CONTAINER_BRIDGE_JS = `const net=require('net'),cp=require('child_process');const a=process.argv.slice(1);const k=a.indexOf('--');
const pairs=a.slice(0,k);const cmd=a.slice(k+1);let up=0;
for(let i=0;i<pairs.length;i+=2){const sock=pairs[i],port=Number(pairs[i+1]);
const srv=net.createServer(c=>{const u=net.connect(sock);c.pipe(u);u.pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy());});
srv.on('error',e=>{process.stderr.write('container bridge: '+e.message+'\\n');process.exit(126);});
srv.listen(port,'127.0.0.1',()=>{if(++up<pairs.length/2)return;const ch=cp.spawn(cmd[0],cmd.slice(1),{stdio:'inherit'});
for(const s of ['SIGTERM','SIGINT','SIGHUP'])process.on(s,()=>ch.kill(s));
ch.on('error',e=>{process.stderr.write(e.message+'\\n');process.exit(127);});
ch.on('exit',(code,sig)=>process.exit(code==null?128+((require('os').constants.signals||{})[sig]||9):code));});}`;
export const SOCK_DIR = '/oh-sock';

/** The container's home directory (its own path: the host path is never reused inside). */
export const CONTAINER_HOME = '/oh-home';
export const RELAY_PORT = 3129;

/** One model endpoint the relay forwards to, with the credentials it adds (they stay in the sidecar). */
export interface RelayRoute {
  prefix: string;
  origin: string;
  basePath: string;
  headers: Record<string, string>;
}

/** The relay routes for a config: one per distinct endpoint, keyed by its rewritten base URL. */
export function relayRoutes(cfg: HarnessConfig, gateway: string): { routes: RelayRoute[]; byBase: Map<string, string> } {
  const routes: RelayRoute[] = [];
  const byBase = new Map<string, string>();
  for (const name of Object.keys(cfg.profiles)) {
    const raw = cfg.profiles[name]?.baseUrl;
    if (!raw || byBase.has(raw)) continue;
    let u: URL;
    try {
      u = new URL(rewriteEndpoint(raw, gateway));
    } catch {
      continue;
    }
    const prof = (() => {
      try {
        return resolveProfile(cfg, name);
      } catch {
        return undefined;
      }
    })();
    const headers: Record<string, string> = { ...(prof?.headers ?? {}) };
    if (prof?.apiKey) headers.authorization = `Bearer ${prof.apiKey}`;
    const prefix = `/m${routes.length}`;
    routes.push({ prefix, origin: u.origin, basePath: u.pathname.replace(/\/$/, '') || '/', headers });
    byBase.set(raw, prefix + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')));
  }
  return { routes, byBase };
}

/**
 * Where a relay request goes, or why not (re-check RC-1). The prefix picks the route; everything after it goes
 * through the shared `buildUpstreamTarget` (src/core/util/upstream.ts): no other origin, nothing outside the
 * endpoint's base path, no encoded or literal dot segments, model API paths only. The key is added by the caller
 * only to a target this returns.
 */
export function relayTarget(routes: RelayRoute[], url: string, method?: string): { route: RelayRoute; target: URL } | { error: string } {
  const m = /^\/m(\d+)(\/.*)?$/s.exec(url);
  const route = m ? routes.find((r) => r.prefix === `/m${m[1]}`) : undefined;
  if (!m || !route) return { error: 'unknown model route' };
  const t = buildUpstreamTarget(route, m[2] ?? '/', MODEL_API_PATHS, method);
  return t.ok ? { route, target: t.url } : { error: t.reason };
}

/**
 * The relay's request handler (run in the sidecar by containerProxy.ts; exported for tests). Hop-by-hop and
 * credential headers from the agent are dropped; the route's own headers (the API key) are added only after
 * `relayTarget` accepted the request; a redirect from upstream is never followed or passed on (502).
 */
export function relayHandler(routes: RelayRoute[], log: (e: Record<string, unknown>) => void = () => {}): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    const t = relayTarget(routes, req.url ?? '/', req.method ?? '');
    if ('error' in t) {
      log({ relay: req.url, allowed: false, reason: t.error });
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`relay: ${t.error}\n`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!['host', 'authorization', 'proxy-authorization', 'cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'].includes(k)) headers[k] = v;
    for (const [k, v] of Object.entries(t.route.headers)) headers[k.toLowerCase()] = v;
    const mod = t.target.protocol === 'https:' ? https : http;
    const up = mod.request(t.target, { method: req.method, headers }, (r) => {
      if ((r.statusCode ?? 0) >= 300 && (r.statusCode ?? 0) < 400) {
        r.resume();
        log({ relay: t.route.prefix, allowed: true, path: t.target.pathname, redirectRefused: r.statusCode });
        res.writeHead(502, { 'content-type': 'text/plain' }).end('relay: the model endpoint answered with a redirect, which the relay does not follow\n');
        return;
      }
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      log({ relay: t.route.prefix, allowed: true, error: e.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`relay: ${e.message}\n`);
    });
    req.pipe(up);
    log({ relay: t.route.prefix, allowed: true, path: t.target.pathname });
  };
}

/**
 * Review finding 2: make a directory the host itself will write into, refusing any symlink on the way (the parent
 * is host-only; this only guards against a link planted before this fix).
 */
function hostOnlyDir(p: string): void {
  try {
    if (fs.lstatSync(p).isSymbolicLink()) fs.rmSync(p, { force: true });
  } catch {
    /* absent */
  }
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(p).isDirectory()) throw new Error(`container session: ${p} is not a directory`);
}

/** Run a whole session in a container. Resolves with the in-container `tug`'s exit code. */
export async function runContainerSession(o: SessionOptions): Promise<SessionResult> {
  const plan = containerSessionPlan(o.cfg, o.workspace, o.engine);
  if (!plan.ok || !plan.engine || !plan.image) throw new Error(`container session refused: ${plan.reason}`);
  const engine = plan.engine;
  const image = plan.image;
  const st = settingsOf(o.cfg);
  sweepStale(engine);
  if (plan.build) {
    const exists = sh(engine, ['image', 'inspect', image], 30_000).ok;
    if (!exists) {
      const b = spawnSync(engine, ['build', '-f', plan.build.dockerfile, '-t', image, plan.build.context], { stdio: o.stdio === 'pipe' ? 'pipe' : ['ignore', 'inherit', 'inherit'], timeout: 1_800_000 });
      if (b.status !== 0) throw new Error(`container session: building ${path.relative(o.workspace, plan.build.dockerfile)} failed (exit ${b.status})`);
    }
  } else if (!sh(engine, ['image', 'inspect', image], 30_000).ok) {
    const p = sh(engine, ['pull', image], 900_000);
    if (!p.ok) throw new Error(`container session: cannot pull ${image}: ${p.out.split('\n').pop()}`);
  }
  const nodeOk = sh(engine, ['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 3)'], 120_000);
  if (!nodeOk.ok) throw new Error(`container session: image ${image} has no Node.js >= 20, which the harness needs inside the container (${nodeOk.out.split('\n').pop() ?? ''})`);

  const id = crypto.randomBytes(5).toString('hex');
  const vol = `oh-sock-${id}`;
  const proxyName = `oh-proxy-${id}`;
  const agentName = `oh-agent-${id}`;
  const labels = ['--label', `tugline.session=${id}`, '--label', `tugline.pid=${process.pid}`, '--label', `tugline.host=${os.hostname()}`];
  const { root, argv: entry } = harnessEntry();
  const gateway = hostGateway(engine);
  const { sandboxConfig } = await import('./index.js');
  const sb = sandboxConfig(o.cfg);
  // review findings 7/8: the model is reached through the sidecar's relay, which holds the key; the egress proxy
  // allows only sandbox.allowDomains (the model host is NOT opened on every port)
  const { routes, byBase } = relayRoutes(o.cfg, gateway);
  const allow = sb.network === 'host' ? ['*'] : [...new Set(sb.allowDomains)];
  const stateDir = path.join(o.cfg.homeDir, 'containers', projectKey(o.workspace));
  hostOnlyDir(stateDir);
  // the container's home: writable by the container, never written by the host (review finding 2)
  const dataHome = path.join(stateDir, 'home');
  hostOnlyDir(dataHome);
  // the mount points for the read-only files: a directory the inner harness can write its sessions into; a link the
  // container left in place of either is removed (unlink never follows it), never written through
  hostOnlyDir(path.join(dataHome, '.tugline'));
  for (const f of ['config.json', 'trusted-workspaces.json']) {
    const t = path.join(dataHome, '.tugline', f);
    try {
      if (!fs.lstatSync(t).isFile()) fs.rmSync(t, { recursive: true, force: true });
    } catch {
      /* absent */
    }
  }
  // the generated files: a fresh host-only directory, created exclusively, mounted read-only
  const gen = fs.mkdtempSync(path.join(stateDir, 'run-'));
  const writeNew = (f: string, body: string) => fs.writeFileSync(path.join(gen, f), body, { mode: 0o600, flag: 'wx' });
  const cleanup = () => {
    // one by one: Podman stops at the first name it does not know (the agent's --rm may have removed it already)
    for (const n of [agentName, proxyName]) spawnSync(engine, ['rm', '-f', ...(engine === 'podman' ? ['--ignore'] : []), n], { stdio: 'ignore', timeout: 60_000 });
    spawnSync(engine, ['volume', 'rm', '-f', vol], { stdio: 'ignore', timeout: 60_000 });
    fs.rmSync(gen, { recursive: true, force: true });
  };
  const onExit = () => cleanup();
  process.once('exit', onExit);
  const hardening = ['--cap-drop=ALL', '--security-opt=no-new-privileges', `--pids-limit=${st.pidsLimit ?? 1024}`, `--memory=${st.memory ?? '4g'}`, `--cpus=${st.cpus ?? 2}`];
  const user = typeof process.getuid === 'function' ? (engine === 'podman' && process.getuid() !== 0 ? ['--userns=keep-id'] : ['--user', `${process.getuid()}:${process.getgid!()}`]) : [];
  try {
    // the volume the two containers share (the proxy's and the relay's sockets); no network between them
    const v = sh(engine, ['volume', 'create', ...labels.filter((_, i) => i < 2), vol]);
    if (!v.ok) throw new Error(`container session: cannot create the socket volume: ${v.out}`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    if (uid !== 0 && engine === 'docker') {
      // a fresh volume is root's: hand it to the user the containers run as
      const c = sh(engine, ['run', '--rm', '--network', 'none', '-v', `${vol}:${SOCK_DIR}`, '--user', '0:0', '--entrypoint', 'chown', image, `${uid}:${process.getgid!()}`, SOCK_DIR]);
      if (!c.ok) throw new Error(`container session: cannot prepare the socket volume: ${c.out}`);
    }
    // the egress proxy and model relay: default network; the only container with a route out.
    // The relay's routes (with the API key) reach it through the client's environment, not argv.
    const p = spawnSync(engine, ['run', '-d', '--rm', '--name', proxyName, ...labels, ...hardening, ...user, ...(process.platform === 'linux' && engine === 'docker' ? ['--add-host', `host.docker.internal:host-gateway`] : []), '-v', `${root}:${root}:ro`, '-v', `${vol}:${SOCK_DIR}`, '-e', 'TUG_RELAY_ROUTES', '--entrypoint', 'node', image, ...proxyEntry(root), '--socket-dir', SOCK_DIR, '--allow', JSON.stringify(allow)], { encoding: 'utf8', timeout: 120_000, env: { ...process.env, TUG_RELAY_ROUTES: JSON.stringify(routes) } });
    if (p.status !== 0) throw new Error(`container session: cannot start the egress proxy: ${`${p.stdout ?? ''}${p.stderr ?? ''}`.trim()}`);
    // wait until both sockets listen
    for (let i = 0; ; i++) {
      const logs = sh(engine, ['logs', proxyName], 15_000).out;
      if (/relayListening/.test(logs)) break;
      if (i > 120) throw new Error(`container session: the egress proxy did not start: ${logs.slice(-400)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    const proxyHost = '127.0.0.1';
    const relayBase = `http://${proxyHost}:${RELAY_PORT}`;
    writeNew('config.json', JSON.stringify(innerConfig(o.cfg, gateway, (b) => relayBase + (byBase.get(b) ?? '/m-unknown')), null, 2));
    writeNew('trusted-workspaces.json', JSON.stringify(o.cfg.trust?.workspaceTrusted ? { [o.workspace]: true } : {}));
    const proxyUrl = `http://${proxyHost}:${PROXY_PORT}`;
    const env: Record<string, string> = {
      HOME: CONTAINER_HOME,
      [SESSION_ENV]: id,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      // the relay is reached directly; everything else goes through the egress proxy
      NO_PROXY: proxyHost,
      no_proxy: proxyHost,
      NODE_USE_ENV_PROXY: '1',
      TUG_PROFILE: o.cfg.profile,
      TERM: process.env.TERM ?? 'dumb',
      ...(o.env ?? {}),
    };
    for (const [k, v] of Object.entries(st.env ?? {})) {
      if (SECRET_NAME.test(k)) throw new Error(`container session: sandbox.container.env ${k} looks like a credential; pass secrets through the vault, not the container environment`);
      if (!(k in env)) env[k] = String(v);
    }
    const envArgs = Object.keys(env).flatMap((k) => ['-e', k]);
    const mounts = extraMounts(st.mounts ?? [], o.cfg);
    const tty = o.stdio !== 'pipe' && process.stdin.isTTY && process.stdout.isTTY;
    const ohDir = `${CONTAINER_HOME}/.tugline`;
    const args = ['run', '--rm', '-i', ...(tty ? ['-t'] : []), '--init', '--name', agentName, '--network', 'none', '-v', `${vol}:${SOCK_DIR}`, ...labels, ...hardening, ...user, '-v', `${o.workspace}:${o.workspace}`, '-v', `${dataHome}:${CONTAINER_HOME}`, '-v', `${path.join(gen, 'config.json')}:${ohDir}/config.json:ro`, '-v', `${path.join(gen, 'trusted-workspaces.json')}:${ohDir}/trusted-workspaces.json:ro`, '-v', `${root}:${root}:ro`, ...mounts, ...(engine === 'podman' ? ['--authfile', emptyAuthFile()] : []), '-w', o.workspace, ...envArgs, '--entrypoint', 'node', image, '-e', CONTAINER_BRIDGE_JS, `${SOCK_DIR}/proxy.sock`, String(PROXY_PORT), `${SOCK_DIR}/relay.sock`, String(RELAY_PORT), '--', 'node', ...entry, ...o.args];
    const child = spawn(engine, args, { stdio: o.stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, ...env } });
    o.onChild?.(child);
    const fwd = (sig: NodeJS.Signals) => () => {
      spawnSync(engine, ['kill', '--signal', sig, agentName], { stdio: 'ignore', timeout: 15_000 });
    };
    const handlers: [NodeJS.Signals, () => void][] = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map((s) => [s, fwd(s)]);
    for (const [s, h] of handlers) process.on(s, h);
    const code = await new Promise<number>((resolve) => {
      child.on('error', () => resolve(125));
      child.on('close', (c) => resolve(c ?? 1));
    });
    for (const [s, h] of handlers) process.off(s, h);
    return { code, id, engine, image };
  } finally {
    cleanup();
    process.off('exit', onExit);
  }
}
