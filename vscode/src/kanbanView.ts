/**
 * Kanban view (v1.2 N48 AC4): the task board in VS Code. Each card is an agent session in its own git worktree
 * (src/core/context/worktreeBoard.ts, shared with `tug board`): add a card from a prompt or a GitHub issue, start
 * it, watch its latest activity, open its diff, send it a message, see its base commit and conflicts, merge it
 * (conflict check → permission → verify in a scratch tree → land) or move it to trash. Webview: strict CSP, nonce
 * script, card text set with textContent only.
 */
import * as vscode from 'vscode';
import { Board, cardTaint, type Card } from '../../src/core/context/worktreeBoard.js';
import { EXTERNAL_PRESETS } from '../../src/core/eval/external.js';
import type { HarnessConfig } from '../../src/core/config.js';
import type { PermissionAnswer, PermissionRequest } from '../../src/core/types.js';
import { makeNonce, webviewShell, THEMED_CONTROLS } from './webviewHtml.js';

export interface KanbanHost {
  config(): Promise<HarnessConfig>;
  workspace(): string | undefined;
  log(m: string): void;
  approve(r: PermissionRequest, cardId: string): Promise<PermissionAnswer>;
  /** show a card's patch (a diff document) */
  showDiff(title: string, patch: string): Promise<void>;
}

const STYLE = `body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:8px}
#board{display:flex;gap:8px}.colm{flex:1;min-width:0}.colm h3{font-size:13px;margin:4px 0}
.card{border:1px solid var(--vscode-panel-border);padding:4px;margin-bottom:6px;border-radius:3px}
.card .t{font-weight:600}.card .meta{opacity:.8;font-size:11px;white-space:pre-wrap}.card.conflict{border-color:var(--vscode-errorForeground)}
input,textarea{width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border)}
button{margin:3px 3px 0 0;font-size:11px}`;

const SCRIPT = `const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const COLS = [['Backlog', ['backlog', 'interrupted']], ['Running', ['running']], ['Review', ['review', 'conflict', 'failed']], ['Merged', ['merged']]];
function btn(card, label, type, extra) { const b = document.createElement('button'); b.textContent = label; b.onclick = () => vscode.postMessage(Object.assign({ type, id: card.id }, extra ? extra() : {})); return b; }
function render(cards) {
  const root = $('board'); root.textContent = '';
  for (const [title, states] of COLS) {
    const col = document.createElement('div'); col.className = 'colm';
    const cs = cards.filter((c) => states.includes(c.state));
    const h = document.createElement('h3'); h.textContent = title + ' (' + cs.length + ')'; col.appendChild(h);
    for (const c of cs) {
      const d = document.createElement('div'); d.className = 'card ' + c.state; d.dataset.id = c.id;
      const t = document.createElement('div'); t.className = 't'; t.textContent = c.title; d.appendChild(t);
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.textContent = c.state + ' · base ' + c.base.slice(0, 8) + ' "' + c.baseSubject + '"' + (c.dependsOn.length ? ' · after ' + c.dependsOn.join(', ') : '') + (c.conflicts && c.conflicts.length ? '\\nconflict: ' + c.conflicts.join(', ') : '') + (c.check ? '\\ncheck: ' + c.check.state : '') + (c.agent ? '\\nagent: ' + c.agent : '') + (c.untrusted ? '\\n⚠ untrusted input: ' + c.untrusted : '') + (c.activity ? '\\n' + c.activity : '') + (c.error ? '\\n' + c.error : '');
      d.appendChild(meta);
      if (['backlog', 'interrupted', 'review', 'failed', 'conflict'].includes(c.state)) d.appendChild(btn(c, c.state === 'backlog' ? 'Start' : 'Resume', 'start'));
      if (c.state === 'running') d.appendChild(btn(c, 'Stop', 'stop'));
      if (['review', 'conflict', 'failed', 'interrupted'].includes(c.state)) { d.appendChild(btn(c, 'Diff', 'diff')); d.appendChild(btn(c, 'Merge', 'merge')); d.appendChild(btn(c, 'Message…', 'say')); }
      if (c.sessionId || c.agent) d.appendChild(btn(c, 'Transcript', 'transcript'));
      if (!['merged', 'trashed'].includes(c.state)) { d.appendChild(btn(c, 'Run command…', 'exec')); d.appendChild(btn(c, 'Trash', 'discard')); }
      col.appendChild(d);
    }
    root.appendChild(col);
  }
}
$('add').onclick = () => { vscode.postMessage({ type: 'add', prompt: $('prompt').value, title: $('title').value, issue: $('issue').value, agent: $('agent').value, carryDirty: $('dirty').checked }); $('prompt').value = ''; $('title').value = ''; $('issue').value = ''; };
window.addEventListener('message', (ev) => { const m = ev.data; if (m.type === 'board') render(m.cards); if (m.type === 'notice') $('msg').textContent = m.message; });
vscode.postMessage({ type: 'ready' });`;

// review F12: the external agents a card can run (the arena's presets: Cline, Codex, Aider, OpenHands, …)
const AGENT_OPTIONS = Object.entries(EXTERNAL_PRESETS)
  .map(([k, v]) => `<option value="${k.replace(/[^\w-]/g, '')}">${String(v.title).replace(/[<>&"]/g, '')}</option>`)
  .join('');

const BODY = `<details open><summary>New card</summary>
<label>Prompt<textarea id="prompt" rows="2"></textarea></label><label>Title (optional)<input id="title"></label>
<label>…or GitHub issue (number or URL)<input id="issue"></label><label>Agent<select id="agent"><option value="">Tugline</option>${AGENT_OPTIONS}</select></label><label><input id="dirty" type="checkbox" style="width:auto"> start from my uncommitted changes</label>
<button id="add">Add card</button></details><div id="msg"></div><div id="board"></div>`;

export class KanbanPanel {
  static current: KanbanPanel | undefined;
  readonly panel: vscode.WebviewPanel;
  posted: any[] = [];
  board?: Board;
  /** the last transcript document and command result (tests read them) */
  lastTranscript?: vscode.TextDocument;
  lastExec?: { ran: boolean; exitCode?: number | null; output: string; reason?: string };
  private sub?: () => void;

  static async show(host: KanbanHost): Promise<KanbanPanel> {
    if (KanbanPanel.current) {
      KanbanPanel.current.panel.reveal();
      return KanbanPanel.current;
    }
    const p = (KanbanPanel.current = new KanbanPanel(host));
    await p.open();
    return p;
  }

  private constructor(private host: KanbanHost) {
    this.panel = vscode.window.createWebviewPanel('tugline.kanban', 'Tugline Board', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
    this.panel.webview.html = webviewShell({ title: 'Board', cspSource: this.panel.webview.cspSource, nonce: makeNonce(), style: STYLE + THEMED_CONTROLS, body: BODY, script: SCRIPT });
    this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.sub?.();
      KanbanPanel.current = undefined;
    });
  }

  private async open(): Promise<void> {
    const ws = this.host.workspace();
    if (!ws) return void this.post({ type: 'notice', message: 'Open a folder (a git repository) first.' });
    try {
      this.board = await Board.open(await this.host.config(), ws);
      const onChange = () => this.refresh();
      this.board.on('change', onChange);
      this.sub = () => this.board?.off('change', onChange);
      this.refresh();
    } catch (e) {
      this.post({ type: 'notice', message: (e as Error).message });
    }
  }

  post(m: any): void {
    this.posted.push(m);
    if (this.posted.length > 2000) this.posted.splice(0, 1000);
    void this.panel.webview.postMessage(m);
  }

  refresh(): void {
    // review F8/F9: cards on third-party content, or added by a tainted session, are marked
    if (this.board) this.post({ type: 'board', cards: this.board.list().filter((c) => c.state !== 'trashed').map((c) => ({ ...c, untrusted: cardTaint(c) })) });
  }

  private ui() {
    return {
      onEvent: () => undefined,
      requestPermission: (r: PermissionRequest, id: string) => this.host.approve(r, id).catch(() => ({ decision: 'deny' as const })),
    };
  }

  /** Runs of started cards (tests wait on them). */
  readonly runs = new Map<string, Promise<Card | undefined>>();

  async onMessage(m: any): Promise<void> {
    const b = this.board;
    if (m.type === 'ready') return this.refresh();
    if (!b) return;
    try {
      switch (m.type) {
        case 'add': {
          const c = await b.add({ prompt: m.prompt || undefined, title: m.title || undefined, issue: m.issue || undefined, carryDirty: !!m.carryDirty, agent: m.agent || undefined });
          this.post({ type: 'notice', message: `Added "${c.title}" to Backlog.` });
          break;
        }
        case 'start':
          this.runs.set(m.id, b.start(m.id, { ui: this.ui() }).catch((e: Error) => (this.post({ type: 'notice', message: e.message }), undefined)));
          break;
        case 'say':
          m.text ??= await vscode.window.showInputBox({ title: `Message to card ${m.id}`, prompt: 'The card resumes its session with this message', ignoreFocusOut: true });
          if (m.text) this.runs.set(m.id, b.start(m.id, { ui: this.ui(), followUp: String(m.text) }).catch((e: Error) => (this.post({ type: 'notice', message: e.message }), undefined)));
          break;
        case 'stop':
          b.stop(m.id);
          break;
        case 'diff': {
          const d = await b.diff(m.id);
          const info = await b.baseInfo(m.id);
          await this.host.showDiff(`${m.id} (base ${info.base}${info.behind ? `, ${info.behind} behind HEAD` : ''})`, d.patch || '(no changes)');
          break;
        }
        case 'merge': {
          const r = await b.merge(m.id, { ui: this.ui() });
          this.post({ type: 'notice', message: r.message });
          break;
        }
        case 'discard':
          await b.discard(m.id);
          break;
        // review F12: the card's transcript, and commands in its worktree (permission engine; asks go to the user)
        case 'transcript': {
          const doc = await vscode.workspace.openTextDocument({ content: b.transcript(m.id), language: 'markdown' });
          this.lastTranscript = doc;
          await vscode.window.showTextDocument(doc, { preview: true });
          break;
        }
        case 'exec': {
          m.command ??= await vscode.window.showInputBox({ title: `Run a command in card ${m.id}'s worktree`, prompt: 'Runs under the OS sandbox; the permission rules decide, and asks go to you', ignoreFocusOut: true });
          if (!m.command) break;
          const r = await b.exec(m.id, String(m.command), { ask: async (command, reason) => (await this.host.approve({ id: `exec_${m.id}`, tool: 'bash', kind: 'execute', title: `Run in card ${m.id}: ${command}`, detail: command, reason }, m.id).catch(() => ({ decision: 'deny' as const }))).decision === 'allow' });
          this.lastExec = r;
          this.post({ type: 'notice', message: r.ran ? `[exit ${r.exitCode}] ${r.output.trim().split('\n').slice(-3).join(' · ').slice(0, 300)}` : `not run: ${r.reason}` });
          break;
        }
      }
    } catch (e) {
      this.post({ type: 'notice', message: (e as Error).message });
    }
    this.refresh();
  }
}
