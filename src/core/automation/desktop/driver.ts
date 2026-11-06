/**
 * DesktopDriver (SPEC F1, F3, F4): the scan-act-verify executor over a backend.
 *
 * The interface itself (`DesktopDriver`: apps, windows, snapshot, act,
 * setValue, type, key, menu, scroll, clipboard, screenshot, point, verify,
 * health) is the shared contract in `automation/types.ts`; this module
 * implements it once for every backend (cua-driver, sidecars, sandbox).
 *
 * Normalisation: native AX / UIA / AT-SPI elements become the shared UiNode
 * tree with ARIA roles and `d`-prefixed refs, rendered by the same renderer
 * as the browser (pruning, budget, query, masking).
 *
 * Refs: a ref stays the same across snapshots while its element keeps its
 * semantic key (role|name|nth|landmark) and its group of identical siblings
 * keeps its size, so diffs show only real changes. Backend tokens are scoped
 * to one snapshot (S10 invariants 1–2) and never reach the model. A ref that
 * is not in the window's latest snapshot is stale: it is rebound only when its
 * key matches exactly one element of a fresh scan, otherwise refused.
 *
 * Every mutating call: resolve → policy guard → act → settle → re-scan →
 * diff → Expect. Without an expect, "nothing changed" is `suspected_noop`, not
 * success (S10: a click that reports success does not prove intent).
 */
import crypto from 'node:crypto';
import type { ActResult, DesktopAction, DesktopDriver, DesktopWindow, Expect, Snapshot, SnapshotOptions, UiNode } from '../types.js';
import { renderTree } from '../snapshot/render.js';
import { lineDiff } from '../snapshot/diff.js';
import { LANDMARK_ROLES, isInteractive, walk } from '../snapshot/tree.js';
import { resolveKey, semanticKey, type SemanticKey } from '../snapshot/keys.js';
import { maskPasswords } from '../snapshot/mask.js';
import { evalAll, evalExpect } from '../expect/evaluate.js';
import type { PolicyVerdict } from '../policy/index.js';
import { BackendError, type BackendHealth, type DesktopBackend, type ElementAction, type RawActResult, type RawApp, type RawElement, type RawWindow, type RawWindowState } from './backend.js';
import { ariaRole, isSecureField } from './roles.js';
import { decodePng, encodePng } from '../perception/png.js';
import { PreconditionError, actionableCount, diagnoseEmpty } from './traps.js';

export type { DesktopDriver } from '../types.js';

export type DesktopActionKind = 'act' | 'set_value' | 'type' | 'key' | 'menu' | 'scroll' | 'point' | 'launch' | 'activate' | 'quit';

export interface DesktopTarget {
  window: RawWindow;
  ref?: string;
  node?: UiNode;
  key?: SemanticKey;
  /** Destructive-check context: the call carries an expect. */
  hasExpect?: boolean;
}

export type DesktopGuard = (t: DesktopTarget, kind: DesktopActionKind, action: string) => PolicyVerdict | Promise<PolicyVerdict>;

export interface DesktopActResult extends ActResult {
  target?: { ref?: string; role?: string; name?: string; key?: SemanticKey; window: string; app: string; windowId: string };
  notes?: string[];
  preHash?: string;
  windowId?: string;
}

export interface DesktopDriverOptions {
  snapshotTokens?: number;
  maxRepeated?: number;
  maxTextChars?: number;
  settleMs?: number;
  activationWaitMs?: number;
  electronApps?: string[];
  mask?: (s: string) => string;
  platform?: NodeJS.Platform;
  /** Notices from the driver (auto-remedies applied). */
  log?: (msg: string) => void;
}

interface Stored {
  snap: Snapshot;
  full: string;
  raw: RawWindowState;
  win: RawWindow;
  byRef: Map<string, { node: UiNode; raw?: RawElement }>;
  keys: Map<string, SemanticKey>;
}

interface WinRefs {
  /** "role|name|landmark" → refs in document order (the group). */
  groups: Map<string, string[]>;
  latest?: Stored;
}

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function landmarkOf(anc: UiNode[]): string {
  for (let i = anc.length - 1; i >= 0; i--) if (LANDMARK_ROLES.has(anc[i].role)) return `${anc[i].role}:${anc[i].name ?? ''}`;
  return '';
}

const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'progressbar', 'meter', 'scrollbar']);

/** Native flat elements → UiNode tree (no refs yet). */
export function buildTree(state: RawWindowState): UiNode {
  const nodes = new Map<number, UiNode>();
  const toNode = (e: RawElement): UiNode => {
    let role = ariaRole(e.role);
    // AT-SPI calls an editable entry "text"; only the editable state tells it from a label.
    if (e.editable && (role === 'statictext' || role === 'generic')) role = 'textbox';
    const n: UiNode = { role, handle: e };
    const states: string[] = [];
    if (role === 'statictext') {
      const t = (e.name || e.value || '').trim();
      if (t) n.name = t;
    } else {
      if (e.name) n.name = e.name.trim();
      if (e.value !== undefined && e.value !== null && e.value !== '' && (VALUE_ROLES.has(role) || !['button', 'checkbox', 'radio', 'switch', 'menuitem', 'tab'].includes(role))) n.value = String(e.value);
    }
    if (e.description && !n.name) n.placeholder = e.description;
    if (e.enabled === false) states.push('disabled');
    if (e.selected) states.push('selected');
    if (e.checked === true) states.push('checked');
    if (e.expanded === true) states.push('expanded');
    else if (e.expanded === false && ['combobox', 'menuitem', 'button', 'treeitem'].includes(role)) states.push('expanded=false');
    if (e.focused) states.push('focused');
    if (isSecureField(e.role)) states.push('password');
    if (!isInteractive({ role }) && e.actions?.some((a) => /press|click|activate|invoke|toggle/i.test(a))) states.push('clickable');
    if (states.length) n.states = states;
    if (e.box) n.box = { ...e.box };
    return n;
  };
  for (const e of state.elements) nodes.set(e.index, toNode(e));
  const root: UiNode = { role: 'window', name: state.window.title || state.window.app, children: [] };
  let windowEl: UiNode | undefined;
  for (const e of state.elements) {
    const n = nodes.get(e.index)!;
    const parent = e.parent !== undefined ? nodes.get(e.parent) : undefined;
    if (parent) (parent.children ??= []).push(n);
    else if (n.role === 'window' && !windowEl) windowEl = n;
    else root.children!.push(n);
  }
  if (windowEl) {
    // The backend's own window element is the root; keep any orphans under it.
    windowEl.name = windowEl.name || root.name;
    windowEl.children = [...(windowEl.children ?? []), ...root.children!];
    return windowEl;
  }
  return root;
}

export class ScanActVerifyDriver implements DesktopDriver {
  private wins = new Map<string, RawWindow>();
  private refs = new Map<string, WinRefs>();
  /** Every ref ever handed out → its window, so an old ref is "stale", not "unknown". */
  private refWindow = new Map<string, string>();
  private counter = 0;
  private snapSeq = 0;
  private lastWindowId?: string;
  private appsCache?: RawApp[];
  /** The semantic key each ref had in the last snapshot that contained it (stale-ref rebinding). */
  private keyHistory = new Map<string, SemanticKey>();
  private healthCache?: BackendHealth;

  constructor(readonly backendImpl: DesktopBackend, readonly opts: DesktopDriverOptions = {}) {}

  get backend(): string {
    return this.backendImpl.name;
  }

  get lastWindow(): RawWindow | undefined {
    return this.lastWindowId ? this.wins.get(this.lastWindowId) : undefined;
  }

  /** The window a ref belongs to (sync; no backend call). */
  windowOfRef(ref: string): RawWindow | undefined {
    const w = this.refWindow.get(ref);
    return w ? this.wins.get(w) : undefined;
  }

  windowById(id: string): RawWindow | undefined {
    return this.wins.get(id) ?? [...this.wins.values()].find((w) => w.app.toLowerCase() === id.toLowerCase());
  }

  latest(windowId: string): Stored | undefined {
    return this.refs.get(windowId)?.latest;
  }

  private mask(s: string): string {
    return this.opts.mask ? this.opts.mask(s) : s;
  }

  // ------------------------------------------------------------ apps and windows

  async health(): Promise<{ ok: boolean; version?: string; permissions?: Record<string, boolean>; message?: string }> {
    this.healthCache = await this.backendImpl.health();
    return this.healthCache;
  }

  async apps(op: 'list' | 'launch' | 'activate' | 'quit', app?: string): Promise<{ apps?: { name: string; pid?: number; bundleId?: string }[]; ok: boolean; message?: string }> {
    if (op === 'list') {
      this.appsCache = await this.backendImpl.listApps();
      return { ok: true, apps: this.appsCache.map((a) => ({ name: a.name, pid: a.pid, bundleId: a.bundleId })) };
    }
    if (!app) return { ok: false, message: `op "${op}" needs an app name` };
    // Every launch sets QT_ACCESSIBILITY=1 so Qt apps expose a tree (the S10 Qt trap never happens for apps we start).
    const r = op === 'launch' ? await this.backendImpl.launch(app, { env: { QT_ACCESSIBILITY: '1' } }) : op === 'activate' ? await this.backendImpl.activate({ app }) : await this.backendImpl.quit({ app });
    this.appsCache = undefined;
    return { ok: r.ok, message: r.message };
  }

  async windows(app?: string): Promise<DesktopWindow[]> {
    const ws = await this.backendImpl.listWindows(app);
    for (const w of ws) this.wins.set(w.windowId, w);
    return ws.map((w) => ({ windowId: w.windowId, app: w.app, title: w.title, focused: !!w.focused, pid: w.pid, bounds: w.bounds }));
  }

  /** A window id, or an app name / title (its frontmost window): forgiving for small models. */
  async resolveWindow(idOrApp: string): Promise<RawWindow> {
    const hit = this.wins.get(idOrApp);
    if (hit) return hit;
    await this.windows();
    const again = this.wins.get(idOrApp);
    if (again) return again;
    const q = idOrApp.toLowerCase();
    const all = [...this.wins.values()];
    const byApp = all.filter((w) => w.app.toLowerCase() === q);
    const pick = byApp.find((w) => w.focused) ?? byApp[0] ?? all.find((w) => w.title.toLowerCase() === q) ?? all.find((w) => w.title.toLowerCase().includes(q));
    if (!pick) throw new BackendError(`no window "${idOrApp}": call desktop_windows to list them (launch the app with desktop_apps first)`, 'ref_not_found');
    return pick;
  }

  async appInfo(win: RawWindow): Promise<RawApp | undefined> {
    if (!this.appsCache) this.appsCache = await this.backendImpl.listApps().catch(() => []);
    return this.appsCache.find((a) => (win.pid !== undefined && a.pid === win.pid) || a.name.toLowerCase() === win.app.toLowerCase());
  }

  // ------------------------------------------------------------ snapshots

  /** One scan of a window → normalised, ref-assigned, rendered, stored as the window's latest. */
  async scan(win: RawWindow, opts: SnapshotOptions = {}): Promise<Stored> {
    const raw = await this.backendImpl.windowState(win.windowId);
    const w = { ...win, ...raw.window, windowId: win.windowId };
    this.wins.set(w.windowId, w);
    const root = buildTree({ ...raw, window: w });
    maskPasswords(root);
    const wr: WinRefs = this.refs.get(w.windowId) ?? { groups: new Map() };
    this.refs.set(w.windowId, wr);
    // Group nodes by role|name|landmark in document order.
    const groups = new Map<string, UiNode[]>();
    walk(root, (n, anc) => {
      if ((n.role === 'statictext' || n.role === 'text') && !n.states?.includes('clickable')) return;
      const g = `${n.role}|${n.name ?? ''}|${landmarkOf(anc)}`;
      const list = groups.get(g) ?? [];
      list.push(n);
      groups.set(g, list);
    });
    const nextGroups = new Map<string, string[]>();
    for (const [g, nodes] of groups) {
      const prev = wr.groups.get(g);
      // Reuse refs only when the group of identical elements kept its size; otherwise
      // positions shifted and an old ref could silently point at a different element.
      const refs = prev && prev.length === nodes.length ? prev : nodes.map(() => `d${++this.counter}`);
      nodes.forEach((n, i) => {
        n.ref = refs[i];
        this.refWindow.set(refs[i], w.windowId);
      });
      nextGroups.set(g, refs);
    }
    wr.groups = nextGroups;
    const byRef = new Map<string, { node: UiNode; raw?: RawElement }>();
    walk(root, (n) => void (n.ref && byRef.set(n.ref, { node: n, raw: n.handle as RawElement | undefined })));
    const keys = new Map<string, SemanticKey>();
    for (const ref of byRef.keys()) {
      const k = semanticKey(root, ref);
      if (k) keys.set(ref, k);
    }
    const full = renderTree(root, { maxTokens: 0, maxRepeated: 10_000, maxTextChars: this.opts.maxTextChars ?? 160, mask: (s) => this.mask(s) }).text;
    const shown = renderTree(root, { maxTokens: opts.maxTokens ?? this.opts.snapshotTokens ?? 4000, query: opts.query, scopeRef: opts.scope, maxRepeated: this.opts.maxRepeated ?? 20, maxTextChars: this.opts.maxTextChars ?? 160, includeBoxes: opts.includeBoxes, mask: (s) => this.mask(s) });
    let count = 0;
    walk(root, (n) => void ((isInteractive(n) || ((n.role === 'statictext' || n.role === 'text') && n.name)) && n !== root && count++));
    const snap: Snapshot = {
      id: `ds${++this.snapSeq}`,
      surface: 'desktop',
      windowId: w.windowId,
      title: `${w.app} — ${w.title}`,
      root,
      tree: shown.text,
      truncated: shown.truncated,
      elementCount: raw.degraded ? Math.min(count, actionableCount(raw.elements)) : count,
      hash: sha(full),
      takenAt: Date.now(),
    };
    const stored: Stored = { snap, full, raw, win: w, byRef, keys };
    wr.latest = stored;
    for (const [ref, k] of keys) this.keyHistory.set(ref, k);
    this.lastWindowId = w.windowId;
    return stored;
  }

  /**
   * Scan with trap diagnosis (F4): an empty tree is diagnosed; `not_activated`
   * runs the activation helper, waits and re-scans once; anything else (or a
   * second empty scan) raises a PreconditionError with the cause hint.
   */
  async scanChecked(win: RawWindow, opts: SnapshotOptions = {}): Promise<{ stored: Stored; applied?: string }> {
    let stored = await this.scan(win, opts);
    let applied: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (stored.snap.elementCount > 0 && !stored.raw.degraded) return { stored, applied };
      const health = this.healthCache ?? (await this.backendImpl.health().catch(() => undefined));
      const app = await this.appInfo(stored.win);
      const d = diagnoseEmpty({ window: stored.win, elements: stored.raw.elements, degraded: stored.raw.degraded, degradedReason: stored.raw.degradedReason, health, app, toolkit: stored.raw.toolkit, platform: this.opts.platform ?? process.platform, electronApps: this.opts.electronApps, activated: !!applied });
      if (d.autoActivate && !applied) {
        const r = await this.backendImpl.activate({ app: stored.win.app, pid: stored.win.pid, windowId: stored.win.windowId });
        applied = `activated ${stored.win.app}${r.ok ? '' : ` (activation helper: ${r.message ?? 'failed'})`}, waited ${this.opts.activationWaitMs ?? 500} ms and re-scanned`;
        this.opts.log?.(`desktop: ${stored.win.app} had an empty tree (background launch); ${applied}`);
        await sleep(this.opts.activationWaitMs ?? 500);
        stored = await this.scan(stored.win, opts);
        continue;
      }
      throw new PreconditionError(d.code, d.cause, d.message, d.remedy, applied);
    }
    return { stored, applied };
  }

  async snapshot(windowId: string, opts: SnapshotOptions = {}): Promise<Snapshot> {
    const win = await this.resolveWindow(windowId);
    return (await this.scanChecked(win, opts)).stored.snap;
  }

  // ------------------------------------------------------------ target resolution

  private async resolveRef(ref: string): Promise<{ stored: Stored; node: UiNode; raw?: RawElement; rebound: boolean } | ActResultLike> {
    const wid = this.refWindow.get(ref);
    if (!wid) return { outcome: 'refused', errorCode: 'ref_not_found', message: `no element ${ref}: refs come from desktop_snapshot (take one first)` };
    const wr = this.refs.get(wid);
    const latest = wr?.latest;
    const hit = latest?.byRef.get(ref);
    if (latest && hit) return { stored: latest, node: hit.node, raw: hit.raw, rebound: false };
    // Stale: the ref is not in the window's latest snapshot. Rebind only on a unique key match.
    const key = this.keyFor(ref);
    const win = this.wins.get(wid);
    if (!key || !win) return { outcome: 'refused', errorCode: 'stale_ref', message: `${ref} is from an older snapshot and can no longer be identified. Take a fresh desktop_snapshot.` };
    const fresh = await this.scan(win);
    const r = resolveKey(fresh.snap.root, key);
    if (r.ok && r.node.ref) {
      const h = fresh.byRef.get(r.node.ref)!;
      return { stored: fresh, node: h.node, raw: h.raw, rebound: true };
    }
    return { outcome: 'refused', errorCode: 'stale_ref', message: `${ref} (${key.role} "${key.name}") is stale: ${r.ok ? 'it has no ref' : r.reason === 'ambiguous' ? `${r.candidates} elements now match it` : 'it is gone'}. Take a fresh desktop_snapshot and pick again.` };
  }

  private keyFor(ref: string): SemanticKey | undefined {
    return this.keyHistory.get(ref);
  }

  // ------------------------------------------------------------ scan-act-verify

  private async mutate(
    kind: DesktopActionKind,
    action: string,
    target: { ref?: string; windowId?: string },
    run: (win: RawWindow, el: RawElement | undefined) => Promise<RawActResult>,
    o: { expect?: Expect; guard?: DesktopGuard; retryStale?: boolean },
  ): Promise<DesktopActResult> {
    let stored: Stored | undefined;
    let node: UiNode | undefined;
    let raw: RawElement | undefined;
    let rebound = false;
    if (target.ref) {
      const r = await this.resolveRef(target.ref);
      if ('outcome' in r) return r as DesktopActResult;
      ({ stored, node, raw, rebound } = r);
    } else {
      const win = target.windowId ? await this.resolveWindow(target.windowId) : this.lastWindow;
      if (!win) return { outcome: 'refused', errorCode: 'ref_not_found', message: 'no target window: pass window_id (from desktop_windows) or take a desktop_snapshot first' };
      stored = this.latest(win.windowId) ?? (await this.scan(win));
    }
    const win = stored.win;
    const key = node?.ref ? stored.keys.get(node.ref) : undefined;
    const tinfo = { ref: node?.ref, role: node?.role, name: node?.name ? this.mask(node.name) : undefined, key, window: win.title, app: win.app, windowId: win.windowId };
    if (o.guard) {
      const v = await o.guard({ window: win, ref: node?.ref, node, key, hasExpect: !!o.expect }, kind, action);
      if (!v.ok) return { outcome: 'refused', errorCode: v.code, message: v.message, target: tinfo, windowId: win.windowId };
    }
    const preWins = await this.backendImpl.listWindows().catch(() => [] as RawWindow[]);
    let res: RawActResult;
    try {
      res = await run(win, raw);
    } catch (e) {
      res = { ok: false, effect: 'failed', code: (e as BackendError).code ?? 'interaction_failed', message: (e as Error).message };
    }
    if (!res.ok && res.code === 'stale_element_token' && node?.ref && o.retryStale !== false) {
      // The app changed since our scan: re-scan and retry once if the key is still unique.
      const fresh = await this.scan(win);
      const r = key ? resolveKey(fresh.snap.root, key) : undefined;
      if (r?.ok && r.node.ref) {
        rebound = true;
        stored = fresh;
        const h = fresh.byRef.get(r.node.ref)!;
        try {
          res = await run(win, h.raw);
        } catch (e) {
          res = { ok: false, effect: 'failed', code: 'interaction_failed', message: (e as Error).message };
        }
      } else return { outcome: 'refused', errorCode: 'stale_ref', message: `the element changed since the snapshot and ${r && !r.ok ? `${r.candidates} elements now match` : 'it cannot be found again'}; take a fresh desktop_snapshot`, target: tinfo, windowId: win.windowId };
    }
    if (!res.ok) {
      const refused = res.effect === 'refused' || /permission|refused|denied/.test(res.code ?? '');
      return { outcome: refused ? 'refused' : 'failed', errorCode: /permission/.test(res.code ?? '') ? 'permission_denied' : refused ? 'policy_denied' : 'interaction_failed', message: res.message ?? res.code, target: tinfo, rebound, windowId: win.windowId, preHash: stored.snap.hash };
    }
    await sleep(this.opts.settleMs ?? 150);
    return this.verifyAfter(stored, res, o.expect, { rebound, target: tinfo, preWins });
  }

  /** VERIFY: always re-scan; diff; evaluate the expectation. */
  private async verifyAfter(pre: Stored, res: RawActResult, expect: Expect | undefined, x: { rebound: boolean; target: DesktopActResult['target']; preWins: RawWindow[] }): Promise<DesktopActResult> {
    const notes: string[] = [];
    let post: Stored | undefined;
    const postWins = await this.backendImpl.listWindows().catch(() => [] as RawWindow[]);
    for (const w of postWins) this.wins.set(w.windowId, w);
    const opened = postWins.filter((w) => !x.preWins.some((p) => p.windowId === w.windowId));
    const closed = x.preWins.filter((p) => !postWins.some((w) => w.windowId === p.windowId));
    for (const w of opened) notes.push(`new window: ${w.windowId} ${w.app} "${this.mask(w.title)}"`);
    for (const w of closed) notes.push(`window closed: ${w.windowId} ${w.app} "${this.mask(w.title)}"`);
    const stillOpen = !closed.some((w) => w.windowId === pre.win.windowId);
    if (stillOpen) {
      try {
        post = await this.scan(pre.win);
      } catch (e) {
        notes.push(`re-scan failed: ${(e as Error).message}`);
      }
    }
    const d = post ? lineDiff(pre.full, post.full) : { text: '', changed: false };
    const changed = d.changed || opened.length > 0 || closed.length > 0;
    let outcome: DesktopActResult['outcome'];
    let errorCode: DesktopActResult['errorCode'];
    let message: string | undefined;
    if (expect) {
      const r = post
        ? evalExpect(expect, { root: post.snap.root, title: post.snap.title, windows: postWins.map((w) => ({ title: `${w.app} — ${w.title}` })) })
        : evalExpect(expect, { root: { role: 'window' }, windows: postWins.map((w) => ({ title: `${w.app} — ${w.title}` })) });
      outcome = r.ok ? 'confirmed' : 'failed';
      if (!r.ok) {
        errorCode = 'verify_failed';
        message = `expectation not met: ${r.detail}`;
      }
    } else if (changed) outcome = 'confirmed';
    else {
      outcome = 'suspected_noop';
      message = res.effect === 'confirmed' ? 'the driver reported success, but nothing changed in the window' : undefined;
    }
    if (res.message && res.effect !== 'confirmed') notes.push(this.mask(res.message));
    return { outcome, errorCode, message, diff: d.text, newSnapshotId: post?.snap.id, rebound: x.rebound || undefined, path: 'L2b', target: x.target, notes, preHash: pre.snap.hash, windowId: pre.win.windowId };
  }

  async act(ref: string, action: DesktopAction, opts: { expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    return this.mutate('act', action, { ref }, (w, el) => this.backendImpl.act(w, el!, action as ElementAction), opts);
  }

  async setValue(ref: string, value: string, opts: { expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    return this.mutate('set_value', 'set_value', { ref }, (w, el) => this.backendImpl.setValue(w, el!, value), opts);
  }

  async type(text: string, opts: { ref?: string; windowId?: string; expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    return this.mutate('type', 'type', { ref: opts.ref, windowId: opts.windowId }, (w, el) => this.backendImpl.typeText(w, el, text), opts);
  }

  async key(keys: string, opts: { windowId?: string; expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    return this.mutate('key', keys, { windowId: opts.windowId }, (w) => this.backendImpl.pressKey(w, keys), opts);
  }

  async menu(app: string, path: string[], opts: { expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    const win = await this.resolveWindow(app);
    return this.mutate('menu', path.join(' > '), { windowId: win.windowId }, (w) => this.backendImpl.menu(app, path, w), opts);
  }

  async scroll(target: { ref?: string; windowId?: string }, direction: 'up' | 'down' | 'left' | 'right', amount = 3, opts: { guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    return this.mutate('scroll', direction, target, (w, el) => this.backendImpl.scroll(w, el, direction, amount), opts);
  }

  async point(windowId: string, x: number, y: number, action: 'click' | 'dblclick' | 'right_click' | 'drag_to', to?: [number, number], opts: { expect?: Expect; guard?: DesktopGuard } = {}): Promise<DesktopActResult> {
    const r = await this.mutate('point', action, { windowId }, (w) => this.backendImpl.pointer(w, x, y, action, to), opts);
    return { ...r, path: 'L3' };
  }

  async verify(windowId: string, checks: Expect[]): Promise<{ ok: boolean; failures: string[] }> {
    const win = await this.resolveWindow(windowId);
    const s = await this.scan(win);
    const wins = await this.backendImpl.listWindows().catch(() => [] as RawWindow[]);
    return evalAll(checks, { root: s.snap.root, title: s.snap.title, windows: wins.map((w) => ({ title: `${w.app} — ${w.title}` })) });
  }

  async screenshot(windowId?: string): Promise<{ png: Buffer; scale?: number }> {
    const win = windowId ? await this.resolveWindow(windowId) : undefined;
    return this.backendImpl.screenshot(win);
  }

  /** Elements filled from secret:// refs, by window (their semantic keys survive re-scans). */
  private secretKeys = new Map<string, SemanticKey[]>();

  markSecret(ref: string): void {
    const w = this.refWindow.get(ref);
    const k = this.keyHistory.get(ref);
    if (!w || !k) return;
    const list = this.secretKeys.get(w) ?? [];
    list.push(k);
    this.secretKeys.set(w, list);
  }

  /**
   * A capture that may reach a model (vision, OCR, grounder): password fields
   * and fields the harness filled from the vault are painted solid black, and
   * the capture is withheld when a vault value shows anywhere else in the window
   * (or, for a whole-screen capture, whenever a secret was used at all), because
   * its pixels could reveal it. Mirrors the browser's screenshot masking (E8).
   */
  async maskedScreenshot(windowId: string | undefined, secretValues: string[]): Promise<{ png: Buffer; scale?: number; masked: number }> {
    const values = secretValues.filter((v) => v && v.length >= 4);
    if (!windowId) {
      if (values.length) throw new BackendError('screenshot withheld: a secret was typed in this session and a whole-screen capture cannot mask it. Capture one window (window_id) instead.', 'policy_denied');
      return { ...(await this.backendImpl.screenshot()), masked: 0 };
    }
    const win = await this.resolveWindow(windowId);
    const fresh = await this.scan(win);
    const boxes: NonNullable<UiNode['box']>[] = [];
    const secretNodes = new Set<UiNode>();
    for (const k of this.secretKeys.get(win.windowId) ?? []) {
      const r = resolveKey(fresh.snap.root, k, { allowNth: true });
      if (r.ok) secretNodes.add(r.node);
    }
    walk(fresh.snap.root, (n) => {
      if (n.states?.includes('password') || secretNodes.has(n)) {
        if (n.box) boxes.push(n.box);
        secretNodes.add(n);
      }
    });
    if (values.length) {
      for (const e of fresh.raw.elements) {
        const node = [...fresh.byRef.values()].find((x) => x.raw === e)?.node;
        if (node && secretNodes.has(node)) continue;
        const text = `${e.name ?? ''}\n${e.value ?? ''}\n${e.description ?? ''}`;
        if (values.some((v) => text.includes(v))) throw new BackendError('screenshot withheld: the window shows a secret the harness typed somewhere other than the field it was typed into, so its pixels could reveal it. Use desktop_snapshot (it masks secrets) or ask the human.', 'policy_denied');
      }
    }
    const shot = await this.backendImpl.screenshot(win);
    if (!boxes.length) return { ...shot, masked: 0 };
    let img;
    try {
      img = decodePng(shot.png);
    } catch {
      throw new BackendError('screenshot withheld: it is not a PNG the harness can mask, and the window has password or secret fields', 'policy_denied');
    }
    const sc = shot.scale ?? 1;
    for (const b of boxes) {
      const x0 = Math.max(0, Math.floor(b.x * sc));
      const y0 = Math.max(0, Math.floor(b.y * sc));
      const x1 = Math.min(img.width, Math.ceil((b.x + b.width) * sc));
      const y1 = Math.min(img.height, Math.ceil((b.y + b.height) * sc));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set([0, 0, 0, 255], (y * img.width + x) * 4);
    }
    return { png: encodePng(img), scale: shot.scale, masked: boxes.length };
  }

  async clipboard(op: 'read' | 'write', text?: string): Promise<{ text?: string }> {
    return this.backendImpl.clipboard(op, text);
  }

  async close(): Promise<void> {
    await this.backendImpl.shutdown();
  }
}

type ActResultLike = DesktopActResult;
