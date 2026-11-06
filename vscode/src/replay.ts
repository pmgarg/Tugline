/**
 * Replay viewer (SPEC E7, VS Code part): shows the `tug replay <run> --html`
 * report of a recorded browser run in a webview. The report is static (no
 * scripts, everything escaped by the renderer); the webview gets no script
 * permission at all.
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';
import { readTrajectory } from '../../src/core/automation/recorder/trajectory.js';
import { renderReplayHtml } from '../../src/core/automation/recorder/html.js';

function replayRunsRoot(workspace: string): string {
  return path.join(workspace, '.tugline', 'runs');
}

export function listRuns(workspace: string): { dir: string; name: string; mtime: number }[] {
  const root = replayRunsRoot(workspace);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'trajectory.jsonl')))
    .map((e) => ({ dir: path.join(root, e.name), name: e.name, mtime: fs.statSync(path.join(root, e.name, 'trajectory.jsonl')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Same output as `tug replay <run> --html`: writes <run>/report.html and returns its content. */
export function replayHtml(runDir: string): string {
  const { meta, steps } = readTrajectory(runDir);
  const html = renderReplayHtml(meta, steps);
  fs.writeFileSync(path.join(runDir, 'report.html'), html);
  return html;
}

/** Wrap the report with a CSP that forbids scripts and remote content. */
export function sandboxedHtml(html: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline';">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}${csp}`) : `<!DOCTYPE html><html><head>${csp}</head><body>${html}</body></html>`;
}

export async function openReplay(workspace: string | undefined, runDir?: string): Promise<vscode.WebviewPanel | undefined> {
  if (!workspace) {
    void vscode.window.showWarningMessage('Tugline: open a folder first.');
    return undefined;
  }
  let dir = runDir;
  if (!dir) {
    const runs = listRuns(workspace);
    if (!runs.length) {
      void vscode.window.showInformationMessage('Tugline: no recorded browser runs in .tugline/runs/ yet.');
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      runs.map((r) => ({ label: r.name, description: new Date(r.mtime).toLocaleString(), dir: r.dir })),
      { title: 'Tugline: open a recorded browser run' },
    );
    if (!pick) return undefined;
    dir = pick.dir;
  }
  const panel = vscode.window.createWebviewPanel('tugline.replay', `Replay: ${path.basename(dir)}`, vscode.ViewColumn.Active, { enableScripts: false, localResourceRoots: [] });
  panel.webview.html = sandboxedHtml(replayHtml(dir));
  return panel;
}
