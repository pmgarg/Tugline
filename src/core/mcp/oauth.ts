/**
 * OAuth 2.1 for remote MCP servers (SPEC G3), built on the v2 SDK's `auth()`
 * flow (protected-resource discovery, authorization-server metadata, dynamic
 * client registration or a configured client id, PKCE, `iss` validation).
 *
 * What this module adds is the part the SDK leaves to the host:
 *  - a token store per server, one JSON file per server under
 *    `<homeDir>/mcp-oauth/`, written with mode 0600 (directory 0700);
 *  - the browser login: a loopback listener on 127.0.0.1 receives the
 *    authorization code; the `state` is checked before the code is used.
 *
 * Logging in is an explicit user action (`tug mcp login <server>`). Connecting
 * at session start only uses stored tokens (refreshing them when the SDK can),
 * so starting an agent never opens a browser on its own.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/client';
import type { McpServerConfig } from '../config.js';

export interface McpOAuthConfig {
  /** Pre-registered client id (skips dynamic client registration). */
  clientId?: string;
  clientSecret?: string;
  /** Requested scopes, space separated. */
  scope?: string;
  /** Fixed loopback port for the redirect (default: any free port). Some providers require a registered port. */
  redirectPort?: number;
}

declare module '../config.js' {
  interface McpServerConfig {
    /** OAuth 2.1 for this remote server: `true` (discover + dynamic registration) or settings. */
    oauth?: boolean | McpOAuthConfig;
  }
}

interface StoreFile {
  server: string;
  url: string;
  clientInformation?: Record<string, unknown>;
  tokens?: Record<string, unknown>;
  codeVerifier?: string;
  savedAt?: string;
}

export function oauthStoreDir(homeDir: string): string {
  return path.join(homeDir, 'mcp-oauth');
}

export function oauthStoreFile(homeDir: string, server: string): string {
  return path.join(oauthStoreDir(homeDir), `${server.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(file), 0o700);
  } catch {
    /* best effort (Windows) */
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * OAuthClientProvider backed by a 0600 file. Tokens are bound to the server URL:
 * if the configured URL changes, stored tokens are not sent to the new host.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  private stateValue = crypto.randomBytes(16).toString('base64url');
  constructor(
    readonly server: string,
    readonly serverUrl: string,
    readonly homeDir: string,
    private readonly opts: McpOAuthConfig & { redirectUrl?: string; onRedirect?: (url: URL) => void | Promise<void> } = {},
  ) {}

  get file(): string {
    return oauthStoreFile(this.homeDir, this.server);
  }

  private read(): StoreFile {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoreFile;
      if (j.url !== this.serverUrl) return { server: this.server, url: this.serverUrl };
      return j;
    } catch {
      return { server: this.server, url: this.serverUrl };
    }
  }

  private update(patch: Partial<StoreFile>): void {
    const cur = this.read();
    writePrivate(this.file, { ...cur, ...patch, server: this.server, url: this.serverUrl, savedAt: new Date().toISOString() });
  }

  get redirectUrl(): string | undefined {
    return this.opts.redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'Tugline',
      redirect_uris: this.opts.redirectUrl ? [this.opts.redirectUrl] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.opts.clientSecret ? 'client_secret_post' : 'none',
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    } as any;
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): any {
    if (this.opts.clientId) return { client_id: this.opts.clientId, ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}) };
    return this.read().clientInformation;
  }

  saveClientInformation(info: any): void {
    this.update({ clientInformation: info });
  }

  tokens(): any {
    return this.read().tokens;
  }

  saveTokens(tokens: any): void {
    this.update({ tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.onRedirect) throw new Error(`MCP server "${this.server}" needs a login: run "tug mcp login ${this.server}"`);
    await this.opts.onRedirect(url);
  }

  saveCodeVerifier(v: string): void {
    this.update({ codeVerifier: v });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error('no PKCE code verifier saved');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const cur = this.read();
    if (scope === 'all' || scope === 'client') delete cur.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete cur.tokens;
    if (scope === 'all' || scope === 'verifier') delete cur.codeVerifier;
    writePrivate(this.file, cur);
  }
}

function oauthSettings(cfg: McpServerConfig): McpOAuthConfig | undefined {
  if (!cfg.oauth) return undefined;
  return cfg.oauth === true ? {} : cfg.oauth;
}

/** Provider used when connecting (stored tokens only; never opens a browser). */
export function connectAuthProvider(name: string, cfg: McpServerConfig, homeDir: string): FileOAuthProvider | undefined {
  const o = oauthSettings(cfg);
  if (!o || !cfg.url) return undefined;
  return new FileOAuthProvider(name, cfg.url, homeDir, o);
}

export interface LoginOptions {
  homeDir: string;
  /** Opens the authorization URL (default: the system browser). Tests pass a fake browser. */
  openUrl?: (url: URL) => void | Promise<void>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  log?: (s: string) => void;
}

/** Open a URL in the system browser without a shell (no injection through the URL). */
export async function openInBrowser(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`refusing to open a non-http(s) URL: ${url.protocol}`);
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url.href]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url.href]] : ['xdg-open', [url.href]];
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
}

/**
 * Browser login for one server: loopback redirect listener → `auth()` →
 * authorization page → code → token exchange. Tokens land in the 0600 store.
 */
export async function mcpLogin(name: string, cfg: McpServerConfig, opts: LoginOptions): Promise<{ tokenFile: string }> {
  if (!cfg.url) throw new Error(`MCP server "${name}" is not a remote (url) server`);
  const settings = oauthSettings(cfg) ?? {};
  let resolveCode!: (v: { code: string; iss?: string }) => void;
  let rejectCode!: (e: Error) => void;
  const codeP = new Promise<{ code: string; iss?: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  codeP.catch(() => undefined); // may reject before it is awaited (bad callback during auth())
  let provider!: FileOAuthProvider;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const err = u.searchParams.get('error');
    if (err || !code || state !== provider.state()) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Login failed. You can close this window.');
      rejectCode(new Error(err ? `authorization failed: ${err}` : state !== provider.state() ? 'state mismatch (possible CSRF); login aborted' : 'no authorization code'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Tugline: login complete. You can close this window.');
    resolveCode({ code, iss: u.searchParams.get('iss') ?? undefined });
  });
  await new Promise<void>((r, j) => {
    srv.once('error', j);
    srv.listen(settings.redirectPort ?? 0, '127.0.0.1', () => r());
  });
  const port = (srv.address() as { port: number }).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const open = opts.openUrl ?? openInBrowser;
  provider = new FileOAuthProvider(name, cfg.url, opts.homeDir, {
    ...settings,
    redirectUrl,
    onRedirect: async (url) => {
      opts.log?.(`Opening the browser to log in to MCP server "${name}":\n  ${url.href}`);
      await open(url);
    },
  });
  const timer = setTimeout(() => rejectCode(new Error('login timed out')), opts.timeoutMs ?? 300_000);
  try {
    const first = await auth(provider, { serverUrl: cfg.url, scope: settings.scope, fetchFn: opts.fetchFn });
    if (first === 'REDIRECT') {
      const { code, iss } = await codeP;
      const second = await auth(provider, { serverUrl: cfg.url, authorizationCode: code, iss, scope: settings.scope, fetchFn: opts.fetchFn });
      if (second !== 'AUTHORIZED') throw new Error(`login did not complete (${second})`);
    }
    return { tokenFile: provider.file };
  } finally {
    clearTimeout(timer);
    srv.close();
  }
}

export function mcpLogout(name: string, homeDir: string): boolean {
  const f = oauthStoreFile(homeDir, name);
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f, { force: true });
  return true;
}
