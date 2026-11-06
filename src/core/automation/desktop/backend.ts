/**
 * Desktop backends: the thin transports under the DesktopDriver (research CU
 * §5.1, §5.5). A backend only perceives and acts; the harness does everything
 * above that (normalisation, refs, scan-act-verify, traps, policy, recording),
 * which is S10's "five layers you build above the driver".
 *
 *   CuaDriverBackend   `cua-driver mcp` over the MCP v2 client (primary, all OSes)
 *   SidecarBackend     our JSON-RPC sidecars: Linux AT-SPI (python), Windows UIA (PowerShell),
 *                      or either one inside the sandbox container (`docker exec -i`)
 *
 * Both return the same flat element list (cua-driver's shape: index + parent
 * index), with per-snapshot element tokens. Tokens are scoped to the snapshot
 * that produced them; a backend reports `stale_element_token` for an old one.
 */

export interface RawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RawElement {
  index: number;
  /** Parent element index; undefined for top-level elements. */
  parent?: number;
  /** Native role: AXButton, push button, ControlType.Button … */
  role: string;
  name?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  selected?: boolean;
  focused?: boolean;
  checked?: boolean;
  expanded?: boolean;
  editable?: boolean;
  /** Window-relative points. */
  box?: RawBox;
  actions?: string[];
  /** Snapshot-scoped handle (cua-driver element_token, sidecar token). Never shown to the model. */
  token?: string;
}

export interface RawWindow {
  windowId: string;
  pid?: number;
  app: string;
  title: string;
  focused?: boolean;
  onScreen?: boolean;
  minimized?: boolean;
  bounds?: RawBox;
  bundleId?: string;
}

export interface RawApp {
  name: string;
  pid?: number;
  bundleId?: string;
  running?: boolean;
  active?: boolean;
  path?: string;
  /** GUI toolkit when the backend knows it (AT-SPI toolkit_name: GTK, Qt …). */
  toolkit?: string;
}

export interface RawWindowState {
  snapshotId?: string;
  window: RawWindow;
  elements: RawElement[];
  degraded?: boolean;
  degradedReason?: string;
  toolkit?: string;
}

export type RawEffect = 'confirmed' | 'unverifiable' | 'suspected_noop' | 'refused' | 'failed';

export interface RawActResult {
  ok: boolean;
  effect?: RawEffect;
  /** e.g. stale_element_token, permission_denied, not_found, background_unavailable */
  code?: string;
  message?: string;
}

export interface BackendHealth {
  ok: boolean;
  version?: string;
  permissions?: Record<string, boolean>;
  message?: string;
  warnings?: string[];
}

export type ElementAction = 'press' | 'click' | 'dblclick' | 'right_click' | 'focus' | 'expand' | 'select' | 'toggle';

export interface DesktopBackend {
  readonly name: string;
  start(): Promise<void>;
  health(): Promise<BackendHealth>;
  listApps(): Promise<RawApp[]>;
  listWindows(app?: string): Promise<RawWindow[]>;
  windowState(windowId: string, opts?: { query?: string }): Promise<RawWindowState>;
  launch(app: string, opts?: { env?: Record<string, string>; args?: string[] }): Promise<RawActResult & { pid?: number }>;
  /** The activation helper: bring an app/window to the front (osascript activate, wmctrl -a, SetForegroundWindow). */
  activate(target: { app?: string; pid?: number; windowId?: string }): Promise<RawActResult>;
  quit(target: { app?: string; pid?: number }): Promise<RawActResult>;
  act(win: RawWindow, el: RawElement, action: ElementAction): Promise<RawActResult>;
  setValue(win: RawWindow, el: RawElement, value: string): Promise<RawActResult>;
  typeText(win: RawWindow | undefined, el: RawElement | undefined, text: string): Promise<RawActResult>;
  pressKey(win: RawWindow | undefined, keys: string): Promise<RawActResult>;
  menu(app: string, path: string[], win?: RawWindow): Promise<RawActResult>;
  scroll(win: RawWindow, el: RawElement | undefined, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<RawActResult>;
  /** Window-relative point action (L3). */
  pointer(win: RawWindow, x: number, y: number, action: 'click' | 'dblclick' | 'right_click' | 'drag_to', to?: [number, number]): Promise<RawActResult>;
  /** PNG of a window (or the screen); `scale` = screenshot pixels per window point. */
  screenshot(win?: RawWindow): Promise<{ png: Buffer; scale?: number }>;
  clipboard(op: 'read' | 'write', text?: string): Promise<{ text?: string }>;
  /** Optional driver-level recording (cua-driver start_recording / stop_recording). */
  startRecording?(dir: string): Promise<boolean>;
  stopRecording?(): Promise<void>;
  /** Release held keys and buttons and stop (kill switch; cua-driver shutdown). Must return fast. */
  shutdown(): Promise<void>;
}

export class BackendError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/**
 * Variables a desktop helper needs to reach the user's session. The harness's
 * scrubbed environment drops names that look like credentials (…AUTH…,
 * …SESSION…), which would cut a sidecar or cua-driver off from X11
 * (XAUTHORITY) and the accessibility bus (DBUS_SESSION_BUS_ADDRESS). These are
 * locators, not secrets, so they are passed through explicitly.
 */
export const DESKTOP_SESSION_VARS = ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'QT_ACCESSIBILITY', 'GTK_MODULES', 'NO_AT_BRIDGE'];

export function desktopSessionEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DESKTOP_SESSION_VARS) if (typeof env[k] === 'string') out[k] = env[k] as string;
  return out;
}
