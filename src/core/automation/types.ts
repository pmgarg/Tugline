/**
 * Shared automation contracts (SPEC S0, §E and §F). Browser (WS5) and desktop
 * (WS6) drivers implement these; the snapshot normaliser, cascade, recorder and
 * policy work on them. Refs are snapshot-scoped: browser refs look like `e12`,
 * desktop refs like `d12`. A ref from an older snapshot is stale.
 * Ref: research/computer-use-and-browser-sota.md §5.
 */

/** One node of the unified accessibility tree. */
export interface UiNode {
  ref?: string;
  role: string;
  name?: string;
  value?: string;
  /** e.g. expanded, checked, disabled, selected, focused, haspopup */
  states?: string[];
  /** CSS pixels (browser) or window-relative points (desktop). */
  box?: { x: number; y: number; width: number; height: number };
  /** Link target (browser). Shown to the model when short. */
  url?: string;
  /** Input placeholder (browser) or help text (desktop). */
  placeholder?: string;
  children?: UiNode[];
  /** Driver-specific handle (element_token, data-oh-ref …). Never shown to the model. */
  handle?: unknown;
}

export interface Snapshot {
  id: string;
  /** 'browser' | 'desktop' */
  surface: 'browser' | 'desktop';
  url?: string;
  title?: string;
  windowId?: string;
  root: UiNode;
  /** Rendered text (YAML-like `- role "name" [ref=..] [state]`) */
  tree?: string;
  truncated?: boolean;
  elementCount: number;
  hash?: string;
  takenAt: number;
}

/** Shared post-condition language. */
export type Expect =
  | { element_present: { role?: string; name?: string | RegExpLike; state?: string } }
  | { element_absent: { role?: string; name?: string | RegExpLike } }
  | { text_present: string }
  | { text_absent: string }
  | { value_equals: { ref?: string; role?: string; name?: string; value: string } }
  | { url_matches: string }
  | { title_matches: string }
  | { window_present: { title_regex: string } }
  | { focused: { role?: string; name?: string } };

/** A regex given by the model as "/pattern/flags". */
export type RegExpLike = `/${string}/${string}`;

export type Outcome = 'confirmed' | 'partial' | 'unverifiable' | 'suspected_noop' | 'refused' | 'failed';

export type AutomationErrorCode =
  | 'blocked_captcha'
  | 'login_required'
  | 'gateway_blocked'
  | 'permission_denied'
  | 'empty_tree'
  | 'stale_ref'
  | 'ref_not_found'
  | 'interaction_failed'
  | 'verify_failed'
  | 'needs_human'
  | 'policy_denied'
  | 'rate_limited'
  | 'timeout'
  | 'vlm_unavailable'
  | 'killed';

export type CauseHint = 'permissions' | 'not_activated' | 'qt_a11y_off' | 'electron_opaque' | 'canvas';

/** The cascade layer that produced a result (S9 "path"). */
export type CascadePath = 'L0' | 'L1' | 'L2a' | 'L2b' | 'L3';

export interface ActResult {
  outcome: Outcome;
  errorCode?: AutomationErrorCode;
  causeHint?: CauseHint;
  message?: string;
  /** +/- lines against the previous snapshot */
  diff?: string;
  newSnapshotId?: string;
  rebound?: boolean;
  path?: CascadePath;
}

export type BrowserAction = 'click' | 'dblclick' | 'hover' | 'check' | 'uncheck' | 'focus' | 'select' | 'upload';
export type DesktopAction = 'press' | 'click' | 'dblclick' | 'right_click' | 'focus' | 'expand' | 'select' | 'toggle';

export interface SnapshotOptions {
  scope?: string;
  query?: string;
  maxTokens?: number;
  includeBoxes?: boolean;
}

export interface BrowserDriver {
  open(url: string, opts?: { profile?: string; headed?: boolean }): Promise<{ url: string; title: string }>;
  snapshot(opts?: SnapshotOptions): Promise<Snapshot>;
  act(ref: string, action: BrowserAction, opts?: { value?: string | string[]; expect?: Expect }): Promise<ActResult>;
  type(text: string, opts?: { ref?: string; secret?: string; submit?: boolean; clear?: boolean; expect?: Expect }): Promise<ActResult>;
  key(keys: string, opts?: { expect?: Expect }): Promise<ActResult>;
  navigate(target: string): Promise<{ url: string; title: string }>;
  screenshot(opts?: { scope?: string; marks?: boolean }): Promise<{ png: Buffer; marks?: { ref: string; box: NonNullable<UiNode['box']> }[] }>;
  verify(checks: Expect[]): Promise<{ ok: boolean; failures: string[] }>;
  close(): Promise<void>;
}

export interface DesktopWindow {
  windowId: string;
  app: string;
  title: string;
  focused: boolean;
  pid?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface DesktopDriver {
  readonly backend: string;
  health(): Promise<{ ok: boolean; version?: string; permissions?: Record<string, boolean>; message?: string }>;
  apps(op: 'list' | 'launch' | 'activate' | 'quit', app?: string): Promise<{ apps?: { name: string; pid?: number; bundleId?: string }[]; ok: boolean; message?: string }>;
  windows(app?: string): Promise<DesktopWindow[]>;
  snapshot(windowId: string, opts?: SnapshotOptions): Promise<Snapshot>;
  act(ref: string, action: DesktopAction, opts?: { expect?: Expect }): Promise<ActResult>;
  setValue(ref: string, value: string): Promise<ActResult>;
  type(text: string, opts?: { ref?: string; windowId?: string }): Promise<ActResult>;
  key(keys: string, opts?: { windowId?: string }): Promise<ActResult>;
  menu(app: string, path: string[]): Promise<ActResult>;
  scroll(target: { ref?: string; windowId?: string }, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<ActResult>;
  screenshot(windowId?: string): Promise<{ png: Buffer; scale?: number }>;
  point(windowId: string, x: number, y: number, action: 'click' | 'dblclick' | 'right_click' | 'drag_to', to?: [number, number]): Promise<ActResult>;
  clipboard(op: 'read' | 'write', text?: string): Promise<{ text?: string }>;
  close(): Promise<void>;
}
