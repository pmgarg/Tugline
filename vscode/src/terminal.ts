/**
 * VS Code terminals for the agent (SPEC B10):
 * - the visible "Tugline" terminal for foreground bash (VisibleTerminalRunner
 *   on the real window API);
 * - one background terminal per background job (D5). The job itself is spawned
 *   by the core job manager through the command wrappers; its terminal is a
 *   pseudoterminal that only streams the job's log file (no second process);
 * - the last command output of any terminal with shell integration, for the
 *   @terminal mention (B4).
 */
import * as vscode from 'vscode';
import fs from 'node:fs';
import { getJob } from '../../src/core/jobs/manager.js';
import { stripAnsi, VisibleTerminalRunner, type TermApi } from './terminalRunner.js';

export function vscodeTermApi(): TermApi {
  return {
    createTerminal: (o) => vscode.window.createTerminal({ name: o.name, cwd: o.cwd, env: o.env, strictEnv: o.strictEnv, isTransient: true, iconPath: new vscode.ThemeIcon('hubot') }) as any,
    onDidChangeTerminalShellIntegration: (cb) => vscode.window.onDidChangeTerminalShellIntegration((e) => cb(e as any)),
    onDidEndTerminalShellExecution: (cb) => vscode.window.onDidEndTerminalShellExecution((e) => cb(e as any)),
    onDidStartTerminalShellExecution: (cb) => vscode.window.onDidStartTerminalShellExecution((e) => cb(e as any)),
    onDidCloseTerminal: (cb) => vscode.window.onDidCloseTerminal((t) => cb(t as any)),
  };
}

export function createVisibleRunner(name: string): VisibleTerminalRunner {
  return new VisibleTerminalRunner(vscodeTermApi(), { name, integrationTimeoutMs: 5000, shellPath: () => vscode.env.shell, platform: process.platform });
}

/** A read-only terminal that follows a background job's log file until the job ends. */
export function openJobTerminal(jobId: string, command: string): vscode.Terminal | undefined {
  const job = getJob(jobId);
  if (!job) return undefined;
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let pos = 0;
  let timer: NodeJS.Timeout | undefined;
  const pump = () => {
    try {
      const st = fs.statSync(job.logFile);
      if (st.size > pos) {
        const fd = fs.openSync(job.logFile, 'r');
        const buf = Buffer.alloc(Math.min(st.size - pos, 256 * 1024));
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos += buf.length;
        write.fire(buf.toString('utf8').replace(/\r?\n/g, '\r\n'));
      }
    } catch {
      /* log not there yet */
    }
    if (job.status !== 'running') {
      write.fire(`\r\n[job ${job.id} ${job.status}${job.exitCode !== undefined ? `, exit code ${job.exitCode}` : ''}]\r\n`);
      clearInterval(timer);
    }
  };
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: () => {
      write.fire(`\x1b[2m$ ${command}  (Tugline background job ${job.id}; output is logged to ${job.logFile})\x1b[0m\r\n`);
      pump();
      timer = setInterval(pump, 500);
    },
    close: () => {
      clearInterval(timer);
    },
  };
  return vscode.window.createTerminal({ name: `OH job ${job.id}`, pty, isTransient: true, iconPath: new vscode.ThemeIcon('server-process') });
}

/** Remembers the last finished command per terminal (shell integration) for @terminal. */
export class TerminalOutputTracker implements vscode.Disposable {
  private last = new Map<vscode.Terminal, { command: string; exitCode?: number; output: string }>();
  private subs: vscode.Disposable[] = [];
  constructor() {
    this.subs.push(
      vscode.window.onDidStartTerminalShellExecution((e) => {
        let out = '';
        const command = e.execution.commandLine.value;
        void (async () => {
          for await (const d of e.execution.read()) if (out.length < 500_000) out += d;
        })().catch(() => undefined);
        const sub = vscode.window.onDidEndTerminalShellExecution((end) => {
          if (end.execution !== e.execution) return;
          sub.dispose();
          setTimeout(() => this.last.set(e.terminal, { command, exitCode: end.exitCode, output: stripAnsi(out) }), 200);
        });
      }),
      vscode.window.onDidCloseTerminal((t) => this.last.delete(t)),
    );
  }

  /** Output of the active terminal's last command, or (fallback) its current selection via the clipboard. */
  async lastOutput(): Promise<{ command?: string; exitCode?: number; output: string; via: 'shell-integration' | 'selection' } | undefined> {
    const t = vscode.window.activeTerminal;
    if (!t) return undefined;
    const l = this.last.get(t);
    if (l) return { ...l, via: 'shell-integration' };
    const before = await vscode.env.clipboard.readText();
    await vscode.commands.executeCommand('workbench.action.terminal.copySelection');
    const sel = await vscode.env.clipboard.readText();
    await vscode.env.clipboard.writeText(before);
    return sel && sel !== before ? { output: sel, via: 'selection' } : undefined;
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
  }
}
