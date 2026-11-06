/**
 * Live sessions behind the server (SPEC G2). Each session is an ordinary
 * `Agent`; this class only translates between the protocol and the core APIs:
 * run/steer/enqueue/abort (D12), permission callbacks, checkpoints (C1), jobs
 * (D5), slash commands (S0.6).
 *
 * Authority stays in the agent's permission engine. The server is just another
 * approval UI: an `ask` decision becomes a `session/permission` notification to
 * the attached clients, and if no client answers (none attached, all gone,
 * timeout, abort) the answer is DENY, which the agent records as a refusal.
 */
import { isPermissionMode, invalidModeMessage } from '../core/approver/modes.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Agent, type AgentOptions } from '../core/agent/agent.js';
import { Journal } from '../core/agent/journal.js';
import { loadConfig, resolveProfile, type HarnessConfig } from '../core/config.js';
import { getSlashCommand } from '../core/commands.js';
import { checkpointsFor } from '../core/checkpoint/index.js';
import { listJobs } from '../core/jobs/manager.js';
import type { ElicitAnswer, ElicitRequestInfo } from '../core/mcp/manager.js';
import type { AgentEvent, PermissionAnswer, PermissionMode, PermissionRequest } from '../core/types.js';
import { ERR, RpcError, type RpcPeer } from './rpc.js';
import { SAFE_CONFIG_KEYS, type RunSummary, type SavedSession, type SessionInfo } from './protocol.js';
import { markUnattended } from '../core/sandbox/index.js';

declare module '../core/config.js' {
  interface HarnessConfigExtensions {
    /** SPEC G2/H5: `tug serve`. */
    server?: ServerSettings;
  }
}

export interface ServerSettings {
  /** WebSocket port (0 = any free port). Default 7878. */
  port?: number;
  /** How long a permission / question waits for a client answer before it is denied. Default 300000. */
  interactionTimeoutMs?: number;
  /** If set, session workspaces must be inside one of these directories. */
  allowedRoots?: string[];
  /** Browser origins allowed to connect (default none: requests with an Origin header are refused). */
  allowedOrigins?: string[];
  remote?: {
    /** Accept remote/run (H5). Default false. */
    enabled?: boolean;
    /** Allow local paths and file:// repositories (tests, same-machine use). Default false. */
    allowLocalRepos?: boolean;
    /** Where server-side clones live. Default <homeDir>/remote-workspaces. */
    workRoot?: string;
    /** Default permission mode for remote sessions. Default "acceptEdits". */
    mode?: PermissionMode;
  };
}

export const DEFAULT_SERVER: Required<Pick<ServerSettings, 'port' | 'interactionTimeoutMs'>> = { port: 7878, interactionTimeoutMs: 300_000 };

export interface HostOptions {
  /** Default workspace for new sessions. */
  workspace: string;
  /** Config of the server process (server.* settings, homeDir). */
  config: HarnessConfig;
  /** Build a session's config. Default: loadConfig for that workspace (governance applies) with the overrides. */
  configFor?: (workspace: string, overrides: Record<string, unknown>) => HarnessConfig | Promise<HarnessConfig>;
  /** Extra Agent options (bundled skill dirs, injected LLM for tests …). */
  agentOptions?: Partial<AgentOptions>;
}

/** One connected client. */
export interface ClientConn {
  id: string;
  peer: RpcPeer;
  /** R16: who authenticated: 'owner' (the server token / stdio) or 'client:<id>' (an issued client token) */
  principal?: string;
  /** close the connection (token revoked) */
  close?: () => void;
}

interface Pending {
  kind: 'permission' | 'ask' | 'plan' | 'elicit';
  resolve: (v: any) => void;
  timer: NodeJS.Timeout;
  fallback: unknown;
}

export interface LiveSession {
  id: string;
  /** R16: the principal that created or loaded it */
  owner: string;
  workspace: string;
  agent: Agent;
  createdAt: string;
  subscribers: Set<ClientConn>;
  pending: Map<string, Pending>;
  /** Set while session/prompt runs. */
  run?: Promise<RunSummary>;
}

const DENY_NO_CLIENT = 'no client is attached to answer (denied and recorded)';

export class SessionHost {
  readonly sessions = new Map<string, LiveSession>();
  /** Server-made workspaces (H5 clones) that may sit outside allowedRoots. */
  readonly internalOk = new Set<string>();
  constructor(readonly opts: HostOptions) {}

  get settings(): ServerSettings {
    return this.opts.config.server ?? {};
  }

  private timeoutMs(): number {
    return this.settings.interactionTimeoutMs ?? DEFAULT_SERVER.interactionTimeoutMs;
  }

  // ------------------------------------------------------------ helpers

  /** R16: the owner principal may address every session; a client principal only its own. */
  mayAddress(s: LiveSession, conn?: ClientConn): boolean {
    if (!conn) return true; // internal callers
    const p = conn.principal ?? 'owner';
    return p === 'owner' || s.owner === p;
  }

  get(sessionId: unknown, conn?: ClientConn): LiveSession {
    const s = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    // a session of another client answers exactly like a missing one (its id is not confirmed)
    if (!s || !this.mayAddress(s, conn)) throw new RpcError(ERR.NOT_FOUND, `unknown session ${String(sessionId)}`);
    return s;
  }

  /** R16: a revoked client token: close its connections and detach them; its sessions stay (the owner can still reach them). */
  revokePrincipal(principal: string): void {
    for (const s of this.sessions.values())
      for (const c of [...s.subscribers])
        if (c.principal === principal) {
          s.subscribers.delete(c);
          c.close?.();
        }
    for (const c of this.connections) if (c.principal === principal) c.close?.();
  }

  /** Authenticated connections (for revocation). */
  readonly connections = new Set<ClientConn>();

  info(s: LiveSession): SessionInfo {
    return { sessionId: s.id, workspace: s.workspace, model: s.agent.llm.profile.model, mode: s.agent.policy.mode, running: s.agent.isRunning || !!s.run, createdAt: s.createdAt, journal: s.agent.journalFile };
  }

  /** Validate a workspace path from a client. */
  resolveWorkspace(ws: unknown, opts: { internal?: boolean } = {}): string {
    const raw = typeof ws === 'string' && ws ? ws : this.opts.workspace;
    let abs: string;
    try {
      abs = fs.realpathSync(path.resolve(raw));
    } catch {
      throw new RpcError(ERR.INVALID_PARAMS, `workspace does not exist: ${raw}`);
    }
    if (!fs.statSync(abs).isDirectory()) throw new RpcError(ERR.INVALID_PARAMS, `workspace is not a directory: ${raw}`);
    const roots = this.settings.allowedRoots;
    if (!opts.internal && roots?.length && !roots.some((r) => {
      const rel = path.relative(path.resolve(r), abs);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    })) throw new RpcError(ERR.FORBIDDEN, `workspace ${abs} is outside server.allowedRoots`);
    return abs;
  }

  private broadcast(s: LiveSession, method: string, params: unknown): void {
    for (const c of s.subscribers) c.peer.notify(method, params);
  }

  /** Ask the attached clients; the first answer wins. No client / timeout → fallback (a denial). */
  private interact<T>(s: LiveSession, kind: Pending['kind'], method: string, payload: Record<string, unknown>, fallback: T): Promise<T> {
    if (!s.subscribers.size) return Promise.resolve(fallback);
    const requestId = crypto.randomBytes(8).toString('hex');
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        s.pending.delete(requestId);
        resolve(fallback);
      }, this.timeoutMs());
      s.pending.set(requestId, { kind, resolve, timer, fallback });
      this.broadcast(s, method, { sessionId: s.id, requestId, ...payload });
    });
  }

  reply(s: LiveSession, kind: Pending['kind'], requestId: unknown, value: unknown): boolean {
    const p = typeof requestId === 'string' ? s.pending.get(requestId) : undefined;
    if (!p || p.kind !== kind) return false;
    s.pending.delete(requestId as string);
    clearTimeout(p.timer);
    p.resolve(value);
    return true;
  }

  /** Settle every open interaction with its fallback (abort, last client gone, delete). */
  private settleAll(s: LiveSession): void {
    for (const [id, p] of s.pending) {
      clearTimeout(p.timer);
      p.resolve(p.fallback);
      s.pending.delete(id);
    }
  }

  // ------------------------------------------------------------ lifecycle

  /** `internalWorkspace`: a server-made workspace (H5 clones), exempt from allowedRoots. Not reachable from the protocol. */
  async create(client: ClientConn | undefined, params: { workspace?: string; mode?: string; profile?: string; sessionId?: string; internalWorkspace?: boolean }): Promise<LiveSession> {
    const workspace = this.resolveWorkspace(params.workspace, { internal: params.internalWorkspace === true && client !== undefined && this.internalOk.has(params.workspace ?? '') });
    const overrides: Record<string, unknown> = {};
    if (params.mode !== undefined) {
      if (!isPermissionMode(params.mode)) throw new RpcError(ERR.INVALID_PARAMS, invalidModeMessage(params.mode));
      overrides.permissionMode = params.mode;
    }
    if (params.profile !== undefined) overrides.profile = String(params.profile);
    // Governance (managed policy, workspace trust) applies: the default builds the config with loadConfig.
    let config = await (this.opts.configFor ?? ((ws, o) => loadConfig({ workspace: ws, overrides: o })))(workspace, overrides);
    // N30: remote runs (H5 clones) are unattended: require the OS sandbox unless the user explicitly set shell.requireSandbox.
    if (params.internalWorkspace === true) config = markUnattended(config);
    if (overrides.profile && !config.profiles[String(overrides.profile)]) throw new RpcError(ERR.INVALID_PARAMS, `unknown profile ${overrides.profile}`);
    if (params.sessionId && this.sessions.has(params.sessionId)) throw new RpcError(ERR.INVALID_PARAMS, `session ${params.sessionId} is already live`);
    if (client) this.connections.add(client);
    const s: LiveSession = { id: '', owner: client?.principal ?? 'owner', workspace, agent: undefined as unknown as Agent, createdAt: new Date().toISOString(), subscribers: new Set(client ? [client] : []), pending: new Map() };
    const agent = await Agent.create({
      surface: 'Tugline server session (the user answers through a connected client)',
      ...this.opts.agentOptions,
      workspace,
      config,
      sessionId: params.sessionId,
      ui: {
        onEvent: (e: AgentEvent) => this.broadcast(s, 'session/event', { sessionId: s.id, event: e }),
        requestPermission: (request: PermissionRequest) => this.interact<PermissionAnswer>(s, 'permission', 'session/permission', { request }, { decision: 'deny', feedback: DENY_NO_CLIENT }),
        askUser: (question: string, options?: string[]) => this.interact<string>(s, 'ask', 'session/ask', { question, options }, ''),
        approvePlan: (plan: string) => this.interact<boolean>(s, 'plan', 'session/plan', { plan }, false),
      },
    });
    s.agent = agent;
    s.id = agent.sessionId;
    if (agent.mcp) agent.mcp.onElicit = (request: ElicitRequestInfo) => this.interact<ElicitAnswer>(s, 'elicit', 'session/elicit', { request }, { action: 'decline' });
    this.sessions.set(s.id, s);
    this.createdBy.set(s.id, s.owner);
    return s;
  }

  async load(client: ClientConn | undefined, params: { sessionId: string; workspace?: string }): Promise<LiveSession> {
    const live = this.sessions.get(params.sessionId);
    if (live) {
      if (!this.mayAddress(live, client)) throw new RpcError(ERR.NOT_FOUND, `unknown session ${params.sessionId}`);
      if (client) live.subscribers.add(client);
      return live;
    }
    const workspace = this.resolveWorkspace(params.workspace);
    const saved = Journal.listSessions(this.opts.config.homeDir, workspace).find((x) => x.id === params.sessionId);
    // R16: a client may reload only its own saved sessions; journals of unknown origin (the CLI, earlier servers) are the owner's
    if (!saved || !this.mayLoadSaved(params.sessionId, client)) throw new RpcError(ERR.NOT_FOUND, `no saved session ${params.sessionId} for ${workspace}`);
    const s = await this.create(client, { workspace, sessionId: undefined });
    s.agent.loadHistory(Journal.loadMessages(saved.file));
    return s;
  }

  /** R16: which principal created each session id in this server process (saved journals keep their owner). */
  private readonly createdBy = new Map<string, string>();

  private mayLoadSaved(id: string, client?: ClientConn): boolean {
    const p = client?.principal ?? 'owner';
    return p === 'owner' || this.createdBy.get(id) === p;
  }

  listSaved(workspace?: string, client?: ClientConn): SavedSession[] {
    const ws = this.resolveWorkspace(workspace);
    return Journal.listSessions(this.opts.config.homeDir, ws)
      .filter((x) => this.mayLoadSaved(x.id, client))
      .slice(0, 50)
      .map((x) => ({ sessionId: x.id, mtime: new Date(x.mtime).toISOString(), firstPrompt: x.firstPrompt.slice(0, 200) }));
  }

  async remove(sessionId: string, purge = false): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.agent.abort();
      this.settleAll(s);
      await s.run?.catch(() => undefined);
      await s.agent.dispose();
      this.sessions.delete(sessionId);
      if (purge && s.agent.journalFile) fs.rmSync(s.agent.journalFile, { force: true });
      return true;
    }
    return false;
  }

  /** A client disconnected: detach it; open questions with no remaining client are denied. */
  detach(client: ClientConn): void {
    this.connections.delete(client);
    for (const s of this.sessions.values()) {
      if (!s.subscribers.delete(client)) continue;
      if (!s.subscribers.size) this.settleAll(s);
    }
  }

  async prompt(s: LiveSession, text: unknown): Promise<RunSummary> {
    if (typeof text !== 'string' || !text.trim()) throw new RpcError(ERR.INVALID_PARAMS, 'text is required');
    if (s.run || s.agent.isRunning) throw new RpcError(ERR.BUSY, 'the session is already running; use session/steer or session/enqueue');
    s.run = s.agent.run(text).then((r) => ({ runId: r.runId, stopReason: r.stopReason, finalText: r.finalText, stats: r.stats }));
    try {
      return await s.run;
    } finally {
      s.run = undefined;
    }
  }

  abort(s: LiveSession): void {
    s.agent.abort();
    this.settleAll(s);
  }

  async command(s: LiveSession, name: unknown, args: unknown): Promise<{ output: string; prompt?: string }> {
    const cmd = typeof name === 'string' ? getSlashCommand(name.replace(/^\//, '')) : undefined;
    if (!cmd) throw new RpcError(ERR.NOT_FOUND, `unknown command ${String(name)}`);
    const out: string[] = [];
    const r = await cmd.run(typeof args === 'string' ? args : '', {
      agent: s.agent,
      config: s.agent.config,
      workspace: s.workspace,
      write: (t) => out.push(t),
      ask: s.subscribers.size ? (q, o) => this.interact<string>(s, 'ask', 'session/ask', { question: q, options: o }, '') : undefined,
      surface: 'server',
    });
    return { output: out.join('\n'), ...(r && r.prompt ? { prompt: r.prompt } : {}) };
  }

  /** The session config with every credential masked. */
  redactedConfig(cfg: HarnessConfig): unknown {
    const secretKey = /key|token|secret|password|authorization|cookie/i;
    const walk = (v: unknown, k = ''): unknown => {
      if (typeof v === 'string') return secretKey.test(k) && v ? '***' : v;
      if (Array.isArray(v)) return v.map((x) => walk(x, k));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, kk === 'env' || kk === 'headers' ? Object.fromEntries(Object.keys(vv as object).map((h) => [h, '***'])) : walk(vv, kk)]));
      return v;
    };
    return walk(cfg);
  }

  setConfig(s: LiveSession, key: unknown, value: unknown): { ok: true; value: unknown } {
    if (!SAFE_CONFIG_KEYS.includes(key as any)) throw new RpcError(ERR.FORBIDDEN, `config/set allows only ${SAFE_CONFIG_KEYS.join(', ')} (other settings belong in config files)`);
    if (key === 'permissionMode') {
      if (!isPermissionMode(value)) throw new RpcError(ERR.INVALID_PARAMS, invalidModeMessage(value));
      s.agent.setMode(value as PermissionMode); // managed policy re-asserts disableAutoMode before the next call
      return { ok: true, value: s.agent.policy.mode };
    }
    if (key === 'profile') {
      try {
        resolveProfile(s.agent.config, String(value));
      } catch (e) {
        throw new RpcError(ERR.INVALID_PARAMS, (e as Error).message);
      }
      s.agent.setProfile(String(value)); // a locked managed profile is re-applied before the next call
      return { ok: true, value: s.agent.llm.profile.name };
    }
    s.agent.config.outputStyle = String(value);
    return { ok: true, value };
  }

  async checkpoints(s: LiveSession): Promise<unknown[]> {
    return checkpointsFor(s.agent.config, s.workspace).list(100);
  }

  async restoreCheckpoint(s: LiveSession, id: unknown, scope: unknown): Promise<unknown> {
    if (s.run || s.agent.isRunning) throw new RpcError(ERR.BUSY, 'abort the run before restoring a checkpoint');
    if (typeof id !== 'string' || !id) throw new RpcError(ERR.INVALID_PARAMS, 'id is required');
    const sc = scope === 'chat' || scope === 'both' ? scope : 'files';
    return checkpointsFor(s.agent.config, s.workspace).restore(id, { files: sc !== 'chat', conversation: sc !== 'files', agent: s.agent });
  }

  jobs(s: LiveSession): unknown[] {
    return listJobs(s.id).map((j) => ({ id: j.id, command: j.command, status: j.status, exitCode: j.exitCode, startedAt: new Date(j.startedAt).toISOString(), endedAt: j.endedAt ? new Date(j.endedAt).toISOString() : undefined, logFile: j.logFile }));
  }

  async close(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.remove(id);
  }
}
