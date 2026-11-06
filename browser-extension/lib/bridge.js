/**
 * Tugline browser extension: the bridge between shared tabs and `tug serve`
 * (SPEC v1.1 N29).
 *
 * - Pairing: the options page stores the server URL (ws://127.0.0.1:PORT/browser-extension)
 *   and the pairing token (`tug browser-extension pair`). The first message is
 *   `hello {token}`; the server refuses anything else.
 * - Sharing: only a tab the user shares with the toolbar action ("Share this tab
 *   with Tugline") is ever driven. Nothing in the protocol lets the server
 *   share, open or pick a tab; a popup a shared tab opens is not shared.
 * - Control: chrome.debugger is attached to shared tabs only while an agent is
 *   connected (`attach`), so Chrome's "is debugging this browser" bar and the
 *   red ON badge mean exactly "an agent can act here now".
 * - Guard: the extension owns the Fetch domain on every attached target
 *   (including cross-site iframes and workers, enabled before they resume).
 *   Each request passes policy.checkRequest() and then the core's verdict
 *   (DNS-based SSRF guard); a refusal is Fetch.failRequest(BlockedByClient).
 * - Kill switch: `detachAll {unshare:true}` from the core, the options page's
 *   "Stop" button, or the user cancelling Chrome's debugging bar detach every
 *   tab and stop sharing at once.
 *
 * chrome and WebSocket are injected so this file is unit-tested in node.
 */
import { checkCommand, checkRequest, requestKind, validPairingUrl } from './policy.js';

export const VERSION = '1.1.0';
const PROTOCOL = '1.3';

export class Bridge {
  constructor({ chrome, WebSocket, log, setTimeout: st, clearTimeout: ct }) {
    this.chrome = chrome;
    this.WS = WebSocket;
    this.log = log || (() => undefined);
    this.setTimeout = st || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = ct || ((t) => clearTimeout(t));
    /** tabId → { targetId?, attached, children: Map<sessionId, type>, url, title } */
    this.shared = new Map();
    this.ws = undefined;
    this.status = 'not paired';
    this.agent = false;
    this.corePolicy = { coreSites: [], allowHosts: [], strictSubresources: false };
    this.settings = { url: '', token: '', sites: [], strict: false };
    this.pending = new Map();
    this.verdicts = new Map();
    this.seq = 0;
    this.retry = undefined;
    this.blocked = [];
  }

  // ------------------------------------------------------------ settings and connection

  async load() {
    const s = await this.chrome.storage.local.get(['url', 'token', 'sites', 'strict']);
    this.settings = { url: s.url || '', token: s.token || '', sites: Array.isArray(s.sites) ? s.sites : [], strict: !!s.strict };
    return this.settings;
  }

  async save(next) {
    const url = validPairingUrl(next.url);
    if (!url) throw new Error('the server URL must be ws://127.0.0.1:PORT (tug serve on this machine)');
    const sites = String(Array.isArray(next.sites) ? next.sites.join('\n') : next.sites || '')
      .split(/[\s,]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    this.settings = { url, token: String(next.token || '').trim() || this.settings.token, sites, strict: !!next.strict };
    await this.chrome.storage.local.set(this.settings);
    this.connect();
    return this.settings;
  }

  policy() {
    return { userSites: this.settings.sites, coreSites: this.corePolicy.coreSites, allowHosts: this.corePolicy.allowHosts, strictSubresources: this.settings.strict || !!this.corePolicy.strictSubresources };
  }

  connect() {
    if (this.retry) this.clearTimeout(this.retry);
    this.retry = undefined;
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = undefined;
    }
    if (!this.settings.url || !this.settings.token) {
      this.status = 'not paired';
      return;
    }
    let ws;
    try {
      ws = new this.WS(this.settings.url);
    } catch (e) {
      this.status = `cannot connect: ${e.message}`;
      return this.reconnectLater();
    }
    this.ws = ws;
    this.status = 'connecting';
    ws.onopen = () => this.send({ type: 'hello', token: this.settings.token, version: VERSION, userAgent: globalThis.navigator ? navigator.userAgent : 'node' });
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      void this.onHub(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.status = ev && ev.code === 4401 ? 'pairing token refused' : 'disconnected';
      void this.detachAll(false);
      if (!(ev && ev.code === 4401)) this.reconnectLater();
    };
    ws.onerror = () => undefined;
  }

  reconnectLater() {
    if (this.retry) return;
    this.retry = this.setTimeout(() => {
      this.retry = undefined;
      this.connect();
    }, 3000);
  }

  send(m) {
    try {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
    } catch {
      /* the close handler cleans up */
    }
  }

  tabList() {
    return [...this.shared.entries()].map(([tabId, t]) => ({ tabId, targetId: t.targetId, attached: t.attached, url: t.url, title: t.title, browserContextId: t.browserContextId }));
  }

  // ------------------------------------------------------------ messages from the core

  async onHub(m) {
    switch (m.type) {
      case 'welcome':
        this.status = 'connected';
        this.send({ type: 'tabs', tabs: this.tabList() });
        return;
      case 'ping':
        return this.send({ type: 'pong' });
      case 'attach': {
        // An agent session connected: take control of the shared tabs (and only those).
        const p = m.policy || {};
        this.corePolicy = { coreSites: p.coreSites || [], allowHosts: p.allowHosts || [], strictSubresources: !!p.strictSubresources };
        this.verdicts.clear();
        this.agent = true;
        for (const tabId of [...this.shared.keys()]) await this.attachTab(tabId).catch((e) => this.log(`attach ${tabId}: ${e.message}`));
        return this.send({ type: 'reply', id: m.id, result: { tabs: this.tabList().filter((t) => t.attached) } });
      }
      case 'detachAll':
        await this.detachAll(!!m.unshare);
        return this.send({ type: 'reply', id: m.id, result: { tabs: this.tabList() } });
      case 'cdp':
        return this.forward(m);
      case 'verdict': {
        const w = this.pending.get(m.id);
        if (w) {
          this.pending.delete(m.id);
          w(m.reason);
        }
        return;
      }
      default:
        return this.send({ type: 'reply', id: m.id, error: `unknown message ${String(m.type)}` });
    }
  }

  async forward(m) {
    const t = this.shared.get(m.tabId);
    const reply = (x) => this.send({ type: 'cdpResult', id: m.id, ...x });
    if (!t || !t.attached) return reply({ error: 'that tab is not shared with Tugline' });
    if (m.sessionId && !t.children.has(m.sessionId)) return reply({ error: 'unknown session' });
    const why = checkCommand(m.method, m.params, this.policy());
    if (why) {
      if (m.method === 'Page.navigate') this.noteBlocked(m.tabId, m.params && m.params.url, why);
      return reply({ error: why });
    }
    try {
      const target = m.sessionId ? { tabId: m.tabId, sessionId: m.sessionId } : { tabId: m.tabId };
      const result = await this.chrome.debugger.sendCommand(target, m.method, m.params || {});
      reply({ result: result || {} });
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
    }
  }

  // ------------------------------------------------------------ sharing (user actions only)

  /** The toolbar action. The only way a tab becomes shared. */
  async toggleShare(tab) {
    if (!tab || typeof tab.id !== 'number') return;
    if (this.shared.has(tab.id)) return this.unshare(tab.id, 'stopped sharing');
    if (!/^https?:/.test(tab.url || '')) {
      await this.badge(tab.id, '!', 'Tugline can only be shared on http(s) pages');
      return;
    }
    this.shared.set(tab.id, { attached: false, children: new Map(), url: tab.url, title: tab.title });
    await this.badge(tab.id, 'S', 'Shared with Tugline (no agent connected). Click to stop sharing.');
    if (this.agent) {
      await this.attachTab(tab.id).catch((e) => this.log(`attach ${tab.id}: ${e.message}`));
      const t = this.shared.get(tab.id);
      if (t && t.attached) this.send({ type: 'tabAttached', tab: this.tabList().find((x) => x.tabId === tab.id) });
    }
    this.send({ type: 'tabs', tabs: this.tabList() });
  }

  async unshare(tabId, reason) {
    const t = this.shared.get(tabId);
    if (!t) return;
    this.shared.delete(tabId);
    if (t.attached) {
      t.attached = false;
      await this.chrome.debugger.detach({ tabId }).catch(() => undefined);
      this.send({ type: 'tabDetached', tabId, targetId: t.targetId, reason });
    }
    await this.badge(tabId, '', 'Share this tab with Tugline');
    this.send({ type: 'tabs', tabs: this.tabList() });
  }

  async attachTab(tabId) {
    const t = this.shared.get(tabId);
    if (!t || t.attached) return;
    await this.chrome.debugger.attach({ tabId }, PROTOCOL);
    t.attached = true;
    try {
      // The request guard is in place before the core sees the tab.
      await this.chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      const info = await this.chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo', {});
      t.targetId = info.targetInfo.targetId;
      t.browserContextId = info.targetInfo.browserContextId;
      t.url = info.targetInfo.url;
      t.title = info.targetInfo.title;
    } catch (e) {
      t.attached = false;
      await this.chrome.debugger.detach({ tabId }).catch(() => undefined);
      throw e;
    }
    await this.badge(tabId, 'ON', 'Tugline is controlling this tab. Click to stop sharing.');
  }

  /** Kill switch / agent gone. unshare: also forget the shares (the user must share again). */
  async detachAll(unshare) {
    this.agent = false;
    const ids = [...this.shared.keys()];
    await Promise.all(
      ids.map(async (tabId) => {
        const t = this.shared.get(tabId);
        if (t && t.attached) {
          t.attached = false;
          t.children.clear();
          await this.chrome.debugger.detach({ tabId }).catch(() => undefined);
        }
        if (unshare) {
          this.shared.delete(tabId);
          await this.badge(tabId, '', 'Share this tab with Tugline');
        } else await this.badge(tabId, 'S', 'Shared with Tugline (no agent connected). Click to stop sharing.');
      }),
    );
  }

  /** The options page's Stop button. */
  async stopAll() {
    const had = this.tabList().filter((t) => t.attached);
    await this.detachAll(true);
    for (const t of had) this.send({ type: 'tabDetached', tabId: t.tabId, targetId: t.targetId, reason: 'stopped by the user' });
    this.send({ type: 'tabs', tabs: [] });
  }

  async badge(tabId, text, title) {
    try {
      await this.chrome.action.setBadgeText({ tabId, text });
      if (text) await this.chrome.action.setBadgeBackgroundColor({ tabId, color: text === 'ON' ? '#c62828' : '#555555' });
      await this.chrome.action.setTitle({ tabId, title });
    } catch {
      /* the tab may be gone */
    }
  }

  // ------------------------------------------------------------ chrome.debugger events

  async onDebuggerEvent(source, method, params) {
    const t = this.shared.get(source.tabId);
    if (!t || !t.attached) return;
    if (method === 'Fetch.requestPaused') return this.onRequestPaused(source, params);
    if (method === 'Target.attachedToTarget') {
      // A cross-site iframe or a worker of the shared tab: guard it before it runs.
      t.children.set(params.sessionId, params.targetInfo && params.targetInfo.type);
      await this.chrome.debugger.sendCommand({ tabId: source.tabId, sessionId: params.sessionId }, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }).catch(() => undefined);
    } else if (method === 'Target.detachedFromTarget') t.children.delete(params.sessionId);
    else if (!source.sessionId && method === 'Target.targetInfoChanged' && params.targetInfo && params.targetInfo.targetId === t.targetId) {
      t.url = params.targetInfo.url;
      t.title = params.targetInfo.title;
    }
    this.send({ type: 'cdpEvent', tabId: source.tabId, sessionId: source.sessionId, method, params });
  }

  async onRequestPaused(source, ev) {
    const t = this.shared.get(source.tabId);
    const target = source.sessionId ? { tabId: source.tabId, sessionId: source.sessionId } : { tabId: source.tabId };
    const kind = requestKind(ev, t && t.targetId, !!source.sessionId);
    let why = checkRequest(ev.request.url, kind, this.policy());
    if (!why) why = await this.coreVerdict(ev.request.url, kind);
    if (why) {
      this.noteBlocked(source.tabId, ev.request.url, why);
      return this.chrome.debugger.sendCommand(target, 'Fetch.failRequest', { requestId: ev.requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    }
    return this.chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId: ev.requestId }).catch(() => undefined);
  }

  /** The core resolves hostnames (SSRF guard) and applies its own allowlist; cached per host and kind. Fails closed. */
  coreVerdict(url, kind) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return Promise.resolve('invalid URL');
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return Promise.resolve(undefined);
    const k = `${u.hostname}|${kind}`;
    let v = this.verdicts.get(k);
    if (!v) {
      v = new Promise((resolve) => {
        if (!this.ws || this.ws.readyState !== 1) return resolve('Tugline is not connected');
        const id = `v${++this.seq}`;
        const timer = this.setTimeout(() => {
          this.pending.delete(id);
          resolve('Tugline did not answer the request check');
        }, 5000);
        this.pending.set(id, (reason) => {
          this.clearTimeout(timer);
          resolve(reason || undefined);
        });
        this.send({ type: 'check', id, url: `${u.origin}${u.pathname}`, kind });
      });
      this.verdicts.set(k, v);
      void v.then((r) => {
        if (r && /did not answer|not connected/.test(r)) this.verdicts.delete(k);
      });
    }
    return v;
  }

  noteBlocked(tabId, url, reason) {
    let shown = String(url || '');
    try {
      const u = new URL(shown);
      shown = `${u.origin}${u.pathname}`;
    } catch {
      /* keep as is */
    }
    this.blocked.push({ tabId, url: shown, reason, at: Date.now() });
    if (this.blocked.length > 50) this.blocked.shift();
    this.send({ type: 'blocked', tabId, url: shown, reason });
  }

  /** Chrome detached us: the user cancelled the debugging bar, closed the tab, or devtools took over. */
  async onDebuggerDetach(source, reason) {
    const t = this.shared.get(source.tabId);
    if (!t || !t.attached) return;
    t.attached = false;
    this.send({ type: 'tabDetached', tabId: source.tabId, targetId: t.targetId, reason: String(reason || 'detached') });
    if (reason === 'canceled_by_user' || reason === 'target_closed') await this.unshare(source.tabId, String(reason));
  }

  async onTabRemoved(tabId) {
    if (this.shared.has(tabId)) await this.unshare(tabId, 'tab closed');
  }

  snapshot() {
    return { status: this.status, agent: this.agent, url: this.settings.url, paired: !!this.settings.token, sites: this.settings.sites, strict: this.settings.strict, tabs: this.tabList(), blocked: this.blocked.slice(-10) };
  }
}
