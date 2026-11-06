/**
 * "Agents" tree in the Tugline sidebar (v1.1 N12): every session (each
 * chat, and the background jobs it started) with its status, completion state,
 * pending approvals, diff stats and actions:
 *   - click / Open: show that chat in the panel;
 *   - Answer: allow or deny a pending approval (or answer a question) from the view;
 *   - Stop: abort the run;
 *   - Merge / Discard (worktree sessions): see worktreeSession.ts.
 * "New session in a worktree" starts a chat whose agent works in `oh/<id>`.
 *
 * Status comes from the pure reducer in agents.ts, fed by ChatViewProvider's
 * `sessionHook`.
 */
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chat.js';
import { jobRow, newRow, rowView, sessionReduce, teamReduce, teamRows, type SessionAction, type SessionRow, type TeamView } from './agents.js';
import { discardSession, mergeSession, newSessionWorktree, worktreeDiffStats, type Worktree } from './worktreeSession.js';
import { commandWrapperFor } from '../../src/core/tools/shell.js';

export class AgentsView implements vscode.TreeDataProvider<SessionRow>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  readonly rows = new Map<string, SessionRow>();
  /** worktrees of sessions, kept after their chat closed so Merge / Discard stay possible */
  private worktrees = new Map<string, Worktree>();
  private subs: vscode.Disposable[] = [];
  private diffTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimer?: NodeJS.Timeout;
  /** v1.2 N34: the team each chat leads (members, tasks, messages), from its `team` events */
  readonly teams = new Map<string, TeamView>();

  constructor(private provider: ChatViewProvider, private log: (m: string) => void, private workspace: () => string | undefined) {
    provider.sessionHook = (chatId, a) => this.apply(chatId, a);
    this.subs.push(provider.onChatsChanged(() => this.syncChats()), this.emitter);
    this.syncChats();
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    for (const t of this.diffTimers.values()) clearTimeout(t);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private refresh(): void {
    // coalesce bursts of events (deltas) into one tree refresh
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.emitter.fire();
    }, 50);
  }

  /** Add rows for new chats, drop rows of closed chats (worktree sessions stay until merged or discarded), follow titles. */
  syncChats(): void {
    const live = new Set(this.provider.chats.keys());
    for (const c of this.provider.chats.values()) {
      const r = this.rows.get(c.id);
      if (c.worktree) this.worktrees.set(c.id, c.worktree);
      if (!r) this.rows.set(c.id, newRow(c.id, c.title, { worktree: c.worktree ? { branch: c.worktree.branch, path: c.worktree.path } : undefined }));
      else if (r.title !== c.title) this.rows.set(c.id, { ...r, title: c.title });
    }
    for (const [id, r] of [...this.rows]) {
      const owner = r.kind !== 'chat' ? r.parent! : id;
      if (!live.has(owner) && !this.worktrees.has(owner)) this.rows.delete(id);
    }
    this.refresh();
  }

  apply(chatId: string, a: SessionAction): void {
    if (a.type === 'event' && a.e.type === 'team') {
      // N34: live team rows under the lead's chat
      const t = teamReduce(this.teams.get(chatId), a.e)!;
      this.teams.set(chatId, t);
      for (const [id, r] of [...this.rows]) if (r.parent === chatId && (r.kind === 'member' || r.kind === 'task' || r.kind === 'message')) this.rows.delete(id);
      for (const r of teamRows(chatId, t)) this.rows.set(r.id, r);
      this.refresh();
      return;
    }
    if (a.type === 'event' && a.e.type === 'job') {
      const id = `job:${a.e.jobId}`;
      const cur = this.rows.get(id);
      if (a.e.phase === 'output') return;
      this.rows.set(id, cur ? sessionReduce(cur, a) : jobRow(a.e, chatId));
      this.refresh();
      return;
    }
    if (!this.rows.has(chatId)) this.syncChats();
    const r = this.rows.get(chatId);
    if (!r) return;
    this.rows.set(chatId, sessionReduce(r, a));
    if (a.type === 'event' && (a.e.type === 'tool_end' || a.e.type === 'run_end' || a.e.type === 'diff_pending')) this.scheduleDiff(chatId);
    this.refresh();
  }

  /** Recompute a worktree session's diff stats (debounced; git runs off the event path). */
  private scheduleDiff(chatId: string, ms = 300): Promise<void> {
    const wt = this.worktrees.get(chatId);
    if (!wt) return Promise.resolve();
    clearTimeout(this.diffTimers.get(chatId));
    return new Promise((resolve) => {
      this.diffTimers.set(
        chatId,
        setTimeout(() => {
          this.diffTimers.delete(chatId);
          void worktreeDiffStats(wt, this.scrub())
            .then((diff) => {
              const r = this.rows.get(chatId);
              if (r) this.rows.set(chatId, sessionReduce(r, { type: 'diff', diff }));
              this.refresh();
            })
            .catch((e) => this.log(`[agents] diff stats ${wt.branch}: ${(e as Error).message}`))
            .finally(resolve);
        }, ms),
      );
    });
  }

  /** Tests and the refresh button: recompute every worktree session's diff now. */
  async refreshDiffs(): Promise<void> {
    await Promise.all([...this.worktrees.keys()].map((id) => this.scheduleDiff(id, 0)));
    this.emitter.fire();
  }

  private scrub(): string[] {
    return this.provider.lastConfig?.shell.scrubEnv ?? [];
  }

  // ------------------------------------------------------------ tree

  getChildren(el?: SessionRow): SessionRow[] {
    const all = [...this.rows.values()];
    if (el) return all.filter((r) => r.kind !== 'chat' && r.parent === el.id);
    return all.filter((r) => r.kind === 'chat' || !this.rows.has(r.parent ?? ''));
  }

  getTreeItem(r: SessionRow): vscode.TreeItem {
    const v = rowView(r);
    const hasJobs = [...this.rows.values()].some((x) => x.kind !== 'chat' && x.parent === r.id);
    const item = new vscode.TreeItem(v.label, hasJobs ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    item.id = r.id;
    item.description = v.description;
    item.tooltip = v.tooltip;
    item.contextValue = v.contextValue;
    item.iconPath = new vscode.ThemeIcon(v.icon.replace('~spin', ''), r.status === 'blocked' ? new vscode.ThemeColor('problemsWarningIcon.foreground') : r.status === 'failed' ? new vscode.ThemeColor('problemsErrorIcon.foreground') : undefined);
    if (v.icon.endsWith('~spin')) item.iconPath = new vscode.ThemeIcon('sync~spin');
    if (r.kind === 'chat') item.command = { command: 'tugline.agents.open', title: 'Open', arguments: [r] };
    return item;
  }

  // ------------------------------------------------------------ actions

  private rowArg(a?: SessionRow | string): SessionRow | undefined {
    if (!a) return this.provider.activeId ? this.rows.get(this.provider.activeId) : undefined;
    return typeof a === 'string' ? this.rows.get(a) : this.rows.get(a.id);
  }

  async open(a?: SessionRow | string): Promise<void> {
    const r = this.rowArg(a);
    if (!r) return;
    const id = r.kind !== 'chat' ? r.parent! : r.id;
    if (this.provider.chats.has(id)) {
      this.provider.switchChat(id);
      await vscode.commands.executeCommand('tugline.chat.focus');
    } else if (this.worktrees.has(id)) {
      void vscode.window.showInformationMessage(`Tugline: this session's chat was closed. Its work is in ${this.worktrees.get(id)!.path} (${this.worktrees.get(id)!.branch}); Merge or Discard it from the Agents view.`);
    }
  }

  stop(a?: SessionRow | string): void {
    const r = this.rowArg(a);
    if (r) this.provider.stop(r.kind !== 'chat' ? r.parent! : r.id);
  }

  /**
   * Answer the first pending request of a session. `answer` skips the quick
   * pick (tests, keybindings): 'allow' | 'always' | 'deny' for approvals,
   * true/false for plans, text for questions.
   */
  async answer(a?: SessionRow | string, answer?: unknown): Promise<boolean> {
    const r = this.rowArg(a);
    const req = r?.blocked[0];
    if (!r || !req) return false;
    let reply: unknown;
    if (req.kind === 'permission') {
      const decision = (answer as string | undefined) ?? (await vscode.window.showQuickPick(['allow', 'always', 'deny'], { title: `${r.title}: ${req.title}`, ignoreFocusOut: true }));
      if (!decision) return false;
      reply = { decision, feedback: decision === 'deny' ? 'denied from the Agents view' : undefined };
    } else if (req.kind === 'plan') {
      const ok = answer ?? ((await vscode.window.showQuickPick(['Approve', 'Reject'], { title: `${r.title}: approve the plan?` })) === 'Approve');
      reply = !!ok;
    } else {
      const text = (answer as string | undefined) ?? (await vscode.window.showInputBox({ title: `${r.title}: ${req.title}`, ignoreFocusOut: true }));
      if (text === undefined) return false;
      reply = text;
    }
    return this.provider.answerPending(req.requestId, reply);
  }

  /** A new chat whose agent works in its own worktree (`oh/<id>` off HEAD). */
  async newWorktreeSession(o: { title?: string; id?: string } = {}): Promise<string | undefined> {
    const ws = this.workspace();
    if (!ws) {
      void vscode.window.showWarningMessage('Tugline: open a folder first.');
      return undefined;
    }
    let wt: Worktree;
    try {
      wt = await newSessionWorktree(ws, o.id);
    } catch (e) {
      void vscode.window.showErrorMessage(`Tugline: could not create a worktree: ${(e as Error).message}`);
      return undefined;
    }
    const chat = this.provider.newChat({ worktree: wt, title: o.title ?? `Worktree ${wt.branch}` });
    this.worktrees.set(chat.id, wt);
    this.syncChats();
    this.log(`[agents] ${chat.id} works in ${wt.path} (${wt.branch})`);
    await vscode.commands.executeCommand('tugline.chat.focus');
    return chat.id;
  }

  private async endSession(r: SessionRow, how: 'merge' | 'discard', confirmed: boolean): Promise<string | undefined> {
    const wt = this.worktrees.get(r.id);
    if (!wt) return undefined;
    const chat = this.provider.chats.get(r.id);
    if (chat?.busy || chat?.agent?.isRunning) {
      void vscode.window.showWarningMessage('Tugline: stop the session before merging or discarding it.');
      return undefined;
    }
    if (!confirmed) {
      const what = how === 'merge' ? `Merge ${wt.branch} into your current branch?` : `Discard ${wt.branch}? Its worktree and every change on the branch are deleted.`;
      const pick = await vscode.window.showWarningMessage(`Tugline: ${what}`, { modal: true }, how === 'merge' ? 'Merge' : 'Discard');
      if (!pick) return undefined;
    }
    const cfg = chat?.agent?.config ?? this.provider.lastConfig;
    const res = how === 'merge' ? await mergeSession(wt, { message: `Tugline session: ${r.title}`, wrap: cfg ? commandWrapperFor(cfg) : undefined, scrub: this.scrub() }) : await discardSession(wt, this.scrub());
    this.log(`[agents] ${how} ${wt.branch}: ${res.message}`);
    if (!res.ok) {
      void vscode.window.showErrorMessage(`Tugline: ${res.message}`);
      return res.message;
    }
    this.worktrees.delete(r.id);
    if (chat) await this.provider.closeChat(r.id);
    this.rows.delete(r.id);
    this.syncChats();
    void vscode.window.showInformationMessage(`Tugline: ${res.message}`);
    return res.message;
  }

  merge(a?: SessionRow | string, confirmed = false): Promise<string | undefined> {
    const r = this.rowArg(a);
    return r ? this.endSession(r, 'merge', confirmed) : Promise.resolve(undefined);
  }

  discard(a?: SessionRow | string, confirmed = false): Promise<string | undefined> {
    const r = this.rowArg(a);
    return r ? this.endSession(r, 'discard', confirmed) : Promise.resolve(undefined);
  }
}
