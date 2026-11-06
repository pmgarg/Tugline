/**
 * Electron escape hatch (SPEC F5; research CU §2.6, S10). VS Code, Slack,
 * Notion, Discord … show the accessibility API one opaque web area. With the
 * user's consent we relaunch the app with a local debugging port, attach with
 * Playwright `connectOverCDP`, and drive its DOM with the same BrowserDriver
 * (E1) the browser tools use: aria snapshot, `e` refs, scan-act-verify.
 *
 * Safety (research CU §2.6, S11 "ClawJacked"): the port binds to 127.0.0.1,
 * is random, and the relaunched app is closed when the session ends; the
 * relaunch is never done without asking (unsaved work in the app may be lost);
 * the harness never relaunches the editor or terminal it runs in.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PlaywrightBrowserDriver } from '../browser/driver.js';
import type { RawApp } from './backend.js';
import { isKnownElectron } from './traps.js';
import { killProcessTree, listProcesses, type ProcInfo } from '../../util/procs.js';

export function detectElectron(app: Pick<RawApp, 'name' | 'bundleId' | 'path'> | undefined, extra: string[] = []): boolean {
  if (!app) return false;
  if (isKnownElectron(app, extra)) return true;
  // Look next to the executable for the Electron markers (macOS framework, resources/app.asar).
  const exe = app.path;
  if (!exe) return false;
  try {
    const mac = exe.match(/^(.*?\.app)(\/|$)/);
    if (mac && fs.existsSync(path.join(mac[1], 'Contents', 'Frameworks', 'Electron Framework.framework'))) return true;
    return fs.existsSync(path.join(path.dirname(exe), 'resources', 'app.asar'));
  } catch {
    return false;
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForCdp(port: number, timeoutMs: number, proc?: ChildProcess): Promise<string> {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) throw new Error(`the app exited (${proc.exitCode}) before opening its debugging port`);
    try {
      const r = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return url;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no DevTools endpoint on ${url} after ${timeoutMs} ms (${last}); the app may strip debugging switches`);
}

export interface RelaunchSpec {
  app: string;
  /** Executable (Linux/Windows) or .app bundle path (macOS). */
  exe?: string;
  args?: string[];
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export interface Relaunched {
  cdpUrl: string;
  port: number;
  proc?: ChildProcess;
  userDataDir?: string;
  stop(): Promise<void>;
}

/**
 * The executable to run for a macOS app: a plain executable file as given
 * (e.g. `…/Foo.app/Contents/MacOS/Foo`), or the one an `.app` bundle's
 * Info.plist names (CFBundleExecutable). Running it directly, rather than via
 * `open -na`, makes it our child: we know its pid and process group and can
 * close it with the session (`open` hands the app to launchd, which is how
 * F5 left Chrome-for-Testing running on macOS).
 */
export function macExecutable(target: string): string | undefined {
  try {
    if (fs.statSync(target).isFile()) return target;
  } catch {
    return undefined;
  }
  const bundle = target.replace(/\/+$/, '');
  if (!/\.app$/i.test(bundle)) return undefined;
  let named: string | undefined;
  try {
    named = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8').match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  } catch {
    /* binary plist or unreadable: fall back to the bundle name */
  }
  for (const n of [named, path.basename(bundle, path.extname(bundle))]) {
    const f = n && path.join(bundle, 'Contents', 'MacOS', n);
    if (f && fs.existsSync(f)) return f;
  }
  return undefined;
}

/** The value of `--user-data-dir=` in an argument list (the relaunched app's private profile, if the user gave one). */
function userDataDirOf(args: string[]): string | undefined {
  const a = args.find((x) => x.startsWith('--user-data-dir='));
  return a?.slice('--user-data-dir='.length) || undefined;
}

/** Relaunch an Electron app with a random 127.0.0.1 debugging port. The caller has already asked and quit the app. */
export async function relaunchWithDebugPort(s: RelaunchSpec): Promise<Relaunched> {
  const port = await freePort();
  const platform = s.platform ?? process.platform;
  const dbg = [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'];
  const extra = s.args ?? [];
  let proc: ChildProcess | undefined;
  const exe = platform === 'darwin' ? (s.exe ? macExecutable(s.exe) : undefined) : s.exe;
  if (platform === 'darwin' && !exe) {
    // Only an app name (or a bundle we cannot read): `open -na` starts a new instance; we find its pid by the port below.
    const o = spawn('open', ['-na', s.exe ?? s.app, '--args', ...dbg, ...extra], { stdio: 'ignore' });
    o.on('error', () => undefined);
    o.unref();
  } else {
    if (!exe) throw new Error(`do not know where ${s.app} is installed: set desktop.electronPaths["${s.app}"]`);
    const args = [...dbg, ...extra];
    if (process.getuid?.() === 0 && !args.includes('--no-sandbox')) args.unshift('--no-sandbox');
    // Own process group (off Windows), so stop() reaches the app's helper processes too.
    proc = spawn(exe, args, { stdio: 'ignore', detached: platform !== 'win32' });
    proc.on('error', () => undefined);
  }
  const profile = userDataDirOf(extra);
  const profiles = profile ? [profile, ...(fs.existsSync(profile) ? [fs.realpathSync(profile)] : [])] : [];
  // Helpers that leave the process group (Chrome's crashpad handler calls setsid and is reparented) still name the port or the profile.
  const match = (p: ProcInfo) => p.args.includes(`--remote-debugging-port=${port}`) || profiles.some((d) => p.args.includes(d));
  const stop = async () => {
    const pid = proc?.pid ?? listProcesses().find((p) => p.args.includes(`--remote-debugging-port=${port}`))?.pid;
    await killProcessTree(pid, { group: !!proc && platform !== 'win32', match, graceMs: 1500, waitMs: 5000 });
  };
  const cdpUrl = await waitForCdp(port, s.timeoutMs ?? 20_000, proc).catch(async (e) => {
    await stop();
    throw e;
  });
  return { cdpUrl, port, proc, userDataDir: profile, stop };
}

/** One relaunched Electron app, attached through CDP and driven by the BrowserDriver. */
export class ElectronBridge {
  readonly windowId: string;
  readonly driver: PlaywrightBrowserDriver;

  constructor(readonly app: string, readonly launched: Relaunched, o: { homeDir: string; mask?: (s: string) => string; secretValues?: () => string[]; snapshotTokens?: number }) {
    this.windowId = `cdp:${app}`;
    this.driver = new PlaywrightBrowserDriver({
      homeDir: o.homeDir || os.tmpdir(),
      profile: 'attached',
      cdpUrl: launched.cdpUrl,
      adoptExistingPages: true,
      engine: 'auto',
      snapshotTokens: o.snapshotTokens,
      hooks: { mask: o.mask, secretValues: o.secretValues },
    });
  }

  async attach(): Promise<void> {
    await this.driver.ensureLaunched('attached');
  }

  async title(): Promise<string> {
    try {
      return String(await this.driver.page.title());
    } catch {
      return this.app;
    }
  }

  async close(): Promise<void> {
    await this.driver.close().catch(() => undefined);
    await this.launched.stop();
  }
}
