/**
 * Arena view (v1.2 N47 AC3): one prompt, several models or agents, live side-by-side streams, the harness check
 * and the user's pick. Drives the core arena (src/core/eval/arena.ts): contestants run in parallel worktrees with
 * their own budget, sandbox and protected paths; the pick is applied through the task board's merge (conflict
 * check, dirty-work check, the permission engine, verify). Webview: strict CSP, nonce script, text only (no HTML
 * from model output is ever rendered).
 */
import * as vscode from 'vscode';
import { applyArenaWinner, runArena, type ArenaControl, type ArenaResult } from '../../src/core/eval/arena.js';
import type { HarnessConfig } from '../../src/core/config.js';
import type { PermissionAnswer, PermissionRequest } from '../../src/core/types.js';
import { makeNonce, webviewShell, THEMED_CONTROLS } from './webviewHtml.js';

export interface ArenaHost {
  config(): Promise<HarnessConfig>;
  workspace(): string | undefined;
  log(m: string): void;
  /** approvals (merge, contestants' asks): a modal in the editor; tests replace it */
  approve(r: PermissionRequest, who: string): Promise<PermissionAnswer>;
}

const STYLE = `body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:8px}
#cols{display:flex;gap:8px;align-items:stretch}.col{flex:1;min-width:0;border:1px solid var(--vscode-panel-border);padding:4px}
.col h3{margin:2px 0;font-size:13px}.col pre{white-space:pre-wrap;max-height:50vh;overflow:auto;font-size:12px}
input,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{margin:4px 4px 0 0}.pass{color:var(--vscode-testing-iconPassed)}.fail{color:var(--vscode-testing-iconFailed)}`;

const SCRIPT = `const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const cols = {};
function col(label, name) {
  if (cols[label]) return cols[label];
  const d = document.createElement('div'); d.className = 'col';
  const h = document.createElement('h3'); h.textContent = label + ' ' + name; d.appendChild(h);
  const st = document.createElement('div'); st.className = 'status'; d.appendChild(st);
  const pre = document.createElement('pre'); d.appendChild(pre);
  const pick = document.createElement('button'); pick.textContent = 'Pick ' + label; pick.disabled = true;
  pick.onclick = () => vscode.postMessage({ type: 'pick', label });
  d.appendChild(pick);
  $('cols').appendChild(d);
  return (cols[label] = { d, h, st, pre, pick });
}
$('start').onclick = () => vscode.postMessage({ type: 'start', prompt: $('prompt').value, models: $('models').value, agents: $('agents').value, check: $('check').value });
$('stop').onclick = () => vscode.postMessage({ type: 'stop' });
window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'started') { $('cols').textContent = ''; for (const k of Object.keys(cols)) delete cols[k]; for (const c of m.contestants) col(c.label, c.name); }
  if (m.type === 'stream') { const c = col(m.label, ''); c.pre.textContent += m.text; c.pre.scrollTop = c.pre.scrollHeight; }
  if (m.type === 'status') { const c = col(m.label, ''); c.st.textContent = m.text; }
  if (m.type === 'result') for (const e of m.entries) { const c = col(e.label, e.model); c.st.textContent = e.outcome + ' · ' + e.files + ' file(s) +' + e.added + '/-' + e.removed + ' · ' + e.tokens + ' tok'; c.st.className = 'status ' + e.outcome; c.pick.disabled = !e.branch; }
  if (m.type === 'picked') $('msg').textContent = m.message;
  if (m.type === 'error') $('msg').textContent = 'Error: ' + m.message;
});
vscode.postMessage({ type: 'ready' });`;

const BODY = `<label>Task<textarea id="prompt" rows="3"></textarea></label>
<label>Models (comma separated: profiles or model ids)<input id="models"></label>
<label>External agents (optional: cline, aider, …)<input id="agents"></label>
<label>Check command (optional; default: the project's check)<input id="check"></label>
<button id="start" class="primary">Start</button><button id="stop">Stop</button><div id="msg"></div><div id="cols"></div>`;

export class ArenaPanel {
  static current: ArenaPanel | undefined;
  readonly panel: vscode.WebviewPanel;
  /** test hooks */
  posted: any[] = [];
  result?: ArenaResult;
  running?: Promise<ArenaResult | undefined>;
  private control: ArenaControl = {};
  private abort?: AbortController;

  static show(host: ArenaHost): ArenaPanel {
    if (ArenaPanel.current) {
      ArenaPanel.current.panel.reveal();
      return ArenaPanel.current;
    }
    return (ArenaPanel.current = new ArenaPanel(host));
  }

  private constructor(private host: ArenaHost) {
    this.panel = vscode.window.createWebviewPanel('tugline.arena', 'Tugline Arena', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.panel.webview.html = webviewShell({ title: 'Arena', cspSource: this.panel.webview.cspSource, nonce: makeNonce(), style: STYLE + THEMED_CONTROLS, body: BODY, script: SCRIPT });
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.abort?.abort();
      ArenaPanel.current = undefined;
    });
  }

  post(m: any): void {
    this.posted.push(m);
    if (this.posted.length > 5000) this.posted.splice(0, 2500);
    void this.panel.webview.postMessage(m);
  }

  async onMessage(m: any): Promise<void> {
    try {
      if (m.type === 'start') this.running = this.start(m);
      else if (m.type === 'stop') {
        this.control.stop?.(m.label);
        if (!m.label) this.abort?.abort();
      } else if (m.type === 'pick') await this.pick(String(m.label));
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
    }
  }

  private async start(m: any): Promise<ArenaResult | undefined> {
    const ws = this.host.workspace();
    if (!ws) throw new Error('open a folder first');
    const split = (s: unknown) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const models = split(m.models);
    const agents = split(m.agents);
    const config = await this.host.config();
    this.post({ type: 'started', contestants: [...models, ...agents].map((name, i) => ({ label: String.fromCharCode(65 + i), name })) });
    this.abort = new AbortController();
    this.control = {};
    try {
      const r = await runArena({
        config,
        workspace: ws,
        models,
        agents,
        prompt: String(m.prompt ?? ''),
        check: m.check ? String(m.check) : undefined,
        mode: 'acceptEdits',
        signal: this.abort.signal,
        control: this.control,
        // a failing approval UI (a dialog that cannot open) is a "no", never an error that kills the contestant
        requestPermission: (req, who) => this.host.approve(req, who).catch(() => ({ decision: 'deny' as const })),
        onEvent: (label, e) => {
          if (e.type === 'text_delta') this.post({ type: 'stream', label, text: e.text });
          else if (e.type === 'tool_start') this.post({ type: 'stream', label, text: `\n⏺ ${e.title}\n` });
          else if (e.type === 'arena_status') this.post({ type: 'status', label, text: `${e.state}${e.detail ? `: ${e.detail}` : ''}` });
        },
        log: (s) => this.host.log(`[arena] ${s}`),
      });
      this.result = r;
      this.post({ type: 'result', run: r.run, entries: r.ranking.map((e) => ({ label: e.label, model: e.model, outcome: e.outcome, files: e.files, added: e.added, removed: e.removed, tokens: e.tokens, branch: e.branch, error: e.error })) });
      return r;
    } catch (e) {
      this.post({ type: 'error', message: (e as Error).message });
      return undefined;
    }
  }

  private async pick(label: string): Promise<void> {
    const r = this.result ?? (await this.running);
    const ws = this.host.workspace();
    if (!r || !ws) throw new Error('no finished arena to pick from');
    const res = await applyArenaWinner({ config: await this.host.config(), workspace: ws, run: r, pick: label, ui: { requestPermission: (req) => this.host.approve(req, label).catch(() => ({ decision: 'deny' as const })) } });
    this.post({ type: 'picked', label, merged: res.merged, message: res.message });
  }
}
