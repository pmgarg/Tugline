/**
 * Scheduled tasks and event triggers (SPEC H1; EAG S16 "an agent that notices").
 *
 * Two kinds of record, kept apart on purpose:
 *  - an EVENT is a fact (`source`, `id`, `type`, `actor`, `data`). It carries no
 *    instruction and no permission;
 *  - a SCHEDULE (S16's "subscription") is written by a human with `tug schedule
 *    add`. It holds the instruction, the permission mode, the budgets and the
 *    actors to ignore. An event can never create or widen one.
 */
import type { PermissionMode } from '../types.js';
import type { CronTz } from './cron.js';

export type Trigger =
  | { type: 'cron'; cron: string; tz?: CronTz }
  | { type: 'watch'; glob: string; debounceMs?: number }
  | { type: 'webhook' }
  /** GitHub webhooks (POST /hooks/<id> with X-GitHub-Event). `events` like "pull_request.opened", "push", "issues.*". */
  | { type: 'github'; events: string[] };

export interface Schedule {
  id: string;
  name?: string;
  trigger: Trigger;
  /** The instruction (written by a human). Event data is appended as untrusted context. */
  prompt: string;
  workspace: string;
  profile?: string;
  /**
   * Permission mode for runs. Default 'ask', which headless means: anything that
   * would ask is denied and recorded. 'auto' only when the schedule says so.
   */
  mode?: PermissionMode;
  /** Window governor (S16): max runs per UTC day (0 = schedule.defaultMaxRunsPerDay). */
  maxRunsPerDay?: number;
  /** Window governor: max spend per UTC day in USD (0 = unlimited). Each run's ceiling shrinks to what is left. */
  dailyBudgetUsd?: number;
  /**
   * v1.1 R4: budgets for endpoints with no per-token price (a local GPU): tokens per UTC
   * day, and GPU-seconds per UTC day (wall time of a run × `gpuShare`). 0/absent = no limit.
   */
  dailyTokens?: number;
  dailyGpuSeconds?: number;
  /** The share of the GPU this schedule's endpoint uses (default schedule.gpuShare, 1 = a dedicated GPU). */
  gpuShare?: number;
  /**
   * v1.1 R4: the most one run may reserve from the day's window (USD / tokens / GPU-seconds).
   * Default: everything still unreserved, so a second event that arrives while a run is in
   * flight is refused (governor_budget) instead of being handed the same ceiling.
   */
  runBudgetUsd?: number;
  runTokens?: number;
  runGpuSeconds?: number;
  /**
   * v1.1 R9: when another writer holds the workspace, 'wait' (default) waits for it up to
   * `workspaceWaitMs`; 'worktree' runs in a fresh git worktree (branch oh/sched-<run>) instead.
   */
  isolation?: 'wait' | 'worktree';
  workspaceWaitMs?: number;
  /** Actors whose events are ignored (in addition to the runtime's own identity). */
  ignoreActors?: string[];
  enabled: boolean;
  createdAt: string;
}

/** A normalised inbound event (cron tick, file change, webhook, GitHub, resume). */
export interface TriggerEvent {
  /** Sender-chosen identity, unique within `source`; the dedupe key is `source/id`. */
  id: string;
  /** e.g. "cron", "watch", "webhook:<scheduleId>", "github:<scheduleId>" */
  source: string;
  /** e.g. "cron.tick", "file.changed", "pull_request.opened" */
  type: string;
  subject?: string;
  /** Who caused it (GitHub sender login, the harness itself for its own writes). */
  actor?: string;
  /** The schedule this event is addressed to (webhook routes and cron know it). */
  scheduleId?: string;
  data?: unknown;
  receivedAt: string;
}

/** One line of the append-only activity log (feeds the morning report). */
export interface ActivityRecord {
  ts: string;
  kind: 'arrived' | 'acted' | 'ignored' | 'refused' | 'parked' | 'resumed' | 'skipped' | 'denied' | 'error' | 'deferred' | 'cancelled' | 'reactivated';
  key?: string;
  scheduleId?: string;
  /** refusal / ignore / skip reason code: duplicate, rate_limited, self_trigger, governor_runs, governor_budget, no_match, disabled, lease_held, bad_signature … */
  reason?: string;
  detail?: string;
  runId?: string;
  costUsd?: number;
  stopReason?: string;
  handle?: string;
}

export interface ScheduleConfig {
  /** The runtime's own actor names; events from them are refused as self_trigger. */
  selfActors: string[];
  /** Max runs per schedule per UTC day when a schedule does not set its own. */
  defaultMaxRunsPerDay: number;
  /** Intake rate limit: events per source per minute, enforced before persistence. */
  ratePerMinute: number;
  /** Webhook listener for `tug daemon` (server mode mounts the same routes on its own port). */
  host: string;
  port: number;
  maxBodyBytes: number;
  heartbeatMs: number;
  /** A heartbeat older than this is "stale": the liveness route returns 503. */
  staleMs: number;
  /** How long cron leases last (a crashed daemon's lease expires). */
  leaseMs: number;
  /**
   * v1.1 R3: a claim on a parked wait is a lease. If the resumed run has not become durable
   * (its run record written) within this time, the claim is presumed crashed and re-claimable.
   */
  claimLeaseMs: number;
  /** v1.1 R4: default GPU share for GPU-second budgets (1 = the endpoint has the GPU to itself). */
  gpuShare: number;
}

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  selfActors: ['tugline', 'tugline[bot]'],
  defaultMaxRunsPerDay: 24,
  ratePerMinute: 30,
  host: '127.0.0.1',
  port: 7880, // tug serve uses 7878 and tug channels 7879
  maxBodyBytes: 1_000_000,
  heartbeatMs: 30_000,
  staleMs: 120_000,
  leaseMs: 10 * 60_000,
  claimLeaseMs: 10 * 60_000,
  gpuShare: 1,
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC H1 (WS8). */
    schedule?: Partial<ScheduleConfig>;
  }
}

import type { HarnessConfig } from '../config.js';
export function scheduleConfig(cfg: HarnessConfig): ScheduleConfig {
  return { ...DEFAULT_SCHEDULE, ...(cfg.schedule ?? {}) };
}
