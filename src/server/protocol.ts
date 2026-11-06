/**
 * Tugline server protocol (SPEC G2), JSON-RPC 2.0 over WebSocket or stdio.
 *
 * Connection: the first WebSocket message must be `auth {token}`; anything else
 * (or a wrong token) gets error -32001 and the socket is closed. Stdio needs no
 * token: the pipe belongs to the process that started the server.
 *
 * Client → server requests
 *   auth {token}                                   → {ok}
 *   initialize {client?}                           → {server, version, protocol, capabilities}
 *   session/create {workspace?, mode?, profile?}   → SessionInfo (subscribes the caller)
 *   session/list {workspace?}                      → {live: SessionInfo[], saved: SavedSession[]}
 *   session/load {sessionId, workspace?}           → SessionInfo (resumes a saved journal)
 *   session/delete {sessionId, purge?}             → {deleted}
 *   session/subscribe|unsubscribe {sessionId}      → {ok}
 *   session/prompt {sessionId, text}               → RunSummary (events stream meanwhile)
 *   session/steer|enqueue {sessionId, text}        → {queued}
 *   session/abort {sessionId}                      → {aborted}
 *   session/permissionReply {sessionId, requestId, decision, always?, feedback?}
 *   session/askReply {sessionId, requestId, answer}
 *   session/planReply {sessionId, requestId, approved}
 *   session/elicitReply {sessionId, requestId, action, content?}
 *   session/command {sessionId, name, args?}       → {output, prompt?}
 *   config/get {sessionId?}                        → redacted config
 *   config/set {sessionId, key, value}             → {ok} (permissionMode | profile | outputStyle)
 *   checkpoints/list {sessionId}                   → {checkpoints}
 *   checkpoints/restore {sessionId, id, scope?}    → restore outcome
 *   jobs/list {sessionId}                          → {jobs}
 *   remote/run {repo, branch?, prompt, mode?}      → RemoteResult (H5; off unless enabled)
 *
 * Server → client notifications
 *   session/event {sessionId, event}                       every AgentEvent
 *   session/permission {sessionId, requestId, request}     answer with session/permissionReply
 *   session/ask {sessionId, requestId, question, options?} answer with session/askReply
 *   session/plan {sessionId, requestId, plan}              answer with session/planReply
 *   session/elicit {sessionId, requestId, request}         answer with session/elicitReply
 *
 * A request for user input that no attached client answers (none attached,
 * client gone, timeout) is denied and recorded: never allowed by default.
 */
import type { AgentEvent, PermissionMode, PermissionRequest, RunStats, StopReason } from '../core/types.js';

export const PROTOCOL_VERSION = 1;

export interface SessionInfo {
  sessionId: string;
  workspace: string;
  model: string;
  mode: PermissionMode;
  running: boolean;
  createdAt: string;
  journal?: string;
}

export interface SavedSession {
  sessionId: string;
  mtime: string;
  firstPrompt: string;
}

export interface RunSummary {
  runId: string;
  stopReason: StopReason;
  finalText: string;
  stats: RunStats;
}

export interface SessionEventParams {
  sessionId: string;
  event: AgentEvent;
}

export interface PermissionParams {
  sessionId: string;
  requestId: string;
  request: PermissionRequest;
}

export interface RemoteRunParams {
  repo: string;
  branch?: string;
  prompt: string;
  mode?: PermissionMode;
  profile?: string;
  /** Keep the server-side clone after the run (default false). */
  keep?: boolean;
}

export interface RemoteResult extends RunSummary {
  sessionId: string;
  repo: string;
  branch?: string;
  /** Commit the patch applies to. */
  base: string;
  /** `git diff --binary` of every change the run made (empty when nothing changed). */
  patch: string;
  /** `git diff --stat`. */
  stat: string;
  files: string[];
}

export const SAFE_CONFIG_KEYS = ['permissionMode', 'profile', 'outputStyle'] as const;
