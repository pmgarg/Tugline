/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: ported from Qwen Code
 * packages/core/src/permissions/denialTracking.ts (commit c726d2c). Changes:
 *  - the total cap SUSPENDS auto mode for the session (every later call goes to
 *    the human until the user resumes it with `/auto resume` or re-selects the
 *    mode), instead of downgrading one call and clearing the counters when the
 *    human approves it (Qwen: a model can keep probing for an allowed phrasing
 *    after each approval);
 *  - "unavailable" is a separate counter with its own circuit breaker
 *    (consecutive unavailable verdicts skip the classifier for a cooldown, so a
 *    dead endpoint does not stall every call for a full timeout); it never counts
 *    towards the block caps and never suspends;
 *  - the limits are configuration (autoMode.*), state is keyed per root session
 *    (a subagent shares its parent's counters, so spawning one does not reset them);
 *  - fingerprints of blocked actions are kept (bounded) so the transcript can mark
 *    a later retry of a blocked action for the classifier.
 */

export interface DenialLimits {
  /** Consecutive classifier blocks after which the blocking call goes to a human prompt (default 3). */
  maxConsecutiveBlocks: number;
  /** Total classifier blocks in a session after which auto mode is suspended (default 20). */
  maxTotalBlocks: number;
  /** Consecutive "unavailable" verdicts after which the classifier is skipped for `unavailableCooldownMs` (default 3). */
  maxConsecutiveUnavailable: number;
  unavailableCooldownMs: number;
}

export const DEFAULT_DENIAL_LIMITS: DenialLimits = { maxConsecutiveBlocks: 3, maxTotalBlocks: 20, maxConsecutiveUnavailable: 3, unavailableCooldownMs: 120_000 };

export interface DenialState {
  consecutiveBlock: number;
  totalBlock: number;
  consecutiveUnavailable: number;
  totalUnavailable: number;
  /** Auto mode suspended by the total cap: every call goes to the human until resumed. */
  suspended: boolean;
  /** Classifier skipped (circuit open) until this time (ms epoch). */
  unavailableUntil: number;
  /** Fingerprints of recently blocked actions (newest last, bounded). */
  blocked: string[];
}

export function createDenialState(): DenialState {
  return { consecutiveBlock: 0, totalBlock: 0, consecutiveUnavailable: 0, totalUnavailable: 0, suspended: false, unavailableUntil: 0, blocked: [] };
}

/** An allow (fast path or classifier) resets both consecutive counters. */
export function recordAllow(s: DenialState): DenialState {
  if (!s.consecutiveBlock && !s.consecutiveUnavailable) return s;
  return { ...s, consecutiveBlock: 0, consecutiveUnavailable: 0 };
}

/** A classifier policy block: counts towards both block caps; resets the unavailable streak. */
export function recordBlock(s: DenialState, fingerprint: string | undefined, limits: DenialLimits): DenialState {
  const blocked = fingerprint ? [...s.blocked.filter((f) => f !== fingerprint), fingerprint].slice(-50) : s.blocked;
  const totalBlock = s.totalBlock + 1;
  return { ...s, consecutiveBlock: s.consecutiveBlock + 1, consecutiveUnavailable: 0, totalBlock, blocked, suspended: s.suspended || totalBlock >= limits.maxTotalBlocks };
}

/** The classifier could not answer (error, timeout, unparseable twice): counted separately. */
export function recordUnavailable(s: DenialState, limits: DenialLimits, now = Date.now()): DenialState {
  const consecutiveUnavailable = s.consecutiveUnavailable + 1;
  return {
    ...s,
    consecutiveBlock: 0,
    consecutiveUnavailable,
    totalUnavailable: s.totalUnavailable + 1,
    unavailableUntil: consecutiveUnavailable >= limits.maxConsecutiveUnavailable ? now + limits.unavailableCooldownMs : s.unavailableUntil,
  };
}

/** A human answered a call that denial tracking sent to them: the consecutive streak starts again. */
export function recordHumanReview(s: DenialState): DenialState {
  return { ...s, consecutiveBlock: 0 };
}

/** The block that reaches the consecutive cap goes to a human instead of back to the model. */
export function reachedConsecutiveCap(s: DenialState, limits: DenialLimits): boolean {
  return s.consecutiveBlock >= limits.maxConsecutiveBlocks;
}

/** Circuit open: skip the classifier (the call goes to the human at once). */
export function classifierCoolingDown(s: DenialState, now = Date.now()): boolean {
  return s.unavailableUntil > now;
}

export function wasBlocked(s: DenialState, fingerprint: string): boolean {
  return s.blocked.includes(fingerprint);
}

export function formatDenialState(s: DenialState, limits: DenialLimits = DEFAULT_DENIAL_LIMITS): string {
  return `blocks ${s.consecutiveBlock}/${limits.maxConsecutiveBlocks} in a row, ${s.totalBlock}/${limits.maxTotalBlocks} in the session; classifier unavailable ${s.consecutiveUnavailable} in a row, ${s.totalUnavailable} in the session${s.suspended ? '; SUSPENDED (every call asks you; /auto resume to continue)' : ''}`;
}

/**
 * Trailing guidance on a classifier block (ported from Qwen's AUTO_MODE_DENIAL_GUIDANCE, shortened for small models).
 * The policy boundary lives in code; this only tells the model how to behave after a block.
 */
export const DENIAL_GUIDANCE =
  'Do not try to do the blocked action another way (another tool, a script, an alias, a symlink, a config change, a hook, an encoded payload or an equivalent command). If the action is really needed, repeat the exact same call once to ask the user. Otherwise continue with unrelated safe work or choose a genuinely safer approach.';
