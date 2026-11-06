/**
 * "History" tree in the Tugline sidebar (SPEC B6): the saved sessions of
 * the workspace, newest first. Click resumes (a new chat with the messages
 * loaded); context menu renames or deletes (moves the journal to trash/);
 * the title bar searches prompts and answers.
 */
import * as vscode from 'vscode';
import { favoriteIds, listSessions, searchSessions, type SessionInfo } from './sessions.js';

export class HistoryProvider implements vscode.TreeDataProvider<SessionInfo> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** active search filter */
  filter = '';
  private hits = new Map<string, string>();

  constructor(private home: () => string | undefined, private workspace: () => string | undefined) {}

  refresh(): void {
    this.emitter.fire();
  }

  setFilter(q: string): void {
    this.filter = q.trim();
    void vscode.commands.executeCommand('setContext', 'tugline.historyFiltered', !!this.filter);
    this.refresh();
  }

  sessions(): SessionInfo[] {
    const home = this.home();
    const ws = this.workspace();
    if (!home || !ws) return [];
    // v1.2 N45: favourites first (Cline task history parity)
    const fav = new Set(favoriteIds(home, ws));
    const starredFirst = (xs: SessionInfo[]) => [...xs.filter((x) => fav.has(x.id)), ...xs.filter((x) => !fav.has(x.id))];
    if (!this.filter) return starredFirst(listSessions(home, ws));
    this.hits.clear();
    return starredFirst(
      searchSessions(home, ws, this.filter).map((h) => {
        this.hits.set(h.session.id, `${h.where}: …${h.snippet}…`);
        return h.session;
      }),
    );
  }

  getChildren(el?: SessionInfo): SessionInfo[] {
    return el ? [] : this.sessions();
  }

  getTreeItem(s: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(s.title, vscode.TreeItemCollapsibleState.None);
    item.id = s.id;
    item.description = new Date(s.mtime).toLocaleString();
    item.tooltip = new vscode.MarkdownString(`**${s.title}**\n\n${this.hits.get(s.id) ?? s.firstPrompt.slice(0, 300)}\n\n\`${s.id}\``);
    const fav = favoriteIds(this.home() ?? '', this.workspace() ?? '').includes(s.id);
    item.contextValue = fav ? 'tugline.session.favorite' : 'tugline.session';
    item.iconPath = new vscode.ThemeIcon(fav ? 'star-full' : 'comment-discussion');
    item.command = { command: 'tugline.history.resume', title: 'Resume', arguments: [s] };
    return item;
  }
}
