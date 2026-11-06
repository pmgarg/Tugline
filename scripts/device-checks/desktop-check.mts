/**
 * SPEC F1 AC2/AC3, F9 [DEVICE]: drive the real calculator on this machine through
 * the desktop driver, with no model: launch → snapshot → 7 × 8 = → verify 56.
 *
 *   node --import tsx scripts/device-checks/desktop-check.mts [--backend cua|sidecar|auto] [--app Calculator]
 *
 * macOS: needs cua-driver (pip install cua-driver) with Accessibility granted to CuaDriver.app.
 * Linux: cua-driver, or the AT-SPI sidecar (python3-gi, at-spi2-core, xdotool) and gnome-calculator.
 * Windows: cua-driver, or the PowerShell UIA sidecar and calc.exe.
 * Exit code 0 = PASS.
 */
import { createBackend } from '../../src/core/automation/desktop/session.js';
import { desktopConfig } from '../../src/core/automation/desktop/config.js';
import { ScanActVerifyDriver } from '../../src/core/automation/desktop/driver.js';
import { PreconditionError } from '../../src/core/automation/desktop/traps.js';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const app = arg('app', process.platform === 'darwin' ? 'Calculator' : process.platform === 'win32' ? 'calc' : 'gnome-calculator');
const cfg = desktopConfig({ desktop: { backend: arg('backend', 'auto') as any } });
const backend = createBackend(cfg);
const d = new ScanActVerifyDriver(backend, { settleMs: 300, log: (m) => console.log(`  note: ${m}`) });
const BUTTONS: Record<string, RegExp> = {
  clear: /^(AC|C|CE|clear|all clear|clear entry)$/i,
  '7': /^(7|seven)$/i,
  '×': /^(×|\*|x|multiply|multiplication|multiply by|times)$/i,
  '8': /^(8|eight)$/i,
  '=': /^(=|equals|equal|equals sign)$/i,
};
try {
  await backend.start();
  const h = await d.health();
  console.log(`backend ${backend.name} · health ${h.ok ? 'ok' : 'NOT OK'} ${h.version ?? ''} ${h.message ?? ''} ${JSON.stringify(h.permissions ?? {})}`);
  const l = await d.apps('launch', app);
  console.log(`launch ${app}: ${l.ok ? 'ok' : l.message}`);
  await new Promise((r) => setTimeout(r, 1500));
  const wins = await d.windows();
  const win = wins.find((w) => new RegExp(app.replace('gnome-', ''), 'i').test(`${w.app} ${w.title}`));
  if (!win) throw new Error(`no ${app} window among: ${wins.map((w) => `${w.app}/${w.title}`).join(', ')}`);
  const snap = await d.snapshot(win.windowId);
  console.log(`snapshot: ${snap.elementCount} elements`);
  const press = async (key: string) => {
    const stored = d.latest(win.windowId)!;
    const hit = [...stored.byRef.entries()].find(([, v]) => v.node.role === 'button' && BUTTONS[key].test((v.node.name ?? '').trim()));
    if (!hit) throw new Error(`no button for ${key} in:\n${stored.snap.tree}`);
    const r = await d.act(hit[0], 'press', key === '=' ? { expect: { text_present: '56' } } : {});
    console.log(`press ${key} (${hit[1].node.name}) → ${r.outcome}${r.diff ? ` · ${r.diff.replace(/\n/g, ' ')}` : ''}`);
    return r;
  };
  await press('clear').catch(() => undefined);
  for (const k of ['7', '×', '8']) await press(k);
  const r = await press('=');
  if (r.outcome !== 'confirmed') throw new Error(`7 × 8 did not show 56: ${r.message}`);
  console.log('PASS: 7 × 8 = 56 through the desktop driver');
  await d.close();
  process.exit(0);
} catch (e) {
  if (e instanceof PreconditionError) console.log(`FAIL: ${e.code} · cause_hint ${e.causeHint} · ${e.message}\n  next: ${e.remedy}`);
  else console.log(`FAIL: ${(e as Error).message}`);
  await d.close().catch(() => undefined);
  process.exit(1);
}
