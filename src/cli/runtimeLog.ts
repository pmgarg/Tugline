/**
 * v1.2 N49 (review F13, Cline runtime log + `doctor fix` / `doctor log`).
 *
 * Runtime log: what the CLI itself reports (start, notices, warnings, errors), one JSON line each, secrets redacted,
 * in `<home>/logs/oh.log` (rotated at 5 MB). Settings (Cline's CLINE_LOG_*): TUG_LOG_ENABLED=0 turns it off,
 * TUG_LOG_LEVEL=error|warn|info|debug|silent (default info), TUG_LOG_PATH=<file>. The session journal stays the record
 * of what the agent did; this log is for diagnosing the tool.
 *
 * `tug doctor fix` removes only what is provably stale (never kills a process): workspace leases and board locks of
 * dead processes, a server.json whose server is gone, worktrees no board card owns (board gc). `tug doctor log`
 * prints where the log is and its last lines.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../core/util/text.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
const MAX_BYTES = 5 * 1024 * 1024;

export interface RuntimeLogSettings {
  enabled: boolean;
  level: LogLevel | 'silent';
  file: string;
}

export function runtimeLogSettings(homeDir: string, env: NodeJS.ProcessEnv = process.env): RuntimeLogSettings {
  const lv = String(env.TUG_LOG_LEVEL ?? 'info').toLowerCase();
  const level = (lv === 'silent' || (LOG_LEVELS as readonly string[]).includes(lv) ? lv : 'info') as RuntimeLogSettings['level'];
  return { enabled: !/^(?:0|false|off|no)$/i.test(env.TUG_LOG_ENABLED ?? '') && level !== 'silent', level, file: env.TUG_LOG_PATH ? path.resolve(env.TUG_LOG_PATH) : path.join(homeDir, 'logs', 'oh.log') };
}

export class RuntimeLog {
  constructor(readonly settings: RuntimeLogSettings, private secrets: string[] = []) {}

  write(level: LogLevel, msg: string, extra: Record<string, unknown> = {}): void {
    const s = this.settings;
    if (!s.enabled || s.level === 'silent' || LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(s.level)) return;
    try {
      fs.mkdirSync(path.dirname(s.file), { recursive: true, mode: 0o700 });
      if (fs.existsSync(s.file) && fs.statSync(s.file).size > MAX_BYTES) fs.renameSync(s.file, `${s.file}.1`);
      fs.appendFileSync(s.file, redactSecrets(JSON.stringify({ ts: new Date().toISOString(), level, pid: process.pid, msg, ...extra }), this.secrets) + '\n', { mode: 0o600 });
    } catch {
      /* logging never breaks the CLI */
    }
  }
}

/** The last `n` lines of the log (`tug doctor log`). */
export function logTail(s: RuntimeLogSettings, n = 40): string {
  if (!fs.existsSync(s.file)) return `${s.file} (empty: nothing logged yet${s.enabled ? '' : '; logging is off'})`;
  const lines = fs.readFileSync(s.file, 'utf8').trimEnd().split('\n');
  return `${s.file} (${lines.length} line(s), level ${s.level}${s.enabled ? '' : ', logging is off'})\n${lines.slice(-n).join('\n')}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `tug doctor fix`: remove stale state only; never kill a process. Returns one line per action. */
export async function doctorFix(homeDir: string, workspace: string, o: { boardGc?: () => Promise<string[]> } = {}): Promise<string[]> {
  const done: string[] = [];
  const host = os.hostname();
  const leases = path.join(homeDir, 'workspaces');
  for (const f of fs.existsSync(leases) ? fs.readdirSync(leases).filter((x) => x.endsWith('.lease.json')) : []) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(leases, f), 'utf8'));
      if (l.host === host && typeof l.pid === 'number' && !pidAlive(l.pid)) {
        fs.rmSync(path.join(leases, f), { force: true });
        done.push(`removed the workspace lease of dead process ${l.pid} (${l.workspace ?? f})`);
      }
    } catch {
      /* unreadable: left alone */
    }
  }
  const boards = path.join(homeDir, 'boards');
  for (const f of fs.existsSync(boards) ? fs.readdirSync(boards).filter((x) => x.endsWith('.lock')) : []) {
    const p = path.join(boards, f);
    // the board's own rule: a lock older than 15 s belongs to a crashed writer (writers hold it for milliseconds)
    let age = 0;
    try {
      age = Date.now() - fs.statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (age > 15_000) {
      fs.rmSync(p, { force: true });
      done.push(`removed the stale board lock ${f}`);
    }
  }
  const srv = path.join(homeDir, 'server.json');
  if (fs.existsSync(srv)) {
    try {
      const j = JSON.parse(fs.readFileSync(srv, 'utf8'));
      if (typeof j.pid === 'number' && !pidAlive(j.pid)) {
        fs.rmSync(srv, { force: true });
        done.push(`removed server.json of the stopped \`tug serve\` (pid ${j.pid})`);
      }
    } catch {
      /* left alone */
    }
  }
  if (o.boardGc) for (const w of await o.boardGc().catch(() => [] as string[])) done.push(`removed the leftover worktree ${w}`);
  return done.length ? done : [`nothing stale found (${workspace})`];
}
