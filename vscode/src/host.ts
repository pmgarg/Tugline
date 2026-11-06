/**
 * VsCodeBufferHost (SPEC B1, implements the S0.1 WorkspaceHost seam).
 *
 * The agent's file tools read and write through this host, so:
 * - reads see the editor buffer, unsaved user changes included;
 * - writes are WorkspaceEdits touching only the changed lines: they merge with
 *   the user's unsaved text, land on the undo stack (Ctrl+Z reverts them) and
 *   keep cursors and folding stable;
 * - a document the user had not modified is saved after the edit (`ide.autoSave`),
 *   so shell commands and tests see the edit; a document with unsaved user
 *   changes is never saved behind the user's back;
 * - `flushForShell` saves agent-touched documents before a bash command;
 * - `diagnostics` reports the language servers' problems and can wait for a
 *   fresh publish after an edit (`languages.onDidChangeDiagnostics`, timeout),
 *   which the core diffs before/after an edit (A6);
 * - `runCommand` runs bash in a visible terminal when enabled (B10).
 *
 * Version tokens are a hash of the text, identical whether a file is read from
 * the buffer or from disk (a background document VS Code closes and reopens
 * must not look "changed since read").
 */
import * as vscode from 'vscode';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { diskHost, type Diagnostic, type FlushReport, type HostCommand, type HostCommandResult, type HostText, type NavRequest, type NavResult, type WorkspaceHost } from '../../src/core/host/workspace.js';
import { vscodeNavigate } from './navigate.js';
import { flushDocuments, saveDocumentsReport, type DocLike } from './coreBridge.js';
import { minimalEdits } from './hunks.js';
import type { VisibleTerminalRunner } from './terminalRunner.js';

const MAX_BUFFER_BYTES = 5 * 1024 * 1024;
/** Languages that normally have no diagnostics provider: never wait for a publish. */
const NO_DIAGNOSTICS = new Set(['plaintext', 'markdown', 'log', 'ignore', 'properties', 'csv', 'tsv', 'diff', 'git-commit']);

export function versionOf(text: string): string {
  return 'h:' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 20);
}

function hasMixedEol(text: string): boolean {
  const crlf = /\r\n/.test(text);
  return crlf && /(^|[^\r])\n/.test(text);
}

/** Tracks diagnostics publishes per document (one per extension). */
export class DiagnosticsWatch implements vscode.Disposable {
  private last = new Map<string, number>();
  /** languages that published diagnostics at least once this session (a provider exists) */
  readonly languages = new Set<string>();
  private waiters = new Set<{ uri: string; resolve: () => void }>();
  private sub: vscode.Disposable;
  constructor() {
    this.sub = vscode.languages.onDidChangeDiagnostics((e) => {
      const now = Date.now();
      for (const u of e.uris) {
        const k = u.toString();
        this.last.set(k, now);
        const lang = vscode.workspace.textDocuments.find((d) => d.uri.toString() === k)?.languageId;
        if (lang) this.languages.add(lang);
        for (const w of [...this.waiters]) if (w.uri === k) w.resolve();
      }
    });
  }
  lastChange(uri: vscode.Uri): number {
    return this.last.get(uri.toString()) ?? 0;
  }
  /** Resolve on the first publish for `uri` after `since`, or after `ms`. */
  wait(uri: vscode.Uri, since: number, ms: number): Promise<boolean> {
    if (this.lastChange(uri) > since) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = {
        uri: uri.toString(),
        resolve: () => {
          clearTimeout(t);
          this.waiters.delete(w);
          resolve(true);
        },
      };
      const t = setTimeout(() => {
        this.waiters.delete(w);
        resolve(false);
      }, ms);
      this.waiters.add(w);
    });
  }
  dispose(): void {
    this.sub.dispose();
  }
}

export function toDiagnostics(entries: [vscode.Uri, readonly vscode.Diagnostic[]][]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [uri, diags] of entries) {
    for (const d of diags) {
      if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
      out.push({ path: uri.fsPath, line: d.range.start.line + 1, col: d.range.start.character + 1, severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning', message: d.message, source: d.source });
    }
  }
  return out;
}

export interface HostHooks {
  /** B1: save documents the user had not modified after an agent edit. */
  autoSave(): boolean;
  /** B2: every agent write/delete (before = null for a new file). */
  onAgentWrite?(abs: string, before: string | null, after: string | null): void;
  /** B10: the visible terminal runner, when enabled. */
  runner?(): VisibleTerminalRunner | undefined;
  /** B2: count our own edits so the review does not mistake them for user typing. */
  ownEdit?<T>(uri: vscode.Uri, fn: () => Thenable<T> | Promise<T>): Promise<T>;
}

function docLike(d: vscode.TextDocument): DocLike {
  return { key: d.uri.toString(), fsPath: d.uri.fsPath, isDirty: d.isDirty, isClosed: d.isClosed, save: () => d.save() };
}

export class VsCodeBufferHost implements WorkspaceHost {
  readonly kind = 'vscode' as const;
  /** uri → was the document dirty before the agent's first edit */
  private touched = new Map<string, boolean>();
  private lastWrite = new Map<string, number>();
  /** paths saved by the last flushForShell (tests, UI) */
  lastFlushed: string[] = [];

  constructor(private hooks: HostHooks, private watch: DiagnosticsWatch) {}

  private openDoc(abs: string): vscode.TextDocument | undefined {
    const uri = vscode.Uri.file(abs).toString();
    return vscode.workspace.textDocuments.find((d) => !d.isClosed && d.uri.toString() === uri);
  }

  private own<T>(uri: vscode.Uri, fn: () => Thenable<T> | Promise<T>): Promise<T> {
    return this.hooks.ownEdit ? this.hooks.ownEdit(uri, fn) : Promise.resolve(fn());
  }

  async readText(abs: string): Promise<HostText | undefined> {
    const doc = this.openDoc(abs);
    if (doc) {
      const text = doc.getText();
      return { text, version: versionOf(text), dirty: doc.isDirty, eol: doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n', utf8: true };
    }
    const d = await diskHost.readText(abs);
    if (!d) return undefined;
    return { ...d, version: versionOf(d.text) };
  }

  async writeText(abs: string, text: string, opts?: { label?: string }): Promise<{ version: string }> {
    const uri = vscode.Uri.file(abs);
    const meta: vscode.WorkspaceEditEntryMetadata = { needsConfirmation: false, label: opts?.label ?? 'Tugline edit' };
    const open = this.openDoc(abs);
    const onDisk = !open && fs.existsSync(abs);
    const before = open ? open.getText() : onDisk ? (await diskHost.readText(abs))?.text : undefined;
    this.lastWrite.set(abs, Date.now());
    // Large files and mixed line endings stay on the disk path: VS Code would load
    // the whole file into the extension host / normalise the line endings.
    const size = onDisk ? fs.statSync(abs).size : 0;
    if (!open && (size > MAX_BUFFER_BYTES || (before !== undefined && hasMixedEol(before)) || abs.endsWith('.ipynb'))) {
      await diskHost.writeText(abs, text);
      this.hooks.onAgentWrite?.(abs, before ?? null, text);
      return { version: versionOf(text.replace(/^﻿/, '')) };
    }
    if (before === undefined) {
      // New file: createFile with contents is one undoable step.
      const we = new vscode.WorkspaceEdit();
      we.createFile(uri, { overwrite: false, ignoreIfExists: true, contents: Buffer.from(text, 'utf8') }, meta);
      const ok = await this.own(uri, () => vscode.workspace.applyEdit(we));
      if (!ok || !fs.existsSync(abs)) await diskHost.writeText(abs, text);
      this.touched.set(uri.toString(), false);
      this.hooks.onAgentWrite?.(abs, null, text);
      return { version: versionOf(text.replace(/^﻿/, '')) };
    }
    // VS Code keeps a file's BOM on save; the core adds it back for disk hosts.
    const body = text.replace(/^﻿/, '');
    const doc = open ?? (await vscode.workspace.openTextDocument(uri));
    const key = uri.toString();
    const wasDirty = doc.isDirty;
    if (!this.touched.has(key)) this.touched.set(key, wasDirty);
    const nl = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const want = body.replace(/\r?\n/g, nl);
    const cur = doc.getText();
    if (cur !== want) {
      const we = new vscode.WorkspaceEdit();
      for (const e of minimalEdits(cur, want)) we.replace(uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text, meta);
      const ok = await this.own(uri, () => vscode.workspace.applyEdit(we));
      if (!ok) throw new Error(`VS Code did not apply the edit to ${abs} (the document may be read-only)`);
      if (doc.getText() !== want) throw new Error(`the editor buffer of ${abs} changed while the edit was applied; read the file again`);
    }
    if (!wasDirty && this.hooks.autoSave()) await doc.save();
    this.hooks.onAgentWrite?.(abs, cur, doc.getText());
    return { version: versionOf(doc.getText()) };
  }

  async exists(abs: string): Promise<boolean> {
    return !!this.openDoc(abs) || fs.existsSync(abs);
  }

  async delete(abs: string): Promise<void> {
    const uri = vscode.Uri.file(abs);
    const before = (await this.readText(abs))?.text;
    const we = new vscode.WorkspaceEdit();
    we.deleteFile(uri, { ignoreIfNotExists: true, recursive: false }, { needsConfirmation: false, label: 'Tugline delete' });
    await this.own(uri, () => vscode.workspace.applyEdit(we)).catch(() => false);
    if (fs.existsSync(abs)) await diskHost.delete(abs);
    this.touched.delete(uri.toString());
    if (before !== undefined) this.hooks.onAgentWrite?.(abs, before, null);
  }

  /**
   * Save agent-touched documents (not the ones the user had unsaved changes in) before a shell command.
   * v1.1 R8: reports saved / skipped (the user's unsaved changes, which the shell will not see) / failed,
   * so the agent can tell the model and the user which version a check ran against.
   */
  async flushForShell(): Promise<FlushReport> {
    const r = await flushDocuments(vscode.workspace.textDocuments.map(docLike), this.touched, (p) => !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p)));
    this.lastFlushed = r.saved;
    return r;
  }

  /** v1.1 R8: save exactly these documents (the user chose to run the check against the editor version). */
  async saveDocuments(paths: string[]): Promise<FlushReport> {
    const r = await saveDocumentsReport(paths, (p) => {
      const d = this.openDoc(p);
      return d ? docLike(d) : undefined;
    });
    this.lastFlushed = [...this.lastFlushed, ...r.saved];
    return r;
  }

  async diagnostics(abs?: string, opts?: { waitMs?: number }): Promise<Diagnostic[]> {
    if (!abs) return toDiagnostics(vscode.languages.getDiagnostics());
    const uri = vscode.Uri.file(abs);
    if (opts?.waitMs) {
      // Wait for the language server's publish after the edit. A language that never
      // published anything this session probably has no provider: wait briefly only.
      const lang = this.openDoc(abs)?.languageId;
      const ms = !lang || this.watch.languages.has(lang) ? opts.waitMs : Math.min(opts.waitMs, 1000);
      if (!lang || !NO_DIAGNOSTICS.has(lang)) await this.watch.wait(uri, this.lastWrite.get(abs) ?? 0, ms);
    }
    return toDiagnostics([[uri, vscode.languages.getDiagnostics(uri)]]);
  }

  /** v1.2 N46 (review F11): the code_* tools use the editor's language features (see navigate.ts) */
  async navigate(req: NavRequest): Promise<NavResult | undefined> {
    return vscodeNavigate(req);
  }

  async runCommand(cmd: HostCommand): Promise<HostCommandResult | undefined> {
    const r = this.hooks.runner?.();
    return r ? r.run(cmd) : undefined;
  }
}
