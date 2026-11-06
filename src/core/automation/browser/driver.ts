/**
 * BrowserDriver on Playwright (SPEC E1; research CU §1.2, §5).
 *
 * Perception is the accessibility tree, so text-only models can drive it:
 *  - engine 'aria': `page.ariaSnapshotJSON({mode:'ai', boxes:true})` (refs like
 *    e12 / f1e3) and `page.getByRef(ref)` to act;
 *  - engine 'dom': a DOM walk that stamps `data-oh-ref` attributes, for
 *    Playwright builds without those APIs.
 *
 * Every mutating call is scan-act-verify: resolve the ref (rebinding a stale
 * one by semantic key only when unambiguous), let the caller's guard (fence
 * rule, human handoff, rate limits) veto it, act, let the page settle,
 * re-snapshot, then return the line diff and an outcome
 * (confirmed / suspected_noop / failed). Dialogs are never auto-accepted, and
 * every request the page makes passes the caller's URL check (SSRF guard,
 * attached-mode allowlist).
 *
 * The driver is mechanism only; policy lives in the session (session.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ActResult, BrowserAction, BrowserDriver, Expect, Snapshot, SnapshotOptions, UiNode } from '../types.js';
import { countRefs, findRef, fromAriaJson, refMap, treeText, walk } from '../snapshot/tree.js';
import { renderTree } from '../snapshot/render.js';
import { lineDiff } from '../snapshot/diff.js';
import { maskPasswords } from '../snapshot/mask.js';
import { keyToString, resolveKey, semanticKey, type SemanticKey } from '../snapshot/keys.js';
import { evalAll, evalExpect } from '../expect/evaluate.js';
import type { PolicyVerdict } from '../policy/index.js';
import { DOM_SNAPSHOT_SRC, ELEMENT_INFO_SRC, PAGE_FACTS_SRC, pageFn } from './pageScripts.js';
import { hasAriaRefs, launch, type Launched } from './launch.js';
import { markCandidates, type Mark } from '../perception/marks.js';
import { startEgressProxy, type EgressOptions, type EgressProxy } from './egress.js';
import type { RelayOptions, RelayPolicy } from './extension/hub.js';

export interface ElementInfo {
  tag: string;
  type: string;
  id: string;
  testid: string;
  haspopup: boolean;
  expanded: string | null;
  submit: boolean;
  inForm: boolean;
  fieldKind: 'card' | 'otp' | 'password' | 'other';
  isFile: boolean;
  isSelect: boolean;
  href: string;
  target: string;
}

export interface TargetInfo {
  ref: string;
  node: UiNode;
  key?: SemanticKey;
  info?: ElementInfo;
  rebound: boolean;
  /** Deterministic CSS selector when the element has an id / data-testid (L2a recipes). */
  selector?: string;
}

export type ActionKind = 'act' | 'type' | 'key' | 'point';
export type Guard = (t: TargetInfo | undefined, kind: ActionKind, action: string) => PolicyVerdict | Promise<PolicyVerdict>;

export interface PageFacts {
  cardFields: boolean;
  otpField: boolean;
  passwords: { value: string; label: string }[];
  text: string;
  canvas: number;
  iframes: string[];
  title: string;
}

export interface DriverHooks {
  /** Return an error message to block a request (SSRF guard, attached allowlist). */
  checkUrl?(u: URL, info: { navigation: boolean; mainFrame: boolean }): Promise<string | undefined>;
  resolveSecret?(ref: string): Promise<string>;
  /** Redaction applied to everything the driver returns (secrets echoed by pages). */
  mask?(s: string): string;
  /** Decide where a download goes; return {error} to refuse it. */
  downloadPath?(suggested: string): { path: string } | { error: string };
  /** Files a page may receive on upload; return an error to refuse. */
  checkUpload?(files: string[]): string | undefined;
  /** Run launched browsers behind the egress guard proxy (every request and redirect hop is checked). */
  egress?: EgressOptions;
  /** Secret values handed out so far (screenshots are withheld when a page echoes one as text). */
  secretValues?(): string[];
}

export interface DriverOptions {
  homeDir: string;
  headless?: boolean;
  executablePath?: string;
  profile?: string;
  cdpUrl?: string;
  engine?: 'auto' | 'aria' | 'dom';
  snapshotTokens?: number;
  maxRepeated?: number;
  maxTextChars?: number;
  actionTimeoutMs?: number;
  navigationTimeoutMs?: number;
  /**
   * Attached profile only: drive the browser's existing pages (and new ones) instead of only a tab we open.
   * For a dedicated app relaunched for us (desktop ElectronBridge), never for the user's own Chrome.
   */
  adoptExistingPages?: boolean;
  /** profile "extension" (N29): the policy pushed to the extension (it enforces it too). */
  extensionPolicy?: RelayPolicy;
  hooks?: DriverHooks;
}

export interface NavResult {
  url: string;
  title: string;
  status?: number;
  blocked?: string;
}

export interface DriverActResult extends ActResult {
  target?: { role: string; name?: string; key?: string; semantic?: SemanticKey; selector?: string; ref: string };
  /** Downloads, new tabs, dialogs: things the model should know. */
  notes?: string[];
  /** Full (budgeted) snapshot after navigation, when the diff is not enough. */
  snapshot?: string;
  url?: string;
  /** Hash of the snapshot the action was taken against (recorder). */
  preHash?: string;
}

interface StoredSnap {
  snap: Snapshot;
  full: string;
}

const SETTLE_MS = 150;

function sha(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function cssEscape(s: string): string {
  return s.replace(/([^A-Za-z0-9_-])/g, '\\$1');
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  private launched?: Launched;
  private pages: any[] = [];
  private active = 0;
  private snaps: StoredSnap[] = [];
  private seq = 0;
  private engine: 'aria' | 'dom' = 'aria';
  private pendingDialog?: { dialog: any; type: string; message: string; defaultValue: string; inflight?: Promise<unknown> };
  private dialogWaiters: ((d: unknown) => void)[] = [];
  private newPages: any[] = [];
  private pendingDownloads: Promise<void>[] = [];
  private notes: string[] = [];
  private lastStatus?: number;
  private hostCache = new Map<string, Promise<string | undefined>>();
  private egress?: EgressProxy;
  private blockedSeen = 0;
  private egressSeen = 0;
  /** Elements the harness filled from secret:// refs: masked in every capture. */
  private secretHandles: any[] = [];
  /** CDP sessions guarding our tabs in attached mode. */
  private cdpSessions: any[] = [];
  /** Attached mode: CDP guards of our out-of-process frames, by frame. */
  private frameGuards = new Map<any, Promise<void>>();
  /** Why the DOM fallback is in use, when it was not asked for. */
  engineNote?: string;
  readonly downloads: { file: string; bytes: number; url: string }[] = [];
  blockedRequests: string[] = [];

  constructor(readonly opts: DriverOptions) {}

  // ------------------------------------------------------------ lifecycle

  get isOpen(): boolean {
    return !!this.launched;
  }

  get profile(): string | undefined {
    return this.launched?.profile;
  }

  get snapshotEngine(): 'aria' | 'dom' {
    return this.engine;
  }

  private mask(s: string): string {
    return this.opts.hooks?.mask ? this.opts.hooks.mask(s) : s;
  }

  get page(): any {
    const p = this.pages[this.active];
    if (!p) throw new Error('no page is open: call browser_open first');
    return p;
  }

  async ensureLaunched(profile?: string, headed?: boolean): Promise<void> {
    const want = profile ?? this.opts.profile ?? 'isolated';
    if (this.launched && this.launched.profile !== want) await this.close();
    if (this.launched) return;
    // The user's own browser (attached, extension) cannot use our egress proxy.
    if (this.opts.hooks?.egress && want !== 'attached' && want !== 'extension') this.egress = await startEgressProxy(this.opts.hooks.egress);
    try {
      this.launched = await launch({ headless: headed ? false : this.opts.headless ?? true, executablePath: this.opts.executablePath, profile: want, homeDir: this.opts.homeDir, cdpUrl: this.opts.cdpUrl, proxy: this.egress?.url, extension: want === 'extension' ? this.relayOptions() : undefined });
    } catch (e) {
      await this.egress?.close();
      this.egress = undefined;
      throw e;
    }
    const ctx = this.launched.context;
    ctx.setDefaultTimeout(this.opts.actionTimeoutMs ?? 8000);
    ctx.setDefaultNavigationTimeout(this.opts.navigationTimeoutMs ?? 30_000);
    // "Own tabs only" is the user's-Chrome mode; a dedicated app (adoptExistingPages) is driven like a launched browser.
    const attached = this.launched.profile === 'attached' && !this.opts.adoptExistingPages;
    const viaExtension = this.launched.profile === 'extension';
    // Launched browsers: a context-wide route guard (defence in depth; the egress proxy is the boundary).
    // Attached: never touch the user's context or other tabs; each tab we drive gets its own CDP guard.
    // Extension: the extension owns the Fetch domain and asks this driver's checkUrl for each request (relayOptions).
    if (this.opts.hooks?.checkUrl && !attached && !viaExtension) await ctx.route('**/*', (route: any) => this.routeGuard(route));
    if (viaExtension) {
      // Exactly the tabs the user shared with the extension; tabs shared later appear as new pages.
      ctx.on('page', (p: any) => {
        if (!this.pages.includes(p)) {
          this.trackPage(p);
          this.newPages.push(p);
        }
      });
      for (const p of ctx.pages()) this.trackPage(p);
      if (!this.pages.length) {
        await this.close();
        throw new Error('no tab is shared with Tugline: open the page in your browser and click the Tugline toolbar button ("Share this tab with Tugline")');
      }
    } else if (attached) {
      // Only the tab we open here (and popups it opens) are ours. The user's existing tabs are not tracked or guarded.
      await this.adoptOwnPage(await ctx.newPage());
    } else {
      ctx.on('page', (p: any) => {
        if (!this.pages.includes(p)) {
          this.trackPage(p);
          this.newPages.push(p);
        }
      });
      for (const p of ctx.pages()) this.trackPage(p);
      if (!this.pages.length) this.trackPage(await ctx.newPage());
    }
    this.newPages = [];
    this.active = 0;
    const probe = this.pages[0];
    const want2 = this.opts.engine ?? 'auto';
    this.engine = want2 === 'dom' ? 'dom' : want2 === 'aria' ? 'aria' : hasAriaRefs(probe) ? 'aria' : 'dom';
    if (this.engine === 'aria' && !hasAriaRefs(probe)) this.engine = 'dom';
    this.engineNote = this.engine === 'dom' && want2 !== 'dom' ? 'DOM-walk fallback: this Playwright lacks ariaSnapshot({mode:"ai"})/getByRef (needs ≥1.64); install playwright@^1.64.1 for the faster, more faithful snapshot' : undefined;
  }

  /** N29: the relay asks this driver's guard about every request the extension sees in a shared tab. */
  private relayOptions(): RelayOptions {
    const kinds = { main: [true, true], frame: [true, false], sub: [false, false] } as const;
    return {
      policy: this.opts.extensionPolicy ?? { coreSites: [], allowHosts: [] },
      checkUrl: this.opts.hooks?.checkUrl ? (u, kind) => this.checkUrlCached(u, kinds[kind][0], kinds[kind][1]) : undefined,
      onBlocked: (msg) => this.blockedRequests.push(msg),
      onDetached: (reason) => this.notes.push(`The shared tab was released (${reason}).`),
    };
  }

  /** The verdict for one request (any guard); a refusal is recorded in blockedRequests. */
  private async requestVerdict(url: string, navigation: boolean, mainFrame: boolean): Promise<string | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return 'invalid URL';
    }
    if (!/^(https?|wss?):$/.test(u.protocol)) return undefined;
    const why = await this.checkUrlCached(u, navigation, mainFrame);
    if (why) this.blockedRequests.push(`${u.origin}${u.pathname}: ${why}`);
    return why;
  }

  /** Playwright route() guard: context-wide for launched browsers, per page in attached mode. */
  private async routeGuard(route: any): Promise<void> {
    const req = route.request();
    const nav = req.isNavigationRequest();
    let frame: any;
    let isMainFrame = false;
    try {
      frame = req.frame();
      isMainFrame = frame === frame.page().mainFrame();
    } catch {
      /* service worker requests have no frame */
    }
    if (await this.requestVerdict(req.url(), nav, nav && isMainFrame)) return route.abort('blockedbyclient').catch(() => undefined);
    // Attached: a cross-site frame runs in its own process, outside the page's CDP guard. Guard it before its
    // first request goes out, so its later redirect hops are checked too (route() does not see redirects).
    if (frame && !isMainFrame && this.launched?.attached) await this.guardFrameCdp(frame);
    return route.continue().catch(() => undefined);
  }

  /**
   * Attached mode (SPEC E6, G4): the user's Chrome does not go through our
   * egress proxy, and Playwright's route() misses redirect hops. So each tab we
   * drive gets a CDP session with `Fetch.enable` at the Request stage: every
   * request of that page, including each redirect hop (a new
   * `Fetch.requestPaused`), is checked before it is sent and refused with
   * `BlockedByClient` when the allowlist or SSRF guard says no.
   *
   * Cross-site iframes are separate targets (site isolation), which the page's
   * CDP session does not see. A page-level route() covers them from their
   * first request (Playwright enables interception before it resumes the
   * frame), and routeGuard then gives each such frame its own CDP guard for
   * redirect hops. Popups opened by our tab are adopted the same way. Nothing
   * is attached to the user's other tabs.
   */
  private async adoptOwnPage(p: any): Promise<void> {
    if (this.pages.includes(p)) return;
    if (this.opts.hooks?.checkUrl) {
      await this.guardTargetCdp(p, true);
      await p.route('**/*', (route: any) => this.routeGuard(route));
      // A frame that navigates cross-site gets a new process: guard it again.
      p.on('framenavigated', (f: any) => {
        if (f !== p.mainFrame()) this.frameGuards.delete(f);
      });
    }
    this.trackPage(p);
    p.on('popup', (pp: any) => {
      void this.adoptOwnPage(pp)
        .then(() => this.vetPopup(pp))
        .then(() => this.newPages.push(pp));
    });
  }

  /**
   * A popup's first request can leave before its CDP guard is in place (the
   * guard is attached when Playwright reports the popup). Later hops are
   * guarded; the opening URL is checked here, and a refused popup is blanked
   * so nothing from it reaches the model.
   */
  private async vetPopup(pp: any): Promise<void> {
    if (!this.opts.hooks?.checkUrl) return;
    await pp.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    let u: URL;
    try {
      u = new URL(pp.url());
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    const why = await this.checkUrlCached(u, true, true);
    if (!why) return;
    this.blockedRequests.push(`${u.origin}${u.pathname}: ${why} (popup)`);
    await pp.goto('about:blank').catch(() => undefined);
  }

  /** A CDP guard for an out-of-process frame (no-op for a frame in its page's process). */
  private guardFrameCdp(f: any): Promise<void> {
    let g = this.frameGuards.get(f);
    if (!g) {
      g = this.guardTargetCdp(f, false).catch(() => undefined /* same-process frame: the page guard sees it */);
      this.frameGuards.set(f, g);
    }
    return g;
  }

  private async guardTargetCdp(target: any, isPage: boolean): Promise<void> {
    const cdp = await this.launched!.context.newCDPSession(target);
    let mainFrameId: string | undefined;
    if (isPage) {
      const tree: any = await cdp.send('Page.getFrameTree').catch(() => undefined);
      mainFrameId = tree?.frameTree?.frame?.id;
    }
    cdp.on('Fetch.requestPaused', async (ev: any) => {
      const go = (method: string, params: Record<string, unknown>) => cdp.send(method, { requestId: ev.requestId, ...params }).catch(() => undefined);
      const navigation = ev.resourceType === 'Document';
      // Only the page's own top frame is a main-frame navigation; a frame target's root is still a subframe.
      const mainFrame = isPage && navigation && (!mainFrameId || ev.frameId === mainFrameId);
      if (await this.requestVerdict(ev.request.url, navigation, mainFrame)) return go('Fetch.failRequest', { errorReason: 'BlockedByClient' });
      return go('Fetch.continueRequest', {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    this.cdpSessions.push(cdp);
  }

  private checkUrlCached(u: URL, navigation: boolean, mainFrame: boolean): Promise<string | undefined> {
    const k = `${u.hostname}|${navigation && mainFrame ? 'nav' : navigation ? 'frame' : 'sub'}`;
    let p = this.hostCache.get(k);
    if (!p) {
      p = this.opts.hooks!.checkUrl!(u, { navigation, mainFrame }).catch((e) => (e as Error).message);
      this.hostCache.set(k, p);
    }
    return p;
  }

  private trackPage(p: any): void {
    if (this.pages.includes(p)) return;
    this.pages.push(p);
    p.on('close', () => {
      const i = this.pages.indexOf(p);
      if (i >= 0) this.pages.splice(i, 1);
      if (this.active >= this.pages.length) this.active = Math.max(0, this.pages.length - 1);
    });
    p.on('dialog', (d: any) => {
      this.pendingDialog = { dialog: d, type: d.type(), message: this.mask(d.message()), defaultValue: d.defaultValue?.() ?? '' };
      const ws = this.dialogWaiters.splice(0);
      for (const w of ws) w(d);
    });
    p.on('download', (d: any) => this.pendingDownloads.push(this.handleDownload(d)));
  }

  private async handleDownload(d: any): Promise<void> {
    const suggested = path.basename(String(d.suggestedFilename() || 'download')).replace(/[^\w.@+-]/g, '_') || 'download';
    const dest = this.opts.hooks?.downloadPath?.(suggested) ?? { error: 'downloads are not configured' };
    if ('error' in dest) {
      await d.cancel().catch(() => undefined);
      this.notes.push(`Download of ${suggested} refused: ${dest.error}`);
      return;
    }
    try {
      fs.mkdirSync(path.dirname(dest.path), { recursive: true });
      await d.saveAs(dest.path);
      const bytes = fs.statSync(dest.path).size;
      this.downloads.push({ file: dest.path, bytes, url: d.url() });
      this.notes.push(`Downloaded ${suggested} → ${dest.path} (${bytes} bytes)`);
    } catch (e) {
      this.notes.push(`Download of ${suggested} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  async close(): Promise<void> {
    const l = this.launched;
    if (l?.attached && !this.opts.adoptExistingPages && l.profile !== 'extension') {
      // Leave the user's browser as it was: close only the tabs we opened.
      for (const p of [...this.pages]) await p.close().catch(() => undefined);
    }
    for (const c of this.cdpSessions.splice(0)) await c.detach().catch(() => undefined);
    this.frameGuards.clear();
    this.launched = undefined;
    this.pages = [];
    this.snaps = [];
    this.pendingDialog = undefined;
    this.hostCache.clear();
    if (l) await l.close();
    await this.egress?.close();
    this.egress = undefined;
    this.blockedSeen = 0;
    this.egressSeen = 0;
    this.blockedRequests = [];
    this.secretHandles = [];
  }

  /**
   * Attached mode has no egress proxy (it is the user's own Chrome), and route()
   * does not see redirect hops: check where the tab actually landed and leave
   * a page that the allowlist / SSRF guard would have refused.
   */
  private async landedCheck(): Promise<string | undefined> {
    if ((this.launched?.profile !== 'attached' && this.launched?.profile !== 'extension') || !this.opts.hooks?.checkUrl) return undefined;
    const page = this.page;
    let u: URL;
    try {
      u = new URL(page.url());
    } catch {
      return undefined;
    }
    if (!/^https?:$/.test(u.protocol)) return undefined;
    const why = await this.opts.hooks.checkUrl(u, { navigation: true, mainFrame: true });
    if (!why) return undefined;
    await page.goto('about:blank').catch(() => undefined);
    return `landed on ${u.host} after a redirect: ${why}`;
  }

  /** Requests refused (route guard or egress proxy) since the last call. */
  private newlyBlocked(): string[] {
    const proxy = this.egress?.blocked ?? [];
    const fresh = [...this.blockedRequests.slice(this.blockedSeen), ...proxy.slice(this.egressSeen)];
    this.blockedSeen = this.blockedRequests.length;
    this.egressSeen = proxy.length;
    return fresh;
  }

  // ------------------------------------------------------------ navigation

  async open(url: string, opts: { profile?: string; headed?: boolean } = {}): Promise<NavResult> {
    await this.ensureLaunched(opts.profile, opts.headed);
    return this.navigate(url);
  }

  async navigate(target: string): Promise<NavResult> {
    if (!this.launched) await this.ensureLaunched();
    const page = this.page;
    this.newlyBlocked();
    let resp: any;
    try {
      if (target === 'back') resp = await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (target === 'forward') resp = await page.goForward({ waitUntil: 'domcontentloaded' });
      else if (target === 'reload') resp = await page.reload({ waitUntil: 'domcontentloaded' });
      else {
        let u: URL;
        try {
          u = new URL(target);
        } catch {
          throw new Error(`invalid URL: ${target}`);
        }
        if (!/^https?:$/.test(u.protocol) && target !== 'about:blank') throw new Error(`only http(s) URLs can be opened (got ${u.protocol})`);
        if (this.opts.hooks?.checkUrl && u.protocol !== 'about:') {
          const why = await this.opts.hooks.checkUrl(u, { navigation: true, mainFrame: true });
          if (why) return { url: page.url(), title: await page.title().catch(() => ''), blocked: why };
        }
        resp = await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });
      }
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      const b = this.newlyBlocked();
      if (b.length) {
        // Chrome commits its own error page right after a refused request; let it settle so the next navigation is not interrupted.
        await page.waitForURL((x: URL) => x.protocol === 'chrome-error:', { timeout: 1500 }).catch(() => undefined);
        await page.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => undefined);
        return { url: page.url(), title: await page.title().catch(() => ''), blocked: b[b.length - 1] };
      }
      throw e;
    }
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
    // A redirect hop refused by the egress proxy: the tab shows our block page, report it as blocked.
    const b = this.newlyBlocked();
    const host = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return '';
      }
    })();
    const mainBlocked = b.find((x) => host && x.startsWith(`${host}:`)) ?? (resp?.headers?.()['x-tugline-blocked'] ? b[b.length - 1] : undefined);
    if (mainBlocked) return { url: page.url(), title: '', blocked: mainBlocked };
    const landed = await this.landedCheck();
    if (landed) return { url: page.url(), title: '', blocked: landed };
    this.lastStatus = resp?.status?.();
    return { url: page.url(), title: this.mask(await page.title().catch(() => '')), status: this.lastStatus };
  }

  get status(): number | undefined {
    return this.lastStatus;
  }

  // ------------------------------------------------------------ perception

  async pageFacts(): Promise<PageFacts> {
    const page = this.page;
    const fn = pageFn<void, PageFacts>(PAGE_FACTS_SRC);
    const main = await page.evaluate(fn).catch(() => ({ cardFields: false, otpField: false, passwords: [], text: '', canvas: 0, iframes: [], title: '' }) as PageFacts);
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const sub: PageFacts | undefined = await f.evaluate(fn).catch(() => undefined);
      if (!sub) continue;
      main.cardFields ||= sub.cardFields;
      main.otpField ||= sub.otpField;
      main.passwords.push(...sub.passwords);
      main.iframes.push(f.url());
      main.text += `\n${sub.text}`;
    }
    return main;
  }

  /** Raw tree from the active engine, with password values masked. */
  private async captureTree(): Promise<UiNode> {
    const page = this.page;
    let root: UiNode;
    if (this.engine === 'aria') {
      const json = await page.ariaSnapshotJSON({ mode: 'ai', boxes: true });
      root = fromAriaJson(json);
      // The aria snapshot includes password values; mark those textboxes (matched by value or label).
      const facts = await this.pageFacts();
      if (facts.passwords.length) {
        const values = new Set(facts.passwords.map((p) => p.value).filter(Boolean));
        const labels = new Set(facts.passwords.map((p) => p.label).filter(Boolean));
        walk(root, (n) => {
          if (n.role !== 'textbox') return;
          // By label; by value only for unlabelled fields (another field may legitimately hold the same text).
          if ((n.name && labels.has(n.name)) || (!n.name && n.value && values.has(n.value))) n.states = [...(n.states ?? []), 'password'];
        });
      }
    } else {
      root = (await page.evaluate(pageFn(DOM_SNAPSHOT_SRC), { maxNodes: 20000 })) as UiNode;
    }
    maskPasswords(root);
    return root;
  }

  private renderOpts(o: SnapshotOptions = {}) {
    return { maxTokens: o.maxTokens ?? this.opts.snapshotTokens ?? 5000, query: o.query, maxRepeated: this.opts.maxRepeated ?? 20, maxTextChars: this.opts.maxTextChars ?? 160, includeBoxes: o.includeBoxes, mask: (s: string) => this.mask(s) };
  }

  async snapshot(opts: SnapshotOptions = {}): Promise<Snapshot> {
    if (!this.launched) throw new Error('no page is open: call browser_open first');
    if (this.pendingDialog) throw new Error(`a ${this.pendingDialog.type} dialog is open ("${this.pendingDialog.message}"); handle it with browser_dialog first`);
    const page = this.page;
    const root = await this.captureTree();
    const full = renderTree(root, { ...this.renderOpts(), maxTokens: 0, query: undefined }).text;
    let scopeRef: string | undefined;
    if (opts.scope && opts.scope !== 'page') {
      if (/^(main|dialog|form|navigation|table)$/.test(opts.scope)) {
        walk(root, (n) => {
          if (scopeRef) return false;
          if ((n.role === opts.scope || (opts.scope === 'dialog' && n.role === 'alertdialog')) && n.ref) scopeRef = n.ref;
        });
      } else scopeRef = opts.scope;
    }
    const r = renderTree(root, { ...this.renderOpts(opts), scopeRef });
    const snap: Snapshot = {
      id: `s${++this.seq}`,
      surface: 'browser',
      url: page.url(),
      title: this.mask(await page.title().catch(() => '')),
      root,
      tree: r.text,
      truncated: r.truncated,
      elementCount: countRefs(root),
      hash: sha(full),
      takenAt: Date.now(),
    };
    this.snaps.push({ snap, full });
    if (this.snaps.length > 6) this.snaps.shift();
    return snap;
  }

  get latest(): Snapshot | undefined {
    return this.snaps[this.snaps.length - 1]?.snap;
  }

  private get latestFull(): string {
    return this.snaps[this.snaps.length - 1]?.full ?? '';
  }

  private locate(ref: string): any {
    const page = this.page;
    return this.engine === 'aria' ? page.getByRef(ref) : page.locator(`[data-oh-ref="${ref.replace(/"/g, '')}"]`);
  }

  /** Resolve a ref to a live element: rebind stale refs by semantic key only when unambiguous. */
  async resolveTarget(ref: string): Promise<{ ok: true; t: TargetInfo; loc: any } | { ok: false; result: DriverActResult }> {
    if (!this.latest) await this.snapshot();
    let current = refMap(this.latest!.root).get(ref);
    let rebound = false;
    let useRef = ref;
    let key: SemanticKey | undefined = current ? semanticKey(this.latest!.root, ref) : undefined;
    if (!current) {
      const older = [...this.snaps].reverse().find((s) => refMap(s.snap.root).has(ref));
      if (!older) return { ok: false, result: { outcome: 'failed', errorCode: 'ref_not_found', message: `no element [ref=${ref}] in the latest snapshot (${this.latest!.id}). Use a ref from the latest browser_snapshot.` } };
      key = semanticKey(older.snap.root, ref);
    }
    let loc = current ? this.locate(useRef) : undefined;
    if (!current || (await loc.count().catch(() => 0)) === 0) {
      // The element is gone (re-render, navigation): rebind by key against a fresh tree.
      if (current) await this.snapshot();
      const r = key ? resolveKey(this.latest!.root, key) : { ok: false as const, reason: 'missing' as const, candidates: 0 };
      if (!r.ok) {
        const why = r.reason === 'ambiguous' ? `${r.candidates} elements now match ${key ? `${key.role} "${key.name}"` : 'it'}, so rebinding would be a guess` : 'the element is no longer on the page';
        return { ok: false, result: { outcome: 'refused', errorCode: 'stale_ref', message: `ref ${ref} is stale: ${why}. Fresh snapshot:\n${this.latest!.tree}`, newSnapshotId: this.latest!.id } };
      }
      current = r.node;
      useRef = r.node.ref!;
      rebound = true;
      key = semanticKey(this.latest!.root, useRef);
      loc = this.locate(useRef);
    }
    let info: ElementInfo | undefined;
    try {
      info = (await loc.evaluate(pageFn(ELEMENT_INFO_SRC), null, { timeout: 2000 })) as ElementInfo;
    } catch {
      info = undefined;
    }
    const selector = info?.testid ? `[data-testid="${info.testid.replace(/"/g, '\\"')}"]` : info?.id ? `#${cssEscape(info.id)}` : undefined;
    return { ok: true, t: { ref: useRef, node: current!, key, info, rebound, selector }, loc };
  }

  // ------------------------------------------------------------ actions

  /** Run an action; if a dialog opens meanwhile, return early (the action finishes after browser_dialog). */
  private async withDialogRace(fn: () => Promise<unknown>): Promise<'done' | 'dialog'> {
    const opened = new Promise<'dialog'>((r) => this.dialogWaiters.push(() => r('dialog')));
    const p = fn();
    const winner = await Promise.race([p.then(() => 'done' as const), opened]);
    if (winner === 'dialog' && this.pendingDialog) this.pendingDialog.inflight = p.catch(() => undefined);
    else this.dialogWaiters = [];
    return winner;
  }

  private async settle(): Promise<void> {
    const page = this.page;
    await page.waitForTimeout(SETTLE_MS).catch(() => undefined);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    if (this.pendingDownloads.length) {
      await Promise.race([Promise.all(this.pendingDownloads.splice(0)), new Promise((r) => setTimeout(r, 15_000))]);
    }
  }

  /** After an action: pick up new tabs, re-scan, diff, evaluate expect. */
  private async verifyAfter(pre: { full: string; url: string; hash?: string }, expect: Expect | undefined, base: Partial<DriverActResult>): Promise<DriverActResult> {
    if (this.newPages.length) {
      const p = this.newPages.splice(0).pop();
      const i = this.pages.indexOf(p);
      if (i >= 0) {
        this.active = i;
        await p.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
        this.notes.push(`A new tab opened and is now active: [${i}] "${this.mask(await p.title().catch(() => ''))}" ${p.url()} (browser_tabs to switch back)`);
      }
    }
    const landed = await this.landedCheck();
    const notes = [...(base.notes ?? []), ...this.notes.splice(0), ...this.newlyBlocked().map((b) => `Request blocked by the egress guard: ${b}`), ...(landed ? [`Navigation refused: ${landed}`] : [])];
    if (this.pendingDialog) {
      return { ...base, outcome: 'partial', notes, message: `A ${this.pendingDialog.type} dialog is open: "${this.pendingDialog.message}". Call browser_dialog with action "accept" or "dismiss".`, path: 'L2b' };
    }
    const post = await this.snapshot();
    const d = lineDiff(pre.full, this.latestFull);
    const navigated = post.url !== pre.url;
    let outcome: DriverActResult['outcome'] = d.changed || navigated || notes.length ? 'confirmed' : 'suspected_noop';
    let errorCode: DriverActResult['errorCode'];
    let message = base.message;
    if (expect) {
      const facts = await this.pageFacts();
      const r = evalExpect(expect, { root: post.root, url: post.url, title: post.title, text: this.mask(`${treeText(post.root)}\n${facts.text}`), windows: await this.tabTitles() });
      if (r.ok) outcome = 'confirmed';
      else {
        outcome = 'failed';
        errorCode = 'verify_failed';
        message = `expectation not met: ${r.detail}`;
      }
    }
    return {
      ...base,
      outcome,
      errorCode,
      message,
      notes,
      diff: navigated ? undefined : d.text,
      snapshot: navigated || d.text.length > 6000 ? post.tree : undefined,
      newSnapshotId: post.id,
      url: post.url,
      path: 'L2b',
    };
  }

  private failure(e: unknown, base: Partial<DriverActResult> = {}): DriverActResult {
    const msg = (e as Error).message.split('\n')[0];
    const timeout = /timeout|Timeout/.test(msg);
    return { ...base, outcome: 'failed', errorCode: timeout ? 'timeout' : 'interaction_failed', message: this.mask(msg), path: 'L2b' };
  }

  private targetSummary(t: TargetInfo): DriverActResult['target'] {
    return { ref: t.ref, role: t.node.role, name: t.node.name, key: t.key ? keyToString(t.key) : undefined, semantic: t.key, selector: t.selector };
  }

  async act(ref: string, action: BrowserAction, opts: { value?: string | string[]; expect?: Expect; guard?: Guard } = {}): Promise<DriverActResult> {
    if (this.pendingDialog) return { outcome: 'refused', errorCode: 'interaction_failed', message: `a ${this.pendingDialog.type} dialog is open ("${this.pendingDialog.message}"); handle it with browser_dialog first` };
    const res = await this.resolveTarget(ref);
    if (!res.ok) return res.result;
    const { t, loc } = res;
    const base: Partial<DriverActResult> = { target: this.targetSummary(t), rebound: t.rebound || undefined, preHash: this.latest?.hash };
    if (opts.guard) {
      const v = await opts.guard(t, 'act', action);
      if (!v.ok) return { ...base, outcome: 'refused', errorCode: v.code, message: v.message };
    }
    const pre = { full: this.latestFull, url: this.page.url() };
    const timeout = this.opts.actionTimeoutMs ?? 8000;
    try {
      const run = async () => {
        switch (action) {
          case 'click':
            return loc.click({ timeout });
          case 'dblclick':
            return loc.dblclick({ timeout });
          case 'hover':
            return loc.hover({ timeout });
          case 'check':
            return loc.check({ timeout });
          case 'uncheck':
            return loc.uncheck({ timeout });
          case 'focus':
            return loc.focus({ timeout });
          case 'select': {
            if (opts.value === undefined) throw new Error('select needs a value (the option label or value)');
            if (t.info && !t.info.isSelect) throw new Error(`this ${t.node.role} is not a native <select>: click it to open it, then click the option in the next turn`);
            const vals = Array.isArray(opts.value) ? opts.value : [opts.value];
            try {
              return await loc.selectOption(vals.map((v) => ({ label: v })), { timeout: 2000 });
            } catch {
              return loc.selectOption(vals, { timeout });
            }
          }
          case 'upload': {
            const files = (Array.isArray(opts.value) ? opts.value : opts.value ? [opts.value] : []).map(String);
            if (!files.length) throw new Error('upload needs value: one or more file paths');
            const why = this.opts.hooks?.checkUpload?.(files);
            if (why) throw new Error(why);
            if (t.info?.isFile) return loc.setInputFiles(files, { timeout });
            const [chooser] = await Promise.all([this.page.waitForEvent('filechooser', { timeout }), loc.click({ timeout })]);
            return chooser.setFiles(files);
          }
          default:
            throw new Error(`unknown action ${action}`);
        }
      };
      await this.withDialogRace(run);
      await this.settle();
    } catch (e) {
      return this.failure(e, base);
    }
    return this.verifyAfter(pre, opts.expect, base);
  }

  async type(text: string, opts: { ref?: string; secret?: string; submit?: boolean; clear?: boolean; expect?: Expect; guard?: Guard } = {}): Promise<DriverActResult> {
    if (this.pendingDialog) return { outcome: 'refused', errorCode: 'interaction_failed', message: `a ${this.pendingDialog.type} dialog is open; handle it with browser_dialog first` };
    let t: TargetInfo | undefined;
    let loc: any;
    if (opts.ref) {
      const res = await this.resolveTarget(opts.ref);
      if (!res.ok) return res.result;
      t = res.t;
      loc = res.loc;
    }
    const base: Partial<DriverActResult> = { target: t ? this.targetSummary(t) : undefined, rebound: t?.rebound || undefined, preHash: this.latest?.hash };
    if (opts.guard) {
      const v = await opts.guard(t, 'type', opts.submit ? 'submit' : 'type');
      if (!v.ok) return { ...base, outcome: 'refused', errorCode: v.code, message: v.message };
    }
    let value = text;
    if (opts.secret) {
      if (!this.opts.hooks?.resolveSecret) return { ...base, outcome: 'refused', errorCode: 'policy_denied', message: 'no secrets vault is configured' };
      try {
        value = await this.opts.hooks.resolveSecret(opts.secret);
      } catch (e) {
        return { ...base, outcome: 'refused', errorCode: 'policy_denied', message: (e as Error).message };
      }
    }
    const pre = { full: this.latestFull, url: this.page.url() };
    const timeout = this.opts.actionTimeoutMs ?? 8000;
    try {
      await this.withDialogRace(async () => {
        if (loc) {
          if (opts.clear === false) await loc.pressSequentially(value, { timeout });
          else await loc.fill(value, { timeout });
          if (opts.secret) await this.markSecret(await loc.elementHandle({ timeout }).catch(() => null));
          if (opts.submit) await loc.press('Enter', { timeout });
        } else {
          if (opts.secret) await this.markSecret(await this.page.evaluateHandle(pageFn('() => document.activeElement')).then((h: any) => h.asElement()).catch(() => null));
          await this.page.keyboard.type(value);
          if (opts.submit) await this.page.keyboard.press('Enter');
        }
      });
      await this.settle();
    } catch (e) {
      return this.failure(e, base);
    }
    return this.verifyAfter(pre, opts.expect, base);
  }

  async key(keys: string, opts: { expect?: Expect; guard?: Guard } = {}): Promise<DriverActResult> {
    if (this.pendingDialog) return { outcome: 'refused', errorCode: 'interaction_failed', message: `a ${this.pendingDialog.type} dialog is open; handle it with browser_dialog first` };
    if (opts.guard) {
      const v = await opts.guard(undefined, 'key', keys);
      if (!v.ok) return { outcome: 'refused', errorCode: v.code, message: v.message };
    }
    const pre = { full: this.latestFull, url: this.page.url() };
    try {
      await this.withDialogRace(async () => {
        for (const k of keys.split(/\s+/).filter(Boolean)) await this.page.keyboard.press(k);
      });
      await this.settle();
    } catch (e) {
      return this.failure(e);
    }
    return this.verifyAfter(pre, opts.expect, { preHash: this.latest?.hash });
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', opts: { ref?: string; amount?: number } = {}): Promise<DriverActResult> {
    const pre = { full: this.latestFull, url: this.page.url() };
    try {
      if (opts.ref) {
        const res = await this.resolveTarget(opts.ref);
        if (!res.ok) return res.result;
        await res.loc.scrollIntoViewIfNeeded();
      } else {
        const px = (opts.amount ?? 3) * 300;
        const [dx, dy] = direction === 'down' ? [0, px] : direction === 'up' ? [0, -px] : direction === 'right' ? [px, 0] : [-px, 0];
        await this.page.mouse.wheel(dx, dy);
      }
      await this.settle();
    } catch (e) {
      return this.failure(e);
    }
    return this.verifyAfter(pre, undefined, {});
  }

  /** Coordinate action (L3 only): CSS pixels in the viewport. */
  async point(x: number, y: number, action: 'click' | 'dblclick' | 'drag_to', opts: { to?: [number, number]; expect?: Expect; guard?: Guard } = {}): Promise<DriverActResult> {
    if (opts.guard) {
      const v = await opts.guard(undefined, 'point', action);
      if (!v.ok) return { outcome: 'refused', errorCode: v.code, message: v.message };
    }
    const pre = { full: this.latestFull, url: this.page.url() };
    try {
      const m = this.page.mouse;
      await this.withDialogRace(async () => {
        if (action === 'click') await m.click(x, y);
        else if (action === 'dblclick') await m.dblclick(x, y);
        else {
          if (!opts.to) throw new Error('drag_to needs `to`');
          await m.move(x, y);
          await m.down();
          await m.move(opts.to[0], opts.to[1], { steps: 8 });
          await m.up();
        }
      });
      await this.settle();
    } catch (e) {
      return this.failure(e);
    }
    return { ...(await this.verifyAfter(pre, opts.expect, { preHash: this.latest?.hash })), path: 'L3' };
  }

  async dialog(action: 'accept' | 'dismiss', text?: string): Promise<DriverActResult> {
    const d = this.pendingDialog;
    if (!d) return { outcome: 'failed', errorCode: 'interaction_failed', message: 'no dialog is open' };
    const pre = { full: this.latestFull, url: this.page.url() };
    try {
      if (action === 'accept') await d.dialog.accept(d.type === 'prompt' ? text ?? d.defaultValue : undefined);
      else await d.dialog.dismiss();
    } catch (e) {
      this.pendingDialog = undefined;
      return this.failure(e);
    }
    this.pendingDialog = undefined;
    if (d.inflight) await Promise.race([d.inflight, new Promise((r) => setTimeout(r, 5000))]);
    await this.settle();
    return this.verifyAfter(pre, undefined, { message: `${action === 'accept' ? 'Accepted' : 'Dismissed'} the ${d.type} dialog "${d.message}"` });
  }

  get openDialog(): { type: string; message: string } | undefined {
    return this.pendingDialog ? { type: this.pendingDialog.type, message: this.pendingDialog.message } : undefined;
  }

  /** Click a ref that starts a download and wait for it to be saved. */
  async download(ref: string, opts: { guard?: Guard } = {}): Promise<DriverActResult> {
    const before = this.downloads.length;
    const r = await this.act(ref, 'click', { guard: opts.guard });
    if (r.outcome === 'refused' || r.outcome === 'failed') return r;
    const deadline = Date.now() + 15_000;
    while (this.downloads.length === before && Date.now() < deadline && !(r.notes ?? []).some((n) => /Download of/.test(n))) {
      await new Promise((res) => setTimeout(res, 100));
      if (this.pendingDownloads.length) await Promise.all(this.pendingDownloads.splice(0));
    }
    const got = this.downloads.slice(before);
    const notes = [...(r.notes ?? []), ...this.notes.splice(0)];
    if (!got.length) return { ...r, outcome: 'failed', errorCode: 'interaction_failed', notes, message: notes.find((n) => /Download/.test(n)) ?? 'clicking it did not start a download' };
    return { ...r, outcome: 'confirmed', notes };
  }

  // ------------------------------------------------------------ tabs, waits, extraction, verification

  async tabTitles(): Promise<{ title: string; url: string; active: boolean }[]> {
    const out: { title: string; url: string; active: boolean }[] = [];
    for (let i = 0; i < this.pages.length; i++) out.push({ title: this.mask(await this.pages[i].title().catch(() => '')), url: this.pages[i].url(), active: i === this.active });
    return out;
  }

  async tabs(op: 'list' | 'select' | 'new' | 'close', opts: { index?: number; url?: string } = {}): Promise<{ tabs: { title: string; url: string; active: boolean }[]; message?: string; nav?: NavResult }> {
    if (!this.launched) await this.ensureLaunched();
    if (op === 'select') {
      if (opts.index === undefined || !this.pages[opts.index]) throw new Error(`no tab ${opts.index}`);
      this.active = opts.index;
      await this.page.bringToFront().catch(() => undefined);
    } else if (op === 'new') {
      if (this.launched!.profile === 'extension') throw new Error('the extension cannot open tabs: ask the user to share one ("Share this tab with Tugline")');
      const p = await this.launched!.context.newPage();
      this.newPages = this.newPages.filter((x) => x !== p);
      if (this.launched!.attached && !this.opts.adoptExistingPages) await this.adoptOwnPage(p);
      else if (!this.pages.includes(p)) this.trackPage(p);
      this.active = this.pages.indexOf(p);
      if (opts.url) return { tabs: await this.tabTitles(), nav: await this.navigate(opts.url) };
    } else if (op === 'close') {
      const i = opts.index ?? this.active;
      const p = this.pages[i];
      if (!p) throw new Error(`no tab ${i}`);
      await p.close();
      if (!this.pages.length) this.trackPage(await this.launched!.context.newPage());
      this.active = Math.min(this.active, this.pages.length - 1);
    }
    return { tabs: await this.tabTitles() };
  }

  async wait(kind: 'text' | 'ref_gone' | 'url' | 'load' | 'time', value: string, timeoutMs = 10_000): Promise<{ ok: boolean; message: string }> {
    const page = this.page;
    const timeout = Math.min(Math.max(timeoutMs, 100), 60_000);
    try {
      if (kind === 'time') await page.waitForTimeout(Math.min(Number(value) || 1000, 10_000));
      else if (kind === 'load') await page.waitForLoadState((['load', 'domcontentloaded', 'networkidle'].includes(value) ? value : 'load') as any, { timeout });
      else if (kind === 'text') {
        const re = /^\/(.+)\/([a-z]*)$/.exec(value);
        await page.getByText(re ? new RegExp(re[1], re[2]) : value).first().waitFor({ state: 'visible', timeout });
      } else if (kind === 'ref_gone') await this.locate(value).waitFor({ state: 'detached', timeout });
      else if (kind === 'url') await page.waitForURL((u: URL) => u.toString().includes(value), { timeout });
      return { ok: true, message: `ok: ${kind} ${value}` };
    } catch (e) {
      return { ok: false, message: `timed out waiting for ${kind} ${value}: ${(e as Error).message.split('\n')[0]}` };
    }
  }

  async extract(mode: 'text' | 'markdown', opts: { scope?: string } = {}): Promise<{ title: string; url: string; content: string }> {
    const page = this.page;
    let content: string;
    const scopeLoc = opts.scope ? this.locate(opts.scope) : page.locator('body');
    if (mode === 'markdown') {
      const { htmlToMarkdown } = await import('../../tools/web.js');
      const html = opts.scope ? await scopeLoc.evaluate(pageFn('(el) => el.outerHTML'), null) : await page.content();
      content = htmlToMarkdown(String(html), page.url()).markdown;
    } else content = String(await scopeLoc.innerText({ timeout: 5000 }));
    return { title: this.mask(await page.title().catch(() => '')), url: page.url(), content: this.mask(content) };
  }

  async verify(checks: Expect[]): Promise<{ ok: boolean; failures: string[] }> {
    const s = await this.snapshot();
    const facts = await this.pageFacts();
    return evalAll(checks, { root: s.root, url: s.url, title: s.title, text: this.mask(`${treeText(s.root)}\n${facts.text}`), windows: await this.tabTitles() });
  }

  /** Remember an element filled from the vault and tag it, so captures can mask it. */
  private async markSecret(handle: any): Promise<void> {
    if (!handle) return;
    this.secretHandles.push(handle);
    await handle.evaluate(pageFn("(el) => el.setAttribute('data-oh-secret', '1')"), null).catch(() => undefined);
  }

  /**
   * Prepare a capture that may reach a model (vision, set-of-marks, OCR,
   * grounder): re-tag secret-filled fields (a page may strip the attribute),
   * refuse when a vault value is echoed elsewhere on the page, and return the
   * mask locators (secret fields and every password input, in every frame).
   */
  private async secretMasks(): Promise<any[]> {
    const page = this.page;
    const alive: any[] = [];
    for (const h of this.secretHandles) {
      const ok = await h.evaluate(pageFn("(el) => { if (!el.isConnected) return false; el.setAttribute('data-oh-secret', '1'); return true; }"), null).catch(() => false);
      if (ok) alive.push(h);
    }
    this.secretHandles = alive;
    const values = (this.opts.hooks?.secretValues?.() ?? []).filter((v) => v.length >= 4);
    if (values.length) {
      const fn = pageFn<void, { text: string; fields: string[] }>(
        "() => ({ text: document.body ? document.body.innerText : '', fields: [...document.querySelectorAll('input, textarea, select')].filter((el) => !el.hasAttribute('data-oh-secret') && (el.type || '') !== 'password').map((el) => String(el.value || '')) })",
      );
      for (const f of page.frames()) {
        const r = await f.evaluate(fn).catch(() => ({ text: '', fields: [] as string[] }));
        if (values.some((v) => r.text.includes(v) || r.fields.some((x: string) => x.includes(v))))
          throw new Error('screenshot withheld: the page shows a secret the harness typed somewhere other than the field it was typed into, so its pixels could reveal it. Use browser_snapshot (it masks secrets) or ask the human.');
      }
    }
    return page.frames().flatMap((f: any) => [f.locator('[data-oh-secret]'), f.locator('input[type=password]')]);
  }

  /** Captures for the model always mask secret-filled and password fields (solid black boxes). */
  async screenshot(opts: { scope?: string; marks?: boolean } = {}): Promise<{ png: Buffer; marks?: Mark[]; dpr: number; viewport: { width: number; height: number } }> {
    const page = this.page;
    const mask = await this.secretMasks();
    const shotOpts = { type: 'png', scale: 'css', mask, maskColor: '#000000' };
    const png: Buffer = opts.scope ? await this.locate(opts.scope).screenshot(shotOpts) : await page.screenshot(shotOpts);
    const vp = page.viewportSize() ?? { width: 1280, height: 800 };
    let marks: Mark[] | undefined;
    if (opts.marks) {
      const s = await this.snapshot();
      marks = markCandidates(s.root, vp);
    }
    return { png, marks, dpr: 1, viewport: vp };
  }

  /**
   * The snapshot ref of the single element a CSS selector matches (replay of
   * L2a recipes), or why there is none. Takes a fresh snapshot first so the ref
   * is current.
   */
  async refForSelector(selector: string): Promise<{ ref?: string; count: number }> {
    const loc = this.page.locator(selector);
    const count = await loc.count().catch(() => 0);
    if (count !== 1) return { count };
    await this.snapshot();
    let ref: string | undefined;
    if (this.engine === 'dom') ref = (await loc.getAttribute('data-oh-ref').catch(() => null)) ?? undefined;
    else {
      // A scoped ai-mode snapshot reports the element's own (page-stable) ref at its root.
      const j: any = await loc.ariaSnapshotJSON({ mode: 'ai' }).catch(() => undefined);
      const first = Array.isArray(j) ? j.find((x: any) => x && typeof x === 'object') : j;
      ref = first?.ref;
    }
    return { ref: ref && this.latest && refMap(this.latest.root).has(ref) ? ref : undefined, count };
  }

  // ------------------------------------------------------------ demonstration recording (N32)

  /** The browser context (the N32 recorder installs its listener on it). */
  get browserContext(): any {
    if (!this.launched) throw new Error('no browser is open');
    return this.launched.context;
  }

  /** A recent snapshot by id (the driver keeps the last few). */
  snapshotById(id: string): Snapshot | undefined {
    return this.snaps.find((s) => s.snap.id === id)?.snap;
  }

  /**
   * Tag the elements of the latest snapshot that have one of `roles` with
   * data-oh-demo="<snapshot id>:<ref>", so an in-page listener can name the
   * element a human acts on synchronously (before a click navigates away).
   */
  async tagInteractive(roles: Set<string>): Promise<number> {
    const snap = this.latest;
    if (!snap) return 0;
    const refs: string[] = [];
    walk(snap.root, (n) => {
      if (n.ref && roles.has(n.role)) refs.push(n.ref);
    });
    const tag = pageFn<string, void>("(el, v) => { el.setAttribute('data-oh-demo', v); }");
    const done = await Promise.all(refs.map((r) => this.locate(r).evaluate(tag, `${snap.id}:${r}`, { timeout: 1500 }).then(() => 1, () => 0)));
    return done.reduce((a: number, b: number) => a + b, 0);
  }

  /** Node for a ref in the latest snapshot (tools use it for policy context). */
  nodeFor(ref: string): UiNode | undefined {
    return this.latest ? findRef(this.latest.root, ref)?.node : undefined;
  }
}
