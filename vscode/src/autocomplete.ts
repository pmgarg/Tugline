/**
 * Tab autocomplete (SPEC B14), VS Code adapter over the pure `fim.ts` core.
 * Registered only when `tugline.autocomplete.enabled` is on; toggling the
 * setting registers/unregisters it.
 */
import * as vscode from 'vscode';
import { completeFim, registerAutocomplete, type FimDeps } from './fim.js';

const MAX_PREFIX = 6000;
const MAX_SUFFIX = 2000;

export function fimProvider(deps: FimDeps): vscode.InlineCompletionItemProvider {
  return {
    async provideInlineCompletionItems(doc, pos, ctx, token) {
      if (ctx.selectedCompletionInfo) return [];
      const offset = doc.offsetAt(pos);
      const text = doc.getText();
      const prefix = text.slice(Math.max(0, offset - MAX_PREFIX), offset);
      const suffix = text.slice(offset, offset + MAX_SUFFIX);
      const out = await completeFim(deps, { prefix, suffix, path: vscode.workspace.asRelativePath(doc.uri) }, token);
      if (!out || token.isCancellationRequested) return [];
      return [new vscode.InlineCompletionItem(out, new vscode.Range(pos, pos))];
    },
  };
}

export class AutocompleteController implements vscode.Disposable {
  private reg?: { dispose(): void };
  /** for tests */
  get registered(): boolean {
    return !!this.reg;
  }
  constructor(private enabled: () => boolean, private deps: FimDeps) {
    this.refresh();
  }
  refresh(): void {
    this.reg?.dispose();
    this.reg = registerAutocomplete(vscode.languages, this.enabled(), fimProvider(this.deps));
  }
  dispose(): void {
    this.reg?.dispose();
  }
}
