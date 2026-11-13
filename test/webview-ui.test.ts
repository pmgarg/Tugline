/**
 * The chat panel's webview (vscode/media/main.js + main.css) in a real Chromium, with a VS Code theme's colours and a
 * stub of the webview API: the in-panel menus, the settings page and big pastes, driven the way a user drives them.
 * TUG_WEBVIEW_SHOTS=<dir> also saves screenshots (dark and light) for a visual review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as pw from 'playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { resolveExecutable } from '../src/core/automation/browser/launch.js';
import { PROVIDERS } from '../vscode/src/connections.js';

const MEDIA = path.resolve('vscode/media');
const CODICONS = [path.resolve('vscode/node_modules/@vscode/codicons/dist/codicon.css'), path.join(MEDIA, 'codicons/codicon.css')].find((f) => fs.existsSync(f));
const SHOTS = process.env.TUG_WEBVIEW_SHOTS;

/** A subset of the variables VS Code puts on a webview (Dark Modern / Light Modern). */
const THEMES: Record<string, Record<string, string>> = {
  dark: {
    'font-family': 'system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif', 'font-size': '13px', 'editor-font-family': 'ui-monospace, "DejaVu Sans Mono", monospace',
    foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'sideBar-background': '#181818', 'editor-background': '#1f1f1f', focusBorder: '#0078d4',
    'button-background': '#0078d4', 'button-foreground': '#ffffff', 'button-hoverBackground': '#026ec1', 'button-secondaryBackground': '#313131', 'button-secondaryForeground': '#cccccc', 'button-secondaryHoverBackground': '#3c3c3c',
    'input-background': '#313131', 'input-foreground': '#cccccc', 'input-border': '#3c3c3c', 'input-placeholderForeground': '#989898', 'textLink-foreground': '#4daafc',
    'list-hoverBackground': '#2a2d2e', 'menu-background': '#1f1f1f', 'menu-foreground': '#cccccc', 'menu-border': '#454545', 'menu-selectionBackground': '#0078d4', 'menu-selectionForeground': '#ffffff',
    'editorWidget-background': '#202020', 'textCodeBlock-background': '#2b2b2b', 'badge-background': '#616161', 'badge-foreground': '#f8f8f8', errorForeground: '#f85149',
    'charts-blue': '#3794ff', 'charts-purple': '#b180d7', 'charts-orange': '#d18616', 'scrollbarSlider-background': 'rgba(121,121,121,.4)',
  },
  light: {
    'font-family': 'system-ui, -apple-system, "Segoe UI", Ubuntu, sans-serif', 'font-size': '13px', 'editor-font-family': 'ui-monospace, "DejaVu Sans Mono", monospace',
    foreground: '#3b3b3b', descriptionForeground: '#3b3b3b', 'sideBar-background': '#f8f8f8', 'editor-background': '#ffffff', focusBorder: '#005fb8',
    'button-background': '#005fb8', 'button-foreground': '#ffffff', 'button-hoverBackground': '#0258a8', 'button-secondaryBackground': '#e5e5e5', 'button-secondaryForeground': '#3b3b3b', 'button-secondaryHoverBackground': '#cccccc',
    'input-background': '#ffffff', 'input-foreground': '#3b3b3b', 'input-border': '#cecece', 'input-placeholderForeground': '#767676', 'textLink-foreground': '#005fb8',
    'list-hoverBackground': '#f2f2f2', 'menu-background': '#ffffff', 'menu-foreground': '#3b3b3b', 'menu-border': '#cecece', 'menu-selectionBackground': '#005fb8', 'menu-selectionForeground': '#ffffff',
    'editorWidget-background': '#f8f8f8', 'textCodeBlock-background': '#f2f2f2', 'badge-background': '#cccccc', 'badge-foreground': '#3b3b3b', errorForeground: '#f85149',
    'charts-blue': '#1a85ff', 'charts-purple': '#652d90', 'charts-orange': '#d18616', 'scrollbarSlider-background': 'rgba(100,100,100,.4)',
  },
};

function page(theme: 'dark' | 'light'): string {
  const vars = Object.entries(THEMES[theme]).map(([k, v]) => `--vscode-${k}: ${v};`).join(' ');
  return `<!doctype html><html><head><meta charset="utf-8">
    ${CODICONS ? `<style>${fs.readFileSync(CODICONS, 'utf8').replace(/url\(["']?\.?\/?codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${fs.readFileSync(path.join(path.dirname(CODICONS), 'codicon.ttf')).toString('base64')}")`)}</style>` : ''}
    <style>html { ${vars} }</style><style>${fs.readFileSync(path.join(MEDIA, 'main.css'), 'utf8')}</style></head>
    <body class="vscode-${theme}"><div id="app"></div>
    <script>window.__posted = []; let __st = {}; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => __st, setState: (s) => (__st = s) });</script>
    <script>${fs.readFileSync(path.join(MEDIA, 'main.js'), 'utf8')}</script></body></html>`;
}

let browser: Browser;
async function open(theme: 'dark' | 'light' = 'dark', width = 420): Promise<Page> {
  browser ??= await chromium.launch({ executablePath: resolveExecutable(pw, undefined, true) });
  const p = await browser.newPage({ viewport: { width, height: 760 } });
  await p.setContent(page(theme));
  await post(p, { type: 'chats', epoch: 'e1', active: 'c1', list: [{ id: 'c1', title: 'New chat' }] });
  await post(p, { type: 'connections', list: CONNS, providers: PROVIDERS, locked: {} });
  await post(p, { type: 'status', chatId: 'c1', model: 'qwen3-coder-30b', baseUrl: 'https://ai.example.com/api', mode: 'ask', running: false, picker: [{ value: 'profile:fast', label: 'fast (qwen3-4b)', group: 'profiles' }, { value: 'model:llama-3.3-70b', label: 'llama-3.3-70b', group: 'models', info: { id: 'llama-3.3-70b', contextWindow: 131072, tools: true } }, { value: 'model:qwen3-coder-30b', label: 'qwen3-coder-30b', group: 'models', info: { id: 'qwen3-coder-30b', contextWindow: 262144, tools: true } }], choice: '', effort: 'default', connections: CONNS.map((c) => ({ id: c.id, name: c.name, provider: c.provider, host: c.host, model: c.model, active: c.active, lastTest: c.lastTest })) });
  return p;
}

/** Two saved connections: the company's Open WebUI (in use, tested) and Ollama. */
const CONNS = [
  { id: 'a1', name: 'Company AI', provider: 'openwebui', baseUrl: 'https://ai.example.com/api', host: 'ai.example.com', model: 'qwen3-coder-30b', contextWindow: 131072, toolMode: 'auto', hasKey: true, active: true, lastTest: { ok: true, at: 1763040000000, latencyMs: 900, tools: 'native' } },
  { id: 'b2', name: 'Ollama', provider: 'ollama', baseUrl: 'http://localhost:11434/v1', host: 'localhost:11434', model: 'qwen3:8b', toolMode: 'auto', hasKey: false, active: false },
];
const post = (p: Page, m: unknown) => p.evaluate((msg) => window.postMessage(msg, '*'), m).then(() => p.waitForTimeout(30));
const posted = (p: Page, type?: string) => p.evaluate((t) => (window as any).__posted.filter((m: any) => !t || m.type === t), type);
async function shot(p: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
test.after(async () => browser?.close());

test('webview: mode, model and effort are menus inside the panel and post the choice', async () => {
  const p = await open();
  assert.equal(await p.textContent('#modeBtn .lbl'), 'Ask first');
  assert.equal(await p.textContent('#modelBtn .lbl'), 'qwen3-coder-30b');
  await p.click('#modeBtn');
  assert.equal(await p.isVisible('#menu'), true);
  assert.deepEqual(await p.$$eval('#menu .mi', (els) => els.map((e) => (e as HTMLElement).dataset.value)), ['ask', 'acceptEdits', 'plan', 'auto', 'yolo']);
  await shot(p, 'menu-mode-dark');
  await p.click('#menu .mi[data-value="plan"]');
  assert.equal(await p.isVisible('#menu'), false);
  assert.equal(await p.textContent('#modeBtn .lbl'), 'Plan');
  assert.deepEqual((await posted(p, 'setMode')).at(-1), { type: 'setMode', chatId: 'c1', mode: 'plan' });
  // the model menu: groups, a filter, and a way to the settings
  await p.click('#modelBtn');
  assert.ok(await p.isVisible('#menuFilter'));
  await shot(p, 'menu-model-dark');
  // connections first, then the models on the one in use (with their context size), then config profiles
  assert.deepEqual(await p.$$eval('#menu .mg', (els) => els.map((e) => e.textContent)), ['Connections', 'Models on Company AI', 'Config profiles']);
  assert.deepEqual(await p.$$eval('#menu .mi', (els) => els.map((e) => (e as HTMLElement).dataset.value)), ['a1', 'b2', '', 'model:llama-3.3-70b', 'profile:fast']);
  assert.match(await p.textContent('#menu .mi[data-value="model:llama-3.3-70b"]'), /128K/);
  await p.fill('#menuFilter', 'llama-3');
  assert.deepEqual(await p.$$eval('#menu .mi', (els) => els.map((e) => (e as HTMLElement).dataset.value)), ['model:llama-3.3-70b']);
  await p.keyboard.press('Enter');
  assert.equal(await p.textContent('#modelBtn .lbl'), 'llama-3.3-70b');
  assert.deepEqual((await posted(p, 'setModel')).at(-1), { type: 'setModel', chatId: 'c1', value: 'model:llama-3.3-70b' });
  // keyboard: Escape closes, a click outside closes
  await p.click('#effortBtn');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  assert.deepEqual((await posted(p, 'setEffort')).at(-1), { type: 'setEffort', chatId: 'c1', effort: 'low' });
  await p.click('#modeBtn');
  await p.keyboard.press('Escape');
  assert.equal(await p.isVisible('#menu'), false);
  // switching the connection from the composer
  await p.click('#modelBtn');
  await p.click('#menu .mi[data-value="b2"]');
  assert.deepEqual((await posted(p, 'conn')).at(-1), { type: 'conn', action: 'use', id: 'b2' });
  await p.click('#modelBtn');
  await p.click('#menu [data-act="addconn"]');
  assert.equal(await p.isVisible('#view-settings'), true);
  assert.ok(await p.isVisible('.tiles'), 'Add a connection opens the gallery');
  await p.close();
});

test('webview: connections are added, tested and switched in the panel (no command palette)', async () => {
  const p = await open();
  await shot(p, 'empty-dark');
  // the welcome screen's line shows the connection in use
  assert.match(await p.textContent('.empty .herocap'), /qwen3-coder-30b[\s\S]*Company AI, ai\.example\.com\. Connected/);
  assert.match(await p.getAttribute('.empty .heroline', 'class'), /\bok\b/);
  await p.click('.empty a[data-act="cfg"]');
  assert.equal(await p.isVisible('#view-settings'), true);
  assert.deepEqual(await posted(p, 'configure'), [], 'not the palette wizard');
  assert.ok((await posted(p, 'conn')).some((m: any) => m.action === 'load'));
  await post(p, { type: 'connections', list: CONNS, providers: PROVIDERS, locked: {} });
  assert.equal(await p.locator('.crow').count(), 2);
  assert.match(await p.textContent('.crow.on'), /Company AI[\s\S]*In use/);
  await shot(p, 'connections-dark');
  // the gallery: local servers that answer are marked running
  await p.click('[data-c="add"]');
  assert.ok((await posted(p, 'conn')).some((m: any) => m.action === 'detect'));
  await post(p, { type: 'connLocal', servers: [{ kind: 'ollama', baseUrl: 'http://localhost:11434/v1', models: 7 }] });
  assert.match(await p.textContent('.tile[data-p="ollama"]'), /Running, 7 models/);
  assert.match(await p.textContent('.tile[data-p="lmstudio"]'), /Not running/);
  await shot(p, 'gallery-dark');
  // a custom URL: type the address and key; the server's models load by themselves
  await p.click('.tile[data-p="custom"]');
  await p.fill('#cfUrl', 'https://gw.example.com/v1');
  await p.fill('#cfKey', 'sk-test-123');
  await p.waitForTimeout(800);
  const req = (await posted(p, 'conn')).filter((m: any) => m.action === 'models').at(-1) as any;
  assert.equal(req.draft.baseUrl, 'https://gw.example.com/v1');
  assert.equal(req.draft.apiKey, 'sk-test-123');
  await post(p, { type: 'connModels', reqId: req.reqId, models: [{ id: 'llama-3.3-70b', contextWindow: 131072, tools: true }, { id: 'qwen3-coder-480b', contextWindow: 262144, maxOutput: 65536, tools: true, coder: true }, { id: 'bge-m3', tools: false }] });
  await p.click('#cfModel');
  // coder and tool-capable models first
  assert.deepEqual(await p.$$eval('#cfList .mo', (els) => els.map((e) => (e as HTMLElement).dataset.model)), ['qwen3-coder-480b', 'llama-3.3-70b', 'bge-m3']);
  await shot(p, 'form-models-dark');
  await p.fill('#cfModel', 'llama');
  assert.deepEqual(await p.$$eval('#cfList .mo', (els) => els.map((e) => (e as HTMLElement).dataset.model)), ['llama-3.3-70b']);
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  assert.equal(await p.inputValue('#cfModel'), 'llama-3.3-70b');
  // Auto follows what the server reports for the model; a custom size is a number box
  assert.equal(await p.textContent('#cfCtx button.on'), 'Auto (128K)');
  await p.click('#cfCtx [data-ctx="custom"]');
  await p.fill('#cfCtxCustom', '98304');
  await p.click('details.fmore summary');
  await p.click('#cfOut [data-out="16384"]');
  await p.click('[data-c="addh"]');
  await p.fill('.hrow .hn', 'X-Team');
  await p.fill('.hrow .hv', 'team-7');
  await p.fill('#cfName', 'Gateway');
  await shot(p, 'form-dark');
  // the test lights the line step by step
  await p.click('[data-c="test"]');
  const t = (await posted(p, 'conn')).filter((m: any) => m.action === 'test').at(-1) as any;
  assert.deepEqual(t.draft.headers, [{ name: 'X-Team', value: 'team-7' }]);
  for (const st of [
    { name: 'server', state: 'ok', detail: 'gw.example.com answered in 120 ms' },
    { name: 'model', state: 'ok', detail: 'llama-3.3-70b is served here' },
    { name: 'chat', state: 'run' },
  ]) await post(p, { type: 'connTest', reqId: t.reqId, ...st });
  assert.match(await p.getAttribute('#cfTest', 'class'), /\brun\b/);
  assert.equal(await p.locator('#cfTest .node.ok').count(), 2);
  await p.$eval('#cfTest', (e) => e.scrollIntoView({ block: 'end' }));
  await shot(p, 'test-running-dark');
  await post(p, { type: 'connTest', reqId: t.reqId, name: 'chat', state: 'ok', detail: 'First reply in 0.9 s, about 41 tokens a second' });
  await post(p, { type: 'connTest', reqId: t.reqId, name: 'tools', state: 'ok', detail: 'Native tool calls work' });
  await post(p, { type: 'connTest', reqId: t.reqId, name: 'done', state: 'ok', tools: 'native' });
  assert.match(await p.getAttribute('#cfTest', 'class'), /\bok\b/);
  assert.match(await p.textContent('#cfTest'), /Ready to use/);
  await p.$eval('.formacts', (e) => e.scrollIntoView({ block: 'end' }));
  await shot(p, 'test-ok-dark');
  // save and use
  await p.click('[data-c="saveuse"]');
  const save = (await posted(p, 'conn')).filter((m: any) => m.action === 'save').at(-1) as any;
  assert.deepEqual(save, { type: 'conn', action: 'save', use: true, draft: { provider: 'custom', name: 'Gateway', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-test-123', model: 'llama-3.3-70b', contextWindow: 98304, maxOutputTokens: 16384, toolMode: 'auto', vision: false, headers: [{ name: 'X-Team', value: 'team-7' }] } });
  await post(p, { type: 'connSaved', ok: true, id: 'c3', used: true });
  assert.match(await p.textContent('#stab-connections'), /Saved\. All new messages use it\./);
  // a failure says which step and what to do
  await p.click('.crow[data-id="a1"] [data-c="edit"]');
  assert.equal(await p.inputValue('#cfUrl'), 'https://ai.example.com/api');
  assert.match(await p.getAttribute('#cfKey', 'placeholder'), /Saved\. Type to replace it/);
  assert.equal(await p.inputValue('#cfKey'), '', 'a saved key never comes back to the page');
  await p.click('[data-c="test"]');
  const t2 = (await posted(p, 'conn')).filter((m: any) => m.action === 'test').at(-1) as any;
  assert.equal(t2.draft.id, 'a1');
  assert.equal(t2.draft.apiKey, undefined);
  await post(p, { type: 'connTest', reqId: t2.reqId, name: 'server', state: 'fail', detail: 'ai.example.com answered with a web page, not an API.', suggestBaseUrl: 'https://ai.example.com/api/v1' });
  await post(p, { type: 'connTest', reqId: t2.reqId, name: 'done', state: 'fail' });
  assert.match(await p.textContent('#cfTest'), /Fix the server step above/);
  await p.$eval('.formacts', (e) => e.scrollIntoView({ block: 'end' }));
  await shot(p, 'test-fail-dark');
  await p.click('#cfTest [data-c="usesuggest"]');
  assert.equal(await p.inputValue('#cfUrl'), 'https://ai.example.com/api/v1');
  // a narrow sidebar: nothing overflows sideways, on the form and in the gallery
  const overflow = () => p.$eval('#settings', (root) => { const lim = root.getBoundingClientRect().right; return [...root.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > lim + 1).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e as HTMLElement).className}`).slice(0, 8); });
  for (const w of [260, 200, 160]) {
    await p.setViewportSize({ width: w, height: 760 });
    assert.deepEqual(await overflow(), [], `form: nothing sticks out at ${w}px`);
  }
  await shot(p, 'form-narrow-dark');
  await p.setViewportSize({ width: 420, height: 760 });
  await p.click('[data-c="back"]');
  await p.click('[data-c="add"]');
  for (const w of [260, 160]) {
    await p.setViewportSize({ width: w, height: 760 });
    assert.deepEqual(await overflow(), [], `gallery: nothing sticks out at ${w}px`);
    // the header's buttons wrap instead of widening the page (a sideways scrollbar under the panel)
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `no page scroll at ${w}px`);
    assert.ok(await p.$eval('#estop', (e) => e.getBoundingClientRect().right <= window.innerWidth + 1), `the header fits at ${w}px`);
  }
  await p.close();
});

test('webview: the connection screens on the light theme, and deleting asks first', async () => {
  const p = await open('light');
  await shot(p, 'empty-light');
  await p.click('#modelBtn');
  await shot(p, 'menu-model-light');
  await p.keyboard.press('Escape');
  await p.click('nav.views [data-view="settings"]');
  await post(p, { type: 'connections', list: CONNS, providers: PROVIDERS, locked: {} });
  await shot(p, 'connections-light');
  await p.click('.crow[data-id="b2"] [data-c="del"]');
  assert.ok(await p.isVisible('.crow[data-id="b2"] .cconfirm'));
  assert.equal((await posted(p, 'conn')).filter((m: any) => m.action === 'delete').length, 0, 'nothing deleted before the confirmation');
  await p.click('.crow[data-id="b2"] [data-c="delyes"]');
  assert.deepEqual((await posted(p, 'conn')).at(-1), { type: 'conn', action: 'delete', id: 'b2' });
  assert.equal(await p.locator('.crow[data-id="a1"] [data-c="del"]').count(), 0, 'the connection in use cannot be deleted');
  await p.click('[data-c="add"]');
  await post(p, { type: 'connLocal', servers: [] });
  await shot(p, 'gallery-light');
  await p.click('.tile[data-p="openrouter"]');
  assert.equal(await p.inputValue('#cfUrl'), 'https://openrouter.ai/api/v1');
  assert.ok(await p.isVisible('a[href="https://openrouter.ai/keys"]'), 'a link to get a key');
  await shot(p, 'form-light');
  // behaviour: the permission modes are a list, not a dropdown
  await post(p, { type: 'settings', hasWorkspace: true, trusted: true, user: { file: '/home/u/.tugline/config.json', data: {} }, project: { file: '/w/.tugline/config.json', data: {} }, prefs: { permissionMode: 'ask', notifications: true, visibleTerminal: false } });
  await p.click('.stab[data-stab="behaviour"]');
  await p.click('.moderow.m-plan');
  assert.deepEqual((await posted(p, 'settings')).filter((m: any) => m.action === 'pref').at(-1), { type: 'settings', action: 'pref', key: 'permissionMode', value: 'plan' });
  await shot(p, 'behaviour-light');
  await p.close();
});

test('webview: a big paste becomes a chip, is sent whole, and shows collapsed in the chat', async () => {
  const p = await open();
  const log = ['Traceback (most recent call last):', ...Array.from({ length: 400 }, (_, i) => `  File "/srv/app/s${i}.py", line ${i}, in f${i}`), 'ValueError: bad input'].join('\n');
  await p.focus('#input');
  await p.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, log);
  assert.equal(await p.inputValue('#input'), '', 'the box is not flooded');
  assert.match(await p.textContent('#atts'), /Pasted text · 402 lines/);
  await p.fill('#input', 'Fix this error');
  await shot(p, 'paste-chip-dark');
  await p.click('#send');
  const sent = (await posted(p, 'send')).at(-1) as any;
  assert.equal(sent.text, `Fix this error\n\n${log}`, 'the whole log is sent');
  assert.equal(await p.isVisible('#atts'), false);
  assert.match(await p.textContent('.msg.user'), /Fix this error[\s\S]*Pasted text · 402 lines/);
  const h = await p.$eval('.msg.user .longtext .lt', (e) => e.getBoundingClientRect().height);
  assert.ok(h < 200, `collapsed (${h}px)`);
  await p.click('.msg.user [data-more]');
  assert.ok((await p.$eval('.msg.user .longtext .lt', (e) => e.getBoundingClientRect().height)) > h, 'Show all expands it');
  await shot(p, 'paste-sent-dark');
  // a small paste stays in the box
  await p.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'npm test');
    document.getElementById('input')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  assert.equal(await p.isVisible('#atts'), false);
  await p.close();
});

test('webview: a run renders on the light theme too (visual check)', async () => {
  const p = await open('light');
  await post(p, { type: 'userMessage', chatId: 'c1', uid: 'u1', text: 'The test in tests/test_calc.py fails. Fix calc.py.' });
  for (const e of [
    { type: 'tool_start', id: 't1', name: 'read_file', title: 'Read calc.py' },
    { type: 'tool_end', id: 't1', name: 'read_file', ok: true, output: 'def average(n): ...' },
    { type: 'text_delta', text: 'Fixed **average()**: an empty list now returns `0`.\n\n```python\nif not numbers:\n    return 0\n```' },
    { type: 'assistant_message' },
    { type: 'run_end', stopReason: 'end_turn', finalText: '', stats: { toolCalls: 1, filesChanged: ['calc.py'], durationMs: 4200, costUsd: 0 }, badge: { cls: 'ok', label: 'Verified', why: '`pytest` passed after the last edit.' } },
  ]) await post(p, { type: 'event', chatId: 'c1', event: e });
  assert.equal(await p.locator('pre.code .copy').count(), 1);
  await p.click('pre.code .copy');
  assert.deepEqual((await posted(p, 'copy')).at(-1), { type: 'copy', text: 'if not numbers:\n    return 0' });
  await shot(p, 'run-light');
  await p.close();
});
