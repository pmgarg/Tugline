/**
 * v1.2 N34: display-only views of a team (Qwen's pane backends, without their execution path).
 *
 * The team writes one log per member to `<homeDir>/teams/<teamId>/<member>.log` (outside the workspace): status
 * changes, tool calls, messages and task changes. `tug team watch <teamId> [--tmux]` shows them; with `--tmux` it
 * opens a tmux session with one pane per member, and every pane runs only `tail -F <that log>`. Nothing in a pane
 * can reach an agent, approve anything or run a tool: approvals stay in the session's own prompt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shq } from '../../eval/external.js';

export function teamLogDir(homeDir: string, teamId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(teamId)) throw new Error(`not a team id: ${teamId}`);
  return path.join(homeDir, 'teams', teamId);
}

export function appendMemberLog(homeDir: string, teamId: string, member: string, line: string): void {
  try {
    const dir = teamLogDir(homeDir, teamId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // one line per entry, control characters removed (a log is displayed in a terminal)
    const clean = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u001b]/g, ' ').replace(/[‪-‮⁦-⁩]/g, '');
    fs.appendFileSync(path.join(dir, `${member.replace(/[^\w-]/g, '_')}.log`), `${new Date().toISOString().slice(11, 19)} ${clean}\n`, { mode: 0o600 });
  } catch {
    /* a display log never breaks a run */
  }
}

export function memberLogs(homeDir: string, teamId: string): { member: string; file: string }[] {
  const dir = teamLogDir(homeDir, teamId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .map((f) => ({ member: f.slice(0, -4), file: path.join(dir, f) }));
}

/** The pane commands: `tail -F <log>`, nothing else. */
export function paneCommands(homeDir: string, teamId: string): string[] {
  return memberLogs(homeDir, teamId).map((l) => `tail -n 200 -F ${shq(l.file)}`);
}

/** Open (detached) a tmux session with one tail pane per member. Returns the session name. */
export function openTmux(homeDir: string, teamId: string, o: { socket?: string } = {}): string {
  const panes = paneCommands(homeDir, teamId);
  if (!panes.length) throw new Error(`no member logs for team ${teamId} yet`);
  const session = `oh-team-${teamId}`.replace(/[^\w-]/g, '_').slice(0, 60);
  const base = o.socket ? ['-L', o.socket] : [];
  const tm = (...a: string[]) => {
    const r = spawnSync('tmux', [...base, ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tmux ${a[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
    return r.stdout;
  };
  tm('new-session', '-d', '-s', session, '-x', '200', '-y', '50', panes[0]!);
  for (const p of panes.slice(1)) {
    tm('split-window', '-t', session, p);
    tm('select-layout', '-t', session, 'tiled');
  }
  return session;
}
