#!/usr/bin/env node
// Fake `cua-driver mcp` (SPEC F1 AC1): an MCP stdio server implementing the
// subset of cua-driver 0.37 tools the CuaDriverAdapter uses, over a
// deterministic Calculator model (plus a small Notes window). Element tokens
// are scoped to one get_window_state, like the real driver: an older token
// gets `stale_element_token`.
//
// Fault injection (argv):
//   --ignore-clicks=N    the first N element clicks report success but change nothing (F3 AC1)
//   --scenario=X         permissions | background | qt | electron | canvas (F4, F6)
//   --window-pid=N       the Calculator window's pid (F7 AC3 self-protection)
//   --version=V          server version (pin check)
//   --log=FILE           append one JSON line per tool call
//   --canvas-png=FILE    screenshot for the canvas scenario
//   --canvas-hit=x,y,w,h the "Submit" area of the canvas (screenshot pixels)
//   --electron-exe=PATH  launch_path reported for the Electron app (Slack) in the electron scenario
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([\w-]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? 'true'] : [a, 'true']; }));
const scenario = argv.scenario ?? '';
let ignoreClicks = Number(argv['ignore-clicks'] ?? 0);
const log = (tool, args) => { if (argv.log) fs.appendFileSync(argv.log, JSON.stringify({ t: Date.now(), tool, args }) + '\n'); };

// ------------------------------------------------------------ app model
const CALC_PID = Number(argv['window-pid'] ?? 4242);
const calcName = scenario === 'qt' ? 'QtCalc' : 'Calculator';
const apps = [
  { pid: CALC_PID, name: calcName, running: true, active: scenario !== 'background', bundle_id: scenario === 'qt' ? 'org.example.qtcalc' : 'com.apple.calculator', launch_path: scenario === 'qt' ? '/opt/qtcalc/bin/qtcalc (libQt6Core.so.6)' : '/System/Applications/Calculator.app' },
  { pid: 5150, name: 'Notes', running: true, active: false, bundle_id: 'com.apple.Notes', launch_path: '/System/Applications/Notes.app' },
  { pid: 100, name: 'Finder', running: true, active: false, bundle_id: 'com.apple.finder', launch_path: '/System/Library/CoreServices/Finder.app' },
];
if (scenario === 'electron') apps.push({ pid: 7777, name: 'Slack', running: true, active: true, bundle_id: 'com.tinyspeck.slackmacgap', launch_path: argv['electron-exe'] ?? '/Applications/Slack.app' });
if (scenario === 'canvas') apps.push({ pid: 8888, name: 'Paint', running: true, active: true, bundle_id: 'org.example.paint', launch_path: '/Applications/Paint.app' });

const calc = { display: '0', acc: null, op: null, fresh: true, open: true };
let activated = scenario !== 'background';
let qtA11y = false;
const notes = { body: 'Shopping list', password: '' };
let canvasSubmitted = false;
let clipboard = '';
let recording = null;

function compute(a, op, b) {
  return op === '+' ? a + b : op === '−' ? a - b : op === '×' ? a * b : op === '÷' ? a / b : b;
}
function pressCalc(label) {
  if (/^[0-9]$/.test(label)) {
    calc.display = calc.fresh || calc.display === '0' ? label : calc.display + label;
    calc.fresh = false;
  } else if (['+', '−', '×', '÷'].includes(label)) {
    if (calc.acc !== null && calc.op && !calc.fresh) calc.display = String(compute(calc.acc, calc.op, Number(calc.display)));
    calc.acc = Number(calc.display);
    calc.op = label;
    calc.fresh = true;
  } else if (label === '=') {
    if (calc.op !== null) calc.display = String(compute(calc.acc, calc.op, Number(calc.display)));
    calc.acc = null;
    calc.op = null;
    calc.fresh = true;
  } else if (label === 'AC') Object.assign(calc, { display: '0', acc: null, op: null, fresh: true });
  else if (label === 'Close') calc.open = false;
}
const KEYS = ['AC', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '='];

// ------------------------------------------------------------ windows and trees
function windows() {
  const ws = [];
  if (calc.open) ws.push({ window_id: 1001, pid: CALC_PID, app_name: calcName, title: calcName, bounds: { x: 100, y: 100, width: 230, height: 320 }, is_on_screen: activated, minimized: false, z_index: activated ? 0 : 3, layer: 0 });
  ws.push({ window_id: 2001, pid: 5150, app_name: 'Notes', title: 'Notes — Shopping', bounds: { x: 400, y: 100, width: 600, height: 400 }, is_on_screen: true, minimized: false, z_index: 1, layer: 0 });
  if (scenario === 'electron') ws.push({ window_id: 3001, pid: 7777, app_name: 'Slack', title: 'Slack — general', bounds: { x: 0, y: 0, width: 1000, height: 700 }, is_on_screen: true, minimized: false, z_index: 0, layer: 0 });
  if (scenario === 'canvas') ws.push({ window_id: 4001, pid: 8888, app_name: 'Paint', title: 'Untitled', bounds: { x: 0, y: 0, width: 400, height: 200 }, is_on_screen: true, minimized: false, z_index: 0, layer: 0 });
  return ws;
}

function calcElements() {
  const els = [
    { role: 'AXWindow', label: calcName, parent: null },
    { role: 'AXButton', label: 'Close', parent: 0, actions: ['AXPress'] },
    { role: 'AXGroup', label: null, parent: 0 },
    { role: 'AXStaticText', label: null, value: calc.display, value_description: 'main display', parent: 2 },
    { role: 'AXGroup', label: 'Keypad', parent: 0 },
    // Like macOS Calculator, the pending operator key stays highlighted (selected).
    ...KEYS.map((k) => ({ role: 'AXButton', label: k, parent: 4, actions: ['AXPress'], selected: calc.op === k && calc.fresh })),
  ];
  return els;
}

function notesElements() {
  return [
    { role: 'AXWindow', label: 'Notes — Shopping', parent: null },
    { role: 'AXTextArea', label: 'Body', value: notes.body, parent: 0, actions: [] },
    { role: 'AXSecureTextField', label: 'Password', value: notes.password, parent: 0 },
    { role: 'AXButton', label: 'Send', parent: 0, actions: ['AXPress'] },
  ];
}

let snapSeq = 0;
const tokens = new Map(); // token -> {snap, windowId, index}
const latestSnap = new Map(); // windowId -> snap

function windowState(windowId, includeScreenshot) {
  const w = windows().find((x) => x.window_id === windowId);
  if (!w) return { error: { code: 'window_target_not_found', message: `no window ${windowId}` } };
  let els = [];
  let degraded = false;
  let reason;
  if (windowId === 1001) {
    if (scenario === 'permissions') {
      degraded = true;
      reason = 'Accessibility permission not granted (TCC)';
    } else if (!activated) {
      els = [{ role: 'AXWindow', label: calcName, parent: null }];
      degraded = true;
      reason = 'window not active: launched in background';
    } else if (scenario === 'qt' && !qtA11y) {
      els = [{ role: 'AXWindow', label: calcName, parent: null }];
      degraded = true;
      reason = 'no accessible children';
    } else els = calcElements();
  } else if (windowId === 2001) els = notesElements();
  else if (windowId === 3001) els = [{ role: 'AXWindow', label: 'Slack — general', parent: null }, { role: 'AXWebArea', label: null, parent: 0 }];
  else if (windowId === 4001) {
    els = [{ role: 'AXWindow', label: 'Untitled', parent: null }, { role: 'AXLayoutArea', label: null, parent: 0 }];
    if (canvasSubmitted) els.push({ role: 'AXStaticText', label: null, value: 'Submitted!', parent: 0 });
  }
  const snap = ++snapSeq;
  latestSnap.set(windowId, snap);
  const elements = els.map((e, i) => {
    const token = `t${snap}-${i}`;
    tokens.set(token, { snap, windowId, index: i, label: e.label, role: e.role });
    return { element_index: i, role: e.role, depth: e.parent === null ? 0 : 1, element_token: token, label: e.label, value: e.value ?? null, value_description: e.value_description ?? null, enabled: true, selected: !!e.selected, in_web_content: e.role === 'AXWebArea', actions: e.actions ?? [], parent_index: e.parent, frame: { x: 10, y: 10 + i * 20, w: 50, h: 18 } };
  });
  const out = { pid: w.pid, window_id: windowId, snapshot_id: `s${snap}`, app_name: w.app_name, window_title: w.title, elements, element_count: elements.length, degraded, degraded_reason: reason ?? null };
  if (includeScreenshot) {
    const png = windowId === 4001 && argv['canvas-png'] ? fs.readFileSync(argv['canvas-png']) : TINY_PNG;
    out.screenshot_width = 400;
    out.screenshot_height = 200;
    out.screenshot_scale = 1;
    return { out, png };
  }
  return { out };
}

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function token(t) {
  const hit = tokens.get(t);
  if (!hit) return { err: { code: 'element_not_found', message: `unknown element_token ${t}` } };
  if (latestSnap.get(hit.windowId) !== hit.snap) return { err: { code: 'stale_element_token', message: `stale_element_token: ${t} belongs to an invalidated snapshot; call get_window_state again` } };
  return { hit };
}

// ------------------------------------------------------------ MCP server
const version = argv.version ?? '0.37.0';
const server = new McpServer({ name: 'cua-driver', version });
const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o });
const fail = (code, message) => ({ content: [{ type: 'text', text: `${code}: ${message}` }], structuredContent: { effect: 'refused', error: { code, message } }, isError: true });
const effect = (e, summary) => json({ effect: e, route: 'ax', path: 'ax', summary });
const win = { pid: z.number().optional(), window_id: z.number().optional(), session: z.string().optional() };

function reg(name, shape, fn) {
  server.registerTool(name, { description: `fake cua-driver ${name}`, inputSchema: z.object(shape) }, async (args) => {
    log(name, args);
    return fn(args ?? {});
  });
}

reg('list_apps', {}, () => json({ apps }));
reg('list_windows', { pid: z.number().optional(), on_screen_only: z.boolean().optional() }, ({ pid }) => json({ windows: windows().filter((w) => pid === undefined || w.pid === pid), current_space_id: 1 }));
reg('launch_app', { name: z.string().optional(), bundle_id: z.string().optional(), env: z.record(z.string(), z.string()).optional(), args: z.array(z.string()).optional() }, ({ name, env }) => {
  const app = apps.find((a) => a.name === name || a.bundle_id === name);
  if (!app) return fail('not_found', `no app ${name}`);
  if (app.name === 'QtCalc' && env?.QT_ACCESSIBILITY === '1') qtA11y = true;
  if (app.pid === CALC_PID) {
    calc.open = true;
    activated = true;
  }
  return json({ effect: 'confirmed', pid: app.pid, summary: `launched ${app.name}` });
});
reg('bring_to_front', { pid: z.number(), window_id: z.number().optional() }, ({ pid }) => {
  if (pid === CALC_PID) activated = true;
  return effect('confirmed', 'activated');
});
reg('kill_app', { pid: z.number() }, ({ pid }) => {
  if (pid === CALC_PID) calc.open = false;
  return effect('confirmed', 'killed');
});
reg('check_permissions', {}, () => json(scenario === 'permissions' ? { accessibility: false, screen_recording: false } : { accessibility: true, screen_recording: true }));
reg('health_report', {}, () => json({ status: 'ok', summary: `fake cua-driver ${version} (scenario ${scenario || 'default'})` }));
reg('get_window_state', { ...win, include_screenshot: z.boolean().optional(), include_accessibility_tree: z.boolean().optional(), query: z.string().optional() }, ({ window_id, include_screenshot }) => {
  const r = windowState(window_id, include_screenshot !== false && include_screenshot !== undefined ? true : false);
  if (r.error) return fail(r.error.code, r.error.message);
  const content = [{ type: 'text', text: JSON.stringify(r.out) }];
  if (r.png) content.push({ type: 'image', mimeType: 'image/png', data: r.png.toString('base64') });
  return { content, structuredContent: r.out };
});
reg('get_desktop_state', { include_screenshot: z.boolean().optional() }, () => ({ content: [{ type: 'image', mimeType: 'image/png', data: TINY_PNG.toString('base64') }], structuredContent: { screenshot_scale: 1 } }));

function clickElement(t, kind) {
  const { hit, err } = token(t);
  if (err) return fail(err.code, err.message);
  if (ignoreClicks > 0) {
    ignoreClicks--;
    return effect('confirmed', 'clicked (ignored by the fake)');
  }
  if (hit.windowId === 1001 && hit.role === 'AXButton') pressCalc(hit.label);
  else if (hit.windowId === 2001 && hit.label === 'Send') notes.body = '(sent)';
  return effect('confirmed', `${kind} ${hit.label ?? hit.role}`);
}

reg('click', { ...win, element_token: z.string().optional(), x: z.number().optional(), y: z.number().optional(), button: z.string().optional(), count: z.number().optional() }, ({ element_token, x, y, window_id }) => {
  if (element_token) return clickElement(element_token, 'clicked');
  if (window_id === 4001 && x !== undefined && y !== undefined) {
    const [hx, hy, hw, hh] = String(argv['canvas-hit'] ?? '0,0,0,0').split(',').map(Number);
    if (x >= hx && x <= hx + hw && y >= hy && y <= hy + hh) canvasSubmitted = true;
    return effect('unverifiable', `clicked at ${x},${y}`);
  }
  return effect('unverifiable', `clicked at ${x},${y}`);
});
reg('double_click', { ...win, element_token: z.string().optional() }, ({ element_token }) => clickElement(element_token, 'double-clicked'));
reg('right_click', { ...win, element_token: z.string().optional() }, ({ element_token }) => clickElement(element_token, 'right-clicked'));
reg('set_value', { ...win, element_token: z.string(), value: z.string() }, ({ element_token, value }) => {
  const { hit, err } = token(element_token);
  if (err) return fail(err.code, err.message);
  if (hit.windowId === 2001 && hit.label === 'Body') notes.body = value;
  else if (hit.windowId === 2001 && hit.label === 'Password') notes.password = value;
  else return fail('not_settable', `${hit.role} is not settable`);
  return effect('confirmed', 'value set');
});
reg('type_text', { ...win, element_token: z.string().optional(), text: z.string() }, ({ text, window_id }) => {
  if ((window_id ?? 1001) === 1001) for (const ch of text.replace(/\*/g, '×').replace(/-/g, '−').replace(/\//g, '÷')) if (KEYS.includes(ch)) pressCalc(ch);
  return effect('confirmed', 'typed');
});
reg('press_key', { ...win, key: z.string(), modifiers: z.array(z.string()).optional() }, ({ key }) => {
  const k = key === 'Enter' || key === 'Return' ? '=' : key === 'Escape' ? 'AC' : key === '*' ? '×' : key;
  if (KEYS.includes(k)) pressCalc(k);
  return effect('confirmed', `pressed ${key}`);
});
reg('hotkey', { ...win, keys: z.array(z.string()) }, ({ keys }) => {
  if (keys.join('+').toLowerCase() === 'cmd+c') clipboard = calc.display;
  return effect('confirmed', `hotkey ${keys.join('+')}`);
});
reg('scroll', { ...win, element_token: z.string().optional(), direction: z.string(), amount: z.number().optional(), x: z.number().optional(), y: z.number().optional() }, () => effect('unverifiable', 'scrolled'));
reg('drag', { ...win, from_x: z.number(), from_y: z.number(), to_x: z.number(), to_y: z.number() }, () => effect('unverifiable', 'dragged'));
reg('invoke_menu', { pid: z.number().optional(), path: z.array(z.string()) }, ({ path }) => {
  if (path.join('>') === 'Edit>Copy') clipboard = calc.display;
  else if (path.join('>') === 'View>Clear') pressCalc('AC');
  else return fail('not_found', `no menu item ${path.join(' > ')}`);
  return effect('confirmed', `invoked ${path.join(' > ')}`);
});
reg('clipboard_read', { include_text: z.boolean().optional() }, () => json({ text: clipboard }));
reg('clipboard_write', { text: z.string().optional() }, ({ text }) => {
  clipboard = text ?? '';
  return effect('confirmed', 'written');
});
reg('start_recording', { output_dir: z.string() }, ({ output_dir }) => {
  recording = output_dir;
  fs.mkdirSync(output_dir, { recursive: true });
  fs.writeFileSync(`${output_dir}/cua-recording.json`, JSON.stringify({ started: Date.now() }));
  return json({ recording: true, output_dir });
});
reg('stop_recording', {}, () => {
  recording = null;
  return json({ recording: false });
});
reg('shutdown', {}, () => {
  setTimeout(() => process.exit(0), 20);
  return json({ ok: true });
});

await server.connect(new StdioServerTransport());
