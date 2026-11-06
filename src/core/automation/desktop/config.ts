/**
 * Desktop config section (SPEC S0.4: `desktop` is owned by WS6). Declaration
 * merging keeps config.ts untouched; defaults are applied here
 * (`desktopConfig(cfg)`), never in loadConfig.
 *
 * Desktop automation is the riskiest surface the harness has (it acts in the
 * user's real apps), so it is off by default and every action asks unless the
 * app is listed in `autoApproveApps`.
 */
import type { HarnessConfig } from '../../config.js';

export interface DesktopConfig {
  /** Register the desktop_* tools. Off by default (SPEC R2). */
  enabled: boolean;
  /** auto: cua-driver when it is installed, else the OS sidecar. cua: cua-driver only. sidecar: our sidecar only. sandbox: the sidecar inside the desktop sandbox container (F10). */
  backend: 'auto' | 'cua' | 'sidecar' | 'sandbox';
  /** cua-driver executable (`cua-driver mcp` is spawned). */
  cuaDriverCommand: string;
  /** Arguments; default ["mcp"]. */
  cuaDriverArgs: string[];
  /** Pinned cua-driver version (prefix match, e.g. "0.37"). A mismatch is reported by health and at start. */
  cuaDriverVersion: string;
  /** Refuse to start when the cua-driver version does not match the pin. */
  cuaDriverVersionStrict: boolean;
  sidecar: {
    /** Explicit command for the sidecar (overrides the OS default), e.g. ["docker","exec","-i","oh-desktop","python3","/opt/oh/linux_atspi.py"]. */
    command?: string[];
    /** Python interpreter for the Linux sidecar. Default: the first of /usr/bin/python3, python3, /usr/bin/python3.X that can `import gi`. */
    python?: string;
    /** PowerShell for the Windows sidecar (pwsh or powershell). */
    powershell?: string;
  };
  /** Apps whose actions run without asking (names or bundle ids, case-insensitive). */
  autoApproveApps: string[];
  /** Apps the agent must never act on, in addition to the harness's own windows. */
  denyApps: string[];
  /** Rate limit: desktop actions per minute (F7). 0 = unlimited. */
  maxActionsPerMinute: number;
  /** Loop breaker: identical consecutive actions allowed. */
  maxIdenticalActions: number;
  /** Actions per model turn (S9/S10 fence rule). */
  maxActionsPerTurn: number;
  /** Token budget for one rendered desktop snapshot. */
  snapshotTokens: number;
  maxRepeatedSiblings: number;
  maxTextChars: number;
  /** Wait after an action before the verify re-scan (ms). */
  settleMs: number;
  /** Wait after the activation helper before re-scanning (S10: 0.5 s). */
  activationWaitMs: number;
  /** Destructive targets (delete/close/quit/discard/erase/send, kill_app) need an `expect`. */
  requireExpectForDestructive: boolean;
  /** Coordinate actions (desktop_point) without asking. */
  allowPoint: boolean;
  /** Record trajectories under <workspace>/.tugline/runs/<session>-desktop/ (F8). */
  record: boolean;
  /** Also ask cua-driver to record its own low-level trajectory (start_recording), when it has the tool. */
  mirrorDriverRecording: boolean;
  /** Kill-switch flag file; default <homeDir>/STOP. */
  stopFile?: string;
  /** How often the STOP file is checked (ms). */
  stopPollMs: number;
  /** Extra Electron app names/bundle ids (added to the built-in list). */
  electronApps: string[];
  /** Extra arguments when relaunching an Electron app with a debugging port, per app name (e.g. a profile flag). */
  electronLaunchArgs: Record<string, string[]>;
  /** Executable per Electron app name when the backend does not report a launch path. */
  electronPaths: Record<string, string>;
  /** Container used by `tug desktop-sandbox` and backend "sandbox". */
  sandbox: { image: string; container: string; vncPort: number };
  /** Timeout for one backend call (ms). */
  callTimeoutMs: number;
}

declare module '../../config.js' {
  interface HarnessConfigExtensions {
    desktop?: Partial<Omit<DesktopConfig, 'sidecar' | 'sandbox'>> & { sidecar?: DesktopConfig['sidecar']; sandbox?: Partial<DesktopConfig['sandbox']> };
  }
}

export const DEFAULT_DESKTOP: DesktopConfig = {
  enabled: false,
  backend: 'auto',
  cuaDriverCommand: 'cua-driver',
  cuaDriverArgs: ['mcp'],
  cuaDriverVersion: '0.37',
  cuaDriverVersionStrict: false,
  sidecar: {},
  autoApproveApps: [],
  denyApps: [],
  maxActionsPerMinute: 60,
  maxIdenticalActions: 3,
  maxActionsPerTurn: 2,
  snapshotTokens: 4000,
  maxRepeatedSiblings: 20,
  maxTextChars: 160,
  settleMs: 150,
  activationWaitMs: 500,
  requireExpectForDestructive: true,
  allowPoint: false,
  record: true,
  mirrorDriverRecording: false,
  stopPollMs: 100,
  electronApps: [],
  electronLaunchArgs: {},
  electronPaths: {},
  sandbox: { image: 'tugline/desktop-sandbox:latest', container: 'oh-desktop-sandbox', vncPort: 6080 },
  callTimeoutMs: 20_000,
};

export function desktopConfig(cfg: Pick<HarnessConfig, 'desktop'>): DesktopConfig {
  const d = cfg.desktop ?? {};
  return { ...DEFAULT_DESKTOP, ...d, sidecar: { ...DEFAULT_DESKTOP.sidecar, ...(d.sidecar ?? {}) }, sandbox: { ...DEFAULT_DESKTOP.sandbox, ...(d.sandbox ?? {}) } } as DesktopConfig;
}

/** Case-insensitive app match against a list of names / bundle ids. */
export function appListed(app: { name?: string; bundleId?: string } | string | undefined, list: string[]): boolean {
  if (!app || !list.length) return false;
  const names = typeof app === 'string' ? [app] : [app.name, app.bundleId];
  const want = new Set(list.map((x) => x.trim().toLowerCase()).filter(Boolean));
  return names.some((n) => !!n && want.has(n.trim().toLowerCase()));
}
