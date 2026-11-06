/**
 * Per-session edit state, keyed by the agent's ReadLedger (one per Agent) so no
 * shared type has to change:
 *  - the host version token seen at read time (S0.1: document versions in VS Code,
 *    mtimes on disk) — the read-before-edit freshness check;
 *  - consecutive anchor failures per file (A5 suggests write_file after 2, A8 calls
 *    the apply model);
 *  - one-shot notices already shown this session (A7 routing advice).
 */
import type { ReadLedger } from '../tools/types.js';

interface SessionState {
  versions: Map<string, string>;
  failures: Map<string, number>;
  notices: Set<string>;
}

const states = new WeakMap<ReadLedger, SessionState>();

function state(ledger: ReadLedger): SessionState {
  let s = states.get(ledger);
  if (!s) {
    s = { versions: new Map(), failures: new Map(), notices: new Set() };
    states.set(ledger, s);
  }
  return s;
}

/** Record a read (or our own write) of `abs` at host version `version`. */
export function recordRead(ledger: ReadLedger, abs: string, version: string): void {
  const n = Number(version);
  ledger.record(abs, Number.isFinite(n) ? n : Date.now());
  state(ledger).versions.set(abs, version);
}

export function seenVersion(ledger: ReadLedger, abs: string): string | undefined {
  return ledger.has(abs) ? state(ledger).versions.get(abs) : undefined;
}

export function noteFailure(ledger: ReadLedger, abs: string): number {
  const s = state(ledger);
  const n = (s.failures.get(abs) ?? 0) + 1;
  s.failures.set(abs, n);
  return n;
}

export function failureCount(ledger: ReadLedger, abs: string): number {
  return state(ledger).failures.get(abs) ?? 0;
}

export function clearFailures(ledger: ReadLedger, abs: string): void {
  state(ledger).failures.delete(abs);
}

/** True the first time `key` is seen in this session. */
export function firstTime(ledger: ReadLedger, key: string): boolean {
  const s = state(ledger);
  if (s.notices.has(key)) return false;
  s.notices.add(key);
  return true;
}
