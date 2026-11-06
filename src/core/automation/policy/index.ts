/**
 * Automation policy (research CU §4, §5.4; S9/S10): deterministic code outside
 * the model that every browser (and later desktop) action passes through.
 *
 *  - kill switch: one global flag that stops every automation surface at once;
 *  - rate limits: actions per minute, and a loop breaker for identical actions;
 *  - the S9 fence rule: at most N actions per model turn, and a "fence" action
 *    (dropdown/menu/combobox trigger, submit, navigation) must be alone in its
 *    turn, because the model "has no eyes between turns";
 *  - human handoff: payments, 2FA and CAPTCHAs are never automated;
 *  - destructive targets need an explicit post-condition;
 *  - domain allowlists (attached mode).
 *
 * Surface-agnostic on purpose: WS6 desktop reuses it with its own targets.
 */
import type { AutomationErrorCode } from '../types.js';

export interface PolicyVerdict {
  ok: boolean;
  code?: AutomationErrorCode;
  message?: string;
}

const OK: PolicyVerdict = { ok: true };

// ------------------------------------------------------------ kill switch

let killed: { reason: string; at: number } | undefined;
const killListeners = new Set<(reason: string) => void>();

/** Stop all automation now. Drivers listening release input and close. */
export function killAutomation(reason = 'kill switch'): void {
  killed = { reason, at: Date.now() };
  for (const l of killListeners) {
    try {
      l(reason);
    } catch {
      /* listeners never block the kill */
    }
  }
}

export function resetKillSwitch(): void {
  killed = undefined;
}

export function isKilled(): boolean {
  return !!killed;
}

export function onKill(fn: (reason: string) => void): () => void {
  killListeners.add(fn);
  return () => killListeners.delete(fn);
}

export function assertNotKilled(): PolicyVerdict {
  return killed ? { ok: false, code: 'killed', message: `automation was stopped (${killed.reason}); a human must reset it` } : OK;
}

// ------------------------------------------------------------ rate limits

export class ActionLimiter {
  private times: number[] = [];
  private lastSig = '';
  private same = 0;
  constructor(private perMinute: number, private maxIdentical: number, private now: () => number = Date.now) {}

  /** Check and record one action. `sig` identifies identical actions (tool + target + value). */
  take(sig: string): PolicyVerdict {
    const t = this.now();
    this.times = this.times.filter((x) => t - x < 60_000);
    if (this.perMinute > 0 && this.times.length >= this.perMinute) return { ok: false, code: 'rate_limited', message: `more than ${this.perMinute} actions in a minute; slow down or ask the user` };
    const same = sig === this.lastSig ? this.same + 1 : 1;
    if (this.maxIdentical > 0 && same > this.maxIdentical) return { ok: false, code: 'rate_limited', message: `the same action was repeated ${same - 1} times in a row; it is not working. Take a snapshot and change approach.` };
    this.times.push(t);
    this.lastSig = sig;
    this.same = same;
    return OK;
  }
}

// ------------------------------------------------------------ fence rule

export interface FenceTarget {
  /** What kind of action: act (click/select/…), type, key, navigate. */
  kind: 'act' | 'type' | 'key' | 'navigate' | 'point';
  action?: string;
  role?: string;
  name?: string;
  states?: string[];
  /** aria-haspopup on the target */
  haspopup?: boolean;
  /** The action submits a form (submit button, Enter in a form field). */
  submit?: boolean;
}

const FENCE_ROLES = new Set(['combobox', 'menu', 'menubar', 'listbox', 'menuitem']);

/** Why this action is a fence (changes the DOM in ways the model must re-read), or undefined. */
export function fenceReason(t: FenceTarget): string | undefined {
  if (t.kind === 'navigate') return 'navigation';
  if (t.submit) return 'form submit';
  if (t.kind === 'key') return /^(Enter|NumpadEnter)$/i.test(t.action ?? '') ? 'Enter may submit' : undefined;
  if (t.kind === 'type') return undefined;
  if (t.role && FENCE_ROLES.has(t.role)) return `${t.role} (dropdown)`;
  if (t.haspopup || t.states?.some((s) => s === 'haspopup' || s.startsWith('expanded') || s.startsWith('haspopup='))) return 'opens a popup';
  if (t.role === 'link' && (t.action ?? 'click') === 'click') return 'link (navigation)';
  // S9 dropdown heuristics on the visible label
  const name = (t.name ?? '').trim();
  if (/[▾▼⌄]$|:$/.test(name) || /^sort\s*:/i.test(name)) return 'dropdown trigger';
  return undefined;
}

/** Per-turn action counter implementing the fence rule. One per session. */
export class FenceTracker {
  private turn: number | string | undefined;
  private count = 0;
  private fence: string | undefined;
  constructor(private maxPerTurn = 2) {}

  beginTurn(turn: number | string): void {
    if (turn === this.turn) return;
    this.turn = turn;
    this.count = 0;
    this.fence = undefined;
  }

  get actionsThisTurn(): number {
    return this.count;
  }

  check(t: FenceTarget): PolicyVerdict {
    if (this.fence) return { ok: false, code: 'policy_denied', message: `fence rule: the previous action this turn (${this.fence}) can change the page. Take a fresh browser_snapshot in your next turn before acting again.` };
    if (this.count >= this.maxPerTurn) return { ok: false, code: 'policy_denied', message: `fence rule: at most ${this.maxPerTurn} actions per turn. Check the result, then continue next turn.` };
    const why = fenceReason(t);
    if (why && this.count > 0) return { ok: false, code: 'policy_denied', message: `fence rule: this action is a fence (${why}) and must be the only action in its turn. Send it alone next turn.` };
    return OK;
  }

  record(t: FenceTarget): void {
    this.count++;
    const why = fenceReason(t);
    if (why) this.fence = why;
  }
}

// ------------------------------------------------------------ human handoff

export interface PageFacts {
  /** Card number / CVC / expiry inputs present. */
  cardFields: boolean;
  /** One-time-code / 2FA input present. */
  otpField: boolean;
  captcha?: boolean;
}

export interface HandoffTarget {
  kind: 'act' | 'type' | 'key' | 'point';
  name?: string;
  submit?: boolean;
  /** The target itself is a card / OTP field. */
  fieldKind?: 'card' | 'otp' | 'password' | 'other';
}

const PAY_WORDS = /\b(pay|payment|purchase|checkout|check out|place order|buy|complete order|confirm order|subscribe)\b/i;

/** needs_human for payments, 2FA and CAPTCHAs (never automated), else ok. */
export function handoffCheck(t: HandoffTarget, facts: PageFacts, opts: { allowPayments: boolean }): PolicyVerdict {
  if (facts.captcha) return { ok: false, code: 'blocked_captcha', message: 'this page shows a CAPTCHA. Do not try to solve it: ask the human to complete it in a headed browser, or use another source.' };
  if (!opts.allowPayments) {
    if (t.fieldKind === 'card') return { ok: false, code: 'needs_human', message: 'this is a payment-card field. The agent never enters card details: ask the human to complete the payment.' };
    if (facts.cardFields && (t.submit || PAY_WORDS.test(t.name ?? ''))) return { ok: false, code: 'needs_human', message: 'this submits a payment (the page has card fields). Stop and ask the human to review and complete the payment themselves.' };
  }
  if (t.fieldKind === 'otp') return { ok: false, code: 'needs_human', message: 'this is a 2FA / one-time-code field. Ask the human to enter the code.' };
  return OK;
}

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|drop|discard|wipe|purge|deactivate|close account|cancel (my )?subscription|unsubscribe)\b/i;

/** Destructive targets need an explicit `expect` (research CU §5.6). */
export function destructiveCheck(t: { name?: string; action?: string; hasExpect: boolean }, required: boolean): PolicyVerdict {
  if (!required || t.hasExpect) return OK;
  if (DESTRUCTIVE.test(t.name ?? '') && (t.action ?? 'click') !== 'hover' && (t.action ?? 'click') !== 'focus')
    return { ok: false, code: 'policy_denied', message: `"${t.name}" looks destructive: repeat the call with an explicit "expect" describing the intended result, e.g. {"text_present":"deleted"}` };
  return OK;
}

// ------------------------------------------------------------ domains

/** `example.com` matches itself, `*.example.com` matches subdomains, `*` matches all. */
export function domainAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return patterns.some((p) => {
    const q = p.toLowerCase().trim();
    if (q === '*') return true;
    if (q.startsWith('*.')) return h.endsWith(q.slice(1)) || h === q.slice(2);
    return h === q;
  });
}
