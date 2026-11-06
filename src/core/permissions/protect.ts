/**
 * R1 layer 2 (dynamic, fail closed): the protected set is fingerprinted before
 * every shell command and compared after it, while background jobs run, and
 * (watched) whenever no run is in progress. Any change is restored, recorded as
 * a refusal, a journal entry and a security event, and returned to the model as
 * a tool error. See protectFs.ts for the layers and what counts as protected.
 *
 *  - Detached writers. Every watched command carries TUG_GUARD_ID in its
 *    environment (agentProcs.ts). When a foreground command exits, every
 *    process still carrying its id is killed, and only then is the set
 *    compared. Declared background jobs keep their processes; they are polled
 *    while they run and checked and cleaned up when they exit.
 *  - Never adopt by inference (review batch 3). The id is an environment
 *    variable the agent controls (`unset TUG_GUARD_ID`), so "no agent process is
 *    alive" proves nothing. While a session is open in this process, the state
 *    after each check is the *trusted* state and every difference from it is
 *    restored, every time: before and after each command, at run start and end,
 *    and when the workspace watcher sees a change between runs. The changed
 *    version is backed up first (`<home>/protect-backups/<workspace>/<time>/`).
 *    A change is accepted only
 *      - when the harness itself made it (a tool that reports the file, or
 *        `noteHarnessWrite`, e.g. the remember tool's MEMORY.md),
 *      - by an explicit user action: `/protect accept [path…]` or
 *        `tug protect accept [path…]` (puts the backed-up version back and
 *        marks it accepted), or the answer "keep my version" to the question
 *        below.
 *  - Between sessions (review batch 3 re-check). The trusted state and copies
 *    of its files are persisted at run and session end. A change found when the
 *    next session starts (in any process) is held, never adopted: it is
 *    restored and backed up, and a human is asked "keep my version" or
 *    "restore"; with no human (headless, eval, scheduled, channel, remote) it
 *    stays restored and is recorded (fail closed).
 *  - Process lifetime (sandbox/index.ts, shell.processLifetime): where bwrap
 *    works, an unsandboxed command runs in its own PID namespace, so nothing it
 *    starts outlives it or the harness, and a session's jobs end with it.
 *  - Past the entry cap the guard cannot vouch for the set, so commands are
 *    refused (a policy hard deny with the reason) instead of running unchecked.
 *
 * Subagents share the workspace, so the trusted state is per workspace.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import { getJob, killJob, listJobs } from '../jobs/manager.js';
import { registerCommandWrapper } from '../tools/shell.js';
import { registerCliCommand, registerSlashCommand } from '../commands.js';
import { AGENT_CONTROL_FILES, realResolve, setShellGate } from './policy.js';
import { ProtectedContentStore, diffProtected, fingerprintProtected, MAX_ENTRIES, protectedSet, restoreProtected, type ProtectedChange, type ProtectedEntry, type ProtectedFingerprint, type ProtectedSet } from './protectFs.js';
import { recordSecurityEvent } from './audit.js';
import { harnessWrites } from './harnessWrites.js';
import { judgeGitConfigChange, sha256Buf } from './gitConfigAdopt.js';
import { GUARD_ENV, killProcessesWithGuardId, newCommandId, processesWithGuardId, PROCESS_TOKEN } from './agentProcs.js';

/** The guarded globs for a config: protected paths plus agent-control files. */
export function guardedGlobs(protectedPaths: string[]): string[] {
  return [...protectedPaths, ...AGENT_CONTROL_FILES];
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** R1 layer 2: 'restore' (default) undoes any shell change to the protected set; 'off' disables the check. */
    shellGuard?: 'restore' | 'off';
    /** R1: the most entries the guard walks; beyond it commands are refused (fail closed). Default 50000. */
    shellGuardMaxEntries?: number;
  }
}

interface InFlight {
  agent: object;
  command: string;
  /** TUG_GUARD_ID of this command's processes */
  id: string;
  jobId?: string;
}

/** One per workspace: subagents share the workspace, so they share the baseline. */
interface WsState {
  ws: string;
  homeDir: string;
  set: ProtectedSet;
  maxEntries: number;
  /** the state after the last check (restored if needed): anything different later is not the user's run-time business */
  trusted?: ProtectedFingerprint;
  inflight: Set<InFlight>;
  /** top-level runs in progress in this workspace */
  runs: number;
  /** the walk hit the cap: commands are refused */
  overCap?: boolean;
  off?: boolean;
  store?: ProtectedContentStore;
  timer?: NodeJS.Timeout;
  /** agents (sessions) of this process using the workspace, and the last one to report to */
  sessions: Set<object>;
  lastApi?: AgentApi;
  /** the between-runs watcher */
  watchers: Map<string, fs.FSWatcher>;
  poll?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
}
const states = new Map<string, WsState>();
const unsandboxedWarned = new WeakSet<object>();
/** Messages for the model about violations found outside its own call (background jobs, between commands), delivered with the next tool result. */
const pendingNotes = new WeakMap<object, string[]>();

process.once('exit', () => {
  for (const s of states.values()) s.store?.dispose();
});

function stateFor(a: AgentApi): WsState {
  const workspace = realResolve(a.workspace);
  let s = states.get(workspace);
  const set = protectedSet(guardedGlobs(a.config.permissions.protectedPaths));
  const maxEntries = a.config.shellGuardMaxEntries ?? 50_000;
  if (!s) {
    s = { ws: workspace, homeDir: a.config.homeDir, set, maxEntries, inflight: new Set(), runs: 0, sessions: new Set(), watchers: new Map() };
    states.set(workspace, s);
  } else if (s.set.patterns.join('\0') !== set.patterns.join('\0') || s.maxEntries !== maxEntries) {
    s.set = set;
    s.maxEntries = maxEntries;
    if (!s.inflight.size) s.trusted = undefined;
  }
  s.off = a.config.shellGuard === 'off';
  s.sessions.add(a.agent as object);
  s.lastApi = a;
  return s;
}

const wsKey = (ws: string) => crypto.createHash('sha256').update(ws).digest('hex').slice(0, 16);
const sha256 = (f: string) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  } catch {
    return undefined;
  }
};


/** The accept marker's value for a deletion the user accepted. */
const ACCEPTED_DELETION = 'deleted';

function acceptFile(homeDir: string, ws: string): string {
  return path.join(homeDir, 'protect-state', `${wsKey(ws)}.accept.json`);
}
function readAccepted(homeDir: string, ws: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(acceptFile(homeDir, ws), 'utf8'));
  } catch {
    return {};
  }
}

function snapshot(s: WsState, a?: AgentApi): ProtectedFingerprint {
  const { fp, truncated } = fingerprintProtected(s.ws, s.set, s.maxEntries);
  s.overCap = truncated;
  s.store ??= new ProtectedContentStore();
  const skipped = s.store.ensure(s.ws, fp);
  if (skipped.length) a?.notice('warn', `protected-path guard: ${skipped.length} protected file(s) are too large to copy; changes to them are detected but cannot be undone`);
  return fp;
}

function describe(changes: ProtectedChange[]): string {
  const shown = changes.slice(0, 8).map((c) => `${c.rel} (${c.kind})`);
  return shown.join(', ') + (changes.length > 8 ? `, and ${changes.length - 8} more` : '');
}

export interface GuardViolation {
  changes: ProtectedChange[];
  failed: string[];
  backup?: string;
  message: string;
}

/** In a backup folder: the protected paths that were deleted (so "keep my version" can delete them again). */
const DELETED_MANIFEST = '.oh-deleted.json';

/** Keep the versions about to be overwritten (a user edit must never be lost), and which files were deleted. */
function backupChanged(s: WsState, changes: ProtectedChange[]): string | undefined {
  const keep = changes.filter((c) => c.kind !== 'deleted');
  const deleted = changes.filter((c) => c.kind === 'deleted').map((c) => c.rel);
  if (!keep.length && !deleted.length) return undefined;
  const dir = path.join(s.homeDir, 'protect-backups', wsKey(s.ws), new Date().toISOString().replace(/[:.]/g, '-'));
  if (deleted.length) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, DELETED_MANIFEST), JSON.stringify(deleted));
    } catch {
      /* best effort */
    }
  }
  for (const c of keep) {
    try {
      const src = path.join(s.ws, c.rel);
      const st = fs.lstatSync(src);
      if (!st.isFile()) continue;
      fs.mkdirSync(path.dirname(path.join(dir, c.rel)), { recursive: true });
      fs.copyFileSync(src, path.join(dir, c.rel));
    } catch {
      /* best effort */
    }
  }
  return fs.existsSync(dir) ? dir : undefined;
}

/**
 * A `.git/config` edit that only touches branch tracking, identity or (for the user's own edits) remote URLs is kept
 * (gitConfigAdopt.ts). The judged bytes are the ones the fingerprint saw: a file that changed again since is restored.
 */
function keepGitConfigEdit(s: WsState, before: ProtectedEntry | undefined, after: ProtectedEntry | undefined, abs: string, userEdit: boolean): Buffer | undefined {
  if (!before || before.type !== 'file' || after?.type !== 'file') return undefined;
  const old = s.store?.copyOf('.git/config', before);
  if (!old) return undefined;
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return undefined;
    const cur = fs.readFileSync(abs);
    if (after.hash ? sha256Buf(cur) !== after.hash : cur.length !== after.size) return undefined;
    // review H2: the remote-URL tier only when no agent process could have written the file: nothing in flight (jobs
    // included), no process carrying any guard id alive, and an OS sandbox that keeps .git/config read-only for agent
    // commands (without one, a detached process with a cleared environment is indistinguishable from the user)
    const user = userEdit && s.inflight.size === 0 && processesWithGuardId({ prefix: `${PROCESS_TOKEN}-` }).length === 0 && !!s.lastApi && gitConfigSandboxed?.(s.lastApi.config) === true && s.sessions.size > 0 && [...s.sessions].every((g) => { const c = (g as { config?: AgentApi['config'] }).config; return !!c && gitConfigSandboxed?.(c) === true; });
    return judgeGitConfigChange(fs.readFileSync(old), cur, { userEdit: user }).keep ? cur : undefined;
  } catch {
    return undefined;
  }
}

/** Set by sandbox/index.ts (which imports this module): whether agent commands see .git/config read-only. */
let gitConfigSandboxed: ((cfg: AgentApi['config']) => boolean) | undefined;
export function setGitConfigSandboxedHook(f: ((cfg: AgentApi['config']) => boolean) | undefined): ((cfg: AgentApi['config']) => boolean) | undefined {
  const prev = gitConfigSandboxed;
  gitConfigSandboxed = f;
  return prev;
}

/** Compare the protected set with `against`, restore it, and re-anchor the trusted state. Null when nothing changed. */
export function checkAndRestore(s: WsState, what: string, against: ProtectedFingerprint | undefined = s.trusted, adoptAbs: string[] = [], o: { userEdit?: boolean } = {}): GuardViolation | null {
  if (!against) return null;
  const now = fingerprintProtected(s.ws, s.set, s.maxEntries).fp;
  let changes = diffProtected(against, now);
  if (!changes.length) {
    s.trusted = now;
    return null;
  }
  // Accepted changes: files the harness wrote itself (a tool reported them, or noteHarnessWrite with the same
  // content), and files the user accepted explicitly (/protect accept, with the same content). Everything else
  // is restored.
  const accepted = readAccepted(s.homeDir, s.ws);
  const adopt = new Set<string>();
  let judgedGitConfig: { entry: ProtectedEntry; bytes: Buffer } | undefined;
  // review M1: the trusted state holds the judged .git/config, never bytes re-read after the judgement (a write that
  // landed in between is a new change at the next check, judged or restored like any other)
  const pinJudged = () => {
    if (!judgedGitConfig || !s.trusted) return;
    const t = s.trusted.get('.git/config');
    const same = t?.type === 'file' && (t.hash && judgedGitConfig.entry.hash ? t.hash === judgedGitConfig.entry.hash : t.size === judgedGitConfig.entry.size && t.mtimeMs === judgedGitConfig.entry.mtimeMs);
    if (!same) s.trusted.set('.git/config', judgedGitConfig.entry);
  };
  for (const c of changes) {
    const abs = path.join(s.ws, c.rel);
    const h = c.kind === 'deleted' ? undefined : sha256(abs);
    const byHarness = adoptAbs.includes(abs) || (h !== undefined && harnessWrites.get(abs) === h);
    const byUser = (h !== undefined && accepted[c.rel] === h) || (c.kind === 'deleted' && accepted[c.rel] === ACCEPTED_DELETION);
    if (byHarness || byUser) {
      adopt.add(c.rel);
      harnessWrites.delete(abs);
      if (byUser) delete accepted[c.rel];
    } else if (c.rel === '.git/config' && c.kind === 'modified') {
      const bytes = keepGitConfigEdit(s, against.get(c.rel), now.get(c.rel), abs, !!o.userEdit);
      if (bytes) {
        adopt.add(c.rel);
        judgedGitConfig = { entry: now.get(c.rel)!, bytes };
      }
    }
  }
  // A newly created real directory (not a symlink) is accepted: it holds no content of its own, and every protected
  // file inside it is judged (and restored) as its own change. Restoring it would delete its whole subtree, including
  // accepted files (the first `.tugline/MEMORY.md`) and harness-owned data the set exempts (`.tugline/runs`).
  for (const c of changes) {
    if (c.kind === 'created' && now.get(c.rel)?.type === 'dir') adopt.add(c.rel);
  }
  if (adopt.size) {
    try {
      fs.writeFileSync(acceptFile(s.homeDir, s.ws), JSON.stringify(accepted));
    } catch {
      /* no marker file yet */
    }
    against = new Map(against);
    for (const rel of adopt) {
      const e = now.get(rel);
      if (e) against.set(rel, e);
      else against.delete(rel);
    }
    s.store?.ensure(s.ws, new Map([...adopt].filter((r) => now.has(r) && !(judgedGitConfig && r === '.git/config')).map((r) => [r, now.get(r)!])));
    if (judgedGitConfig) s.store?.putBytes('.git/config', judgedGitConfig.entry, judgedGitConfig.bytes);
    changes = changes.filter((c) => !adopt.has(c.rel));
    if (!changes.length) {
      s.trusted = snapshot(s);
      pinJudged();
      return null;
    }
  }
  const backup = backupChanged(s, changes);
  const failed = restoreProtected(s.ws, against, changes, s.store!);
  // restoring rewrites files (new inode and ctime): the restored state is the new trusted one
  s.trusted = snapshot(s);
  pinJudged();
  const message =
    `[harness] ERROR: ${what} changed protected files: ${describe(changes)}. ` +
    (failed.length ? `They could NOT all be restored (${failed.slice(0, 8).join(', ')}); tell the user. ` : 'They were restored. ') +
    (backup ? `The changed versions were kept in ${backup} (to keep a change you made yourself: /protect accept <path>). ` : '') +
    'Protected files are the judge (tests, CI, agent config): change the code, not the judge.';
  return { changes, failed, backup, message };
}

function report(a: AgentApi, v: GuardViolation, command: string, args: unknown): void {
  a.stats.refusals++;
  a.emit({ type: 'refusal', tool: 'bash', reason: `shell command modified protected path(s): ${describe(v.changes)}${v.failed.length ? ` (not restored: ${v.failed.join(', ')})` : ' (restored)'}`, args });
  a.journal({ type: 'protected_write', command, changes: v.changes, failed: v.failed, backup: v.backup });
  recordSecurityEvent(a, { type: 'protected_restore', category: 'protected_path', decision: v.failed.length ? 'restore_failed' : 'restore', by: 'guard', reason: `${command ? 'shell command' : 'outside a command'} changed ${describe(v.changes)}${v.failed.length ? `; not restored: ${v.failed.join(', ')}` : ''}`, tool: 'bash', content: { command } });
}

function note(a: AgentApi, text: string): void {
  pendingNotes.set(a.agent as object, [...(pendingNotes.get(a.agent as object) ?? []), text]);
}

/** Live processes started by this harness's agent commands, other than declared background jobs. */
function strayAgentProcesses(): number[] {
  const jobPids = new Set(listJobs().filter((j) => j.status === 'running' && j.pid).map((j) => j.pid!));
  // WS24 (found with the N47 arena driver): commands still running for another workspace's session in this process
  // (arena contestants, board cards, parallel chats or `tug serve` sessions in their own worktrees) are not strays of
  // this run; killing them made a contestant's command exit 128 whenever another contestant finished first. Each is
  // still killed with its own id when it ends (killProcessesWithGuardId), and its workspace's guard checks after it.
  const running = new Set([...states.values()].flatMap((st) => [...st.inflight].map((f) => f.id)));
  return processesWithGuardId({ prefix: `${PROCESS_TOKEN}-`, except: running }).filter((p) => !jobPids.has(p));
}

function stopTimerIfIdle(s: WsState): void {
  if (s.timer && ![...s.inflight].some((f) => f.jobId)) {
    clearInterval(s.timer);
    s.timer = undefined;
  }
}

/** While background jobs run, poll the protected set; a violation kills the job and restores. */
function watchJob(a: AgentApi, s: WsState, f: InFlight, jobId: string, args: unknown): void {
  const job = getJob(jobId);
  if (!job) {
    s.inflight.delete(f);
    return;
  }
  f.jobId = jobId;
  const onViolation = (v: GuardViolation, killed: boolean) => {
    report(a, v, f.command, args);
    const text = `${v.message} (background job ${jobId}${killed ? ' was killed' : ''})`;
    a.notice('error', text);
    note(a, text);
  };
  const finish = async () => {
    if (!s.inflight.has(f)) return;
    // processes the job left behind (its own `&` children) go with it
    await killProcessesWithGuardId(f.id);
    s.inflight.delete(f);
    const v = checkAndRestore(s, `background job ${jobId} (${f.command})`);
    if (v) onViolation(v, false);
    stopTimerIfIdle(s);
  };
  job.onEnd.push(() => void finish());
  if (job.status !== 'running') {
    void finish();
    return;
  }
  if (!s.timer) {
    s.timer = setInterval(() => {
      const v = checkAndRestore(s, 'a background job');
      if (!v) return;
      for (const g of [...s.inflight]) {
        if (!g.jobId) continue;
        const j = getJob(g.jobId);
        if (j?.status === 'running') void killJob(j);
        void killProcessesWithGuardId(g.id);
      }
      onViolation(v, true);
    }, GUARD_POLL_MS);
    s.timer.unref();
  }
}

/** Restore whatever changed while no command runs (a writer left running, or an edit while a session is open). */
function idleCheck(s: WsState): void {
  if (s.off || !s.trusted || [...s.inflight].some((f) => !f.jobId)) return;
  const v = checkAndRestore(s, 'something outside any command (a process left running, or an edit while an Tugline session is open)', s.trusted, [], { userEdit: true });
  if (!v || !s.lastApi) return;
  report(s.lastApi, v, '', {});
  s.lastApi.notice('error', v.message);
  for (const agent of s.sessions) pendingNotes.set(agent, [...(pendingNotes.get(agent) ?? []), v.message]);
}

/** Directories to watch for the protected set: each base (or a file base's parent) and the directories under it, bounded. */
function watchDirs(s: WsState): string[] {
  const out: string[] = [];
  const walk = (abs: string, depth: number) => {
    if (out.length >= MAX_WATCH_DIRS) return;
    out.push(abs);
    if (depth > 12) return;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(abs, e.name), depth + 1);
  };
  for (const b of s.set.bases) {
    const abs = path.join(s.ws, b);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = undefined;
    }
    if (st?.isDirectory() && !st.isSymbolicLink()) walk(abs, 0);
    else out.push(path.dirname(abs)); // a file base, or a missing one: its parent sees it change or appear
  }
  return [...new Set(out)];
}
const MAX_WATCH_DIRS = 256;

/**
 * Watch the protected set while a session is open: changes between runs are restored within a moment.
 * One non-recursive watcher per directory (Node's recursive watch on Linux loses a file once it is
 * replaced by a rename, which is how restores write), re-scanned after each check; a poll backs it up.
 */
function refreshWatchers(s: WsState): void {
  if (!s.poll) return;
  const want = new Set(watchDirs(s));
  for (const [d, w] of s.watchers) if (!want.has(d)) (w.close(), s.watchers.delete(d));
  for (const d of want) {
    if (s.watchers.has(d)) continue;
    try {
      const w = fs.watch(d, { persistent: false }, () => trigger(s));
      w.on('error', () => (w.close(), s.watchers.delete(d)));
      s.watchers.set(d, w);
    } catch {
      /* missing or unreadable: the poll covers it */
    }
  }
}

function trigger(s: WsState): void {
  if (s.debounce) return;
  s.debounce = setTimeout(() => {
    s.debounce = undefined;
    if (s.runs === 0) idleCheck(s); // during a run the command boundaries check
    refreshWatchers(s);
  }, 150);
  s.debounce.unref();
}

function startWatching(s: WsState): void {
  if (s.poll) return;
  s.poll = setInterval(() => {
    if (s.runs === 0) idleCheck(s);
    refreshWatchers(s);
  }, IDLE_POLL_MS);
  s.poll.unref();
  refreshWatchers(s);
}

function stopWatching(s: WsState): void {
  for (const w of s.watchers.values()) w.close();
  s.watchers.clear();
  if (s.poll) clearInterval(s.poll);
  if (s.debounce) clearTimeout(s.debounce);
  s.poll = s.debounce = undefined;
}

function stateFile(homeDir: string, ws: string): string {
  return path.join(homeDir, 'protect-state', `${wsKey(ws)}.json`);
}
function objectsDir(homeDir: string, ws: string): string {
  return path.join(homeDir, 'protect-state', `${wsKey(ws)}.objects`);
}
/**
 * The trusted state when a run or session ends, with copies of its files (`<home>/protect-state/<ws>.objects/`), so the
 * next session, in this process or another, can hold any change made while none was open (R1 (A)).
 */
function persistTrusted(s: WsState): void {
  if (!s.trusted) return;
  try {
    fs.mkdirSync(path.dirname(stateFile(s.homeDir, s.ws)), { recursive: true, mode: 0o700 });
    s.store?.saveTo(objectsDir(s.homeDir, s.ws), s.trusted);
    const tmp = `${stateFile(s.homeDir, s.ws)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date().toISOString(), patterns: s.set.patterns, entries: [...s.trusted] }), { mode: 0o600 });
    fs.renameSync(tmp, stateFile(s.homeDir, s.ws));
  } catch {
    /* best effort */
  }
}
function loadPersisted(homeDir: string, ws: string): { fp: ProtectedFingerprint; patterns?: string[] } | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(homeDir, ws), 'utf8'));
    return { fp: new Map(j.entries), patterns: Array.isArray(j.patterns) ? j.patterns : undefined };
  } catch {
    return undefined;
  }
}

/** A human can answer right now: the UI asks (CLI REPL, VS Code, a server client) and the run is not unattended. */
function askerFor(a: AgentApi): ((q: string, options?: string[]) => Promise<string>) | undefined {
  if (a.config.unattended) return undefined;
  return (a.agent as { opts?: { ui?: { askUser?: (q: string, options?: string[]) => Promise<string> } } }).opts?.ui?.askUser;
}

/**
 * R1 (A): the first session on a workspace (in this process) holds whatever changed in the protected set since the last
 * trusted state, instead of deciding on the user's behalf: the guard cannot tell the user's edit from a process an earlier
 * session left running. The change is restored and backed up; a human is asked to keep it or not; with no human
 * (`tug -p`, eval, scheduled, channel and remote runs) it stays restored and is recorded (fail closed).
 */
async function holdChangesSinceLastSession(a: AgentApi, s: WsState): Promise<void> {
  const persisted = loadPersisted(s.homeDir, s.ws);
  s.store ??= new ProtectedContentStore();
  if (!persisted || !persisted.patterns || persisted.patterns.join('\0') !== s.set.patterns.join('\0')) {
    // nothing to compare with: the first session here, protectedPaths changed, or a state saved before copies were kept
    // (an older version): start from the current state, and say so
    s.trusted = snapshot(s, a);
    if (persisted) a.notice('info', `protected paths: ${persisted.patterns ? 'the protected set changed' : 'the saved state has no copies (older version)'} since the last session; the guard starts from the current state`);
    return;
  }
  s.store.loadFrom(objectsDir(s.homeDir, s.ws), persisted.fp);
  s.trusted = persisted.fp;
  const v = checkAndRestore(s, 'a change made while no Tugline session was open (your own edit, or a process an earlier session left running)', persisted.fp);
  s.trusted = snapshot(s, a); // the state after the check (restored, or accepted) is the trusted one
  if (!v) return;
  const files = v.changes.map((c) => c.rel);
  const restored = v.failed.length ? `Restored except ${v.failed.join(', ')} (no trusted copy; those changes stay).` : 'They were restored to the last trusted version.';
  const kept = v.backup ? ` Your version is kept in ${v.backup}.` : '';
  const ask = askerFor(a);
  if (ask) {
    const answer = await ask(`Protected files changed while no Tugline session was open: ${describe(v.changes)}. They may be your own edits, or a process an earlier session left running. ${restored}${kept} Keep your version, or keep the restored one?`, ['keep my version', 'restore']);
    if (/^k/i.test(String(answer).trim()) && v.backup) {
      const r = acceptProtected(s.homeDir, s.ws, files, v.backup);
      a.notice('info', `protected files: kept your version of ${r.accepted.join(', ') || 'nothing'}`);
      recordSecurityEvent(a, { type: 'protected_restore', category: 'external_change', decision: 'accept', by: 'user', reason: `kept the version changed while no session was open: ${describe(v.changes)}` });
      return;
    }
    a.notice('info', `protected files: kept the restored version of ${describe(v.changes)}${kept}`);
    recordSecurityEvent(a, { type: 'protected_restore', category: 'external_change', decision: 'restore', by: 'user', reason: `restored the version changed while no session was open: ${describe(v.changes)}` });
    return;
  }
  report(a, v, '', {});
  const notKept = v.failed.length < v.changes.length ? ' No one can be asked in this run, so the change is not kept.' : '';
  a.notice('warn', `protected files changed while no Tugline session was open: ${describe(v.changes)}. ${restored}${kept}${notKept} To keep it: tug protect accept ${files.slice(0, 4).join(' ')}${files.length > 4 ? ' …' : ''}`);
}

export let IDLE_POLL_MS = 2000;
export let GUARD_POLL_MS = 1000;
/** Tests only. */
export function setGuardPollMs(ms: number, idleMs?: number): void {
  GUARD_POLL_MS = ms;
  if (idleMs !== undefined) IDLE_POLL_MS = idleMs;
}

// Tag every command spawned for a watched shell call with its guard id (before the OS sandbox wraps the spec).
registerCommandWrapper('ws3-guard-id', () => (spec) => {
  // only the model's shell commands are tagged; other spawns (helpers, eval wrappers) are left exactly as they were
  for (const s of states.values())
    for (const f of s.inflight)
      if (!f.jobId && spec.args.some((x) => x === f.command || x.trim() === f.command.trim())) return { ...spec, env: { ...spec.env, [GUARD_ENV]: f.id } };
  return spec;
});

// Fail closed past the entry cap: a policy hard deny for every command, with the reason.
setShellGate((workspace) => {
  const s = states.get(realResolve(workspace));
  if (!s || s.off || !s.overCap) return null;
  return `refusing to run commands: the protected set (${s.set.patterns.length} patterns) has more than ${s.maxEntries} entries, so the shell guard cannot check it. Narrow permissions.protectedPaths, raise shellGuardMaxEntries, or use the OS sandbox (shell.sandbox).`;
});

registerAgentExtension({
  id: 'ws3-protect-guard',
  async onRunStart(a) {
    if (a.depth !== 0 || a.config.shellGuard === 'off') return;
    const s = stateFor(a);
    s.runs++;
    if (!unsandboxedWarned.has(a.config)) {
      unsandboxedWarned.add(a.config);
      try {
        const { sandboxStatus } = await import('../sandbox/index.js');
        const st = sandboxStatus(a.config);
        if (st.runner === 'none')
          a.notice(
            'info',
            st.processLifetime === 'bwrap'
              ? 'protected paths: without an OS sandbox they are checked around each command and watched between runs, and restored when changed. Commands cannot outlive the session (bwrap PID namespace), so nothing an earlier command started can rewrite them later; the OS sandbox (shell.sandbox) also keeps a running command from writing them.'
              : 'protected paths: without an OS sandbox they are checked around each command and watched between runs, and restored when changed. A process that sheds its guard id can still rewrite them until the next check, and a command can read a changed file in that window; a change found when a session starts is held for you to decide. The OS sandbox (shell.sandbox) prevents it.',
          );
      } catch {
        /* status is best effort */
      }
    }
    if (!s.trusted) {
      // The first session in this process: hold (never adopt) what changed since the last trusted state, and warn
      // when another process holds the workspace.
      await holdChangesSinceLastSession(a, s);
      try {
        const { workspaceLeaseStatus, describeHolder } = await import('../workspace/lease.js');
        const l = workspaceLeaseStatus(s.homeDir, s.ws);
        if (l.held && !l.stale && l.lease && l.lease.pid !== process.pid) a.notice('warn', `another Tugline session is writing this workspace (${describeHolder(l.lease)}); each session's guard restores protected files from its own starting state`);
      } catch {
        /* lease status is informational */
      }
      startWatching(s);
      return;
    }
    // A session is open: whatever changed since the last check is restored, never adopted.
    const v = checkAndRestore(s, 'something between runs (a process left running, or an edit while the session is open)', s.trusted, [], { userEdit: true });
    if (v) {
      report(a, v, '', {});
      note(a, v.message);
      a.notice('error', v.message);
    }
    startWatching(s);
  },
  async onRunEnd(a) {
    if (a.depth !== 0) return;
    const s = states.get(realResolve(a.workspace));
    if (!s || s.off) return;
    s.runs = Math.max(0, s.runs - 1);
    if (s.inflight.size) return; // background jobs still running keep their own guard
    for (const pid of strayAgentProcesses()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    // Never adopted at run end either: anything that changed since the last check is restored.
    const v = checkAndRestore(s, 'something after the last command of the run');
    if (v) {
      report(a, v, '', {});
      a.notice('error', v.message);
    }
    persistTrusted(s);
  },
  beforeShell(a, command) {
    if (a.config.shellGuard === 'off') return;
    const s = stateFor(a);
    // Calls of this agent that never reached afterTool (the tool threw) are settled now (one shell command at a time per agent).
    for (const f of [...s.inflight]) {
      if (f.agent !== a.agent || f.jobId) continue;
      s.inflight.delete(f);
      void killProcessesWithGuardId(f.id);
      const v = checkAndRestore(s, `the command "${f.command}"`);
      if (v) {
        report(a, v, f.command, { command: f.command });
        note(a, v.message);
      }
    }
    // Before every command nothing may have changed the set since the last check: compare with the
    // trusted state and restore (also while background jobs run), never adopt silently.
    if (s.trusted) {
      const jobs = [...s.inflight].some((x) => x.jobId);
      const v = checkAndRestore(s, jobs ? 'a background job, or something between commands' : 'something between commands (a process left running, or an edit during the run)');
      if (v) {
        report(a, v, '', {});
        note(a, v.message);
        a.notice('error', v.message);
      }
    }
    if (!s.inflight.size || !s.trusted) {
      s.trusted = snapshot(s, a);
      if (s.overCap) a.notice('error', `protected-path guard: more than ${s.maxEntries} entries; shell commands are refused until the set is narrowed`);
    }
    s.inflight.add({ agent: a.agent as object, command, id: newCommandId() });
  },
  async afterTool(a, call) {
    const notes = pendingNotes.get(a.agent as object) ?? [];
    pendingNotes.delete(a.agent as object);
    const command = typeof (call.args as { command?: unknown })?.command === 'string' ? String((call.args as { command: string }).command).trim() : undefined;
    const s = states.get(realResolve(a.workspace));
    const f = s && command !== undefined ? [...s.inflight].find((x) => x.agent === a.agent && !x.jobId && x.command.trim() === command) : undefined;
    if (s && !f && !s.off && !s.inflight.size && s.trusted) {
      // A non-shell tool ran: the files it reports writing (the file tools, remember …) are the harness's own and
      // are adopted; any other change to the set happened outside it and is restored.
      const m = call.meta as Record<string, unknown>;
      const reported = [m.changedFile, m.memoryFile, ...(Array.isArray(m.changes) ? (m.changes as { path?: unknown }[]).map((c) => c?.path) : [])].filter((x): x is string => typeof x === 'string').map((x) => path.resolve(a.workspace, x));
      const v = checkAndRestore(s, 'something during a tool call (a process left running, or an edit while the session is open)', s.trusted, reported.map((x) => path.join(s.ws, path.relative(realResolve(a.workspace), realResolve(x)))));
      if (v) {
        report(a, v, '', {});
        notes.push(v.message);
      }
    }
    if (!s || !f) return notes.length ? { text: notes.join('\n'), isError: true } : undefined;
    if (typeof call.meta.jobId === 'string') watchJob(a, s, f, call.meta.jobId, call.args);
    else {
      // The foreground command has exited: whatever it left running (`&`, nohup, setsid) goes now, before the check.
      await killProcessesWithGuardId(f.id);
      s.inflight.delete(f);
    }
    const v = checkAndRestore(s, 'this command');
    if (!v) return notes.length ? { text: notes.join('\n'), isError: true } : undefined;
    report(a, v, f.command, call.args);
    return { text: [...notes, v.message].join('\n'), isError: true };
  },
  onSessionEnd(a) {
    const s = states.get(realResolve(a.workspace));
    if (!s) return;
    for (const f of [...s.inflight]) if (f.agent === a.agent && !f.jobId) s.inflight.delete(f);
    s.sessions.delete(a.agent as object);
    if (s.lastApi?.agent === a.agent) s.lastApi = undefined;
    if (!s.sessions.size && !s.inflight.size && !s.runs) {
      idleCheck(s);
      persistTrusted(s);
      stopWatching(s);
      stopTimerIfIdle(s);
      s.store?.dispose();
      states.delete(s.ws);
    }
  },
});

// ------------------------------------------------------------ explicit accept (/protect accept, tug protect accept)

/** The newest backup folder for a workspace, or undefined. */
export function latestBackup(homeDir: string, workspace: string): string | undefined {
  const dir = path.join(homeDir, 'protect-backups', wsKey(realResolve(workspace)));
  try {
    const all = fs.readdirSync(dir).sort();
    return all.length ? path.join(dir, all[all.length - 1]!) : undefined;
  } catch {
    return undefined;
  }
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else if (e.isFile() && !(dir === base && e.name === DELETED_MANIFEST)) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

/**
 * The user's explicit acceptance of changed protected files: put the backed-up (changed) version back and
 * mark exactly that content as accepted, so every guard adopts it instead of restoring it.
 */
export function acceptProtected(homeDir: string, workspace: string, paths: string[] = [], from?: string): { accepted: string[]; backup?: string; missing: string[] } {
  const ws = realResolve(workspace);
  const backup = from ?? latestBackup(homeDir, ws);
  if (!backup) return { accepted: [], missing: paths };
  const files = listFiles(backup);
  let deleted: string[] = [];
  try {
    deleted = JSON.parse(fs.readFileSync(path.join(backup, DELETED_MANIFEST), 'utf8'));
  } catch {
    /* no deletions in this backup */
  }
  const want = paths.length ? paths.map((p) => path.relative(ws, path.resolve(ws, p)).split(path.sep).join('/')) : [...files, ...deleted];
  const accepted: string[] = [];
  const missing: string[] = [];
  const marker = readAccepted(homeDir, ws);
  const removals: string[] = [];
  for (const rel of want) {
    if (deleted.includes(rel) && !files.includes(rel)) {
      marker[rel] = ACCEPTED_DELETION;
      removals.push(rel);
      accepted.push(rel);
      continue;
    }
    if (!files.includes(rel)) {
      missing.push(rel);
      continue;
    }
    const h = sha256(path.join(backup, rel));
    if (!h) continue;
    marker[rel] = h;
    accepted.push(rel);
  }
  fs.mkdirSync(path.dirname(acceptFile(homeDir, ws)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(acceptFile(homeDir, ws), JSON.stringify(marker), { mode: 0o600 });
  for (const rel of accepted) {
    if (removals.includes(rel)) {
      fs.rmSync(path.join(ws, rel), { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.copyFileSync(path.join(backup, rel), path.join(ws, rel));
  }
  // a guard in this process adopts it now
  const s = states.get(ws);
  if (s && !s.inflight.size) checkAndRestore(s, 'accept');
  return { accepted, backup, missing };
}

function acceptText(r: ReturnType<typeof acceptProtected>): string {
  if (!r.backup) return 'protect: no backed-up change to accept for this workspace';
  return [
    r.accepted.length ? `accepted (from ${r.backup}): ${r.accepted.join(', ')}` : 'nothing accepted',
    r.missing.length ? `not in that backup: ${r.missing.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

registerSlashCommand({
  name: 'protect',
  description: 'protected files the guard restored: accept your own change, or list backups',
  usage: 'accept [path…] | backups',
  run(args, ctx) {
    const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (sub === 'accept') ctx.write(acceptText(acceptProtected(ctx.config.homeDir, ctx.workspace, rest)));
    else if (sub === 'backups') ctx.write(latestBackup(ctx.config.homeDir, ctx.workspace) ?? 'no backups');
    else ctx.write('usage: /protect accept [path…] | /protect backups');
  },
});

registerCliCommand({
  name: 'protect',
  description: 'accept a change to protected files that the guard restored (it was kept in a backup)',
  usage: 'accept [path…] [--from BACKUP_DIR] | backups',
  needsModel: false,
  run(argv, ctx) {
    const i = argv.indexOf('--from');
    const from = i >= 0 ? argv[i + 1] : undefined;
    const rest = argv.filter((x, k) => k !== i && k !== i + 1 || i < 0);
    const [sub, ...paths] = rest;
    if (sub === 'accept') {
      const r = acceptProtected(ctx.config.homeDir, ctx.workspace, paths, from);
      ctx.write(acceptText(r) + '\n');
      return r.accepted.length ? 0 : 1;
    }
    if (sub === 'backups') {
      ctx.write((latestBackup(ctx.config.homeDir, ctx.workspace) ?? 'no backups') + '\n');
      return 0;
    }
    ctx.write('usage: tug protect accept [path…] [--from BACKUP_DIR] | tug protect backups\n');
    return 2;
  },
});

export { MAX_ENTRIES };
