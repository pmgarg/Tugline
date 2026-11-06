/**
 * Notifications (SPEC B13): tell the user when a long run ends or when the
 * agent waits for a permission and the chat panel is not visible. The window
 * is injected, so this is unit-tested with a mock.
 */
import type { AgentEvent } from '../../src/core/types.js';

export interface WindowLike {
  showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined> | Thenable<string | undefined>;
}

type Thenable<T> = PromiseLike<T>;

export interface NotifierOptions {
  enabled: () => boolean;
  /** runs longer than this notify when they end */
  afterMs: () => number;
  /** is the chat panel visible right now? */
  panelVisible: () => boolean;
  /** called when the user clicks "Show" */
  reveal: () => void;
  now?: () => number;
}

export class Notifier {
  private startedAt = new Map<string, number>();
  /** messages shown (tests) */
  readonly shown: string[] = [];

  constructor(private win: WindowLike, private o: NotifierOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private show(msg: string): void {
    if (!this.o.enabled()) return;
    this.shown.push(msg);
    void Promise.resolve(this.win.showInformationMessage(msg, 'Show')).then((pick) => {
      if (pick === 'Show') this.o.reveal();
    });
  }

  /** Feed every agent event of a chat. */
  onEvent(chat: string, e: AgentEvent): void {
    if (e.type === 'run_start') this.startedAt.set(chat, this.now());
    else if (e.type === 'run_end') {
      const t0 = this.startedAt.get(chat);
      this.startedAt.delete(chat);
      if (t0 === undefined) return;
      const ms = this.now() - t0;
      if (ms < this.o.afterMs()) return;
      const what = e.stopReason === 'end_turn' ? 'finished' : `stopped (${e.stopReason})`;
      this.show(`Tugline ${what} after ${Math.round(ms / 1000)}s${chat ? ` in ${chat}` : ''}: ${(e.finalText || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }

  /** A permission/question/plan approval is waiting for the user. */
  onRequest(chat: string, title: string): void {
    if (this.o.panelVisible()) return;
    this.show(`Tugline is waiting for you${chat ? ` (${chat})` : ''}: ${title.slice(0, 140)}`);
  }
}
