/**
 * Browser sessions: one driver per agent session (SPEC E1), plus the policy
 * that sits between the model and the driver (research CU §5.6):
 *
 *   kill switch → human handoff (CAPTCHA, payment, 2FA) → destructive-needs-expect
 *   → fence rule (≤2 actions/turn, fence actions alone) → rate limit / loop breaker
 *
 * Driver hooks wire in the harness's own guards: every request the page makes
 * passes the web SSRF guard (`assertPublicUrl`, so `web.allowHosts` is the only
 * way to reach localhost/intranet), attached mode adds a domain allowlist,
 * secrets resolve from the vault inside the driver, and everything returned is
 * masked. Each tool call is recorded to the trajectory (E7).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../../config.js';
import type { AgentEvent } from '../../types.js';
import type { PermissionPolicy } from '../../permissions/policy.js';
import { assertPublicUrl } from '../../tools/web.js';
import { registerSecretValues } from '../../tools/shell.js';
import { SecretVault } from '../../secrets/vault.js';
import { makeMasker } from '../snapshot/mask.js';
import { ActionLimiter, FenceTracker, assertNotKilled, destructiveCheck, domainAllowed, handoffCheck, onKill, type FenceTarget, type PolicyVerdict } from '../policy/index.js';
import { detectCaptcha, detectPrecondition, type Precondition } from '../cascade/preconditions.js';
import { TrajectoryRecorder, formatPathStats, pathStats } from '../recorder/trajectory.js';
import { browserConfig, type BrowserConfig } from './config.js';
import { PlaywrightBrowserDriver, type ActionKind, type DriverActResult, type TargetInfo } from './driver.js';
import type { CascadePath, Expect } from '../types.js';

export interface SessionEnv {
  sessionId: string;
  workspace: string;
  config: HarnessConfig;
  policy?: PermissionPolicy;
  emit?: (e: AgentEvent) => void;
  model?: string;
}

export class BrowserSession {
  readonly cfg: BrowserConfig;
  readonly driver: PlaywrightBrowserDriver;
  readonly vault: SecretVault;
  readonly fence: FenceTracker;
  readonly limiter: ActionLimiter;
  readonly mask: (s: string) => string;
  recorder?: TrajectoryRecorder;
  /** Consent for attached mode, asked once per session (E6 AC3). */
  attachConsent?: boolean;
  consentAsks = 0;
  private idleTimer?: NodeJS.Timeout;
  private offKill: () => void;
  private turn: number | string = 0;
  /** Expectation attached to the current action (destructive check). */
  private currentExpect?: Expect;

  constructor(readonly env: SessionEnv) {
    this.cfg = browserConfig(env.config);
    this.vault = new SecretVault(env.config.homeDir);
    this.mask = makeMasker(() => this.vault.usedValues());
    this.fence = new FenceTracker(this.cfg.maxActionsPerTurn);
    this.limiter = new ActionLimiter(this.cfg.actionsPerMinute, this.cfg.maxIdenticalActions);
    const allowHosts = env.config.web.allowHosts ?? [];
    this.driver = new PlaywrightBrowserDriver({
      homeDir: env.config.homeDir,
      headless: this.cfg.headless,
      executablePath: this.cfg.executablePath,
      profile: this.cfg.profile,
      cdpUrl: this.cfg.cdpUrl,
      engine: this.cfg.snapshotEngine,
      snapshotTokens: this.cfg.snapshotTokens,
      maxRepeated: this.cfg.maxRepeatedSiblings,
      maxTextChars: this.cfg.maxTextChars,
      actionTimeoutMs: this.cfg.actionTimeoutMs,
      navigationTimeoutMs: this.cfg.navigationTimeoutMs,
      extensionPolicy: { coreSites: this.cfg.attachedAllowDomains, allowHosts, strictSubresources: this.cfg.attachedStrictSubresources },
      hooks: {
        checkUrl: async (u, info) => {
          const realBrowser = this.driver.profile === 'attached' || this.driver.profile === 'extension';
          if (realBrowser && !domainAllowed(u.hostname, this.cfg.attachedAllowDomains)) {
            // Top-level pages must be allowlisted; subresources (CDNs) only in strict mode. Private/metadata hosts fall to the SSRF guard below.
            if (info.navigation && info.mainFrame) return `${u.hostname} is not in browser.attachedAllowDomains (attached mode only reaches allowlisted sites)`;
            if (this.cfg.attachedStrictSubresources) return `${u.hostname} is not in browser.attachedAllowDomains (browser.attachedStrictSubresources)`;
          }
          try {
            await assertPublicUrl(u, allowHosts);
            return undefined;
          } catch (e) {
            return (e as Error).message;
          }
        },
        resolveSecret: async (ref) => {
          const v = await this.vault.resolve(ref);
          registerSecretValues([v]);
          return v;
        },
        mask: this.mask,
        egress: { allowHosts },
        secretValues: () => this.vault.usedValues(),
        downloadPath: (name) => {
          const abs = path.resolve(env.workspace, this.cfg.downloadsDir, name);
          const d = env.policy?.check({ tool: 'browser_download', kind: 'edit', paths: [{ path: abs, write: true }] });
          if (d?.decision === 'deny') return { error: d.reason };
          return { path: abs };
        },
        checkUpload: (files) => {
          const missing = files.filter((f) => !fs.existsSync(f));
          return missing.length ? `file not found: ${missing.join(', ')}` : undefined;
        },
      },
    });
    this.offKill = onKill(() => void this.close());
    if (this.cfg.record) {
      this.recorder = new TrajectoryRecorder(path.join(env.workspace, '.tugline', 'runs', env.sessionId.replace(/[^\w.-]/g, '_')), {
        session: env.sessionId,
        surface: 'browser',
        model: env.model,
        versions: { tugline: '1.0', engine: this.cfg.snapshotEngine },
      });
    }
  }

  beginTurn(turn: number | string): void {
    this.turn = turn;
    this.fence.beginTurn(turn);
  }

  get currentTurn(): number | string {
    return this.turn;
  }

  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.cfg.idleCloseMs > 0) {
      this.idleTimer = setTimeout(() => void this.close(), this.cfg.idleCloseMs);
      this.idleTimer.unref();
    }
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.recorder?.flushMeta({ endedAt: new Date().toISOString() });
    await this.driver.close();
  }

  dispose(): Promise<void> {
    this.offKill();
    return this.close();
  }

  /** The policy guard run by the driver after resolving the target and before acting. */
  guard = async (t: TargetInfo | undefined, kind: ActionKind, action: string): Promise<PolicyVerdict> => {
    const killed = assertNotKilled();
    if (!killed.ok) return killed;
    const facts = await this.driver.pageFacts();
    const submit = kind === 'act' ? !!t?.info?.submit && action === 'click' : kind === 'type' ? action === 'submit' : kind === 'key' ? /Enter/.test(action) && facts.cardFields : false;
    const h = handoffCheck({ kind, name: t?.node.name, submit, fieldKind: t?.info?.fieldKind }, { cardFields: facts.cardFields, otpField: facts.otpField, captcha: detectCaptcha({ iframes: facts.iframes, title: facts.title, text: facts.text }) }, { allowPayments: this.cfg.allowPayments });
    if (!h.ok) return h;
    if (kind === 'act') {
      const d = destructiveCheck({ name: t?.node.name, action, hasExpect: !!this.currentExpect }, this.cfg.requireExpectForDestructive);
      if (!d.ok) return d;
    }
    const ft: FenceTarget = { kind: kind === 'point' ? 'point' : kind, action, role: t?.node.role, name: t?.node.name, states: t?.node.states, haspopup: t?.info?.haspopup, submit };
    const f = this.fence.check(ft);
    if (!f.ok) return f;
    const r = this.limiter.take(`${kind}:${action}:${t?.key ? `${t.key.role}|${t.key.name}|${t.key.nth}` : t?.ref ?? ''}`);
    if (!r.ok) return r;
    this.fence.record(ft);
    return { ok: true };
  };

  /**
   * Guard for deterministic replay (L2a recipes, `tug replay`): the kill switch
   * and human handoff still apply; the fence rule does not, because no model is
   * choosing actions blind.
   */
  replayGuard = async (t: TargetInfo | undefined, kind: ActionKind, action: string): Promise<PolicyVerdict> => {
    const killed = assertNotKilled();
    if (!killed.ok) return killed;
    const facts = await this.driver.pageFacts();
    const submit = kind === 'act' ? !!t?.info?.submit && action === 'click' : kind === 'type' ? action === 'submit' : false;
    return handoffCheck({ kind, name: t?.node.name, submit, fieldKind: t?.info?.fieldKind }, { cardFields: facts.cardFields, otpField: facts.otpField, captcha: detectCaptcha({ iframes: facts.iframes, title: facts.title, text: facts.text }) }, { allowPayments: this.cfg.allowPayments });
  };

  /** Run an act-like call with the destructive-check context set. */
  async withExpect<T>(expect: Expect | undefined, fn: () => Promise<T>): Promise<T> {
    this.currentExpect = expect;
    try {
      return await fn();
    } finally {
      this.currentExpect = undefined;
    }
  }

  /** L0 detectors over the current page. */
  async precondition(): Promise<Precondition | undefined> {
    const facts = await this.driver.pageFacts();
    const s = this.driver.latest;
    return detectPrecondition({ status: this.driver.status, title: facts.title, text: facts.text, iframes: facts.iframes, passwordFields: facts.passwords.length, elementCount: s?.elementCount, canvas: facts.canvas });
  }

  record(tool: string, args: Record<string, unknown>, r: Partial<DriverActResult> & { path?: CascadePath | string }, extra: { expect?: Expect; url?: string } = {}): void {
    if (this.recorder) {
      const t = r.target;
      this.recorder.write({
        turn: this.turn,
        tool,
        path: r.path,
        args: sanitizeArgs(args, this.mask),
        url: extra.url ?? r.url,
        target: t ? { role: t.role, name: t.name, key: t.semantic, selector: t.selector } : undefined,
        preHash: r.preHash,
        outcome: r.outcome,
        errorCode: r.errorCode,
        diff: r.diff ? this.mask(r.diff).slice(0, 4000) : undefined,
        expect: extra.expect,
      });
    }
    this.env.emit?.({ type: 'automation', surface: 'browser', tool, path: r.path, outcome: r.outcome, errorCode: r.errorCode });
  }

  stats(): { stats: Record<string, number>; text: string } {
    const s = pathStats(this.recorder?.steps ?? []);
    return { stats: s, text: formatPathStats(s) };
  }
}

/** Never record typed secrets: only refs. Plain typed text is masked like page output. */
function sanitizeArgs(a: Record<string, unknown>, mask: (s: string) => string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? mask(v) : v;
  }
  return out;
}

// ------------------------------------------------------------ registry

const sessions = new Map<string, BrowserSession>();
/** Latest model turn per agent session, noted even before the first browser call creates the session. */
const turns = new Map<string, number | string>();

export function noteTurn(sessionId: string, turn: number | string): void {
  turns.set(sessionId, turn);
  sessions.get(sessionId)?.beginTurn(turn);
}

export function getBrowserSession(env: SessionEnv): BrowserSession {
  let s = sessions.get(env.sessionId);
  if (!s) {
    s = new BrowserSession(env);
    sessions.set(env.sessionId, s);
    const t = turns.get(env.sessionId);
    if (t !== undefined) s.beginTurn(t);
  }
  s.touch();
  return s;
}

export function peekBrowserSession(sessionId: string): BrowserSession | undefined {
  return sessions.get(sessionId);
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  sessions.delete(sessionId);
  turns.delete(sessionId);
  await s?.dispose();
}

export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(closeBrowserSession));
}
