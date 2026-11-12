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
  await post(p, { type: 'status', chatId: 'c1', model: 'qwen3-coder-30b', baseUrl: 'https://ai.example.com/api', mode: 'ask', running: false, picker: [{ value: 'profile:fast', label: 'fast (qwen3-4b)', group: 'profiles' }, { value: 'model:llama-3.3-70b', label: 'llama-3.3-70b', group: 'models' }, { value: 'model:qwen3-coder-30b', label: 'qwen3-coder-30b', group: 'models' }], choice: '', effort: 'default' });
  return p;
}
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
  await shot(p, 'empty-dark');
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
  await p.fill('#menuFilter', 'llama');
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
  await p.close();
});

test('webview: the model, base URL and API key are set in the panel (no command palette)', async () => {
  const p = await open();
  // "Model and API key" on the empty chat opens the settings at the model card
  await p.click('.empty a[data-act="cfg"]');
  assert.equal(await p.isVisible('#view-settings'), true);
  assert.deepEqual(await posted(p, 'configure'), [], 'not the palette wizard');
  assert.ok((await posted(p, 'settings')).some((m: any) => m.action === 'load'));
  await post(p, { type: 'settings', hasWorkspace: true, trusted: true, user: { file: '/home/u/.tugline/config.json', data: {} }, project: { file: '/w/.tugline/config.json', data: {} }, endpoint: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder:30b', contextWindow: 32768, maxOutputTokens: 8192, toolMode: 'auto', hasKey: false, locked: {} }, prefs: { permissionMode: 'ask', notifications: true, visibleTerminal: false } });
  assert.equal(await p.inputValue('#epUrl'), 'http://localhost:11434/v1');
  assert.equal(await p.inputValue('#epPreset'), 'ollama');
  // a company server: pick the provider, type the URL and key, load the models, pick one
  await p.selectOption('#epPreset', 'company');
  assert.equal(await p.inputValue('#epUrl'), '');
  await p.fill('#epUrl', 'https://ai.example.com/api');
  await p.fill('#epKey', 'sk-test-123');
  await p.click('#epLoad');
  const req = (await posted(p, 'settings')).filter((m: any) => m.action === 'endpointModels').at(-1) as any;
  assert.deepEqual({ baseUrl: req.baseUrl, apiKey: req.apiKey }, { baseUrl: 'https://ai.example.com/api', apiKey: 'sk-test-123' });
  await post(p, { type: 'endpointModels', reqId: req.reqId, models: [{ id: 'qwen3-coder-30b', tags: ['coder'] }, { id: 'llama-3.3-70b', tags: [] }] });
  assert.match(await p.textContent('#epModels'), /2 models on this endpoint/);
  await p.click('#epModels .mi[data-model="llama-3.3-70b"]');
  assert.equal(await p.inputValue('#epModel'), 'llama-3.3-70b');
  await shot(p, 'settings-dark');
  await p.click('#epSave');
  const save = (await posted(p, 'settings')).filter((m: any) => m.action === 'saveEndpoint').at(-1);
  assert.deepEqual(save, { type: 'settings', action: 'saveEndpoint', baseUrl: 'https://ai.example.com/api', apiKey: 'sk-test-123', model: 'llama-3.3-70b', contextWindow: 32768, maxOutputTokens: 8192, toolMode: 'auto' });
  assert.match(await p.textContent('#epResult'), /Saving and testing llama-3\.3-70b/);
  await post(p, { type: 'endpointResult', ok: true, model: 'llama-3.3-70b', report: { chatOk: true, nativeTools: true, textTools: false, latencyMs: 1800, errors: [] } });
  assert.match(await p.textContent('#epResult'), /Connected to llama-3\.3-70b[\s\S]*native tool calls/);
  assert.equal(await p.inputValue('#epKey'), '', 'the key is not kept in the page after saving');
  await shot(p, 'settings-saved-dark');
  // a narrow sidebar: nothing overflows sideways
  await p.setViewportSize({ width: 260, height: 760 });
  assert.equal(await p.$eval('#settings', (e) => e.scrollWidth <= e.clientWidth + 1), true, 'no horizontal scroll');
  await p.click('details.more summary');
  // what sticks out past the settings page's right edge (empty when nothing does)
  const overflow = () => p.$eval('#settings', (root) => { const lim = root.getBoundingClientRect().right; return [...root.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > lim + 1).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e as HTMLElement).className}`).slice(0, 8); });
  for (const w of [180, 150]) {
    await p.setViewportSize({ width: w, height: 760 });
    assert.deepEqual(await overflow(), [], `nothing sticks out at ${w}px`);
  }
  await p.setViewportSize({ width: 260, height: 760 });
  assert.ok((await p.$eval('#epModel', (e) => e.getBoundingClientRect().width)) > 120, 'the model box stays usable');
  assert.equal(await p.$eval('#epKey', (e) => e.getBoundingClientRect().right <= e.closest('.card')!.getBoundingClientRect().right), true, 'the key box fits its card');
  await shot(p, 'settings-narrow-dark');
  await p.setViewportSize({ width: 420, height: 760 });
  // a chat website's address: the error and the API address the host found
  await p.fill('#epUrl', 'https://ai.example.com');
  await p.click('#epLoad');
  const req2 = (await posted(p, 'settings')).filter((m: any) => m.action === 'endpointModels').at(-1) as any;
  await post(p, { type: 'endpointModels', reqId: req2.reqId, models: [], error: 'https://ai.example.com answered with a web page, not an OpenAI-compatible API.', suggestBaseUrl: 'https://ai.example.com/api' });
  await p.click('[data-ep="useSuggest"]');
  assert.equal(await p.inputValue('#epUrl'), 'https://ai.example.com/api');
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
