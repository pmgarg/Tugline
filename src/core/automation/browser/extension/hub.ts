/**
 * Real-browser extension hub (SPEC v1.1 N29).
 *
 * The MV3 extension in `browser-extension/` connects to `tug serve` at
 * `ws://127.0.0.1:<port>/browser-extension`. This hub:
 *
 *  1. Authenticates it: the Origin must be `chrome-extension://…` (no web page
 *     can open this socket), the Host loopback, and the first message
 *     `hello {token}` with the pairing token from
 *     `~/.tugline/browser-extension.json` (`tug browser-extension pair`).
 *  2. Relays CDP for the tabs the user shared. The browser session's driver
 *     connects Playwright (`connectOverCDP`) to a private relay endpoint
 *     (127.0.0.1, random port, 256-bit path). The relay answers the few
 *     browser-level commands itself (it is not a real browser endpoint: no
 *     new tabs, no other targets) and forwards page-level commands to the
 *     extension, which runs them with chrome.debugger on shared tabs only. So
 *     the agent gets the same browser_* tools, snapshot engine, Expect checks
 *     and masking as every other profile.
 *  3. Answers the extension's request checks with the session's own guard
 *     (allowlist + DNS-resolving SSRF guard), and surfaces refusals.
 *
 * The extension enforces its own site list, owns the Fetch domain and refuses
 * cookie and browser-wide commands; the core enforces attachedAllowDomains and
 * the SSRF guard. Either one alone refuses. The kill switch detaches every tab.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { registerUpgradeHandler } from '../../../serverHooks.js';
import { onKill } from '../../policy/index.js';

export const EXTENSION_PATH = '/browser-extension';

// ------------------------------------------------------------ pairing token

export function pairingFile(homeDir: string): string {
  return path.join(homeDir, 'browser-extension.json');
}

/** The pairing token (created on first use, file mode 0600). */
export function pairingToken(homeDir: string, opts: { create?: boolean; rotate?: boolean } = {}): string | undefined {
  const file = pairingFile(homeDir);
  if (!opts.rotate) {
    try {
      const t = JSON.parse(fs.readFileSync(file, 'utf8')).token;
      if (typeof t === 'string' && t.length >= 32) return t;
    } catch {
      /* none yet */
    }
  }
  if (!opts.create && !opts.rotate) return undefined;
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

function tokenMatches(given: unknown, expected: string | undefined): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------ types

export interface SharedTab {
  tabId: number;
  targetId?: string;
  attached?: boolean;
  url?: string;
  title?: string;
  browserContextId?: string;
}

export interface RelayPolicy {
  /** browser.attachedAllowDomains */
  coreSites: string[];
  /** web.allowHosts */
  allowHosts: string[];
  strictSubresources?: boolean;
}

export interface RelayOptions {
  policy: RelayPolicy;
  /** The session's guard: returns a reason to refuse. kind: main (top-level), frame (iframe document), sub. */
  checkUrl?: (u: URL, kind: 'main' | 'frame' | 'sub') => Promise<string | undefined>;
  onBlocked?: (msg: string) => void;
  /** All tabs were detached (kill switch, the user pressed Stop, or the extension went away). */
  onDetached?: (reason: string) => void;
}

export interface Relay {
  endpoint: string;
  close(): Promise<void>;
}

const TAB_SESSION = (tabId: number) => `oh-tab-${tabId}`;

// ------------------------------------------------------------ the hub

export class ExtensionHub extends EventEmitter {
  private ext?: { ws: WebSocket; userAgent: string; version: string };
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private relay?: RelayImpl;
  private ping?: NodeJS.Timeout;
  tabs: SharedTab[] = [];

  constructor(readonly homeDir: string) {
    super();
    this.wss.on('connection', (ws: WebSocket) => this.onExtension(ws));
  }

  get connected(): boolean {
    return !!this.ext && this.ext.ws.readyState === 1;
  }

  get userAgent(): string {
    return this.ext?.userAgent ?? '';
  }

  /** `tug serve` upgrade route. Returns true when handled (always, for our path). */
  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const origin = String(req.headers.origin ?? '');
    if (!/^(chrome-extension|extension):\/\/[a-p]{32}$/.test(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    return true;
  }

  private onExtension(ws: WebSocket): void {
    let authed = false;
    const authTimer = setTimeout(() => !authed && ws.close(4401, 'authentication timeout'), 10_000);
    ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (m?.type !== 'hello' || !tokenMatches(m.token, pairingToken(this.homeDir))) {
          ws.close(4401, 'invalid pairing token');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        // One extension at a time: a new pairing replaces the old connection.
        if (this.ext && this.ext.ws !== ws) this.ext.ws.close(4000, 'replaced by a new connection');
        this.ext = { ws, userAgent: String(m.userAgent ?? ''), version: String(m.version ?? '') };
        this.send({ type: 'welcome' });
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.send({ type: 'ping' }), 20_000); // keeps the MV3 worker alive
        this.ping.unref?.();
        this.emit('connected');
        return;
      }
      this.onExtMessage(m);
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (this.ext?.ws !== ws) return;
      this.ext = undefined;
      if (this.ping) clearInterval(this.ping);
      this.tabs = [];
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('the Tugline extension disconnected'));
      }
      this.pending.clear();
      this.relay?.extensionGone('the Tugline extension disconnected');
      this.emit('disconnected');
    });
    ws.on('error', () => undefined);
  }

  private send(m: unknown): void {
    if (this.connected) this.ext!.ws.send(JSON.stringify(m));
  }

  /** Request/response to the extension (reply or cdpResult carry the same id). */
  request(m: Record<string, unknown>, timeoutMs = 15_000): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('the Tugline extension is not connected'));
    const id = `h${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the extension did not answer ${String(m.type)}${m.method ? ` ${String(m.method)}` : ''}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...m, id });
    });
  }

  private onExtMessage(m: any): void {
    switch (m?.type) {
      case 'reply':
      case 'cdpResult': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(String(m.error)));
        else p.resolve(m.result ?? {});
        return;
      }
      case 'tabs':
        this.tabs = Array.isArray(m.tabs) ? m.tabs : [];
        this.emit('tabs', this.tabs);
        return;
      case 'cdpEvent':
        this.relay?.fromExtension(m);
        return;
      case 'tabAttached':
        this.relay?.tabAttached(m.tab);
        return;
      case 'tabDetached':
        this.relay?.tabDetached(m.tabId, m.targetId, String(m.reason ?? 'detached'));
        return;
      case 'check':
        void this.answerCheck(m);
        return;
      case 'blocked':
        this.relay?.blocked(`${String(m.url)}: ${String(m.reason)} (refused by the extension)`);
        this.emit('blocked', m);
        return;
      case 'pong':
        return;
    }
  }

  private async answerCheck(m: any): Promise<void> {
    let reason: string | undefined;
    const relay = this.relay;
    if (!relay) reason = 'no agent session is attached';
    else {
      try {
        const kind = m.kind === 'main' || m.kind === 'frame' ? m.kind : 'sub';
        reason = await relay.check(new URL(String(m.url)), kind);
      } catch (e) {
        reason = (e as Error).message;
      }
    }
    this.send({ type: 'verdict', id: m.id, reason });
  }

  /** Open the CDP relay for one browser session. Only one session drives the extension at a time. */
  async openRelay(o: RelayOptions): Promise<Relay> {
    if (!this.connected) throw new Error('the Tugline browser extension is not connected: install it from browser-extension/, pair it (tug browser-extension pair) and keep tug serve running');
    if (this.relay) throw new Error('another session is already driving the shared tabs; close it first (/browser stop stops all)');
    const r = new RelayImpl(this, o);
    this.relay = r;
    try {
      await r.listen();
    } catch (e) {
      this.relay = undefined;
      throw e;
    }
    return { endpoint: r.endpoint, close: () => r.close() };
  }

  /** @internal */
  relayClosed(r: RelayImpl): void {
    if (this.relay === r) this.relay = undefined;
  }

  /** Kill switch: detach every shared tab and stop sharing (the user must share again). */
  async killAll(reason = 'kill switch'): Promise<void> {
    const r = this.relay;
    if (this.connected) await this.request({ type: 'detachAll', unshare: true }, 2000).catch(() => undefined);
    r?.extensionGone(reason);
    await r?.close();
  }
}

// ------------------------------------------------------------ the CDP relay (Playwright side)

class RelayImpl {
  endpoint = '';
  private server = http.createServer((_req, res) => res.writeHead(404).end());
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  private client?: WebSocket;
  private nonce = crypto.randomBytes(32).toString('base64url');
  private autoAttach = false;
  /** sessionId → tabId (tab sessions and their child sessions). */
  private sessions = new Map<string, { tabId: number; child?: string }>();
  private attached = new Map<number, SharedTab>();
  private closed = false;

  constructor(readonly hub: ExtensionHub, readonly o: RelayOptions) {}

  async listen(): Promise<void> {
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== `/cdp/${this.nonce}` || this.client) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.client = ws;
        ws.on('message', (d) => void this.fromPlaywright(String(d)));
        ws.on('close', () => void this.close());
        ws.on('error', () => undefined);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.endpoint = `ws://127.0.0.1:${(this.server.address() as { port: number }).port}/cdp/${this.nonce}`;
  }

  check(u: URL, kind: 'main' | 'frame' | 'sub'): Promise<string | undefined> {
    return this.o.checkUrl ? this.o.checkUrl(u, kind) : Promise.resolve(undefined);
  }

  blocked(msg: string): void {
    this.o.onBlocked?.(msg);
  }

  private toPlaywright(m: unknown): void {
    if (this.client?.readyState === 1) this.client.send(JSON.stringify(m));
  }

  private targetInfo(t: SharedTab) {
    return { targetId: t.targetId, type: 'page', title: t.title ?? '', url: t.url ?? '', attached: true, canAccessOpener: false, browserContextId: t.browserContextId ?? 'oh-default' };
  }

  private announce(t: SharedTab): void {
    if (!t.targetId || this.attached.has(t.tabId)) return;
    this.attached.set(t.tabId, t);
    this.sessions.set(TAB_SESSION(t.tabId), { tabId: t.tabId });
    this.toPlaywright({ method: 'Target.attachedToTarget', params: { sessionId: TAB_SESSION(t.tabId), targetInfo: this.targetInfo(t), waitingForDebugger: false } });
  }

  tabAttached(t: SharedTab): void {
    if (this.autoAttach && t) this.announce(t);
  }

  tabDetached(tabId: number, targetId: string | undefined, _reason: string): void {
    const t = this.attached.get(tabId);
    if (!t) return;
    this.attached.delete(tabId);
    for (const [sid, s] of [...this.sessions]) if (s.tabId === tabId) this.sessions.delete(sid);
    this.toPlaywright({ method: 'Target.detachedFromTarget', params: { sessionId: TAB_SESSION(tabId), targetId: targetId ?? t.targetId } });
    if (!this.attached.size) this.o.onDetached?.('every shared tab was detached');
  }

  extensionGone(reason: string): void {
    for (const tabId of [...this.attached.keys()]) this.tabDetached(tabId, undefined, reason);
    this.o.onDetached?.(reason);
  }

  fromExtension(m: { tabId: number; sessionId?: string; method: string; params: any }): void {
    if (!this.attached.has(m.tabId)) return;
    if (m.method === 'Target.attachedToTarget' && m.params?.sessionId) this.sessions.set(m.params.sessionId, { tabId: m.tabId, child: m.params.sessionId });
    if (m.method === 'Target.detachedFromTarget' && m.params?.sessionId) this.sessions.delete(m.params.sessionId);
    this.toPlaywright({ method: m.method, params: m.params, sessionId: m.sessionId ?? TAB_SESSION(m.tabId) });
  }

  private async fromPlaywright(raw: string): Promise<void> {
    let m: { id: number; method: string; params?: any; sessionId?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (x: { result?: unknown; error?: string }) =>
      this.toPlaywright(x.error !== undefined ? { id: m.id, sessionId: m.sessionId, error: { code: -32000, message: x.error } } : { id: m.id, sessionId: m.sessionId, result: x.result ?? {} });
    try {
      if (!m.sessionId) return reply({ result: await this.browserCommand(m.method, m.params ?? {}) });
      const s = this.sessions.get(m.sessionId);
      if (!s) return reply({ error: `unknown session ${m.sessionId}` });
      const result = await this.hub.request({ type: 'cdp', tabId: s.tabId, sessionId: s.child, method: m.method, params: m.params ?? {} }, 60_000);
      reply({ result });
    } catch (e) {
      reply({ error: (e as Error).message });
    }
  }

  /** The browser-level surface Playwright needs from a connectOverCDP endpoint. */
  private async browserCommand(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion': {
        const ua = this.hub.userAgent;
        const product = ua.match(/(HeadlessChrome|Chrome|Edg)\/[\d.]+/)?.[0]?.replace(/^Edg\//, 'Chrome/') ?? 'Chrome/125.0.0.0';
        return { protocolVersion: '1.3', product, revision: '', userAgent: ua, jsVersion: '' };
      }
      case 'Target.setAutoAttach': {
        this.autoAttach = !!params.autoAttach;
        if (this.autoAttach) {
          const r = await this.hub.request({ type: 'attach', policy: this.o.policy }, 20_000);
          for (const t of (r.tabs ?? []) as SharedTab[]) this.announce(t);
        }
        return {};
      }
      case 'Target.getTargetInfo':
        if (params.targetId) {
          const t = [...this.attached.values()].find((x) => x.targetId === params.targetId);
          if (!t) throw new Error('no such target');
          return { targetInfo: this.targetInfo(t) };
        }
        return { targetInfo: { targetId: 'oh-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
      case 'Target.getTargets':
        return { targetInfos: [...this.attached.values()].map((t) => this.targetInfo(t)) };
      case 'Target.getBrowserContexts':
        return { browserContextIds: [] };
      case 'Target.setDiscoverTargets':
      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Browser.close':
      case 'Target.detachFromTarget':
        return {};
      case 'Target.createTarget':
        throw new Error('the extension only drives tabs you share (use "Share this tab with Tugline" in that tab)');
      case 'Target.closeTarget':
        return { success: false };
      default:
        throw new Error(`${method} is not available through the Tugline extension`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.hub.relayClosed(this);
    // The agent is gone: release the tabs (they stay shared; the user can stop sharing in the extension).
    if (this.attached.size && this.hub.connected) await this.hub.request({ type: 'detachAll', unshare: false }, 2000).catch(() => undefined);
    this.attached.clear();
    try {
      this.client?.close();
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

// ------------------------------------------------------------ process-wide hub, mounted on `tug serve`

let hub: ExtensionHub | undefined;

export function extensionHub(homeDir?: string): ExtensionHub | undefined {
  if (!hub && homeDir) hub = new ExtensionHub(homeDir);
  return hub;
}

registerUpgradeHandler(EXTENSION_PATH, (req, socket, head, ctx) => {
  const h = extensionHub(ctx.config.homeDir)!;
  return h.handleUpgrade(req, socket, head);
});

onKill(() => void hub?.killAll());
