/**
 * Live preview pane with an element picker (v1.1 N24), VS Code part.
 *
 * "Tugline: Open Preview" opens a webview showing a page (a dev server,
 * loopback by default) rendered by the E1 browser driver (headless Chromium
 * through Playwright, an isolated profile). Frames are the driver's own
 * screenshots, which keep its secret masking; clicks and wheel are passed
 * through. With "Pick element" on, a click maps the frame point to page CSS
 * pixels (DPR-aware, previewMap.ts), the page reports the element under it,
 * the driver resolves its accessibility-snapshot ref (E2), and the pick is
 * attached to the chat as `<attached_context source="element">` (ref,
 * role/name, selector, computed styles, likely source location) with an
 * `@path:lines` mention of the source in the composer.
 *
 * URL policy: top-level navigations must be on the preview allowlist
 * (`previewUrlAllowed`); every other request the page makes passes the web
 * SSRF guard with the same allowlist, behind the driver's egress proxy.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import type { ChatViewProvider } from './chat.js';
import { PlaywrightBrowserDriver } from '../../src/core/automation/browser/driver.js';
import { browserConfig } from '../../src/core/automation/browser/config.js';
import { assertPublicUrl } from '../../src/core/tools/web.js';
import { elementContext, findSourceLocation, framePointToPage, nodeAtPoint, previewUrlAllowed, sourceHints, sourceMention, type FrameGeometry, type PageElement, type PickedElement } from './previewMap.js';

/** Runs in the page: the element at a viewport point, a stable selector and a few computed styles. */
const ELEMENT_AT_POINT = String.raw`({ x, y }) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));
  const sel = (e) => {
    if (e.id) return '#' + esc(e.id);
    const t = e.getAttribute('data-testid');
    if (t) return '[data-testid="' + t.replace(/"/g, '\\"') + '"]';
    const parts = [];
    for (let n = e, d = 0; n && n.nodeType === 1 && d < 6; n = n.parentElement, d++) {
      if (n.id) { parts.unshift('#' + esc(n.id)); break; }
      let i = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
    }
    return parts.join(' > ');
  };
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const styles = {};
  for (const k of ['display', 'position', 'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'margin', 'padding', 'border', 'border-radius']) styles[k] = cs.getPropertyValue(k);
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    classes: Array.from(el.classList).slice(0, 8),
    text: ((el.innerText || el.textContent || '') + '').trim().slice(0, 300) || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    selector: sel(el),
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    styles,
  };
}`;

const SOURCE_GLOB = '**/*.{html,htm,jsx,tsx,js,mjs,ts,vue,svelte,astro,erb,php,hbs}';
const SOURCE_EXCLUDE = '**/{node_modules,dist,build,out,.git,.tugline,.next,coverage}/**';

export class PreviewPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private driver?: PlaywrightBrowserDriver;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private picking = false;
  /** last frame's geometry inputs (image size and dpr), for tests */
  lastFrame?: { width: number; height: number; dpr: number; url: string };
  lastPick?: PickedElement;
  lastError?: string;

  constructor(private provider: ChatViewProvider, private log: (m: string) => void) {}

  dispose(): void {
    this.stopFrames();
    void this.driver?.close().catch(() => undefined);
    this.driver = undefined;
    this.panel?.dispose();
  }

  private allowHosts(): string[] {
    return vscode.workspace.getConfiguration('tugline').get<string[]>('preview.allowHosts', []) ?? [];
  }

  private async ensureDriver(): Promise<PlaywrightBrowserDriver> {
    if (this.driver) return this.driver;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const cfg = this.provider.lastConfig ?? (await this.provider.buildConfig(ws));
    const b = browserConfig(cfg);
    const allow = () => this.allowHosts();
    this.driver = new PlaywrightBrowserDriver({
      homeDir: cfg.homeDir,
      headless: true,
      executablePath: b.executablePath,
      profile: 'isolated',
      engine: b.snapshotEngine,
      snapshotTokens: b.snapshotTokens,
      navigationTimeoutMs: b.navigationTimeoutMs,
      actionTimeoutMs: b.actionTimeoutMs,
      hooks: {
        checkUrl: async (u, info) => {
          const top = previewUrlAllowed(u.href, allow());
          if (top.ok) return undefined;
          if (info.navigation && info.mainFrame) return top.error;
          try {
            await assertPublicUrl(u, [...allow(), ...(cfg.web.allowHosts ?? [])]);
            return undefined;
          } catch (e) {
            return (e as Error).message;
          }
        },
        egress: { allowHosts: ['localhost', '127.0.0.1', '::1', ...allow(), ...(cfg.web.allowHosts ?? [])] },
      },
    });
    return this.driver;
  }

  /** Open (or focus) the panel on a URL. Returns an error message when the URL is refused. */
  async open(raw?: string): Promise<string | undefined> {
    const target = raw ?? (await vscode.window.showInputBox({ title: 'Tugline Preview: URL of the app (dev server)', value: 'http://localhost:3000', ignoreFocusOut: true }));
    if (!target) return undefined;
    const ok = previewUrlAllowed(target, this.allowHosts());
    if (!ok.ok) return this.fail(ok.error);
    this.showPanel();
    return this.navigate(ok.url.href);
  }

  private fail(message: string): string {
    this.lastError = message;
    this.log(`[preview] ${message}`);
    void this.panel?.webview.postMessage({ type: 'error', message });
    void vscode.window.showWarningMessage(`Tugline Preview: ${message}`);
    return message;
  }

  async navigate(url: string): Promise<string | undefined> {
    const ok = previewUrlAllowed(url, this.allowHosts());
    if (!ok.ok) return this.fail(ok.error);
    try {
      const d = await this.ensureDriver();
      const r = d.isOpen ? await d.navigate(ok.url.href) : await d.open(ok.url.href, { profile: 'isolated' });
      if (r.blocked) return this.fail(r.blocked);
      this.lastError = undefined;
      await this.frame();
      this.startFrames();
      return undefined;
    } catch (e) {
      return this.fail((e as Error).message);
    }
  }

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    this.panel = vscode.window.createWebviewPanel('tugline.preview', 'Tugline Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.panel.webview.html = previewHtml(nonce, this.panel.webview.cspSource);
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m).catch((e) => this.fail((e as Error).message)));
    this.panel.onDidChangeViewState(() => (this.panel?.visible ? this.startFrames() : this.stopFrames()));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopFrames();
      void this.driver?.close().catch(() => undefined);
      this.driver = undefined;
    });
  }

  private startFrames(): void {
    if (this.timer || !this.panel) return;
    this.timer = setInterval(() => void this.frame(), 700);
  }

  private stopFrames(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Capture one frame and post it to the webview. */
  async frame(): Promise<void> {
    const d = this.driver;
    if (!d?.isOpen || this.busy || !this.panel) return;
    this.busy = true;
    try {
      const shot = await d.screenshot();
      const url = String(d.page.url());
      this.lastFrame = { width: shot.viewport.width * shot.dpr, height: shot.viewport.height * shot.dpr, dpr: shot.dpr, url };
      void this.panel.webview.postMessage({ type: 'frame', data: shot.png.toString('base64'), dpr: shot.dpr, url, picking: this.picking });
    } catch (e) {
      this.log(`[preview] frame: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  setPicking(on: boolean): void {
    this.picking = on;
    void this.panel?.webview.postMessage({ type: 'picking', on });
  }

  async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'navigate':
        await this.navigate(String(m.url ?? ''));
        return;
      case 'reload':
        if (this.driver?.isOpen) await this.driver.navigate('reload');
        await this.frame();
        return;
      case 'picking':
        this.setPicking(!!m.on);
        return;
      case 'click': {
        const p = framePointToPage(m.offsetX, m.offsetY, m.geom as FrameGeometry);
        if (!p || !this.driver?.isOpen) return;
        if (this.picking) {
          await this.pickAt(p.x, p.y);
          this.setPicking(false);
        } else {
          await this.driver.page.mouse.click(p.x, p.y);
          await new Promise((r) => setTimeout(r, 150));
          await this.frame();
        }
        return;
      }
      case 'wheel':
        if (this.driver?.isOpen) await this.driver.page.mouse.wheel(0, Number(m.dy) || 0);
        await this.frame();
        return;
    }
  }

  /** Pick the element at a page point (CSS px of the viewport) and attach it to the active chat. */
  async pickAt(x: number, y: number): Promise<PickedElement | undefined> {
    const d = this.driver;
    if (!d?.isOpen) return undefined;
    const el: PageElement | null = await d.page.evaluate(`(${ELEMENT_AT_POINT})(${JSON.stringify({ x, y })})`);
    if (!el) return undefined;
    const pick: PickedElement = { ...el, url: String(d.page.url()) };
    // E2: the element's snapshot ref (and role/name) through its selector, else the smallest snapshot box at the point
    const viaSel = await d.refForSelector(el.selector).catch(() => ({ ref: undefined, count: 0 }));
    const node = viaSel.ref ? d.nodeFor(viaSel.ref) : d.latest ? nodeAtPoint(d.latest.root, x, y) : undefined;
    if (node) {
      pick.ref = node.ref;
      pick.role = node.role;
      pick.name = node.name;
    }
    pick.source = await this.findSource(el);
    this.lastPick = pick;
    this.provider.addContext(elementContext(pick), 'element');
    const mention = sourceMention(pick.source);
    if (mention) this.provider.insertInComposer(mention);
    void this.panel?.webview.postMessage({ type: 'picked', summary: `${pick.role ?? pick.tag}${pick.name ? ` "${pick.name}"` : ''} ${pick.ref ? `[${pick.ref}]` : ''} attached to the chat` });
    return pick;
  }

  private async findSource(el: PageElement): Promise<PickedElement['source']> {
    const hints = sourceHints(el);
    if (!hints.length) return undefined;
    const uris = await vscode.workspace.findFiles(SOURCE_GLOB, SOURCE_EXCLUDE, 400);
    const files: { path: string; text: string }[] = [];
    for (const u of uris) {
      try {
        if (fs.statSync(u.fsPath).size > 512 * 1024) continue;
        files.push({ path: vscode.workspace.asRelativePath(u, false), text: fs.readFileSync(u.fsPath, 'utf8') });
      } catch {
        /* unreadable */
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return findSourceLocation(files, hints);
  }
}

function previewHtml(nonce: string, csp: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${csp}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
.bar{display:flex;gap:6px;padding:6px;align-items:center;border-bottom:1px solid var(--vscode-panel-border)}
.bar input{flex:1;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px}
button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:4px 8px;cursor:pointer}
button.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
#wrap{padding:6px}#frame{max-width:100%;display:block;border:1px solid var(--vscode-panel-border)}
#frame.picking{cursor:crosshair;outline:2px solid var(--vscode-focusBorder)}
#msg{padding:4px 6px;font-size:12px;opacity:.85}
</style></head><body>
<div class="bar"><button id="reload" title="Reload">⟳</button><input id="url" placeholder="http://localhost:3000"><button id="go">Go</button><button id="pick" title="Click an element to attach it to the chat">Pick element</button></div>
<div id="msg"></div><div id="wrap"><img id="frame" alt="preview"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let dpr = 1, picking = false;
$('go').onclick = () => vscode.postMessage({ type: 'navigate', url: $('url').value });
$('url').onkeydown = (e) => { if (e.key === 'Enter') $('go').onclick(); };
$('reload').onclick = () => vscode.postMessage({ type: 'reload' });
$('pick').onclick = () => vscode.postMessage({ type: 'picking', on: !picking });
const img = $('frame');
img.onclick = (e) => {
  const r = img.getBoundingClientRect();
  vscode.postMessage({ type: 'click', offsetX: e.clientX - r.left, offsetY: e.clientY - r.top, geom: { displayedWidth: r.width, displayedHeight: r.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, dpr } });
};
img.onwheel = (e) => { e.preventDefault(); vscode.postMessage({ type: 'wheel', dy: e.deltaY }); };
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'frame') { dpr = m.dpr || 1; img.src = 'data:image/png;base64,' + m.data; if (document.activeElement !== $('url')) $('url').value = m.url; }
  else if (m.type === 'picking') { picking = m.on; $('pick').classList.toggle('on', picking); img.classList.toggle('picking', picking); $('msg').textContent = picking ? 'Click an element to attach it to the chat' : ''; }
  else if (m.type === 'picked') $('msg').textContent = m.summary;
  else if (m.type === 'error') $('msg').textContent = '⚠ ' + m.message;
});
</script></body></html>`;
}
