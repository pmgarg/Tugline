/**
 * Checkpoints (SPEC C1): snapshot the workspace before every turn and before
 * every shell command, list them, diff them, and rewind files and/or the
 * conversation.
 *
 * Integration is entirely through seams: an agent extension (`beforeTurn`,
 * `beforeShell`, S0.3) and slash commands (`/checkpoints`, `/rewind`, S0.6).
 * Storage is a shadow git repository (shadow.ts) or, without git, content-
 * addressed copies (copy.ts). Neither ever writes to the user's `.git`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { ChatMessage } from '../types.js';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import { registerSlashCommand, type SlashContext } from '../commands.js';
import { contentToText, truncateLine } from '../util/text.js';
import { rootSession } from '../permissions/limits.js';
import { CopyBackend } from './copy.js';
import { ShadowGitBackend, gitAvailable } from './shadow.js';
import { DEFAULT_CHECKPOINTS, type CheckpointBackend, type CheckpointConfig, type CheckpointMeta, type FileChange, type RestoreResult, type SnapshotInput } from './types.js';

export * from './types.js';

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC C1 (WS3). Defaults: DEFAULT_CHECKPOINTS. */
    checkpoints?: Partial<CheckpointConfig>;
  }
}

export function checkpointConfig(cfg: HarnessConfig): CheckpointConfig {
  return { ...DEFAULT_CHECKPOINTS, ...(cfg.checkpoints ?? {}) };
}

/** Stable per-workspace directory name: readable basename + hash of the real path. */
export function projectKey(workspace: string): string {
  let real = path.resolve(workspace);
  try {
    real = fs.realpathSync(real);
  } catch {
    /* keep */
  }
  const base = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root';
  return `${base}-${crypto.createHash('sha1').update(real).digest('hex').slice(0, 12)}`;
}

export interface RestoreOptions {
  /** Restore workspace files (default true). */
  files?: boolean;
  /** Truncate the agent's conversation to the checkpoint (default false). */
  conversation?: boolean;
  /** The agent whose conversation to truncate (required for conversation restore). */
  agent?: any;
}

export interface RestoreOutcome extends RestoreResult {
  checkpoint: CheckpointMeta;
  /** Safety snapshot taken just before restoring files (rewind to it to undo the rewind). */
  preRestoreId?: string;
  /** New conversation length when the conversation was truncated. */
  conversationLength?: number;
  /** Why the conversation was not truncated, if it was requested but skipped. */
  conversationSkipped?: string;
  /** 'truncateTo' (WS4 core API, D12) or 'splice' fallback. */
  conversationMethod?: 'truncateTo' | 'splice';
}

export class CheckpointManager {
  readonly storeDir: string;
  private backendP?: Promise<CheckpointBackend>;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when snapshots before shell commands were turned off (slow repo). */
  shellDisabled = false;
  /** Set when checkpoints cannot run at all for this workspace. */
  disabledReason?: string;
  failures = 0;
  /** Compaction epoch of the agent at each checkpoint (in-memory: conversation restore is per process). */
  private epochs = new Map<string, number>();

  constructor(readonly workspace: string, homeDir: string, readonly conf: CheckpointConfig) {
    this.storeDir = path.join(homeDir, 'checkpoints', projectKey(workspace));
    const real = (() => {
      try {
        return fs.realpathSync(workspace);
      } catch {
        return path.resolve(workspace);
      }
    })();
    // Snapshotting a home directory or a filesystem root would copy the whole machine (research ED §5.2).
    if (real === path.parse(real).root || real === os.homedir()) this.disabledReason = `checkpoints are off for ${real} (home directory or filesystem root)`;
  }

  backend(): Promise<CheckpointBackend> {
    if (!this.backendP) {
      this.backendP = (async () => {
        const max = Math.max(0, this.conf.maxFileMB) * 1024 * 1024;
        const useGit = this.conf.backend === 'git' || (this.conf.backend === 'auto' && (await gitAvailable()));
        return useGit ? new ShadowGitBackend(this.workspace, this.storeDir, max) : new CopyBackend(this.workspace, this.storeDir, max);
      })();
    }
    return this.backendP;
  }

  /** Serialize all store operations (a subagent's shell snapshot may race the parent's turn snapshot). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async snapshot(meta: SnapshotInput, epoch = 0): Promise<CheckpointMeta | undefined> {
    if (this.disabledReason) return undefined;
    const cp = await this.serial(async () => (await this.backend()).snapshot(meta));
    if (cp) this.epochs.set(cp.id, epoch);
    return cp;
  }

  list(limit?: number): Promise<CheckpointMeta[]> {
    return this.serial(async () => (await this.backend()).list(limit));
  }

  async find(idOrPrefix: string): Promise<CheckpointMeta | undefined> {
    const all = await this.list(1000);
    return all.find((c) => c.id === idOrPrefix) ?? all.find((c) => c.id.startsWith(idOrPrefix));
  }

  diff(id: string): Promise<{ files: FileChange[]; patch?: string }> {
    return this.serial(async () => (await this.backend()).diff(id));
  }

  /** Turn checkpoints of a session, newest first. */
  async turns(sessionId?: string): Promise<CheckpointMeta[]> {
    return (await this.list(1000)).filter((c) => c.kind === 'turn' && (!sessionId || c.sessionId === sessionId));
  }

  async restore(id: string, opts: RestoreOptions = {}): Promise<RestoreOutcome> {
    const cp = await this.find(id);
    if (!cp) throw new Error(`unknown checkpoint "${id}"`);
    const out: RestoreOutcome = { checkpoint: cp, restored: [], removed: [] };
    if (opts.files !== false) {
      const pre = await this.snapshot({ label: `before rewind to ${cp.id}`, kind: 'pre-restore', sessionId: opts.agent?.sessionId });
      out.preRestoreId = pre?.id;
      const r = await this.serial(async () => (await this.backend()).restoreFiles(cp.id));
      out.restored = r.restored;
      out.removed = r.removed;
      // The agent must re-read restored files before editing them (stale-read guard).
      const ledger = opts.agent?.ledger;
      if (ledger && typeof ledger.forget === 'function') for (const p of [...r.restored, ...r.removed]) ledger.forget(path.join(this.workspace, p));
    }
    if (opts.conversation) {
      const agent = opts.agent;
      const curEpoch = agent ? compactionEpoch(agent) : 0;
      if (!agent) out.conversationSkipped = 'no agent given';
      else if (cp.messageIndex === undefined) out.conversationSkipped = 'checkpoint has no conversation position';
      else if (cp.sessionId && cp.sessionId !== agent.sessionId) out.conversationSkipped = 'checkpoint belongs to another session';
      else if (!this.epochs.has(cp.id) || this.epochs.get(cp.id) !== curEpoch) out.conversationSkipped = 'the conversation was compacted or reloaded since this checkpoint';
      else if (cp.messageIndex > agent.messages.length) out.conversationSkipped = 'conversation is already shorter than the checkpoint';
      else {
        if (typeof agent.truncateTo === 'function') {
          agent.truncateTo(cp.messageIndex);
          out.conversationMethod = 'truncateTo';
        } else {
          // Fallback until WS4's agent.truncateTo (D12) lands: splice the public message array.
          (agent.messages as ChatMessage[]).splice(cp.messageIndex);
          out.conversationMethod = 'splice';
        }
        out.conversationLength = agent.messages.length;
      }
    }
    return out;
  }
}

const managers = new Map<string, CheckpointManager>();

/** The shared manager for a workspace and config (one per homeDir + workspace). */
export function checkpointsFor(cfg: HarnessConfig, workspace: string): CheckpointManager {
  const key = `${cfg.homeDir}\0${path.resolve(workspace)}`;
  let m = managers.get(key);
  if (!m) {
    m = new CheckpointManager(workspace, cfg.homeDir, checkpointConfig(cfg));
    managers.set(key, m);
  }
  return m;
}

// ------------------------------------------------------------ conversation epochs

const epochOf = new WeakMap<object, number>();
function compactionEpoch(agent: object): number {
  return epochOf.get(agent) ?? 0;
}

// ------------------------------------------------------------ agent extension

async function take(a: AgentApi, meta: SnapshotInput): Promise<void> {
  const conf = checkpointConfig(a.config);
  if (!conf.enabled) return;
  const m = checkpointsFor(a.config, a.workspace);
  if (m.disabledReason) {
    if (m.failures++ === 0) a.notice('warn', m.disabledReason);
    return;
  }
  if (meta.kind === 'shell' && m.shellDisabled) return;
  const started = Date.now();
  let cp: CheckpointMeta | undefined;
  try {
    cp = await m.snapshot(meta, compactionEpoch(a.agent as object));
  } catch (e) {
    m.failures++;
    if (m.failures <= 3) a.notice('warn', `checkpoint failed: ${(e as Error).message}`);
    if (m.failures === 3) {
      m.disabledReason = 'checkpoints disabled for this session after 3 failures';
      a.notice('warn', m.disabledReason);
    }
    return;
  }
  const ms = Date.now() - started;
  if (ms > conf.slowSnapshotMs && !m.shellDisabled) {
    m.shellDisabled = true;
    a.notice('warn', `checkpoint took ${(ms / 1000).toFixed(1)}s; snapshots before shell commands are off for this session (turn checkpoints continue)`);
  }
  if (!cp) return;
  a.emit({ type: 'checkpoint', id: cp.id, label: cp.label, turn: cp.turn, messageIndex: cp.messageIndex, files: cp.files });
  a.journal({ type: 'checkpoint', id: cp.id, kind: cp.kind, label: cp.label, turn: cp.turn, messageIndex: cp.messageIndex, files: cp.files, ms });
}

function lastPromptText(msgs: ChatMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i]._meta?.synthetic) return contentToText(msgs[i].content);
  return '';
}

registerAgentExtension({
  id: 'ws3-checkpoints',
  onEvent(a, e) {
    if (e.type === 'compaction') epochOf.set(a.agent as object, compactionEpoch(a.agent as object) + 1);
  },
  async beforeTurn(a, turn) {
    // Subagents share the workspace; their shell commands are covered by beforeShell.
    if (a.depth !== 0) return;
    const msgs = a.messages;
    // Turn 1 rewinds to before the run's prompt; later turns to the start of that turn.
    const messageIndex = turn === 1 && msgs.at(-1)?.role === 'user' ? msgs.length - 1 : msgs.length;
    const label = turn === 1 ? `turn 1: ${truncateLine(lastPromptText(msgs).replace(/<([a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, '').replace(/\s+/g, ' ').trim(), 60)}` : `turn ${turn}`;
    await take(a, { label, kind: 'turn', sessionId: a.sessionId, runId: a.runId, turn, messageIndex });
  },
  async beforeShell(a, command) {
    const msgs = a.messages;
    let idx = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--)
      if (msgs[i].role === 'assistant') {
        idx = i;
        break;
      }
    await take(a, { label: `before: ${truncateLine(command.replace(/\s+/g, ' '), 60)}`, kind: 'shell', sessionId: rootSession(a.sessionId), runId: a.runId, turn: a.stats.turns, messageIndex: a.depth === 0 ? idx : undefined });
  },
});

// ------------------------------------------------------------ slash commands

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function formatCheckpoints(list: CheckpointMeta[]): string {
  if (!list.length) return '  (no checkpoints yet)';
  return list.map((c, i) => `  ${String(i).padStart(2)}  ${c.id}  ${fmtTime(c.ts)}  ${c.kind.padEnd(11)} ${c.label}${c.files ? `  (${c.files} file${c.files === 1 ? '' : 's'} changed)` : ''}`).join('\n');
}

export function formatRestore(r: RestoreOutcome): string {
  const lines = [`  rewound to ${r.checkpoint.id} (${r.checkpoint.label})`];
  if (r.restored.length) lines.push(`  restored: ${r.restored.join(', ')}`);
  if (r.removed.length) lines.push(`  removed:  ${r.removed.join(', ')}`);
  if (!r.restored.length && !r.removed.length && r.preRestoreId) lines.push('  files already matched the checkpoint');
  if (r.conversationLength !== undefined) lines.push(`  conversation truncated to ${r.conversationLength} messages (${r.conversationMethod === 'truncateTo' ? 'agent.truncateTo' : 'splice fallback'})`);
  if (r.conversationSkipped) lines.push(`  conversation not changed: ${r.conversationSkipped}`);
  if (r.preRestoreId) lines.push(`  undo this rewind with: /rewind ${r.preRestoreId}`);
  return lines.join('\n');
}

/** Resolve "/rewind" arguments: a number n = n turn checkpoints back (0 = latest), else a checkpoint id. */
export async function resolveRewindTarget(m: CheckpointManager, arg: string, sessionId?: string): Promise<CheckpointMeta | undefined> {
  if (/^\d{1,3}$/.test(arg)) {
    const turns = await m.turns(sessionId);
    if (!turns.length) return undefined;
    return turns[Math.min(Number(arg), turns.length - 1)];
  }
  return m.find(arg);
}

registerSlashCommand({
  name: 'checkpoints',
  description: 'list workspace checkpoints (taken before each turn and shell command)',
  usage: '[count]',
  async run(args, ctx: SlashContext) {
    const m = checkpointsFor(ctx.config, ctx.workspace);
    if (m.disabledReason) return void ctx.write(`  ${m.disabledReason}`);
    const n = Math.max(1, Math.min(200, Number(args.trim()) || 20));
    ctx.write(`${formatCheckpoints(await m.list(n))}\n  (backend: ${(await m.backend()).kind}; store: ${m.storeDir})`);
  },
});

registerSlashCommand({
  name: 'rewind',
  description: 'restore files and/or conversation to a checkpoint: n turns back or a checkpoint id',
  usage: '[n|id] [files|chat|both]',
  async run(args, ctx: SlashContext) {
    const m = checkpointsFor(ctx.config, ctx.workspace);
    const [target, scopeArg] = args.trim().split(/\s+/).filter(Boolean);
    if (!target) {
      ctx.write(`${formatCheckpoints((await m.list(15)).filter((c) => c.kind === 'turn' || c.kind === 'pre-restore'))}\n  usage: /rewind <n turns back | id> [files|chat|both]`);
      return;
    }
    const scope = scopeArg ?? 'both';
    if (!['files', 'chat', 'both'].includes(scope)) return void ctx.write('  scope must be files, chat or both');
    if (ctx.agent?.isRunning) return void ctx.write('  cannot rewind while the agent is running');
    const cp = await resolveRewindTarget(m, target, ctx.agent?.sessionId);
    if (!cp) return void ctx.write(`  no checkpoint "${target}"`);
    const r = await m.restore(cp.id, { files: scope !== 'chat', conversation: scope !== 'files', agent: ctx.agent });
    ctx.write(formatRestore(r));
  },
});

/**
 * `/undo [n|all]` on checkpoints (replaces the v0.1 in-memory undo, SPEC C1):
 * revert the file changes of the last n prompts (runs) of this session, by
 * restoring the turn-1 checkpoint of the n-th most recent run. Unlike the old
 * editHistory undo it also reverts changes made by shell commands, and the
 * undo itself is undoable (/rewind <pre-restore id>). Falls back to the old
 * per-edit undo when checkpoints are off.
 */
registerSlashCommand({
  name: 'undo',
  description: "revert the file changes of the last prompt(s) (edits and shell commands), via checkpoints",
  usage: '[n|all]',
  async run(args, ctx: SlashContext) {
    const agent = ctx.agent;
    const m = checkpointsFor(ctx.config, ctx.workspace);
    if (!checkpointConfig(ctx.config).enabled || m.disabledReason) {
      if (!agent || typeof agent.undo !== 'function') return void ctx.write('  nothing to undo');
      const n = args.trim() === 'all' ? agent.editHistory.length : Math.max(1, Number(args) || 1);
      const r = agent.undo(n);
      ctx.write(r.restored.length ? `  restored: ${r.restored.join(', ')}` : '  nothing to undo');
      if (r.skipped.length) ctx.write(`  skipped: ${r.skipped.join(', ')}`);
      return;
    }
    if (agent?.isRunning) return void ctx.write('  cannot undo while the agent is running');
    const runStarts = (await m.turns(agent?.sessionId)).filter((c) => c.turn === 1);
    if (!runStarts.length) return void ctx.write('  nothing to undo');
    const n = args.trim() === 'all' ? runStarts.length : Math.max(1, Number(args) || 1);
    const target = runStarts[Math.min(n, runStarts.length) - 1];
    const r = await m.restore(target.id, { files: true, agent });
    ctx.write(r.restored.length || r.removed.length ? formatRestore(r) : '  nothing to undo (files already match)');
  },
});
