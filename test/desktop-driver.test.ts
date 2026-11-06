/**
 * WS6 driver-level tests: the CuaDriverAdapter against the fake cua-driver MCP
 * server (F1), scan-act-verify (F3), trap diagnosis (F4), the pixel fallback
 * with real OCR (F6), rate limits and self-protection (F7), the Linux AT-SPI
 * sidecar under Xvfb (F9) and the Docker sandbox (F10).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CuaDriverBackend } from '../src/core/automation/desktop/cua.js';
import { ScanActVerifyDriver } from '../src/core/automation/desktop/driver.js';
import { PreconditionError } from '../src/core/automation/desktop/traps.js';
import { DesktopSession, setDesktopBackendFactory } from '../src/core/automation/desktop/session.js';
import { SidecarBackend, LINUX_SIDECAR, findGiPython, sandboxSidecarCommand } from '../src/core/automation/desktop/sidecar.js';
import type { DesktopBackend, RawElement, RawWindow, RawWindowState } from '../src/core/automation/desktop/backend.js';
import { sandboxUp, sandboxDown } from '../src/core/automation/desktop/commands.js';
import { ocrRegions, centre } from '../src/core/automation/perception/ocr.js';
import { resetKillSwitch } from '../src/core/automation/policy/index.js';
import { testConfig, tmpWorkspace } from './helpers.js';

const FAKE = path.resolve('test/fixtures/fake-cua-driver.mjs');
const CANVAS = path.resolve('test/fixtures/desktop-canvas.png');
const ROOT = path.resolve('.');
const started: { close(): Promise<void> }[] = [];

after(async () => {
  for (const d of started) await d.close().catch(() => undefined);
});

async function fake(flags: string[] = [], opts: { pin?: string; settleMs?: number } = {}) {
  const b = new CuaDriverBackend({ command: process.execPath, args: [FAKE, ...flags], versionPin: opts.pin ?? '0.37', timeoutMs: 15_000 });
  await b.start();
  const d = new ScanActVerifyDriver(b, { settleMs: opts.settleMs ?? 0, activationWaitMs: 500 });
  started.push(d);
  return { b, d };
}

function refOf(tree: string, re: RegExp): string {
  const line = tree.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  if (!line) throw new Error(`no ${re} in:\n${tree}`);
  return line.match(/\[ref=(\w+)\]/)![1];
}

// ------------------------------------------------------------ F1

test('F1 AC1: CuaDriverAdapter against the fake cua-driver MCP server (health, apps, windows, tree, act, stale token, version pin, shutdown)', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cua-')), 'calls.jsonl');
  const { b, d } = await fake([`--log=${log}`]);
  const h = await d.health();
  assert.equal(h.ok, true);
  assert.equal(h.version, '0.37.0');
  assert.deepEqual(h.permissions, { accessibility: true, screen_recording: true });
  const apps = await d.apps('list');
  assert.ok(apps.apps!.some((a) => a.name === 'Calculator' && a.bundleId === 'com.apple.calculator'));
  const wins = await d.windows();
  assert.deepEqual(wins.map((w) => [w.windowId, w.app]), [['1001', 'Calculator'], ['2001', 'Notes']]);
  const snap = await d.snapshot('Calculator'); // an app name resolves to its window
  assert.equal(snap.surface, 'desktop');
  assert.equal(snap.windowId, '1001');
  assert.match(snap.tree!, /- window "Calculator":/);
  assert.match(snap.tree!, /button "7" \[ref=d\d+\]/);
  assert.match(snap.tree!, /statictext "0"/);
  // Backend tokens never reach the model.
  assert.doesNotMatch(snap.tree!, /t\d+-\d+/);
  const r = await d.act(refOf(snap.tree!, /button "7"/), 'press');
  assert.equal(r.outcome, 'confirmed');
  assert.equal(r.diff, '- statictext "0"\n+ statictext "7"');
  // The adapter sent element_token + pid + window_id (the advertised schema), and get_window_state without a screenshot.
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const click = calls.find((c) => c.tool === 'click');
  assert.deepEqual(Object.keys(click.args).sort(), ['element_token', 'pid', 'window_id']);
  assert.equal(calls.find((c) => c.tool === 'get_window_state').args.include_screenshot, false);
  // Tokens are snapshot-scoped in the driver: an old token is refused by cua-driver itself.
  const old = d.latest('1001')!.raw.elements.find((e) => e.name === '8')!;
  await d.scan(d.windowById('1001')!);
  const stale = await b.act(d.windowById('1001')!, old, 'press');
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale_element_token');
  // Version pin mismatch is reported at start.
  const { d: d2 } = await fake([], { pin: '9.9' });
  const h2 = await d2.health();
  assert.match(h2.message ?? '', /does not match the pinned desktop\.cuaDriverVersion 9\.9/);
  // Shutdown ends the child process.
  const pid = b.pid!;
  await d.close();
  await new Promise((res) => setTimeout(res, 100));
  assert.throws(() => process.kill(pid, 0));
});

test('F1 AC2: a Linux cua-driver build scanned and clicked (DEVICE / pending-env)', { skip: 'cua-driver 0.37.0 ships a Linux wheel, but running the downloaded third-party binary was refused in this container; scripts/device-checks/desktop-linux.sh runs it on a user machine' }, () => {});

// ------------------------------------------------------------ F3

test('F3 AC1 (driver): a click the app ignores is detected as suspected_noop, and a retry is confirmed', async () => {
  const { d } = await fake(['--ignore-clicks=1']);
  const snap = await d.snapshot('1001');
  const seven = refOf(snap.tree!, /button "7"/);
  const r1 = await d.act(seven, 'press');
  assert.equal(r1.outcome, 'suspected_noop');
  assert.match(r1.message ?? '', /reported success, but nothing changed/);
  const r2 = await d.act(seven, 'press');
  assert.equal(r2.outcome, 'confirmed');
});

/** In-process scriptable backend: element lists can change between scans; tokens are snapshot-scoped. */
class ScriptedBackend implements DesktopBackend {
  readonly name = 'scripted';
  elements: Omit<RawElement, 'token' | 'index'>[] = [];
  private snap = 0;
  clicks: string[] = [];
  win: RawWindow = { windowId: 'w1', app: 'Dialogs', title: 'Dialogs', pid: 999_999_999, focused: true, onScreen: true };
  async start() {}
  async health() {
    return { ok: true };
  }
  async listApps() {
    return [{ name: 'Dialogs', pid: 999_999_999 }];
  }
  async listWindows() {
    return [this.win];
  }
  async windowState(): Promise<RawWindowState> {
    this.snap++;
    return { window: this.win, elements: this.elements.map((e, i) => ({ ...e, index: i, token: `${this.snap}:${i}` })) };
  }
  private check(el: RawElement) {
    return el.token?.split(':')[0] === String(this.snap) ? undefined : { ok: false, effect: 'failed' as const, code: 'stale_element_token', message: 'stale' };
  }
  async act(_w: RawWindow, el: RawElement) {
    const bad = this.check(el);
    if (bad) return bad;
    this.clicks.push(el.name ?? '');
    if (el.name === 'OK') this.elements = this.elements.filter((e) => e.name !== 'Pending');
    return { ok: true, effect: 'confirmed' as const };
  }
  async launch() {
    return { ok: true };
  }
  async activate() {
    return { ok: true };
  }
  async quit() {
    return { ok: true };
  }
  async setValue() {
    return { ok: true };
  }
  async typeText() {
    return { ok: true };
  }
  async pressKey() {
    return { ok: true };
  }
  async menu() {
    return { ok: true };
  }
  async scroll() {
    return { ok: true };
  }
  async pointer() {
    return { ok: true };
  }
  async screenshot() {
    return { png: Buffer.alloc(0) };
  }
  async clipboard() {
    return {};
  }
  async shutdown() {}
}

test('F3 AC3: a stale element token is rebound only when its key is unique, otherwise refused (stale_ref)', async () => {
  const b = new ScriptedBackend();
  b.elements = [{ role: 'AXWindow', name: 'Dialogs' }, { role: 'AXStaticText', name: 'Pending', parent: 0 }, { role: 'AXButton', name: 'OK', parent: 0 }, { role: 'AXButton', name: 'Cancel', parent: 0 }];
  const d = new ScanActVerifyDriver(b, { settleMs: 0 });
  const snap = await d.snapshot('w1');
  const ok = refOf(snap.tree!, /button "OK"/);
  // (a) The app re-rendered behind our back: the token is stale but "OK" is still unique → rebound and confirmed.
  await b.windowState(); // invalidates our tokens, like another get_window_state would
  const r1 = await d.act(ok, 'press');
  assert.equal(r1.outcome, 'confirmed');
  assert.equal(r1.rebound, true);
  assert.deepEqual(b.clicks, ['OK']);
  // (b) Now two "Cancel" buttons exist and our token is stale → refused, nothing clicked.
  const cancel = refOf(d.latest('w1')!.snap.tree!, /button "Cancel"/);
  b.elements.push({ role: 'AXButton', name: 'Cancel', parent: 0 });
  await b.windowState();
  const r2 = await d.act(cancel, 'press');
  assert.equal(r2.outcome, 'refused');
  assert.equal(r2.errorCode, 'stale_ref');
  assert.match(r2.message!, /2 elements now match/);
  assert.deepEqual(b.clicks, ['OK']);
  // (c) A ref that is not in the window's latest snapshot any more is stale too: refused, never guessed.
  await d.snapshot('w1');
  const r3 = await d.act(cancel, 'press');
  assert.equal(r3.outcome, 'refused');
  assert.equal(r3.errorCode, 'stale_ref');
  // (d) Refs that never existed are ref_not_found.
  assert.equal((await d.act('d999', 'press')).errorCode, 'ref_not_found');
});

test('F3 AC2 (driver): a destructive press without expect is refused by the session guard; with expect it runs and is verified', async () => {
  const ws = tmpWorkspace();
  setDesktopBackendFactory(() => new CuaDriverBackend({ command: process.execPath, args: [FAKE], versionPin: '0.37' }));
  const s = new DesktopSession({ sessionId: `destr-${Date.now()}`, workspace: ws, config: testConfig('http://127.0.0.1:9/v1', { desktop: { enabled: true, settleMs: 0, record: false } }) });
  try {
    const d = await s.ensure();
    s.beginTurn(1);
    const snap = await d.snapshot('1001');
    const close = refOf(snap.tree!, /button "Close"/);
    const r1 = await d.act(close, 'press', { guard: s.guard });
    assert.equal(r1.outcome, 'refused');
    assert.equal(r1.errorCode, 'policy_denied');
    assert.match(r1.message!, /looks destructive/);
    assert.equal((await d.windows()).length, 2, 'nothing was closed');
    s.beginTurn(2);
    const r2 = await d.act(close, 'press', { guard: s.guard, expect: { window_present: { title_regex: 'Notes' } } });
    assert.equal(r2.outcome, 'confirmed');
    assert.ok(r2.notes?.some((n) => /window closed: 1001 Calculator/.test(n)));
  } finally {
    setDesktopBackendFactory(undefined);
    await s.close();
  }
});

// ------------------------------------------------------------ F4

test('F4 AC1: each empty-tree trap gets the right cause_hint, and not_activated is auto-remedied (5 cases)', async () => {
  // permissions
  {
    const { d } = await fake(['--scenario=permissions']);
    await d.health();
    await assert.rejects(d.snapshot('1001'), (e: PreconditionError) => e instanceof PreconditionError && e.causeHint === 'permissions' && e.code === 'permission_denied' && /CuaDriver\.app|accessibility/i.test(e.remedy));
  }
  // not_activated → activation helper (bring_to_front) + 0.5 s wait + re-scan succeeds
  {
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cua-')), 'calls.jsonl');
    const { d } = await fake(['--scenario=background', `--log=${log}`]);
    const t0 = Date.now();
    const { stored, applied } = await d.scanChecked(await d.resolveWindow('1001'));
    assert.ok(Date.now() - t0 >= 500, 'waited 0.5 s after activating');
    assert.match(applied!, /activated Calculator, waited 500 ms and re-scanned/);
    assert.match(stored.snap.tree!, /button "7"/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).tool);
    assert.ok(calls.indexOf('bring_to_front') > calls.indexOf('get_window_state'));
  }
  // qt_a11y_off → hint names QT_ACCESSIBILITY; launching through the driver sets it and the tree appears
  {
    const { d } = await fake(['--scenario=qt']);
    await assert.rejects(d.snapshot('1001'), (e: PreconditionError) => e.causeHint === 'qt_a11y_off' && /QT_ACCESSIBILITY=1/.test(e.remedy));
    assert.equal((await d.apps('launch', 'QtCalc')).ok, true);
    assert.match((await d.snapshot('1001')).tree!, /button "7"/);
  }
  // electron_opaque → points at desktop_electron
  {
    const { d } = await fake(['--scenario=electron']);
    await assert.rejects(d.snapshot('3001'), (e: PreconditionError) => e.causeHint === 'electron_opaque' && /desktop_electron/.test(e.remedy));
  }
  // canvas → points at the pixel layer
  {
    const { d } = await fake(['--scenario=canvas']);
    await assert.rejects(d.snapshot('4001'), (e: PreconditionError) => e.causeHint === 'canvas' && /desktop_screenshot/.test(e.remedy));
  }
});

// ------------------------------------------------------------ F6

test('F6 AC1: a canvas-only window is clicked by OCR region (fixture PNG, real tesseract), verified by re-scan', async () => {
  // The fake's "Submit" area in the fixture: rectangle 120,70 → 280,130.
  const { d } = await fake(['--scenario=canvas', `--canvas-png=${CANVAS}`, '--canvas-hit=120,70,160,60']);
  await assert.rejects(d.snapshot('4001'), (e: PreconditionError) => e.causeHint === 'canvas');
  const shot = await d.maskedScreenshot('4001', []);
  const regions = await ocrRegions(shot.png, {});
  const submit = regions.find((r) => /submit/i.test(r.text));
  assert.ok(submit, `OCR regions: ${JSON.stringify(regions.map((r) => r.text))}`);
  const [x, y] = centre(submit.box);
  const r = await d.point('4001', Math.round(x / (shot.scale ?? 1)), Math.round(y / (shot.scale ?? 1)), 'click', undefined, { expect: { text_present: 'Submitted!' } });
  assert.equal(r.outcome, 'confirmed');
  assert.equal(r.path, 'L3');
  assert.match(r.diff ?? '', /\+ statictext "Submitted!"/);
});

test('F6/E8: desktop screenshots paint password and secret-filled fields black, and are withheld when a secret shows elsewhere', async () => {
  const { encodePng, decodePng, blank } = await import('../src/core/automation/perception/png.js');
  const b = new ScriptedBackend();
  b.elements = [{ role: 'AXWindow', name: 'Login' }, { role: 'AXSecureTextField', name: 'Password', value: 'hunter2hunter2', parent: 0, box: { x: 10, y: 10, width: 20, height: 10 } }, { role: 'AXTextField', name: 'Token', value: '', parent: 0, box: { x: 10, y: 30, width: 20, height: 10 } }];
  b.screenshot = async () => ({ png: encodePng(blank(50, 50, [255, 255, 255, 255])), scale: 1 });
  const d = new ScanActVerifyDriver(b, { settleMs: 0 });
  await d.snapshot('w1');
  d.markSecret(refOf(d.latest('w1')!.snap.tree!, /textbox "Token"/));
  const shot = await d.maskedScreenshot('w1', []);
  assert.equal(shot.masked, 2);
  const img = decodePng(shot.png);
  const px = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
  assert.deepEqual(px(15, 15), [0, 0, 0]);
  assert.deepEqual(px(15, 35), [0, 0, 0]);
  assert.deepEqual(px(45, 45), [255, 255, 255]);
  // The secret value appears in another element's text → withheld.
  b.elements.push({ role: 'AXStaticText', value: 'your token is s3cr3t-value', parent: 0 });
  await assert.rejects(d.maskedScreenshot('w1', ['s3cr3t-value']), /screenshot withheld/);
  await assert.rejects(d.maskedScreenshot(undefined, ['s3cr3t-value']), /whole-screen/);
});

// ------------------------------------------------------------ F7

test('F7 AC2: the rate limit refuses the 61st desktop action in a minute', async () => {
  const ws = tmpWorkspace();
  setDesktopBackendFactory(() => new CuaDriverBackend({ command: process.execPath, args: [FAKE], versionPin: '0.37' }));
  const s = new DesktopSession({ sessionId: `rate-${Date.now()}`, workspace: ws, config: testConfig('http://127.0.0.1:9/v1', { desktop: { enabled: true, settleMs: 0, record: false, maxIdenticalActions: 0 } }) });
  try {
    const d = await s.ensure();
    const snap = await d.snapshot('1001');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map((k) => refOf(snap.tree!, new RegExp(`button "${k}"`)));
    const outcomes: string[] = [];
    for (let i = 0; i < 61; i++) {
      s.beginTurn(i);
      const r = await d.act(keys[i % keys.length], 'press', { guard: s.guard });
      outcomes.push(r.errorCode === 'rate_limited' ? 'rate_limited' : r.outcome);
    }
    assert.ok(outcomes.slice(0, 60).every((o) => o === 'confirmed' || o === 'suspected_noop'), JSON.stringify(outcomes));
    assert.equal(outcomes[60], 'rate_limited');
  } finally {
    setDesktopBackendFactory(undefined);
    await s.close();
  }
});

test('F7 AC3: acting on a window owned by the harness pid is refused', async () => {
  const ws = tmpWorkspace();
  setDesktopBackendFactory(() => new CuaDriverBackend({ command: process.execPath, args: [FAKE, `--window-pid=${process.pid}`], versionPin: '0.37' }));
  const s = new DesktopSession({ sessionId: `self-${Date.now()}`, workspace: ws, config: testConfig('http://127.0.0.1:9/v1', { desktop: { enabled: true, settleMs: 0, record: false } }) });
  try {
    const d = await s.ensure();
    s.beginTurn(1);
    const snap = await d.snapshot('1001');
    const r = await d.act(refOf(snap.tree!, /button "7"/), 'press', { guard: s.guard });
    assert.equal(r.outcome, 'refused');
    assert.equal(r.errorCode, 'policy_denied');
    assert.match(r.message!, /harness itself/);
    assert.match((await d.snapshot('1001')).tree!, /statictext "0"/, 'nothing was pressed');
    // Keys and typing into the harness window are refused too.
    assert.equal((await d.key('Enter', { windowId: '1001', guard: s.guard })).outcome, 'refused');
  } finally {
    setDesktopBackendFactory(undefined);
    await s.close();
    resetKillSwitch();
  }
});

// ------------------------------------------------------------ F9 (Linux AT-SPI sidecar under Xvfb)

const giPython = findGiPython();
const haveXvfb = spawnSync('which', ['xvfb-run']).status === 0 && spawnSync('which', ['dbus-run-session']).status === 0;

test('F9 AC1: the Linux AT-SPI sidecar scans and clicks a GTK test window under Xvfb (7×8=56, set_value, screenshot)', { skip: !giPython || !haveXvfb ? 'needs python3-gi + AT-SPI + xvfb-run (DEVICE: scripts/device-checks/desktop-linux.sh)' : false, timeout: 120_000 }, async () => {
  const app = path.join(ROOT, 'docker/desktop-sandbox/apps/oh_calc.py');
  const b = new SidecarBackend(['xvfb-run', '-a', 'dbus-run-session', '--', path.join(ROOT, 'docker/desktop-sandbox/session.sh'), giPython!, LINUX_SIDECAR], { env: { TUG_SESSION_APPS: `${giPython} ${app}` }, timeoutMs: 30_000 });
  const d = new ScanActVerifyDriver(b, { settleMs: 150 });
  started.push(d);
  await b.start();
  const h = await d.health();
  assert.equal(h.ok, true, h.message);
  let win: { windowId: string; title: string } | undefined;
  for (let i = 0; i < 60 && !win; i++) {
    win = (await d.windows()).find((w) => w.title === 'OH Calc');
    if (!win) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(win, 'the GTK window appeared on the AT-SPI bus');
  const snap = await d.snapshot(win.windowId);
  assert.match(snap.tree!, /button "7" \[ref=d\d+\]/);
  assert.match(snap.tree!, /textbox "Note"/);
  const tree = () => d.latest(win!.windowId)!.snap.tree!;
  for (const k of ['7', '×', '8']) await d.act(refOf(tree(), new RegExp(`button "${k}"`)), 'press');
  const eq = await d.act(refOf(tree(), /button "="/), 'press', { expect: { text_present: '56' } });
  assert.equal(eq.outcome, 'confirmed', eq.message);
  assert.match(eq.diff ?? '', /\+ statictext "56"/);
  const sv = await d.setValue(refOf(tree(), /textbox "Note"/), 'hello from the sidecar', { expect: { value_equals: { role: 'textbox', name: 'Note', value: 'hello from the sidecar' } } });
  assert.equal(sv.outcome, 'confirmed', sv.message);
  const shot = await d.screenshot(win.windowId);
  assert.ok(shot.png.subarray(1, 4).toString() === 'PNG' && shot.png.length > 1000);
  await d.close();
});

// ------------------------------------------------------------ F10 (Docker sandbox)

const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 }).status === 0;

test('F10 AC1: the sandbox image builds and the sidecar inside answers ping and snapshot', { skip: dockerUp ? false : 'docker daemon not available (pending-env)', timeout: 30 * 60_000 }, async () => {
  const cfg = testConfig('http://127.0.0.1:9/v1', { desktop: { sandbox: { container: `oh-desktop-test-${process.pid}`, vncPort: 16080 + (process.pid % 1000) } } });
  const up = await sandboxUp(cfg, {});
  assert.equal(up.ok, true, up.message);
  const b = new SidecarBackend(sandboxSidecarCommand(cfg.desktop!.sandbox!.container!), { timeoutMs: 30_000 });
  const d = new ScanActVerifyDriver(b, { settleMs: 150 });
  try {
    await b.start(); // ping
    let win: { windowId: string; title: string } | undefined;
    // a fresh image on a slow CI runner can take a while to bring up the AT-SPI bus and the app
    for (let i = 0; i < 240 && !win; i++) {
      win = (await d.windows()).find((w) => w.title === 'OH Calc');
      if (!win) await new Promise((r) => setTimeout(r, 250));
    }
    if (!win) {
      // on failure, say why: the container's own logs (display, bus, AT-SPI launcher, the app)
      const logs = spawnSync('docker', ['exec', cfg.desktop!.sandbox!.container!, 'sh', '-c', 'for f in /tmp/xvfb.log /tmp/atspi.log /tmp/oh_calc.log; do echo "== $f"; tail -n 20 "$f" 2>&1; done; ls /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher 2>&1'], { encoding: 'utf8', timeout: 20_000 });
      assert.fail(`the sample app is on the sandbox AT-SPI bus; windows seen: ${JSON.stringify((await d.windows()).map((w) => w.title))}\n${logs.stdout}${logs.stderr}`);
    }
    const snap = await d.snapshot(win.windowId);
    assert.match(snap.tree!, /button "=" \[ref=d\d+\]/);
    const r = await d.act(refOf(snap.tree!, /button "9"/), 'press');
    assert.equal(r.outcome, 'confirmed');
  } finally {
    await d.close();
    await sandboxDown(cfg);
  }
});
