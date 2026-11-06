/**
 * Desktop recording replay (SPEC F8; research CU §5.7). Desktop steps are
 * recorded in the same trajectory format as the browser (E7): tool, args,
 * semantic key of the target, the window as `desktop://<app>/<title>`, the
 * expectation and the outcome. Strict replay needs no model: each step finds
 * its window again (app, then title), re-scans it, resolves the semantic key
 * (exactly one match, or the recorded position when the number of identical
 * elements is unchanged) and acts through the same scan-act-verify driver, so
 * recorded expectations are re-checked. A successful run becomes a regression
 * test (S10).
 */
import type { Expect } from '../types.js';
import { resolveKey } from '../snapshot/keys.js';
import type { TrajectoryStep } from '../recorder/trajectory.js';
import type { DesktopGuard, ScanActVerifyDriver } from './driver.js';
import type { RawWindow } from './backend.js';

export interface DesktopReplayResult {
  ok: boolean;
  steps: number;
  failure?: string;
  failedSeq?: number;
}

const SKIP = new Set(['desktop_snapshot', 'desktop_windows', 'desktop_screenshot', 'desktop_clipboard', 'desktop_electron']);

export function parseDesktopUrl(url: string | undefined): { app: string; title: string } | undefined {
  const m = url?.match(/^desktop:\/\/([^/]*)\/(.*)$/);
  return m ? { app: decodeURIComponent(m[1]), title: decodeURIComponent(m[2]) } : undefined;
}

async function findWindow(d: ScanActVerifyDriver, where: { app: string; title: string }): Promise<RawWindow | undefined> {
  const ws = await d.windows();
  const app = ws.filter((w) => w.app.toLowerCase() === where.app.toLowerCase());
  const hit = app.find((w) => w.title === where.title) ?? (app.length === 1 ? app[0] : undefined) ?? ws.find((w) => w.title === where.title);
  return hit ? d.windowById(hit.windowId) : undefined;
}

export async function replayDesktop(d: ScanActVerifyDriver, steps: TrajectoryStep[], o: { guard?: DesktopGuard; resolveSecret?: (ref: string) => Promise<string>; log?: (s: string) => void } = {}): Promise<DesktopReplayResult> {
  let count = 0;
  const fail = (s: TrajectoryStep, why: string): DesktopReplayResult => ({ ok: false, steps: count, failure: `step ${s.seq} (${s.tool}): ${why}`, failedSeq: s.seq });
  for (const step of steps) {
    if (SKIP.has(step.tool) || !step.tool.startsWith('desktop_')) continue;
    if (step.outcome === 'refused' || step.outcome === 'failed') continue; // the original run did not do it either
    const a = step.args as Record<string, any>;
    count++;
    if (step.tool === 'desktop_apps') {
      if (a.op === 'list') continue;
      const r = await d.apps(a.op, a.app);
      if (!r.ok) return fail(step, r.message ?? `${a.op} failed`);
      continue;
    }
    const where = parseDesktopUrl(step.url);
    if (!where) return fail(step, 'no recorded window');
    let win: RawWindow | undefined;
    for (let i = 0; i < 10 && !win; i++) {
      win = await findWindow(d, where);
      if (!win) await new Promise((r) => setTimeout(r, 200));
    }
    if (!win) return fail(step, `window ${where.app} "${where.title}" not found`);
    if (step.tool === 'desktop_verify') {
      const v = await d.verify(win.windowId, (a.checks ?? []) as Expect[]);
      if (!v.ok) return fail(step, `verify failed: ${v.failures.join('; ')}`);
      continue;
    }
    let ref: string | undefined;
    if (step.target?.key) {
      const fresh = await d.scan(win);
      const r = resolveKey(fresh.snap.root, step.target.key, { allowNth: true });
      if (!r.ok || !r.node.ref) return fail(step, `semantic key ${step.target.key.role} "${step.target.key.name}" is ${r.ok ? 'unrefd' : r.reason} (${r.ok ? 1 : r.candidates} candidates)`);
      ref = r.node.ref;
    } else await d.scan(win);
    const expect = step.expect;
    let r;
    if (step.tool === 'desktop_act') r = await d.act(ref!, a.action ?? 'press', { expect, guard: o.guard });
    else if (step.tool === 'desktop_set_value') {
      const value = a.secret && o.resolveSecret ? await o.resolveSecret(String(a.secret)) : String(a.value ?? '');
      r = await d.setValue(ref!, value, { expect, guard: o.guard });
    } else if (step.tool === 'desktop_type') r = await d.type(String(a.text ?? ''), { ref, windowId: win.windowId, expect, guard: o.guard });
    else if (step.tool === 'desktop_key') r = await d.key(String(a.keys), { windowId: win.windowId, expect, guard: o.guard });
    else if (step.tool === 'desktop_menu') r = await d.menu(String(a.app), a.path ?? [], { expect, guard: o.guard });
    else if (step.tool === 'desktop_scroll') r = await d.scroll({ ref, windowId: win.windowId }, a.direction ?? 'down', a.amount ?? 3, { guard: o.guard });
    else if (step.tool === 'desktop_point') r = await d.point(win.windowId, Number(a.x), Number(a.y), a.action ?? 'click', a.to, { expect, guard: o.guard });
    else continue;
    o.log?.(`step ${step.seq} ${step.tool}: ${r.outcome}`);
    if (r.outcome === 'failed' || r.outcome === 'refused') return fail(step, `${r.errorCode ?? r.outcome}: ${r.message ?? ''}`);
  }
  return { ok: true, steps: count };
}
