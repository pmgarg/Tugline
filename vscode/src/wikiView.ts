/**
 * WS12 N8: `Tugline: Open Wiki` — the generated wiki (.tugline/wiki)
 * in a webview panel. Wiki links navigate inside the panel; citation links open
 * the cited source lines in the editor (only files under the workspace). If no
 * wiki exists yet, the command offers to build it with the configured model.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../../src/core/config.js';
import { buildWiki, wikiDir } from '../../src/core/docs/wiki.js';
import { readablePath } from '../../src/core/docs/inventory.js';
import { wikiWebviewHtml } from './wikiHtml.js';

export async function openWiki(ws: string, config: () => Promise<HarnessConfig>, log: (m: string) => void): Promise<vscode.WebviewPanel | undefined> {
  const cfg = await config();
  const dir = wikiDir(cfg, ws);
  if (!fs.existsSync(path.join(dir, 'index.md'))) {
    const pick = await vscode.window.showInformationMessage('Tugline: this workspace has no wiki yet. Build it now with your configured model? (map-reduce over the source; may take a while on a local model)', 'Build wiki');
    if (pick !== 'Build wiki') return undefined;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Tugline: building the wiki…', cancellable: false }, async (p) => {
        await buildWiki({ config: cfg, workspace: ws, log: (m) => (log(m), p.report({ message: m.slice(0, 80) })) });
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`Tugline: wiki build failed — ${(e as Error).message}`);
      return undefined;
    }
  }
  const panel = vscode.window.createWebviewPanel('tugline.wiki', 'Tugline Wiki', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let current = 'index.md';
  const show = (page: string) => {
    current = page.split('#')[0] || current;
    panel.webview.html = wikiWebviewHtml(ws, dir, current, nonce, panel.webview.cspSource);
  };
  panel.webview.onDidReceiveMessage(async (m: { type: string; target: string }) => {
    if (m.type === 'wiki') show(m.target);
    else if (m.type === 'src') {
      const [rel, hash] = m.target.split('#');
      if (!readablePath(ws, rel)) return;
      const line = Number(/^L(\d+)/.exec(hash ?? '')?.[1] ?? 1) - 1;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(ws, rel)));
      const pos = new vscode.Position(Math.max(0, line), 0);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(pos, pos), preview: true });
    }
  });
  show(current);
  return panel;
}
