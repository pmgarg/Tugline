/**
 * v1.2 N46 (review F11): the `code_*` tools use the editor's language features in VS Code. The host's `navigate`
 * maps the N3 contract (src/core/host/workspace.ts NavRequest) onto VS Code's provider commands:
 *   definition → vscode.executeDefinitionProvider, references → executeReferenceProvider,
 *   implementation / typeDefinition → executeImplementationProvider / executeTypeDefinitionProvider,
 *   documentSymbols / workspaceSymbols → executeDocumentSymbolProvider / executeWorkspaceSymbolProvider,
 *   hover → executeHoverProvider, rename → executeDocumentRenameProvider (edits only, never applied),
 *   incoming/outgoingCalls → prepareCallHierarchy + provideIncomingCalls / provideOutgoingCalls,
 *   codeActions → executeCodeActionProvider (edits flattened; commands are never executed).
 * Undefined when no provider answers, so the core falls back to its own LSP client, then name matching.
 * Lines and columns are 1-based in the contract, 0-based in VS Code.
 */
import * as vscode from 'vscode';
import type { NavAction, NavCall, NavEdit, NavLocation, NavRequest, NavResult } from '../../src/core/host/workspace.js';

const SYMBOL_KIND = (k: vscode.SymbolKind): string => (vscode.SymbolKind[k] ?? 'symbol').toLowerCase();

const pos = (r: NavRequest): vscode.Position => new vscode.Position(Math.max(0, (r.line ?? 1) - 1), Math.max(0, (r.col ?? 1) - 1));

function loc(uri: vscode.Uri, range: vscode.Range, extra: Partial<NavLocation> = {}): NavLocation {
  return { path: uri.fsPath, line: range.start.line + 1, col: range.start.character + 1, endLine: range.end.line + 1, ...extra };
}

function fromLocations(x: (vscode.Location | vscode.LocationLink)[] | undefined): NavLocation[] {
  return (x ?? []).map((l) => ('targetUri' in l ? loc(l.targetUri, l.targetSelectionRange ?? l.targetRange) : loc(l.uri, l.range)));
}

function flattenSymbols(uri: vscode.Uri, syms: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined, container?: string, out: NavLocation[] = []): NavLocation[] {
  for (const s of syms ?? []) {
    if ('location' in s) out.push(loc(s.location.uri, s.location.range, { name: s.name, kind: SYMBOL_KIND(s.kind), ...(s.containerName ? { container: s.containerName } : {}) }));
    else {
      out.push(loc(uri, s.selectionRange, { name: s.name, kind: SYMBOL_KIND(s.kind), ...(container ? { container } : {}) }));
      flattenSymbols(uri, s.children, s.name, out);
    }
  }
  return out;
}

function edits(we: vscode.WorkspaceEdit | undefined): NavEdit[] {
  const out: NavEdit[] = [];
  for (const [uri, list] of we?.entries() ?? []) for (const e of list) out.push({ path: uri.fsPath, line: e.range.start.line + 1, col: e.range.start.character + 1, endLine: e.range.end.line + 1, endCol: e.range.end.character + 1, newText: e.newText });
  return out;
}

function hoverText(h: vscode.Hover[] | undefined): string | undefined {
  const parts = (h ?? []).flatMap((x) => x.contents.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : String(c))));
  const t = parts.join('\n\n').trim();
  return t || undefined;
}

export async function vscodeNavigate(r: NavRequest, exec: <T>(cmd: string, ...args: unknown[]) => Thenable<T> = vscode.commands.executeCommand): Promise<NavResult | undefined> {
  const uri = r.path ? vscode.Uri.file(r.path) : undefined;
  const some = <T>(xs: T[] | undefined): T[] | undefined => (xs && xs.length ? xs : undefined);
  switch (r.op) {
    case 'definition':
    case 'references':
    case 'implementation':
    case 'typeDefinition': {
      if (!uri) return undefined;
      const cmd = { definition: 'vscode.executeDefinitionProvider', references: 'vscode.executeReferenceProvider', implementation: 'vscode.executeImplementationProvider', typeDefinition: 'vscode.executeTypeDefinitionProvider' }[r.op];
      const l = some(fromLocations(await exec<(vscode.Location | vscode.LocationLink)[]>(cmd, uri, pos(r))));
      return l ? { locations: l } : undefined;
    }
    case 'documentSymbols': {
      if (!uri) return undefined;
      const l = some(flattenSymbols(uri, await exec<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', uri)));
      return l ? { locations: l } : undefined;
    }
    case 'workspaceSymbols': {
      const l = some(flattenSymbols(vscode.Uri.file('/'), await exec<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', r.query ?? '')));
      return l ? { locations: l } : undefined;
    }
    case 'hover': {
      if (!uri) return undefined;
      const h = hoverText(await exec<vscode.Hover[]>('vscode.executeHoverProvider', uri, pos(r)));
      return h ? { hover: h } : undefined;
    }
    case 'rename': {
      if (!uri || !r.newName) return undefined;
      const e = some(edits(await exec<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, pos(r), r.newName)));
      return e ? { edits: e } : undefined;
    }
    case 'incomingCalls':
    case 'outgoingCalls': {
      if (!uri) return undefined;
      const items = (await exec<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos(r))) ?? [];
      const calls: NavCall[] = [];
      for (const item of items) {
        if (r.op === 'incomingCalls') {
          for (const c of (await exec<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item)) ?? [])
            calls.push({ name: c.from.name, kind: SYMBOL_KIND(c.from.kind), path: c.from.uri.fsPath, line: c.from.selectionRange.start.line + 1, col: c.from.selectionRange.start.character + 1, at: c.fromRanges.map((x) => ({ line: x.start.line + 1, col: x.start.character + 1 })) });
        } else {
          for (const c of (await exec<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item)) ?? [])
            calls.push({ name: c.to.name, kind: SYMBOL_KIND(c.to.kind), path: c.to.uri.fsPath, line: c.to.selectionRange.start.line + 1, col: c.to.selectionRange.start.character + 1, at: c.fromRanges.map((x) => ({ line: x.start.line + 1, col: x.start.character + 1 })) });
        }
      }
      return calls.length ? { calls } : undefined;
    }
    case 'codeActions': {
      if (!uri) return undefined;
      const range = new vscode.Range(pos(r), new vscode.Position(Math.max(0, (r.endLine ?? r.line ?? 1) - 1), Math.max(0, (r.endCol ?? 10_000) - 1)));
      const acts = (await exec<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', uri, range)) ?? [];
      const out: NavAction[] = acts.map((a) => {
        if (typeof (a as vscode.Command).command === 'string') return { title: a.title, command: (a as vscode.Command).command };
        const ca = a as vscode.CodeAction;
        return { title: ca.title, ...(ca.kind ? { kind: ca.kind.value } : {}), ...(ca.edit ? { edits: edits(ca.edit) } : {}), ...(ca.command ? { command: ca.command.command } : {}) };
      });
      return out.length ? { actions: out } : undefined;
    }
  }
  return undefined;
}
