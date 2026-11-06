/**
 * Fallback sidecars (SPEC F9; research CU §5.5): JSON-RPC 2.0 over stdio, one
 * JSON object per line, same methods on every OS:
 *
 *   linux   sidecars/linux_atspi.py   (python3 + gi Atspi; xdotool on X11)
 *   win32   sidecars/windows_uia.ps1  (PowerShell + System.Windows.Automation)
 *   sandbox `docker exec -i <container> python3 /opt/tugline/linux_atspi.py` (F10)
 *
 * The sidecar is harness infrastructure (like cua-driver), not a command the
 * model chose, so it is not run through the shell command wrappers; it gets
 * the scrubbed environment. It exits on stdin EOF, so it can never outlive us.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrubbedEnv } from '../../tools/shell.js';
import { BackendError, desktopSessionEnv, type BackendHealth, type DesktopBackend, type ElementAction, type RawActResult, type RawApp, type RawElement, type RawWindow, type RawWindowState } from './backend.js';

export const SIDECAR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidecars');
export const LINUX_SIDECAR = path.join(SIDECAR_DIR, 'linux_atspi.py');
export const WINDOWS_SIDECAR = path.join(SIDECAR_DIR, 'windows_uia.ps1');

/** The methods every sidecar implements (checked against both scripts in tests). */
export const SIDECAR_METHODS = ['ping', 'health', 'list_apps', 'list_windows', 'snapshot', 'act', 'set_value', 'type_text', 'press_key', 'menu', 'scroll', 'pointer', 'screenshot', 'clipboard', 'launch', 'activate', 'quit', 'shutdown'] as const;

/**
 * NDJSON framing: split a byte stream into JSON messages. Tolerates CRLF
 * (PowerShell), partial lines across chunks, several messages per chunk, a
 * UTF-8 BOM and non-JSON noise lines (a library printing a warning).
 */
export class NdjsonParser {
  private buf = '';
  noise: string[] = [];
  push(chunk: string | Buffer): unknown[] {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '').replace(/^﻿/, '').trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        if (this.noise.length < 50) this.noise.push(line.slice(0, 300));
      }
    }
    return out;
  }
}

export function encodeRequest(id: number, method: string, params: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** First Python that can `import gi` (the system one; a /usr/local python usually lacks gi). */
export function findGiPython(explicit?: string): string | undefined {
  const candidates = [explicit, '/usr/bin/python3', 'python3', ...['3.13', '3.12', '3.11', '3.10'].map((v) => `/usr/bin/python${v}`)].filter((x): x is string => !!x);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import gi; gi.require_version("Atspi", "2.0"); from gi.repository import Atspi'], { timeout: 8000, stdio: 'ignore' });
      if (r.status === 0) return c;
    } catch {
      /* next */
    }
  }
  return undefined;
}

export function defaultSidecarCommand(platform: NodeJS.Platform, o: { python?: string; powershell?: string } = {}): string[] | undefined {
  if (platform === 'linux') {
    const py = findGiPython(o.python);
    return py ? [py, LINUX_SIDECAR] : undefined;
  }
  if (platform === 'win32') return [o.powershell ?? 'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SIDECAR];
  return undefined;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class SidecarBackend implements DesktopBackend {
  readonly name: string;
  private proc?: ChildProcess;
  private parser = new NdjsonParser();
  private pending = new Map<number, Pending>();
  private seq = 0;
  private stderr = '';
  private wins = new Map<string, RawWindow>();
  private exited?: string;

  constructor(readonly command: string[], readonly o: { name?: string; timeoutMs?: number; env?: Record<string, string>; cwd?: string } = {}) {
    this.name = o.name ?? `sidecar:${path.basename(command[command.length - 1] ?? 'sidecar')}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(): Promise<void> {
    if (this.proc && !this.exited) return;
    const [file, ...args] = this.command;
    if (!file) throw new BackendError('no sidecar command for this platform', 'unavailable');
    const env = { ...scrubbedEnv([]), ...desktopSessionEnv(), ...(this.o.env ?? {}) } as NodeJS.ProcessEnv;
    this.exited = undefined;
    // Own process group so shutdown also reaches anything the sidecar's wrapper started (xvfb-run, dbus).
    const proc = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: this.o.cwd, detached: process.platform !== 'win32' });
    this.proc = proc;
    proc.stdout!.on('data', (d) => {
      for (const m of this.parser.push(d)) this.onMessage(m as any);
    });
    proc.stderr!.on('data', (d) => {
      this.stderr = (this.stderr + String(d)).slice(-4000);
    });
    proc.on('error', (e) => this.onExit(`failed to start: ${e.message}`));
    proc.on('exit', (code, sig) => this.onExit(`exited (${code ?? sig})`));
    proc.stdin!.on('error', () => undefined);
    const pong = await this.call('ping', {}, this.o.timeoutMs ?? 30_000).catch((e) => {
      throw new BackendError(`desktop sidecar did not answer: ${(e as Error).message}${this.stderr ? `\n${this.stderr.slice(-800)}` : ''}`, 'unavailable');
    });
    if (!pong?.pong) throw new BackendError('desktop sidecar answered ping with something unexpected', 'unavailable');
  }

  private onExit(why: string): void {
    this.exited = why;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BackendError(`desktop sidecar ${why}${this.stderr ? `: ${this.stderr.slice(-500)}` : ''}`, 'unavailable'));
      this.pending.delete(id);
    }
  }

  private onMessage(m: { id?: number; result?: unknown; error?: { message: string; data?: { code?: string } } }): void {
    if (typeof m?.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new BackendError(m.error.message, m.error.data?.code ?? 'interaction_failed'));
    else p.resolve(m.result);
  }

  call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<any> {
    if (!this.proc || this.exited) return Promise.reject(new BackendError(`desktop sidecar is not running${this.exited ? ` (${this.exited})` : ''}`, 'unavailable'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BackendError(`desktop sidecar timed out on ${method}`, 'timeout'));
      }, timeoutMs ?? this.o.timeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(encodeRequest(id, method, params));
    });
  }

  private async actCall(method: string, params: Record<string, unknown>): Promise<RawActResult> {
    try {
      const r = await this.call(method, params);
      return { ok: true, effect: r?.effect ?? 'unverifiable', message: r?.summary };
    } catch (e) {
      const code = (e as BackendError).code;
      return { ok: false, effect: code === 'permission_denied' ? 'refused' : 'failed', code, message: (e as Error).message };
    }
  }

  // ------------------------------------------------------------ DesktopBackend

  async health(): Promise<BackendHealth> {
    const h = await this.call('health');
    return { ok: !!h.ok, version: h.version, permissions: h.permissions, message: h.message ?? (h.tools ? `tools: ${Object.entries(h.tools).map(([k, v]) => `${k}${v ? '' : ' (missing)'}`).join(', ')}` : undefined) };
  }

  async listApps(): Promise<RawApp[]> {
    const r = await this.call('list_apps');
    return (r.apps ?? []).map((a: any) => ({ name: String(a.name ?? ''), pid: a.pid ?? undefined, bundleId: a.bundle_id ?? undefined, running: a.running, toolkit: a.toolkit ?? undefined, path: a.path ?? undefined }));
  }

  private toWindow(w: any): RawWindow {
    return { windowId: String(w.window_id), pid: w.pid ?? undefined, app: String(w.app ?? ''), title: String(w.title ?? ''), focused: w.focused, onScreen: w.on_screen, minimized: w.minimized, bounds: w.bounds ?? undefined };
  }

  async listWindows(app?: string): Promise<RawWindow[]> {
    const r = await this.call('list_windows', app ? { app } : {});
    const ws = (r.windows ?? []).map((w: any) => this.toWindow(w));
    for (const w of ws) this.wins.set(w.windowId, w);
    return ws;
  }

  async windowState(windowId: string): Promise<RawWindowState> {
    const r = await this.call('snapshot', { window_id: windowId });
    const elements: RawElement[] = (r.elements ?? []).map((e: any) => ({
      index: e.index,
      parent: e.parent ?? undefined,
      role: String(e.role ?? 'unknown'),
      name: e.name ?? undefined,
      value: e.value ?? undefined,
      description: e.description ?? undefined,
      enabled: e.enabled ?? undefined,
      selected: e.selected || undefined,
      focused: e.focused || undefined,
      checked: e.checked ?? undefined,
      expanded: e.expanded ?? undefined,
      editable: e.editable ?? undefined,
      box: e.box ?? undefined,
      actions: e.actions ?? undefined,
      token: e.token,
    }));
    const window = this.toWindow(r.window ?? { window_id: windowId });
    this.wins.set(windowId, window);
    return { snapshotId: r.snapshot_id, window, elements, degraded: !!r.degraded, toolkit: r.toolkit ?? undefined };
  }

  async launch(app: string, opts: { env?: Record<string, string>; args?: string[] } = {}): Promise<RawActResult & { pid?: number }> {
    try {
      const r = await this.call('launch', { app, env: opts.env, args: opts.args }, 30_000);
      return { ok: true, effect: r.effect ?? 'confirmed', pid: r.pid, message: r.summary };
    } catch (e) {
      return { ok: false, effect: 'failed', code: (e as BackendError).code, message: (e as Error).message };
    }
  }

  activate(t: { app?: string; pid?: number; windowId?: string }): Promise<RawActResult> {
    return this.actCall('activate', { app: t.app, pid: t.pid, window_id: t.windowId });
  }

  quit(t: { app?: string; pid?: number }): Promise<RawActResult> {
    return this.actCall('quit', { app: t.app, pid: t.pid });
  }

  act(w: RawWindow, el: RawElement, action: ElementAction): Promise<RawActResult> {
    return this.actCall('act', { window_id: w.windowId, token: el.token, action });
  }

  setValue(w: RawWindow, el: RawElement, value: string): Promise<RawActResult> {
    return this.actCall('set_value', { window_id: w.windowId, token: el.token, value });
  }

  typeText(w: RawWindow | undefined, el: RawElement | undefined, text: string): Promise<RawActResult> {
    return this.actCall('type_text', { window_id: w?.windowId, token: el?.token, text });
  }

  pressKey(w: RawWindow | undefined, keys: string): Promise<RawActResult> {
    return this.actCall('press_key', { window_id: w?.windowId, keys });
  }

  menu(app: string, p: string[]): Promise<RawActResult> {
    return this.actCall('menu', { app, path: p });
  }

  scroll(w: RawWindow, el: RawElement | undefined, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<RawActResult> {
    return this.actCall('scroll', { window_id: w.windowId, token: el?.token, direction, amount });
  }

  pointer(w: RawWindow, x: number, y: number, action: 'click' | 'dblclick' | 'right_click' | 'drag_to', to?: [number, number]): Promise<RawActResult> {
    return this.actCall('pointer', { window_id: w.windowId, x, y, action, to });
  }

  async screenshot(w?: RawWindow): Promise<{ png: Buffer; scale?: number }> {
    const r = await this.call('screenshot', w ? { window_id: w.windowId } : {}, 30_000);
    return { png: Buffer.from(String(r.png_base64 ?? ''), 'base64'), scale: r.scale };
  }

  async clipboard(op: 'read' | 'write', text?: string): Promise<{ text?: string }> {
    const r = await this.call('clipboard', { op, text });
    return { text: r?.text };
  }

  /** Kill switch: ask politely for 200 ms, then kill the whole process group. */
  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    if (!this.exited) {
      const id = ++this.seq;
      try {
        proc.stdin!.write(encodeRequest(id, 'shutdown'));
        proc.stdin!.end();
      } catch {
        /* already closed */
      }
      await new Promise((r) => {
        const t = setTimeout(r, 200);
        proc.once('exit', () => {
          clearTimeout(t);
          r(undefined);
        });
      });
    }
    try {
      if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, 'SIGKILL');
      else proc.kill('SIGKILL');
    } catch {
      /* gone */
    }
    this.onExit('shut down');
  }
}

/** The sidecar inside the desktop sandbox container (F10). */
export function sandboxSidecarCommand(container: string): string[] {
  return ['docker', 'exec', '-i', '-e', 'DISPLAY=:1', container, 'oh-desktop-sidecar'];
}

export function sidecarScriptExists(file: string): boolean {
  return fs.existsSync(file);
}
