/**
 * Self-protection (SPEC F7 AC3, research CU §5.9.9): the agent must never act
 * on the harness itself: the process running `tug`, the terminal that hosts it
 * (an ancestor process), or the VS Code window that runs the extension.
 * Driving those would let the model approve its own prompts, type into its own
 * input box or kill the session that is supposed to supervise it.
 *
 * Identification is by pid first (the window's owning pid is the harness or
 * one of its ancestors, or VS Code's main pid) and by app name second (the
 * terminal / editor app this session runs in, from TERM_PROGRAM and the VS
 * Code environment), plus the user's `desktop.denyApps`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { PolicyVerdict } from '../policy/index.js';
import type { RawWindow } from './backend.js';
import { listProcesses, parentPid, type ProcInfo } from '../../util/procs.js';

let cachedPids: Set<number> | undefined;
let winProcs: ProcInfo[] | undefined;
/** One process snapshot per ancestor walk on Windows (PowerShell is slow; there is no /proc or ps). */
const winSnapshot = (): ProcInfo[] => (winProcs ??= listProcesses());
const extraPids = new Set<number>();

function parentOf(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // pid (comm) state ppid …; comm may contain spaces and parens: split after the last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const p = Number(rest[1]);
      return Number.isFinite(p) && p > 0 ? p : undefined;
    }
    if (process.platform === 'win32') return pid === process.pid ? process.ppid : parentPid(pid, winSnapshot()); // R7: the whole ancestor chain, not just the parent
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const p = Number(out);
    return Number.isFinite(p) && p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

/** The harness pid, its ancestors (the terminal / IDE that launched it) and VS Code's main pid. */
export function harnessPids(): Set<number> {
  if (!cachedPids) {
    const s = new Set<number>([process.pid]);
    let p: number | undefined = process.ppid;
    for (let i = 0; p && p > 1 && i < 32 && !s.has(p); i++) {
      s.add(p);
      p = parentOf(p);
    }
    const vs = Number(process.env.VSCODE_PID);
    if (Number.isFinite(vs) && vs > 0) s.add(vs);
    cachedPids = s;
  }
  return new Set([...cachedPids, ...extraPids]);
}

/** Register another harness-owned pid (e.g. the VS Code extension host passes its window's pid). */
export function protectPid(pid: number): void {
  extraPids.add(pid);
}

/** App names of the surface this session runs in. */
export function harnessApps(env: NodeJS.ProcessEnv = process.env): string[] {
  const apps: string[] = [];
  const term = env.TERM_PROGRAM ?? '';
  const map: Record<string, string[]> = {
    Apple_Terminal: ['Terminal'],
    'iTerm.app': ['iTerm2', 'iTerm'],
    vscode: ['Code', 'Visual Studio Code', 'Code - Insiders', 'Cursor', 'VSCodium', 'Windsurf'],
    WezTerm: ['WezTerm'],
    ghostty: ['Ghostty'],
    Hyper: ['Hyper'],
    tmux: [],
    WarpTerminal: ['Warp'],
    kitty: ['kitty'],
    Alacritty: ['Alacritty'],
  };
  apps.push(...(map[term] ?? (term ? [term] : [])));
  if (env.VSCODE_PID || env.VSCODE_IPC_HOOK || env.VSCODE_IPC_HOOK_CLI || env.VSCODE_CWD) apps.push('Code', 'Visual Studio Code', 'Code - Insiders', 'Cursor', 'VSCodium', 'Windsurf');
  if (env.WT_SESSION) apps.push('Windows Terminal', 'WindowsTerminal');
  if (env.GNOME_TERMINAL_SCREEN || env.GNOME_TERMINAL_SERVICE) apps.push('gnome-terminal', 'Terminal', 'gnome-terminal-server');
  if (env.KONSOLE_VERSION) apps.push('konsole', 'Konsole');
  return [...new Set(apps)];
}

/** Refuse acting on a window that belongs to the harness (pid) or a protected app (name). */
export function selfProtectCheck(win: Pick<RawWindow, 'pid' | 'app' | 'title'>, denyApps: string[] = [], env: NodeJS.ProcessEnv = process.env): PolicyVerdict {
  if (win.pid !== undefined && harnessPids().has(win.pid))
    return { ok: false, code: 'policy_denied', message: `refusing to act on "${win.app}" (pid ${win.pid}): it is the harness itself or the terminal/editor running it. The agent never drives its own process or windows.` };
  const app = (win.app ?? '').toLowerCase();
  const own = harnessApps(env).map((a) => a.toLowerCase());
  if (app && own.includes(app))
    return { ok: false, code: 'policy_denied', message: `refusing to act on "${win.app}": Tugline is running inside it. The agent never drives its own terminal or editor window.` };
  if (app && denyApps.map((a) => a.toLowerCase()).includes(app)) return { ok: false, code: 'policy_denied', message: `"${win.app}" is in desktop.denyApps` };
  return { ok: true };
}
