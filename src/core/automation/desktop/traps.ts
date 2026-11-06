/**
 * Trap diagnosis (SPEC F4, S10 "traps that look the same"). Five different
 * problems all show up as `element_count: 0`:
 *
 *   permissions      TCC (macOS), the a11y bus / portal (Linux), UIPI (Windows)
 *   not_activated    an app launched in the background has no AX window yet
 *   qt_a11y_off      Qt apps expose nothing unless QT_ACCESSIBILITY=1
 *   electron_opaque  Electron/Chromium shows one opaque web area (→ F5 CDP)
 *   canvas           canvas, games, remote desktops: pixels only (→ F6)
 *
 * The driver never "tries harder" on an empty tree: it diagnoses, applies the
 * one safe automatic remedy (activate + 0.5 s + re-scan), and otherwise raises
 * a typed PreconditionError whose cause_hint drives a different recovery.
 */
import type { AutomationErrorCode, CauseHint } from '../types.js';
import type { BackendHealth, RawApp, RawElement, RawWindow } from './backend.js';
import { isCanvasLike, isWebArea } from './roles.js';

export class PreconditionError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    readonly causeHint: CauseHint,
    message: string,
    readonly remedy: string,
    /** What the harness already did about it (e.g. "activated Calculator and re-scanned"). */
    readonly applied?: string,
  ) {
    super(message);
  }
}

/** Known Electron / Chromium-shell apps (S10 planner pattern: match list_apps against a known list). */
export const KNOWN_ELECTRON_APPS = [
  'visual studio code', 'code', 'code - insiders', 'cursor', 'vscodium', 'windsurf', 'slack', 'discord', 'notion', 'obsidian', 'linear', '1password', 'microsoft teams', 'teams', 'figma',
  'postman', 'signal', 'whatsapp', 'spotify', 'github desktop', 'element', 'mattermost', 'loom', 'claude', 'chatgpt', 'zoom', 'skype', 'hyper', 'atom', 'insomnia', 'mongodb compass',
  'com.microsoft.vscode', 'com.tinyspeck.slackmacgap', 'com.hnc.discord', 'notion.id', 'md.obsidian',
];

export function isKnownElectron(app: { name?: string; bundleId?: string; path?: string } | undefined, extra: string[] = []): boolean {
  if (!app) return false;
  const list = new Set([...KNOWN_ELECTRON_APPS, ...extra.map((x) => x.toLowerCase())]);
  if ([app.name, app.bundleId].some((n) => n && list.has(n.toLowerCase()))) return true;
  // macOS bundle layout / Windows+Linux resources/app.asar next to the binary
  return !!app.path && /Electron Framework\.framework|resources[\\/]app\.asar/i.test(app.path);
}

export interface DiagnoseInput {
  window?: RawWindow;
  elements: RawElement[];
  degraded?: boolean;
  degradedReason?: string;
  health?: BackendHealth;
  app?: RawApp;
  toolkit?: string;
  platform: NodeJS.Platform;
  electronApps?: string[];
  /** The activation helper already ran for this scan. */
  activated?: boolean;
}

export interface Diagnosis {
  cause: CauseHint;
  code: AutomationErrorCode;
  message: string;
  remedy: string;
  /** Run the activation helper, wait, re-scan (only for not_activated, once). */
  autoActivate?: boolean;
}

const ACTIONABLE = /button|checkbox|radio|textfield|text field|entry|edit|combo|menu|link|slider|tab|list item|listitem|row|cell|switch|spin|toggle|option|tree item|treeitem/i;

/** Elements a model could act on or read (anything beyond the window frame and empty wrappers). */
export function actionableCount(elements: RawElement[]): number {
  return elements.filter((e) => ACTIONABLE.test(e.role) || !!e.actions?.some((a) => /press|click|activate|invoke/i.test(a)) || (!!(e.name || e.value) && !/window|frame|application/i.test(e.role))).length;
}

function permissionRemedy(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Grant Accessibility (and Screen Recording for screenshots) to CuaDriver.app in System Settings → Privacy & Security, not to VS Code or Terminal, then retry. Run `cua-driver mcp` once to trigger the prompt.';
  if (platform === 'win32') return 'The target window runs elevated (UIPI): the agent cannot drive it from a normal process. Ask the user to do this step, or run both at the same integrity level with explicit approval.';
  return 'The accessibility bus is off or the portal refused access. Enable it (GNOME: gsettings set org.gnome.desktop.interface toolkit-accessibility true; or start at-spi-bus-launcher), log out and in, then retry. On Wayland, prefer an X11 session or the desktop sandbox.';
}

/** Decide why a window shows no actionable elements. Order matters: the cheapest certain cause first. */
export function diagnoseEmpty(i: DiagnoseInput): Diagnosis {
  const reason = `${i.degradedReason ?? ''} ${i.health?.message ?? ''}`.toLowerCase();
  const perms = i.health?.permissions ?? {};
  const denied = Object.entries(perms).filter(([, v]) => v === false).map(([k]) => k);
  if (denied.some((k) => /access|a11y|ax|uia|atspi|automation/i.test(k)) || /permission|not trusted|tcc|accessibility (is )?(disabled|not granted)|access denied|uipi|elevat/.test(reason)) {
    return { cause: 'permissions', code: 'permission_denied', message: `the accessibility API returned nothing because permission is missing${denied.length ? ` (${denied.join(', ')})` : ''}`, remedy: permissionRemedy(i.platform) };
  }
  const w = i.window;
  const bg = !w || w.minimized === true || w.onScreen === false || (w.focused === false && !i.elements.length) || /background|not.?active|no window|minimi[sz]ed|off.?screen|hidden/.test(reason);
  if (bg && !i.activated) {
    return { cause: 'not_activated', code: 'empty_tree', message: 'the app looks launched in the background: it has no accessible window content until it is activated', remedy: 'activate the app (osascript activate / wmctrl -a / bring_to_front), wait 0.5 s and re-scan', autoActivate: true };
  }
  const toolkit = (i.toolkit ?? i.app?.toolkit ?? '').toLowerCase();
  const qtBinary = /libQt\d|QtCore|QtWidgets|Qt\w*\.framework/i.test(i.app?.path ?? '');
  if (/\bqt\b|qt\d/.test(toolkit) || qtBinary || /qt_accessibility|qt a11y/.test(reason)) {
    return { cause: 'qt_a11y_off', code: 'empty_tree', message: 'this is a Qt app and Qt exposes no accessibility tree unless QT_ACCESSIBILITY=1 is set', remedy: `quit it and relaunch with QT_ACCESSIBILITY=1 (desktop_apps {"op":"launch","app":"${i.app?.name ?? w?.app ?? '<app>'}"} sets it for you), then re-scan` };
  }
  const webAreas = i.elements.filter((e) => isWebArea(e.role));
  const electron = isKnownElectron(i.app ?? (w ? { name: w.app, bundleId: w.bundleId } : undefined), i.electronApps);
  if (electron || (webAreas.length === 1 && i.elements.every((e) => isWebArea(e.role) || /window|frame|group|generic|application|scroll/i.test(e.role) || !(e.name || e.value)))) {
    return { cause: 'electron_opaque', code: 'empty_tree', message: 'this is an Electron/Chromium app: its whole UI is one opaque web area in the accessibility tree', remedy: `use desktop_electron {"app":"${i.app?.name ?? w?.app ?? '<app>'}"} to relaunch it with a local debugging port (asks the user first; unsaved work in that app may be lost) and drive it through its DOM` };
  }
  if (i.elements.some((e) => isCanvasLike(e.role)) || i.elements.length > 0 || i.activated) {
    return { cause: 'canvas', code: 'empty_tree', message: 'the window draws its content itself (canvas, game, remote desktop): there is nothing in the accessibility tree', remedy: 'escalate to pixels: desktop_screenshot (text-only models get OCR text regions), then desktop_point {"region":"rN"} — every point action is verified and asks first' };
  }
  return { cause: 'not_activated', code: 'empty_tree', message: 'the window has no accessible content', remedy: 'activate the app and re-scan', autoActivate: !i.activated };
}
