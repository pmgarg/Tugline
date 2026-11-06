/**
 * Next-edit suggestions (v1.1 N15), VS Code part. Off by default
 * (`tugline.nes.enabled`); stable APIs only (text decorations, a context
 * key and keybindings), since VS Code's own inline-edit API is proposed.
 *
 * After the user edits, the recent edit history and the cursor region go to a
 * Zeta-format model (nes.ts). The suggested replacement is shown in place: the
 * text it replaces is highlighted and the new text follows as ghost text. When
 * it is away from the cursor, a hint at the cursor line says where; the first
 * Tab jumps there, the next Tab applies it. Esc dismisses. A request that
 * does not answer within the latency budget (400 ms by default) is cancelled,
 * and typing on cancels the one in flight.
 */
import * as vscode from 'vscode';
import { buildZetaPrompt, EditHistory, needsJump, requestNextEdit, type FetchLike, type NesOutcome, type NesRequest, type TextEdit } from './nes.js';

interface Shown {
  uri: string;
  version: number;
  edit: TextEdit;
  jump: boolean;
  jumped: boolean;
}

export interface NesDeps {
  fetch: FetchLike;
  /** endpoint, model and limits (the governed profile); undefined = not configured yet */
  config(): NesRequest | undefined;
  debounceMs(): number;
}

export class NesController implements vscode.Disposable {
  readonly history = new EditHistory();
  private texts = new Map<string, string>();
  private shown?: Shown;
  private inflight?: AbortController;
  private timer?: NodeJS.Timeout;
  private applying = false;
  private subs: vscode.Disposable[] = [];
  private replaceDeco = vscode.window.createTextEditorDecorationType({ backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'), textDecoration: 'line-through' });
  private insertDeco = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorGhostText.foreground'), fontStyle: 'italic' } });
  private hintDeco = vscode.window.createTextEditorDecorationType({ after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' } });
  /** counters and the last outcome (tests, the log) */
  stats = { requests: 0, timeouts: 0, cancelled: 0, shown: 0, accepted: 0, jumps: 0 };
  lastOutcome?: NesOutcome;

  constructor(private enabled: () => boolean, private deps: NesDeps, private log: (m: string) => void = () => {}) {
    for (const d of vscode.workspace.textDocuments) this.texts.set(d.uri.toString(), d.getText());
    this.subs.push(
      vscode.workspace.onDidOpenTextDocument((d) => this.texts.set(d.uri.toString(), d.getText())),
      vscode.workspace.onDidCloseTextDocument((d) => this.texts.delete(d.uri.toString())),
      vscode.workspace.onDidChangeTextDocument((e) => this.onChange(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.dismiss()),
      this.replaceDeco,
      this.insertDeco,
      this.hintDeco,
    );
  }

  dispose(): void {
    this.dismiss();
    for (const s of this.subs) s.dispose();
  }

  get visible(): Shown | undefined {
    return this.shown;
  }

  private onChange(e: vscode.TextDocumentChangeEvent): void {
    const k = e.document.uri.toString();
    const before = this.texts.get(k);
    this.texts.set(k, e.document.getText());
    if (!this.enabled() || e.document.uri.scheme !== 'file' || !e.contentChanges.length) return;
    if (!this.applying) this.dismiss();
    if (before !== undefined) {
      const rel = vscode.workspace.asRelativePath(e.document.uri, false);
      const oldLines = before.split('\n');
      for (const c of e.contentChanges) {
        const startLine = c.range.start.line;
        const oldCount = c.range.end.line - startLine + 1;
        const newCount = c.text.split('\n').length;
        const removed = oldLines.slice(startLine, startLine + oldCount).join('\n');
        const added = Array.from({ length: newCount }, (_, i) => (startLine + i < e.document.lineCount ? e.document.lineAt(startLine + i).text : '')).join('\n');
        this.history.record({ path: rel, line: startLine + 1, removed, added });
      }
    }
    if (this.applying) return;
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document !== e.document) return;
    this.schedule(ed);
  }

  private schedule(ed: vscode.TextEditor): void {
    clearTimeout(this.timer);
    this.inflight?.abort();
    this.timer = setTimeout(() => void this.trigger(ed), this.deps.debounceMs());
  }

  /** Ask now for the active editor (also the "Suggest Next Edit" command). */
  async trigger(ed = vscode.window.activeTextEditor): Promise<NesOutcome | undefined> {
    if (!ed || !this.enabled()) return undefined;
    const cfg = this.deps.config();
    if (!cfg) return undefined;
    this.inflight?.abort();
    const ctl = new AbortController();
    this.inflight = ctl;
    const doc = ed.document;
    const version = doc.version;
    const text = doc.getText();
    const cursor = doc.offsetAt(ed.selection.active);
    const p = buildZetaPrompt({ path: vscode.workspace.asRelativePath(doc.uri, false), text, cursor, events: this.history.events });
    this.stats.requests++;
    const out = await requestNextEdit(this.deps.fetch, cfg, p, ctl.signal);
    if (this.inflight === ctl) this.inflight = undefined;
    this.lastOutcome = out;
    if (out.reason === 'timeout') this.stats.timeouts++;
    if (out.reason === 'cancelled') this.stats.cancelled++;
    if (out.reason && out.reason !== 'no-change') this.log(`[nes] no suggestion: ${out.reason} (${out.ms} ms)`);
    // stale: the user typed on, or moved to another editor
    if (!out.edit || doc.version !== version || vscode.window.activeTextEditor !== ed) return out;
    this.show(ed, out.edit, needsJump(text, cursor, out.edit));
    return out;
  }

  private show(ed: vscode.TextEditor, edit: TextEdit, jump: boolean): void {
    const doc = ed.document;
    this.shown = { uri: doc.uri.toString(), version: doc.version, edit, jump, jumped: false };
    this.stats.shown++;
    this.render(ed);
    void vscode.commands.executeCommand('setContext', 'tugline.nesVisible', true);
  }

  private render(ed: vscode.TextEditor): void {
    const s = this.shown;
    if (!s) return;
    const doc = ed.document;
    const range = new vscode.Range(doc.positionAt(s.edit.start), doc.positionAt(s.edit.end));
    const first = s.edit.text.split('\n');
    const ghost = first[0] + (first.length > 1 ? ` ⏎ … (+${first.length - 1} line${first.length > 2 ? 's' : ''})` : '');
    ed.setDecorations(this.replaceDeco, range.isEmpty ? [] : [range]);
    ed.setDecorations(this.insertDeco, s.edit.text ? [{ range: new vscode.Range(range.end, range.end), renderOptions: { after: { contentText: ghost || ' ' } } }] : []);
    const cursorLine = ed.selection.active.line;
    const hint = s.jump && !s.jumped ? `⇥ Tab: next edit at line ${range.start.line + 1}` : '⇥ Tab: accept edit · Esc: dismiss';
    const line = s.jump && !s.jumped ? cursorLine : range.end.line;
    ed.setDecorations(this.hintDeco, [{ range: new vscode.Range(line, doc.lineAt(line).text.length, line, doc.lineAt(line).text.length), renderOptions: { after: { contentText: hint } } }]);
  }

  /** Tab: jump to a far suggestion first, then apply it. Returns what happened. */
  async accept(): Promise<'jumped' | 'applied' | undefined> {
    const s = this.shown;
    const ed = vscode.window.activeTextEditor;
    if (!s || !ed || ed.document.uri.toString() !== s.uri || ed.document.version !== s.version) {
      this.dismiss();
      return undefined;
    }
    const doc = ed.document;
    const range = new vscode.Range(doc.positionAt(s.edit.start), doc.positionAt(s.edit.end));
    if (s.jump && !s.jumped) {
      s.jumped = true;
      this.stats.jumps++;
      ed.selection = new vscode.Selection(range.start, range.start);
      ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      this.render(ed);
      return 'jumped';
    }
    this.applying = true;
    try {
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, range, s.edit.text);
      await vscode.workspace.applyEdit(we);
    } finally {
      this.applying = false;
    }
    const end = doc.positionAt(s.edit.start + s.edit.text.length);
    ed.selection = new vscode.Selection(end, end);
    this.stats.accepted++;
    this.dismiss();
    // the accepted edit is part of the history; look for the next one
    this.schedule(ed);
    return 'applied';
  }

  dismiss(): void {
    if (!this.shown) return;
    this.shown = undefined;
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.replaceDeco, []);
      ed.setDecorations(this.insertDeco, []);
      ed.setDecorations(this.hintDeco, []);
    }
    void vscode.commands.executeCommand('setContext', 'tugline.nesVisible', false);
  }
}
