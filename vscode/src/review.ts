/**
 * Write-then-review (SPEC B2) and inline-edit review (B3).
 *
 * In acceptEdits/auto modes the agent's edits are applied at once and recorded
 * here as pending changes: per file a baseline (the text before the agent's
 * first edit) against the live document. The chat panel lists them (+/−
 * counts, Open Diff, Keep, Undo, Keep all, Undo all); in the editor every hunk
 * gets a CodeLens "Keep | Undo" and added lines are highlighted. Inline edits
 * use the same machinery with "Accept | Reject".
 *
 * - Keep advances the baseline (the hunk disappears); Undo applies a
 *   WorkspaceEdit putting the baseline lines back (only that hunk).
 * - User typing outside agent hunks is folded into the baseline, so Undo never
 *   reverts it. Typing INSIDE an agent hunk becomes part of that hunk: undoing
 *   the hunk reverts it too.
 * - Pending state survives a window reload (workspaceState).
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import { computeHunks, countChanges, hunkOffsets, keepHunk, rebaseUserChanges, revertHunk, sameHunk, type ReviewHunk } from './hunks.js';

export type ReviewKind = 'agent' | 'inline';

interface Entry {
  uri: string;
  base: string;
  kind: ReviewKind;
  /** the file did not exist before the agent created it */
  created: boolean;
  /** last known text (to map user changes) */
  last?: string;
}

export interface PendingFile {
  uri: string;
  path: string;
  kind: ReviewKind;
  added: number;
  removed: number;
  hunks: number;
  created: boolean;
}

const STATE_KEY = 'tugline.pending.v1';
export const BASE_SCHEME = 'tugline-base';

export class ReviewManager implements vscode.CodeLensProvider, vscode.Disposable {
  private entries = new Map<string, Entry>();
  private ownEdits = new Map<string, number>();
  private lensEmitter = new vscode.EventEmitter<void>();
  private changeEmitter = new vscode.EventEmitter<void>();
  private baseEmitter = new vscode.EventEmitter<vscode.Uri>();
  private subs: vscode.Disposable[] = [];
  private addedDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'), overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'), overviewRulerLane: vscode.OverviewRulerLane.Left });
  private removedDeco = vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '1px 0 0 0', borderStyle: 'dashed', borderColor: new vscode.ThemeColor('diffEditor.removedTextBorder'), after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' } });
  private notes: string[] = [];
  private saveTimer?: NodeJS.Timeout;
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  /** pending list changed (webview refresh) */
  readonly onDidChangePending = this.changeEmitter.event;
  /** the baseline side of "Open Diff" (scheme tugline-base) */
  readonly baseProvider: vscode.TextDocumentContentProvider = {
    onDidChange: this.baseEmitter.event,
    provideTextDocumentContent: (uri) => this.entries.get(Buffer.from(uri.query, 'hex').toString('utf8'))?.base ?? '',
  };

  constructor(private state: vscode.Memento) {
    for (const e of state.get<Entry[]>(STATE_KEY, [])) this.entries.set(e.uri, e);
    this.subs.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorateAll()),
      this.lensEmitter,
      this.changeEmitter,
      this.baseEmitter,
      this.addedDeco,
      this.removedDeco,
    );
    void this.prune();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  // ------------------------------------------------------------ content provider (baseline side of the diff)

  baseUri(uri: string): vscode.Uri {
    const u = vscode.Uri.parse(uri);
    return vscode.Uri.from({ scheme: BASE_SCHEME, path: u.path, query: Buffer.from(uri, 'utf8').toString('hex') });
  }

  // ------------------------------------------------------------ state

  /** Run our own edit so it is not taken for user typing. */
  async own<T>(uri: vscode.Uri, fn: () => Thenable<T> | Promise<T>): Promise<T> {
    const k = uri.toString();
    this.ownEdits.set(k, (this.ownEdits.get(k) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.ownEdits.get(k) ?? 1) - 1;
      if (n <= 0) this.ownEdits.delete(k);
      else this.ownEdits.set(k, n);
      const e = this.entries.get(k);
      if (e) e.last = await this.currentText(k);
    }
  }

  /** Record a change for review. `before` = null for a file the agent created. The first baseline wins. */
  async track(uri: vscode.Uri, before: string | null, kind: ReviewKind): Promise<void> {
    const k = uri.toString();
    if (!this.entries.has(k)) this.entries.set(k, { uri: k, base: before ?? '', kind, created: before === null });
    const e = this.entries.get(k)!;
    e.last = await this.currentText(k);
    if (e.last === e.base && !e.created) this.entries.delete(k);
    this.changed(k);
  }

  has(uri: vscode.Uri | string): boolean {
    return this.entries.has(uri.toString());
  }

  kindOf(uri: vscode.Uri | string): ReviewKind | undefined {
    return this.entries.get(uri.toString())?.kind;
  }

  /** Notes for the model about reverted hunks ("user reverted …"), drained once. */
  drainNotes(): string[] {
    return this.notes.splice(0);
  }

  private async currentText(k: string): Promise<string | undefined> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === k && !d.isClosed);
    if (doc) return doc.getText();
    const u = vscode.Uri.parse(k);
    if (u.scheme !== 'file') return undefined;
    try {
      return fs.readFileSync(u.fsPath, 'utf8');
    } catch {
      return undefined;
    }
  }

  private changed(k?: string): void {
    this.lensEmitter.fire();
    this.changeEmitter.fire();
    if (k) this.baseEmitter.fire(this.baseUri(k));
    this.decorateAll();
    void vscode.commands.executeCommand('setContext', 'tugline.hasPending', this.entries.size > 0);
    this.updateInlineContext();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.state.update(STATE_KEY, [...this.entries.values()].map(({ last, ...e }) => e)), 200);
  }

  updateInlineContext(): void {
    const ed = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'tugline.inlineDiffVisible', !!ed && this.entries.get(ed.document.uri.toString())?.kind === 'inline');
  }

  /** Drop entries whose file is gone or matches its baseline again (after a reload or external revert). */
  async prune(): Promise<void> {
    for (const [k, e] of [...this.entries]) {
      const cur = await this.currentText(k);
      if (cur === undefined ? !e.created : cur === e.base) this.entries.delete(k);
      else e.last = cur;
    }
    this.changed();
  }

  private onDocChange(ev: vscode.TextDocumentChangeEvent): void {
    const k = ev.document.uri.toString();
    const e = this.entries.get(k);
    if (!e || !ev.contentChanges.length) return;
    const cur = ev.document.getText();
    if (!this.ownEdits.has(k) && e.last !== undefined) e.base = rebaseUserChanges(e.base, e.last, ev.contentChanges.map((c) => ({ rangeOffset: c.rangeOffset, rangeLength: c.rangeLength, text: c.text })));
    e.last = cur;
    if (cur === e.base && !e.created) this.entries.delete(k);
    this.changed(k);
  }

  async list(): Promise<PendingFile[]> {
    const out: PendingFile[] = [];
    for (const [k, e] of this.entries) {
      const cur = (await this.currentText(k)) ?? '';
      const c = countChanges(e.base, cur);
      out.push({ uri: k, path: vscode.Uri.parse(k).fsPath, kind: e.kind, ...c, created: e.created });
    }
    return out;
  }

  async hunks(uri: string): Promise<ReviewHunk[]> {
    const e = this.entries.get(uri);
    if (!e) return [];
    return computeHunks(e.base, (await this.currentText(uri)) ?? '');
  }

  // ------------------------------------------------------------ actions

  /** Keep a hunk (or the whole file): the baseline moves forward. */
  async keep(uri: string, hunk?: ReviewHunk): Promise<void> {
    const e = this.entries.get(uri);
    if (!e) return;
    const cur = (await this.currentText(uri)) ?? '';
    if (!hunk) e.base = cur;
    else {
      const h = computeHunks(e.base, cur).find((x) => sameHunk(x, hunk));
      if (!h) return;
      e.base = keepHunk(e.base, cur, h);
    }
    e.created = e.created && !!hunk;
    if (e.base === cur) this.entries.delete(uri);
    this.changed(uri);
  }

  /** Undo a hunk (or the whole file) with a WorkspaceEdit (undoable). */
  async undo(uri: string, hunk?: ReviewHunk): Promise<boolean> {
    const e = this.entries.get(uri);
    if (!e) return false;
    const u = vscode.Uri.parse(uri);
    if (!hunk && e.created) {
      // the agent created this file: undo = delete it
      const we = new vscode.WorkspaceEdit();
      we.deleteFile(u, { ignoreIfNotExists: true });
      await this.own(u, () => vscode.workspace.applyEdit(we));
      if (u.scheme === 'file' && fs.existsSync(u.fsPath)) fs.rmSync(u.fsPath, { force: true });
      this.entries.delete(uri);
      this.notes.push(`The user removed ${vscode.workspace.asRelativePath(u)} (a file you created).`);
      this.changed(uri);
      return true;
    }
    const doc = await vscode.workspace.openTextDocument(u);
    const cur = doc.getText();
    const all = computeHunks(e.base, cur);
    const targets = hunk ? all.filter((x) => sameHunk(x, hunk)) : all;
    if (!targets.length) return false;
    const wasDirty = doc.isDirty;
    const we = new vscode.WorkspaceEdit();
    for (const h of targets) {
      const { start, end } = hunkOffsets(cur, h);
      const next = revertHunk(e.base, cur, h);
      const text = next.slice(start, next.length - (cur.length - end));
      we.replace(u, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), text, { needsConfirmation: false, label: 'Tugline: undo agent change' });
    }
    const ok = await this.own(u, () => vscode.workspace.applyEdit(we));
    if (!ok) return false;
    if (!wasDirty && e.kind === 'agent' && u.scheme === 'file') await doc.save();
    this.notes.push(`The user reverted ${hunk ? 'one hunk' : `all ${targets.length} hunk(s)`} of your changes in ${vscode.workspace.asRelativePath(u)}.`);
    if (doc.getText() === e.base) this.entries.delete(uri);
    this.changed(uri);
    return true;
  }

  async keepAll(kind?: ReviewKind): Promise<void> {
    for (const [k, e] of [...this.entries]) if (!kind || e.kind === kind) await this.keep(k);
  }

  async undoAll(kind?: ReviewKind): Promise<void> {
    for (const [k, e] of [...this.entries]) if (!kind || e.kind === kind) await this.undo(k);
  }

  async openDiff(uri: string): Promise<void> {
    const u = vscode.Uri.parse(uri);
    await vscode.commands.executeCommand('vscode.diff', this.baseUri(uri), u, `${vscode.workspace.asRelativePath(u)} (Tugline changes)`, { preview: true });
  }

  /** Multi-file review in VS Code's multi-diff editor. */
  async openAll(): Promise<void> {
    const list = [...this.entries.keys()].map((k) => [vscode.Uri.parse(k), this.baseUri(k), vscode.Uri.parse(k)]);
    if (list.length) await vscode.commands.executeCommand('vscode.changes', 'Tugline changes', list);
  }

  // ------------------------------------------------------------ editor UI

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const k = doc.uri.toString();
    const e = this.entries.get(k);
    if (!e) return [];
    const hs = computeHunks(e.base, doc.getText());
    const [yes, no] = e.kind === 'inline' ? ['Accept', 'Reject'] : ['Keep', 'Undo'];
    const lenses: vscode.CodeLens[] = [];
    hs.forEach((h, i) => {
      const line = Math.min(h.newStart, Math.max(0, doc.lineCount - 1));
      const r = new vscode.Range(line, 0, line, 0);
      lenses.push(new vscode.CodeLens(r, { title: `${yes}`, command: 'tugline.review.keepHunk', arguments: [k, h], tooltip: `${yes} this change (${i + 1}/${hs.length})` }));
      lenses.push(new vscode.CodeLens(r, { title: `${no}`, command: 'tugline.review.undoHunk', arguments: [k, h], tooltip: `${no} this change` }));
      if (i === 0 && hs.length > 1) {
        lenses.push(new vscode.CodeLens(r, { title: `${yes} all`, command: 'tugline.review.keepFile', arguments: [k] }));
        lenses.push(new vscode.CodeLens(r, { title: `${no} all`, command: 'tugline.review.undoFile', arguments: [k] }));
      }
    });
    return lenses;
  }

  private decorateAll(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const e = this.entries.get(ed.document.uri.toString());
      if (!e) {
        ed.setDecorations(this.addedDeco, []);
        ed.setDecorations(this.removedDeco, []);
        continue;
      }
      const hs = computeHunks(e.base, ed.document.getText());
      const added: vscode.Range[] = [];
      const removed: vscode.DecorationOptions[] = [];
      for (const h of hs) {
        for (let l = h.newStart; l < h.newStart + h.newLines && l < ed.document.lineCount; l++) added.push(new vscode.Range(l, 0, l, 0));
        if (h.oldLines && !h.newLines) {
          const line = Math.min(h.newStart, ed.document.lineCount - 1);
          removed.push({ range: new vscode.Range(line, 0, line, 0), renderOptions: { after: { contentText: `− ${h.oldLines} line(s) removed` } } });
        }
      }
      ed.setDecorations(this.addedDeco, added);
      ed.setDecorations(this.removedDeco, removed);
    }
  }
}
