/**
 * Screenshot + page check.
 *
 * target='page': open a URL or local HTML file in headless Chromium (Playwright),
 *   capture a PNG and — like EAG S17's webcheck — report what a DOM assertion
 *   misses: uncaught JS errors, console errors, how much text is actually
 *   *visible*, and (optionally) the page with JavaScript disabled.
 * target='screen': capture the user's desktop (macOS screencapture, Linux
 *   import/gnome-screenshot, Windows PowerShell). Requires permission.
 *
 * The PNG is saved under .tugline/artifacts and, if the model has vision,
 * attached to the conversation. For full browser automation (click, type,
 * navigate) connect the Playwright MCP server (`npx @playwright/mcp@latest`).
 */
import { wrapUntrusted } from '../util/untrusted.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError, type ToolDef } from './types.js';
import { execCommand, scrubbedEnv } from './shell.js';
import { resolvePath } from './fs.js';
import { assertPublicUrl } from './web.js';
import { fileURLToPath } from 'node:url';

async function loadPlaywright(): Promise<any> {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      return await import(mod);
    } catch {
      /* try next */
    }
  }
  throw new ToolError('Playwright is not installed. Run: npm i -g playwright && npx playwright install chromium (or install Google Chrome; it is used automatically).');
}

async function launch(pw: any): Promise<any> {
  const errors: string[] = [];
  for (const opts of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try {
      return await pw.chromium.launch({ headless: true, ...opts });
    } catch (e) {
      errors.push((e as Error).message.split('\n')[0]);
    }
  }
  throw new ToolError(`could not launch a browser: ${errors.join(' | ')}. Run: npx playwright install chromium`);
}

export const screenshotTool: ToolDef<{ target?: 'page' | 'screen'; url?: string; path?: string; full_page?: boolean; width?: number; height?: number; wait_ms?: number; check_no_js?: boolean }> = {
  name: 'screenshot',
  kind: 'network',
  readOnly: true,
  description:
    'Take a screenshot. target="page" (default) renders a URL or a local HTML file in a headless browser and reports JS errors, console errors and how much text is visible ' +
    '(use it to verify web pages you build — a page can look fine in code and be blank in a browser). target="screen" captures the user\'s desktop. ' +
    'The image is attached if the model supports vision; otherwise the textual report is returned.',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['page', 'screen'] },
      url: { type: 'string', description: 'http(s) URL to render' },
      path: { type: 'string', description: 'Local HTML file to render (opened via file://)' },
      full_page: { type: 'boolean' },
      width: { type: 'integer', description: 'Viewport width (default 1280)' },
      height: { type: 'integer', description: 'Viewport height (default 800)' },
      wait_ms: { type: 'integer', description: 'Extra wait after load (default 800)' },
      check_no_js: { type: 'boolean', description: 'Also load the page with JavaScript disabled and report visible text' },
    },
  },
  title: (a) => (a.target === 'screen' ? 'Screenshot of the screen' : `Screenshot ${a.url ?? a.path}`),
  permissionInput: (a, ctx) => {
    if (a.target === 'screen') return { forceAsk: 'captures your whole screen' };
    if (a.path) return { paths: [{ path: resolvePath(ctx, a.path), write: false }] };
    const u = new URL(String(a.url ?? ''));
    if (u.protocol === 'file:') return { paths: [{ path: fileURLToPath(u), write: false }] };
    return { domain: u.hostname };
  },
  async run(a, ctx) {
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
    const file = path.join(ctx.artifactsDir, `screenshot-${Date.now()}.png`);
    if (a.target === 'screen') {
      let res;
      if (process.platform === 'darwin') res = await execCommand({ argv: ['screencapture', '-x', file], cwd: ctx.workspace, timeoutMs: 20_000, env: scrubbedEnv([]) });
      else if (process.platform === 'win32')
        res = await execCommand({
          argv: ['powershell', '-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${file}')`],
          cwd: ctx.workspace, timeoutMs: 20_000, env: scrubbedEnv([]),
        });
      else {
        res = await execCommand({ argv: ['import', '-window', 'root', file], cwd: ctx.workspace, timeoutMs: 20_000, env: scrubbedEnv([]) });
        if (res.exitCode !== 0) res = await execCommand({ argv: ['gnome-screenshot', '-f', file], cwd: ctx.workspace, timeoutMs: 20_000, env: scrubbedEnv([]) });
      }
      if (!fs.existsSync(file)) throw new ToolError(`screen capture failed: ${res.output.slice(0, 300)}`);
      const b64 = fs.readFileSync(file).toString('base64');
      return { output: `Captured the screen → ${file}${ctx.vision ? ' (image attached)' : ' (model has no vision; image not shown)'}`, images: ctx.vision ? [{ mimeType: 'image/png', base64: b64 }] : undefined, meta: { file, untrusted: true } };
    }
    let target: string;
    if (a.path) {
      const abs = resolvePath(ctx, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`file not found: ${a.path}`);
      target = pathToFileURL(abs).toString();
    } else if (a.url) {
      const u = new URL(a.url);
      if (u.protocol === 'file:') {
        const abs = fileURLToPath(u);
        if (!fs.existsSync(abs)) throw new ToolError(`file not found: ${abs}`);
        target = u.toString();
      } else if (u.protocol === 'http:' || u.protocol === 'https:') {
        // Loopback is allowed (local dev servers); private networks and cloud metadata are not.
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
        if (!loopback) await assertPublicUrl(u, ctx.config.web.allowHosts ?? []);
        target = u.toString();
      } else throw new ToolError(`unsupported URL scheme ${u.protocol}`);
    } else throw new ToolError('pass url or path');
    const pw = await loadPlaywright();
    const browser = await launch(pw);
    const report: string[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: a.width ?? 1280, height: a.height ?? 800 } });
      const pageErrors: string[] = [];
      const consoleErrors: string[] = [];
      page.on('pageerror', (e: Error) => pageErrors.push(e.message));
      page.on('console', (m: any) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      const resp = await page.goto(target, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(a.wait_ms ?? 800);
      await page.screenshot({ path: file, fullPage: !!a.full_page });
      // Passed as a string so transpiler helpers (e.g. esbuild's __name) are never injected into the page.
      const info = (await page.evaluate(`(() => {
        const visible = (el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0;
        };
        let chars = 0;
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const p = n.parentElement;
          if (p && visible(p)) chars += (n.textContent || '').trim().length;
        }
        return { title: document.title, visibleChars: chars, text: ((document.body && document.body.innerText) || '').slice(0, 1500) };
      })()`)) as { title: string; visibleChars: number; text: string };
      report.push(`Rendered ${target} (HTTP ${resp?.status() ?? 'n/a'}) → ${file}`);
      report.push(`title: ${info.title || '(none)'} | visible characters: ${info.visibleChars}`);
      report.push(pageErrors.length ? `UNCAUGHT JS ERRORS:\n- ${pageErrors.slice(0, 10).join('\n- ')}` : 'uncaught JS errors: none');
      if (consoleErrors.length) report.push(`console errors:\n- ${consoleErrors.slice(0, 10).join('\n- ')}`);
      if (info.visibleChars < 50) report.push('WARNING: almost no visible text — the page may be blank to a user (opacity/animation never ran, script crashed, or content not rendered).');
      if (a.check_no_js) {
        const ctxNoJs = await browser.newContext({ javaScriptEnabled: false });
        const p2 = await ctxNoJs.newPage();
        await p2.goto(target, { waitUntil: 'load', timeout: 30_000 });
        const t = (await p2.evaluate(`(document.body && document.body.innerText) || ''`)) as string;
        report.push(`with JavaScript disabled: ${t.trim().length} characters of text`);
      }
      report.push(`visible text excerpt:\n${info.text.slice(0, 800)}`);
    } finally {
      await browser.close().catch(() => {});
    }
    const b64 = fs.readFileSync(file).toString('base64');
    return { output: wrapUntrusted('web_content', { source: 'screenshot' }, report.join('\n')), images: ctx.vision ? [{ mimeType: 'image/png', base64: b64 }] : undefined, meta: { file, untrusted: true } };
  },
};
