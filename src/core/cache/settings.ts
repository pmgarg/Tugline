/**
 * WS10 config sections (SPEC S0.4 declaration merging): `promptCache` (N10)
 * and `memory` (N20). Defaults live here; untrusted project config drops
 * unknown sections like every other extension section.
 */
import type { HarnessConfig } from '../config.js';

export interface PromptCacheConfig {
  /** Emit `cache_break` events when the cached prefix changes (default true). */
  guard?: boolean;
  /** Keep the system prompt byte-identical across runs when only the date/git lines changed; the update rides on the user message (default true). */
  stableEnvironment?: boolean;
  /** Compact while the user is idle, keeping the system prompt and tools byte-identical (default true). */
  idleCompaction?: boolean;
  /** Idle time after a run before compacting (ms, default 30000). */
  idleCompactMs?: number;
  /** Compact at idle once the history passes this fraction of the compaction budget (default 0.6, like the D8 background summary). */
  idleCompactAt?: number;
}

export interface MemoryConfig {
  /**
   * N20: offer the `memory_consolidate` tool (writes a proposal file only, never MEMORY.md),
   * for scheduled (H1) runs. Default false: interactive users run `/memory consolidate`.
   */
  consolidateTool?: boolean;
  /** N20: how many recent session journals `--journals` mines by default (default 5). */
  journalSessions?: number;
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    promptCache?: PromptCacheConfig;
    memory?: MemoryConfig;
  }
}

export const DEFAULT_PROMPT_CACHE: Required<PromptCacheConfig> = {
  guard: true,
  stableEnvironment: true,
  idleCompaction: true,
  idleCompactMs: 30_000,
  idleCompactAt: 0.6,
};

export function promptCacheSettings(cfg: HarnessConfig | undefined): Required<PromptCacheConfig> {
  const c = (cfg?.promptCache ?? {}) as PromptCacheConfig;
  const out = { ...DEFAULT_PROMPT_CACHE };
  for (const k of Object.keys(out) as (keyof PromptCacheConfig)[]) if (c[k] !== undefined && c[k] !== null) (out as any)[k] = c[k];
  out.idleCompactMs = Math.max(0, Number(out.idleCompactMs) || 0);
  out.idleCompactAt = Math.min(1, Math.max(0, Number(out.idleCompactAt) || 0));
  return out;
}

export function memorySettings(cfg: HarnessConfig | undefined): Required<MemoryConfig> {
  const m = (cfg?.memory ?? {}) as MemoryConfig;
  return { consolidateTool: m.consolidateTool === true, journalSessions: Math.max(0, Math.floor(Number(m.journalSessions ?? 5) || 0)) };
}
