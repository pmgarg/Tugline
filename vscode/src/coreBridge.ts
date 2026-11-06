/**
 * v1.1 bridges between the extension and the core that need no `vscode` import (unit-tested in
 * test/vscode-units.test.ts):
 *   - R4: model calls the extension makes itself (pasted-image description, inline edit) go
 *     through the core's admission point, like every agent call;
 *   - R8: the saved / skipped / failed report of flushForShell and saveDocuments;
 *   - R2: the completion badge for run_end;
 *   - R14: the durable session state carried across agent re-creation in a live chat.
 */
import type { Agent } from '../../src/core/agent/agent.js';
import type { HarnessConfig } from '../../src/core/config.js';
import type { CompletionRequest, CompletionResult, LLMClient } from '../../src/core/llm/client.js';
import type { FlushReport } from '../../src/core/host/workspace.js';
import type { ChatMessage, CompletionStatus } from '../../src/core/types.js';
import type { SessionState } from '../../src/core/context/sessionState.js';

// ------------------------------------------------------------ R4

/**
 * One model call made by the extension, admitted against the limits before anything is sent:
 * inside the chat agent's scope (its session, run budget and stats) when there is one, else in a
 * scope of its own for the governed config. A refusal rejects with LLMError kind 'budget'.
 */
export function admittedComplete(client: LLMClient, req: CompletionRequest, o: { agent?: Agent; config: HarnessConfig; kind: string; role: string }): Promise<CompletionResult> {
  if (o.agent) return o.agent.completeWith(client, req, o.role);
  // through the client's own admission module (one instance in the bundle; in tests the extension may load a second copy)
  return client.completeIn({ config: o.config, sessionId: `vscode-${o.kind}`, depth: 0, kind: o.kind, role: o.role }, req);
}

// ------------------------------------------------------------ R8

/** What the host needs to know about an open document. */
export interface DocLike {
  /** uri string (the key the host tracks touched documents by) */
  key: string;
  fsPath: string;
  isDirty: boolean;
  isClosed: boolean;
  save(): Thenable<boolean> | Promise<boolean>;
}

/**
 * flushForShell (R8): save documents the agent edited that the user had not modified; report the
 * ones it must not save silently (the user had unsaved changes: agent-touched documents that were
 * dirty before the agent's edit, and any other dirty document in the workspace) as skipped, and
 * saves that failed.
 */
export async function flushDocuments(docs: DocLike[], touched: Map<string, boolean>, inWorkspace: (fsPath: string) => boolean): Promise<FlushReport> {
  const r: FlushReport = { saved: [], skipped: [], failed: [] };
  for (const d of docs) {
    if (d.isClosed || !d.isDirty) continue;
    const t = touched.get(d.key);
    if (t === false) {
      try {
        if (await d.save()) r.saved.push(d.fsPath);
        else r.failed.push({ path: d.fsPath, error: 'the editor did not save it' });
      } catch (e) {
        r.failed.push({ path: d.fsPath, error: (e as Error).message });
      }
    } else if (t === true || inWorkspace(d.fsPath)) r.skipped.push(d.fsPath);
  }
  return r;
}

/** saveDocuments (R8): save exactly these documents (the user chose "save"). */
export async function saveDocumentsReport(paths: string[], find: (fsPath: string) => DocLike | undefined): Promise<FlushReport> {
  const r: FlushReport = { saved: [], skipped: [], failed: [] };
  for (const p of paths) {
    const d = find(p);
    if (!d || d.isClosed || !d.isDirty) continue; // nothing unsaved any more: the disk is the editor version
    try {
      if (await d.save()) r.saved.push(p);
      else r.failed.push({ path: p, error: 'the editor did not save it' });
    } catch (e) {
      r.failed.push({ path: p, error: (e as Error).message });
    }
  }
  return r;
}

// ------------------------------------------------------------ R2

export interface CompletionBadge {
  state: CompletionStatus['state'];
  /** css modifier */
  cls: 'ok' | 'fail' | 'warn';
  label: string;
  title: string;
  /** one plain sentence for the line under the answer (title keeps the full summary) */
  why: string;
}

/** The chat badge for a run's completion status (none for not_applicable: nothing was changed). */
export function completionBadge(c: CompletionStatus | undefined): CompletionBadge | undefined {
  if (!c || c.state === 'not_applicable') return undefined;
  const label = c.state === 'verified' ? 'Verified' : c.state === 'failed' ? 'Check failed' : 'Not verified';
  // UI tour: the line under an answer quoted config keys; it says what happened in plain words now (details in the tooltip)
  const cmd = c.check?.command ? `\`${c.check.command.length > 60 ? `${c.check.command.slice(0, 57)}…` : c.check.command}\`` : 'the project check';
  const why =
    c.state === 'verified'
      ? `${cmd} passed after the last edit.`
      : c.state === 'failed'
        ? `${cmd} failed after the last edit.`
        : c.declaredUnverifiable
          ? 'The agent said it could not check this.'
          : /harnessCheck: "off"/.test(c.summary)
            ? 'Automatic checks are off for this workspace; the agent\'s own test runs are not counted.'
            : 'No check ran after the last edit.';
  return { state: c.state, cls: c.state === 'verified' ? 'ok' : c.state === 'failed' ? 'fail' : 'warn', label, title: c.summary, why };
}

// ------------------------------------------------------------ R14

/** The history to hand a re-created agent, carrying the old agent's durable session state with it. */
export function historyWithState(old: Pick<Agent, 'messages' | 'sessionState'>): ChatMessage[] {
  const msgs = old.messages.filter((m) => m.role !== 'system');
  const state: SessionState = old.sessionState();
  Object.defineProperty(msgs, 'sessionState', { value: state, enumerable: false });
  return msgs;
}
