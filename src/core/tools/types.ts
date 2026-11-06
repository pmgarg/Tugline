import type { AgentEvent, JSONSchema, PermissionMode, TodoItem, ToolKind } from '../types.js';
import type { HarnessConfig } from '../config.js';
import type { LLMClient } from '../llm/client.js';
import type { CheckInput, PermissionPolicy } from '../permissions/policy.js';
import type { SkillManager } from '../skills/manager.js';
import type { WorkspaceHost } from '../host/workspace.js';

export interface ToolOutput {
  output: string;
  isError?: boolean;
  /** Images to show the model (only sent if the profile has vision) */
  images?: { mimeType: string; base64: string }[];
  meta?: Record<string, unknown>;
}

export class ToolError extends Error {}

/** What this run has read: the precondition for editing (EAG S17 "read before edit"). */
export class ReadLedger {
  private seen = new Map<string, number>();
  record(abs: string, mtimeMs: number): void {
    this.seen.set(abs, mtimeMs);
  }
  has(abs: string): boolean {
    return this.seen.has(abs);
  }
  mtime(abs: string): number | undefined {
    return this.seen.get(abs);
  }
  forget(abs: string): void {
    this.seen.delete(abs);
  }
  list(): string[] {
    return [...this.seen.keys()];
  }
}

export interface SubagentRequest {
  agentType: string;
  description: string;
  prompt: string;
  /** D2: run the child in a fresh git worktree on branch oh/<id> */
  isolation?: 'worktree';
  /** D1: return a handle immediately; fetch the report later with task_result */
  background?: boolean;
  /** v1.2 N18: start from a copy of the parent's conversation (forked subagent) */
  fork?: boolean;
}

export interface ToolContext {
  workspace: string;
  config: HarnessConfig;
  ledger: ReadLedger;
  signal: AbortSignal;
  llm: LLMClient;
  smallLlm: LLMClient;
  policy: PermissionPolicy;
  skills: SkillManager;
  emit: (e: AgentEvent) => void;
  todos: TodoItem[];
  setTodos: (t: TodoItem[]) => void;
  runSubagent?: (req: SubagentRequest) => Promise<string>;
  askUser?: (question: string, options?: string[]) => Promise<string>;
  setMode: (m: PermissionMode) => void;
  /** Request a plan approval from the user (plan mode) */
  approvePlan?: (plan: string) => Promise<boolean>;
  vision: boolean;
  /** Directory for harness artefacts (screenshots etc.) */
  artifactsDir: string;
  /** Where file tools read and write (SPEC S0.1). DiskHost for CLI/eval, buffer host in VS Code. */
  host: WorkspaceHost;
  sessionId: string;
  /** Agent depth: 0 = main, 1 = subagent */
  depth: number;
  /** v1.2 WS24 (review F9): where untrusted content entered this session, if it has (Rule of Two) */
  taint?: string;
}

export interface ToolDef<A = any> {
  name: string;
  description: string;
  parameters: JSONSchema;
  kind: ToolKind;
  /** Safe to run concurrently with other read-only tools */
  readOnly?: boolean;
  /** Keep this tool loaded even when tool search defers the rest (SPEC D3). Use for a provider's few essential tools. */
  core?: boolean;
  /** Inputs for the permission engine derived from args. */
  permissionInput?: (args: A, ctx: ToolContext) => Omit<CheckInput, 'tool' | 'kind'>;
  /** One-line human label: "Read src/app.ts" */
  title: (args: A) => string;
  /** Cheap precondition check run BEFORE asking the user (throw ToolError to reject without prompting). */
  validate?: (args: A, ctx: ToolContext) => void;
  /** Diff preview for approval UIs */
  preview?: (args: A, ctx: ToolContext) => Promise<{ path: string; before: string; after: string } | undefined>;
  run: (args: A, ctx: ToolContext) => Promise<ToolOutput>;
  /** MCP server name, when this tool is a proxy */
  mcpServer?: string;
}
