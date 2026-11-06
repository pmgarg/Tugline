/**
 * Agent extension points (SPEC S0.3). Features that hook into the loop
 * (checkpoints, classifier approver, steering, post-edit feedback, background
 * jobs) register here instead of editing agent.ts.
 *
 * Ordering: extensions run in registration order. Errors are caught and
 * reported as notices; an extension never breaks the loop.
 * Authority: `approve` is consulted ONLY for decisions the policy engine left
 * as 'ask'. Hard denies (protected paths, dangerous commands, deny rules,
 * managed policy) never reach an extension.
 */
import type { AgentEvent, ChatMessage, PermissionMode, RunStats, StopReason } from '../types.js';
import type { HarnessConfig } from '../config.js';
import type { LLMClient } from '../llm/client.js';
import type { CheckInput } from '../permissions/policy.js';
import type { WorkspaceHost } from '../host/workspace.js';

export interface AgentApi {
  readonly sessionId: string;
  readonly runId: string | undefined;
  readonly workspace: string;
  readonly config: HarnessConfig;
  readonly depth: number;
  readonly mode: PermissionMode;
  readonly host: WorkspaceHost;
  readonly llm: LLMClient;
  readonly smallLlm: LLMClient;
  /** Live message array (read; mutate only via the agent's public methods). */
  readonly messages: ChatMessage[];
  readonly stats: RunStats;
  readonly signal: AbortSignal | undefined;
  emit(e: AgentEvent): void;
  notice(level: 'info' | 'warn' | 'error', message: string): void;
  /** Write a record to the session journal. */
  journal(rec: Record<string, unknown>): void;
  /** The agent object itself, for extensions that need more (typed loosely on purpose). */
  readonly agent: unknown;
}

export interface ApprovalQuery {
  tool: string;
  input: CheckInput;
  args: unknown;
  title: string;
  reason: string;
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  args: unknown;
  ok: boolean;
  output: string;
  meta: Record<string, unknown>;
  durationMs: number;
}

export interface RunEndInfo {
  runId: string;
  stopReason: StopReason;
  finalText: string;
  stats: RunStats;
}

export interface TurnGate {
  stop: StopReason;
  message: string;
}

export type AfterToolResult = string | { text: string; isError?: boolean };

export type ApprovalDecision = { decision: 'allow' | 'ask' | 'deny'; reason?: string; by?: string };

export interface AgentExtension {
  id: string;
  /** Only run for these depths (default: all). */
  depths?: number[];
  /** Once per agent session, before the first run starts (SessionStart). */
  onSessionStart?(a: AgentApi): Promise<void> | void;
  /** When the agent is disposed (SessionEnd). */
  onSessionEnd?(a: AgentApi): Promise<void> | void;
  onRunStart?(a: AgentApi, prompt: string): Promise<void> | void;
  /** Before each LLM call. Steering intake, checkpoints, budget admission. Return {stop} to end the run. */
  beforeTurn?(a: AgentApi, turn: number): Promise<TurnGate | void> | TurnGate | void;
  /** Synchronous observer of every agent event (usage ledgers, telemetry). Must be cheap. */
  onEvent?(a: AgentApi, e: AgentEvent): void;
  /** Before the history is compacted (PreCompact hooks). */
  beforeCompact?(a: AgentApi, info: { force: boolean; tokens: number }): Promise<void> | void;
  /** When a subagent starts or ends (SubagentStart/Stop hooks). */
  onSubagent?(a: AgentApi, info: { phase: 'start' | 'end'; agentType: string; description: string; result?: string }): Promise<void> | void;
  /** N43: the permission mode changed (/mode, VS Code picker, SDK, managed policy). */
  onModeChange?(a: AgentApi, from: PermissionMode, to: PermissionMode): Promise<void> | void;
  /**
   * Consulted for policy 'ask' decisions only. Return undefined to abstain. 'allow' settles the call, 'deny'
   * refuses it (any deny wins), and 'ask' is a floor (N43): the human decides, whatever another extension says.
   */
  approve?(a: AgentApi, q: ApprovalQuery): Promise<ApprovalDecision | undefined> | ApprovalDecision | undefined;
  /**
   * After a tool ran. Returned text is appended to the tool result the model sees;
   * `{ text, isError: true }` also marks the result as an error (R1: a shell command
   * that changed protected files and was undone).
   */
  afterTool?(a: AgentApi, call: ToolCallRecord): Promise<AfterToolResult | void> | AfterToolResult | void;
  /** Before a shell command executes (after approval). */
  beforeShell?(a: AgentApi, command: string): Promise<void> | void;
  onRunEnd?(a: AgentApi, info: RunEndInfo): Promise<void> | void;
}

const registry: AgentExtension[] = [];

export function registerAgentExtension(e: AgentExtension): void {
  const i = registry.findIndex((x) => x.id === e.id);
  if (i >= 0) registry[i] = e;
  else registry.push(e);
}

export function unregisterAgentExtension(id: string): void {
  const i = registry.findIndex((x) => x.id === id);
  if (i >= 0) registry.splice(i, 1);
}

export function globalExtensions(): AgentExtension[] {
  return [...registry];
}
