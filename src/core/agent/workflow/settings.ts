/**
 * v1.2 WS17 settings (N18 nesting and workflows, N34 teams, N35 goal verifier).
 * config.ts only gets these through declaration merging; defaults live here.
 */
import type { HarnessConfig } from '../../config.js';
import { maxDepthOf } from './clamp.js';

declare module '../../config.js' {
  interface AgentConfigExtensions {
    /** N18: how deep subagents may nest (root = 0). Default 2, maximum 4. */
    maxDepth?: number;
    /** N18: per-child budget cap for `task` subagents (in addition to the parent's remaining budget). */
    subagentMaxTokens?: number;
    subagentMaxCostUsd?: number;
    /** N18: images an agent definition may pick for its container backend (besides shell.dockerImage) */
    containerImages?: string[];
  }
  interface HarnessConfigExtensions {
    /** N18 workflows. */
    workflow?: Partial<WorkflowSettings>;
    /** N34 agent teams. */
    team?: Partial<TeamSettings>;
    /** N35 goal verifier. */
    goal?: Partial<GoalSettings>;
  }
}

export interface WorkflowSettings {
  /** most items one workflow may fan out to (typed refusal above it) */
  maxItems: number;
  /** most items in flight at once, whatever the spec asks */
  maxConcurrency: number;
  /** per-item wall-clock limit (backstop), ms */
  itemTimeoutMs: number;
  /** stall watchdog: an item with no progress (no model output, usage or tool event) for this long, while no tool is running, is stopped and retried, ms */
  stallMs: number;
}

export interface TeamSettings {
  /** default member cap (spec: 4), raised per team up to maxMembersHard */
  maxMembers: number;
  /** hard ceiling (spec: 8) */
  maxMembersHard: number;
  /** total team budget (all members); undefined = only the lead's own limits */
  maxTokens?: number;
  maxCostUsd?: number;
  /** per-member cap */
  memberMaxTokens?: number;
  memberMaxCostUsd?: number;
  /** messages one member may send per minute */
  messagesPerMinute: number;
  /** a member with nothing to do for this long stops (ms) */
  idleTimeoutMs: number;
  /** most runs (wake-ups) per member */
  maxMemberRuns: number;
  /** F6: a claim expires after this long unless its owner is still working (renewed at each run and team tool call), ms */
  claimLeaseMs: number;
  /** F12 (conversation delta): characters of team messages an external member's next run gets (newest first) */
  externalMessageChars: number;
}

export interface GoalSettings {
  /** profile used by the independent verifier (default: the main profile at temperature 0) */
  verifierModel?: string;
  verifierTemperature: number;
  /** verifier session turns */
  verifierMaxTurns: number;
  /** characters of diff the verifier receives (the rest is summarised as a file list) */
  maxDiffChars: number;
}

export const DEFAULT_WORKFLOW: WorkflowSettings = { maxItems: 200, maxConcurrency: 8, itemTimeoutMs: 15 * 60_000, stallMs: 180_000 };
export const DEFAULT_TEAM: TeamSettings = { maxMembers: 4, maxMembersHard: 8, messagesPerMinute: 20, idleTimeoutMs: 120_000, maxMemberRuns: 12, claimLeaseMs: 30 * 60_000, externalMessageChars: 6000 };
export const DEFAULT_GOAL: GoalSettings = { verifierTemperature: 0, verifierMaxTurns: 12, maxDiffChars: 40_000 };

export const workflowSettings = (c: HarnessConfig): WorkflowSettings => ({ ...DEFAULT_WORKFLOW, ...(c.workflow ?? {}) });
export function teamSettings(c: HarnessConfig): TeamSettings {
  const t = { ...DEFAULT_TEAM, ...(c.team ?? {}) };
  t.maxMembersHard = Math.min(8, Math.max(1, Math.floor(t.maxMembersHard)));
  t.maxMembers = Math.min(t.maxMembersHard, Math.max(1, Math.floor(t.maxMembers)));
  return t;
}
export const goalSettings = (c: HarnessConfig): GoalSettings => ({ ...DEFAULT_GOAL, ...(c.goal ?? {}) });
export const maxDepth = (c: HarnessConfig): number => maxDepthOf(c.agent.maxDepth);
