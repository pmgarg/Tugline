/**
 * Desktop sessions: one driver per agent session, plus the policy between the
 * model and the driver (research CU §4, §5.6; SPEC F2, F3, F7):
 *
 *   kill switch / STOP file → self-protection (harness pids, own terminal/editor,
 *   desktop.denyApps) → destructive-needs-expect → fence rule (≤2 actions per
 *   turn, menus/launches/pixel clicks alone) → rate limit and loop breaker
 *
 * All of it is code outside the model. Approval (ask unless the app is in
 * desktop.autoApproveApps) happens in the tool layer before the guard runs.
 * Every call is recorded to the trajectory (F8) with semantic keys and the
 * window as `desktop://<app>/<title>`.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { HarnessConfig } from '../../config.js';
import type { AgentEvent } from '../../types.js';
import { SecretVault } from '../../secrets/vault.js';
import { makeMasker } from '../snapshot/mask.js';
import { ActionLimiter, FenceTracker, assertNotKilled, fenceReason, onKill, type FenceTarget, type PolicyVerdict } from '../policy/index.js';
import { TrajectoryRecorder, formatPathStats, pathStats } from '../recorder/trajectory.js';
import type { CascadePath, Expect } from '../types.js';
import { desktopConfig, type DesktopConfig } from './config.js';
import { BackendError, type DesktopBackend, type RawWindow } from './backend.js';
import { CuaDriverBackend } from './cua.js';
import { SidecarBackend, defaultSidecarCommand, sandboxSidecarCommand } from './sidecar.js';
import { ScanActVerifyDriver, type DesktopActResult, type DesktopActionKind, type DesktopGuard, type DesktopTarget } from './driver.js';
import { selfProtectCheck } from './selfprotect.js';
import { stopFileExists, stopFilePath, watchStopFile } from './killswitch.js';
import type { ElectronBridge } from './electron.js';
import type { Region } from '../perception/ocr.js';

export interface DesktopEnv {
  sessionId: string;
  workspace: string;
  config: HarnessConfig;
  emit?: (e: AgentEvent) => void;
  model?: string;
  notice?: (msg: string) => void;
}

/** Test seam: build the backend yourself (e.g. an in-process fake). */
export type BackendFactory = (cfg: DesktopConfig, env: DesktopEnv) => DesktopBackend;
let backendFactory: BackendFactory | undefined;
export function setDesktopBackendFactory(f: BackendFactory | undefined): void {
  backendFactory = f;
}

function onPath(cmd: string): boolean {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 3000 });
  return r.status === 0;
}

/** desktop.backend → a backend. auto: cua-driver when installed, else the OS sidecar. */
export function createBackend(cfg: DesktopConfig, platform: NodeJS.Platform = process.platform): DesktopBackend {
  const cua = () => new CuaDriverBackend({ command: cfg.cuaDriverCommand, args: cfg.cuaDriverArgs, versionPin: cfg.cuaDriverVersion, strictVersion: cfg.cuaDriverVersionStrict, timeoutMs: cfg.callTimeoutMs, platform });
  const sidecar = () => {
    const cmd = cfg.sidecar.command ?? defaultSidecarCommand(platform, cfg.sidecar);
    if (!cmd) throw new BackendError(platform === 'linux' ? 'no Python with gi/Atspi found for the Linux sidecar: apt install python3-gi gir1.2-atspi-2.0 at-spi2-core (or set desktop.sidecar.python)' : `no desktop sidecar for ${platform}: install cua-driver (pip install cua-driver) and set desktop.backend = "cua"`, 'unavailable');
    return new SidecarBackend(cmd, { timeoutMs: cfg.callTimeoutMs });
  };
  if (cfg.backend === 'cua') return cua();
  if (cfg.backend === 'sidecar') return sidecar();
  if (cfg.backend === 'sandbox') return new SidecarBackend(sandboxSidecarCommand(cfg.sandbox.container), { name: `sandbox:${cfg.sandbox.container}`, timeoutMs: cfg.callTimeoutMs });
  if (cfg.sidecar.command) return sidecar();
  if (onPath(cfg.cuaDriverCommand)) return cua();
  return sidecar();
}

const DESTRUCTIVE_NAME = /\b(delete|remove|close|quit|exit|discard|erase|send|destroy|wipe|purge|empty trash|move to trash|uninstall|format|log ?out|sign ?out|shut ?down|restart|don'?t save)\b/i;
const DESTRUCTIVE_KEYS = /^(cmd|command|meta|super|ctrl|control)\+(q|w|backspace|delete)$|^alt\+f4$|^shift\+delete$/i;

/** Destructive desktop actions need an explicit `expect` (S10: verification is mandatory for them). */
export function desktopDestructiveCheck(t: { kind: DesktopActionKind; action: string; name?: string; hasExpect: boolean }, required: boolean): PolicyVerdict {
  if (!required || t.hasExpect) return { ok: true };
  let why: string | undefined;
  if (t.kind === 'quit') why = 'quitting an app';
  else if (t.kind === 'key' && DESTRUCTIVE_KEYS.test(t.action.replace(/\s+/g, ''))) why = `the shortcut ${t.action}`;
  else if (t.kind === 'menu' && DESTRUCTIVE_NAME.test(t.action.split('>').pop() ?? '')) why = `the menu item "${t.action}"`;
  else if ((t.kind === 'act' || t.kind === 'point') && t.action !== 'focus' && DESTRUCTIVE_NAME.test(t.name ?? '')) why = `"${t.name}"`;
  if (!why) return { ok: true };
  return { ok: false, code: 'policy_denied', message: `${why} looks destructive: repeat the call with an explicit "expect" describing the intended result (e.g. {"window_present":{"title_regex":"Saved"}} or {"element_absent":{"name":"Draft"}}). The harness verifies it after acting.` };
}

export class DesktopSession {
  readonly cfg: DesktopConfig;
  readonly vault: SecretVault;
  readonly mask: (s: string) => string;
  readonly fence: FenceTracker;
  readonly limiter: ActionLimiter;
  readonly stopFile: string;
  recorder?: TrajectoryRecorder;
  backend?: DesktopBackend;
  driver?: ScanActVerifyDriver;
  /** Apps the user allowed for the rest of the session (auto mode consent). */
  readonly approvedApps = new Set<string>();
  /** Electron apps relaunched with a debugging port (F5), by window id `cdp:<app>`. */
  readonly electron = new Map<string, ElectronBridge>();
  /** Consent for Electron relaunches, per app. */
  readonly electronConsent = new Map<string, boolean>();
  /** OCR regions of the last screenshot per window (F6). */
  regions?: { windowId?: string; regions: Region[]; scale: number };
  startWarnings: string[] = [];
  private starting?: Promise<ScanActVerifyDriver>;
  private turn: number | string = 0;
  private offKill: () => void;
  private releaseStop: () => void;
  closed = false;

  constructor(readonly env: DesktopEnv) {
    this.cfg = desktopConfig(env.config);
    this.vault = new SecretVault(env.config.homeDir);
    this.mask = makeMasker(() => this.vault.usedValues());
    this.fence = new FenceTracker(this.cfg.maxActionsPerTurn);
    this.limiter = new ActionLimiter(this.cfg.maxActionsPerMinute, this.cfg.maxIdenticalActions);
    this.stopFile = stopFilePath(env.config.homeDir, this.cfg.stopFile);
    this.releaseStop = watchStopFile(this.stopFile, this.cfg.stopPollMs);
    // The global kill switch (WS5) stops desktop input too: shut the backend down at once.
    this.offKill = onKill(() => void this.shutdownNow());
    if (this.cfg.record) {
      this.recorder = new TrajectoryRecorder(path.join(env.workspace, '.tugline', 'runs', `${env.sessionId.replace(/[^\w.-]/g, '_')}-desktop`), {
        session: env.sessionId,
        surface: 'desktop',
        model: env.model,
        versions: { tugline: '1.0' },
      });
    }
  }

  beginTurn(turn: number | string): void {
    this.turn = turn;
    this.fence.beginTurn(turn);
  }

  /** Start the backend once; health and permissions are checked at start (F1). */
  ensure(): Promise<ScanActVerifyDriver> {
    if (this.driver) return Promise.resolve(this.driver);
    if (this.closed) return Promise.reject(new BackendError('the desktop session was closed (kill switch); /desktop resume to start again', 'killed'));
    if (!this.starting) {
      this.starting = (async () => {
        const backend = backendFactory ? backendFactory(this.cfg, this.env) : createBackend(this.cfg);
        await backend.start();
        const driver = new ScanActVerifyDriver(backend, {
          snapshotTokens: this.cfg.snapshotTokens,
          maxRepeated: this.cfg.maxRepeatedSiblings,
          maxTextChars: this.cfg.maxTextChars,
          settleMs: this.cfg.settleMs,
          activationWaitMs: this.cfg.activationWaitMs,
          electronApps: this.cfg.electronApps,
          mask: this.mask,
          log: (m) => this.env.notice?.(m),
        });
        const h = await driver.health().catch((e) => ({ ok: false, message: (e as Error).message }) as { ok: boolean; message?: string; permissions?: Record<string, boolean> });
        if (!h.ok) this.startWarnings.push(`desktop backend ${backend.name}: ${h.message ?? 'health check failed'}${h.permissions ? ` (permissions: ${Object.entries(h.permissions).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`);
        const warn = (backend as CuaDriverBackend).warnings;
        if (Array.isArray(warn)) this.startWarnings.push(...warn);
        if (this.cfg.mirrorDriverRecording && backend.startRecording && this.recorder) await backend.startRecording(path.join(this.recorder.dir, 'driver')).catch(() => false);
        this.backend = backend;
        this.driver = driver;
        return driver;
      })().catch((e) => {
        this.starting = undefined;
        throw e;
      });
    }
    return this.starting;
  }

  /** Kill switch target: release input and stop the backend now (bounded). */
  private async shutdownNow(): Promise<void> {
    this.closed = true;
    const b = this.backend;
    this.backend = undefined;
    this.driver = undefined;
    this.starting = undefined;
    const bridges = [...this.electron.values()];
    this.electron.clear();
    await Promise.all([b?.shutdown(), ...bridges.map((x) => x.close())].map((p) => Promise.resolve(p).catch(() => undefined)));
  }

  async close(): Promise<void> {
    this.releaseStop();
    this.offKill();
    if (this.backend?.stopRecording) await this.backend.stopRecording().catch(() => undefined);
    this.recorder?.flushMeta({ endedAt: new Date().toISOString() });
    await this.shutdownNow();
  }

  /** Kill switch state, including a STOP file nobody has polled yet. */
  killed(): PolicyVerdict {
    const k = assertNotKilled();
    if (!k.ok) return k;
    if (stopFileExists(this.stopFile)) return { ok: false, code: 'killed', message: `the STOP file ${this.stopFile} exists: all automation is stopped until a human removes it (/desktop resume)` };
    return { ok: true };
  }

  /** The window a ref, window id or app name refers to, without any backend call (for approvals). */
  windowFor(a: { ref?: string; window_id?: string; app?: string }): Partial<RawWindow> | undefined {
    const d = this.driver;
    if (a.window_id?.startsWith('cdp:')) return { app: a.window_id.slice(4), windowId: a.window_id };
    if (a.ref && /^f?\d*e\d+$/.test(a.ref)) {
      const b = [...this.electron.values()].find((x) => x.driver.latest?.root && JSON.stringify(x.driver.latest.root).includes(`"ref":"${a.ref}"`));
      return b ? { app: b.app, windowId: b.windowId } : undefined;
    }
    if (!d) return a.app ? { app: a.app } : undefined;
    if (a.ref) return d.windowOfRef(a.ref);
    if (a.window_id) return d.windowById(a.window_id) ?? { app: a.window_id };
    if (a.app) return { app: a.app };
    return d.lastWindow;
  }

  /** The policy guard (runs after resolving the target, before acting). */
  guard: DesktopGuard = async (t: DesktopTarget, kind: DesktopActionKind, action: string): Promise<PolicyVerdict> => {
    const k = this.killed();
    if (!k.ok) return k;
    const sp = selfProtectCheck(t.window, this.cfg.denyApps);
    if (!sp.ok) return sp;
    const d = desktopDestructiveCheck({ kind, action, name: t.node?.name, hasExpect: !!t.hasExpect }, this.cfg.requireExpectForDestructive);
    if (!d.ok) return d;
    const f = this.fenceCheck(t, kind, action);
    if (!f.ok) return f;
    const r = this.limiter.take(`${kind}:${action}:${t.key ? `${t.key.role}|${t.key.name}|${t.key.nth}` : t.ref ?? t.window.windowId}`);
    if (!r.ok) return r;
    this.fenceRecord(t, kind, action);
    return { ok: true };
  };

  /** Desktop-only fences: menus, app switches and blind pixel clicks change what is on screen. */
  private desktopFence(kind: DesktopActionKind): string | undefined {
    if (kind === 'menu') return 'invokes a menu';
    if (kind === 'launch' || kind === 'activate' || kind === 'quit') return 'switches apps';
    if (kind === 'point') return 'pixel action';
    return undefined;
  }

  /** S9/S10 fence classification for element and key actions (shared with the browser). */
  fenceTarget(t: Pick<DesktopTarget, 'node'>, kind: DesktopActionKind, action: string): FenceTarget {
    if (kind === 'key') return { kind: 'key', action: /^(enter|return)$/i.test(action) ? 'Enter' : action };
    if (kind === 'type' || kind === 'set_value' || kind === 'scroll') return { kind: 'type', action };
    return { kind: 'act', action: action === 'press' ? 'click' : action, role: t.node?.role, name: t.node?.name, states: t.node?.states };
  }

  fenceWhy(t: Pick<DesktopTarget, 'node'>, kind: DesktopActionKind, action: string): string | undefined {
    return this.desktopFence(kind) ?? fenceReason(this.fenceTarget(t, kind, action));
  }

  private fenceCheck(t: Pick<DesktopTarget, 'node'>, kind: DesktopActionKind, action: string): PolicyVerdict {
    const own = this.desktopFence(kind);
    if (own && this.fence.actionsThisTurn > 0) return { ok: false, code: 'policy_denied', message: `fence rule: this action is a fence (${own}) and must be the only action in its turn. Send it alone next turn.` };
    const f = this.fence.check(own ? { kind: 'type' } : this.fenceTarget(t, kind, action));
    if (!f.ok) return { ...f, message: f.message?.replace('browser_snapshot', 'desktop_snapshot').replace('can change the page', 'can change the window') };
    return f;
  }

  private fenceRecord(t: Pick<DesktopTarget, 'node'>, kind: DesktopActionKind, action: string): void {
    // A desktop fence is recorded as a navigation so the tracker blocks the rest of the turn.
    this.fence.record(this.desktopFence(kind) ? { kind: 'navigate' } : this.fenceTarget(t, kind, action));
  }

  record(tool: string, args: Record<string, unknown>, r: Partial<DesktopActResult> & { path?: CascadePath | string }, extra: { expect?: Expect; window?: Partial<RawWindow> } = {}): void {
    const w = extra.window ?? (r.target ? { app: r.target.app, title: r.target.window } : undefined);
    if (this.recorder) {
      const t = r.target;
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) clean[k] = typeof v === 'string' ? this.mask(v) : v;
      this.recorder.write({
        turn: this.turn,
        tool,
        path: r.path,
        args: clean,
        url: w ? `desktop://${encodeURIComponent(w.app ?? '')}/${encodeURIComponent(w.title ?? '')}` : undefined,
        target: t?.role ? { role: t.role, name: t.name, key: t.key } : undefined,
        preHash: r.preHash,
        outcome: r.outcome,
        errorCode: r.errorCode,
        diff: r.diff ? this.mask(r.diff).slice(0, 4000) : undefined,
        expect: extra.expect,
      });
    }
    this.env.emit?.({ type: 'automation', surface: 'desktop', tool, path: r.path, outcome: r.outcome, errorCode: r.errorCode });
  }

  stats(): { stats: Record<string, number>; text: string } {
    const s = pathStats(this.recorder?.steps ?? []);
    return { stats: s, text: formatPathStats(s) };
  }
}

// ------------------------------------------------------------ registry

const sessions = new Map<string, DesktopSession>();
const turns = new Map<string, number | string>();

export function noteDesktopTurn(sessionId: string, turn: number | string): void {
  turns.set(sessionId, turn);
  sessions.get(sessionId)?.beginTurn(turn);
}

export function getDesktopSession(env: DesktopEnv): DesktopSession {
  let s = sessions.get(env.sessionId);
  if (s?.closed && !assertNotKilled().ok) return s;
  if (!s || s.closed) {
    if (s) void s.close();
    s = new DesktopSession(env);
    sessions.set(env.sessionId, s);
    const t = turns.get(env.sessionId);
    if (t !== undefined) s.beginTurn(t);
  }
  return s;
}

export function peekDesktopSession(sessionId: string): DesktopSession | undefined {
  return sessions.get(sessionId);
}

export async function closeDesktopSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  sessions.delete(sessionId);
  turns.delete(sessionId);
  await s?.close();
}

export async function closeAllDesktopSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeDesktopSession));
}
