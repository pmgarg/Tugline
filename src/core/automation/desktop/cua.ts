/**
 * CuaDriverAdapter backend (SPEC F1; research CU §2.1, §5.5): spawns
 * `cua-driver mcp` and speaks MCP to it through the v2 client, the same
 * client the harness uses for every MCP server.
 *
 * cua-driver is 0.x and renames things, so the adapter is schema-adaptive:
 * it reads each tool's advertised input schema at connect time and sends only
 * the argument names that tool declares (legacy `pid`/`window_id`, or the
 * newer `target: {kind:"window", pid, window_id}` form). The version is pinned
 * (`desktop.cuaDriverVersion`) and checked at start from the MCP server info.
 * Element tokens (`element_token`) are scoped to one `get_window_state`; a
 * stale one comes back as `stale_element_token`, which the driver turns into
 * rebind-or-refuse.
 *
 * Telemetry is switched off in the child's environment, and the child gets the
 * harness's scrubbed environment (no credentials).
 */
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { scrubbedEnv } from '../../tools/shell.js';
import { BackendError, desktopSessionEnv, type BackendHealth, type DesktopBackend, type ElementAction, type RawActResult, type RawApp, type RawElement, type RawWindow, type RawWindowState } from './backend.js';

export interface CuaOptions {
  command: string;
  args: string[];
  versionPin?: string;
  strictVersion?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
}

interface ToolInfo {
  props: Set<string>;
  /** The schema declares properties (otherwise pass everything). */
  typed: boolean;
}

/** Version pin check: "0.37" matches 0.37.x; "0.37.0" matches exactly; "" or "*" matches anything. */
export function versionMatches(actual: string | undefined, pin: string | undefined): boolean {
  if (!pin || pin === '*') return true;
  if (!actual) return false;
  const a = actual.replace(/^v/, '').split(/[.+-]/);
  const p = pin.replace(/^v/, '').split('.');
  return p.every((x, i) => a[i] === x);
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
}

function box(v: any): RawElement['box'] {
  if (!v || typeof v !== 'object') return undefined;
  const x = num(v.x);
  const y = num(v.y);
  const w = num(v.w ?? v.width);
  const h = num(v.h ?? v.height);
  return x !== undefined && y !== undefined && w !== undefined && h !== undefined ? { x, y, width: w, height: h } : undefined;
}

/** cua-driver's WindowElement → RawElement. */
export function elementFromCua(e: any): RawElement {
  const role = String(e.role ?? 'AXUnknown');
  const value = e.value === null || e.value === undefined ? undefined : String(e.value);
  const el: RawElement = {
    index: Number(e.element_index ?? e.index),
    parent: e.parent_index === null || e.parent_index === undefined ? undefined : Number(e.parent_index),
    role,
    name: str(e.label ?? e.title ?? e.name) || undefined,
    value,
    description: str(e.value_description ?? e.description ?? e.help) || undefined,
    enabled: typeof e.enabled === 'boolean' ? e.enabled : undefined,
    selected: typeof e.selected === 'boolean' ? e.selected : undefined,
    focused: typeof e.focused === 'boolean' ? e.focused : undefined,
    expanded: typeof e.expanded === 'boolean' ? e.expanded : undefined,
    box: box(e.frame ?? e.bounds),
    actions: Array.isArray(e.actions) ? e.actions.map(String) : undefined,
    token: str(e.element_token ?? e.token),
  };
  // AX checkboxes and radio buttons report their state as value "1"/"0".
  if (/checkbox|radiobutton|switch/i.test(role) && (value === '1' || value === '0')) {
    el.checked = value === '1';
    el.value = undefined;
  }
  return el;
}

export function windowFromCua(w: any): RawWindow {
  return {
    windowId: String(w.window_id ?? w.id),
    pid: num(w.pid),
    app: String(w.app_name ?? w.app ?? ''),
    title: String(w.title ?? ''),
    focused: typeof w.focused === 'boolean' ? w.focused : typeof w.z_index === 'number' ? w.z_index === 0 : undefined,
    onScreen: typeof w.is_on_screen === 'boolean' ? w.is_on_screen : undefined,
    minimized: typeof w.minimized === 'boolean' ? w.minimized : undefined,
    bounds: box(w.bounds),
    bundleId: str(w.bundle_id),
  };
}

/** A tool result → structured object (structuredContent, else JSON text, else {text}). */
export function parseResult(res: any): { data: any; text: string; images: { mimeType: string; data: string }[]; isError: boolean } {
  const texts: string[] = [];
  const images: { mimeType: string; data: string }[] = [];
  for (const c of res?.content ?? []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image') images.push({ mimeType: c.mimeType, data: c.data });
  }
  const text = texts.join('\n');
  let data = res?.structuredContent;
  if (data === undefined) {
    for (const t of texts) {
      try {
        data = JSON.parse(t);
        break;
      } catch {
        /* not JSON */
      }
    }
  }
  return { data: data ?? {}, text, images, isError: !!res?.isError };
}

const ERROR_CODES = ['stale_element_token', 'ambiguous_window_target', 'window_target_not_found', 'screenshot_context_missing', 'permission_denied', 'background_unavailable', 'element_not_found', 'not_found'];

function errorCode(text: string, data: any): string | undefined {
  const c = data?.error?.code ?? data?.code ?? data?.error_code;
  if (typeof c === 'string') return c;
  return ERROR_CODES.find((x) => text.includes(x));
}

export class CuaDriverBackend implements DesktopBackend {
  readonly name = 'cua-driver';
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools = new Map<string, ToolInfo>();
  private wins = new Map<string, RawWindow>();
  version?: string;
  warnings: string[] = [];

  constructor(readonly o: CuaOptions) {}

  get pid(): number | null | undefined {
    return this.transport?.pid;
  }

  has(tool: string): boolean {
    return this.tools.has(tool);
  }

  async start(): Promise<void> {
    if (this.client) return;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(scrubbedEnv([]))) if (typeof v === 'string') env[k] = v;
    // cua-core mentions telemetry (research CU §2.1): off.
    Object.assign(env, desktopSessionEnv(), { CUA_TELEMETRY_ENABLED: 'false', CUA_TELEMETRY: 'off', CUA_DRIVER_TELEMETRY: '0', DO_NOT_TRACK: '1' }, this.o.env ?? {});
    this.transport = new StdioClientTransport({ command: this.o.command, args: this.o.args, env, stderr: 'ignore' });
    const client = new Client({ name: 'tugline-desktop', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } } as any);
    try {
      await withTimeout(client.connect(this.transport), this.o.timeoutMs ?? 20_000, `cua-driver did not start (${this.o.command} ${this.o.args.join(' ')})`);
    } catch (e) {
      await this.transport.close().catch(() => undefined);
      this.transport = undefined;
      throw new BackendError(`could not start cua-driver: ${(e as Error).message}. Install it (pip install cua-driver) or set desktop.cuaDriverCommand.`, 'unavailable');
    }
    this.client = client;
    const listed = await client.listTools();
    for (const t of listed.tools) {
      const props = (t.inputSchema as any)?.properties;
      this.tools.set(t.name, { props: new Set(Object.keys(props ?? {})), typed: !!props && Object.keys(props).length > 0 });
    }
    this.version = client.getServerVersion()?.version;
    if (!versionMatches(this.version, this.o.versionPin)) {
      const msg = `cua-driver ${this.version ?? '(unknown version)'} does not match the pinned desktop.cuaDriverVersion ${this.o.versionPin}`;
      if (this.o.strictVersion) {
        await this.shutdown();
        throw new BackendError(`${msg} (desktop.cuaDriverVersionStrict is on)`, 'version_mismatch');
      }
      this.warnings.push(msg);
    }
  }

  /** Keep only arguments the tool declares; map pid/window_id to `target` when the tool wants that form. */
  private shape(tool: string, args: Record<string, unknown>): Record<string, unknown> {
    const info = this.tools.get(tool);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) out[k] = v;
    if (!info?.typed) return out;
    if (info.props.has('target') && !info.props.has('pid') && (out.pid !== undefined || out.window_id !== undefined)) {
      out.target = { kind: 'window', pid: out.pid, window_id: out.window_id };
      delete out.pid;
      delete out.window_id;
    }
    for (const k of Object.keys(out)) if (!info.props.has(k)) delete out[k];
    return out;
  }

  /** First of several candidate argument names that the tool declares. */
  private argName(tool: string, candidates: string[]): string {
    const info = this.tools.get(tool);
    return candidates.find((c) => info?.props.has(c)) ?? candidates[0];
  }

  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ReturnType<typeof parseResult>> {
    if (!this.client) await this.start();
    if (!this.tools.has(tool)) throw new BackendError(`this cua-driver (${this.version ?? '?'}) has no "${tool}" tool`, 'unsupported');
    const res = await this.client!.callTool({ name: tool, arguments: this.shape(tool, args) }, { timeout: timeoutMs ?? this.o.timeoutMs ?? 20_000 } as any);
    return parseResult(res);
  }

  private actResult(r: ReturnType<typeof parseResult>): RawActResult {
    const effect = (r.data?.effect ?? r.data?.outcome) as RawActResult['effect'] | undefined;
    const code = errorCode(r.text, r.data);
    if (r.isError || effect === 'refused' || r.data?.error) return { ok: false, effect: effect === 'refused' ? 'refused' : 'failed', code: code ?? 'interaction_failed', message: r.data?.error?.message ?? r.data?.summary ?? r.text };
    return { ok: true, effect: effect ?? 'unverifiable', message: r.data?.summary };
  }

  private winArgs(w: RawWindow): Record<string, unknown> {
    return { pid: w.pid, window_id: num(w.windowId) ?? w.windowId };
  }

  // ------------------------------------------------------------ DesktopBackend

  async health(): Promise<BackendHealth> {
    await this.start();
    const out: BackendHealth = { ok: true, version: this.version, warnings: [...this.warnings] };
    if (this.has('check_permissions')) {
      const r = await this.call('check_permissions');
      const perms: Record<string, boolean> = {};
      const src = r.data?.permissions ?? r.data;
      for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'boolean') perms[k] = v;
      out.permissions = perms;
      if (Object.values(perms).some((v) => v === false)) out.ok = false;
    }
    if (this.has('health_report')) {
      const r = await this.call('health_report').catch(() => undefined);
      if (r) out.message = (r.data?.summary ?? r.data?.status ?? r.text)?.toString().slice(0, 500);
    }
    if (this.warnings.length) out.message = [out.message, ...this.warnings].filter(Boolean).join(' · ');
    return out;
  }

  async listApps(): Promise<RawApp[]> {
    const r = await this.call('list_apps');
    const apps = Array.isArray(r.data?.apps) ? r.data.apps : Array.isArray(r.data) ? r.data : [];
    return apps.map((a: any) => ({ name: String(a.name), pid: num(a.pid), bundleId: str(a.bundle_id), running: a.running, active: a.active, path: str(a.launch_path ?? a.path), toolkit: str(a.toolkit) }));
  }

  async listWindows(app?: string): Promise<RawWindow[]> {
    let pid: number | undefined;
    if (app) pid = (await this.listApps()).find((a) => a.name.toLowerCase() === app.toLowerCase() || a.bundleId?.toLowerCase() === app.toLowerCase())?.pid;
    if (app && pid === undefined) return [];
    const r = await this.call('list_windows', { pid, on_screen_only: false });
    const ws: RawWindow[] = (Array.isArray(r.data?.windows) ? r.data.windows : []).map(windowFromCua);
    for (const w of ws) this.wins.set(w.windowId, w);
    return ws;
  }

  private async win(windowId: string): Promise<RawWindow> {
    if (!this.wins.has(windowId)) await this.listWindows();
    const w = this.wins.get(windowId);
    if (!w) throw new BackendError(`window ${windowId} not found`, 'window_target_not_found');
    return w;
  }

  async windowState(windowId: string, opts: { query?: string } = {}): Promise<RawWindowState> {
    const w = await this.win(windowId);
    const r = await this.call('get_window_state', { ...this.winArgs(w), include_screenshot: false, include_accessibility_tree: true, query: opts.query });
    if (r.isError) throw new BackendError(`get_window_state failed: ${r.text}`, errorCode(r.text, r.data));
    const d = r.data;
    const elements: RawElement[] = (Array.isArray(d?.elements) ? d.elements : []).map(elementFromCua);
    const window: RawWindow = { ...w, app: str(d?.app_name) ?? w.app, title: str(d?.window_title) ?? w.title };
    this.wins.set(windowId, window);
    return { snapshotId: str(d?.snapshot_id), window, elements, degraded: !!d?.degraded, degradedReason: str(d?.degraded_reason), toolkit: str(d?.toolkit) };
  }

  async launch(app: string, opts: { env?: Record<string, string>; args?: string[] } = {}): Promise<RawActResult & { pid?: number }> {
    const nameArg = this.argName('launch_app', ['name', 'app', 'app_name', 'bundle_id']);
    const envArg = this.argName('launch_app', ['env', 'environment']);
    const r = await this.call('launch_app', { [nameArg]: app, [envArg]: opts.env, args: opts.args });
    const a = this.actResult(r);
    return { ...a, effect: a.ok ? 'confirmed' : a.effect, pid: num(r.data?.pid) };
  }

  async activate(t: { app?: string; pid?: number; windowId?: string }): Promise<RawActResult> {
    let pid = t.pid;
    if (pid === undefined && t.app) pid = (await this.listApps()).find((a) => a.name.toLowerCase() === t.app!.toLowerCase())?.pid;
    if (this.has('bring_to_front') && pid !== undefined) return this.actResult(await this.call('bring_to_front', { pid, window_id: t.windowId ? num(t.windowId) : undefined }));
    // The S10 activation helper on macOS when the driver has no tool for it.
    if ((this.o.platform ?? process.platform) === 'darwin' && t.app) return osascriptActivate(t.app);
    return { ok: false, effect: 'failed', code: 'unsupported', message: 'no activation helper available' };
  }

  async quit(t: { app?: string; pid?: number }): Promise<RawActResult> {
    let pid = t.pid;
    if (pid === undefined && t.app) pid = (await this.listApps()).find((a) => a.name.toLowerCase() === t.app!.toLowerCase())?.pid;
    if (pid === undefined) return { ok: false, effect: 'failed', code: 'not_found', message: `app ${t.app} is not running` };
    return this.actResult(await this.call('kill_app', { pid }));
  }

  async act(w: RawWindow, el: RawElement, action: ElementAction): Promise<RawActResult> {
    const base = { ...this.winArgs(w), element_token: el.token };
    if (action === 'right_click') return this.actResult(await this.call(this.has('right_click') ? 'right_click' : 'click', { ...base, button: 'right' }));
    if (action === 'dblclick') return this.actResult(await this.call(this.has('double_click') ? 'double_click' : 'click', { ...base, count: 2 }));
    return this.actResult(await this.call('click', base));
  }

  async setValue(w: RawWindow, el: RawElement, value: string): Promise<RawActResult> {
    return this.actResult(await this.call('set_value', { ...this.winArgs(w), element_token: el.token, value }));
  }

  async typeText(w: RawWindow | undefined, el: RawElement | undefined, text: string): Promise<RawActResult> {
    return this.actResult(await this.call('type_text', { ...(w ? this.winArgs(w) : {}), element_token: el?.token, text }));
  }

  async pressKey(w: RawWindow | undefined, keys: string): Promise<RawActResult> {
    const parts = keys.split('+').map((k) => k.trim()).filter(Boolean);
    if (parts.length > 1 && this.has('hotkey')) return this.actResult(await this.call('hotkey', { ...(w ? this.winArgs(w) : {}), keys: parts }));
    return this.actResult(await this.call('press_key', { ...(w ? this.winArgs(w) : {}), key: parts[parts.length - 1], modifiers: parts.length > 1 ? parts.slice(0, -1) : undefined }));
  }

  async menu(app: string, path: string[], w?: RawWindow): Promise<RawActResult> {
    const pathArg = this.argName('invoke_menu', ['path', 'menu_path', 'items']);
    let pid = w?.pid;
    if (pid === undefined) pid = (await this.listApps()).find((a) => a.name.toLowerCase() === app.toLowerCase())?.pid;
    return this.actResult(await this.call('invoke_menu', { pid, [pathArg]: path }));
  }

  async scroll(w: RawWindow, el: RawElement | undefined, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<RawActResult> {
    const c = el?.box ? { x: el.box.x + el.box.width / 2, y: el.box.y + el.box.height / 2 } : { x: (w.bounds?.width ?? 400) / 2, y: (w.bounds?.height ?? 300) / 2 };
    return this.actResult(await this.call('scroll', { ...this.winArgs(w), element_token: el?.token, direction, amount, ...c }));
  }

  async pointer(w: RawWindow, x: number, y: number, action: 'click' | 'dblclick' | 'right_click' | 'drag_to', to?: [number, number]): Promise<RawActResult> {
    if (action === 'drag_to') {
      if (!to) return { ok: false, effect: 'failed', code: 'bad_args', message: 'drag_to needs "to"' };
      return this.actResult(await this.call('drag', { ...this.winArgs(w), from_x: x, from_y: y, to_x: to[0], to_y: to[1] }));
    }
    return this.actResult(await this.call('click', { ...this.winArgs(w), x, y, button: action === 'right_click' ? 'right' : undefined, count: action === 'dblclick' ? 2 : undefined }));
  }

  async screenshot(w?: RawWindow): Promise<{ png: Buffer; scale?: number }> {
    const r = w ? await this.call('get_window_state', { ...this.winArgs(w), include_screenshot: true, include_accessibility_tree: false }) : await this.call('get_desktop_state', { include_screenshot: true });
    const img = r.images[0] ?? (r.data?.screenshot?.data_base64 ? { mimeType: r.data.screenshot.mime_type, data: r.data.screenshot.data_base64 } : undefined);
    if (!img) throw new BackendError(`no screenshot returned${r.text ? `: ${r.text.slice(0, 200)}` : ''} (macOS: grant Screen Recording to CuaDriver.app)`, 'screenshot_context_missing');
    return { png: Buffer.from(img.data, 'base64'), scale: num(r.data?.screenshot_scale) };
  }

  async clipboard(op: 'read' | 'write', text?: string): Promise<{ text?: string }> {
    if (op === 'read') {
      const r = await this.call('clipboard_read', { include_text: true });
      return { text: str(r.data?.text) ?? r.text };
    }
    await this.call('clipboard_write', { text });
    return {};
  }

  async startRecording(dir: string): Promise<boolean> {
    if (!this.has('start_recording')) return false;
    const arg = this.argName('start_recording', ['output_dir', 'dir', 'path']);
    const r = await this.call('start_recording', { [arg]: dir });
    return !r.isError;
  }

  async stopRecording(): Promise<void> {
    if (this.has('stop_recording')) await this.call('stop_recording').catch(() => undefined);
  }

  /**
   * Kill switch: ask the driver to stop (it releases held keys and buttons),
   * then close the transport, which kills the child. Bounded at ~300 ms so the
   * whole stop stays under a second.
   */
  async shutdown(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    if (client && this.tools.has('shutdown')) await withTimeout(client.callTool({ name: 'shutdown', arguments: {} }) as Promise<unknown>, 300, 'shutdown timed out').catch(() => undefined);
    const pid = transport?.pid;
    await withTimeout(client ? client.close() : Promise.resolve(), 300, 'close timed out').catch(() => undefined);
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

export function osascriptActivate(app: string): Promise<RawActResult> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `tell application ${JSON.stringify(app)} to activate`], { timeout: 5000 }, (err) => resolve(err ? { ok: false, effect: 'failed', code: 'activation_failed', message: err.message } : { ok: true, effect: 'confirmed' }));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
