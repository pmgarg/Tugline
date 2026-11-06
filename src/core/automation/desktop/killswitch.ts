/**
 * Desktop kill switch (SPEC F7; research CU §4 "Kill switch"). It extends the
 * one global automation kill switch from WS5 (`killAutomation()` in
 * automation/policy) instead of adding a second one. Every way to pull it ends
 * in that call, whose listeners then stop everything within a second:
 *
 *   - the flag file `~/.tugline/STOP` (works across processes: a second
 *     terminal, a launcher hotkey, the VS Code "Emergency Stop" command);
 *   - CLI Ctrl+C twice during a run;
 *   - `/desktop stop` (and `/browser stop`).
 *
 * Listeners: desktop sessions shut their backend down (cua-driver releases
 * held keys and exits), browser sessions close, and every agent run with
 * desktop tools is aborted.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isKilled, killAutomation, resetKillSwitch } from '../policy/index.js';

export function stopFilePath(homeDir: string, configured?: string): string {
  return configured ?? path.join(homeDir, 'STOP');
}

export function stopFileExists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** Pull the kill switch from anywhere: write the flag file (other processes) and kill in-process. */
export function emergencyStop(homeDir: string, reason = 'emergency stop', stopFile?: string): string {
  const file = stopFilePath(homeDir, stopFile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${new Date().toISOString()} ${reason}\n`);
  } catch {
    /* the in-process kill below still works */
  }
  killAutomation(reason);
  return file;
}

/** A human resets the switch: remove the flag file and clear the in-process state. */
export function clearStop(homeDir: string, stopFile?: string): void {
  try {
    fs.rmSync(stopFilePath(homeDir, stopFile), { force: true });
  } catch {
    /* ignore */
  }
  resetKillSwitch();
}

/**
 * Polls the flag file (fs.watch is unreliable across platforms and network
 * homes; a 100 ms existsSync costs nothing). One watcher per file, shared by
 * every session and run that uses it; reference-counted.
 */
class StopWatcher {
  private timer?: NodeJS.Timeout;
  private refs = 0;
  constructor(readonly file: string, readonly pollMs: number) {}
  acquire(): void {
    if (this.refs++ === 0) {
      this.timer = setInterval(() => this.check(), this.pollMs);
      this.timer.unref();
    }
    this.check();
  }
  release(): void {
    if (--this.refs <= 0) {
      this.refs = 0;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  check(): boolean {
    if (stopFileExists(this.file)) {
      if (!isKilled()) killAutomation(`STOP file ${this.file}`);
      return true;
    }
    return false;
  }
}

const watchers = new Map<string, StopWatcher>();

/** Start watching a STOP file; returns the release function. */
export function watchStopFile(file: string, pollMs = 100): () => void {
  let w = watchers.get(file);
  if (!w) {
    w = new StopWatcher(file, pollMs);
    watchers.set(file, w);
  }
  w.acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    w!.release();
  };
}
