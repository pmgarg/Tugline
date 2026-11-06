/**
 * The agent loop.
 *
 *   user prompt ─▶ [compact?] ─▶ LLM ─▶ tool calls? ──no──▶ (stop hooks, optional
 *                     ▲                    │yes                validator) ─▶ answer
 *                     └── tool results ◀── permission ▶ hooks ▶ run ▶ record
 *
 * Deterministic code owns every decision that matters (EAG S11/S12/S15/S16):
 * permissions, protected paths, budgets, thrash ceilings, compaction. The
 * model only proposes. The loop is a straight line (S17 §8): each failure earns
 * the next attempt as new messages; nothing is rewritten in place except
 * old tool output during compaction, and the journal keeps everything.
 */
import { attachmentBlock } from '../util/attachments.js';
import { forbiddenModes } from '../policy/managed.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, ChatMessage, CompletionStatus, ContentPart, ModelProfile, PermissionAnswer, PermissionMode, PermissionRequest, RunStats, StopReason, TodoItem, ToolSpec, VerificationEvidence } from '../types.js';
import { readUserConfigFile, resolveProfile, type HarnessConfig } from '../config.js';
import { LLMClient, LLMError, costOf, newToolCallId, type CompletionRequest, type CompletionResult, type CompletionToolCall } from '../llm/client.js';
import { PermissionPolicy, type CheckInput, type Decision } from '../permissions/policy.js';
import { denyReadPaths } from '../sandbox/settings.js';
import { ensurePublishedPricing } from '../llm/pricing.js';
import { authorityOf, broaderThan, modeWithin, narrowTools, type Authority } from '../permissions/authority.js';

declare module '../permissions/policy.js' {
  interface CheckInput {
    /** Ask a human in every permission mode, auto included (enforced by the agent loop). */
    alwaysAsk?: string;
  }
}
import { SkillManager, defaultSkillDirs, loadAgentDefinitions, type AgentDefinition } from '../skills/manager.js';
import { McpManager } from '../mcp/manager.js';
import { builtinTools, toolsForAgentType } from '../tools/index.js';
import { ReadLedger, ToolError, type SubagentRequest, type ToolContext, type ToolDef, type ToolOutput } from '../tools/types.js';
import { buildSystemPrompt, EXPLORE_ROLE, GENERAL_ROLE, VALIDATOR_ROLE } from './prompt.js';
import { compact, findCut, assembleCompacted, mechanicalSummary, safeCut, spanFingerprint, summarize } from './compaction.js';
import { Journal, JournalChainError } from './journal.js';
import { runHooks } from './hooks.js';
import { capOutput, contentToText, estimateMessagesTokens, estimateTokens, shortId, truncateLine } from '../util/text.js';
import { parseJsonLenient } from '../util/json.js';
import { bashBackgroundTool, bashTool, checkAllowlisted, commandWrapperFor, containerSandboxFor, execCommand, registerSecretValues, resetSessionCwd, scrubbedEnv } from '../tools/shell.js';
import { CORE_TOOL_NAMES, makeToolSearchTool } from '../tools/search.js';
import { makeTaskResultTool, type BackgroundTask } from '../tools/meta.js';
import { coreSettings, type RoutingRole } from '../context/settings.js';
import { applyOverlayDefaults, profileWithCapabilities, selectOverlay } from '../llm/overlays.js';
import { killJob, killSessionJobs, listJobs } from '../jobs/manager.js';
import { createWorktree, finishWorktree, removeWorktree, type Worktree } from '../context/worktree.js';
import { buildRepoMap, readableBy, repoMapCacheDir } from '../context/repomap.js';
import { taintCategory, taintContainment, untrustedEnvelope, withoutHarnessRelay, untrustedResult, type TaintContainment } from '../context/taint.js';
import { limitState, newBudgetPool, withAdmissionScope, withScopeOverride, type AdmissionScope, type BudgetPool } from '../llm/admission.js';
import { ChildRefusal, clampChild, type ChildRequest, type Clamp } from './workflow/clamp.js'; // WS17 N18
import { maxDepth } from './workflow/settings.js'; // WS17 N18
import { MEMBER_TOOLS, TEAM_TOOLS_AFTER_CREATE } from './team/names.js'; // WS17 N34: shown once a team exists
import { sandboxConfig } from '../sandbox/index.js';
import { emptyState, loadStateForJournal, stateFileFor, writeState, type RunCompletion, type SessionState } from '../context/sessionState.js';
import { addToBrief, briefFromMessages, briefToolText, renderBrief, type TaskBrief } from '../context/brief.js';
import { agentsMdVerifyCommands, classifyCheck, completionStatus, definitionChanges, fileVersion, onlyNewTests, snapshotCheckDefinitions, verificationNudge, zeroTestsReported } from '../context/verification.js';
import { cleanCheckEnv, makeCheckHome, outputTail, planChecks, prepareCheckPlan, programsInWorkspace, runnerUnavailable, untrustedChanges, type CheckPlan } from '../context/harnessCheck.js';
import { addMemory, memoryFile, proposeMemories } from '../memory/memory.js';
import { providerTools } from '../tools/registry.js';
import '../tools/providers.js';
import { diskHost, type WorkspaceHost } from '../host/workspace.js';
import { globalExtensions, type AgentApi, type AgentExtension, type AfterToolResult, type ApprovalDecision, type TurnGate } from './extensions.js';
import { stabilizeSystemPrompt } from '../cache/prefix.js'; // WS10 N10
import { promptCacheSettings } from '../cache/settings.js'; // WS10 N10

export interface AgentUI {
  onEvent?: (e: AgentEvent) => void;
  requestPermission?: (req: PermissionRequest) => Promise<PermissionAnswer>;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  approvePlan?: (plan: string) => Promise<boolean>;
}

interface Shared {
  policy: PermissionPolicy;
  skills: SkillManager;
  agentDefs: AgentDefinition[];
  mcp?: McpManager;
  allTools: ToolDef[];
  smallLlm: LLMClient;
  depth: number;
}

export interface AgentOptions {
  workspace: string;
  config: HarnessConfig;
  ui?: AgentUI;
  /** Where the agent runs: "terminal", "VS Code", "eval harness" */
  surface?: string;
  /** Directory of bundled skills shipped with the harness */
  bundledSkillsDir?: string;
  bundledAgentsDir?: string;
  sessionId?: string;
  /** v1.2 N49: keep only the tools this returns true for (CLI --allowed-tools / --exclude-tools) */
  toolFilter?: (t: ToolDef) => boolean;
  journal?: boolean;
  /** Connect MCP servers (default true) */
  mcp?: boolean;
  /** Extra tools (embedding apps) */
  extraTools?: ToolDef[];
  /** Testing: inject a client */
  llm?: LLMClient;
  /** Internal: subagent wiring */
  shared?: Shared;
  agentType?: string;
  roleOverride?: string;
  tools?: ToolDef[];
  /** File access backend (SPEC S0.1). Default: disk. */
  host?: WorkspaceHost;
  /** Per-agent extensions, run after globally registered ones (SPEC S0.3). */
  extensions?: AgentExtension[];
  /** D10: role tag for usage events (subagents: their agent type). Default "main". */
  role?: string;
  /** v1.1 R2: task acceptance commands (eval task, /goal --check): trusted checks for the completion status. */
  acceptanceChecks?: string[];
  /** G2 (internal): a subagent reports untrusted input to its parent; and starts tainted if the parent is. */
  onTaint?: (source: string) => void;
  initialTaint?: string;
  /**
   * v1.2 WS24 (review F8/F9): the session starts tainted for this reason (a task-board card on a third party's pull
   * request, a card added by a tainted session): Rule of Two applies from the first call.
   */
  taintedBy?: string;
  /**
   * Review F8: the workspace's own instruction files (AGENTS.md, CLAUDE.md, .cursor/rules …) come from an untrusted
   * source (e.g. "pull request #12"): they are not put in the system prompt as project instructions.
   */
  untrustedProject?: string;
  /** v1.2 N18/N34: shared budgets every model call of this agent also draws from (inherited downward). */
  budgetPools?: BudgetPool[];
  /** Internal: a subagent has no journal of its own; its extension records (prerequisite stops …) go to the parent's (S8). */
  journalSink?: (rec: Record<string, unknown>) => void;
}

/** v1.2 N18/N34/N35: what a child agent (nested subagent, workflow item, teammate, verifier) is started with. */
export interface ChildSpec extends ChildRequest {
  /** explore | general | validator | <custom> | teammate | workflow | verifier */
  agentType: string;
  description: string;
  /** system role text (default: from the agent type) */
  role?: string;
  isolation?: 'worktree' | 'shared';
  /** extra shared budgets (workflow total, team total); the parent's own pools are always inherited */
  pools?: BudgetPool[];
  /** label for events and the journal ("[name] …") */
  label?: string;
  /** a teammate is not a sub-task of the parent's conversation: taint reaches it only through what it is sent */
  member?: boolean;
  /** start from a copy of the parent's conversation (forked subagent) */
  fork?: boolean;
  /** extra per-agent extensions (team inbox, ...) */
  extensions?: AgentExtension[];
  /** tools to use exactly (already narrowed by the caller, e.g. the verifier's read-only set) */
  toolDefs?: ToolDef[];
  /** maximum turns for this child (never above the parent's) */
  maxTurns?: number;
  /** policy overrides that only narrow (e.g. the verifier's writeOnly: []) */
  writeOnly?: string[];
  /** forward permission requests to the human with this prefix (team members: their name) */
  approvalBadge?: string;
  /** observe the child's events (workflow stall watchdog) */
  onEvent?: (e: AgentEvent) => void;
  /** N18: names of the parent's configured MCP servers the child may use (a subset; never new servers) */
  mcpServers?: string[];
  /** N18: the parent's hooks the child keeps, as "Event" or "Event:matcher" selectors (a subset; model text never adds hooks) */
  hooks?: string[];
  /** N18: run the child's commands in a container (the C2 docker runner, network none): only ever stricter */
  sandbox?: 'container';
  /** F17: the child's taint does not flow up (the goal verifier, whose output the parent already treats as data) */
  isolateTaint?: boolean;
}

export interface SpawnedChild {
  agent: Agent;
  worktree?: Worktree;
  clamps: Clamp[];
  /** the child's own budget cap */
  pool?: BudgetPool;
  /** N18: what the child was granted, after clamping (persisted for a resumable background child) */
  granted: { tools: string[]; mode: PermissionMode; roots?: string[]; domains?: string[]; profile?: string; budget: { maxTokens?: number; maxCostUsd?: number }; mcpServers?: string[]; hooks?: string[]; sandbox?: 'container' };
}

/** Tools kept out of the list until something makes them relevant (a job, a background task, a worktree branch). */
const HIDDEN_UNTIL_USED = new Set(['task_result', 'worktree_merge', 'job_output', 'monitor', 'job_kill', 'task_brief', 'task_stop', 'task_resume', 'team_create', 'workflow_run', ...TEAM_TOOLS_AFTER_CREATE]);

const isMcpTool = (t: ToolDef) => t.kind === 'mcp' || !!t.mcpServer;

/** Tool messages must answer a call of the assistant message that opened the current exchange. */
export function dropOrphanToolMessages(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let open = new Set<string>();
  for (const m of msgs) {
    if (m.role === 'tool') {
      if (m.tool_call_id && open.has(m.tool_call_id)) {
        open.delete(m.tool_call_id);
        out.push(m);
      }
      continue;
    }
    open = m.role === 'assistant' && m.tool_calls?.length ? new Set(m.tool_calls.map((c) => c.id)) : new Set();
    out.push(m);
  }
  return out;
}

/** Problems that would make a transcript invalid for strict chat templates (empty = valid). */
export function messageSequenceProblems(msgs: ChatMessage[]): string[] {
  const problems: string[] = [];
  if (msgs.length && msgs[0].role !== 'system') problems.push('first message is not the system prompt');
  let open = new Set<string>();
  msgs.forEach((m, i) => {
    if (m.role === 'system' && i > 0) problems.push(`system message at ${i}`);
    if (m.role === 'tool') {
      if (!m.tool_call_id || !open.has(m.tool_call_id)) problems.push(`orphan tool message at ${i}`);
      else open.delete(m.tool_call_id);
      return;
    }
    if (open.size) problems.push(`tool call(s) ${[...open].join(', ')} unanswered before message ${i}`);
    open = m.role === 'assistant' && m.tool_calls?.length ? new Set(m.tool_calls.map((c) => c.id)) : new Set();
  });
  if (open.size) problems.push(`tool call(s) ${[...open].join(', ')} unanswered at the end`);
  return problems;
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export interface RunResult {
  runId: string;
  stopReason: StopReason;
  finalText: string;
  stats: RunStats;
  /** v1.1 R2: whether the work was verified by a trusted check (separate from why the loop stopped) */
  completion: CompletionStatus;
}

/** R8: what the host did with editor buffers before a shell command (WorkspaceHost.flushForShell). */
export interface FlushOutcome {
  saved: string[];
  /** documents with unsaved user changes the host did not save: the shell sees the disk version */
  skipped: string[];
  failed: { path: string; error: string }[];
  error?: string;
  /** R8: what was decided for documents the user had unsaved changes in */
  decision?: 'saved' | 'disk';
  /** documents saved because of that decision */
  savedByDecision?: string[];
}

function emptyStats(): RunStats {
  return { turns: 0, llmCalls: 0, successfulLlmCalls: 0, unparseableReplies: 0, toolCalls: 0, toolErrors: 0, refusals: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, durationMs: 0, filesChanged: [], commandsRun: [], evidence: [] };
}

/** Coerce stringly-typed args (common with small models) and check required fields. */
export function coerceArgs(args: Record<string, unknown>, schema: Record<string, any>): { args: Record<string, unknown>; error?: string } {
  const props = (schema?.properties ?? {}) as Record<string, any>;
  const out: Record<string, unknown> = { ...args };
  for (const [k, spec] of Object.entries(props)) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    const t = spec?.type;
    if ((t === 'integer' || t === 'number') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) out[k] = Number(v);
    else if (t === 'boolean' && typeof v === 'string') out[k] = v === 'true' || v === '1';
    else if ((t === 'array' || t === 'object') && typeof v === 'string') {
      const p = parseJsonLenient(v);
      if (p.ok) out[k] = p.value;
    } else if (t === 'string' && typeof v !== 'string') out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const missing = ((schema?.required ?? []) as string[]).filter((r) => out[r] === undefined || out[r] === null);
  if (missing.length) return { args: out, error: `missing required argument(s): ${missing.join(', ')}` };
  return { args: out };
}

export class Agent {
  messages: ChatMessage[] = [];
  todos: TodoItem[] = [];
  llm!: LLMClient;
  readonly ledger = new ReadLedger();
  /** Session id (R6: replaced by a fresh one when the existing journal for it fails verification). */
  sessionId: string;
  private shared!: Shared;
  private tools: ToolDef[] = [];
  private toolMap = new Map<string, ToolDef>();
  private journal?: Journal;
  private abortCtl?: AbortController;
  private running = false;
  private stats: RunStats = emptyStats();
  private lastEditSeq = 0;
  /** R2: when the last edit happened (a background job only counts if it started after it) */
  private lastEditAt = 0;
  /** R2 (batch 3): fingerprints of the files that define checks, at the start of the run */
  private checkDefs?: Map<string, string>;
  /** R2 (batch 4): the check the harness runs itself, fixed at run start with the fingerprints of what it can load */
  private checkPlan?: CheckPlan;
  /** R2 (batch 4): why there is no harness check this run (none configured or detectable, off, a subagent) */
  private noCheckReason?: string;
  /** R2 (batch 4): the edit sequence number the last harness check saw (no re-run until another edit) */
  private harnessSeq = -1;
  /** R2 (batch 4): loadable files an earlier run of this session changed, with the state it left them in */
  private sessionTamper = new Map<string, string>();
  /** v1.1 R2: task acceptance commands; trusted checks (also settable by /goal and the eval runner). */
  readonly acceptanceChecks: string[] = [];
  private verifyCommandsCache?: string[];
  private seq = 0;
  private failStreak = new Map<string, number>();
  private lastCallSig = '';
  private sameCallCount = 0;
  private toolErrorStreak = 0;
  private thrashReason = '';
  private pendingImages: ContentPart[] = [];
  private currentRunId?: string;
  private sessionStarted = false;
  // D3 tool search: visible = core + tool_search + activated (appended, so the prefix stays stable)
  private baseVisible: ToolDef[] = [];
  private activated: ToolDef[] = [];
  private deferred = new Map<string, ToolDef>();
  private searchActive = false;
  private toolSearch?: ToolDef;
  /** N10: the deferred-tools listing of the system prompt, fixed when the tool set is (activation must not rewrite the prompt prefix). */
  private deferredListing: ToolDef[] = [];
  private taskResult?: ToolDef;
  private taskBriefTool?: ToolDef;
  /** v1.1 R5: the user's requests (original + later constraints), kept outside the lossy history. */
  brief: TaskBrief = { entries: [] };
  /** v1.1 R14: durable session state (requests, constraints, tasks, evidence) next to the journal */
  private stateFile?: string;
  private sessionEvidence: import('../types.js').VerificationEvidence[] = [];
  private completions: RunCompletion[] = [];
  private resumedFrom: string[] = [];
  /** R8: the user's save/disk choice per document with unsaved changes (this session) */
  private unsavedChoice = new Map<string, 'save' | 'disk'>();
  // D12 steering and queue
  private steerQueue: string[] = [];
  private runQueue: (string | ContentPart[])[] = [];
  private queueRunner?: Promise<void>;
  // D8 background compaction
  private bgSummary?: { cut: number; fingerprint: string; promise: Promise<string | undefined> };
  /**
   * N10: bumped whenever the history is replaced (clear, truncateTo, loadHistory). A compaction
   * swaps its result in only if the generation and the array it started from are unchanged.
   */
  private historyGen = 0;
  /** N10: a compaction started while no run is active (idle compaction, /compact): cancellable. */
  private pendingCompaction?: { ctl: AbortController; promise: Promise<void> };
  // D10 routing
  private roleClients = new Map<string, LLMClient>();
  // D1/D2 subagents
  private subSeq = 0;
  private activeChildren = new Set<Agent>();
  private worktrees = new Set<Worktree>();
  /** Subagents started with run_in_background (D1). */
  readonly backgroundTasks = new Map<string, BackgroundTask>();
  // G2: where untrusted content entered the conversation (message index), if it has
  private taint?: { source: string; index: number };
  private containment?: TaintContainment;
  /** Every file change made by the agent this session (for /undo). `before` is null for files it created. */
  readonly editHistory: { path: string; before: string | null; after: string; ts: number }[] = [];
  /** Session-wide totals across runs */
  readonly totals = { promptTokens: 0, completionTokens: 0, costUsd: 0, llmCalls: 0 };

  private constructor(readonly opts: AgentOptions) {
    this.sessionId = opts.sessionId ?? `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${shortId()}`;
  }

  static async create(opts: AgentOptions): Promise<Agent> {
    const a = new Agent(opts);
    // live run (5 Nov): hosted endpoints without configured prices (OpenRouter) get their published prices, so costs and
    // dollar limits work; only for the root agent (children share its process-wide cache)
    if (!opts.shared) {
      try {
        await ensurePublishedPricing(resolveProfile(opts.config), opts.config.homeDir);
      } catch {
        /* costs stay unknown */
      }
    }
    await a.init();
    return a;
  }

  get config(): HarnessConfig {
    return this.opts.config;
  }
  get workspace(): string {
    return this.opts.workspace;
  }
  get depth(): number {
    return this.shared.depth;
  }
  /** v1.1 R13: the tool names this agent was given (before tool search hides any). */
  private baseToolNames: string[] = [];
  /** v1.1 R13: what this agent may do, for the authority-inheritance check. */
  authority(): Authority {
    return authorityOf(this.policy, this.baseToolNames);
  }
  get policy(): PermissionPolicy {
    return this.shared.policy;
  }
  get skills(): SkillManager {
    return this.shared.skills;
  }
  get agentDefinitions(): AgentDefinition[] {
    return this.shared.agentDefs;
  }
  get mcp(): McpManager | undefined {
    return this.shared.mcp;
  }
  get toolList(): ToolDef[] {
    return this.tools;
  }
  get isRunning(): boolean {
    return this.running;
  }
  /** v1.2 N34: a git worktree for a child that is not an Agent (an external agent CLI); removed on dispose unless collected. */
  async createChildWorktree(label: string): Promise<Worktree> {
    const limit = maxDepth(this.config);
    if (this.depth + 1 > limit) throw new ChildRefusal('depth_limit', `agent.maxDepth is ${limit} and this agent is already at depth ${this.depth}, so it cannot start ${label}`);
    const wt = await createWorktree(this.workspace, `${this.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-8)}-${++this.subSeq}-${shortId()}`);
    this.worktrees.add(wt);
    return wt;
  }

  /** v1.2 N34: the next child session id (`<root>-sub-<n>`, so the ledger and admission count it under the root). */
  nextChildSessionId(): string {
    return `${this.sessionId}-sub-${++this.subSeq}`;
  }

  /** v1.2 N35: the tool definitions this agent was given (what a narrowed child can be built from). */
  availableTools(): ToolDef[] {
    const names = new Set(this.baseToolNames);
    return this.shared.allTools.filter((t) => names.has(t.name));
  }

  /** v1.2 N18/N34: the current run's abort signal (workflows and teams stop with it). */
  get abortSignal(): AbortSignal | undefined {
    return this.running ? this.abortCtl?.signal : undefined;
  }
  get journalFile(): string | undefined {
    return this.journal?.file;
  }

  private log = (level: 'info' | 'warn', message: string) => this.emit({ type: 'notice', level, message });

  private async init(): Promise<void> {
    const cfg = this.config;
    this.llm = this.opts.llm ?? new LLMClient(this.tuneProfile(cfg.profile), this.log);
    if (this.opts.shared) {
      this.shared = this.opts.shared;
    } else {
      const skills = new SkillManager(defaultSkillDirs(this.workspace, this.opts.bundledSkillsDir, cfg.skills.dirs), cfg.skills.disabled);
      const policy = new PermissionPolicy({
        workspace: this.workspace,
        mode: cfg.permissionMode,
        allow: cfg.permissions.allow,
        deny: cfg.permissions.deny,
        ask: cfg.permissions.ask,
        autoClassifyAllShell: (cfg as { autoMode?: { classifyAllShell?: boolean } }).autoMode?.classifyAllShell === true,
        protectedPaths: cfg.permissions.protectedPaths,
        additionalDirectories: cfg.permissions.additionalDirectories,
        readOnlyRoots: [...skills.roots, path.join(os.tmpdir())],
        // v1.2 N45 (review F1): the "read-only commands" auto-approve category, user config only
        readOnlyCommands: readUserConfigFile(cfg.homeDir).permissions?.readOnlyCommands === true,
        // N36: the same credential list the sandbox hides (sandbox.denyRead), plus the harness home
        credentialPaths: denyReadPaths({ homeDir: cfg.homeDir, sandbox: cfg.sandbox as { denyRead?: unknown; allowRead?: unknown } | undefined }),
        credentialAllowRead: (cfg.sandbox as { allowRead?: string[] } | undefined)?.allowRead,
      });
      let mcp: McpManager | undefined;
      if (this.opts.mcp !== false && Object.keys(cfg.mcpServers).length) {
        mcp = new McpManager(cfg.mcpServers, this.log, { homeDir: cfg.homeDir });
        await mcp.connectAll();
      }
      const smallLlm = cfg.smallProfile && cfg.profiles[cfg.smallProfile] ? new LLMClient(this.tuneProfile(cfg.smallProfile), this.log) : this.llm;
      const provided = await providerTools(cfg, { workspace: this.workspace, homeDir: cfg.homeDir, depth: 0, hostNavigates: !!this.host.navigate }, (id, e) => this.log('warn', `tool provider ${id} failed: ${e.message}`));
      // First definition of a name wins (builtin > provider > MCP > embedding app); duplicates are reported.
      const allTools: ToolDef[] = [];
      for (const t of [...builtinTools(cfg), ...provided, ...(mcp?.tools() ?? []), ...(this.opts.extraTools ?? [])]) {
        if (allTools.some((x) => x.name === t.name)) this.log('warn', `duplicate tool name "${t.name}" ignored`);
        else allTools.push(t);
      }
      this.shared = { policy, skills, agentDefs: loadAgentDefinitions(this.workspace, this.opts.bundledAgentsDir), mcp, allTools, smallLlm, depth: 0 };
    }
    let base = this.opts.tools ?? this.shared.allTools;
    // N43 (capability from Qwen Code's tool registration status): a tool denied outright (`"deny": ["web_fetch"]`) is
    // not offered to the model at all, so a small model does not spend turns on calls that can only be refused.
    const deniedOutright = new Set(cfg.permissions.deny.map((r) => r.trim().replace(/\(\*?\)$/, '')).filter((r) => /^[\w.-]+$/.test(r)));
    if (deniedOutright.size) base = base.filter((t) => !deniedOutright.has(t.name));
    this.baseToolNames = base.map((t) => t.name);
    // D5: with background jobs on, bash gains run_in_background (same run(), same permission input, same wrappers).
    if (coreSettings(cfg).backgroundJobs) base = base.map((t) => (t === bashTool ? bashBackgroundTool : t));
    // v1.2 N49 (WS24): `tug --allowed-tools / --exclude-tools` narrow the tool set (never widen it)
    if (this.opts.toolFilter) base = base.filter(this.opts.toolFilter);
    this.setTools(base);
    if (this.opts.initialTaint) this.taint = { source: `${this.opts.initialTaint} (inherited from the parent agent)`, index: 0 };
    if (this.opts.taintedBy) this.taint = { source: this.opts.taintedBy, index: 0 };
    // Every credential the harness knows about is scrubbed from child envs and redacted from journals.
    const secrets = [
      ...Object.keys(cfg.profiles).map((n) => {
        try {
          return resolveProfile(cfg, n).apiKey ?? '';
        } catch {
          return '';
        }
      }),
      ...Object.values(cfg.profiles).flatMap((p) => Object.values(p.headers ?? {})),
      cfg.web.braveApiKey ?? '',
      cfg.web.tavilyApiKey ?? '',
      ...Object.values(cfg.mcpServers).flatMap((m) => [...Object.values(m.headers ?? {}), ...Object.values(m.env ?? {})]),
    ].filter((v) => typeof v === 'string' && v.length >= 8);
    registerSecretValues(secrets);
    if (this.opts.journal !== false) {
      const auditSink = cfg.audit?.sink;
      try {
        this.journal = new Journal(cfg.homeDir, this.workspace, this.sessionId, secrets, { auditSink });
      } catch (e) {
        // R6: never continue a broken chain; keep the evidence apart under a new id.
        if (!(e instanceof JournalChainError)) throw e;
        const old = this.sessionId;
        this.sessionId = `${old}-${shortId()}`;
        this.emit({ type: 'notice', level: 'warn', message: `journal ${old} failed verification at line ${e.line}; it was left untouched and this session continues as ${this.sessionId}` });
        this.journal = new Journal(cfg.homeDir, this.workspace, this.sessionId, secrets, { auditSink });
      }
      // R14: an existing session id (restart, another surface) continues with its durable state
      this.stateFile = stateFileFor(this.journal.file);
      if (fs.existsSync(this.journal.file)) this.adoptState(loadStateForJournal(this.journal.file, this.sessionId, this.workspace));
    }
  }

  // ------------------------------------------------------------ extensions (SPEC S0.3)

  get host(): WorkspaceHost {
    return this.opts.host ?? diskHost;
  }

  get runId(): string | undefined {
    return this.currentRunId;
  }

  get runStats(): RunStats {
    return this.stats;
  }

  get smallLlm(): LLMClient {
    return this.shared.smallLlm;
  }

  /** Emit an event through the agent (for extensions and embedding apps). */
  emitEvent(e: AgentEvent): void {
    this.emit(e);
  }

  /** Append a record to the session journal. */
  journalWrite(rec: Record<string, unknown>): void {
    this.journal?.write(rec as any);
  }

  private extensions(): AgentExtension[] {
    return [...globalExtensions(), ...(this.opts.extensions ?? [])].filter((e) => !e.depths || e.depths.includes(this.depth));
  }

  private api(): AgentApi {
    const self = this;
    return {
      get sessionId() { return self.sessionId; },
      get runId() { return self.currentRunId; },
      get workspace() { return self.workspace; },
      get config() { return self.config; },
      get depth() { return self.depth; },
      get mode() { return self.policy.mode; },
      get host() { return self.host; },
      get llm() { return self.llm; },
      get smallLlm() { return self.shared.smallLlm; },
      get messages() { return self.messages; },
      get stats() { return self.stats; },
      get signal() { return self.abortCtl?.signal; },
      emit: (e) => self.emit(e),
      notice: (level, message) => self.emit({ type: 'notice', level, message }),
      journal: (rec) => (self.journal ? self.journal.write(rec as any) : self.opts.journalSink?.(rec as Record<string, unknown>)),
      get agent() { return self; },
    };
  }

  /** Run one hook across all extensions; failures become notices. Returns the non-undefined results. */
  private async runExt<R>(hook: keyof AgentExtension, call: (e: AgentExtension) => R | undefined | void | Promise<R | undefined | void>): Promise<R[]> {
    const out: R[] = [];
    for (const e of this.extensions()) {
      if (typeof e[hook] !== 'function') continue;
      try {
        const r = await call(e);
        if (r !== undefined && r !== null) out.push(r as R);
      } catch (err) {
        this.emit({ type: 'notice', level: 'warn', message: `extension ${e.id}.${String(hook)} failed: ${(err as Error).message}` });
      }
    }
    return out;
  }

  /** Resolved profile with the D4 overlay defaults and cached probe capabilities applied. */
  private tuneProfile(name: string): ModelProfile {
    let p = resolveProfile(this.config, name);
    if (coreSettings(this.config).modelOverlays) p = applyOverlayDefaults(p, this.config.profiles[name], selectOverlay(p.model));
    return profileWithCapabilities(p, this.config.homeDir);
  }

  /**
   * D3: decide which tools are sent. With tool search active only the core
   * tools plus tool_search are visible; the rest are deferred and loaded on
   * demand. Previously activated tools stay active (session-level).
   */
  private setTools(base: ToolDef[]): void {
    const s = coreSettings(this.config);
    const all = [...base];
    if (this.depth === 0 && all.some((t) => t.name === 'task')) {
      this.taskResult ??= makeTaskResultTool((h) => this.backgroundTasks.get(h), () => [...this.backgroundTasks.values()]);
      all.push(this.taskResult);
    }
    // R5: the full task brief, activated when a compaction had to shorten it
    this.taskBriefTool ??= {
      name: 'task_brief',
      kind: 'meta',
      readOnly: true,
      description: "Read the user's requests in this session in full (the original request and every later correction or constraint), verbatim. Use it when the compacted summary shows a shortened task brief.",
      parameters: { type: 'object', properties: { entry: { type: 'integer', description: 'one entry (1-based) in full, e.g. 1 = the original request' }, offset: { type: 'integer', description: 'character offset for long texts' } } },
      title: () => 'Read the task brief',
      run: async (args: { offset?: number; entry?: number }) => ({ output: briefToolText(this.brief, Math.max(0, Number(args?.offset) || 0), 20_000, args?.entry ? Number(args.entry) : undefined) }),
    };
    all.push(this.taskBriefTool);
    const candidates = all.filter((t) => !HIDDEN_UNTIL_USED.has(t.name));
    const schemaTokens = estimateTokens(JSON.stringify(candidates.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))));
    this.searchActive =
      s.toolSearch === 'on' ||
      (s.toolSearch === 'auto' && (candidates.length > s.toolSearchThreshold || schemaTokens > 0.15 * this.llm.profile.contextWindow));
    const core = new Set([...CORE_TOOL_NAMES, ...s.coreTools]);
    const visible: ToolDef[] = [];
    const deferred = new Map<string, ToolDef>();
    for (const t of all) {
      // MCP tools are never core while search is active (unless deferMcpTools is off).
      const coreTool = core.has(t.name) || (t.core === true && !isMcpTool(t)) || (!s.deferMcpTools && isMcpTool(t));
      if (HIDDEN_UNTIL_USED.has(t.name) || (this.searchActive && !coreTool)) deferred.set(t.name, t);
      else visible.push(t);
    }
    if (this.searchActive) {
      this.toolSearch ??= makeToolSearchTool({ deferred: () => [...this.deferred.values()].filter((t) => !HIDDEN_UNTIL_USED.has(t.name)), activate: (n) => void this.activateTools(n) });
      visible.push(this.toolSearch);
    }
    this.baseVisible = visible;
    this.activated = this.activated.filter((t) => deferred.has(t.name)).map((t) => deferred.get(t.name)!);
    for (const t of this.activated) deferred.delete(t.name);
    this.deferred = deferred;
    this.deferredListing = [...deferred.values(), ...this.activated].filter((t) => !HIDDEN_UNTIL_USED.has(t.name));
    this.rebuildToolList();
  }

  private rebuildToolList(): void {
    this.tools = [...this.baseVisible, ...this.activated];
    this.toolMap = new Map([...this.tools, ...this.deferred.values()].map((t) => [t.name, t]));
  }

  /** Activate deferred tools (appended at the end of the tool list for the rest of the session). Returns the names activated. */
  activateTools(names: string[]): string[] {
    const done: string[] = [];
    for (const n of names) {
      const t = this.deferred.get(n);
      if (!t) continue;
      this.deferred.delete(n);
      this.activated.push(t);
      done.push(n);
    }
    if (done.length) {
      this.rebuildToolList();
      this.journal?.write({ type: 'tools_activated', names: done });
    }
    return done;
  }

  /** Names of tools whose schemas are not sent yet (D3). */
  deferredToolNames(): string[] {
    return [...this.deferred.keys()];
  }

  get toolSearchActive(): boolean {
    return this.searchActive;
  }

  private emit(e: AgentEvent): void {
    try {
      this.opts.ui?.onEvent?.(e);
    } catch {
      /* UI errors never break the loop */
    }
    if (this.shared) {
      for (const x of this.extensions()) {
        if (!x.onEvent) continue;
        try {
          x.onEvent(this.api(), e);
        } catch {
          /* observers never break the loop */
        }
      }
    }
    if (e.type !== 'text_delta' && e.type !== 'reasoning_delta') this.journal?.write({ type: 'event', event: e });
  }

  private push(m: ChatMessage): void {
    m._meta = { ...(m._meta ?? {}), ts: Date.now() };
    this.messages.push(m);
    this.journal?.write({ type: 'message', message: m });
  }

  // ------------------------------------------------------------ controls

  /** Cancel the current run, its subagents (background ones too) and anything queued. */
  abort(): void {
    this.runQueue = [];
    this.steerQueue = [];
    this.abortCtl?.abort();
    for (const c of this.activeChildren) c.abort();
  }

  setMode(m: PermissionMode): void {
    const from = this.policy.mode;
    const requested = m;
    // N43 (review finding 7): a mode managed policy forbids never takes effect, not even for a microtask, so every
    // surface (tug serve config/set, ACP set_mode) reports the mode really in effect
    if (forbiddenModes(this.config.managed?.policy ?? {}).includes(m)) m = 'ask';
    this.policy.mode = m;
    if (this.messages[0]?.role === 'system') this.messages[0].content = this.systemPrompt();
    this.emit({ type: 'notice', level: m === 'yolo' ? 'warn' : 'info', message: m === 'yolo' ? `permission mode: yolo. WARNING: commands and MCP tools now run WITHOUT approval and without the auto-mode classifier (hard denies, protected paths and the sandbox still apply)` : `permission mode: ${m}` });
    // N43: extensions (auto mode's denial tracking) see every switch
    void this.runExt('onModeChange', (e) => e.onModeChange!(this.api(), from, requested));
  }

  setProfile(name: string): ModelProfile {
    const p = this.tuneProfile(name);
    this.config.profile = name;
    this.llm = new LLMClient(p, this.log);
    return p;
  }

  setProfileObject(p: ModelProfile): void {
    this.llm = new LLMClient(p, this.log);
  }

  clear(): void {
    this.cancelPendingCompaction();
    this.messages = [];
    this.todos = [];
    this.taint = undefined;
    this.brief = { entries: [] };
    this.sessionEvidence = [];
    this.completions = [];
    this.emit({ type: 'todos', todos: [] });
    this.saveState();
  }

  /**
   * Resume from saved messages. R5: the task brief comes from `brief`, else from the journal records
   * Journal.loadMessages attaches to its result, else it is rebuilt from the messages (user messages
   * and the brief carried by compaction notes).
   */
  loadHistory(msgs: ChatMessage[], brief?: TaskBrief): void {
    this.cancelPendingCompaction();
    this.messages = [{ role: 'system', content: this.systemPrompt() }, ...msgs.filter((m) => m.role !== 'system')];
    const attached = (msgs as { taskBrief?: TaskBrief }).taskBrief;
    // R14: the durable state stored with the journal these messages came from
    const state = (msgs as { sessionState?: SessionState }).sessionState;
    if (state) {
      this.adoptState(state);
      if (state.sessionId && state.sessionId !== this.sessionId && !this.resumedFrom.includes(state.sessionId)) this.resumedFrom.push(state.sessionId);
      this.journal?.write({ type: 'state_resumed', from: state.sessionId });
    }
    this.brief = brief ?? (state?.requests.length ? this.brief : attached?.entries.length ? attached : briefFromMessages(msgs));
    this.recomputeTaint();
    this.saveState();
  }

  /** R5: record a user message in the task brief (journaled, so a resumed session keeps it). */
  private noteBrief(text: string, steer = false): void {
    const e = addToBrief(this.brief, text, { steer });
    if (e) {
      this.journal?.write({ type: 'task_brief', entry: e });
      this.saveState();
    }
  }

  // ------------------------------------------------------------ durable session state (R14)

  /** The session's durable state: requests and constraints, tasks, evidence across runs, completions. */
  sessionState(): SessionState {
    return { ...emptyState(this.sessionId, this.workspace), resumedFrom: [...this.resumedFrom], requests: [...this.brief.entries], tasks: [...this.todos], evidence: [...this.sessionEvidence], completions: [...this.completions] };
  }

  private adoptState(s: SessionState | undefined): void {
    if (!s) return;
    if (s.requests.length) this.brief = { entries: s.requests.map((e) => ({ ...e })) };
    if (s.tasks.length) this.todos = s.tasks.map((t) => ({ ...t }));
    this.sessionEvidence = [...s.evidence];
    this.completions = [...s.completions];
    this.resumedFrom = [...s.resumedFrom];
  }

  /** Persist the state (atomic write); never breaks a run. Agents without a journal keep it in memory. */
  private saveState(): void {
    if (!this.stateFile) return;
    try {
      writeState(this.stateFile, this.sessionState());
    } catch (e) {
      this.log('warn', `session state not saved: ${(e as Error).message}`);
    }
  }

  /** R5: the brief as re-inserted after a compaction; a shortened brief activates the task_brief tool. */
  private renderedBrief(): string | undefined {
    if (!this.brief.entries.length) return undefined;
    const r = renderBrief(this.brief);
    if (r.truncated) this.activateTools(['task_brief']);
    return r.text;
  }

  // ------------------------------------------------------------ taint (G2, Rule of Two)

  /** Where untrusted content entered this session, if it has. */
  get taintSource(): string | undefined {
    return this.taint?.source;
  }

  /** Record that untrusted content entered the conversation (first time: notice + journal; subagents tell their parent). */
  markTainted(source: string): void {
    if (this.taint) return;
    this.taint = { source, index: this.messages.length };
    this.journal?.write({ type: 'taint', source });
    // A subagent reports to its parent, which shows the notice once for the whole run.
    if (this.opts.onTaint) this.opts.onTaint(source);
    else if (coreSettings(this.config).taint !== 'off') this.emit({ type: 'notice', level: 'warn', message: `untrusted content read (${source}); outbound actions now need approval; ${this.taintContainment().coverage}` });
    // Subagents already running (parallel tasks) share the conversation's trust level.
    for (const c of this.activeChildren) c.markTainted(`${source} (read by the parent agent)`);
    // Background jobs started before the taint run uncontained (containment applies when a command starts).
    if (coreSettings(this.config).taint !== 'off') this.taintJobsPromise = this.stopUncontainedJobs();
  }

  /** Set while background jobs are being stopped after a taint (tests await it). */
  taintJobsPromise?: Promise<string[]>;

  /**
   * G2: a background job started before untrusted content was read keeps the network it started with.
   * `agent.taintJobs: "stop"` (default) stops them and says so (restarting one runs it contained);
   * `"keep"` leaves them running and names them in a warning.
   */
  private async stopUncontainedJobs(): Promise<string[]> {
    const running = listJobs(this.sessionId).filter((j) => j.status === 'running');
    if (!running.length) return [];
    const names = running.map((j) => `${j.id} ($ ${truncateLine(j.command, 60)})`);
    if (coreSettings(this.config).taintJobs === 'keep') {
      this.emit({ type: 'notice', level: 'warn', message: `background job(s) started before untrusted content was read keep their network access (agent.taintJobs: keep): ${names.join(', ')}` });
      return [];
    }
    for (const j of running) await killJob(j).catch(() => false);
    this.emit({ type: 'notice', level: 'warn', message: `stopped background job(s) started before untrusted content was read, since they could reach the network: ${names.join(', ')}. Restart one to run it contained.` });
    return running.map((j) => j.id);
  }

  /** G2: how shell commands are contained while tainted (computed once per agent). */
  taintContainment(): TaintContainment {
    this.containment ??= taintContainment(this.config, coreSettings(this.config).taintShellNetwork);
    return this.containment;
  }

  /** Re-derive the taint from the messages (after resume or truncation): any untrusted envelope that is still in context. */
  private recomputeTaint(): void {
    this.taint = undefined;
    this.messages.forEach((m, i) => {
      if (this.taint || m.role === 'system' || m.role === 'assistant') return;
      const env = untrustedEnvelope(contentToText(m.content));
      if (env) this.taint = { source: env, index: i };
    });
  }

  systemPrompt(): string {
    return buildSystemPrompt({
      workspace: this.workspace,
      config: this.config,
      model: this.llm.profile.model,
      mode: this.policy.mode,
      skills: this.skills,
      agents: this.agentDefinitions,
      surface: this.opts.surface ?? 'terminal',
      toolNames: [...this.tools, ...this.deferred.values()].map((t) => t.name),
      roleOverride: this.opts.roleOverride,
      modelNote: coreSettings(this.config).modelOverlays ? selectOverlay(this.llm.profile.model)?.note : undefined,
      // N10: activated tools stay listed, so the next run's system prompt (the cached prefix) is unchanged
      deferredTools: this.searchActive ? this.deferredListing.map((t) => ({ name: t.name, server: t.mcpServer })) : [],
      homeDir: this.config.homeDir,
      untrustedProject: this.opts.untrustedProject,
    });
  }

  toolSpecs(): ToolSpec[] {
    return this.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }

  /** Token budget for messages: window minus output reserve and tool schemas. */
  private budget(): number {
    const p = this.llm.profile;
    const toolTokens = estimateTokens(JSON.stringify(this.toolSpecs()));
    return Math.max(2000, Math.floor((p.contextWindow - p.maxOutputTokens - toolTokens) * this.config.agent.compactAt));
  }

  compactNow(force = true, instructions?: string): Promise<void> {
    if (this.running) return this.admitted(() => this.compactNowAdmitted(force, instructions), 'summarizer');
    // N10: outside a run (idle compaction, /compact) the compaction can be cancelled by clear/truncateTo/loadHistory.
    const ctl = new AbortController();
    const promise = this.admitted(() => this.compactNowAdmitted(force, instructions, ctl.signal), 'summarizer').finally(() => {
      if (this.pendingCompaction?.ctl === ctl) this.pendingCompaction = undefined;
    });
    this.pendingCompaction = { ctl, promise: promise.catch(() => undefined) };
    return promise;
  }

  /** N10: resolves when no compaction started outside a run is in flight (it may have been cancelled). */
  async compactionSettled(): Promise<void> {
    while (this.pendingCompaction) await this.pendingCompaction.promise;
  }

  /**
   * N10: the history is about to be replaced: abort an in-flight idle compaction (its summary request
   * stops) and invalidate it, so its result can never be swapped over the new history. The methods
   * that call this are synchronous (callers in the CLI, VS Code, server and ACP), so the generation
   * check is what guarantees the outcome; `compactionSettled()` awaits the aborted call if needed.
   */
  private cancelPendingCompaction(): void {
    this.historyGen++;
    const p = this.pendingCompaction;
    if (p) {
      p.ctl.abort();
      this.journal?.write({ type: 'compaction_cancelled', reason: 'history replaced' });
    }
  }

  private async compactNowAdmitted(force: boolean, instructions?: string, cancel?: AbortSignal): Promise<void> {
    const gen = this.historyGen;
    const base = this.messages;
    await this.runExt('beforeCompact', (e) => e.beforeCompact!(this.api(), { force, tokens: estimateMessagesTokens(this.messages) }));
    // D8: a summary pre-built in the background is used if its span is unchanged (no extra blocking call).
    let precomputed: { cut: number; summary: string } | undefined;
    const bg = this.bgSummary;
    this.bgSummary = undefined;
    if (bg && !instructions && bg.cut < this.messages.length && spanFingerprint(this.messages.slice(1, bg.cut)) === bg.fingerprint) {
      const summary = await bg.promise;
      if (summary && spanFingerprint(this.messages.slice(1, bg.cut)) === bg.fingerprint) precomputed = { cut: bg.cut, summary };
    }
    // N10: compact shallow copies, so clearing old tool output in place never touches a history that replaces this one
    const snapshot = base.map((m) => ({ ...m }));
    const signals = [this.abortCtl?.signal, cancel].filter((x): x is AbortSignal => !!x);
    const r = await compact({ messages: snapshot, budgetTokens: this.budget(), llm: this.llmFor('summarizer'), todos: this.todos, force, signal: signals.length ? AbortSignal.any(signals) : undefined, precomputed, instructions, onUsage: this.usageSink('summarizer'), brief: this.renderedBrief() });
    if (r.strategy !== 'none') {
      // N10: swap only over the history the compaction started from
      if (cancel?.aborted || this.historyGen !== gen || this.messages !== base || (base[0]?.role === 'system') !== (snapshot[0]?.role === 'system')) {
        this.journal?.write({ type: 'compaction_discarded', reason: 'the history was replaced while compacting' });
        return;
      }
      // keep messages appended meanwhile, and the live system prompt (a run start may have rebuilt it in place)
      const next = [...r.messages, ...base.slice(snapshot.length)];
      if (base[0]?.role === 'system' && next[0]?.role === 'system') next[0] = base[0];
      this.messages = next;
      this.journal?.write({ type: 'compacted', messages: this.messages });
      this.emit({ type: 'compaction', beforeTokens: r.before, afterTokens: r.after, strategy: r.strategy });
    }
  }

  /**
   * D8: start summarising the older span in the background once the history
   * passes 60% of the budget, so the compaction at the threshold is a swap.
   */
  private maybeStartBackgroundSummary(tokens: number, budget: number): void {
    if (this.bgSummary || !coreSettings(this.config).backgroundCompaction || tokens <= 0.6 * budget) return;
    const cut = findCut(this.messages, Math.floor(budget * 0.15));
    if (cut <= 2) return;
    const span = this.messages.slice(1, cut);
    const fingerprint = spanFingerprint(span);
    const llm = this.llmFor('summarizer');
    const todos = [...this.todos];
    // R4: the background summary is admitted too (it inherits the run's scope, tagged summarizer)
    const promise = withScopeOverride({ role: 'summarizer' }, () => summarize(llm, span, todos, { onUsage: this.usageSink('summarizer') })).catch(() => undefined);
    this.bgSummary = { cut, fingerprint, promise };
    this.journal?.write({ type: 'background_summary_started', cut });
  }

  /**
   * "Summarise up to here" (D8): replace messages[1..messageIndex) with a
   * summary note and keep every later message verbatim.
   */
  summarizeUpTo(messageIndex: number, instructions?: string): Promise<{ summarized: number; strategy: string }> {
    return this.admitted(() => this.summarizeUpToAdmitted(messageIndex, instructions), 'summarizer');
  }

  private async summarizeUpToAdmitted(messageIndex: number, instructions?: string): Promise<{ summarized: number; strategy: string }> {
    if (this.running) throw new Error('cannot summarise while a run is in progress');
    const cut = safeCut(this.messages, messageIndex);
    if (cut <= 1) return { summarized: 0, strategy: 'none' };
    const head = this.messages.slice(1, cut);
    const gen = this.historyGen;
    const base = this.messages;
    let summary: string;
    let strategy = 'summarize';
    try {
      summary = await summarize(this.llmFor('summarizer'), head, this.todos, { instructions, onUsage: this.usageSink('summarizer') });
    } catch {
      summary = mechanicalSummary(head);
      strategy = 'mechanical-summary';
    }
    // N10: the history was replaced (clear, rewind, resume) while summarising: do not swap over it
    if (this.historyGen !== gen || this.messages !== base) return { summarized: 0, strategy: 'discarded' };
    const before = estimateMessagesTokens(this.messages);
    this.messages = assembleCompacted(this.messages, cut, summary, this.renderedBrief());
    this.bgSummary = undefined;
    this.journal?.write({ type: 'compacted', messages: this.messages });
    this.emit({ type: 'compaction', beforeTokens: before, afterTokens: estimateMessagesTokens(this.messages), strategy: `summarize-up-to-${cut}` });
    return { summarized: head.length, strategy };
  }

  // ------------------------------------------------------------ routing (D10)

  /** The client for a routing role: `routing.<role>` profile if set, else small model (summarizer/explore/approver) or main. */
  llmFor(role: RoutingRole): LLMClient {
    if (role === 'main') return this.llm;
    const name = this.config.routing?.[role];
    if (name && this.config.profiles[name]) {
      let c = this.roleClients.get(name);
      if (!c) this.roleClients.set(name, (c = new LLMClient(this.tuneProfile(name), this.log)));
      return c;
    }
    return role === 'summarizer' || role === 'explore' || role === 'approver' ? this.shared.smallLlm : this.llm;
  }

  /** Meter a call made outside the main loop (usage event tagged with its role, counted in stats and totals). */
  private usageSink(role: string): (usage: import('../types.js').Usage, latencyMs: number, model: string) => void {
    return (usage, latencyMs, model) => {
      const client = role === 'main' ? this.llm : this.llmFor(role as RoutingRole);
      const cost = costOf(usage, client.profile);
      this.stats.promptTokens += usage.promptTokens;
      this.stats.completionTokens += usage.completionTokens;
      this.stats.costUsd += cost;
      this.stats.llmCalls++;
      this.stats.successfulLlmCalls++;
      this.totals.promptTokens += usage.promptTokens;
      this.totals.completionTokens += usage.completionTokens;
      this.totals.costUsd += cost;
      this.totals.llmCalls++;
      this.emit({ type: 'usage', usage, costUsd: cost, latencyMs, model, role });
    };
  }

  /** One completion with a role's model, metered and tagged (for extensions: approver, editor, planner helpers). */
  async completeAs(role: RoutingRole, req: CompletionRequest): Promise<CompletionResult> {
    // R4: admitted like every other request (refused → LLMError 'budget', nothing sent)
    const res = await this.admitted(() => this.llmFor(role).complete(req), role);
    this.usageSink(role)(res.usage, res.latencyMs, res.model);
    return res;
  }

  /**
   * v1.1 R4: one completion with a client the caller made (an IDE helper: image description, inline
   * edit), admitted in this agent's scope (session limits and run budget) and metered under `role`.
   */
  async completeWith(client: LLMClient, req: CompletionRequest, role = 'helper'): Promise<CompletionResult> {
    const res = await this.admitted(() => client.complete(req), role);
    const cost = costOf(res.usage, client.profile);
    this.stats.promptTokens += res.usage.promptTokens;
    this.stats.completionTokens += res.usage.completionTokens;
    this.stats.costUsd += cost;
    this.stats.llmCalls++;
    this.stats.successfulLlmCalls++;
    this.totals.promptTokens += res.usage.promptTokens;
    this.totals.completionTokens += res.usage.completionTokens;
    this.totals.costUsd += cost;
    this.totals.llmCalls++;
    this.emit({ type: 'usage', usage: res.usage, costUsd: cost, latencyMs: res.latencyMs, model: res.model, role });
    return res;
  }

  // ------------------------------------------------------------ steering, queue, truncation (D12)

  /**
   * Inject a user message into the running loop: it is added after the current
   * tool results and before the next LLM call as "[user steer] …". If the agent
   * is idle (or the run ends before a next call) it runs as the next prompt.
   */
  steer(text: string): void {
    const t = String(text ?? '').trim();
    if (!t) return;
    this.emit({ type: 'steer', text: t, queued: !this.running });
    if (this.running) this.steerQueue.push(t);
    else {
      this.runQueue.push(t);
      this.drainQueue();
    }
  }

  /** Run `input` after the current run (and earlier queued prompts) finish. Starts now if idle. Returns the queue position. */
  enqueue(input: string | ContentPart[]): number {
    this.runQueue.push(input);
    if (typeof input === 'string') this.emit({ type: 'steer', text: input, queued: true });
    this.drainQueue();
    return this.runQueue.length;
  }

  get queued(): number {
    return this.runQueue.length;
  }

  /** Resolves when no run is active and the queue is empty. */
  async idle(): Promise<void> {
    while (this.queueRunner || this.running) await (this.queueRunner ?? new Promise((r) => setTimeout(r, 20)));
  }

  private drainQueue(): void {
    if (this.queueRunner || this.running || !this.runQueue.length) return;
    this.queueRunner = (async () => {
      try {
        while (this.runQueue.length && !this.running) {
          const next = this.runQueue.shift()!;
          try {
            await this.runOnce(next);
          } catch (e) {
            this.emit({ type: 'notice', level: 'error', message: `queued prompt failed: ${(e as Error).message}` });
          }
        }
      } finally {
        this.queueRunner = undefined;
      }
    })();
  }

  /** N34: messages from teammates waiting for the next turn (already wrapped as untrusted data). */
  private inbound: string[] = [];

  /**
   * N34: deliver a teammate message (or team notice). It lands before the next model call as a separate,
   * synthetic user message: never as "[user steer]", never in the task brief (it is not the user speaking),
   * and never as an approval (approvals only come from requestPermission). `taint` marks the session tainted
   * when the sender had read untrusted content (inter-agent messages carry taint).
   * An idle agent keeps it for its next run.
   */
  deliver(text: string, o: { taint?: string } = {}): void {
    const t = String(text ?? '').trim();
    if (!t) return;
    if (o.taint) this.markTainted(o.taint);
    this.inbound.push(t);
  }

  /** N34: messages delivered and not yet seen by the model. */
  get pendingInbound(): number {
    return this.inbound.length;
  }

  private injectInbound(): void {
    if (!this.inbound.length) return;
    const texts = this.inbound.splice(0);
    this.push({ role: 'user', content: texts.join('\n\n'), _meta: { synthetic: true } });
  }

  private injectSteers(): void {
    if (!this.steerQueue.length) return;
    const texts = this.steerQueue.splice(0);
    for (const t of texts) this.noteBrief(t, true);
    this.push({ role: 'user', content: texts.map((t) => `[user steer] ${t}`).join('\n\n') });
  }

  /**
   * Keep messages[0..messageIndex) and drop the rest (edit-and-resubmit, C1
   * conversation restore). The result is always a valid sequence: the system
   * message is kept, and an assistant tool call never survives without all of
   * its results (nor a result without its call).
   */
  truncateTo(messageIndex: number): ChatMessage[] {
    if (this.running) throw new Error('cannot truncate the conversation while a run is in progress');
    this.cancelPendingCompaction();
    const hasSystem = this.messages[0]?.role === 'system';
    let keep = this.messages.slice(0, Math.max(hasSystem ? 1 : 0, Math.min(Math.floor(messageIndex), this.messages.length)));
    for (;;) {
      // drop a trailing incomplete tool exchange
      let ai = -1;
      for (let i = keep.length - 1; i >= 0; i--) if (keep[i].role === 'assistant' && keep[i].tool_calls?.length) {
        ai = i;
        break;
      }
      if (ai < 0) break;
      const ids = new Set(keep[ai].tool_calls!.map((c) => c.id));
      const answered = new Set(keep.slice(ai + 1).filter((m) => m.role === 'tool' && ids.has(m.tool_call_id ?? '')).map((m) => m.tool_call_id));
      if (answered.size === ids.size) break;
      keep = keep.slice(0, ai);
    }
    keep = dropOrphanToolMessages(keep);
    const removed = this.messages.slice(keep.length);
    this.messages = keep;
    if (this.taint && this.taint.index >= keep.length) this.recomputeTaint();
    // R5: a removed prompt (edit-and-resubmit) is no longer part of the brief
    this.brief = briefFromMessages(keep);
    this.steerQueue = [];
    this.bgSummary = undefined;
    this.pendingImages = [];
    this.journal?.write({ type: 'compacted', reason: 'truncate', messages: this.messages });
    this.emit({ type: 'notice', level: 'info', message: `conversation truncated to ${keep.length} message(s) (${removed.length} removed)` });
    return removed;
  }

  // ------------------------------------------------------------ run

  /**
   * Run one prompt to completion. Prompts queued with enqueue()/steer() while
   * it runs start right after it (await idle() to wait for them too).
   */
  async run(input: string | ContentPart[]): Promise<RunResult> {
    if (this.running || this.queueRunner) throw new Error('agent is already running');
    try {
      return await this.runOnce(input);
    } finally {
      this.drainQueue();
    }
  }

  /** v1.1 R4: who is calling, for the admission point every model request goes through (llm/admission.ts). */
  private admissionScope(role = 'main'): AdmissionScope {
    const self = this;
    const a = this.config.agent;
    return {
      config: this.config,
      sessionId: this.sessionId,
      get runId() {
        return self.currentRunId;
      },
      depth: this.depth,
      kind: 'agent',
      role,
      run: { maxCostUsd: a.maxCostUsd, maxTokens: a.maxTokens, spent: () => ({ costUsd: self.stats.costUsd, tokens: self.stats.promptTokens + self.stats.completionTokens }) },
      // v1.2 N18: the budgets inherited from ancestors (and this run's own), checked and reserved on every call
      get pools() {
        return self.budgetPools();
      },
    };
  }

  /** v1.2 N18: this run's budget as a pool, so children (any depth) draw from what this run has left. */
  private runPool?: BudgetPool;

  /** v1.2 N18/N34: every budget a model call of this agent draws from: the inherited ones, then this run's. */
  budgetPools(): BudgetPool[] {
    return [...(this.opts.budgetPools ?? []), ...(this.runPool ? [this.runPool] : [])];
  }

  /** v1.2 N18: what this agent may still spend (the tightest of its pools), for clamping a child's budget. */
  remainingBudget(): { maxTokens?: number; maxCostUsd?: number } {
    const out: { maxTokens?: number; maxCostUsd?: number } = {};
    for (const p of this.budgetPools()) {
      if (limitState(p.maxTokens) !== 'unlimited') out.maxTokens = Math.min(out.maxTokens ?? Infinity, p.maxTokens! - p.used.tokens - p.reserved.tokens);
      if (limitState(p.maxCostUsd) !== 'unlimited') out.maxCostUsd = Math.min(out.maxCostUsd ?? Infinity, p.maxCostUsd! - p.used.costUsd - p.reserved.costUsd);
    }
    return out;
  }

  /** Run model work (a run, a helper call, compaction) inside this agent's admission scope. */
  private admitted<T>(fn: () => Promise<T>, role = 'main'): Promise<T> {
    return withAdmissionScope(this.admissionScope(role), fn);
  }

  private runOnce(input: string | ContentPart[]): Promise<RunResult> {
    return this.admitted(() => this.runOnceAdmitted(input));
  }

  private async runOnceAdmitted(input: string | ContentPart[]): Promise<RunResult> {
    if (this.running) throw new Error('agent is already running');
    this.running = true;
    this.abortCtl = new AbortController();
    // N10: an idle compaction in flight finishes (or is discarded) before the run touches the history
    await this.compactionSettled();
    this.stats = emptyStats();
    // v1.2 N18: a pool for this run's own limits, inherited by every child it starts (budgets flow downward)
    const lim = this.config.agent;
    this.runPool = limitState(lim.maxTokens) !== 'unlimited' || limitState(lim.maxCostUsd) !== 'unlimited' ? newBudgetPool(`${this.depth ? 'subagent ' : ''}run (agent.maxTokens / agent.maxCostUsd)`, { maxTokens: lim.maxTokens, maxCostUsd: lim.maxCostUsd }) : undefined;
    this.failStreak.clear();
    this.thrashReason = '';
    this.toolErrorStreak = 0;
    const runId = shortId('run_');
    this.currentRunId = runId;
    const started = Date.now();
    // R2: what defines the checks (runner configs, scripts, existing tests) before the agent touches anything
    try {
      this.checkDefs = snapshotCheckDefinitions(this.workspace);
    } catch {
      this.checkDefs = undefined;
    }
    // R2 (batch 4): the check the harness will run, fixed now (before the first edit), with what it can load
    this.prepareHarnessCheck();
    const promptText = contentToText(input);
    let stopReason: StopReason = 'end_turn';
    let finalText = '';
    try {
      // fresh system prompt each run (git state, memory files, mode may have changed).
      // N10: when only the date/git lines changed, the previous prompt is kept byte-identical (prefix cache) and the update rides on the user message.
      const stable = stabilizeSystemPrompt(this, this.messages[0]?.role === 'system' ? contentToText(this.messages[0].content) : undefined, this.systemPrompt(), promptCacheSettings(this.config).stableEnvironment);
      const sys = stable.system;
      if (this.messages[0]?.role === 'system') this.messages[0] = { role: 'system', content: sys };
      else this.messages.unshift({ role: 'system', content: sys });
      if (this.depth === 0) this.journal?.write({ type: 'manifest', runId, model: this.llm.profile.model, baseUrl: this.llm.profile.baseUrl, toolMode: this.llm.profile.toolMode, permissionMode: this.policy.mode, shellMode: this.config.shell.mode, protectedPaths: this.config.permissions.protectedPaths, workspace: this.workspace, tools: this.tools.map((t) => t.name) });
      const pre = await runHooks(this.config.hooks.UserPromptSubmit, 'UserPromptSubmit', { prompt: promptText }, this.workspace);
      if (pre.block) {
        finalText = `Prompt blocked by hook: ${pre.reason}`;
        stopReason = 'error';
        return await this.finish(runId, stopReason, finalText, started);
      }
      let content: string | ContentPart[] = pre.context ? (typeof input === 'string' ? `${input}\n\n${attachmentBlock('hook_context', {}, pre.context)}` : [...input, { type: 'text', text: attachmentBlock('hook_context', {}, pre.context) }]) : input;
      content = await this.withRepoMap(content, promptText);
      if (stable.note) content = typeof content === 'string' ? `${content}\n\n${stable.note}` : [...content, { type: 'text', text: stable.note }];
      this.emit({ type: 'run_start', runId, prompt: promptText, model: this.llm.profile.model });
      this.push({ role: 'user', content });
      if (this.depth === 0 || !this.brief.entries.length) this.noteBrief(promptText);
      // A prompt that carries untrusted data (a channel message from a non-owner, a webhook event) taints from the start.
      const promptEnv = untrustedEnvelope(withoutHarnessRelay(promptText));
      if (promptEnv) this.markTainted(`${promptEnv} (in the prompt)`);
      if (!this.sessionStarted) {
        this.sessionStarted = true;
        await this.runExt('onSessionStart', (e) => e.onSessionStart!(this.api()));
      }
      await this.runExt('onRunStart', (e) => e.onRunStart!(this.api(), promptText));
      let emptyNudges = 0;
      let overflowRetries = 0;
      let validations = 0;
      let stopHookBlocks = 0;
      let verifyNudged = false;
      for (;;) {
        if (this.abortCtl.signal.aborted) {
          stopReason = 'aborted';
          break;
        }
        if (this.stats.turns >= this.config.agent.maxTurns) {
          stopReason = 'max_turns';
          finalText = `Stopped after ${this.stats.turns} turns (agent.maxTurns). The work may be incomplete.`;
          break;
        }
        this.stats.turns++;
        this.emit({ type: 'turn_start', turn: this.stats.turns });
        const gate = (await this.runExt<TurnGate | void>('beforeTurn', (e) => e.beforeTurn!(this.api(), this.stats.turns))).find((g): g is TurnGate => !!g && typeof g === 'object' && 'stop' in g);
        if (gate) {
          stopReason = gate.stop;
          finalText = gate.message;
          this.emit({ type: 'notice', level: 'warn', message: gate.message });
          break;
        }
        // D12: steering messages land after the last tool results, before this call.
        this.injectSteers();
        // N34: inbound teammate messages (delivered by the team inbox's beforeTurn), as data, never as the user
        this.injectInbound();
        const tokens = estimateMessagesTokens(this.messages);
        const budget = this.budget();
        if (tokens > budget) await this.compactNow(false);
        else this.maybeStartBackgroundSummary(tokens, budget);

        let res: CompletionResult;
        try {
          res = await this.callLLM();
          overflowRetries = 0;
        } catch (e) {
          const err = e as LLMError;
          if (err.kind === 'aborted' || this.abortCtl.signal.aborted) {
            stopReason = 'aborted';
            break;
          }
          if (err.kind === 'budget') {
            // R4: the admission point refused the call before anything was sent
            stopReason = 'budget';
            finalText = err.message;
            this.emit({ type: 'notice', level: 'warn', message: finalText });
            break;
          }
          if (err.kind === 'context_overflow' && overflowRetries < 2) {
            overflowRetries++;
            this.stats.turns--;
            this.emit({ type: 'notice', level: 'warn', message: 'context window exceeded; compacting and retrying' });
            await this.compactNow(true);
            continue;
          }
          stopReason = this.stats.successfulLlmCalls === 0 ? 'llm_unavailable' : 'error';
          finalText = `LLM error: ${err.message}`;
          this.emit({ type: 'notice', level: 'error', message: finalText });
          break;
        }
        if (this.overBudget()) {
          stopReason = 'budget';
          finalText = `Stopped: budget exceeded (cost $${this.stats.costUsd.toFixed(4)}, tokens ${this.stats.promptTokens + this.stats.completionTokens}).`;
          break;
        }
        const calls = res.toolCalls;
        if (!calls.length && !res.text.trim()) {
          this.stats.unparseableReplies++;
          if (emptyNudges < 2) {
            emptyNudges++;
            const why = res.emptyDueToLength
              ? 'Your previous reply hit the output-token limit before producing any visible answer or tool call (hidden reasoning consumed it). Be more direct: call the next tool or give the answer now.'
              : 'Your previous reply was empty. Either call a tool to continue the task, or give your final answer.';
            this.emit({ type: 'notice', level: 'warn', message: res.emptyDueToLength ? 'model reply empty (max_tokens consumed by reasoning) — nudging' : 'empty model reply — nudging' });
            this.push({ role: 'user', content: why, _meta: { synthetic: true } });
            continue;
          }
          stopReason = 'error';
          finalText = 'The model returned empty replies repeatedly.';
          break;
        }
        emptyNudges = 0;
        // D4: some templates (Mistral, Llama) reject ids that are not exactly 9 alphanumerics.
        if (selectOverlay(this.llm.profile.model)?.strictToolIds && coreSettings(this.config).modelOverlays) for (const c of calls) if (!/^[A-Za-z0-9]{9}$/.test(c.id)) c.id = newToolCallId();
        this.push({
          role: 'assistant',
          content: res.text || null,
          tool_calls: calls.length ? calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.args ? JSON.stringify(c.args) : c.argsRaw } })) : undefined,
          // Interleaved-thinking models need their earlier reasoning back in the tool loop (overlay passReasoningBack).
          ...(res.reasoning && ((this.llm.profile as any).passReasoningBack ?? selectOverlay(this.llm.profile.model)?.passReasoningBack) ? { reasoning_content: res.reasoning } : {}),
        });
        this.emit({ type: 'assistant_message', text: res.text, toolCalls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? c.argsRaw })) });

        if (!calls.length) {
          // Candidate final answer: stop hooks and optional independent validation.
          const stopHook = await runHooks(this.config.hooks.Stop, 'Stop', { finalText: res.text, filesChanged: this.stats.filesChanged }, this.workspace);
          if (stopHook.block && stopHookBlocks < 3) {
            stopHookBlocks++;
            this.push({ role: 'user', content: `A project hook did not accept stopping yet: ${stopHook.reason}`, _meta: { synthetic: true } });
            continue;
          }
          // Open models often claim success without checking (EAG S17/S18 "unverified pass" / "false success").
          // v1.1 R2: deterministic, once per run, from recorded evidence: the answer claims success but no trusted
          // check passed after the last edit (none ran, or the last one failed) → ask to verify, with the evidence.
          // R2 (batch 4): the harness runs the project's check itself; only that can verify
          await this.runHarnessCheck();
          const status = completionStatus({ filesChanged: this.stats.filesChanged, evidence: this.stats.evidence ?? [], finalText: res.text, noCheck: this.noCheckReason });
          if (this.config.agent.requireVerification && (status.state === 'unverified' || status.state === 'failed') && status.claimedSuccess && !verifyNudged && this.policy.mode !== 'plan' && (this.toolMap.has('bash') || this.checkPlan)) {
            verifyNudged = true;
            this.emit({ type: 'notice', level: 'info', message: `success claimed without a check that passed after the last edit (${status.summary}) — asking the agent to ${status.state === 'failed' ? 'fix it' : 'verify'}` });
            this.push({ role: 'user', content: verificationNudge(status, this.stats.evidence ?? []), _meta: { synthetic: true } });
            continue;
          }
          if (this.config.agent.autoValidate && this.depth === 0 && this.stats.filesChanged.length && validations < 2 && this.toolMap.has('task')) {
            validations++;
            const report = await this.runSubagent({ agentType: 'validator', description: 'validate the work', prompt: `Task given to the other agent:\n${promptText}\n\nIts final report:\n${res.text}\n\nFiles it changed: ${this.stats.filesChanged.join(', ')}\nWorkspace: ${this.workspace}` });
            if (/VERDICT:\s*FAIL/i.test(report) || report.startsWith('UNVERIFIED')) {
              this.push({ role: 'user', content: `An independent validator reviewed your work and found problems. Address them (or explain why they are not problems), verify, then give your final answer.\n\n${report}`, _meta: { synthetic: true } });
              continue;
            }
          }
          finalText = res.text;
          stopReason = 'end_turn';
          break;
        }

        await this.executeCalls(calls);
        if (this.pendingImages.length) {
          this.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...this.pendingImages], _meta: { synthetic: true } });
          this.pendingImages = [];
        }
        if (this.thrashReason) {
          stopReason = 'thrashing';
          finalText = `Stopped: ${this.thrashReason}`;
          this.emit({ type: 'notice', level: 'warn', message: finalText });
          break;
        }
      }
    } finally {
      this.running = false;
      // Steers that arrived after the last LLM call run next, in order.
      if (this.steerQueue.length) this.runQueue.unshift(...this.steerQueue.splice(0).map((t) => `[user steer] ${t}`));
    }
    return await this.finish(runId, stopReason, finalText, started);
  }

  /** D7: the first prompt of a session carries a ranked repo map (personalised to what the prompt mentions). */
  private async withRepoMap(content: string | ContentPart[], promptText: string): Promise<string | ContentPart[]> {
    const tokens = coreSettings(this.config).repoMapTokens;
    if (this.depth !== 0 || tokens <= 0 || typeof content !== 'string' || this.messages.some((m) => m.role === 'user' || m.role === 'assistant')) return content;
    try {
      const recent = [...new Set(this.editHistory.map((e) => e.path))];
      const m = await buildRepoMap(this.workspace, { tokens, focusText: promptText, focusFiles: recent, canRead: readableBy(this.policy), exclude: coreSettings(this.config).repoMapExclude, cacheDir: repoMapCacheDir(this.config)(this.workspace), maxFiles: coreSettings(this.config).repoMapMaxFiles });
      if (!m.text) return content;
      return `${content}\n\n${attachmentBlock('repo_map', {}, `Ranked outline of this repository (${m.files.length} of ${m.totalFiles} source files; ⋮ = elided code). Use it to decide what to read; it is not the full code.\n${m.text}`)}`;
    } catch (e) {
      this.log('warn', `repo map failed: ${(e as Error).message}`);
      return content;
    }
  }

  private async finish(runId: string, stopReason: StopReason, finalText: string, started: number): Promise<RunResult> {
    this.stats.durationMs = Date.now() - started;
    this.stats.filesChanged = [...new Set(this.stats.filesChanged)];
    // R2 (batch 4): the run ends: the harness check runs if no check has seen the last edit yet (not after a cancel)
    if (stopReason !== 'aborted' && !this.abortCtl?.signal.aborted) {
      try {
        await this.runHarnessCheck();
      } catch (e) {
        this.log('warn', `harness check failed: ${(e as Error).message}`);
      }
    }
    const completion = completionStatus({ filesChanged: this.stats.filesChanged, evidence: this.stats.evidence ?? [], finalText, noCheck: this.noCheckReason });
    await this.runExt('onRunEnd', (e) => e.onRunEnd!(this.api(), { runId, stopReason, finalText, stats: this.stats }));
    this.emit({ type: 'run_end', stopReason, finalText, stats: this.stats, completion });
    this.completions.push({ runId, ts: new Date().toISOString(), state: completion.state, summary: completion.summary });
    this.saveState();
    return { runId, stopReason, finalText, stats: this.stats, completion };
  }

  /** Commands that count as trusted checks besides known runners: agent.verifyCommands + AGENTS.md (cached per session). */
  verifyCommands(): string[] {
    this.verifyCommandsCache ??= [...coreSettings(this.config).verifyCommands, ...agentsMdVerifyCommands(this.workspace)];
    return this.verifyCommandsCache;
  }

  /** R8: ask the host to save agent-touched buffers before a shell command, and report what it could not. */
  private async flushHost(): Promise<FlushOutcome | undefined> {
    if (!this.host.flushForShell) return undefined;
    try {
      const r = (await this.host.flushForShell()) as unknown;
      if (Array.isArray(r)) return { saved: r.map(String), skipped: [], failed: [] };
      const o = (r ?? {}) as Partial<FlushOutcome>;
      return { saved: o.saved ?? [], skipped: o.skipped ?? [], failed: o.failed ?? [], error: o.error };
    } catch (e) {
      return { saved: [], skipped: [], failed: [], error: (e as Error).message };
    }
  }

  /**
   * R8: the explicit save decision for documents the user had unsaved changes in (agent.unsavedBuffers):
   * "save" saves them first, "disk" runs against the disk version, "ask" (default) asks the user once per
   * file per session; without a user, or a host that cannot save, the command runs against the disk.
   */
  private async decideUnsaved(f: FlushOutcome, command: string): Promise<FlushOutcome> {
    if (!f.skipped.length) return f;
    const policy = coreSettings(this.config).unsavedBuffers;
    const rel = (p: string) => path.relative(this.workspace, p) || p;
    let save = policy === 'save';
    if (policy === 'ask') {
      const undecided = f.skipped.filter((p) => !this.unsavedChoice.has(p));
      if (undecided.length && this.opts.ui?.askUser && this.host.saveDocuments) {
        const answer = await this.opts.ui.askUser(
          `${undecided.map(rel).join(', ')} ha${undecided.length === 1 ? 's' : 've'} unsaved changes in the editor that the agent did not make. Save before running \`${truncateLine(command, 80)}\`? "save" runs it against the editor version; "disk" runs it against the version on disk (the result will say so).`,
          ['save', 'disk'],
        );
        const choice = /^s/i.test(String(answer).trim()) ? 'save' : 'disk';
        for (const p of undecided) this.unsavedChoice.set(p, choice);
      }
      save = f.skipped.every((p) => this.unsavedChoice.get(p) === 'save');
    }
    if (!save || !this.host.saveDocuments) return { ...f, decision: 'disk' };
    try {
      const r = await this.host.saveDocuments(f.skipped);
      return { saved: [...f.saved, ...r.saved], skipped: r.skipped, failed: [...f.failed, ...r.failed], error: f.error, decision: 'saved', savedByDecision: r.saved };
    } catch (e) {
      return { ...f, failed: [...f.failed, ...f.skipped.map((p) => ({ path: p, error: (e as Error).message }))], skipped: [], decision: 'disk' };
    }
  }

  /** R8: the note appended to a shell result when the shell did not see what is in the editor. */
  private flushNote(f: FlushOutcome | undefined): { note?: string; unsaved: string[]; decision?: 'saved' | 'disk' } {
    if (!f) return { unsaved: [] };
    const rel = (p: string) => path.relative(this.workspace, p) || p;
    const unsaved = [...f.skipped, ...f.failed.map((x) => x.path)].map(rel);
    const parts: string[] = [];
    if (f.error) parts.push(`saving editor buffers before this command failed (${f.error}); the command ran against the files on disk, which may differ from the editor`);
    if (f.failed.length) parts.push(`could not save ${f.failed.map((x) => `${rel(x.path)} (${x.error})`).join(', ')}: the command saw the disk version`);
    if (f.skipped.length) parts.push(`${f.skipped.map(rel).join(', ')} ha${f.skipped.length === 1 ? 's' : 've'} unsaved changes in the editor that were not saved; the command ran against the disk version`);
    if (f.savedByDecision?.length) parts.push(`saved ${f.savedByDecision.map(rel).join(', ')} (unsaved editor changes) before the command, as decided; it ran against the editor version`);
    const decision = f.decision ?? (unsaved.length ? 'disk' : undefined);
    return { note: parts.length ? `[harness] ${parts.join('; ')}.` : undefined, unsaved, decision };
  }

  private overBudget(): boolean {
    const a = this.config.agent;
    if (limitState(a.maxCostUsd) === 'limited' && this.stats.costUsd > a.maxCostUsd!) return true;
    if (limitState(a.maxTokens) === 'limited' && this.stats.promptTokens + this.stats.completionTokens > a.maxTokens!) return true;
    return false;
  }

  private async callLLM(): Promise<CompletionResult> {
    this.stats.llmCalls++;
    this.totals.llmCalls++;
    // D10: in plan mode the main loop uses the planner profile when one is routed.
    const planning = this.policy.mode === 'plan' && !!this.config.routing?.planner && this.depth === 0;
    const client = planning ? this.llmFor('planner') : this.llm;
    const res = await client.complete({
      messages: this.messages,
      tools: this.toolSpecs(),
      signal: this.abortCtl!.signal,
      // N10: llama.cpp pins one slot per agent (subagents have their own session id)
      cacheSlot: { key: this.sessionId, primary: this.depth === 0 },
      onTextDelta: (t) => this.emit({ type: 'text_delta', text: t }),
      onReasoningDelta: (t) => this.emit({ type: 'reasoning_delta', text: t }),
    });
    this.stats.successfulLlmCalls++;
    const cost = costOf(res.usage, client.profile);
    this.stats.promptTokens += res.usage.promptTokens;
    this.stats.completionTokens += res.usage.completionTokens;
    this.stats.costUsd += cost;
    this.totals.promptTokens += res.usage.promptTokens;
    this.totals.completionTokens += res.usage.completionTokens;
    this.totals.costUsd += cost;
    this.emit({ type: 'usage', usage: res.usage, costUsd: cost, latencyMs: res.latencyMs, model: res.model, role: planning ? 'planner' : (this.opts.role ?? 'main') });
    if (res.toolCalls.some((c) => c.parseError)) this.stats.unparseableReplies++;
    return res;
  }

  // ------------------------------------------------------------ tools

  private toolContext(): ToolContext {
    return {
      workspace: this.workspace,
      config: this.config,
      ledger: this.ledger,
      signal: this.abortCtl!.signal,
      llm: this.llm,
      smallLlm: this.shared.smallLlm,
      policy: this.policy,
      skills: this.skills,
      emit: (e) => this.emit(e),
      todos: this.todos,
      setTodos: (t) => {
        this.todos = t;
        this.emit({ type: 'todos', todos: t });
        this.saveState();
      },
      // N18: every depth may ask; runSubagentNow refuses past agent.maxDepth with a typed reason
      runSubagent: (req) => this.runSubagent(req),
      askUser: this.opts.ui?.askUser,
      setMode: (m) => this.setMode(m),
      approvePlan: this.opts.ui?.approvePlan,
      vision: this.llm.profile.vision,
      artifactsDir: path.join(this.workspace, '.tugline', 'artifacts'),
      host: this.host,
      sessionId: this.sessionId,
      depth: this.depth,
      taint: this.taint && coreSettings(this.config).taint !== 'off' ? this.taint.source : undefined,
    };
  }

  private resolveTool(name: string): ToolDef | undefined {
    const n = name.replace(/^(functions\.|tools\.|default_api\.)/, '').trim();
    const t = this.toolMap.get(name) ?? this.toolMap.get(n) ?? [...this.toolMap.values()].find((x) => x.name.toLowerCase() === n.toLowerCase());
    // Calling a deferred tool by its exact (listed) name loads it, as tool_search would.
    if (t && this.deferred.has(t.name)) this.activateTools([t.name]);
    return t;
  }

  private async executeCalls(calls: CompletionToolCall[]): Promise<void> {
    const ctx = this.toolContext();
    const results: { call: CompletionToolCall; out: ToolOutput; name: string }[] = [];
    const allReadOnly = this.config.agent.parallelReadOnlyTools && calls.length > 1 && calls.every((c) => this.resolveTool(c.name)?.readOnly && this.preCheck(c) === 'allow');
    if (allReadOnly) {
      const outs = await Promise.all(calls.map((c) => this.executeOne(c, ctx)));
      outs.forEach((o, i) => results.push({ call: calls[i], out: o.out, name: o.name }));
    } else {
      const isTask = (c: CompletionToolCall) => this.resolveTool(c.name)?.name === 'task' && !!ctx.runSubagent;
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (this.abortCtl!.signal.aborted) {
          results.push({ call: c, out: { output: 'Cancelled by the user.', isError: true }, name: c.name });
          continue;
        }
        // D1: consecutive task calls run concurrently (bounded); results keep call order.
        if (isTask(c)) {
          let j = i;
          while (j + 1 < calls.length && isTask(calls[j + 1])) j++;
          if (j > i) {
            const group = calls.slice(i, j + 1);
            const outs = await mapLimit(group, coreSettings(this.config).maxParallelSubagents, (gc) => this.executeOne(gc, ctx));
            outs.forEach((o, k) => results.push({ call: group[k], out: o.out, name: o.name }));
            i = j;
            if (this.thrashReason) break;
            continue;
          }
        }
        const o = await this.executeOne(c, ctx);
        results.push({ call: c, out: o.out, name: o.name });
        if (this.thrashReason) break;
      }
      // Calls skipped after a thrash stop still need a result message
      for (const c of calls.slice(results.length)) results.push({ call: c, out: { output: 'Not executed: the run was stopped.', isError: true }, name: c.name });
    }
    for (const r of results) {
      this.push({ role: 'tool', tool_call_id: r.call.id, name: r.name, content: r.out.isError ? `Error: ${r.out.output}` : r.out.output });
      if (r.out.images?.length && this.llm.profile.vision) for (const img of r.out.images) this.pendingImages.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
    }
  }

  private preCheck(c: CompletionToolCall): 'allow' | 'other' {
    const tool = this.resolveTool(c.name);
    if (!tool || c.parseError) return 'other';
    try {
      const { args } = coerceArgs(c.args ?? {}, tool.parameters as any);
      const pin = tool.permissionInput?.(args as any, this.toolContext()) ?? {};
      return this.check({ tool: tool.name, kind: tool.kind, ...pin }).decision === 'allow' ? 'allow' : 'other';
    } catch {
      return 'other';
    }
  }

  /**
   * The policy decision, plus `alwaysAsk`: an input that must reach a human in
   * every mode, auto included (writes that persist into every future session,
   * like user memory). Hard denies and deny rules still win; no allow rule or
   * mode can turn it into an allow.
   */
  private check(input: CheckInput): Decision {
    const d = this.policy.check(input);
    if (d.decision === 'allow' && input.alwaysAsk) return { decision: 'ask', reason: input.alwaysAsk };
    return d;
  }

  private async executeOne(call: CompletionToolCall, ctx: ToolContext): Promise<{ out: ToolOutput; name: string }> {
    this.stats.toolCalls++;
    const tool = this.resolveTool(call.name);
    const started = Date.now();
    const fail = (msg: string, name = call.name): { out: ToolOutput; name: string } => {
      this.stats.toolErrors++;
      this.toolErrorStreak++;
      if (this.toolErrorStreak >= 8) this.thrashReason = `${this.toolErrorStreak} tool calls in a row failed; the agent is not making progress.`;
      this.emit({ type: 'tool_end', id: call.id, name, ok: false, output: msg, durationMs: Date.now() - started });
      return { out: { output: msg, isError: true }, name };
    };
    if (!tool) return fail(`unknown tool "${call.name}". Available tools: ${this.tools.map((t) => t.name).join(', ')}`);
    if (call.parseError) return fail(`the arguments for ${tool.name} were not valid JSON (${call.parseError}). Re-send the call with valid JSON arguments.`, tool.name);
    const coerced = coerceArgs(call.args ?? {}, tool.parameters as any);
    if (coerced.error) return fail(`${coerced.error} for ${tool.name}. Expected parameters: ${JSON.stringify(tool.parameters)}`, tool.name);
    const args = coerced.args;
    let title = tool.name;
    try {
      title = tool.title(args as any);
    } catch {
      /* keep */
    }
    this.emit({ type: 'tool_start', id: call.id, name: tool.name, args, title });

    // ---- permission
    let pin: Omit<CheckInput, 'tool' | 'kind'> = {};
    try {
      pin = tool.permissionInput?.(args as any, ctx) ?? {};
    } catch (e) {
      return fail(`invalid arguments: ${(e as Error).message}`, tool.name);
    }
    const input: CheckInput = { tool: tool.name, kind: tool.kind, ...pin };
    let decision = this.check(input);
    // G2 Rule of Two: after untrusted input, outbound actions need a human (allow → ask; hard denies stay).
    let taintAsk = false;
    if (this.taint && decision.decision !== 'deny' && coreSettings(this.config).taint !== 'off') {
      const hit = taintCategory({ tool: tool.name, input, args, reason: decision.reason }, this.workspace);
      const uncontained = typeof input.command === 'string' && tool.kind === 'execute' ? this.taintContainment().ask : undefined;
      if (hit) {
        taintAsk = true;
        decision = { decision: 'ask', reason: `untrusted content was read in this session (${this.taint.source}), so ${hit.category.replace(/-/g, ' ')} needs your approval: ${hit.reason}` };
      } else if (uncontained) {
        taintAsk = true;
        decision = { decision: 'ask', reason: `untrusted content was read in this session (${this.taint.source}), and ${uncontained}` };
      }
    }
    // Reject calls that would fail anyway before bothering the user (deny decisions still win and are recorded).
    if (decision.decision !== 'deny' && tool.validate) {
      try {
        tool.validate(args as any, ctx);
      } catch (e) {
        return fail(e instanceof ToolError ? e.message : (e as Error).message, tool.name);
      }
    }
    if (decision.decision === 'deny') {
      this.stats.refusals++;
      this.emit({ type: 'refusal', tool: tool.name, reason: decision.reason, args });
      this.journal?.write({ type: 'refusal', tool: tool.name, reason: decision.reason, args });
      return fail(`Refused: ${decision.reason}`, tool.name);
    }
    if (decision.decision === 'ask') {
      const request: PermissionRequest = {
        id: call.id,
        tool: tool.name,
        kind: tool.kind,
        title,
        detail: input.command ?? (tool.kind === 'mcp' ? JSON.stringify(args, null, 2) : undefined),
        reason: decision.reason,
        // no "always allow" for taint asks: each outbound action after untrusted input is judged on its own
        suggestedRule: taintAsk ? undefined : PermissionPolicy.suggestRule(input, this.workspace),
      };
      if (tool.preview) {
        try {
          request.diff = await tool.preview(args as any, ctx);
        } catch {
          /* no preview */
        }
      }
      // Extensions (e.g. the classifier approver, SPEC C3) may settle an 'ask'. Hard denies never get here.
      let extDecision: ApprovalDecision | undefined;
      // alwaysAsk inputs (user-scope memory, whole-screen capture …) must reach a human: no extension may settle them.
      // Taint asks likewise: an approver model reads the same injected context, so it cannot be the second key.
      const approvals = input.alwaysAsk || taintAsk ? [] : await this.runExt<ApprovalDecision>('approve', (e) => e.approve!(this.api(), { tool: tool.name, input, args, title, reason: decision.reason }));
      for (const d of approvals) {
        if (d.decision === 'deny') {
          extDecision = d;
          break;
        }
        if (d.decision === 'allow' && !extDecision) extDecision = d;
      }
      // N43: an extension's 'ask' is a floor (auto mode's prefilter, ask rules): no other extension's allow settles it,
      // and the prompt offers no "always allow" (a stored rule must not quietly pre-approve a floor action later)
      if (approvals.some((d) => d.decision === 'ask')) {
        if (extDecision?.decision === 'allow') extDecision = undefined;
        request.suggestedRule = undefined;
      }
      let answer: PermissionAnswer;
      if (extDecision?.decision === 'allow') {
        answer = { decision: 'allow' };
        this.emit({ type: 'permission', request: { ...request, reason: `${decision.reason}; auto-approved by ${extDecision.by ?? 'extension'}${extDecision.reason ? `: ${extDecision.reason}` : ''}` }, answer, auto: true });
      } else if (extDecision?.decision === 'deny') {
        answer = { decision: 'deny', feedback: `blocked by ${extDecision.by ?? 'extension'}${extDecision.reason ? `: ${extDecision.reason}` : ''}` };
      } else if (this.opts.ui?.requestPermission) answer = await this.opts.ui.requestPermission(request);
      else answer = { decision: 'deny', feedback: `no user is available to approve this (${decision.reason}); permission mode is "${this.policy.mode}"` };
      if (extDecision?.decision !== 'allow') this.emit({ type: 'permission', request, answer, auto: false });
      if (answer.decision === 'deny') {
        this.stats.refusals++;
        this.emit({ type: 'refusal', tool: tool.name, reason: answer.feedback ?? 'denied by user', args });
        return fail(`The user denied this action${answer.feedback ? `: ${answer.feedback}` : ''}. Do not retry the same call; adjust your approach or ask the user.`, tool.name);
      }
      if (answer.always && request.suggestedRule) this.policy.addSessionRule(request.suggestedRule);
      if (this.abortCtl?.signal.aborted) return fail('Cancelled by the user.', tool.name);
    }

    // ---- hooks before
    const preHook = await runHooks(this.config.hooks.PreToolUse, 'PreToolUse', { tool: tool.name, args }, this.workspace);
    if (preHook.block) {
      this.stats.refusals++;
      this.emit({ type: 'refusal', tool: tool.name, reason: `hook: ${preHook.reason}`, args });
      return fail(`Blocked by a project hook: ${preHook.reason}`, tool.name);
    }

    // ---- run
    if (this.abortCtl?.signal.aborted) return fail('Cancelled by the user.', tool.name);
    let flush: ReturnType<Agent['flushNote']> = { unsaved: [] };
    if (typeof input.command === 'string' && tool.kind === 'execute') {
      // R8: a failed or partial save is reported, never swallowed: the shell sees the disk, not the editor.
      const flushed = await this.flushHost();
      flush = this.flushNote(flushed ? await this.decideUnsaved(flushed, input.command) : undefined);
      if (flush.note) this.emit({ type: 'notice', level: 'warn', message: flush.note.replace(/^\[harness\] /, '') });
      await this.runExt('beforeShell', (e) => e.beforeShell!(this.api(), input.command!));
    }
    // G2: while tainted, shell commands run contained (sandbox, network off): enforcement, not pattern matching
    const contained = this.taint && coreSettings(this.config).taint !== 'off' && typeof input.command === 'string' && tool.kind === 'execute' ? this.taintContainment().config : undefined;
    const runCtx = contained ? { ...ctx, config: contained } : ctx;
    let out: ToolOutput;
    try {
      out = await tool.run(args as any, runCtx);
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
      // An error can carry untrusted text too (an MCP server's error message, a page quoted in a failure).
      const src = untrustedResult(tool, { output: msg });
      if (src) this.markTainted(src);
      return fail(msg, tool.name);
    }
    this.toolErrorStreak = out.isError ? this.toolErrorStreak + 1 : 0;
    out.output = capOutput(out.output, this.config.agent.maxToolOutputChars);
    if (flush.note) out.output += `\n\n${flush.note}`;
    const untrusted = untrustedResult(tool, out);
    if (untrusted) this.markTainted(untrusted);

    // ---- bookkeeping: edits, commands, thrash detection
    this.seq++;
    const meta = out.meta ?? {};
    if (Array.isArray(meta.activateTools)) this.activateTools(meta.activateTools.map(String));
    // Multi-file tools (apply_patch) report every change in meta.changes; single-file tools use changedFile.
    const changes: { path: string; before: string | null; after: string | null }[] = Array.isArray(meta.changes)
      ? (meta.changes as any[]).filter((c) => typeof c?.path === 'string')
      : typeof meta.changedFile === 'string'
        ? [{ path: meta.changedFile, before: meta.created ? null : String(meta.before ?? ''), after: String(meta.after ?? '') }]
        : [];
    if (changes.length) {
      for (const c of changes) {
        this.editHistory.push({ path: c.path, before: c.before, after: c.after ?? '', ts: Date.now() });
        this.stats.filesChanged.push(path.relative(this.workspace, c.path) || c.path);
      }
      this.lastEditSeq = this.seq;
      this.lastEditAt = Date.now();
      for (const c of this.stats.commandsRun) c.afterLastEdit = false;
      for (const e of this.stats.evidence ?? []) e.afterLastEdit = false;
    }
    // R2: a background job counts only when polled to completion with a real exit code, and only if it
    // started after the last edit (job_output reports `jobResult` for an exited job)
    const jr = meta.jobResult as { command?: string; exitCode?: number | null; startedAt?: number } | undefined;
    if (jr && typeof jr.command === 'string' && typeof jr.exitCode === 'number') this.recordEvidence(jr.command, jr.exitCode, [], undefined, out.output, { startedAt: jr.startedAt ?? 0, background: true });
    if (typeof meta.command === 'string') {
      const exitCode = (meta.exitCode as number | null) ?? null;
      this.stats.commandsRun.push({ command: meta.command, exitCode, afterLastEdit: true });
      this.recordEvidence(meta.command, exitCode, flush.unsaved, flush.decision, out.output);
      const key = meta.command.replace(/\s+/g, ' ').trim();
      if (exitCode === 0) this.failStreak.set(key, 0);
      else {
        const n = (this.failStreak.get(key) ?? 0) + 1;
        this.failStreak.set(key, n);
        const max = this.config.agent.maxRepeatFailures;
        if (max > 0 && n >= max) this.thrashReason = `"${truncateLine(key, 80)}" failed ${n} times in a row. Failing the same way repeatedly is thrashing, not iteration; stopping so a human can look.`;
        else if (max > 1 && n === max - 1) out.output += `\n\n[harness] This command has now failed ${n} times in a row. If the next attempt fails too, the run stops. Re-read the error carefully and change your approach rather than repeating it.`;
      }
    }
    const sig = `${tool.name}:${JSON.stringify(args)}:${out.output.length}:${out.output.slice(-200)}`;
    if (sig === this.lastCallSig) {
      this.sameCallCount++;
      if (this.sameCallCount >= 5) this.thrashReason = `the same ${tool.name} call returned the same result ${this.sameCallCount + 1} times in a row.`;
      else if (this.sameCallCount >= 2) out.output += `\n\n[harness] You have made this identical call ${this.sameCallCount + 1} times with the same result. Do something different.`;
    } else {
      this.sameCallCount = 0;
      this.lastCallSig = sig;
    }

    // ---- hooks after
    const postHook = await runHooks(this.config.hooks.PostToolUse, 'PostToolUse', { tool: tool.name, args, output: out.output.slice(0, 20_000), isError: !!out.isError }, this.workspace);
    if (postHook.block) out.output += `\n\n[project hook feedback] ${postHook.reason}`;
    else if (postHook.context) out.output += `\n\n[project hook] ${postHook.context}`;
    for (const extra of await this.runExt<AfterToolResult | void>('afterTool', (e) => e.afterTool!(this.api(), { id: call.id, tool: tool.name, args, ok: !out.isError, output: out.output, meta, durationMs: Date.now() - started }))) {
      if (typeof extra === 'string' && extra) out.output += `\n\n${extra}`;
      else if (extra && typeof extra === 'object' && extra.text) {
        out.output += `\n\n${extra.text}`;
        if (extra.isError) out.isError = true;
      }
    }

    this.emit({ type: 'tool_end', id: call.id, name: tool.name, ok: !out.isError, output: out.output, durationMs: Date.now() - started, meta: { ...meta, before: undefined, after: undefined, changes: Array.isArray(meta.changes) ? (meta.changes as any[]).map((c) => ({ path: c.path, created: c.before === null, deleted: c.after === null })) : undefined } });
    return { out, name: tool.name };
  }

  /** R2: this run's changed files and their versions now (disk-only when the editor held unsaved changes). */
  private evidenceFiles(unsaved: string[]): VerificationEvidence['files'] {
    return [...new Set(this.stats.filesChanged)].slice(0, 50).map((rel) => ({ path: rel, version: fileVersion(path.resolve(this.workspace, rel)), ...(unsaved.includes(rel) ? { diskOnly: true } : {}) }));
  }

  /** R2 (batch 4): fix this run's harness check and fingerprint what it can load, before the first edit. */
  private prepareHarnessCheck(): void {
    this.harnessSeq = -1;
    this.checkPlan = undefined;
    this.noCheckReason = undefined;
    if (this.depth > 0) {
      this.noCheckReason = 'a subagent run: the parent agent\'s check covers it';
      return;
    }
    const s = coreSettings(this.config);
    if (s.harnessCheck === 'off') {
      this.noCheckReason = 'the harness check is off (agent.harnessCheck: "off")';
      return;
    }
    try {
      const checks = planChecks(this.workspace, { acceptance: [...(this.opts.acceptanceChecks ?? []), ...this.acceptanceChecks], verifyCommands: s.verifyCommands });
      if (checks.length) this.checkPlan = prepareCheckPlan(this.workspace, checks);
      else this.noCheckReason = 'no check is configured or detectable for this project (set agent.verifyCommands, or list the test command in AGENTS.md)';
    } catch (e) {
      this.noCheckReason = `the project's check could not be prepared (${(e as Error).message})`;
    }
  }

  /** R2 (batch 4): may the harness run this check command? true, or why not. Same policy as the agent's own commands. */
  private async harnessMayRun(command: string): Promise<true | string> {
    const input: CheckInput = { tool: 'bash', kind: 'execute', command, cwd: this.workspace };
    const d = this.check(input);
    if (d.decision === 'allow') return true;
    if (d.decision === 'deny') return `the permission policy refused it (${d.reason})`;
    // v1.2 live run (5 Nov): the harness's own check goes through the same approval extensions as the agent's commands
    // (auto mode's floor, fast paths and classifier), so an unattended auto-mode run can still be verified. Not when the
    // session is tainted (an approver reads the same injected context) and never past an extension's 'ask' (a floor).
    if (!this.taint && !input.alwaysAsk) {
      const approvals = await this.runExt<ApprovalDecision>('approve', (e) => e.approve!(this.api(), { tool: 'bash', input, args: { command }, title: `Verify the work: ${command}`, reason: d.reason }));
      const denied = approvals.find((x) => x.decision === 'deny');
      if (denied) return `blocked by ${denied.by ?? 'extension'}${denied.reason ? `: ${denied.reason}` : ''}`;
      const allowed = approvals.find((x) => x.decision === 'allow');
      if (allowed && !approvals.some((x) => x.decision === 'ask')) {
        this.emit({ type: 'permission', request: { id: shortId('chk_'), tool: 'bash', kind: 'execute', title: `Verify the work: ${command}`, detail: command, reason: `${d.reason}; auto-approved by ${allowed.by ?? 'extension'}${allowed.reason ? `: ${allowed.reason}` : ''}` }, answer: { decision: 'allow' }, auto: true });
        return true;
      }
    }
    if (!this.opts.ui?.requestPermission) return `running it needs approval and no user is available (${d.reason})`;
    const request: PermissionRequest = { id: shortId('chk_'), tool: 'bash', kind: 'execute', title: `Verify the work: ${command}`, detail: command, reason: `the harness runs the project's check itself to verify the agent's work; ${d.reason}`, suggestedRule: PermissionPolicy.suggestRule(input, this.workspace) };
    const answer = await this.opts.ui.requestPermission(request);
    this.emit({ type: 'permission', request, answer, auto: false });
    if (answer.decision === 'deny') return `the user declined to run it${answer.feedback ? ` (${answer.feedback})` : ''}`;
    if (answer.always && request.suggestedRule) this.policy.addSessionRule(request.suggestedRule);
    return true;
  }

  /**
   * R2 (batch 4): run the check fixed at run start, in a clean environment, unless no edit happened since the
   * last one. Not run at all when the run changed what the check would load (the files are named instead).
   * Records one evidence entry per command (byHarness), journaled and shown.
   */
  private async runHarnessCheck(): Promise<void> {
    const plan = this.checkPlan;
    if (!plan || !this.stats.filesChanged.length || this.harnessSeq === this.lastEditSeq || this.abortCtl?.signal.aborted) return;
    this.harnessSeq = this.lastEditSeq;
    const checkId = shortId('chk_');
    const sh = this.config.shell;
    const pycache = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-pycache-'));
    const base = scrubbedEnv(sh.scrubEnv);
    const checkHome = makeCheckHome(base.HOME ?? base.USERPROFILE);
    try {
      const env = cleanCheckEnv(base, this.workspace, pycache, checkHome);
      const record = (command: string, source: string, exitCode: number | null, trusted: boolean, why: string, unsaved: string[] = [], decision?: 'saved' | 'disk', output?: string) => {
        const ev: VerificationEvidence = { command, exitCode, ts: new Date().toISOString(), trusted, why, afterLastEdit: true, files: this.evidenceFiles(unsaved), byHarness: true, checkId, source, ...(output !== undefined ? { outputTail: outputTail(output) } : {}), ...(unsaved.length ? { unsavedInEditor: unsaved } : {}), ...(decision ? { unsavedDecision: decision } : {}) };
        (this.stats.evidence ??= []).push(ev);
        this.sessionEvidence.push(ev);
        this.journal?.write({ type: 'evidence', evidence: ev });
      };
      const tamper = (): string | undefined => {
        const u = untrustedChanges(this.workspace, plan, this.sessionTamper, env);
        for (const [k, v] of u.flagged) this.sessionTamper.set(k, v);
        const inWs = programsInWorkspace(this.workspace, plan, env.PATH ?? '');
        if (!u.files.length && !inWs.length) return undefined;
        const files = u.files.length ? `the run created or changed files the check would load: ${u.files.slice(0, 8).join(', ')}${u.files.length > 8 ? ' …' : ''} (${u.reasons.slice(0, 3).join('; ')})` : '';
        return [files, ...inWs].filter(Boolean).join('; ');
      };
      const before = tamper();
      if (before) {
        for (const c of plan.checks) record(c.command, c.source, null, false, `not run: ${before}`);
        this.emit({ type: 'notice', level: 'warn', message: `verification: the harness did not run \`${plan.checks.map((c) => c.command).join('`, `')}\`: ${before}` });
        this.saveState();
        return;
      }
      // the check runs against the disk: report (and decide on) unsaved editor buffers like any shell command
      const flushed = await this.flushHost();
      const flush = this.flushNote(flushed ? await this.decideUnsaved(flushed, plan.checks[0]!.command) : undefined);
      if (flush.note) this.emit({ type: 'notice', level: 'warn', message: flush.note.replace(/^\[harness\] /, '') });
      for (const c of plan.checks) {
        if (this.abortCtl?.signal.aborted) return;
        const may = await this.harnessMayRun(c.command);
        if (may !== true) {
          record(c.command, c.source, null, false, `not run: ${may}`, flush.unsaved, flush.decision);
          break;
        }
        // G2: while tainted, commands run contained, the harness's included
        const tainted = this.taint && coreSettings(this.config).taint !== 'off';
        const cfg = (tainted ? this.taintContainment().config : undefined) ?? this.config;
        if (tainted && !this.taintContainment().config) {
          record(c.command, c.source, null, false, `not run: untrusted content was read in this session and no sandbox can contain the check (${this.taintContainment().ask ?? 'no sandbox'})`, flush.unsaved, flush.decision);
          break;
        }
        let argv: string[] | undefined;
        if (cfg.shell.mode === 'allowlist') {
          try {
            argv = checkAllowlisted(c.command, cfg.shell.allowlist);
          } catch (e) {
            record(c.command, c.source, null, false, `not run: ${(e as Error).message}`, flush.unsaved, flush.decision);
            break;
          }
        }
        this.emit({ type: 'notice', level: 'info', message: `verification: running \`${c.command}\` (${c.source}; the harness runs it itself in a clean environment)` });
        const sandbox = containerSandboxFor(cfg, this.workspace);
        const res = await execCommand({ ...(argv ? { argv } : { shellCommand: c.command }), cwd: this.workspace, timeoutMs: coreSettings(this.config).checkTimeoutMs, env, signal: this.abortCtl?.signal, sandbox, wrap: commandWrapperFor(cfg) });
        if (this.abortCtl?.signal.aborted) return;
        const exitCode = res.timedOut ? null : res.exitCode;
        const unavailable = runnerUnavailable(exitCode, res.output);
        const zero = exitCode === 0 ? zeroTestsReported(res.output) : null;
        // the check may not have changed what it loaded while it ran (a writer the run left behind)
        const during = tamper();
        let trusted = true;
        let why = `${c.source} check, run by the harness in a clean environment`;
        if (during) [trusted, why] = [false, `files the check loads changed while it ran: ${during}`];
        else if (unavailable) [trusted, why] = [false, `it could not run: ${unavailable} (install the runner, or set agent.verifyCommands)`];
        else if (zero) [trusted, why] = [false, `it passed but ${zero}`];
        record(c.command, c.source, exitCode, trusted, why, flush.unsaved, flush.decision, res.output);
        this.emit({ type: 'notice', level: trusted && exitCode === 0 ? 'info' : 'warn', message: `verification: \`${c.command}\` ${res.timedOut ? 'timed out' : `exited ${exitCode}`}${trusted ? '' : ` (${why})`}` });
        // a failure decides; a runner that could not start does not stop the other checks from saying something
        if (during || (trusted && exitCode !== 0)) break;
      }
      this.saveState();
    } finally {
      fs.rmSync(pycache, { recursive: true, force: true });
      // removes the links, never what they point at
      fs.rmSync(checkHome, { recursive: true, force: true });
    }
  }

  /** R2: evidence for one command: trusted or not, and the versions of this run's changed files it saw. */
  private recordEvidence(command: string, exitCode: number | null, unsaved: string[], decision?: 'saved' | 'disk', output = '', job?: { startedAt: number; background: true }): void {
    const c = classifyCheck(command, { acceptance: [...(this.opts.acceptanceChecks ?? []), ...this.acceptanceChecks], verifyCommands: this.verifyCommands() });
    let { trusted, why } = c;
    // a passing check that ran no tests verifies nothing
    const zero = trusted && exitCode === 0 ? zeroTestsReported(output) : null;
    if (zero) [trusted, why] = [false, `${why}, but ${zero}`];
    // a check whose definition the agent changed in this run (conftest, scripts, runner config, existing tests) proves nothing
    if (trusted && this.checkDefs) {
      const d = definitionChanges(this.checkDefs, this.workspace);
      if (d.changed.length) [trusted, why] = [false, `${why}, but files that define the check changed in this run: ${d.changed.slice(0, 6).join(', ')}${d.changed.length > 6 ? ' …' : ''}`];
      else {
        const only = onlyNewTests(command, d.newTests);
        if (only) [trusted, why] = [false, `${why}, but it runs only test files written in this run (${only.join(', ')})`];
      }
    }
    if (job) why = `background job polled to completion: ${why}`;
    const files = this.evidenceFiles(unsaved);
    const ev: VerificationEvidence = { command, exitCode, ts: new Date().toISOString(), trusted, why, afterLastEdit: job ? job.startedAt >= this.lastEditAt : true, files, ...(unsaved.length ? { unsavedInEditor: unsaved } : {}), ...(decision ? { unsavedDecision: decision } : {}) };
    (this.stats.evidence ??= []).push(ev);
    this.sessionEvidence.push(ev);
    this.journal?.write({ type: 'evidence', evidence: ev });
    this.saveState();
  }

  // ------------------------------------------------------------ subagents

  /**
   * Run a subagent (depth 1). Concurrent calls are safe: each child has its own
   * agent, abort controller and stats, merged here when it finishes (D1).
   * `background` returns a handle at once (task_result collects it);
   * `isolation: "worktree"` runs the child in its own git worktree branch (D2).
   */
  async runSubagent(req: SubagentRequest): Promise<string> {
    if (req.background) {
      if (this.depth !== 0) throw new ToolError('background subagents are only available to the main agent');
      const handle = shortId('task_');
      return this.startBackground(handle, req);
    }
    return this.runSubagentNow(req);
  }

  /** D1 + N18: run a background subagent under `handle` (a new one, or a resumed one with its narrowed caps). */
  private startBackground(handle: string, req: SubagentRequest, resumed?: { spawned: SpawnedChild; prompt: string }): string {
    {
      const task: BackgroundTask = { handle, description: req.description, agentType: req.agentType, status: 'running', startedAt: Date.now(), promise: Promise.resolve('') };
      task.promise = this.runSubagentNow(req, (c) => (this.backgroundStops.set(handle, () => c.abort())), { handle, resumed }).then(
        (text) => {
          task.status = 'done';
          task.result = text;
          this.emit({ type: 'notice', level: 'info', message: `background subagent ${handle} (${req.description}) finished` });
          return text;
        },
        (e) => {
          task.status = 'failed';
          task.result = `subagent failed: ${(e as Error).message}`;
          return task.result;
        },
      );
      this.backgroundTasks.set(handle, task);
      return `${resumed ? 'Resumed' : 'Started'} background subagent ${handle} (${req.agentType}: ${req.description}). Continue with other work; call task_result {"handle":"${handle}"} to get its report.`;
    }
  }

  // ------------------------------------------------------------ v1.2 N18: resumable background subagents

  /** Where background children's state is kept: next to this session's journal (none without a journal). */
  private childStateDir(): string | undefined {
    return this.journal ? path.join(path.dirname(this.journal.file), `${this.sessionId}.children`) : undefined;
  }

  /**
   * Persist a background child (its narrowed caps, its conversation, how it ended). The file's hash goes into the
   * hash-chained journal, so a resume can tell that neither the journal nor the state was edited.
   */
  /** F5: the per-install key that authenticates saved child state (kept in the secrets vault, never in the session dir). */
  private async resumeKey(): Promise<string> {
    const { SecretVault } = await import('../secrets/vault.js');
    const v = new SecretVault(this.config.homeDir);
    const name = 'tugline-resume-key';
    try {
      return await v.resolve(name);
    } catch {
      const k = crypto.randomBytes(32).toString('hex');
      v.set(name, k);
      return k;
    }
  }

  private async saveBackgroundState(handle: string, req: SubagentRequest, granted: SpawnedChild['granted'], child: Agent, stopReason: string): Promise<void> {
    const dir = this.childStateDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const status = stopReason === 'end_turn' ? 'done' : stopReason === 'aborted' ? 'interrupted' : 'stopped';
      const body = JSON.stringify({ handle, agentType: req.agentType, description: req.description, prompt: req.prompt, isolation: req.isolation, granted, status, stopReason, messages: child.messages.filter((m) => m.role !== 'system'), savedAt: new Date().toISOString() });
      const file = path.join(dir, `${handle.replace(/[^\w-]/g, '_')}.json`);
      fs.writeFileSync(file, body, { mode: 0o600 });
      // F5: the record is authenticated with a key that is not in the session directory (an unkeyed chain can be re-forged)
      const mac = crypto.createHmac('sha256', await this.resumeKey()).update(`${this.sessionId}\n${handle}\n${body}`).digest('hex');
      this.journal?.write({ type: 'background_child', phase: 'saved', handle, status, stateSha: crypto.createHash('sha256').update(body).digest('hex'), mac });
    } catch (e) {
      this.log('warn', `background subagent ${handle}: state not saved: ${(e as Error).message}`);
    }
  }

  /** Background children of this session that can be resumed (interrupted or stopped, state saved). */
  resumableBackground(): { handle: string; description: string; status: string }[] {
    const f = this.journal?.file;
    if (!f || !fs.existsSync(f)) return [];
    const last = new Map<string, { handle: string; status: string }>();
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.includes('"background_child"')) continue;
      try {
        const r = JSON.parse(l);
        if (r.type === 'background_child' && r.phase === 'saved') last.set(r.handle, { handle: r.handle, status: r.status });
      } catch {
        /* torn line */
      }
    }
    const dir = this.childStateDir()!;
    return [...last.values()]
      .filter((x) => x.status !== 'done' && !this.backgroundTasks.get(x.handle)?.status.startsWith('running'))
      .map((x) => {
        let description = '';
        try {
          description = JSON.parse(fs.readFileSync(path.join(dir, `${x.handle.replace(/[^\w-]/g, '_')}.json`), 'utf8')).description;
        } catch {
          /* missing */
        }
        return { ...x, description };
      });
  }

  /**
   * v1.2 N18: resume a background subagent after a restart. Fails closed (typed `resume_refused`) unless the
   * session journal's hash chain verifies and the saved state is byte-identical to what the journal recorded.
   * The saved caps are a REQUEST: they are clamped again against this agent's current authority, so a parent
   * that shrank since (fewer tools, a stricter mode, less budget) resumes a child that is narrower too.
   */
  async resumeBackground(handle: string): Promise<string> {
    const refuse = (why: string): never => {
      this.journal?.write({ type: 'refusal', tool: 'task_resume', code: 'resume_refused', handle, reason: why });
      throw new ChildRefusal('resume_refused', why);
    };
    const jf = this.journal?.file;
    if (!jf || !fs.existsSync(jf)) refuse('this session has no journal, so nothing can be resumed');
    const broken = Journal.verify(jf!);
    if (broken) refuse(`the session journal's hash chain is broken at line ${broken}; a tampered history is never resumed`);
    let rec: { stateSha: string; status: string; mac?: string } | undefined;
    for (const l of fs.readFileSync(jf!, 'utf8').split('\n')) {
      if (!l.includes('"background_child"')) continue;
      try {
        const r = JSON.parse(l);
        if (r.type === 'background_child' && r.phase === 'saved' && r.handle === handle) rec = r;
      } catch {
        /* torn line */
      }
    }
    if (!rec) refuse(`no saved background subagent ${handle} in this session`);
    if (rec!.status === 'done') refuse(`background subagent ${handle} finished; collect its report with task_result instead`);
    if (this.backgroundTasks.get(handle)?.status === 'running') refuse(`background subagent ${handle} is running`);
    const file = path.join(this.childStateDir()!, `${handle.replace(/[^\w-]/g, '_')}.json`);
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      refuse(`the saved state of ${handle} is missing`);
    }
    if (crypto.createHash('sha256').update(body).digest('hex') !== rec!.stateSha) refuse(`the saved state of ${handle} differs from what the journal recorded (tampered); it is not resumed`);
    const mac = crypto.createHmac('sha256', await this.resumeKey()).update(`${this.sessionId}\n${handle}\n${body}`).digest('hex');
    if (typeof rec!.mac !== 'string' || rec!.mac.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(rec!.mac), Buffer.from(mac))) refuse(`the saved state of ${handle} is not authenticated by this installation's key (forged or from elsewhere); it is not resumed`);
    const st = JSON.parse(body) as { agentType: string; description: string; prompt: string; isolation?: 'worktree'; granted: SpawnedChild['granted']; messages: ChatMessage[] };
    const g = st.granted;
    // the saved caps are clamped again against what this agent may do NOW
    const spawned = await this.spawnChild({ agentType: st.agentType, description: st.description, label: `${st.agentType} (resumed ${handle})`, tools: g.tools, mode: g.mode, roots: g.roots, domains: g.domains, profile: g.profile, budget: g.budget, mcpServers: g.mcpServers, sandbox: g.sandbox, isolation: st.isolation });
    spawned.agent.loadHistory(st.messages);
    // F5: a history read back from disk is data the session did not see being written: the resumed child starts tainted
    spawned.agent.markTainted(`resumed background state ${handle} (read from disk)`);
    this.journal?.write({ type: 'background_child', phase: 'resumed', handle, clamps: spawned.clamps.map((c) => ({ field: c.field, reason: c.reason })), granted: spawned.granted });
    const req: SubagentRequest = { agentType: st.agentType, description: st.description, prompt: st.prompt, isolation: st.isolation, background: true };
    return this.startBackground(handle, req, { spawned, prompt: `[resumed after a restart] Continue the task where you stopped. The task was:\n${st.prompt}` });
  }

  /** v1.2 N18: how to stop each running background subagent (task_stop). */
  readonly backgroundStops = new Map<string, () => void>();

  private async runSubagentNow(req: SubagentRequest, onChild?: (child: Agent) => void, bg?: { handle: string; resumed?: { spawned: SpawnedChild; prompt: string } }): Promise<string> {
    const def = this.agentDefinitions.find((a) => a.name === req.agentType);
    const type = def ? 'custom' : ['explore', 'validator', 'general'].includes(req.agentType) ? req.agentType : 'general';
    if (req.isolation === 'worktree' && (type === 'explore' || type === 'validator')) throw new ToolError(`isolation "worktree" is for subagents that edit files; "${req.agentType}" is read-only`);
    const cap = { maxTokens: this.config.agent.subagentMaxTokens, maxCostUsd: this.config.agent.subagentMaxCostUsd };
    const spawned = bg?.resumed?.spawned ?? (await this.spawnChild({ agentType: req.agentType, description: req.description, isolation: req.isolation, fork: req.fork, budget: cap.maxTokens !== undefined || cap.maxCostUsd !== undefined ? cap : undefined }));
    const { agent: child, worktree: wt } = spawned;
    onChild?.(child);
    if (bg && !bg.resumed) this.journal?.write({ type: 'background_child', phase: 'start', handle: bg.handle, agentType: req.agentType, description: req.description, granted: spawned.granted });
    this.emit({ type: 'subagent', phase: 'start', agentType: req.agentType, description: req.description });
    await this.runExt('onSubagent', (e) => e.onSubagent!(this.api(), { phase: 'start', agentType: req.agentType, description: req.description }));
    let result: RunResult;
    const onAbort = () => child.abort();
    this.abortCtl?.signal.addEventListener('abort', onAbort, { once: true });
    try {
      result = await child.run(bg?.resumed?.prompt ?? req.prompt);
      // N18: a background child's state is saved however it ended (done, interrupted, stopped), for a resume
      if (bg) await this.saveBackgroundState(bg.handle, req, spawned.granted, child, result.stopReason);
    } catch (e) {
      if (wt) {
        await removeWorktree(wt).catch(() => undefined);
        this.worktrees.delete(wt);
      }
      throw e;
    } finally {
      this.abortCtl?.signal.removeEventListener('abort', onAbort);
      this.activeChildren.delete(child);
    }
    this.mergeChildStats(child, result);
    let text = stripScratchpad(result.finalText) || '(the subagent returned no text)';
    if (type === 'validator' && result.stats.commandsRun.length === 0) text = `UNVERIFIED (the validator ran no command, so this is not a pass):\n${text}`;
    if (result.stopReason !== 'end_turn') text += `\n\n[subagent stopped early: ${result.stopReason}]`;
    if (wt) text += await this.collectWorktree(wt, `${req.description} (Tugline ${req.agentType} subagent)`);
    this.emit({ type: 'subagent', phase: 'end', agentType: req.agentType, description: req.description, result: truncateLine(text, 300) });
    await this.runExt('onSubagent', (e) => e.onSubagent!(this.api(), { phase: 'end', agentType: req.agentType, description: req.description, result: text }));
    return text;
  }

  /** D2: commit a worktree child's changes on its branch and say how to merge them (the worktree directory is removed). */
  async collectWorktree(wt: Worktree, message: string): Promise<string> {
    try {
      const w = await finishWorktree(wt, message);
      return w.committed
        ? `\n\n[worktree] The subagent's changes are committed on branch ${w.branch} (your working tree is unchanged):\n${w.diffStat}\nMerge them with worktree_merge {"branch":"${w.branch}"}.`
        : `\n\n[worktree] The subagent made no file changes (branch ${w.branch} removed).`;
    } catch (e) {
      return `\n\n[worktree] could not collect the subagent's changes: ${(e as Error).message}`;
    } finally {
      this.worktrees.delete(wt);
    }
  }

  /**
   * v1.2 N18/N34/N35: create a child agent one level deeper, narrowed to this agent's authority (S2).
   * Refuses past `agent.maxDepth` (typed `depth_limit`). Whatever the spec asks for beyond this agent's
   * tools, mode, roots, domains, model profiles or remaining budget is clamped, and every clamp is
   * journaled and shown. The child inherits this agent's budget pools (plus its own cap and any shared
   * pool the caller passes), its taint (it starts tainted when this agent is) and reports its own taint
   * upward. `broaderThan` still runs on the created child as the fail-closed backstop (R13).
   */
  async spawnChild(spec: ChildSpec): Promise<SpawnedChild> {
    const limit = maxDepth(this.config);
    if (this.depth + 1 > limit) {
      const err = new ChildRefusal('depth_limit', `agent.maxDepth is ${limit} and this agent is already at depth ${this.depth}, so it cannot start another agent (${spec.agentType}: ${spec.description}). Do this part of the work yourself.`);
      this.journal?.write({ type: 'refusal', tool: 'spawn', code: err.code, reason: err.message, agentType: spec.agentType });
      this.emit({ type: 'refusal', tool: 'spawn', reason: err.message, args: { agentType: spec.agentType, description: spec.description } });
      throw err;
    }
    const def = this.agentDefinitions.find((a) => a.name === spec.agentType);
    const builtin = ['explore', 'validator', 'general'].includes(spec.agentType);
    const type = def ? 'custom' : builtin ? spec.agentType : 'general';
    // the tool set the type would get, then (N18) `task` for general/custom children so they can nest
    let base = spec.toolDefs ?? toolsForAgentType(this.shared.allTools, type, def?.tools);
    // (only where it can be used: a child at agent.maxDepth would only be refused)
    if (!spec.toolDefs && this.depth + 1 < limit && (type === 'general' || (type === 'custom' && !def?.tools)) && this.baseToolNames.includes('task')) {
      const task = this.shared.allTools.find((t) => t.name === 'task');
      if (task && !base.includes(task)) base = [...base, task];
    }
    // N34: a child running in plan mode can hand its plan to the human (exit_plan_mode; never to another agent)
    const planMode = (spec.mode ?? def?.meta?.permissionMode) === 'plan' || this.policy.mode === 'plan';
    if (!spec.toolDefs && planMode && this.baseToolNames.includes('exit_plan_mode')) {
      const ep = this.shared.allTools.find((t) => t.name === 'exit_plan_mode');
      if (ep && !base.includes(ep)) base = [...base, ep];
    }
    // N34 F12: a member whose persona (agent definition) lists its own tools still gets the team's coordination tools
    if (spec.member && !spec.toolDefs) {
      for (const n of MEMBER_TOOLS) {
        const t = this.shared.allTools.find((x) => x.name === n);
        if (t && !base.includes(t)) base = [...base, t];
      }
    }
    // N18: per-agent MCP servers: a subset of the parent's configured servers, never new ones
    const extraClamps: Clamp[] = [];
    const defMcp = metaValue(def?.meta?.mcpServers);
    if (defMcp && typeof defMcp === 'object' && !Array.isArray(defMcp)) extraClamps.push({ field: 'mcpServers', requested: Object.keys(defMcp), granted: [], reason: `agent definition ${def!.name} defines MCP server(s) ${Object.keys(defMcp).join(', ')}; a definition can only select the parent's configured servers, never add one` });
    const reqMcp = spec.mcpServers ?? (Array.isArray(defMcp) ? defMcp.map(String) : typeof defMcp === 'string' ? defMcp.split(',').map((x) => x.trim()).filter(Boolean) : defMcp && typeof defMcp === 'object' ? [] : undefined);
    let grantedMcp: string[] | undefined;
    if (reqMcp) {
      const avail = this.availableTools();
      const parentServers = new Set(avail.filter(isMcpTool).map((t) => t.mcpServer!).filter(Boolean));
      grantedMcp = reqMcp.filter((n) => parentServers.has(n));
      const extra = reqMcp.filter((n) => !parentServers.has(n));
      if (extra.length) extraClamps.push({ field: 'mcpServers', requested: reqMcp, granted: grantedMcp, reason: `MCP servers the parent has not configured were removed: ${extra.join(', ')}` });
      const keep = new Set(grantedMcp);
      base = [...base.filter((t) => !isMcpTool(t) || keep.has(t.mcpServer ?? '')), ...avail.filter((t) => isMcpTool(t) && keep.has(t.mcpServer ?? '') && !base.includes(t))];
    }
    const disallowed = def?.meta?.disallowedTools;
    const disallow = Array.isArray(disallowed) ? disallowed.map(String) : typeof disallowed === 'string' ? disallowed.split(',').map((x) => x.trim()) : [];
    if (disallow.length) base = base.filter((t) => !disallow.includes(t.name));
    const parentDomains = (() => {
      try {
        return sandboxConfig(this.config).allowDomains;
      } catch {
        return [];
      }
    })();
    const defMode = typeof def?.meta?.permissionMode === 'string' ? def.meta.permissionMode : undefined;
    const granted = clampChild(
      { tools: spec.tools ?? base.map((t) => t.name), mode: spec.mode ?? defMode, roots: spec.roots, domains: spec.domains, profile: spec.profile ?? def?.profile, budget: spec.budget },
      { tools: this.baseToolNames, mode: this.policy.mode, roots: [this.workspace, ...this.policy.opts.additionalDirectories], domains: parentDomains, profiles: Object.keys(this.config.profiles), remaining: this.remainingBudget() },
    );
    // a requested tool name the type's set does not have is not added either: the child gets (type set) ∩ (request) ∩ (parent)
    const names = new Set(granted.tools ?? base.map((t) => t.name));
    const tools = narrowTools(base.filter((t) => names.has(t.name)), this.baseToolNames);
    const label = spec.label ?? spec.agentType;
    granted.clamps.push(...extraClamps);
    for (const c of granted.clamps) {
      this.journal?.write({ type: 'clamp', child: label, agentType: spec.agentType, field: c.field, requested: c.requested, granted: c.granted, reason: c.reason });
      this.emit({ type: 'notice', level: 'warn', message: `${label}: ${c.reason} (S2: a child never gets more than its parent)` });
    }
    const role = spec.role ?? def?.systemPrompt ?? (type === 'explore' ? EXPLORE_ROLE : type === 'validator' ? VALIDATOR_ROLE : GENERAL_ROLE);
    const n = ++this.subSeq;
    let wt: Worktree | undefined;
    if (spec.isolation === 'worktree') {
      wt = await createWorktree(this.workspace, `${this.sessionId.replace(/[^A-Za-z0-9]/g, '').slice(-8)}-${n}-${shortId()}`);
      this.worktrees.add(wt);
    }
    const workspace = wt?.path ?? this.workspace;
    // own policy when it must differ (worktree root, a stricter mode, fewer roots, write restrictions)
    // F8: roots RESTRICT: a root inside the workspace limits where the child may write (writeOnly <root>/**); a root
    // outside it must be inside one of the parent's extra directories and becomes the child's only extra directory
    let rootWrites: string[] | undefined;
    let rootDirs: string[] | undefined;
    if (granted.roots) {
      const wsReal = fs.realpathSync(this.workspace);
      const inWs = granted.roots.filter((r) => realInsideWs(r, wsReal));
      rootDirs = granted.roots.filter((r) => !realInsideWs(r, wsReal));
      if (inWs.length && !inWs.includes(wsReal)) rootWrites = inWs.map((r) => `${path.relative(wsReal, r).split(path.sep).join('/')}/**`);
      // every requested root was clamped away: the child may write nowhere (never "anywhere")
      if (!inWs.length && !rootDirs.length) rootWrites = [];
    }
    const writeOnly = spec.writeOnly ?? rootWrites;
    const narrow = !!wt || (granted.mode !== undefined && granted.mode !== this.policy.mode) || granted.roots !== undefined || writeOnly !== undefined;
    const policy = narrow ? this.policyFor(workspace, { mode: granted.mode, roots: rootDirs ?? (granted.roots ? [] : undefined), writeOnly }) : this.shared.policy;
    // config: a child never runs longer, or reaches more domains, than its parent
    const defTurns = Number(def?.meta?.maxTurns);
    const turns = Math.min(this.config.agent.maxTurns, spec.maxTurns ?? Infinity, Number.isFinite(defTurns) && defTurns > 0 ? defTurns : Infinity);
    let config = this.config;
    // N18: per-agent hooks: a subset of the parent's (user, managed or approved project hooks), plus hooks
    // an agent definition defines inline only when the user wrote it (user scope) or the project hook is trusted
    const defHooks = metaValue(def?.meta?.hooks);
    const hookSel = spec.hooks ?? (Array.isArray(defHooks) ? (defHooks as unknown[]).filter((x) => typeof x === 'string').map(String) : undefined);
    const inlineHooks = defHooks && typeof defHooks === 'object' && !Array.isArray(defHooks) ? (defHooks as Record<string, unknown>) : undefined;
    let grantedHooks: string[] | undefined;
    const hookClamps: Clamp[] = [];
    if (hookSel || inlineHooks) {
      const parentHooks = this.config.hooks ?? {};
      const out: HarnessConfig['hooks'] = {};
      grantedHooks = [];
      for (const sel of hookSel ?? []) {
        const [ev, matcher] = sel.split(':');
        const list = (parentHooks[ev!] ?? []).filter((h) => matcher === undefined || (h.matcher ?? '') === matcher);
        if (!list.length) {
          hookClamps.push({ field: 'hooks', requested: sel, granted: undefined, reason: `hook "${sel}" is not one of the parent's hooks; a child never gets a hook its parent does not run` });
          continue;
        }
        out[ev!] = [...(out[ev!] ?? []), ...list.filter((h) => !(out[ev!] ?? []).includes(h))];
        grantedHooks.push(sel);
      }
      if (inlineHooks) {
        const userScope = !!def?.file && [path.join(os.homedir(), '.tugline'), path.join(os.homedir(), '.claude'), this.config.homeDir].some((d) => path.resolve(def.file!).startsWith(path.resolve(d) + path.sep));
        const { hookHash, isHookApproved } = await import('./hooks.js');
        for (const [ev, raw] of Object.entries(inlineHooks)) {
          for (const h of (Array.isArray(raw) ? raw : []) as { matcher?: string; command?: string }[]) {
            if (!h || typeof h.command !== 'string') continue;
            const hash = hookHash(ev, { matcher: h.matcher, command: h.command });
            const trusted = userScope || (this.config.trust?.workspaceTrusted === true && isHookApproved(this.config.homeDir, this.workspace, hash));
            if (!trusted) {
              hookClamps.push({ field: 'hooks', requested: { event: ev, matcher: h.matcher, command: h.command }, granted: undefined, reason: `the project agent definition ${def!.name} defines a ${ev} hook that is not approved (trust the workspace and approve the hook first); it was not added` });
              continue;
            }
            (out[ev] ??= []).push({ matcher: h.matcher, command: h.command });
            grantedHooks.push(`${ev}:${h.matcher ?? ''} (from ${userScope ? 'user' : 'approved project'} definition ${def!.name})`);
          }
        }
      }
      config = { ...config, hooks: out };
    }
    for (const c of hookClamps) {
      granted.clamps.push(c);
      this.journal?.write({ type: 'clamp', child: label, agentType: spec.agentType, field: c.field, requested: c.requested, granted: c.granted, reason: c.reason });
      this.emit({ type: 'notice', level: 'warn', message: `${label}: ${c.reason} (S2: a child never gets more than its parent)` });
    }
    if (turns !== this.config.agent.maxTurns) config = { ...config, agent: { ...config.agent, maxTurns: turns } };
    if (granted.domains) config = { ...config, sandbox: { ...(config.sandbox ?? {}), allowDomains: granted.domains, allowDomainsPreset: [] } };
    // N18: per-agent container backend: the child's commands run in the C2 docker runner with no network. The image
    // is the user's shell.dockerImage, or one listed in agent.containerImages (a project definition cannot pick any image).
    const wantContainer = spec.sandbox === 'container' || def?.meta?.executionBackend === 'container';
    if (wantContainer) {
      const asked = typeof def?.meta?.image === 'string' ? def.meta.image : undefined;
      const allowed = [config.shell.dockerImage, ...(config.agent.containerImages ?? [])];
      const image = asked && allowed.includes(asked) ? asked : config.shell.dockerImage;
      if (asked && image !== asked) {
        this.journal?.write({ type: 'clamp', child: label, agentType: spec.agentType, field: 'sandbox', requested: asked, granted: image, reason: `image ${asked} is not in agent.containerImages; the configured shell.dockerImage is used` });
        granted.clamps.push({ field: 'sandbox', requested: asked, granted: image, reason: `image ${asked} is not allowed` });
      }
      config = { ...config, shell: { ...config.shell, sandbox: 'docker', dockerImage: image, dockerNetwork: 'none' } };
    }
    const pool = granted.budget.maxTokens !== undefined || granted.budget.maxCostUsd !== undefined ? newBudgetPool(`${label} (per-child cap)`, granted.budget) : undefined;
    const parentUi = this.opts.ui;
    const badge = spec.approvalBadge;
    const child = await Agent.create({
      ...this.opts,
      config,
      workspace,
      shared: { ...this.shared, policy, depth: this.depth + 1 },
      host: wt ? diskHost : this.opts.host,
      agentType: spec.agentType,
      roleOverride: role,
      tools,
      journal: false,
      // ledger and admission count it under the root session (`<root>-sub-<n>`)
      sessionId: `${this.sessionId}-sub-${n}`,
      // G2/N18 SAC3: a child of a tainted parent starts tainted; a tainted child taints the parent
      initialTaint: this.taint?.source,
      onTaint: spec.isolateTaint ? (src) => this.journal?.write({ type: 'taint', source: `${label}: ${src}`, isolated: true }) : (src) => this.markTainted(`${spec.member ? 'teammate' : 'subagent'} ${label}: ${src}`),
      // WS18 (V0.1 finding): a child's extension records (prerequisite_blocked …) reach the parent's journal
      journalSink: (rec) => (this.journal ? this.journal.write({ ...rec, subagent: label } as any) : this.opts.journalSink?.({ ...rec, subagent: label })),
      extensions: [...(this.opts.extensions ?? []), ...(spec.extensions ?? [])],
      role: type === 'custom' || !builtin ? spec.agentType : type,
      budgetPools: [...this.budgetPools(), ...(spec.pools ?? []), ...(pool ? [pool] : [])],
      llm: granted.profile && this.config.profiles[granted.profile] ? new LLMClient(this.tuneProfile(granted.profile), this.log) : type === 'explore' ? this.llmFor('explore') : this.llm,
      ui: {
        onEvent: (e) => {
          spec.onEvent?.(e);
          if (e.type === 'tool_start') parentUi?.onEvent?.({ ...e, title: `[${label}] ${e.title}` });
          else if (e.type === 'tool_end' || e.type === 'refusal' || e.type === 'permission' || e.type === 'notice' || e.type === 'usage' || e.type === 'job') parentUi?.onEvent?.(e);
          this.journal?.write({ type: 'subagent_event', agentType: spec.agentType, child: label, event: e.type === 'text_delta' || e.type === 'reasoning_delta' ? undefined : e });
        },
        // approvals still come only from the human (S4); a teammate's request carries its name
        requestPermission: parentUi?.requestPermission && badge ? (r) => parentUi.requestPermission!({ ...r, title: `[${badge}] ${r.title}` }) : parentUi?.requestPermission,
        askUser: badge && parentUi?.askUser ? (q, o) => parentUi.askUser!(`[${badge}] ${q}`, o) : undefined,
        approvePlan: badge && parentUi?.approvePlan ? (p) => parentUi.approvePlan!(`[${badge}]\n${p}`) : undefined,
      },
    });
    if (!spec.member) this.activeChildren.add(child);
    // R13: fail closed if the child would have broader authority than this agent
    const broader = broaderThan(child.authority(), this.authority());
    if (broader.length) {
      this.activeChildren.delete(child);
      if (wt) {
        await removeWorktree(wt).catch(() => undefined);
        this.worktrees.delete(wt);
      }
      throw new ToolError(`refusing to start the ${spec.agentType} subagent: it would have broader authority than this agent (${broader.join('; ')})`);
    }
    if (spec.fork) child.loadHistory(dropOrphanToolMessages(this.messages.filter((m) => m.role !== 'system')));
    return { agent: child, worktree: wt, clamps: granted.clamps, pool, granted: { tools: tools.map((t) => t.name), mode: child.policy.mode, roots: granted.roots, domains: granted.domains, profile: granted.profile, budget: granted.budget, mcpServers: grantedMcp, hooks: grantedHooks, ...(wantContainer ? { sandbox: 'container' as const } : {}) } };
  }

  /**
   * v1.2 N34: merge a long-lived child's (teammate's) usage into this agent: the delta of its session totals
   * since `since` (so repeated runs are never counted twice), and its run stats while this agent is running.
   */
  absorbChild(child: Agent, result: RunResult | undefined, since: { promptTokens: number; completionTokens: number; costUsd: number; llmCalls: number }): void {
    const d = { promptTokens: child.totals.promptTokens - since.promptTokens, completionTokens: child.totals.completionTokens - since.completionTokens, costUsd: child.totals.costUsd - since.costUsd, llmCalls: child.totals.llmCalls - since.llmCalls };
    this.absorbUsage(d, result);
  }

  /** v1.2 N34: add usage made on this agent's behalf (a child, or an external agent metered at the proxy). */
  absorbUsage(d: { promptTokens: number; completionTokens: number; costUsd: number; llmCalls: number }, result?: RunResult): void {
    this.totals.promptTokens += d.promptTokens;
    this.totals.completionTokens += d.completionTokens;
    this.totals.costUsd += d.costUsd;
    this.totals.llmCalls += d.llmCalls;
    if (this.running) {
      this.stats.promptTokens += d.promptTokens;
      this.stats.completionTokens += d.completionTokens;
      this.stats.costUsd += d.costUsd;
      this.stats.llmCalls += d.llmCalls;
      if (result) {
        this.stats.toolCalls += result.stats.toolCalls;
        this.stats.toolErrors += result.stats.toolErrors;
        this.stats.refusals += result.stats.refusals;
      }
    }
  }

  /** Merge a finished one-shot child's stats and totals into this agent (D1; N18 workflow items). */
  mergeChildStats(child: Agent, result: RunResult): void {
    const s = this.stats;
    s.promptTokens += result.stats.promptTokens;
    s.completionTokens += result.stats.completionTokens;
    s.costUsd += result.stats.costUsd;
    s.llmCalls += result.stats.llmCalls;
    s.successfulLlmCalls += result.stats.successfulLlmCalls;
    s.toolCalls += result.stats.toolCalls;
    s.toolErrors += result.stats.toolErrors;
    s.refusals += result.stats.refusals;
    s.unparseableReplies += result.stats.unparseableReplies;
    this.totals.llmCalls += child.totals.llmCalls;
    this.totals.promptTokens += child.totals.promptTokens;
    this.totals.completionTokens += child.totals.completionTokens;
    this.totals.costUsd += child.totals.costUsd;
    // Worktree children changed files on their branch, not here: they do not count as edits in this tree.
    if (child.workspace === this.workspace) {
      s.filesChanged.push(...result.stats.filesChanged);
      if (result.stats.filesChanged.length) {
        this.lastEditSeq = ++this.seq;
        this.lastEditAt = Date.now();
        for (const c of s.commandsRun) c.afterLastEdit = false;
        for (const e of s.evidence ?? []) e.afterLastEdit = false;
      }
      s.commandsRun.push(...result.stats.commandsRun);
      (s.evidence ??= []).push(...(result.stats.evidence ?? []));
    }
  }

  /** A permission policy like this agent's but rooted at another workspace (worktree children). */
  private policyFor(workspace: string, narrow: { mode?: PermissionMode; roots?: string[]; writeOnly?: string[] } = {}): PermissionPolicy {
    const o = this.policy.opts;
    // N18: roots and write globs only ever narrow (clampChild already removed anything outside the parent's)
    const writeOnly = narrow.writeOnly ? (o.writeOnly ? narrow.writeOnly.filter((g) => o.writeOnly!.includes(g)) : [...narrow.writeOnly]) : o.writeOnly ? [...o.writeOnly] : undefined;
    const p = new PermissionPolicy({ ...o, workspace, allow: [...o.allow], deny: [...o.deny], ask: [...(o.ask ?? [])], protectedPaths: [...o.protectedPaths], additionalDirectories: narrow.roots ? [...narrow.roots] : [...o.additionalDirectories], writeOnly });
    // R13: the child follows the parent's mode (a parent switched to plan mid-run narrows its running children too)
    const parent = this.policy;
    // and can narrow itself, never widen past the parent.
    // N43: modes are a partial order (modeWithin): never broader, never sideways (auto ⟂ acceptEdits)
    let own: PermissionMode | undefined = narrow.mode && narrow.mode !== parent.mode && modeWithin(narrow.mode, parent.mode) ? narrow.mode : undefined;
    Object.defineProperty(p.opts, 'mode', { get: () => (own && own !== parent.mode && modeWithin(own, parent.mode) ? own : parent.mode), set: (m: PermissionMode) => (own = m), enumerable: true });
    return p;
  }

  /**
   * Undo the agent's most recent file change (or the last `count`). Refuses to
   * clobber a file that was changed again outside the agent since.
   */
  undo(count = 1): { restored: string[]; skipped: string[] } {
    const restored: string[] = [];
    const skipped: string[] = [];
    for (let i = 0; i < count && this.editHistory.length; i++) {
      const e = this.editHistory.pop()!;
      const current = fs.existsSync(e.path) ? fs.readFileSync(e.path, 'utf8') : null;
      if (current !== e.after) {
        skipped.push(`${path.relative(this.workspace, e.path)} (changed since the agent's edit)`);
        continue;
      }
      if (e.before === null) fs.rmSync(e.path, { force: true });
      else fs.writeFileSync(e.path, e.before, 'utf8');
      this.ledger.forget(e.path);
      restored.push(path.relative(this.workspace, e.path));
    }
    if (restored.length) this.emit({ type: 'notice', level: 'info', message: `undid agent edits: ${restored.join(', ')}` });
    return { restored, skipped };
  }

  async dispose(): Promise<void> {
    if (this.depth === 0) await this.admitted(() => this.autoMemory(), 'summarizer').catch((e) => this.log('warn', `auto-memory failed: ${(e as Error).message}`));
    if (this.sessionStarted) await this.runExt('onSessionEnd', (e) => e.onSessionEnd!(this.api()));
    for (const c of this.activeChildren) c.abort();
    // N18: interrupted background children save their state before the session closes (bounded wait)
    const running = [...this.backgroundTasks.values()].filter((t) => t.status === 'running').map((t) => t.promise);
    if (running.length) await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, 5000).unref?.())]);
    for (const wt of this.worktrees) await removeWorktree(wt).catch(() => undefined);
    this.worktrees.clear();
    if (this.depth === 0) {
      // D5: background jobs end with the session unless started with persist:true.
      const killed = await killSessionJobs(this.sessionId);
      if (killed.length) this.log('info', `stopped background job(s): ${killed.join(', ')}`);
      resetSessionCwd(this.sessionId);
      await this.shared.mcp?.close();
    }
  }

  /**
   * D6 auto-memory (agent.autoMemory, off by default): a small model proposes
   * at most 3 durable memories from the session; each is written only if the
   * user approves it. Without a UI to ask, nothing is written.
   */
  private async autoMemory(): Promise<void> {
    if (!coreSettings(this.config).autoMemory || !this.messages.some((m) => m.role === 'user')) return;
    const ask = this.opts.ui?.askUser;
    if (!ask) return;
    const proposals = await proposeMemories(this.llmFor('summarizer'), this.messages);
    for (const p of proposals) {
      const answer = await ask(`Remember this for future sessions in this project?\n[${p.kind}] ${p.key}: ${p.text}`, ['yes', 'no']);
      if (!/^y/i.test(String(answer).trim())) continue;
      const r = addMemory(memoryFile('project', this.workspace, this.config.homeDir), p);
      this.emit({ type: 'notice', level: 'info', message: `remembered: ${r.line}` });
    }
  }
}

/** Convenience: bundled resource directories next to the compiled package. */
export function bundledDirs(fromFile: string): { skills?: string; agents?: string } {
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'skills')) && fs.existsSync(path.join(dir, 'package.json'))) return { skills: path.join(dir, 'skills'), agents: fs.existsSync(path.join(dir, 'agents')) ? path.join(dir, 'agents') : undefined };
    dir = path.dirname(dir);
  }
  return {};
}

/** v1.2 N18 (ported idea, Qwen subagent-result): a child's scratchpad / thinking tags stay out of the parent's context. */
export function stripScratchpad(text: string): string {
  return String(text ?? '')
    .replace(/<(scratchpad|think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(scratchpad|think|thinking)>[\s\S]*$/i, '')
    .trim();
}

/** v1.2 N18: an agent-definition frontmatter value; maps are written as inline JSON (`hooks: {"PreToolUse": [...]}`). */
function metaValue(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v === '' ? undefined : v;
  try {
    return JSON.parse(t);
  } catch {
    return { '(unreadable)': t };
  }
}

/** F8: is `p` (a real path) inside the workspace (a real path)? */
function realInsideWs(p: string, ws: string): boolean {
  const rel = path.relative(ws, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
