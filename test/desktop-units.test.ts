/**
 * WS6 desktop unit tests: role mapping, tree normalisation, trap diagnosis,
 * policy pieces (destructive, fence, self-protection), the kill-switch file,
 * sidecar framing and method parity. No processes beyond small helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ariaRole } from '../src/core/automation/desktop/roles.js';
import { buildTree } from '../src/core/automation/desktop/driver.js';
import { diagnoseEmpty, isKnownElectron } from '../src/core/automation/desktop/traps.js';
import { desktopDestructiveCheck, DesktopSession } from '../src/core/automation/desktop/session.js';
import { harnessPids, harnessApps, selfProtectCheck } from '../src/core/automation/desktop/selfprotect.js';
import { NdjsonParser, encodeRequest, SIDECAR_METHODS, LINUX_SIDECAR, WINDOWS_SIDECAR } from '../src/core/automation/desktop/sidecar.js';
import { versionMatches, elementFromCua, parseResult } from '../src/core/automation/desktop/cua.js';
import { emergencyStop, clearStop, watchStopFile } from '../src/core/automation/desktop/killswitch.js';
import { isKilled, resetKillSwitch } from '../src/core/automation/policy/index.js';
import { desktopConfig, appListed } from '../src/core/automation/desktop/config.js';
import { renderTree } from '../src/core/automation/snapshot/render.js';
import { testConfig, tmpWorkspace } from './helpers.js';

test('F1: native roles from AX, UIA and AT-SPI map to ARIA roles', () => {
  assert.equal(ariaRole('AXButton'), 'button');
  assert.equal(ariaRole('ControlType.Button'), 'button');
  assert.equal(ariaRole('push button'), 'button');
  assert.equal(ariaRole('AXTextField'), 'textbox');
  assert.equal(ariaRole('ControlType.Edit'), 'textbox');
  assert.equal(ariaRole('AXCheckBox'), 'checkbox');
  assert.equal(ariaRole('check box'), 'checkbox');
  assert.equal(ariaRole('AXStaticText'), 'statictext');
  assert.equal(ariaRole('label'), 'statictext');
  assert.equal(ariaRole('AXWebArea'), 'document');
  assert.equal(ariaRole('menu item'), 'menuitem');
  assert.equal(ariaRole('AXSheet'), 'dialog');
});

test('F1: flat cua-driver elements normalise into the shared tree (window root, parent links, states, password masking)', () => {
  const els = [
    { element_index: 0, role: 'AXWindow', label: 'Login', parent_index: null, element_token: 't1-0' },
    { element_index: 1, role: 'AXTextField', label: 'User', value: 'ada', parent_index: 0, element_token: 't1-1' },
    { element_index: 2, role: 'AXSecureTextField', label: 'Password', value: 'hunter22', parent_index: 0, element_token: 't1-2' },
    { element_index: 3, role: 'AXCheckBox', label: 'Remember me', value: '1', parent_index: 0, element_token: 't1-3' },
    { element_index: 4, role: 'AXButton', label: 'Sign in', enabled: false, parent_index: 0, element_token: 't1-4' },
    { element_index: 5, role: 'AXStaticText', value: '7', parent_index: 0 },
    { element_index: 6, role: 'AXButton', label: '7', parent_index: 0 },
  ].map(elementFromCua);
  const root = buildTree({ window: { windowId: '1', app: 'App', title: 'Login' }, elements: els });
  assert.equal(root.role, 'window');
  assert.equal(root.children?.length, 6);
  const text = renderTree(root, { maxTokens: 0 }).text;
  assert.match(text, /textbox "User" \[value="ada"\]/);
  assert.match(text, /checkbox "Remember me" \[checked\]/);
  assert.match(text, /button "Sign in" \[disabled\]/);
  // The display "7" survives next to the "7" button (the HTML label-dedupe rule must not hide it).
  assert.match(text, /statictext "7"/);
  assert.equal(root.children![1].states?.includes('password'), true);
});

test('F1: the cua-driver version pin is a prefix match', () => {
  assert.ok(versionMatches('0.37.0', '0.37'));
  assert.ok(versionMatches('v0.37.2', '0.37'));
  assert.ok(!versionMatches('0.38.0', '0.37'));
  assert.ok(versionMatches('0.38.0', '*'));
  assert.ok(!versionMatches(undefined, '0.37'));
});

test('F1: tool results parse from structuredContent, JSON text or plain text', () => {
  assert.deepEqual(parseResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } }).data, { a: 1 });
  assert.deepEqual(parseResult({ content: [{ type: 'text', text: '{"b":2}' }] }).data, { b: 2 });
  const p = parseResult({ content: [{ type: 'text', text: 'stale_element_token: gone' }], isError: true });
  assert.equal(p.isError, true);
  assert.match(p.text, /stale_element_token/);
});

test('F4 (unit): diagnosis order and hints for each cause', () => {
  const w = { windowId: '1', app: 'Calculator', title: 'Calculator', focused: true, onScreen: true };
  assert.equal(diagnoseEmpty({ window: w, elements: [], health: { ok: false, permissions: { accessibility: false } }, platform: 'darwin' }).cause, 'permissions');
  assert.equal(diagnoseEmpty({ window: w, elements: [], health: { ok: false, permissions: { accessibility: false } }, platform: 'darwin' }).code, 'permission_denied');
  const bg = diagnoseEmpty({ window: { ...w, onScreen: false, focused: false }, elements: [], platform: 'darwin' });
  assert.equal(bg.cause, 'not_activated');
  assert.equal(bg.autoActivate, true);
  assert.equal(diagnoseEmpty({ window: w, elements: [{ index: 0, role: 'AXWindow' }], app: { name: 'QtCalc', toolkit: 'Qt' }, platform: 'linux' }).cause, 'qt_a11y_off');
  assert.equal(diagnoseEmpty({ window: { ...w, app: 'Slack' }, elements: [{ index: 0, role: 'AXWindow' }, { index: 1, role: 'AXWebArea', parent: 0 }], platform: 'darwin' }).cause, 'electron_opaque');
  assert.equal(diagnoseEmpty({ window: { ...w, app: 'Paint' }, elements: [{ index: 0, role: 'AXWindow' }, { index: 1, role: 'AXLayoutArea', parent: 0 }], platform: 'darwin' }).cause, 'canvas');
  assert.ok(isKnownElectron({ name: 'Slack' }));
  assert.ok(isKnownElectron({ name: 'X', path: '/opt/x/resources/app.asar' }));
  assert.ok(!isKnownElectron({ name: 'Calculator' }));
});

test('F3 (unit): destructive desktop actions need an expect', () => {
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'press', name: 'Delete', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'press', name: 'Send', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'press', name: 'Close', hasExpect: true }, true).ok, true);
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'focus', name: 'Delete', hasExpect: false }, true).ok, true);
  assert.equal(desktopDestructiveCheck({ kind: 'quit', action: 'quit Mail', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'key', action: 'cmd+q', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'key', action: 'alt+F4', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'key', action: 'cmd+s', hasExpect: false }, true).ok, true);
  assert.equal(desktopDestructiveCheck({ kind: 'menu', action: 'File > Move to Trash', hasExpect: false }, true).ok, false);
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'press', name: '7', hasExpect: false }, true).ok, true);
  assert.equal(desktopDestructiveCheck({ kind: 'act', action: 'press', name: 'Delete', hasExpect: false }, false).ok, true);
});

test('F7 (unit): self-protection covers the harness pid, its ancestors, VS Code and the own terminal app', () => {
  const pids = harnessPids();
  assert.ok(pids.has(process.pid));
  assert.ok(pids.has(process.ppid), 'the parent (terminal / runner) is protected too');
  assert.equal(selfProtectCheck({ pid: process.pid, app: 'node', title: 'x' }).ok, false);
  assert.equal(selfProtectCheck({ pid: process.ppid, app: 'bash', title: 'x' }).ok, false);
  assert.equal(selfProtectCheck({ pid: 999_999_999, app: 'Calculator', title: 'Calculator' }, [], {}).ok, true);
  assert.ok(harnessApps({ TERM_PROGRAM: 'vscode' }).includes('Visual Studio Code'));
  assert.equal(selfProtectCheck({ pid: 999_999_999, app: 'iTerm2', title: 'tug' }, [], { TERM_PROGRAM: 'iTerm.app' }).ok, false);
  assert.equal(selfProtectCheck({ pid: 999_999_999, app: 'Code', title: 'x' }, [], { VSCODE_PID: '1' }).ok, false);
  assert.equal(selfProtectCheck({ pid: 999_999_999, app: 'Keychain Access', title: 'x' }, ['Keychain Access'], {}).ok, false);
});

test('F2/F7 (unit): desktop config defaults are off and safe', () => {
  const c = desktopConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.maxActionsPerMinute, 60);
  assert.deepEqual(c.autoApproveApps, []);
  assert.equal(c.requireExpectForDestructive, true);
  assert.equal(c.allowPoint, false);
  assert.ok(appListed({ name: 'Calculator' }, ['calculator']));
  assert.ok(appListed({ name: 'X', bundleId: 'com.apple.calculator' }, ['com.apple.Calculator']));
  assert.ok(!appListed(undefined, ['x']));
});

test('F7 (unit): the fence rule keeps menus, app switches and pixel clicks alone in their turn', async () => {
  const ws = tmpWorkspace();
  const s = new DesktopSession({ sessionId: `fence-${Date.now()}`, workspace: ws, config: testConfig('http://127.0.0.1:9/v1', { desktop: { enabled: true, record: false } }) });
  try {
    const win = { windowId: '1', app: 'Calculator', title: 'Calculator', pid: 999_999_999 };
    s.beginTurn(1);
    assert.equal((await s.guard({ window: win, node: { role: 'button', name: '7' } }, 'act', 'press')).ok, true);
    const menu = await s.guard({ window: win }, 'menu', 'Edit > Copy');
    assert.equal(menu.ok, false);
    assert.match(menu.message!, /fence rule.*invokes a menu/);
    s.beginTurn(2);
    assert.equal((await s.guard({ window: win }, 'point', 'click')).ok, true);
    const after = await s.guard({ window: win, node: { role: 'button', name: '8' } }, 'act', 'press');
    assert.equal(after.ok, false);
    assert.match(after.message!, /desktop_snapshot/);
  } finally {
    await s.close();
  }
});

test('F9 AC2: sidecar NDJSON framing (partial chunks, several per chunk, CRLF, BOM, noise)', () => {
  const p = new NdjsonParser();
  assert.deepEqual(p.push('{"id":1,"res'), []);
  assert.deepEqual(p.push('ult":{"a":1}}\r\n{"id":2,"result":2}\n'), [{ id: 1, result: { a: 1 } }, { id: 2, result: 2 }]);
  assert.deepEqual(p.push('﻿{"id":3,"result":null}\r\nWARNING: something\n\n'), [{ id: 3, result: null }]);
  assert.deepEqual(p.noise, ['WARNING: something']);
  assert.deepEqual(p.push(Buffer.from('{"id":4,"result":"é"}\n', 'utf8')), [{ id: 4, result: 'é' }]);
  const req = encodeRequest(7, 'snapshot', { window_id: 'w' });
  assert.ok(req.endsWith('\n') && !req.slice(0, -1).includes('\n'));
  assert.deepEqual(JSON.parse(req), { jsonrpc: '2.0', id: 7, method: 'snapshot', params: { window_id: 'w' } });
});

test('F9 AC2: the Windows and Linux sidecars implement the same JSON-RPC methods (and pwsh parses the script when available)', () => {
  const py = fs.readFileSync(LINUX_SIDECAR, 'utf8');
  const ps = fs.readFileSync(WINDOWS_SIDECAR, 'utf8');
  for (const m of SIDECAR_METHODS) {
    if (m === 'shutdown') {
      assert.match(py, /method == "shutdown"/);
      assert.match(ps, /\$req\.method -eq 'shutdown'/);
      continue;
    }
    assert.match(py, new RegExp(`"${m}":`), `python sidecar lacks ${m}`);
    assert.match(ps, new RegExp(`'${m}' = \\{`), `PowerShell sidecar lacks ${m}`);
  }
  // Both exit on stdin EOF (kill switch: the sidecar never outlives the harness).
  assert.match(py, /for line in sys\.stdin/);
  assert.match(ps, /if \(\$null -eq \$line\) \{ break \}/);
  // PowerShell's automatic $PID is read-only: the script must not assign it.
  assert.doesNotMatch(ps, /\$pid\s*=/i);
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${WINDOWS_SIDECAR}', [ref]$null, [ref]$e) | Out-Null; if ($e.Count) { $e | % { $_.Message }; exit 1 }`], { encoding: 'utf8' });
  if (!pwsh.error) assert.equal(pwsh.status, 0, pwsh.stdout + pwsh.stderr);
  const pyc = spawnSync('python3', ['-c', `import ast,sys; ast.parse(open(${JSON.stringify(LINUX_SIDECAR)}).read())`], { encoding: 'utf8' });
  assert.equal(pyc.status, 0, pyc.stderr);
});

test('F7 (unit): the STOP file pulls the global kill switch through the watcher; clearing resets it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-stop-'));
  const file = path.join(home, 'STOP');
  resetKillSwitch();
  const release = watchStopFile(file, 20);
  try {
    assert.equal(isKilled(), false);
    fs.writeFileSync(file, 'stop');
    const t0 = Date.now();
    while (!isKilled() && Date.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 10));
    assert.equal(isKilled(), true);
    assert.ok(Date.now() - t0 < 200, `noticed in ${Date.now() - t0} ms`);
    clearStop(home);
    assert.equal(isKilled(), false);
    assert.equal(fs.existsSync(file), false);
    emergencyStop(home, 'test');
    assert.equal(isKilled(), true);
    assert.ok(fs.existsSync(file));
  } finally {
    release();
    clearStop(home);
  }
});

test('F9: desktop helpers keep the session locators the scrubbed environment would drop (XAUTHORITY, DBUS_SESSION_BUS_ADDRESS)', async () => {
  const { desktopSessionEnv } = await import('../src/core/automation/desktop/backend.js');
  const { scrubbedEnv } = await import('../src/core/tools/shell.js');
  const env = { DISPLAY: ':0', XAUTHORITY: '/run/user/1000/xauth', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', OPENAI_API_KEY: 'sk-nope-123456789' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const scrubbed = scrubbedEnv([]);
    assert.equal(scrubbed.XAUTHORITY, undefined, 'the generic scrub drops it (…AUTH…)');
    const kept = desktopSessionEnv(process.env);
    assert.equal(kept.XAUTHORITY, env.XAUTHORITY);
    assert.equal(kept.DBUS_SESSION_BUS_ADDRESS, env.DBUS_SESSION_BUS_ADDRESS);
    assert.equal(kept.DISPLAY, ':0');
    assert.equal((kept as any).OPENAI_API_KEY, undefined, 'credentials are still not passed');
  } finally {
    for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
