/**
 * L0 precondition layer (SPEC E3; S9 "if the page never loads, return a typed
 * error so the planner can re-route"; research CU §1.9).
 *
 * Detectors look at what any layer has: HTTP status, title, visible text,
 * iframe URLs, password fields, element counts. Each maps to a typed
 * error_code. They never "try harder": a CAPTCHA is reported, never solved.
 */
import type { AutomationErrorCode, CauseHint } from '../types.js';

export interface PreconditionInput {
  status?: number;
  url?: string;
  title?: string;
  /** Visible text (or extracted markdown). */
  text?: string;
  /** Raw HTML when available (L1 fetch). */
  html?: string;
  iframes?: string[];
  /** Password inputs on the page. */
  passwordFields?: number;
  /** Refs in the accessibility tree (browser) or AX elements (desktop). */
  elementCount?: number;
  canvas?: number;
}

export interface Precondition {
  code: AutomationErrorCode;
  causeHint?: CauseHint;
  message: string;
  /** Blocking codes stop the cascade; informational ones (login_required) are reported. */
  blocking: boolean;
}

const CAPTCHA_URL = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha-delivery|arkoselabs|funcaptcha/i;
const CAPTCHA_TEXT = /verify (that )?you are (a )?human|i'?m not a robot|are you a robot|just a moment\.\.\.|complete the security check|attention required!? \| cloudflare|unusual traffic from your (computer )?network/i;
const LOGIN_TEXT = /\b(sign in|log in|login|sign on)\b/i;

export function detectCaptcha(i: PreconditionInput): boolean {
  if ((i.iframes ?? []).some((u) => CAPTCHA_URL.test(u))) return true;
  if (i.html && /<iframe[^>]+src=["'][^"']*(recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile)/i.test(i.html)) return true;
  if (i.html && /class=["'][^"']*(g-recaptcha|h-captcha|cf-turnstile)/i.test(i.html)) return true;
  return CAPTCHA_TEXT.test(`${i.title ?? ''}\n${(i.text ?? '').slice(0, 5000)}`);
}

export function detectPrecondition(i: PreconditionInput): Precondition | undefined {
  if (detectCaptcha(i)) return { code: 'blocked_captcha', blocking: true, message: 'the page shows a CAPTCHA / bot check. Do not try to solve it: use another source, or ask the human to complete it in a headed browser and then continue.' };
  if (i.status === 429 || i.status === 403 || i.status === 503) return { code: 'gateway_blocked', blocking: true, message: `the site answered HTTP ${i.status} (blocked or rate-limited). Try another source or ask the human.` };
  if (i.status && i.status >= 400) return { code: 'gateway_blocked', blocking: true, message: `the page returned HTTP ${i.status}` };
  const text = (i.text ?? '').replace(/\s+/g, ' ').trim();
  const pw = i.passwordFields ?? (i.html ? (i.html.match(/<input[^>]+type=["']?password/gi) ?? []).length : 0);
  if (pw > 0 && LOGIN_TEXT.test(`${i.title ?? ''} ${text.slice(0, 2000)}`) && text.length < 1500)
    return { code: 'login_required', blocking: false, message: 'this is a login wall. Use browser_type with a secret://name ref for credentials (never ask for a password in chat), or ask the human to log in.' };
  if ((i.elementCount ?? 1) === 0 && text.length < 20) {
    const canvas = (i.canvas ?? 0) > 0;
    return { code: 'empty_tree', causeHint: canvas ? 'canvas' : undefined, blocking: false, message: canvas ? 'the page is drawn on a <canvas>: the tree cannot see it. Use browser_screenshot (vision or OCR regions) and browser_point.' : 'the page has no accessible content yet (still loading, or rendered without accessibility).' };
  }
  return undefined;
}
