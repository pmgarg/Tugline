/**
 * Playwright loading and browser launch (SPEC E1, E6).
 *
 * Playwright is an optional dependency, imported lazily: `playwright`, then
 * `playwright-core` (which ships no browsers, so we look for one). Browser
 * discovery, first hit wins:
 *   browser.executablePath → $TUG_CHROMIUM_PATH → Playwright's expected build →
 *   any Chromium already in the Playwright browsers dir (a version mismatch
 *   between the npm package and the downloaded build is common behind
 *   firewalls; we never run `playwright install`) → system Chrome channel.
 *
 * Profiles:
 *   isolated            fresh context per session (default, lowest risk)
 *   persistent:<name>   ~/.tugline/browser-profiles/<name> (alias site:<name>)
 *   attached            connectOverCDP to the user's Chrome (E6; consent elsewhere)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree } from '../../util/procs.js';
import { extensionHub, type RelayOptions } from './extension/hub.js';

export class BrowserLaunchError extends Error {}

export async function loadPlaywright(): Promise<any> {
  const errors: string[] = [];
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const m: any = await import(mod);
      return m.chromium ? m : m.default;
    } catch (e) {
      errors.push(`${mod}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new BrowserLaunchError(`Playwright is not installed (${errors.join('; ')}). Install it with: npm i playwright`);
}

/** Does this Playwright build have the AI snapshot API (1.59+ mode:'ai', 1.64 getByRef)? */
export function hasAriaRefs(page: any): boolean {
  return typeof page?.ariaSnapshotJSON === 'function' && typeof page?.getByRef === 'function';
}

function browsersDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

/** Installed Playwright Chromium builds, newest first. Headless-shell builds first when headless. */
export function installedChromiums(headless: boolean): string[] {
  const dir = browsersDir();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const rel: Record<string, string[]> = {
    chromium_headless_shell: ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-linux/headless_shell'],
    chromium: ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-win/chrome.exe', 'chrome-win64/chrome.exe'],
  };
  const found: { file: string; build: number; shell: boolean }[] = [];
  for (const e of entries) {
    const m = e.match(/^(chromium_headless_shell|chromium)-(\d+)$/);
    if (!m) continue;
    for (const r of rel[m[1]]) {
      const f = path.join(dir, e, r);
      if (fs.existsSync(f)) found.push({ file: f, build: Number(m[2]), shell: m[1] === 'chromium_headless_shell' });
    }
  }
  found.sort((a, b) => (headless ? Number(b.shell) - Number(a.shell) : Number(a.shell) - Number(b.shell)) || b.build - a.build);
  return found.map((f) => f.file);
}

/** A full Chromium (not the headless shell): needed to start a debuggable browser for attach tests. */
export function fullChromium(): string | undefined {
  return installedChromiums(false).find((f) => !/headless/.test(f));
}

export function resolveExecutable(pw: any, explicit: string | undefined, headless: boolean): string | undefined {
  if (explicit) return explicit;
  if (process.env.TUG_CHROMIUM_PATH) return process.env.TUG_CHROMIUM_PATH;
  try {
    const def = pw.chromium.executablePath();
    if (def && fs.existsSync(def)) return undefined; // Playwright's own build is present: let it choose (headless shell etc.)
  } catch {
    /* fall through */
  }
  return installedChromiums(headless)[0];
}

/**
 * Flags for every browser we launch. WebRTC's UDP is not sent through an HTTP
 * proxy, so without these a page could reach internal hosts (STUN/TURN to
 * private addresses) around the egress guard: allow only proxied traffic.
 */
export const LAUNCH_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

export interface LaunchOptions {
  headless: boolean;
  executablePath?: string;
  profile: string;
  homeDir: string;
  cdpUrl?: string;
  viewport?: { width: number; height: number };
  /** Route all browser traffic through this proxy (the egress guard). Ignored when attached. */
  proxy?: string;
  /** profile "extension" (N29): the relay's policy and hooks. */
  extension?: RelayOptions;
}

export interface Launched {
  browser?: any;
  context: any;
  /** Attached mode: do not close the user's browser on exit. */
  attached: boolean;
  profile: string;
  close(): Promise<void>;
}

const CONTEXT_OPTS = (o: LaunchOptions) => ({ acceptDownloads: true, viewport: o.viewport ?? { width: 1280, height: 800 }, locale: 'en-US' });

export function profileDir(homeDir: string, name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new BrowserLaunchError(`invalid profile name "${name}" (letters, digits, _ . - only)`);
  return path.join(homeDir, 'browser-profiles', name);
}

export async function launch(o: LaunchOptions): Promise<Launched> {
  const pw = await loadPlaywright();
  const exe = resolveExecutable(pw, o.executablePath, o.headless);
  // Playwright forces loopback through the proxy too (<-loopback> bypass rule), so localhost is guarded as well.
  const base = { headless: o.headless, args: [...LAUNCH_ARGS], ...(exe ? { executablePath: exe } : {}), ...(o.proxy ? { proxy: { server: o.proxy } } : {}) };
  const tryLaunch = async (fn: (opts: any) => Promise<any>): Promise<any> => {
    const errors: string[] = [];
    for (const extra of exe ? [{}] : [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
      try {
        return await fn({ ...base, ...extra });
      } catch (e) {
        errors.push((e as Error).message.split('\n')[0]);
      }
    }
    throw new BrowserLaunchError(`could not launch a browser: ${errors.join(' | ')}. Set browser.executablePath to a Chrome/Chromium binary.`);
  };
  if (o.profile === 'attached') {
    if (!o.cdpUrl) throw new BrowserLaunchError('attached profile needs browser.cdpUrl (e.g. http://127.0.0.1:9222). Start Chrome with --remote-debugging-port=9222 --user-data-dir=<a non-default dir> (Chrome 136+ ignores the port for the default profile).');
    const browser = await pw.chromium.connectOverCDP(o.cdpUrl, { timeout: 15_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext(CONTEXT_OPTS(o)));
    // For a connected browser, close() only disconnects (the user's Chrome keeps running; asserted in tests).
    return { browser, context, attached: true, profile: 'attached', close: () => browser.close().catch(() => undefined) };
  }
  if (o.profile === 'extension') {
    // N29: the user's real browser through the Tugline extension (tabs they shared), via the hub's CDP relay.
    const hub = extensionHub(o.homeDir);
    if (!hub?.connected) throw new BrowserLaunchError('the Tugline browser extension is not connected. Load browser-extension/ (chrome://extensions → Load unpacked), pair it with `tug browser-extension pair`, keep `tug serve` running, and share a tab with the toolbar button.');
    const relay = await hub.openRelay(o.extension ?? { policy: { coreSites: [], allowHosts: [] } });
    try {
      const browser = await pw.chromium.connectOverCDP(relay.endpoint, { timeout: 15_000 });
      const context = browser.contexts()[0];
      if (!context) throw new BrowserLaunchError('the extension relay exposed no browser context');
      return {
        browser,
        context,
        attached: true,
        profile: 'extension',
        close: async () => {
          await browser.close().catch(() => undefined);
          await relay.close();
        },
      };
    } catch (e) {
      await relay.close();
      throw e;
    }
  }
  const persistent = o.profile.match(/^(?:persistent|site):(.+)$/);
  if (persistent) {
    const dir = profileDir(o.homeDir, persistent[1]);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const context = await tryLaunch((opts) => pw.chromium.launchPersistentContext(dir, { ...opts, ...CONTEXT_OPTS(o) }));
    return { context, attached: false, profile: o.profile, close: () => context.close().catch(() => undefined) };
  }
  if (o.profile !== 'isolated') throw new BrowserLaunchError(`unknown browser profile "${o.profile}": use isolated, persistent:<name>, attached or extension`);
  const browser = await tryLaunch((opts) => pw.chromium.launch(opts));
  const context = await browser.newContext(CONTEXT_OPTS(o));
  return { browser, context, attached: false, profile: 'isolated', close: () => browser.close().catch(() => undefined) };
}

// ------------------------------------------------------------ debuggable Chrome (E6 guidance and tests)

export interface DebugChrome {
  cdpUrl: string;
  proc: ChildProcess;
  userDataDir: string;
  stop(): Promise<void>;
}

/**
 * Start a Chromium with a CDP port on 127.0.0.1 and a NON-default, temporary
 * user-data-dir (Chrome 136+ refuses the port for the default profile). Used by
 * tests and by `/browser attach-test`; users normally start their own Chrome.
 */
export async function startDebugChrome(opts: { executablePath?: string; headless?: boolean } = {}): Promise<DebugChrome> {
  const exe = opts.executablePath ?? process.env.TUG_CHROMIUM_PATH ?? fullChromium();
  if (!exe) throw new BrowserLaunchError('no Chromium binary found to start with a debug port');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-cdp-'));
  const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', ...(opts.headless !== false ? ['--headless=new'] : []), 'about:blank'];
  if (process.getuid?.() === 0) args.unshift('--no-sandbox');
  // Own process group, so stop() reaches Chrome's helper processes too.
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  const cdpUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new BrowserLaunchError(`Chromium did not report a DevTools port: ${buf.slice(-500)}`)), 20_000);
    proc.stderr!.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(t);
        const u = new URL(m[1]);
        resolve(`http://${u.host}`);
      }
    });
    proc.on('exit', (c) => {
      clearTimeout(t);
      reject(new BrowserLaunchError(`Chromium exited (${c}) before opening the debug port: ${buf.slice(-500)}`));
    });
  });
  return {
    cdpUrl,
    proc,
    userDataDir,
    stop: async () => {
      // SIGTERM, then SIGKILL, to the group, every descendant and any helper that left the group but
      // still names our private profile (Chrome's crashpad handler on macOS is reparented to launchd), R7.
      await killProcessTree(proc.pid, { group: process.platform !== 'win32', match: (p) => p.args.includes(userDataDir), graceMs: 3000, waitMs: 5000 });
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}
