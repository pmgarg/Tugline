/**
 * N29 (v1.1): the real-browser extension (browser-extension/) and its hub on
 * `tug serve`. Unit tests drive the extension's own logic (lib/policy.js,
 * lib/bridge.js) with a fake chrome.*; the integration tests load the unpacked
 * extension in Chromium (--load-extension, new headless), pair it through its
 * options page, share a tab the way a user does, and run the agent loop
 * against the test site through the relay. Every browser is closed.
 */
import { childProcesses, isZombie } from '../src/core/util/procs.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { startSiteServer } from '../evals/browser/serve.mjs';
import { Agent } from '../src/core/agent/agent.js';
import type { AgentEvent } from '../src/core/types.js';
import { startServer, type RunningServer } from '../src/server/server.js';
import { extensionHub, pairingToken } from '../src/core/automation/browser/extension/hub.js';
import { fullChromium } from '../src/core/automation/browser/launch.js';
import { BrowserSession, closeAllBrowserSessions } from '../src/core/automation/browser/session.js';
import { killAutomation, resetKillSwitch } from '../src/core/automation/policy/index.js';
import { SecretVault } from '../src/core/secrets/vault.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult, type Script } from './helpers.js';

const EXT_DIR = path.resolve('browser-extension');
const lib = async (f: string): Promise<any> => import(path.join(EXT_DIR, 'lib', f));

// ------------------------------------------------------------ unit: lib/policy.js

test('N29 (unit): extension policy — both site lists for pages, SSRF literals, owned Fetch domain, no cookies, loopback pairing URL', async () => {
  const P = await lib('policy.js');
  const pol = { userSites: ['*.example.com'], coreSites: ['shop.example.com', 'docs.example.com'], allowHosts: ['intranet.corp'], strictSubresources: false };
  assert.equal(P.checkRequest('https://shop.example.com/cart', 'main', pol), undefined);
  assert.match(P.checkRequest('https://other.example.com/', 'main', pol), /not in browser\.attachedAllowDomains/);
  assert.match(P.checkRequest('https://shop.example.org/', 'main', pol), /not in the extension's allowed sites/);
  // Subresources: any public host, never private/metadata literals or internal names (unless web.allowHosts).
  assert.equal(P.checkRequest('https://cdn.jsdelivr.net/x.js', 'sub', pol), undefined);
  for (const u of ['http://169.254.169.254/latest/', 'http://10.1.2.3/', 'http://[::1]:8080/', 'http://[::ffff:7f00:1]/', 'http://localhost:3000/', 'http://printer.local/', 'http://metadata.google.internal/'])
    assert.match(P.checkRequest(u, 'sub', pol) ?? '', /private, loopback or metadata/, u);
  assert.equal(P.checkRequest('http://intranet.corp/', 'sub', { ...pol, allowHosts: ['intranet.corp'] }), undefined);
  assert.match(P.checkRequest('https://cdn.jsdelivr.net/x.js', 'sub', { ...pol, strictSubresources: true }) ?? '', /strict subresources/);
  assert.match(P.checkRequest('file:///etc/passwd', 'main', pol) ?? '', /file: pages cannot be opened/);
  // Commands the core may not send.
  for (const m of ['Fetch.disable', 'Fetch.continueRequest', 'Network.getAllCookies', 'Storage.getCookies', 'Target.createTarget', 'Target.attachToTarget', 'Browser.close', 'DOM.setFileInputFiles', 'DOM.getFileInfo', 'Page.setInterceptFileChooserDialog', 'Network.loadNetworkResource', 'IO.read', 'FileSystem.getDirectory'])
    assert.match(P.checkCommand(m, {}, pol) ?? '', /not available through the Tugline extension/, m);
  assert.equal(P.checkCommand('Runtime.evaluate', {}, pol), undefined);
  assert.match(P.checkCommand('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], files: ['/etc/passwd'], dragOperationsMask: 1 } }, pol) ?? '', /with files is not available/);
  assert.equal(P.checkCommand('Input.dispatchDragEvent', { type: 'dragEnter', x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } }, pol), undefined);
  assert.match(P.checkCommand('Page.navigate', { url: 'https://evil.test/' }, pol) ?? '', /not in the extension's allowed sites/);
  assert.equal(P.checkCommand('Page.navigate', { url: 'https://docs.example.com/' }, pol), undefined);
  assert.equal(P.validPairingUrl('ws://127.0.0.1:7878'), 'ws://127.0.0.1:7878/browser-extension');
  assert.equal(P.validPairingUrl('ws://evil.test:7878/browser-extension'), undefined);
  assert.equal(P.validPairingUrl('https://127.0.0.1:7878/'), undefined);
});

// ------------------------------------------------------------ unit: lib/bridge.js with a fake chrome

function fakeChrome() {
  const calls: any[] = [];
  const storage: Record<string, unknown> = {};
  const chrome = {
    storage: { local: { get: async () => ({ ...storage }), set: async (o: any) => void Object.assign(storage, o) } },
    debugger: {
      attach: async (t: any) => void calls.push(['attach', t.tabId]),
      detach: async (t: any) => void calls.push(['detach', t.tabId]),
      sendCommand: async (t: any, m: string, p: any) => {
        calls.push(['cmd', t.tabId, t.sessionId ?? null, m, p]);
        if (m === 'Target.getTargetInfo') return { targetInfo: { targetId: `T${t.tabId}`, url: 'https://shop.example.com/', title: 'Shop', browserContextId: 'C1' } };
        return { ok: true };
      },
    },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined, setTitle: async () => undefined },
  };
  return { chrome, calls, storage };
}

class FakeWS {
  static last: FakeWS;
  sent: any[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (e: any) => void;
  onclose?: (e: any) => void;
  constructor(readonly url: string) {
    FakeWS.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

test('N29 (unit): the bridge shares a tab only on the user\'s action, guards it before the core sees it, and the kill switch unshares', async () => {
  const { Bridge } = await lib('bridge.js');
  const { chrome, calls } = fakeChrome();
  const b = new Bridge({ chrome, WebSocket: FakeWS });
  await b.save({ url: 'ws://127.0.0.1:7878', token: 'tok', sites: 'shop.example.com\n*.cdn.example', strict: false });
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeWS.last;
  assert.equal(ws.url, 'ws://127.0.0.1:7878/browser-extension');
  assert.deepEqual(ws.sent[0].type, 'hello');
  assert.equal(ws.sent[0].token, 'tok');
  await b.onHub({ type: 'welcome' });

  // An agent attaching with nothing shared gets nothing; the protocol has no way to share, open or pick a tab.
  await b.onHub({ type: 'attach', id: 'a1', policy: { coreSites: ['shop.example.com'], allowHosts: [] } });
  assert.deepEqual(ws.of('reply').at(-1), { type: 'reply', id: 'a1', result: { tabs: [] } });
  assert.equal(calls.filter((c) => c[0] === 'attach').length, 0);
  await b.onHub({ type: 'share', id: 's1', tabId: 7 });
  assert.match(ws.of('reply').at(-1).error, /unknown message share/);
  await b.onHub({ type: 'cdp', id: 'c0', tabId: 7, method: 'Runtime.evaluate', params: {} });
  assert.match(ws.of('cdpResult').at(-1).error, /not shared/);

  // The user clicks the toolbar button on tab 7: it is attached and guarded (Fetch) before it is announced.
  await b.toggleShare({ id: 7, url: 'https://shop.example.com/', title: 'Shop' });
  const order = calls.map((c) => (c[0] === 'cmd' ? c[3] : c[0]));
  assert.deepEqual(order.slice(0, 3), ['attach', 'Fetch.enable', 'Target.getTargetInfo']);
  assert.equal(ws.of('tabAttached').at(-1).tab.targetId, 'T7');
  // Not http(s): refused.
  await b.toggleShare({ id: 8, url: 'chrome://settings' });
  assert.equal(b.shared.has(8), false);

  // Forwarded commands: allowed ones run, the extension's own domains and cookies are refused.
  await b.onHub({ type: 'cdp', id: 'c1', tabId: 7, method: 'Runtime.evaluate', params: { expression: '1' } });
  assert.deepEqual(ws.of('cdpResult').at(-1), { type: 'cdpResult', id: 'c1', result: { ok: true } });
  for (const [id, m] of [['c2', 'Fetch.disable'], ['c3', 'Network.getAllCookies'], ['c4', 'Target.createTarget']]) {
    await b.onHub({ type: 'cdp', id, tabId: 7, method: m, params: {} });
    assert.match(ws.of('cdpResult').at(-1).error, /not available/);
  }
  await b.onHub({ type: 'cdp', id: 'c5', tabId: 7, method: 'Page.navigate', params: { url: 'https://evil.test/' } });
  assert.match(ws.of('cdpResult').at(-1).error, /not in the extension's allowed sites/);
  assert.equal(ws.of('blocked').at(-1).url, 'https://evil.test/');

  // Requests: refused locally without asking the core; otherwise the core's verdict decides.
  const paused = (id: string, url: string, resourceType = 'Document', frameId = 'T7', sessionId?: string) => b.onRequestPaused({ tabId: 7, sessionId }, { requestId: id, request: { url }, resourceType, frameId });
  await paused('r1', 'https://evil.test/');
  assert.deepEqual(calls.at(-1).slice(3), ['Fetch.failRequest', { requestId: 'r1', errorReason: 'BlockedByClient' }]);
  assert.equal(ws.of('check').length, 0, 'a local refusal never reaches the core');
  await paused('r2', 'http://169.254.169.254/latest/meta-data/', 'Image');
  assert.equal(calls.at(-1)[3], 'Fetch.failRequest');
  const p3 = paused('r3', 'https://shop.example.com/cart');
  await new Promise((r) => setTimeout(r, 0));
  const chk = ws.of('check').at(-1);
  assert.deepEqual([chk.url, chk.kind], ['https://shop.example.com/cart', 'main']);
  await b.onHub({ type: 'verdict', id: chk.id });
  await p3;
  assert.deepEqual(calls.at(-1).slice(3), ['Fetch.continueRequest', { requestId: 'r3' }]);
  const p4 = paused('r4', 'https://tracker.test/pixel.gif', 'Image');
  await new Promise((r) => setTimeout(r, 0));
  await b.onHub({ type: 'verdict', id: ws.of('check').at(-1).id, reason: 'tracker.test resolves to a private address (SSRF guard)' });
  await p4;
  assert.equal(calls.at(-1)[3], 'Fetch.failRequest', "the core's refusal is applied");

  // A cross-site iframe target is guarded (Fetch) before its attach event reaches the core.
  await b.onDebuggerEvent({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'child1', targetInfo: { type: 'iframe' }, waitingForDebugger: true });
  assert.deepEqual(calls.at(-1).slice(1, 4), [7, 'child1', 'Fetch.enable']);
  assert.equal(ws.of('cdpEvent').at(-1).method, 'Target.attachedToTarget');
  // Fetch events are the extension's own and are never forwarded.
  const before = ws.of('cdpEvent').length;
  const p5 = b.onDebuggerEvent({ tabId: 7 }, 'Fetch.requestPaused', { requestId: 'r5', request: { url: 'https://evil.test/' }, resourceType: 'Document', frameId: 'T7' });
  await p5;
  assert.equal(ws.of('cdpEvent').length, before);

  // Kill switch from the core: detach and unshare.
  await b.onHub({ type: 'detachAll', id: 'k1', unshare: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'detach').map((c) => c[1]), [7]);
  assert.equal(b.shared.size, 0);
  assert.equal(b.agent, false);

  // The user cancels Chrome's debugging bar: unshared, and the core is told.
  await b.toggleShare({ id: 9, url: 'https://shop.example.com/', title: 'Shop' });
  await b.onHub({ type: 'attach', id: 'a2', policy: { coreSites: ['shop.example.com'], allowHosts: [] } });
  await b.onDebuggerDetach({ tabId: 9 }, 'canceled_by_user');
  assert.equal(b.shared.has(9), false);
  assert.equal(ws.of('tabDetached').at(-1).tabId, 9);
});

// ------------------------------------------------------------ hub: pairing

const fixture: { site?: { url: string; close: () => Promise<void> }; home?: string; srv?: RunningServer; ctx?: any; sw?: any; extId?: string; userDir?: string } = {};

before(async () => {
  fixture.site = await startSiteServer();
  const cfg = testConfig('http://127.0.0.1:9/v1');
  fixture.home = cfg.homeDir;
  pairingToken(cfg.homeDir, { create: true });
  fixture.srv = await startServer({ workspace: tmpWorkspace(), config: cfg, port: 0 });
});

after(async () => {
  await closeAllBrowserSessions();
  await fixture.ctx?.close().catch(() => undefined);
  await fixture.srv?.close();
  await fixture.site?.close();
  if (fixture.userDir) fs.rmSync(fixture.userDir, { recursive: true, force: true });
});

function wsResult(url: string, headers: Record<string, string>, first?: unknown): Promise<{ status?: number; closeCode?: number; messages: any[] }> {
  return new Promise((resolve) => {
    const messages: any[] = [];
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, messages }));
    ws.on('open', () => first && ws.send(JSON.stringify(first)));
    ws.on('message', (d) => {
      messages.push(JSON.parse(String(d)));
      if (messages[0]?.type === 'welcome') ws.close(1000);
    });
    ws.on('close', (code) => resolve({ closeCode: code, messages }));
    ws.on('error', () => undefined);
  });
}

test('N29: the hub on tug serve accepts only the paired extension (extension Origin, loopback Host, pairing token)', async () => {
  const url = `${fixture.srv!.url}/browser-extension`;
  const extOrigin = { Origin: `chrome-extension://${'a'.repeat(32)}` };
  assert.equal((await wsResult(url, { Origin: 'https://evil.test' })).status, 403, 'a web page cannot open the socket');
  assert.equal((await wsResult(url, {})).status, 403, 'no Origin: not an extension');
  const bad = await wsResult(url, extOrigin, { type: 'hello', token: 'guess' });
  assert.equal(bad.closeCode, 4401);
  const servToken = await wsResult(url, extOrigin, { type: 'hello', token: fixture.srv!.token });
  assert.equal(servToken.closeCode, 4401, 'the tug serve token is not the pairing token');
  const ok = await wsResult(url, extOrigin, { type: 'hello', token: pairingToken(fixture.home!) });
  assert.equal(ok.messages[0]?.type, 'welcome');
  // The pairing file is private.
  assert.equal(fs.statSync(path.join(fixture.home!, 'browser-extension.json')).mode & 0o777, 0o600);
});

// ------------------------------------------------------------ integration: the real extension in Chromium

async function launchUserBrowser(): Promise<void> {
  if (fixture.ctx) return;
  const { chromium } = await import('playwright');
  fixture.userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ext-user-'));
  fixture.ctx = await chromium.launchPersistentContext(fixture.userDir, {
    executablePath: fullChromium(),
    headless: true,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  fixture.sw = fixture.ctx.serviceWorkers()[0] ?? (await fixture.ctx.waitForEvent('serviceworker', { timeout: 15_000 }));
  fixture.extId = new URL(fixture.sw.url()).host;
  // Pair through the options page, as a user does.
  const opts = await fixture.ctx.newPage();
  await opts.goto(`chrome-extension://${fixture.extId}/options.html`);
  await opts.fill('#url', `${fixture.srv!.url}/browser-extension`);
  await opts.fill('#token', pairingToken(fixture.home!)!);
  await opts.fill('#sites', 'localhost');
  await opts.click('#save');
  const hub = extensionHub(fixture.home!)!;
  // up to 30 s: the extension retries every 3 s, and a loaded runner can miss the first attempts
  for (let i = 0; i < 300 && !hub.connected; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(hub.connected, 'the extension paired with tug serve');
  await opts.waitForFunction(() => /connected/.test(document.getElementById('status')!.textContent ?? ''), null, { timeout: 5000 });
  await opts.close();
}

/** The user opens a page and clicks "Share this tab with Tugline" (the action's click handler). */
async function userShares(url: string): Promise<any> {
  const page = await fixture.ctx.newPage();
  await page.goto(url);
  await fixture.sw.evaluate(async (u: string) => {
    const [t] = await chrome.tabs.query({ url: u });
    await (self as any).ohBridge.toggleShare(t);
  }, page.url());
  return page;
}

async function unshareAll(): Promise<void> {
  await fixture.sw.evaluate(() => (self as any).ohBridge.stopAll());
  for (const p of fixture.ctx.pages()) if (!p.url().startsWith('chrome-extension://')) await p.close().catch(() => undefined);
}

function refIn(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  if (!line) throw new Error(`no ${re} in:\n${text}`);
  return line.match(/\[ref=(\w+)\]/)![1];
}

const allText = (body: any) => (body.messages as any[]).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

async function runAgent(script: Script, over: any = {}) {
  const srv = await startMockServer(script);
  const cfg = testConfig(srv.url, {
    homeDir: fixture.home,
    permissionMode: 'yolo',
    web: { searchProvider: 'none', allowHosts: ['localhost', '127.0.0.1'] },
    browser: { enabled: true, record: false, extensionEnabled: true, attachedAllowDomains: ['localhost', '127.0.0.1'], ...over },
  });
  const events: AgentEvent[] = [];
  let asks = 0;
  const agent = await Agent.create({ workspace: tmpWorkspace(), config: cfg, mcp: false, ui: { onEvent: (e: AgentEvent) => events.push(e), askUser: async () => (asks++, 'Allow for this session') } });
  try {
    const res = await agent.run('do the browser task in my shared tab');
    return { res, srv, events, asks, journal: agent.journalFile };
  } finally {
    await agent.dispose();
    await srv.close();
  }
}

test('N29 AC1+AC2: the agent drives a shared tab through the extension; a non-allowlisted site is refused by the extension; unshared tabs are never seen', async () => {
  await launchUserBrowser();
  const L = fixture.site!.url.replace('127.0.0.1', 'localhost');
  const shared = await userShares(`${L}form.html`);
  // A second tab the user did NOT share.
  const other = await fixture.ctx.newPage();
  await other.goto(`${L}table.html`);
  try {
    const script: Script = (body, i) => {
      const last = lastToolResult(body);
      if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${L}form.html`, profile: 'extension' } }] };
      if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Full name"/), text: 'Ada Lovelace' } }, { name: 'browser_act', arguments: { ref: refIn(last, /checkbox "I accept the terms"/), action: 'check' } }] };
      if (i === 3) return { toolCalls: [{ name: 'browser_tabs', arguments: { op: 'list' } }] };
      return { content: 'done' };
    };
    const { srv, events, asks } = await runAgent(script);
    assert.match(lastToolResult(srv.requests[1]), /opened http:\/\/localhost:\d+\/form\.html .*profile extension/);
    assert.match(lastToolResult(srv.requests[2]), /<untrusted_web_content source="http:\/\/localhost:\d+\/form\.html">/);
    assert.match(lastToolResult(srv.requests[3]), /\[checked\]/);
    assert.equal(await shared.inputValue('#name'), 'Ada Lovelace', "the action happened in the user's real tab");
    assert.equal(await shared.isChecked('#terms'), true);
    const tabs = lastToolResult(srv.requests[4]);
    assert.match(tabs, /Order form/);
    assert.doesNotMatch(tabs, /table\.html|Table/, 'a tab the user did not share is invisible to the agent');
    assert.equal(asks, 1, 'per-session consent');
    assert.ok(events.some((e) => e.type === 'notice' && /controlling the tabs you shared/.test(e.message)), 'visible banner');

    // AC2: allowed by the core (attachedAllowDomains, web.allowHosts) but not by the extension's own site list.
    const refused: Script = (_b, i) => {
      if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${L}form.html`, profile: 'extension' } }] };
      if (i === 1) return { toolCalls: [{ name: 'browser_navigate', arguments: { url: `${fixture.site!.url}table.html` } }] };
      // An allowlisted page that redirects off the extension's list: the hop is refused at the request stage.
      if (i === 2) return { toolCalls: [{ name: 'browser_navigate', arguments: { url: `${L}__redirect?to=${encodeURIComponent(`${fixture.site!.url}table.html`)}` } }] };
      if (i === 3) return { toolCalls: [{ name: 'browser_tabs', arguments: { op: 'new', url: `${L}tabs.html` } }] };
      return { content: 'done' };
    };
    const r2 = await runAgent(refused);
    assert.match(lastToolResult(r2.srv.requests[2]), /blocked: .*127\.0\.0\.1.*not in the extension's allowed sites/);
    assert.match(lastToolResult(r2.srv.requests[3]), /blocked: .*127\.0\.0\.1.*not in the extension's allowed sites/);
    assert.match(lastToolResult(r2.srv.requests[4]), /cannot open tabs/);
    assert.doesNotMatch(shared.url(), /127\.0\.0\.1/, 'the tab never loaded the refused site');
    // The extension recorded its refusals, and after the session the tab is released but still shared.
    const st = await fixture.sw.evaluate(() => (self as any).ohBridge.snapshot());
    assert.ok(st.blocked.some((b: any) => /127\.0\.0\.1/.test(b.url)), JSON.stringify(st.blocked));
    assert.deepEqual(st.tabs.map((t: any) => t.attached), [false], 'released when the session ends');
    assert.equal(shared.isClosed(), false, "the user's tab stays open");
  } finally {
    await unshareAll();
  }
});

test('N29 AC3: the kill switch detaches every shared tab within 1 s', async () => {
  await launchUserBrowser();
  const L = fixture.site!.url.replace('127.0.0.1', 'localhost');
  await userShares(`${L}form.html`);
  const cfg = testConfig('http://127.0.0.1:9/v1', { homeDir: fixture.home, web: { allowHosts: ['localhost'] }, browser: { enabled: true, record: false, extensionEnabled: true, attachedAllowDomains: ['localhost'] } });
  const s = new BrowserSession({ sessionId: `n29-kill-${Date.now()}`, workspace: tmpWorkspace(), config: cfg });
  // Is the EXTENSION's debugger session still on the tab? (getTargets() would also count this test's own Playwright.)
  const tabId: number = await fixture.sw.evaluate(async () => (await chrome.tabs.query({})).find((t: any) => /form\.html/.test(t.url ?? ''))!.id);
  const attached = async () => fixture.sw.evaluate((id: number) => chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', { expression: '1' }).then(() => true, () => false), tabId);
  try {
    assert.equal((await s.driver.open(`${L}form.html`, { profile: 'extension' })).blocked, undefined);
    await s.driver.snapshot();
    assert.equal(await attached(), true, 'the tab is under control before the kill');
    const t0 = Date.now();
    killAutomation('test kill switch');
    let after = -1;
    while (Date.now() - t0 < 3000) {
      if (!(await attached())) {
        after = Date.now() - t0;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(after >= 0 && after < 1000, `detached after ${after} ms`);
    const st = await fixture.sw.evaluate(() => (self as any).ohBridge.snapshot());
    assert.deepEqual(st.tabs, [], 'the kill switch also stops sharing: the user must share again');
    assert.equal(s.driver.isOpen, false, 'the session closed its driver');
  } finally {
    resetKillSwitch();
    await s.dispose();
    await unshareAll();
  }
});

test('N29 AC4: a secret:// value typed into the shared tab never appears in any message to the model', async () => {
  await launchUserBrowser();
  const L = fixture.site!.url.replace('127.0.0.1', 'localhost');
  const SECRET = 'correct-horse-battery-9';
  new SecretVault(fixture.home!, {}).set('site/pw', SECRET);
  const page = await userShares(`${L}login.html`);
  try {
    const script: Script = (body, i) => {
      const last = lastToolResult(body);
      if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${L}login.html`, profile: 'extension' } }] };
      if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Username"/), text: 'alice' } }, { name: 'browser_type', arguments: { ref: refIn(last, /textbox "Password"/), secret: 'secret://site/pw' } }] };
      if (i === 3) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(allText(body), /textbox "API key"/), secret: 'secret://site/pw' } }] };
      if (i === 4) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Sign in"/), expect: { text_present: 'Welcome' } } }] };
      if (i === 5) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }, { name: 'browser_extract', arguments: {} }, { name: 'browser_screenshot', arguments: {} }] };
      return { content: 'signed in' };
    };
    const { srv, journal } = await runAgent(script);
    assert.match(lastToolResult(srv.requests[5]), /outcome: confirmed[\s\S]*Welcome, alice/);
    assert.match(lastToolResult(srv.requests[4]), /textbox "API key" \[ref=\w+\] \[value="•••"\]/);
    assert.equal(await page.inputValue('#apikey'), SECRET, 'the value was filled in the real tab');
    const transcript = JSON.stringify(srv.requests);
    assert.ok(transcript.includes('secret://site/pw'), 'the model works with the ref');
    assert.ok(!transcript.includes(SECRET), 'the value never reaches the model');
    assert.ok(journal && !fs.readFileSync(journal, 'utf8').includes(SECRET), 'nor the journal');
  } finally {
    await unshareAll();
  }
});

test('N29: a popup that a shared tab opens is not shared (never auto-share)', async () => {
  await launchUserBrowser();
  const L = fixture.site!.url.replace('127.0.0.1', 'localhost');
  await userShares(`${L}tabs.html`);
  try {
    const script: Script = (body, i) => {
      const last = lastToolResult(body);
      if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${L}tabs.html`, profile: 'extension' } }] };
      if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      if (i === 2) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(last, /link "Open details in a new tab"/) } }] };
      if (i === 3) return { toolCalls: [{ name: 'browser_tabs', arguments: { op: 'list' } }] };
      return { content: 'done' };
    };
    const { srv } = await runAgent(script);
    // The browser did open the popup (the user's browser), but it is not one of the agent's tabs.
    assert.ok(fixture.ctx.pages().some((p: any) => /tab2\.html/.test(p.url())), 'the popup exists in the browser');
    const tabs = lastToolResult(srv.requests[4]);
    assert.match(tabs, /Tabs/);
    assert.doesNotMatch(tabs, /tab2|Details/i, tabs);
    const st = await fixture.sw.evaluate(() => (self as any).ohBridge.snapshot());
    assert.equal(st.tabs.length, 1, 'still only the tab the user shared');
  } finally {
    await unshareAll();
  }
});

test('no browser processes leak from this test file (extension)', async () => {
  await fixture.ctx?.close();
  fixture.ctx = undefined;
  const out = childProcesses(process.pid).filter((p) => !isZombie(p)).map((p) => `${p.pid} ${p.args}`).join('\n');
  assert.doesNotMatch(out, /chrom(e|ium)/i, out);
});
