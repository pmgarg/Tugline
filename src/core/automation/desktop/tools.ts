/**
 * Model-facing desktop tools (SPEC F2; research CU §5.2). Registered through
 * the tool-provider seam only when `desktop.enabled` is true (off by default).
 *
 * Text-only first: a window is an accessibility tree with `d` refs; every
 * mutating call is scan → guard → act → re-scan → diff → Expect and returns
 * `outcome` and `path`. Pixels (screenshot + OCR regions + desktop_point) are
 * the last resort (F6), Electron apps are driven through CDP (F5).
 *
 * Approval: every desktop action asks unless its app is listed in
 * `desktop.autoApproveApps` (or a permission allow rule matches). That holds in
 * auto mode too: desktop automation acts outside the workspace, which auto
 * mode does not cover, so in auto mode the tool asks the user itself.
 *
 * Accessibility text, window titles and OCR text are untrusted and wrapped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, type ToolContext, type ToolDef, type ToolOutput } from '../../tools/types.js';
import { registerToolProvider } from '../../tools/registry.js';
import { registerAgentExtension } from '../../agent/extensions.js';
import { ruleMatches } from '../../permissions/policy.js';
import { commandWrapperFor, registerSecretValues } from '../../tools/shell.js';
import type { BrowserAction, DesktopAction, Expect } from '../types.js';
import { validateExpect } from '../expect/evaluate.js';
import { withUntrustedMeta, wrapUntrusted } from '../../util/untrusted.js';
import { onKill } from '../policy/index.js';
import { perceptionConfig } from '../browser/config.js';
import { drawMarks, markCandidates } from '../perception/marks.js';
import { centre, ocrRegions, renderRegions } from '../perception/ocr.js';
import { ground } from '../perception/grounder.js';
import type { ActionKind, TargetInfo } from '../browser/driver.js';
import { appListed, desktopConfig } from './config.js';
import { PreconditionError } from './traps.js';
import { closeDesktopSession, getDesktopSession, noteDesktopTurn, peekDesktopSession, type DesktopSession } from './session.js';
import type { DesktopActResult, DesktopActionKind, ScanActVerifyDriver } from './driver.js';
import { BackendError, type RawWindow } from './backend.js';
import { ElectronBridge, detectElectron, relaunchWithDebugPort } from './electron.js';
import { selfProtectCheck } from './selfprotect.js';
import { stopFilePath, watchStopFile } from './killswitch.js';

// ------------------------------------------------------------ helpers

function session(ctx: ToolContext): DesktopSession {
  return getDesktopSession({ sessionId: ctx.sessionId, workspace: ctx.workspace, config: ctx.config, emit: ctx.emit, model: ctx.llm?.profile?.model, notice: (m) => ctx.emit({ type: 'notice', level: 'info', message: m }) });
}

function killedError(s: DesktopSession): void {
  const k = s.killed();
  if (!k.ok) throw new ToolError(`error_code: killed · ${k.message}. Do not retry; tell the user what you were doing.`);
}

async function driverOf(ctx: ToolContext): Promise<{ s: DesktopSession; d: ScanActVerifyDriver }> {
  const s = session(ctx);
  killedError(s);
  try {
    const d = await s.ensure();
    if (s.startWarnings.length) {
      for (const w of s.startWarnings.splice(0)) ctx.emit({ type: 'notice', level: 'warn', message: w });
    }
    return { s, d };
  } catch (e) {
    throw new ToolError(`error_code: ${(e as BackendError).code === 'killed' ? 'killed' : 'permission_denied'} · desktop backend unavailable: ${(e as Error).message}`);
  }
}

/** Accessibility, window-title, clipboard and OCR text is data, never instructions (shared wrapper, SPEC R3). */
function untrusted(source: string, body: string): string {
  return wrapUntrusted('desktop_content', { source }, body);
}

function checkExpect(e: unknown): Expect | undefined {
  if (e === undefined || e === null || e === '') return undefined;
  const err = validateExpect(e);
  if (err) throw new ToolError(`invalid expect: ${err}`);
  return e as Expect;
}

const isElectronRef = (ref: string | undefined) => !!ref && /^f?\d*e\d+$/.test(ref);

function appOf(ctx: ToolContext, a: { ref?: string; window_id?: string; app?: string }): string | undefined {
  return peekDesktopSession(ctx.sessionId)?.windowFor(a)?.app ?? a.app;
}

/** Permission input for a desktop action: ask (even where the mode would allow) unless the app is auto-approved. */
function askUnlessApproved(what: string) {
  return (a: { ref?: string; window_id?: string; app?: string }, ctx: ToolContext) => {
    const app = appOf(ctx, a);
    return appListed(app, desktopConfig(ctx.config).autoApproveApps) ? {} : { forceAsk: `${what}${app ? ` in "${app}"` : ''} (desktop automation acts in your real apps)` };
  };
}

/**
 * Yolo mode (the old classifier-less `auto`) lifts `forceAsk`; desktop actions still need a human unless the app
 * is auto-approved, the user allowed it for this session, or an allow rule matches.
 */
async function consent(ctx: ToolContext, s: DesktopSession, tool: string, app: string | undefined, title: string, opts: { point?: boolean } = {}): Promise<string | undefined> {
  if (ctx.policy.mode !== 'yolo') return undefined; // the permission engine already asked (or an allow rule / auto-approve matched)
  if (opts.point ? s.cfg.allowPoint : appListed(app, s.cfg.autoApproveApps)) return undefined;
  if (!opts.point && app && s.approvedApps.has(app.toLowerCase())) return undefined;
  if (ctx.policy.opts.allow.some((r) => ruleMatches(r, { tool, kind: 'execute' }, ctx.workspace))) return undefined;
  if (!ctx.askUser) return `error_code: needs_human · desktop actions${app ? ` in "${app}"` : ''} need your approval and no user is available (add the app to desktop.autoApproveApps to allow it)`;
  const sessionLabel = `Allow ${app ?? 'this app'} for this session`;
  const ans = await ctx.askUser(`Tugline wants to ${title}${app ? ` in "${app}"` : ''} on your desktop. Allow?`, opts.point ? ['Allow once', 'Deny'] : ['Allow once', sessionLabel, 'Deny']);
  const t = ans.trim().toLowerCase();
  if (t.startsWith('allow') && t.includes('session') && app) s.approvedApps.add(app.toLowerCase());
  if (/^(allow|yes|y\b|ok)/.test(t)) return undefined;
  return 'error_code: policy_denied · the user did not allow this desktop action. Do not retry it; ask the user how to proceed.';
}

function actOutput(s: DesktopSession, r: DesktopActResult, tool: string, extra: string[] = []): ToolOutput {
  const head = [`outcome: ${r.outcome}`, `path: ${r.path ?? 'L2b'}`];
  if (r.errorCode) head.push(`error_code: ${r.errorCode}`);
  if (r.causeHint) head.push(`cause_hint: ${r.causeHint}`);
  if (r.rebound) head.push('rebound: true');
  if (r.newSnapshotId) head.push(`snapshot: ${r.newSnapshotId}`);
  const lines = [head.join(' · '), ...extra];
  if (r.target?.role) lines.push(`target: ${r.target.role}${r.target.name ? ` "${r.target.name}"` : ''}${r.target.ref ? ` [ref=${r.target.ref}]` : ''} in ${r.target.app}`);
  const body: string[] = [];
  if (r.message) body.push(s.mask(r.message));
  for (const n of r.notes ?? []) body.push(n);
  if (r.diff !== undefined && r.outcome !== 'refused') body.push(r.diff ? `diff:\n${r.diff}` : 'diff: (no change in the window)');
  if (r.outcome === 'suspected_noop') lines.push('Nothing visible changed. Check with desktop_snapshot before retrying; do not repeat the same action blindly.');
  const src = r.target ? `${r.target.app} — ${r.target.window}` : 'desktop';
  return { output: [...lines, body.length ? untrusted(src, body.join('\n')) : ''].filter(Boolean).join('\n'), isError: r.outcome === 'failed' || r.outcome === 'refused', meta: { outcome: r.outcome, errorCode: r.errorCode, path: r.path ?? 'L2b', tool } };
}

function trapOutput(s: DesktopSession, e: PreconditionError, tool: string, win?: Partial<RawWindow>): ToolOutput {
  s.record(tool, {}, { path: 'L0', outcome: 'failed', errorCode: e.code }, { window: win });
  const lines = [`outcome: failed · path: L0 · error_code: ${e.code} · cause_hint: ${e.causeHint} · element_count: 0`, `why: ${e.message}`];
  if (e.applied) lines.push(`already tried: ${e.applied}`);
  lines.push(`next: ${e.remedy}`);
  return { output: lines.join('\n'), isError: true, meta: { errorCode: e.code, causeHint: e.causeHint, path: 'L0' } };
}

async function guarded<T>(s: DesktopSession, tool: string, fn: () => Promise<T>, win?: Partial<RawWindow>): Promise<T | ToolOutput> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PreconditionError) return trapOutput(s, e, tool, win);
    if (e instanceof BackendError) return { output: `outcome: failed · error_code: ${e.code === 'ref_not_found' ? 'ref_not_found' : e.code === 'timeout' ? 'timeout' : e.code === 'policy_denied' ? 'policy_denied' : 'interaction_failed'}\n${untrusted('desktop backend', s.mask(e.message))}`, isError: true };
    throw e;
  }
}

const isOutput = (x: unknown): x is ToolOutput => !!x && typeof x === 'object' && 'output' in (x as object) && !('outcome' in (x as object));

const EXPECT_SCHEMA = {
  type: 'object',
  description: 'Post-condition checked after the action (re-scan), e.g. {"text_present":"56"}, {"element_present":{"role":"dialog","name":"Save"}}, {"value_equals":{"ref":"d5","value":"x"}}, {"window_present":{"title_regex":"Export"}}. Required for destructive actions (delete/close/quit/discard/erase/send).',
};

// Electron (F5): `e` refs in a `cdp:<app>` window go to the BrowserDriver.
function bridgeFor(s: DesktopSession, a: { ref?: string; window_id?: string }): ElectronBridge | undefined {
  if (a.window_id?.startsWith('cdp:')) return s.electron.get(a.window_id);
  if (isElectronRef(a.ref)) {
    for (const b of s.electron.values()) if (b.driver.latest && JSON.stringify(b.driver.latest.root).includes(`"ref":"${a.ref}"`)) return b;
    return [...s.electron.values()][0];
  }
  return undefined;
}

function electronGuard(s: DesktopSession, b: ElectronBridge, hasExpect: boolean) {
  return async (t: TargetInfo | undefined, kind: ActionKind, action: string) => {
    const k: DesktopActionKind = kind === 'act' ? 'act' : kind === 'type' ? 'type' : kind === 'key' ? 'key' : 'point';
    return s.guard({ window: { windowId: b.windowId, app: b.app, title: b.app, pid: b.launched.proc?.pid }, ref: t?.ref, node: t?.node, key: t?.key, hasExpect }, k, action);
  };
}

function electronOutput(s: DesktopSession, b: ElectronBridge, r: any, tool: string): ToolOutput {
  const res: DesktopActResult = { ...r, target: r.target ? { ref: r.target.ref, role: r.target.role, name: r.target.name, key: r.target.semantic, window: b.app, app: b.app, windowId: b.windowId } : undefined, notes: r.notes, path: 'L2b' };
  s.record(tool, {}, res, { window: { app: b.app, title: b.windowId } });
  return actOutput(s, res, tool, ['via: CDP (Electron DOM)']);
}

// ------------------------------------------------------------ apps and windows

const desktopApps: ToolDef<{ op: 'list' | 'launch' | 'activate' | 'quit'; app?: string; expect?: Expect }> = {
  name: 'desktop_apps',
  core: true,
  kind: 'execute',
  description:
    'List running apps (op="list"), or launch / activate (bring to front) / quit an app by name or bundle id. Launch sets QT_ACCESSIBILITY=1 so Qt apps expose their UI. ' +
    'Quitting is destructive: pass expect (e.g. {"element_absent":{"name":"…"}} or a window check). Then desktop_windows and desktop_snapshot.',
  parameters: { type: 'object', properties: { op: { type: 'string', enum: ['list', 'launch', 'activate', 'quit'] }, app: { type: 'string', description: 'App name or bundle id' }, expect: EXPECT_SCHEMA }, required: ['op'] },
  title: (a) => (a.op === 'list' ? 'List desktop apps' : `${a.op} ${a.app}`),
  permissionInput: (a, ctx) => (a.op === 'list' ? {} : askUnlessApproved(`${a.op} an app`)({ app: a.app }, ctx)),
  validate: (a) => {
    if (a.op !== 'list' && !a.app) throw new ToolError(`op "${a.op}" needs app`);
  },
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    if (a.op === 'list') {
      const r = await d.apps('list');
      s.record('desktop_apps', a, { path: 'L1', outcome: 'confirmed' });
      return { output: untrusted('apps', (r.apps ?? []).map((x) => `${x.name}${x.pid !== undefined ? ` (pid ${x.pid})` : ''}${x.bundleId ? ` ${x.bundleId}` : ''}`).join('\n') || '(no apps)'), meta: { path: 'L1' } };
    }
    const app = String(a.app);
    const denied = await consent(ctx, s, 'desktop_apps', app, `${a.op} ${app}`);
    if (denied) return { output: denied, isError: true };
    const kind: DesktopActionKind = a.op === 'launch' ? 'launch' : a.op === 'activate' ? 'activate' : 'quit';
    const expect = checkExpect(a.expect);
    const known = d.windowById(app);
    const v = await s.guard({ window: { windowId: known?.windowId ?? `app:${app}`, app, title: known?.title ?? app, pid: known?.pid }, hasExpect: !!expect }, kind, `${a.op} ${app}`);
    if (!v.ok) {
      s.record('desktop_apps', a, { path: 'L2a', outcome: 'refused', errorCode: v.code }, { window: { app, title: app } });
      return { output: `outcome: refused · error_code: ${v.code}\n${v.message}`, isError: true };
    }
    const before = await d.windows().catch(() => []);
    const r = await d.apps(a.op, app);
    await new Promise((res) => setTimeout(res, s.cfg.settleMs));
    const after = await d.windows().catch(() => []);
    let outcome: DesktopActResult['outcome'] = r.ok ? 'confirmed' : 'failed';
    let msg = r.message ?? '';
    if (expect && r.ok) {
      const w = after.find((x) => x.app.toLowerCase() === app.toLowerCase());
      const res = w ? await d.verify(w.windowId, [expect]).catch(() => ({ ok: false, failures: ['window gone'] })) : { ok: 'element_absent' in expect || 'text_absent' in expect, failures: ['no window of the app'] };
      if (!res.ok) {
        outcome = 'failed';
        msg = `expectation not met: ${res.failures.join('; ')}`;
      }
    }
    const opened = after.filter((w) => !before.some((b) => b.windowId === w.windowId));
    const closed = before.filter((w) => !after.some((b) => b.windowId === w.windowId));
    const notes = [...opened.map((w) => `new window: ${w.windowId} ${w.app} "${w.title}"`), ...closed.map((w) => `window closed: ${w.windowId} ${w.app} "${w.title}"`)];
    s.record('desktop_apps', a, { path: 'L2a', outcome, errorCode: outcome === 'failed' ? 'interaction_failed' : undefined }, { expect, window: { app, title: app } });
    return { output: `outcome: ${outcome} · path: L2a\n${a.op} ${app}${msg ? `: ${s.mask(msg)}` : ''}${notes.length ? `\n${untrusted('windows', notes.join('\n'))}` : ''}\nNext: desktop_windows, then desktop_snapshot.`, isError: outcome !== 'confirmed' };
  },
};

const desktopWindows: ToolDef<{ app?: string }> = {
  name: 'desktop_windows',
  core: true,
  kind: 'read',
  readOnly: true,
  description: 'List open windows: window_id, app, title, focused. Pass app to filter. Use a window_id (or the app name) with desktop_snapshot.',
  parameters: { type: 'object', properties: { app: { type: 'string' } } },
  title: (a) => `List windows${a.app ? ` of ${a.app}` : ''}`,
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const ws = await d.windows(a.app);
    const lines = ws.map((w) => `${w.windowId} · ${w.app} · "${w.title}"${w.focused ? ' · focused' : ''}${w.pid !== undefined ? ` · pid ${w.pid}` : ''}${selfProtectCheck(w, s.cfg.denyApps).ok ? '' : ' · PROTECTED (the agent may not act here)'}`);
    for (const b of s.electron.values()) lines.push(`${b.windowId} · ${b.app} · "${await b.title()}" · via CDP (Electron DOM, refs eN)`);
    return { output: untrusted('windows', lines.join('\n') || '(no windows: launch an app with desktop_apps)') };
  },
};

const desktopSnapshot: ToolDef<{ window_id: string; query?: string; max_tokens?: number; scope?: string }> = {
  name: 'desktop_snapshot',
  core: true,
  kind: 'read',
  readOnly: true,
  description:
    'Read a window as an accessibility tree: `- role "name" [ref=d12] [state]`. Act on elements by ref (refs are valid for the latest snapshot of that window). ' +
    'window_id from desktop_windows (an app name also works). Pass query to filter large windows. An empty tree returns error_code empty_tree with a cause_hint and the next step.',
  parameters: { type: 'object', properties: { window_id: { type: 'string' }, query: { type: 'string' }, max_tokens: { type: 'integer' }, scope: { type: 'string', description: 'ref of a group to show alone' } }, required: ['window_id'] },
  title: (a) => `Desktop snapshot ${a.window_id}${a.query ? ` "${a.query}"` : ''}`,
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const b = bridgeFor(s, a);
    if (b) {
      const snap = await b.driver.snapshot({ query: a.query, maxTokens: a.max_tokens ?? s.cfg.snapshotTokens });
      s.record('desktop_snapshot', a, { path: 'L2b', outcome: 'confirmed' }, { window: { app: b.app, title: b.windowId } });
      return { output: `snapshot ${snap.id} · window ${b.windowId} (Electron via CDP) · ${snap.elementCount} elements · path: L2b${snap.truncated ? ' · truncated: true' : ''}\n${untrusted(`${b.app} (CDP)`, `title: ${snap.title}\n${snap.tree}`)}` };
    }
    const r = await guarded(s, 'desktop_snapshot', async () => {
      const win = await d.resolveWindow(String(a.window_id));
      const { stored, applied } = await d.scanChecked(win, { query: a.query, maxTokens: a.max_tokens, scope: a.scope });
      return { stored, applied, win };
    }, { app: a.window_id, title: a.window_id });
    if (isOutput(r)) return r;
    const { stored, applied } = r;
    const snap = stored.snap;
    s.record('desktop_snapshot', a, { path: 'L2b', outcome: 'confirmed' }, { window: stored.win });
    const protectedNote = selfProtectCheck(stored.win, s.cfg.denyApps).ok ? '' : '\nnote: this window belongs to the harness or a denied app; actions on it will be refused.';
    return {
      output: `snapshot ${snap.id} · window ${stored.win.windowId} · ${snap.elementCount} elements · path: L2b${snap.truncated ? ' · truncated: true' : ''}${applied ? `\nnote: empty tree at first (background launch): ${applied}` : ''}${protectedNote}\n${untrusted(snap.title ?? '', snap.tree ?? '')}`,
      meta: { snapshotId: snap.id, path: 'L2b' },
    };
  },
};

const desktopAct: ToolDef<{ ref: string; action?: DesktopAction; expect?: Expect }> = {
  name: 'desktop_act',
  core: true,
  kind: 'execute',
  description:
    'Act on one element by ref from the latest desktop_snapshot: action = press (default) | click | dblclick | right_click | focus | expand | select | toggle. ' +
    'Returns outcome (confirmed / suspected_noop / failed / refused) and a diff of what changed in the window. At most 2 actions per turn; menus and app switches must be alone.',
  parameters: { type: 'object', properties: { ref: { type: 'string', description: 'e.g. d12' }, action: { type: 'string', enum: ['press', 'click', 'dblclick', 'right_click', 'focus', 'expand', 'select', 'toggle'] }, expect: EXPECT_SCHEMA }, required: ['ref'] },
  title: (a) => `${a.action ?? 'press'} ${a.ref}`,
  permissionInput: (a, ctx) => askUnlessApproved(`${a.action ?? 'press'} ${a.ref}`)(a, ctx),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const expect = checkExpect(a.expect);
    const action = (a.action ?? 'press') as DesktopAction;
    const denied = await consent(ctx, s, 'desktop_act', appOf(ctx, a), `${action} ${a.ref}`);
    if (denied) return { output: denied, isError: true };
    const b = bridgeFor(s, a);
    if (b) {
      const map: Record<string, BrowserAction | undefined> = { press: 'click', click: 'click', expand: 'click', toggle: 'click', select: 'click', dblclick: 'dblclick', focus: 'focus', right_click: undefined };
      const ba = map[action];
      if (!ba) return { output: 'outcome: refused · error_code: interaction_failed\nright_click is not available through CDP; use click', isError: true };
      const r = await b.driver.act(String(a.ref), ba, { expect, guard: electronGuard(s, b, !!expect) });
      return electronOutput(s, b, r, 'desktop_act');
    }
    const r = await guarded(s, 'desktop_act', () => d.act(String(a.ref), action, { expect, guard: s.guard }));
    if (isOutput(r)) return r;
    s.record('desktop_act', a, r, { expect });
    return actOutput(s, r, 'desktop_act');
  },
};

const desktopSetValue: ToolDef<{ ref: string; value?: string; secret?: string; expect?: Expect }> = {
  name: 'desktop_set_value',
  kind: 'execute',
  description:
    'Set the value of a text field, slider or similar element directly (more reliable than typing). For passwords pass secret="secret://name": the harness fills it and you never see the value. ' +
    'Verified by re-reading the value unless the field is a password.',
  parameters: { type: 'object', properties: { ref: { type: 'string' }, value: { type: 'string' }, secret: { type: 'string', description: 'secret://name' }, expect: EXPECT_SCHEMA }, required: ['ref'] },
  title: (a) => `Set ${a.ref} = ${a.secret ?? JSON.stringify((a.value ?? '').slice(0, 40))}`,
  permissionInput: (a, ctx) => askUnlessApproved(`set the value of ${a.ref}`)(a, ctx),
  validate: (a) => {
    if (a.value === undefined && !a.secret) throw new ToolError('pass value or secret');
    if (a.secret && !/^secret:\/\//.test(a.secret)) throw new ToolError('secret must look like secret://name');
  },
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_set_value', appOf(ctx, a), `set the value of ${a.ref}`);
    if (denied) return { output: denied, isError: true };
    let value = a.value ?? '';
    if (a.secret) {
      value = await s.vault.resolve(a.secret);
      registerSecretValues([value]);
    }
    // A password field reads back as ••• (masked), so its value cannot be compared: verify only that it changed.
    const expect = checkExpect(a.expect) ?? (a.secret ? undefined : { value_equals: { ref: String(a.ref), value } });
    const r = await guarded(s, 'desktop_set_value', () => d.setValue(String(a.ref), value, { expect, guard: s.guard }));
    if (isOutput(r)) return r;
    if (a.secret && r.outcome !== 'refused') d.markSecret(String(a.ref));
    s.record('desktop_set_value', a.secret ? { ref: a.ref, secret: a.secret } : { ref: a.ref, value: s.mask(value) }, r, { expect: a.secret ? undefined : expect });
    return actOutput(s, r, 'desktop_set_value');
  },
};

const desktopType: ToolDef<{ text: string; ref?: string; window_id?: string; expect?: Expect }> = {
  name: 'desktop_type',
  core: true,
  kind: 'execute',
  description: 'Type text with the keyboard, into the element ref (focused first) or the given / last-snapshotted window. Prefer desktop_set_value for form fields. Never type passwords: use desktop_set_value with secret.',
  parameters: { type: 'object', properties: { text: { type: 'string' }, ref: { type: 'string' }, window_id: { type: 'string' }, expect: EXPECT_SCHEMA }, required: ['text'] },
  title: (a) => `Type ${JSON.stringify(a.text.slice(0, 40))}${a.ref ? ` into ${a.ref}` : ''}`,
  permissionInput: (a, ctx) => askUnlessApproved('type text')(a, ctx),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_type', appOf(ctx, a), `type ${JSON.stringify(a.text.slice(0, 40))}`);
    if (denied) return { output: denied, isError: true };
    const expect = checkExpect(a.expect);
    const b = bridgeFor(s, a);
    if (b) return electronOutput(s, b, await b.driver.type(String(a.text), { ref: a.ref, expect, guard: electronGuard(s, b, !!expect) }), 'desktop_type');
    const r = await guarded(s, 'desktop_type', () => d.type(String(a.text), { ref: a.ref, windowId: a.window_id, expect, guard: s.guard }));
    if (isOutput(r)) return r;
    s.record('desktop_type', { ...a, text: s.mask(a.text) }, r, { expect });
    return actOutput(s, r, 'desktop_type');
  },
};

const desktopKey: ToolDef<{ keys: string; window_id?: string; expect?: Expect }> = {
  name: 'desktop_key',
  kind: 'execute',
  description: 'Press a key or shortcut in a window: "Enter", "Escape", "Tab", "cmd+s", "ctrl+shift+t". Space-separated for a sequence ("Down Down Enter"). Shortcuts that close or quit (cmd+q, cmd+w, alt+f4) need expect.',
  parameters: { type: 'object', properties: { keys: { type: 'string' }, window_id: { type: 'string' }, expect: EXPECT_SCHEMA }, required: ['keys'] },
  title: (a) => `Press ${a.keys}`,
  permissionInput: (a, ctx) => askUnlessApproved(`press ${a.keys}`)(a, ctx),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_key', appOf(ctx, a), `press ${a.keys}`);
    if (denied) return { output: denied, isError: true };
    const expect = checkExpect(a.expect);
    const b = bridgeFor(s, a);
    if (b) return electronOutput(s, b, await b.driver.key(String(a.keys), { expect, guard: electronGuard(s, b, !!expect) }), 'desktop_key');
    const r = await guarded(s, 'desktop_key', () => d.key(String(a.keys), { windowId: a.window_id, expect, guard: s.guard }));
    if (isOutput(r)) return r;
    s.record('desktop_key', a, r, { expect });
    return actOutput(s, r, 'desktop_key');
  },
};

const desktopMenu: ToolDef<{ app: string; path: string[]; expect?: Expect }> = {
  name: 'desktop_menu',
  kind: 'execute',
  description: 'Invoke an application menu item by its path, e.g. app="TextEdit", path=["File","Export as PDF…"]. Deterministic and cheaper than clicking through menus. Must be the only action in its turn.',
  parameters: { type: 'object', properties: { app: { type: 'string' }, path: { type: 'array', items: { type: 'string' } }, expect: EXPECT_SCHEMA }, required: ['app', 'path'] },
  title: (a) => `Menu ${a.app}: ${(a.path ?? []).join(' > ')}`,
  permissionInput: (a, ctx) => askUnlessApproved(`invoke ${(a.path ?? []).join(' > ')}`)({ app: a.app }, ctx),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_menu', a.app, `invoke ${(a.path ?? []).join(' > ')}`);
    if (denied) return { output: denied, isError: true };
    const expect = checkExpect(a.expect);
    const r = await guarded(s, 'desktop_menu', () => d.menu(String(a.app), (a.path ?? []).map(String), { expect, guard: s.guard }));
    if (isOutput(r)) return r;
    const res = { ...r, path: 'L2a' as const };
    s.record('desktop_menu', a, res, { expect });
    return actOutput(s, res, 'desktop_menu');
  },
};

const desktopScroll: ToolDef<{ ref?: string; window_id?: string; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }> = {
  name: 'desktop_scroll',
  kind: 'execute',
  description: 'Scroll an element (ref) or a window (window_id): direction up|down|left|right, amount in steps (default 3).',
  parameters: { type: 'object', properties: { ref: { type: 'string' }, window_id: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer' } }, required: ['direction'] },
  title: (a) => `Scroll ${a.direction} ${a.ref ?? a.window_id ?? ''}`,
  permissionInput: (a, ctx) => askUnlessApproved('scroll')(a, ctx),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_scroll', appOf(ctx, a), `scroll ${a.direction}`);
    if (denied) return { output: denied, isError: true };
    const r = await guarded(s, 'desktop_scroll', () => d.scroll({ ref: a.ref, windowId: a.window_id }, a.direction ?? 'down', a.amount ?? 3, { guard: s.guard }));
    if (isOutput(r)) return r;
    s.record('desktop_scroll', a, r);
    return actOutput(s, r, 'desktop_scroll');
  },
};

const desktopVerify: ToolDef<{ window_id: string; checks: Expect[] }> = {
  name: 'desktop_verify',
  kind: 'read',
  readOnly: true,
  description: 'Check post-conditions on a window without acting: a list of Expect objects such as {"text_present":"56"}. Use it before reporting success.',
  parameters: { type: 'object', properties: { window_id: { type: 'string' }, checks: { type: 'array', items: { type: 'object' } } }, required: ['window_id', 'checks'] },
  title: (a) => `Verify ${a.window_id}`,
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const checks = (Array.isArray(a.checks) ? a.checks : [a.checks]).map(checkExpect).filter((x): x is Expect => !!x);
    if (!checks.length) throw new ToolError('checks must be a non-empty list of expectations');
    const b = bridgeFor(s, a);
    const r = b ? await b.driver.verify(checks) : await d.verify(String(a.window_id), checks);
    const win = b ? { app: b.app, title: b.windowId } : d.windowById(String(a.window_id));
    s.record('desktop_verify', a, { path: 'L2b', outcome: r.ok ? 'confirmed' : 'failed', errorCode: r.ok ? undefined : 'verify_failed' }, { window: win });
    return { output: r.ok ? 'ok: all checks passed' : `not ok:\n${untrusted(String(a.window_id), r.failures.map((f) => `- ${s.mask(f)}`).join('\n'))}`, isError: !r.ok, meta: { ok: r.ok } };
  },
};

const desktopClipboard: ToolDef<{ op: 'read' | 'write'; text?: string }> = {
  name: 'desktop_clipboard',
  kind: 'execute',
  description: 'Read or write the system clipboard (op="read" | "write" with text). A cheap L1 way to get text out of an app (copy, then read).',
  parameters: { type: 'object', properties: { op: { type: 'string', enum: ['read', 'write'] }, text: { type: 'string' } }, required: ['op'] },
  title: (a) => (a.op === 'read' ? 'Read clipboard' : 'Write clipboard'),
  permissionInput: (a) => ({ forceAsk: a.op === 'read' ? 'reads your clipboard, which may hold passwords or private text' : 'replaces your clipboard' }),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_clipboard', undefined, a.op === 'read' ? 'read your clipboard' : 'write your clipboard');
    if (denied) return { output: denied, isError: true };
    const k = s.killed();
    if (!k.ok) return { output: `outcome: refused · error_code: killed\n${k.message}`, isError: true };
    const r = await d.clipboard(a.op, a.text);
    s.record('desktop_clipboard', { op: a.op }, { path: 'L1', outcome: 'confirmed' });
    return { output: a.op === 'read' ? untrusted('clipboard', s.mask(r.text ?? '')) : 'clipboard written' };
  },
};

// ------------------------------------------------------------ L3: screenshot and point (F6)

const desktopScreenshot: ToolDef<{ window_id?: string; marks?: boolean }> = {
  name: 'desktop_screenshot',
  kind: 'read',
  description:
    'Look at a window\'s pixels, for apps whose accessibility tree is empty (canvas, games, remote desktops). Vision models get the image (marks=true numbers elements with their refs). ' +
    'Text-only models get numbered OCR text regions like [r2] "Submit" (x,y w×h) when perception is configured; click one with desktop_point {"window_id":…,"region":"r2"}.',
  parameters: { type: 'object', properties: { window_id: { type: 'string' }, marks: { type: 'boolean' } } },
  title: (a) => `Screenshot ${a.window_id ?? 'screen'}`,
  // A whole-display capture can show any app (mail, password managers): a human approves it in every mode, auto included.
  permissionInput: (a) => (a.window_id ? {} : { forceAsk: 'captures your whole screen', alwaysAsk: 'captures your whole screen (every app on it), so a human approves it in every permission mode' }),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const k = s.killed();
    if (!k.ok) return { output: `outcome: refused · error_code: killed\n${k.message}`, isError: true };
    const win = a.window_id ? await d.resolveWindow(String(a.window_id)).catch(() => undefined) : undefined;
    if (a.window_id && !win) throw new ToolError(`no window ${a.window_id}`);
    if (win) {
      const sp = selfProtectCheck(win, s.cfg.denyApps);
      if (!sp.ok) return { output: `outcome: refused · error_code: ${sp.code}\n${sp.message}`, isError: true };
    }
    let shot: { png: Buffer; scale?: number; masked: number };
    try {
      shot = await d.maskedScreenshot(win?.windowId, s.vault.usedValues());
    } catch (e) {
      return { output: `outcome: refused · error_code: policy_denied\n${(e as Error).message}`, isError: true };
    }
    const scale = shot.scale ?? 1;
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
    const file = path.join(ctx.artifactsDir, `desktop-${Date.now()}.png`);
    const src = win ? `${win.app} — ${win.title}` : 'screen';
    if (ctx.vision) {
      const latest = win ? d.latest(win.windowId) : undefined;
      const marks = a.marks && latest ? markCandidates(latest.snap.root) : [];
      const png = marks.length ? drawMarks(shot.png, marks, scale) : shot.png;
      fs.writeFileSync(file, png);
      s.record('desktop_screenshot', a, { path: 'L3', outcome: 'confirmed' }, { window: win });
      const legend = marks.length ? `\nmarks:\n${untrusted(src, marks.map((m) => `${m.ref} ${m.role ?? ''} "${s.mask(m.name ?? '')}"`).join('\n'))}` : '';
      return { output: `screenshot attached (window-relative coordinates; ${scale} px per point) · saved ${path.relative(ctx.workspace, file)} · path: L3${legend}`, images: [{ mimeType: 'image/png', base64: png.toString('base64') }], meta: { path: 'L3', file } };
    }
    fs.writeFileSync(file, shot.png);
    const p = perceptionConfig(ctx.config);
    if (p.backend === 'ocr') {
      const regions = await ocrRegions(shot.png, { command: p.ocr?.command, lang: p.ocr?.lang, omniparserUrl: p.ocr?.omniparserUrl, wrap: commandWrapperFor(ctx.config), workDir: ctx.artifactsDir });
      for (const r of regions) r.text = s.mask(r.text);
      s.regions = { windowId: win?.windowId, regions, scale };
      s.record('desktop_screenshot', a, { path: 'L3', outcome: 'confirmed' }, { window: win });
      return { output: `OCR text regions (${regions.length}) · path: L3 · click one with desktop_point {"window_id":"${win?.windowId ?? ''}","region":"rN"}\n${untrusted(src, renderRegions(regions))}`, meta: { path: 'L3', regions: regions.length } };
    }
    if (p.backend === 'grounder') return { output: 'This model has no vision. A grounding model is configured: call desktop_point with "instruction" describing the target (e.g. "the green Submit button") and it will be located. path: L3', meta: { path: 'L3' } };
    return { output: `This model has no vision and no perception backend is configured (perception.backend "ocr" or "grounder"), so the screenshot cannot be described. Saved to ${path.relative(ctx.workspace, file)}.`, isError: true };
  },
};

const desktopPoint: ToolDef<{ window_id: string; region?: string; instruction?: string; x?: number; y?: number; action?: 'click' | 'dblclick' | 'right_click' | 'drag_to'; to?: [number, number]; expect?: Expect }> = {
  name: 'desktop_point',
  kind: 'execute',
  description:
    'L3 pixel action in a window, for things the accessibility tree cannot target: region (an OCR region id from desktop_screenshot), instruction (with a grounding model), or x,y window-relative points (vision models). ' +
    'Always asks first unless desktop.allowPoint; must be alone in its turn; verified by re-scanning. Prefer refs whenever the element is in the snapshot.',
  parameters: {
    type: 'object',
    properties: { window_id: { type: 'string' }, region: { type: 'string' }, instruction: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, action: { type: 'string', enum: ['click', 'dblclick', 'right_click', 'drag_to'] }, to: { type: 'array', items: { type: 'number' } }, expect: EXPECT_SCHEMA },
    required: ['window_id'],
  },
  title: (a) => `Point ${a.region ?? a.instruction ?? `${a.x},${a.y}`} in ${a.window_id}`,
  permissionInput: (a, ctx) => (desktopConfig(ctx.config).allowPoint ? {} : { forceAsk: `pixel ${a.action ?? 'click'} in "${appOf(ctx, a) ?? a.window_id}" (L3: the target is not in the accessibility tree)` }),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const denied = await consent(ctx, s, 'desktop_point', appOf(ctx, a), `${a.action ?? 'click'} at ${a.region ?? a.instruction ?? `${a.x},${a.y}`}`, { point: true });
    if (denied) return { output: denied, isError: true };
    const expect = checkExpect(a.expect);
    const win = await d.resolveWindow(String(a.window_id));
    let x: number;
    let y: number;
    let how: string;
    if (a.region) {
      const lr = s.regions;
      const r = lr?.regions.find((q) => q.id === a.region);
      if (!r || (lr?.windowId && lr.windowId !== win.windowId)) throw new ToolError(`unknown region ${a.region} for this window: call desktop_screenshot {"window_id":"${win.windowId}"} first and use an id from its list`);
      const [cx, cy] = centre(r.box);
      [x, y] = [cx / (lr!.scale || 1), cy / (lr!.scale || 1)];
      how = `region ${r.id} "${r.text}"`;
    } else if (a.instruction) {
      const p = perceptionConfig(ctx.config);
      if (p.backend !== 'grounder' || !p.grounder) throw new ToolError('no grounding model is configured (perception.backend = "grounder")');
      let shot: { png: Buffer; scale?: number };
      try {
        shot = await d.maskedScreenshot(win.windowId, s.vault.usedValues());
      } catch (e) {
        return { output: `outcome: refused · error_code: policy_denied\n${(e as Error).message}`, isError: true };
      }
      try {
        const g = await ground(p.grounder, shot.png, a.instruction);
        [x, y] = [g.x / (shot.scale ?? 1), g.y / (shot.scale ?? 1)];
        how = `grounded "${a.instruction}"${g.zoomed ? ' (zoomed)' : ''}`;
      } catch (e) {
        return { output: `outcome: failed · error_code: vlm_unavailable\n${(e as Error).message}`, isError: true };
      }
    } else if (typeof a.x === 'number' && typeof a.y === 'number') {
      if (!ctx.vision && !s.cfg.allowPoint) throw new ToolError('raw coordinates need a vision model (or desktop.allowPoint); use an OCR region id instead');
      [x, y] = [a.x, a.y];
      how = `(${x},${y})`;
    } else throw new ToolError('give region, instruction, or x and y');
    const r = await guarded(s, 'desktop_point', () => d.point(win.windowId, Math.round(x), Math.round(y), a.action ?? 'click', a.to, { expect, guard: s.guard }));
    if (isOutput(r)) return r;
    s.record('desktop_point', { ...a, x: Math.round(x), y: Math.round(y) }, r, { expect, window: win });
    const out = actOutput(s, r, 'desktop_point');
    return { ...out, output: `${how} → (${Math.round(x)},${Math.round(y)}) in window ${win.windowId}\n${out.output}` };
  },
};

// ------------------------------------------------------------ Electron (F5)

const desktopElectron: ToolDef<{ app: string }> = {
  name: 'desktop_electron',
  kind: 'execute',
  description:
    'For an Electron/Chromium app whose snapshot is one opaque web area (cause_hint electron_opaque): with the user\'s consent, quit and relaunch it with a local debugging port and attach to its DOM. ' +
    'Afterwards the app appears as window "cdp:<app>": desktop_snapshot shows its DOM with refs eN, and desktop_act / desktop_type / desktop_key work on them.',
  parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
  title: (a) => `Relaunch ${a.app} with a debugging port`,
  permissionInput: (a) => ({ forceAsk: `quit and relaunch "${a.app}" with a local debugging port (unsaved work in it may be lost)` }),
  async run(a, ctx) {
    const { s, d } = await driverOf(ctx);
    const app = String(a.app);
    const existing = s.electron.get(`cdp:${app}`);
    if (existing) return { output: `already attached: window cdp:${app}. Use desktop_snapshot {"window_id":"cdp:${app}"}.` };
    const info = (await d.apps('list')).apps?.find((x) => x.name.toLowerCase() === app.toLowerCase());
    const raw = (await s.backend!.listApps()).find((x) => x.name.toLowerCase() === app.toLowerCase());
    const sp = selfProtectCheck({ app, pid: info?.pid, title: app }, s.cfg.denyApps);
    if (!sp.ok) return { output: `outcome: refused · error_code: ${sp.code}\n${sp.message}`, isError: true };
    if (!detectElectron(raw ?? { name: app }, s.cfg.electronApps) && !s.cfg.electronPaths[app]) return { output: `outcome: refused · error_code: policy_denied\n${app} does not look like an Electron app (add it to desktop.electronApps if it is).`, isError: true };
    // F5 AC2: consent is required, in every permission mode, once per app per session.
    if (s.electronConsent.get(app) === undefined) {
      if (!ctx.askUser) return { output: 'error_code: needs_human · relaunching an app needs your consent and no user is available', isError: true };
      const ans = await ctx.askUser(`Relaunch ${app} with a local debugging port so Tugline can drive its UI? ${app} will quit first (unsaved work may be lost) and will be closed again when this session ends.`, ['Relaunch', 'Deny']);
      s.electronConsent.set(app, /^(relaunch|allow|yes|y)\b/i.test(ans.trim()));
    }
    if (!s.electronConsent.get(app)) return { output: `error_code: policy_denied · the user did not allow relaunching ${app}`, isError: true };
    const v = await s.guard({ window: { windowId: `cdp:${app}`, app, title: app, pid: info?.pid }, hasExpect: true }, 'launch', `relaunch ${app}`);
    if (!v.ok) return { output: `outcome: refused · error_code: ${v.code}\n${v.message}`, isError: true };
    if (info) await d.apps('quit', app).catch(() => undefined);
    try {
      const launched = await relaunchWithDebugPort({ app, exe: s.cfg.electronPaths[app] ?? raw?.path, args: s.cfg.electronLaunchArgs[app] });
      const b = new ElectronBridge(app, launched, { homeDir: ctx.config.homeDir, mask: s.mask, secretValues: () => s.vault.usedValues(), snapshotTokens: s.cfg.snapshotTokens });
      await b.attach();
      s.electron.set(b.windowId, b);
      const snap = await b.driver.snapshot({ maxTokens: s.cfg.snapshotTokens });
      s.record('desktop_electron', a, { path: 'L2a', outcome: 'confirmed' }, { window: { app, title: b.windowId } });
      return { output: `outcome: confirmed · attached to ${app} through CDP at ${launched.cdpUrl.replace(/\d+$/, '…')} (127.0.0.1 only) · window cdp:${app}\n${untrusted(`${app} (CDP)`, `title: ${snap.title}\n${snap.tree}`)}` };
    } catch (e) {
      return { output: `outcome: failed · error_code: interaction_failed\ncould not relaunch ${app} with a debugging port: ${(e as Error).message}`, isError: true };
    }
  },
};

export const DESKTOP_TOOLS: ToolDef[] = [desktopApps, desktopWindows, desktopSnapshot, desktopAct, desktopSetValue, desktopType, desktopKey, desktopMenu, desktopScroll, desktopVerify, desktopScreenshot, desktopPoint, desktopClipboard, desktopElectron];
const MUTATING = new Set(['desktop_act', 'desktop_set_value', 'desktop_type', 'desktop_key', 'desktop_menu', 'desktop_scroll', 'desktop_apps']);

// G2: accessibility text, OCR and screenshots taint the session (meta.untrusted)
const PROVIDED_TOOLS = DESKTOP_TOOLS.map(withUntrustedMeta);

registerToolProvider({
  id: 'desktop',
  tools: (cfg, env) => (desktopConfig(cfg).enabled && env.depth === 0 ? PROVIDED_TOOLS : []),
});

// ------------------------------------------------------------ loop integration

/** Runs with desktop tools, aborted by the kill switch. */
const runningAgents = new Map<string, { abort(): void }>();
const runStopWatch = new Map<string, () => void>();
onKill(() => {
  for (const a of runningAgents.values()) {
    try {
      a.abort();
    } catch {
      /* best effort */
    }
  }
});

registerAgentExtension({
  id: 'desktop',
  onRunStart: (a) => {
    const cfg = desktopConfig(a.config);
    if (!cfg.enabled) return;
    const ag = a.agent as { abort?: () => void };
    if (typeof ag?.abort === 'function') runningAgents.set(`${a.sessionId}:${a.depth}`, ag as { abort(): void });
    // Watch the STOP file for the whole run, not only while a desktop call is in flight.
    runStopWatch.get(a.sessionId)?.();
    runStopWatch.set(a.sessionId, watchStopFile(stopFilePath(a.config.homeDir, cfg.stopFile), cfg.stopPollMs));
  },
  beforeTurn: (a, turn) => {
    noteDesktopTurn(a.sessionId, turn);
  },
  approve: (a, q) => {
    if (!q.tool.startsWith('desktop_')) return undefined;
    const args = (q.args ?? {}) as { op?: string; ref?: string; window_id?: string; app?: string };
    if (q.tool === 'desktop_apps' && args.op === 'list') return { decision: 'allow', by: 'desktop', reason: 'listing apps changes nothing' };
    if (!MUTATING.has(q.tool)) return undefined;
    const app = peekDesktopSession(a.sessionId)?.windowFor(args)?.app ?? args.app;
    if (appListed(app, desktopConfig(a.config).autoApproveApps)) return { decision: 'allow', by: 'desktop.autoApproveApps', reason: `${app} is auto-approved` };
    return undefined;
  },
  onRunEnd: (a) => {
    runningAgents.delete(`${a.sessionId}:${a.depth}`);
    runStopWatch.get(a.sessionId)?.();
    runStopWatch.delete(a.sessionId);
    const s = peekDesktopSession(a.sessionId);
    if (!s?.recorder?.steps.length) return;
    s.recorder.flushMeta({ endedAt: new Date().toISOString() });
    a.notice('info', `desktop path stats: ${s.stats().text} · trajectory ${s.recorder.file}`);
    a.journal({ type: 'automation_stats', surface: 'desktop', pathStats: s.stats().stats, trajectory: s.recorder.file });
  },
  onSessionEnd: async (a) => {
    await closeDesktopSession(a.sessionId);
  },
});
