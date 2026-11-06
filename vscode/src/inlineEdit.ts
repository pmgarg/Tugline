/**
 * Inline edit on a selection (SPEC B3): Ctrl/Cmd+Alt+K (Ctrl+Shift+K is VS Code's Delete Line).
 *
 * v1 (research ED §3.2 "simpler alternative"): the reply is buffered behind a
 * cancellable progress notification, the selection is replaced with ONE
 * WorkspaceEdit (one undo step), and the result is reviewed in place with the
 * shared review machinery: added lines highlighted, CodeLens "Accept | Reject"
 * per hunk, and Accept all (Ctrl/Cmd+Shift+Enter) / Reject all
 * (Ctrl/Cmd+Shift+Backspace). Reject restores the original text exactly. No
 * tools are offered to the model.
 */
import * as vscode from 'vscode';
import type { CompletionRequest, CompletionResult, LLMClient } from '../../src/core/llm/client.js';
import { estimateTokens } from '../../src/core/util/text.js';
import { buildInlineEditPrompt, buildReplacement } from './inlinePrompt.js';
import type { ReviewManager } from './review.js';

const HISTORY_KEY = 'tugline.inlineHistory';

export interface InlineDeps {
  review: ReviewManager;
  state: vscode.Memento;
  /** client for ide.inlineEditProfile (or the chat's profile) */
  client(): Promise<LLMClient>;
  /** v1.1 R4: run the model call through the core's admission point (the extension supplies the scope) */
  admit?<T>(client: LLMClient, req: CompletionRequest): Promise<CompletionResult>;
  log(msg: string): void;
}

export interface InlineResult {
  applied: boolean;
  reason?: string;
  replacement?: string;
}

async function askInstruction(state: vscode.Memento): Promise<string | undefined> {
  const history = state.get<string[]>(HISTORY_KEY, []);
  const qp = vscode.window.createQuickPick();
  qp.title = 'Tugline: edit selection';
  qp.placeholder = 'Describe the change (Enter). History below.';
  qp.items = history.map((h) => ({ label: h }));
  return new Promise((resolve) => {
    let done = false;
    qp.onDidAccept(() => {
      done = true;
      const v = qp.value.trim() || qp.selectedItems[0]?.label;
      qp.hide();
      resolve(v);
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

export async function runInlineEdit(deps: InlineDeps, args?: { instruction?: string }): Promise<InlineResult> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return { applied: false, reason: 'no active editor' };
  if (ed.selections.length > 1) {
    void vscode.window.showWarningMessage('Tugline: inline edit works on one selection (multi-cursor is not supported).');
    return { applied: false, reason: 'multi-cursor' };
  }
  const doc = ed.document;
  if (doc.uri.scheme === 'vscode-notebook-cell') {
    void vscode.window.showWarningMessage('Tugline: inline edit does not support notebook cells yet; use the chat.');
    return { applied: false, reason: 'notebook' };
  }
  if (deps.review.kindOf(doc.uri) === 'inline') {
    void vscode.window.showWarningMessage('Tugline: accept or reject the pending inline edit first.');
    return { applied: false, reason: 'pending inline edit' };
  }
  // Whole lines: the selection's base indentation is what the reply is re-indented to.
  const sel = ed.selection;
  const startLine = sel.start.line;
  let endLine = sel.end.line;
  if (!sel.isEmpty && sel.end.character === 0 && endLine > startLine) endLine--;
  const end = endLine + 1 < doc.lineCount ? new vscode.Position(endLine + 1, 0) : doc.lineAt(doc.lineCount - 1).range.end;
  const range = new vscode.Range(new vscode.Position(startLine, 0), end);
  const selection = doc.getText(range);
  const instruction = args?.instruction ?? (await askInstruction(deps.state));
  if (!instruction) return { applied: false, reason: 'cancelled' };
  const history = deps.state.get<string[]>(HISTORY_KEY, []);
  await deps.state.update(HISTORY_KEY, [instruction, ...history.filter((h) => h !== instruction)].slice(0, 30));
  const diagnostics = vscode.languages
    .getDiagnostics(doc.uri)
    .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.range.end.line >= startLine - 3 && d.range.start.line <= endLine + 3)
    .map((d) => `line ${d.range.start.line + 1}: ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${d.message}`);
  const messages = buildInlineEditPrompt({
    path: vscode.workspace.asRelativePath(doc.uri),
    language: doc.languageId,
    prefix: doc.getText(new vscode.Range(0, 0, startLine, 0)),
    selection,
    suffix: doc.getText(new vscode.Range(range.end, doc.lineAt(doc.lineCount - 1).range.end)),
    instruction,
    diagnostics,
  });
  const versionBefore = doc.version;
  const client = await deps.client();
  let reply: string;
  try {
    reply = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Tugline: ${instruction.slice(0, 60)}…`, cancellable: true }, async (_p, token) => {
      const ctl = new AbortController();
      token.onCancellationRequested(() => ctl.abort());
      const req: CompletionRequest = { messages, maxTokens: Math.min(client.profile.maxOutputTokens || 8192, 2 * estimateTokens(selection) + 512), temperature: 0.2, signal: ctl.signal, noStream: true };
      const res = deps.admit ? await deps.admit(client, req) : await client.complete(req);
      return res.text;
    });
  } catch (e) {
    void vscode.window.showErrorMessage(`Tugline inline edit failed: ${(e as Error).message}`);
    return { applied: false, reason: (e as Error).message };
  }
  const replacement = buildReplacement(reply, selection);
  if (replacement === undefined) {
    deps.log(`[inline] unparseable reply: ${reply.slice(0, 300)}`);
    void vscode.window.showWarningMessage('Tugline: the model did not return code for the selection.');
    return { applied: false, reason: 'unparseable reply' };
  }
  if (replacement === selection) {
    void vscode.window.showInformationMessage('Tugline: no change suggested.');
    return { applied: false, reason: 'no change', replacement };
  }
  if (doc.version !== versionBefore) {
    void vscode.window.showWarningMessage('Tugline: the document changed while the model was answering; inline edit discarded.');
    return { applied: false, reason: 'document changed' };
  }
  const base = doc.getText();
  const we = new vscode.WorkspaceEdit();
  we.replace(doc.uri, range, replacement, { needsConfirmation: false, label: `Tugline: ${instruction.slice(0, 40)}` });
  const ok = await deps.review.own(doc.uri, () => vscode.workspace.applyEdit(we));
  if (!ok) return { applied: false, reason: 'edit refused' };
  await deps.review.track(doc.uri, base, 'inline');
  deps.review.updateInlineContext();
  return { applied: true, replacement };
}
