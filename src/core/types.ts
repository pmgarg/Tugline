/**
 * Canonical types shared by every part of the harness.
 *
 * The transcript is always stored in OpenAI chat-completions shape (the de-facto
 * standard that vLLM, Ollama, LM Studio, llama.cpp, TGI, LiteLLM, OpenRouter and
 * most company gateways speak). Provider "dialects" (e.g. models with no native
 * tool calling) are rendered from this canonical form at the edge, inside the
 * LLM client — never stored.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** Assistant reasoning, sent back only for models whose template expects it (interleaved thinking: GLM, Kimi, MiniMax). */
  reasoning_content?: string;
  /** Harness-only metadata; stripped before sending. */
  _meta?: { compactedSummary?: boolean; cleared?: boolean; synthetic?: boolean; ts?: number };
}

export type JSONSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  /** true when the server did not report usage and we estimated it */
  estimated?: boolean;
  cachedTokens?: number;
}

export type ToolMode = 'native' | 'text' | 'auto';

/** A model endpoint profile: everything needed to reach one LLM. */
/** Extra profile keys added by workstreams (editFormat, reasoning, capabilities …), SPEC S0.4. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ModelProfileExtensions {}

export interface ModelProfile extends ModelProfileExtensions {
  /** Display name for the profile, e.g. "company-llm" */
  name: string;
  /** OpenAI-compatible base URL, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Context window in tokens (used for compaction). */
  contextWindow: number;
  /** Max tokens to generate per call. */
  maxOutputTokens: number;
  /** native = OpenAI tools API, text = tool calls in text (XML/JSON), auto = detect */
  toolMode: ToolMode;
  /** Model accepts image inputs. */
  vision: boolean;
  temperature?: number;
  /** USD per 1M tokens, for metering. */
  pricing?: { inputPerM: number; outputPerM: number };
  /** Extra headers (e.g. company gateway auth). */
  headers?: Record<string, string>;
  /** Extra body params merged into each request (e.g. {"top_k":20}). */
  extraBody?: Record<string, unknown>;
  /** Request timeout ms. */
  timeoutMs?: number;
}

/**
 * N43: `auto` = the classifier mode (prefilter floor, fast paths, two-stage classifier, denial tracking);
 * `yolo` = the old classifier-less `auto` (commands run without asking, except dangerous ones).
 */
export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'auto' | 'yolo';

export type ToolKind = 'read' | 'edit' | 'execute' | 'network' | 'meta' | 'mcp';

export interface PermissionRequest {
  id: string;
  tool: string;
  kind: ToolKind;
  /** Human readable one-liner: "Run: npm test" */
  title: string;
  /** Extra detail such as a diff or the full command */
  detail?: string;
  /** For edits: a diff preview */
  diff?: { path: string; before: string; after: string };
  /** Suggested rule if the user chooses "always allow" */
  suggestedRule?: string;
  reason?: string;
}

export type PermissionAnswer =
  | { decision: 'allow'; always?: boolean }
  | { decision: 'deny'; feedback?: string };

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type StopReason =
  | 'end_turn'
  | 'max_turns'
  | 'aborted'
  | 'thrashing'
  /** a prerequisite the task needs (a secret, a deployment value) is missing; the agent stopped and said what */
  | 'blocked'
  | 'budget'
  | 'error'
  | 'llm_unavailable';

/** Everything the agent emits. UIs (CLI, VS Code, eval runner) subscribe to these. */
export type AgentEvent =
  | { type: 'run_start'; runId: string; prompt: string; model: string }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'assistant_message'; text: string; toolCalls: { id: string; name: string; args: unknown }[] }
  | { type: 'tool_start'; id: string; name: string; args: unknown; title: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; output: string; durationMs: number; meta?: Record<string, unknown> }
  | { type: 'permission'; request: PermissionRequest; answer: PermissionAnswer; auto: boolean }
  | { type: 'refusal'; tool: string; reason: string; args: unknown }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'usage'; usage: Usage; costUsd: number; latencyMs: number; model: string; /** D10: main | planner | explore | summarizer | approver | editor | <subagent type> */ role?: string }
  | { type: 'compaction'; beforeTokens: number; afterTokens: number; strategy: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'subagent'; phase: 'start' | 'end'; agentType: string; description: string; result?: string }
  | { type: 'run_end'; stopReason: StopReason; finalText: string; stats: RunStats; /** v1.1 R2: verified | failed | unverified | not_applicable */ completion?: CompletionStatus }
  // ---- v1.0 (SPEC S0.5). UIs must ignore event types they do not know.
  | { type: 'checkpoint'; id: string; label: string; turn?: number; messageIndex?: number; files?: number }
  | { type: 'steer'; text: string; queued: boolean }
  | { type: 'job'; jobId: string; phase: 'start' | 'output' | 'end'; command?: string; exitCode?: number | null; text?: string }
  | { type: 'automation'; surface: 'browser' | 'desktop'; tool: string; path?: string; outcome?: string; errorCode?: string; detail?: string }
  | { type: 'diff_pending'; path: string; added: number; removed: number; hunks?: number }
  | { type: 'approval_auto'; tool: string; decision: 'allow' | 'ask' | 'deny'; by: string; category?: string; reason?: string; /** N43: which pipeline step decided, and how long each classifier stage took */ stage?: string; latencyMs?: number; stages?: { stage: 1 | 2; verdict: string; ms: number }[] }
  // ---- v1.1 N10 (WS10): the cacheable prompt prefix changed since the previous call, so the server re-reads it.
  | { type: 'cache_break'; turn: number; scope: ('model' | 'system' | 'tools' | 'history')[]; causes: string[]; detail: string; /** estimated prompt tokens after the break point (re-processed) */ invalidatedTokens: number }
  // ---- v1.2 WS17: workflows (N18), agent teams (N34), goals with an independent verifier (N35)
  | { type: 'workflow'; runId: string; name: string; phase: 'start' | 'item' | 'reduce' | 'end'; index?: number; status?: string; attempt?: number; detail?: string; counts?: { done: number; failed: number; total: number } }
  | { type: 'team'; teamId: string; name: string; phase: 'created' | 'member' | 'task' | 'message' | 'disbanded'; member?: { name: string; role?: string; status: string; model?: string; worktree?: string; color?: string }; task?: { id: string; title: string; status: string; owner?: string; deps?: string[] }; message?: { from: string; to: string; text: string; tainted?: boolean }; summary?: string }
  | { type: 'goal'; phase: 'start' | 'iteration' | 'verdict' | 'end'; condition: string; iteration?: number; status?: string; /** "verified" (harness-run check) | "judged met (independent verifier)" | "not met" */ label?: string; reasons?: string[] };

export interface RunStats {
  turns: number;
  llmCalls: number;
  successfulLlmCalls: number;
  unparseableReplies: number;
  toolCalls: number;
  toolErrors: number;
  refusals: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
  filesChanged: string[];
  commandsRun: { command: string; exitCode: number | null; afterLastEdit: boolean }[];
  /** v1.1 R2: what each command checked (trusted or not, file versions, editor/disk divergence) */
  evidence?: VerificationEvidence[];
}

// ---- v1.1 R2: completion is separate from the stop reason (why the loop ended).
export type CompletionState = 'verified' | 'failed' | 'unverified' | 'not_applicable';

export interface EvidenceFile {
  /** workspace-relative path */
  path: string;
  /** sha256 (16 hex) of the disk content when the check ran; "missing" if deleted */
  version: string;
  /** the editor held unsaved changes in this file that the command did not see (R8) */
  diskOnly?: boolean;
}

export interface VerificationEvidence {
  command: string;
  exitCode: number | null;
  ts: string;
  /** a trusted check: acceptance command, configured verify command, or a known test/build/lint runner */
  trusted: boolean;
  why: string;
  /** no edit happened after it (in this run) */
  afterLastEdit: boolean;
  /** files changed in this run and their versions when the command ran */
  files: EvidenceFile[];
  /** R8: documents with unsaved editor changes that the command did not see (it ran against the disk version) */
  unsavedInEditor?: string[];
  /** R8: the explicit decision for documents the user had unsaved: saved first, or ran against the disk version */
  unsavedDecision?: 'saved' | 'disk';
  /** batch 4: the harness ran this check itself (fixed at run start, clean environment); only these decide verified/failed */
  byHarness?: boolean;
  /** batch 4: harness checks run together share an id; the latest group decides */
  checkId?: string;
  /** batch 4: where the harness check came from: acceptance, verifyCommands, AGENTS.md or detected */
  source?: string;
  /** batch 4: the last part of a harness check's output */
  outputTail?: string;
}

export interface CompletionStatus {
  state: CompletionState;
  /** one line for UIs and journals */
  summary: string;
  /** the trusted check that decided verified/failed */
  check?: { command: string; exitCode: number | null; ts: string };
  /** the final answer said it could not be verified (the explicit unverified exit) */
  declaredUnverifiable?: boolean;
  claimedSuccess?: boolean;
}
