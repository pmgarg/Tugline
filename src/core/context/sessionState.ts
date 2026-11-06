/**
 * Durable session state (v1.1 R14): the store behind R2 (evidence) and R5 (task brief).
 *
 * The message history is lossy (compaction summarises it, truncation cuts it), so
 * what the session must never forget lives here instead:
 *   - requests and constraints: the task brief entries (original request, follow-ups,
 *     steers, corrections), verbatim;
 *   - tasks: the agent's todo list;
 *   - evidence: every command's verification record (R2) across runs, and each run's
 *     completion status.
 * It is one JSON file next to the session's journal
 * (`<home>/sessions/<project>/<session>.state.json`, 0600), written atomically
 * (temp file + rename) on every change, so it survives restarts and crashes. Every
 * surface (CLI, VS Code, ACP, server, schedules) builds on Agent, so they share it:
 *   - an Agent created with an existing session id adopts that session's state;
 *   - `Journal.loadMessages(file)` attaches the state stored next to that journal, and
 *     `agent.loadHistory()` adopts it (a resumed session gets a new id and its own state
 *     file, with `resumedFrom` recording the chain).
 * The journal stays the audit record; this file is the working state. If the file is
 * missing or unreadable, the state is rebuilt from the journal's records.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BriefEntry } from './brief.js';
import type { TodoItem, VerificationEvidence, CompletionStatus } from '../types.js';

export const STATE_VERSION = 1;
const MAX_EVIDENCE = 300;
const MAX_COMPLETIONS = 100;

export interface RunCompletion {
  runId: string;
  ts: string;
  state: CompletionStatus['state'];
  summary: string;
}

export interface SessionState {
  version: number;
  sessionId: string;
  workspace: string;
  /** session ids this one was resumed from, oldest first */
  resumedFrom: string[];
  updatedAt: string;
  /** requests and constraints, verbatim (the R5 task brief) */
  requests: BriefEntry[];
  tasks: TodoItem[];
  /** R2 evidence across runs (newest last, capped) */
  evidence: VerificationEvidence[];
  completions: RunCompletion[];
}

export function emptyState(sessionId: string, workspace: string): SessionState {
  return { version: STATE_VERSION, sessionId, workspace, resumedFrom: [], updatedAt: new Date().toISOString(), requests: [], tasks: [], evidence: [], completions: [] };
}

/** The state file that belongs to a journal file. */
export function stateFileFor(journalFile: string): string {
  return journalFile.replace(/\.jsonl$/, '') + '.state.json';
}

/** Read a state file; undefined when missing, unreadable or not a state file (callers rebuild from the journal). */
export function readState(file: string): SessionState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionState;
    if (!s || s.version !== STATE_VERSION || !Array.isArray(s.requests) || !Array.isArray(s.evidence)) return undefined;
    return { ...emptyState(s.sessionId, s.workspace), ...s };
  } catch {
    return undefined;
  }
}

/** Write atomically (temp file + rename): a crash leaves the old or the new state, never a torn file. */
export function writeState(file: string, s: SessionState): void {
  const out: SessionState = { ...s, updatedAt: new Date().toISOString(), evidence: s.evidence.slice(-MAX_EVIDENCE), completions: s.completions.slice(-MAX_COMPLETIONS) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Rebuild what the journal records hold (task_brief, evidence, todos events, run_end completions). */
export function stateFromJournal(journalFile: string, sessionId: string, workspace: string): SessionState {
  const s = emptyState(sessionId, workspace);
  let raw = '';
  try {
    raw = fs.readFileSync(journalFile, 'utf8');
  } catch {
    return s;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.type === 'task_brief' && r.entry?.text) s.requests.push(r.entry);
      else if (r.type === 'evidence' && r.evidence) s.evidence.push(r.evidence);
      else if (r.type === 'event' && r.event?.type === 'todos') s.tasks = r.event.todos ?? [];
      else if (r.type === 'event' && r.event?.type === 'run_end' && r.event.completion) s.completions.push({ runId: r.event.runId ?? '', ts: r.ts, state: r.event.completion.state, summary: r.event.completion.summary });
      else if (r.type === 'state_resumed' && typeof r.from === 'string') s.resumedFrom.push(r.from);
    } catch {
      /* skip a corrupt line */
    }
  }
  return s;
}

/** The state stored for a journal: the state file, else rebuilt from the journal. */
export function loadStateForJournal(journalFile: string, sessionId: string, workspace: string): SessionState {
  return readState(stateFileFor(journalFile)) ?? stateFromJournal(journalFile, sessionId, workspace);
}
