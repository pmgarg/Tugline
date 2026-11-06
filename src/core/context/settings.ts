/**
 * WS4 settings: defaults for the v1.0 `agent.*` additions and the `routing`
 * section (SPEC S0.4, D10). config.ts only declares the optional fields; the
 * defaults live here so the shared config file stays untouched.
 */
import type { HarnessConfig } from '../config.js';

/** D10: model routing ladder. Each value is a profile name from `profiles`. */
export interface RoutingConfig {
  /** main loop while in plan mode */
  planner?: string;
  /** edit/apply helper calls (A8 apply model may use it) */
  editor?: string;
  /** compaction and "summarise up to here" */
  summarizer?: string;
  /** explore subagents */
  explore?: string;
  /** classifier approver (C3) */
  approver?: string;
}

export type RoutingRole = keyof RoutingConfig | 'main';

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** v1.1 R6: anchor each journal record's hash outside the workspace (http(s) URL or absolute file path). */
    audit?: { sink?: string };
    routing?: RoutingConfig;
  }
  interface AgentConfigExtensions {
    /** D1: concurrent `task` calls per turn (default 3) */
    maxParallelSubagents?: number;
    /** D3: 'auto' defers schemas when there are many tools; 'on' always; 'off' never (default auto) */
    toolSearch?: 'auto' | 'on' | 'off';
    /** D3: tool count above which only core tools + tool_search are sent (default 20) */
    toolSearchThreshold?: number;
    /** D3: while tool search is active, MCP tools are always deferred (never core). Default true. */
    deferMcpTools?: boolean;
    /** D3: extra tool names always sent in full when tool search is active */
    coreTools?: string[];
    /** D4: per-model prompt notes and request defaults (default true) */
    modelOverlays?: boolean;
    /** D5: bash run_in_background + job tools. Off by default (R2). */
    backgroundJobs?: boolean;
    /** D6: propose memories at session end (asks the user). Off by default. */
    autoMemory?: boolean;
    /** D7: repo-map token budget in the first-turn context; 0 = off (default 1500) */
    repoMapTokens?: number;
    /** D7: globs never mapped (default: eval task trees). .tuglineignore and secret files are always excluded. */
    repoMapExclude?: string[];
    /** R15: max source files the repo map scans; 0 = no limit (default). Was a fixed 3000. */
    repoMapMaxFiles?: number;
    /** R15: persist per-file extraction under <homeDir>/index/<project>/ so later sessions reparse only changed files (default true) */
    repoMapCache?: boolean;
    /** D8: pre-build the compaction summary in the background at 60% of the budget (default true) */
    backgroundCompaction?: boolean;
    /** G2: after untrusted content is read, outbound actions (exfiltration, publishing, persistence, outside writes) need a human. Default 'ask'. */
    taint?: 'ask' | 'off';
    /** G2: while tainted, shell commands run sandboxed with network 'none' (default) or only package 'registries' (N30 proxy preset). */
    taintShellNetwork?: 'none' | 'registries';
    /** G2: background jobs that started before the run was tainted: 'stop' them (default) or 'keep' them (warned). */
    taintJobs?: 'stop' | 'keep';
    /** v1.1 R8: documents the user had unsaved changes in, before a shell command: 'ask' (default), 'save' first, or run against the 'disk' version. */
    unsavedBuffers?: 'ask' | 'save' | 'disk';
    /** v1.1 R2: the project's check, run by the harness itself to verify the work (the documented way to get `verified` reliably) */
    verifyCommands?: string[];
    /** v1.1 R2 batch 4: the harness runs the check fixed at run start when the model claims success and at the end of the run ('auto', default) or never ('off': runs end unverified) */
    harnessCheck?: 'auto' | 'off';
    /** v1.1 R2 batch 4: timeout for each harness check command (default 600000 ms) */
    checkTimeoutMs?: number;
  }
}

export interface CoreSettings {
  maxParallelSubagents: number;
  toolSearch: 'auto' | 'on' | 'off';
  toolSearchThreshold: number;
  deferMcpTools: boolean;
  coreTools: string[];
  modelOverlays: boolean;
  backgroundJobs: boolean;
  autoMemory: boolean;
  repoMapTokens: number;
  repoMapExclude: string[];
  repoMapMaxFiles: number;
  repoMapCache: boolean;
  backgroundCompaction: boolean;
  taint: 'ask' | 'off';
  taintShellNetwork: 'none' | 'registries';
  unsavedBuffers: 'ask' | 'save' | 'disk';
  taintJobs: 'stop' | 'keep';
  verifyCommands: string[];
  harnessCheck: 'auto' | 'off';
  checkTimeoutMs: number;
}

export const DEFAULT_CORE_SETTINGS: CoreSettings = {
  maxParallelSubagents: 3,
  toolSearch: 'auto',
  toolSearchThreshold: 20,
  deferMcpTools: true,
  coreTools: [],
  modelOverlays: true,
  backgroundJobs: false,
  autoMemory: false,
  repoMapTokens: 1500,
  repoMapExclude: ['**/evals/**/tasks/**'],
  repoMapMaxFiles: 0,
  repoMapCache: true,
  backgroundCompaction: true,
  taint: 'ask',
  taintShellNetwork: 'none',
  unsavedBuffers: 'ask',
  taintJobs: 'stop',
  verifyCommands: [],
  harnessCheck: 'auto',
  checkTimeoutMs: 600_000,
};

export function coreSettings(cfg: HarnessConfig): CoreSettings {
  const a = (cfg.agent ?? {}) as Partial<CoreSettings>;
  const out = { ...DEFAULT_CORE_SETTINGS };
  for (const k of Object.keys(out) as (keyof CoreSettings)[]) if (a[k] !== undefined && a[k] !== null) (out as any)[k] = a[k];
  out.maxParallelSubagents = Math.max(1, Math.floor(Number(out.maxParallelSubagents) || 1));
  out.repoMapTokens = Math.max(0, Math.floor(Number(out.repoMapTokens) || 0));
  out.checkTimeoutMs = Math.max(1000, Math.min(Math.floor(Number(out.checkTimeoutMs) || 600_000), 3_600_000));
  if (out.harnessCheck !== 'off') out.harnessCheck = 'auto';
  return out;
}
