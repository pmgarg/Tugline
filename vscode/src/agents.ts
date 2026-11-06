/**
 * Agent manager (v1.1 N12), pure part: the status reducer behind the "Agents"
 * view and the parsing of a session worktree's diff stats. No `vscode` import,
 * so it is unit-tested with node.
 *
 * A row is one session: a chat (its own Agent) or a background job the agent
 * started (D5). The status comes from the agent's events plus the panel's own
 * knowledge of pending approvals (the agent emits `permission` only after the
 * answer, so "blocked" is driven by the request itself).
 *
 * The completion state (verified / failed / unverified) is read from `run_end`
 * when the core provides it (review finding R2, WS4). Until then it is absent
 * and the row shows only how the run stopped.
 */
import type { AgentEvent } from '../../src/core/types.js';

export type SessionStatus = 'idle' | 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'stopped';
export type Completion = 'verified' | 'failed' | 'unverified';

export interface DiffStats {
  files: number;
  added: number;
  removed: number;
}

export interface SessionRow {
  id: string;
  /** v1.2 N34: team members, board tasks and the latest team messages are rows under their lead's chat */
  kind: 'chat' | 'job' | 'member' | 'task' | 'message';
  title: string;
  status: SessionStatus;
  /** R2 completion state of the last run, when the core reports one */
  completion?: Completion;
  /** how the last run stopped (StopReason) */
  stopReason?: string;
  /** approvals / questions waiting for the user */
  blocked: { requestId: string; title: string; kind: string }[];
  /** prompts waiting behind the current run */
  queued: number;
  worktree?: { branch: string; path: string };
  diff?: DiffStats;
  /** the chat a job (or team row) belongs to */
  parent?: string;
  /** v1.2 N34: extra text for team rows (role · model · branch, the task owner, the message text) */
  detail?: string;
}

export type SessionAction =
  | { type: 'event'; e: AgentEvent }
  | { type: 'blocked'; requestId: string; title: string; kind: string }
  | { type: 'answered'; requestId: string }
  | { type: 'queued'; count: number }
  | { type: 'diff'; diff: DiffStats | undefined };

export function newRow(id: string, title: string, o: Partial<SessionRow> = {}): SessionRow {
  return { id, kind: 'chat', title, status: 'idle', blocked: [], queued: 0, ...o };
}

const COMPLETIONS: Completion[] = ['verified', 'failed', 'unverified'];

/**
 * The completion state carried by a run_end, whatever shape WS4 lands
 * (`completion: 'verified'`, `completion: {state}`, `verification: {state}` or
 * `completionState`). Anything else is ignored.
 */
export function completionOf(e: AgentEvent): Completion | undefined {
  if (e.type !== 'run_end') return undefined;
  const x = e as any;
  for (const v of [x.completion, x.completion?.state, x.verification?.state, x.verification, x.completionState]) if (typeof v === 'string' && (COMPLETIONS as string[]).includes(v)) return v as Completion;
  return undefined;
}

/** The status a row shows when nothing is blocking it. */
function settled(row: SessionRow): SessionStatus {
  if (row.status === 'running' || row.status === 'blocked') return 'running';
  return row.status;
}

export function sessionReduce(row: SessionRow, a: SessionAction): SessionRow {
  switch (a.type) {
    case 'blocked': {
      if (row.blocked.some((b) => b.requestId === a.requestId)) return row;
      return { ...row, status: 'blocked', blocked: [...row.blocked, { requestId: a.requestId, title: a.title, kind: a.kind }] };
    }
    case 'answered': {
      const blocked = row.blocked.filter((b) => b.requestId !== a.requestId);
      if (blocked.length === row.blocked.length) return row;
      return { ...row, blocked, status: blocked.length ? 'blocked' : settled(row) };
    }
    case 'queued':
      return { ...row, queued: Math.max(0, a.count), status: row.status === 'idle' || row.status === 'done' || row.status === 'failed' || row.status === 'stopped' ? (a.count > 0 ? 'queued' : row.status) : row.status };
    case 'diff':
      return { ...row, diff: a.diff };
    case 'event': {
      const e = a.e;
      if (e.type === 'run_start') return { ...row, status: row.blocked.length ? 'blocked' : 'running', completion: undefined, stopReason: undefined, queued: Math.max(0, row.queued - 1) };
      if (e.type === 'run_end') {
        const completion = completionOf(e);
        const status: SessionStatus = e.stopReason === 'aborted' ? 'stopped' : completion === 'failed' || ['error', 'llm_unavailable', 'thrashing', 'budget', 'max_turns'].includes(e.stopReason) ? 'failed' : 'done';
        // a run ended, but another queued prompt starts next
        return { ...row, status: row.queued > 0 ? 'queued' : status, completion, stopReason: e.stopReason, blocked: [] };
      }
      if (e.type === 'job' && row.kind === 'job') {
        if (e.phase === 'start') return { ...row, status: 'running' };
        if (e.phase === 'end') return { ...row, status: e.exitCode === 0 ? 'done' : e.exitCode === null || e.exitCode === undefined ? 'stopped' : 'failed', stopReason: `exit ${e.exitCode ?? 'killed'}` };
      }
      return row;
    }
  }
}

/** A row for a background job, from its start event. */
export function jobRow(e: Extract<AgentEvent, { type: 'job' }>, parent: string): SessionRow {
  return sessionReduce(newRow(`job:${e.jobId}`, `$ ${(e.command ?? e.jobId).slice(0, 60)}`, { kind: 'job', parent }), { type: 'event', e });
}

/**
 * Diff stats of a worktree against its base: `git diff --numstat <base>` (the
 * working tree, so uncommitted work counts) plus untracked files from
 * `git ls-files --others --exclude-standard` (counted by their lines).
 */
export function parseDiffStats(numstat: string, untracked: { lines: number }[] = []): DiffStats {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    if (m[1] !== '-') added += Number(m[1]);
    if (m[2] !== '-') removed += Number(m[2]);
  }
  for (const u of untracked) {
    files++;
    added += u.lines;
  }
  return { files, added, removed };
}

const ICON: Record<SessionStatus, string> = { idle: 'circle-outline', queued: 'clock', running: 'sync~spin', blocked: 'warning', done: 'pass', failed: 'error', stopped: 'debug-stop' };

/** What the tree item shows: label, description, tooltip, icon id and the context value that picks the inline actions. */
export function rowView(r: SessionRow): { label: string; description: string; tooltip: string; icon: string; contextValue: string } {
  const parts: string[] = [r.kind === 'message' ? '' : r.status === 'blocked' ? `blocked: ${r.blocked[0]?.title ?? 'approval'}` : r.status].filter(Boolean);
  if (r.detail) parts.push(r.detail);
  if (r.completion) parts.push(r.completion);
  if (r.queued > 0) parts.push(`${r.queued} queued`);
  if (r.diff) parts.push(`${r.diff.files} file${r.diff.files === 1 ? '' : 's'} +${r.diff.added} −${r.diff.removed}`);
  if (r.worktree) parts.push(r.worktree.branch);
  const tip = [
    r.title,
    `status: ${r.status}${r.stopReason ? ` (${r.stopReason})` : ''}`,
    r.completion ? `completion: ${r.completion}` : '',
    ...r.blocked.map((b) => `waiting: ${b.title}`),
    r.worktree ? `worktree: ${r.worktree.path} (${r.worktree.branch})` : '',
  ].filter(Boolean);
  const ctx = [`oh.${r.kind}`, r.worktree ? 'worktree' : '', r.status === 'blocked' ? 'blocked' : '', r.status === 'running' || r.status === 'blocked' || r.status === 'queued' ? 'running' : ''].filter(Boolean).join('.');
  return { label: r.title, description: parts.join(' · '), tooltip: tip.join('\n'), icon: ICON[r.status], contextValue: ctx };
}

// ------------------------------------------------------------ v1.2 N34: agent teams

export interface TeamView {
  teamId: string;
  name: string;
  members: Map<string, { status: string; role?: string; model?: string; worktree?: string; color?: string }>;
  tasks: Map<string, { title: string; status: string; owner?: string; deps?: string[] }>;
  messages: { from: string; to: string; text: string; tainted?: boolean }[];
  disbanded: boolean;
}

/** Fold a `team` event into the team view of a chat (live: every member, task and message event updates it). */
export function teamReduce(t: TeamView | undefined, e: AgentEvent): TeamView | undefined {
  if (e.type !== 'team') return t;
  const cur: TeamView = t && t.teamId === e.teamId ? { ...t, members: new Map(t.members), tasks: new Map(t.tasks), messages: [...t.messages] } : { teamId: e.teamId, name: e.name, members: new Map(), tasks: new Map(), messages: [], disbanded: false };
  if (e.phase === 'member' && e.member) cur.members.set(e.member.name, { status: e.member.status, role: e.member.role, model: e.member.model, worktree: e.member.worktree, color: e.member.color });
  if (e.phase === 'task' && e.task) cur.tasks.set(e.task.id, { title: e.task.title, status: e.task.status, owner: e.task.owner, deps: e.task.deps });
  if (e.phase === 'message' && e.message) cur.messages = [...cur.messages, e.message].slice(-5);
  if (e.phase === 'disbanded') cur.disbanded = true;
  return cur;
}

const MEMBER_STATUS: Record<string, SessionStatus> = { starting: 'queued', working: 'running', idle: 'idle', stopped: 'stopped', failed: 'failed', done: 'done' };
const TASK_STATUS: Record<string, SessionStatus> = { pending: 'queued', in_progress: 'running', done: 'done', blocked: 'failed', cancelled: 'stopped' };

/** The rows a team adds under its lead's chat: members, then tasks, then the latest messages. */
export function teamRows(chatId: string, t: TeamView): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const [name, m] of t.members) rows.push(newRow(`team:${t.teamId}:m:${name}`, `${name}${m.role ? ` (${m.role})` : ''}`, { kind: 'member', parent: chatId, status: t.disbanded && m.status !== 'failed' ? 'stopped' : (MEMBER_STATUS[m.status] ?? 'idle'), detail: [m.model, m.worktree].filter(Boolean).join(' · ') }));
  for (const [id, x] of t.tasks) rows.push(newRow(`team:${t.teamId}:t:${id}`, `${id}: ${x.title}`, { kind: 'task', parent: chatId, status: TASK_STATUS[x.status] ?? 'idle', detail: [x.owner ? `@${x.owner}` : '', x.deps?.length ? `after ${x.deps.join(', ')}` : ''].filter(Boolean).join(' · ') }));
  t.messages.forEach((m, i) => rows.push(newRow(`team:${t.teamId}:msg:${i}`, `${m.from} → ${m.to}`, { kind: 'message', parent: chatId, status: 'done', detail: `${m.tainted ? '⚠ untrusted · ' : ''}${m.text.slice(0, 80)}` })));
  return rows;
}
