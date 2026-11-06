/**
 * Diff-line comments (v1.1 N14), VS Code part: a CommentController on files
 * with pending agent changes (B2). The "+" in the gutter appears on the lines
 * of the agent's hunks; a comment is added with "Add Comment" and stays as a
 * draft until "Send N comments to the agent" (status bar, or the thread's
 * title bar) delivers all of them:
 *   - grouped by the chat whose agent made the change;
 *   - one steer when that agent is running (D12: injected at the next tool
 *     boundary), else one new prompt;
 *   - then the threads are cleared.
 */
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chat.js';
import type { ReviewManager } from './review.js';
import { buildReviewCommentMessage, commentRanges, type ReviewComment } from './reviewComments.js';

export class ReviewCommentsController implements vscode.Disposable {
  readonly controller: vscode.CommentController;
  private threads = new Set<vscode.CommentThread>();
  private status: vscode.StatusBarItem;
  private subs: vscode.Disposable[] = [];
  /** the last messages delivered (tests): chat id, how, text */
  lastSent: { chatId: string; via: 'steer' | 'prompt'; text: string }[] = [];

  constructor(private review: ReviewManager, private provider: ChatViewProvider) {
    this.controller = vscode.comments.createCommentController('tugline.review', 'Tugline review');
    this.controller.options = { prompt: 'Comment for the agent…', placeHolder: 'What should the agent change here?' };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (doc) => {
        if (!this.review.has(doc.uri)) return [];
        const hunks = await this.review.hunks(doc.uri.toString());
        return commentRanges(hunks, doc.lineCount).map(([a, b]) => new vscode.Range(a, 0, b, doc.lineAt(b).text.length));
      },
    };
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'tugline.reviewComments.send';
    this.subs.push(this.controller, this.status);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }

  get count(): number {
    let n = 0;
    for (const t of this.threads) n += t.comments.length;
    return n;
  }

  private update(): void {
    const n = this.count;
    void vscode.commands.executeCommand('setContext', 'tugline.reviewCommentCount', n);
    this.status.text = `$(comment) Send ${n} comment${n === 1 ? '' : 's'} to the agent`;
    this.status.tooltip = 'Tugline: deliver your review comments to the agent that made these changes';
    if (n) this.status.show();
    else this.status.hide();
  }

  private comment(body: string): vscode.Comment {
    return { body, mode: vscode.CommentMode.Preview, author: { name: 'You' }, contextValue: 'tugline.draft' };
  }

  /** "Add Comment" on a new or existing thread (the comment widget's button). */
  reply(r: vscode.CommentReply): void {
    if (!r.text.trim()) return;
    const t = r.thread;
    t.comments = [...t.comments, this.comment(r.text)];
    t.canReply = true;
    t.label = 'For the agent (not sent yet)';
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.add(t);
    this.update();
  }

  /** Programmatic comment (tests, other commands). Lines are 1-based. */
  add(uri: vscode.Uri, line: number, body: string, endLine = line): vscode.CommentThread {
    const t = this.controller.createCommentThread(uri, new vscode.Range(line - 1, 0, endLine - 1, 0), []);
    this.reply({ thread: t, text: body });
    return t;
  }

  deleteThread(t: vscode.CommentThread): void {
    this.threads.delete(t);
    t.dispose();
    this.update();
  }

  /** Clear without sending. */
  clear(): void {
    for (const t of this.threads) t.dispose();
    this.threads.clear();
    this.update();
  }

  private async collect(): Promise<Map<string, ReviewComment[]>> {
    const byChat = new Map<string, ReviewComment[]>();
    for (const t of this.threads) {
      if (!t.comments.length) continue;
      const doc = await vscode.workspace.openTextDocument(t.uri);
      const range = t.range ?? new vscode.Range(0, 0, 0, 0);
      const startLine = range.start.line;
      const endLine = Math.max(startLine, range.end.line);
      const code = Array.from({ length: Math.min(doc.lineCount - 1, endLine) - startLine + 1 }, (_, i) => doc.lineAt(startLine + i).text).join('\n');
      const owner = this.provider.ownerOf(t.uri.fsPath) ?? this.provider.active;
      const list = byChat.get(owner.id) ?? [];
      for (const c of t.comments) {
        const body = typeof c.body === 'string' ? c.body : c.body.value;
        list.push({ path: t.uri.fsPath, line: startLine + 1, endLine: endLine + 1, body, code });
      }
      byChat.set(owner.id, list);
    }
    return byChat;
  }

  /** Deliver every draft comment, then clear them. Returns how many were sent. */
  async send(): Promise<number> {
    const n = this.count;
    if (!n) {
      void vscode.window.showInformationMessage('Tugline: no review comments to send.');
      return 0;
    }
    const byChat = await this.collect();
    this.lastSent = [];
    for (const [chatId, comments] of byChat) {
      const chat = this.provider.chats.get(chatId);
      if (!chat) continue;
      const text = buildReviewCommentMessage(comments, chat.agent?.workspace ?? chat.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      if (!text) continue;
      if (chat.busy && chat.agent) {
        await this.provider.steer(chat, text);
        this.lastSent.push({ chatId, via: 'steer', text });
      } else {
        this.lastSent.push({ chatId, via: 'prompt', text });
        void this.provider.sendPrompt(text, { chatId }).catch(() => undefined);
      }
    }
    this.clear();
    return n;
  }
}
