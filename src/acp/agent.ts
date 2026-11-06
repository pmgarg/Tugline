/**
 * Agent Client Protocol server (SPEC G1): `tug --acp` speaks ACP v1 over stdio,
 * so Zed, JetBrains AI Assistant, Neovim (CodeCompanion, avante.nvim) and other
 * ACP clients can drive Tugline. Built on the official
 * `@agentclientprotocol/sdk` (Apache-2.0).
 *
 *   initialize          → capabilities (loadSession, embedded context, http MCP)
 *   session/new         → a fresh Agent for `cwd` (config via loadConfig: trust and
 *                         managed policy apply; client MCP servers are added there)
 *   session/load        → journal history restored and replayed as session/update
 *   session/prompt      → run; streams agent_message_chunk, agent_thought_chunk,
 *                         tool_call / tool_call_update, plan
 *   session/cancel      → agent.abort(); open permission requests resolve as denied
 *   session/set_mode    → ask | acceptEdits | plan | auto
 *   session/request_permission ← every permission-engine "ask" (our PermissionRequest)
 *   fs/read_text_file, fs/write_text_file ← file tools, when the client advertises them
 *
 * Authority is unchanged: the permission engine decides; ACP is only the
 * approval UI. A failed, cancelled or unanswered permission request is a denial.
 * stdout belongs to the protocol: nothing else may write there.
 */
import { attachmentBlock } from '../core/util/attachments.js';
import { MODE_INFO, PERMISSION_MODES } from '../core/approver/modes.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { Agent, type AgentOptions } from '../core/agent/agent.js';
import { Journal } from '../core/agent/journal.js';
import { loadConfig, type HarnessConfig, type McpServerConfig } from '../core/config.js';
import { contentToText } from '../core/util/text.js';
import type { AgentEvent, ChatMessage, PermissionAnswer, PermissionMode, PermissionRequest, StopReason, ToolKind } from '../core/types.js';
import { AcpFsHost } from './host.js';

export const ACP_AGENT_VERSION = '1.0.0';

// N43: the same modes as every other surface (src/core/approver/modes.ts)
const MODES: { id: PermissionMode; name: string; description: string }[] = PERMISSION_MODES.map((id) => ({ id, ...MODE_INFO[id] }));

export interface AcpOptions {
  configFor?: (cwd: string, overrides: Record<string, unknown>) => HarnessConfig | Promise<HarnessConfig>;
  agentOptions?: Partial<AgentOptions>;
  /** Where the ACP session-id aliases live (default: the session config's homeDir). */
  log?: (s: string) => void;
}

interface AcpSession {
  id: string;
  agent: Agent;
  cwd: string;
  /** Cancels outstanding permission requests (resolves them as denied). */
  cancels: Set<() => void>;
  /** Tool calls already announced (tool_start) in this turn. */
  started: Set<string>;
}

export function acpToolKind(tool: string, kind: ToolKind): acp.ToolKind {
  if (tool === 'grep' || tool === 'glob' || tool === 'list_dir' || tool === 'web_search' || tool === 'tool_search') return 'search';
  if (tool === 'exit_plan_mode') return 'switch_mode';
  switch (kind) {
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'execute':
      return 'execute';
    case 'network':
      return 'fetch';
    case 'meta':
      return 'think';
    default:
      return 'other';
  }
}

function mapStop(r: StopReason): acp.StopReason {
  switch (r) {
    case 'end_turn':
      return 'end_turn';
    case 'aborted':
      return 'cancelled';
    case 'max_turns':
      return 'max_turn_requests';
    case 'budget':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

/** ACP mcpServers (editor config) → our config shape. ACP-transport servers are not supported. */
export function mcpFromAcp(list: acp.McpServer[] | undefined): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of list ?? []) {
    const name = String((s as any).name ?? '').replace(/[^\w.-]/g, '_') || `server${Object.keys(out).length + 1}`;
    if ('command' in s && (s as any).command) {
      out[name] = { command: (s as any).command, args: (s as any).args ?? [], env: Object.fromEntries(((s as any).env ?? []).map((e: any) => [e.name, e.value])) };
    } else if ((s as any).type === 'http' || (s as any).type === 'sse') {
      out[name] = { url: (s as any).url, headers: Object.fromEntries(((s as any).headers ?? []).map((h: any) => [h.name, h.value])) };
    }
  }
  return out;
}

/** Prompt content blocks → one prompt string (embedded resources inline as files). */
export function promptText(blocks: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'resource_link') parts.push(`@${b.uri.startsWith('file://') ? decodeURIComponent(new URL(b.uri).pathname) : b.uri}`);
    else if (b.type === 'resource') {
      const r: any = b.resource;
      const p = typeof r.uri === 'string' && r.uri.startsWith('file://') ? decodeURIComponent(new URL(r.uri).pathname) : r.uri;
      if (typeof r.text === 'string') parts.push(attachmentBlock('file', { path: String(p) }, r.text));
      else parts.push(`[attached ${p}]`);
    } else if (b.type === 'image') parts.push('[image attached]');
  }
  return parts.join('\n\n');
}

function aliasFile(homeDir: string): string {
  return path.join(homeDir, 'acp-sessions.json');
}
function readAliases(homeDir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(aliasFile(homeDir), 'utf8'));
  } catch {
    return {};
  }
}
function writeAlias(homeDir: string, acpId: string, internal: string): void {
  const a = readAliases(homeDir);
  if (a[acpId] === internal) return;
  a[acpId] = internal;
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(aliasFile(homeDir), JSON.stringify(a, null, 2), { mode: 0o600 });
}

export class OhAcpAgent implements acp.Agent {
  private sessions = new Map<string, AcpSession>();
  private clientCaps: acp.ClientCapabilities = {};

  constructor(private readonly conn: acp.AgentSideConnection, private readonly opts: AcpOptions = {}) {}

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    this.clientCaps = params.clientCapabilities ?? {};
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } },
      authMethods: [],
      agentInfo: { name: 'tugline', title: 'Tugline', version: ACP_AGENT_VERSION },
    } as acp.InitializeResponse;
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  private modes(current: PermissionMode): acp.SessionModeState {
    return { currentModeId: current, availableModes: MODES.map((m) => ({ id: m.id, name: m.name, description: m.description })) };
  }

  private async makeSession(acpId: string | undefined, cwd: string, mcpServers: acp.McpServer[] | undefined, internalId?: string): Promise<AcpSession> {
    if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) throw acp.RequestError.invalidParams(undefined, `cwd must be an existing absolute path: ${cwd}`);
    const servers = mcpFromAcp(mcpServers);
    const overrides = Object.keys(servers).length ? { mcpServers: servers } : {};
    const config = await (this.opts.configFor ?? ((ws, o) => loadConfig({ workspace: ws, overrides: o })))(cwd, overrides);
    const s: AcpSession = { id: acpId ?? '', agent: undefined as unknown as Agent, cwd, cancels: new Set(), started: new Set() };
    const fsCaps = this.clientCaps.fs ?? {};
    const host = fsCaps.readTextFile || fsCaps.writeTextFile ? new AcpFsHost(this.conn, () => s.id, { read: !!fsCaps.readTextFile, write: !!fsCaps.writeTextFile }) : undefined;
    s.agent = await Agent.create({
      surface: 'editor (via the Agent Client Protocol)',
      ...this.opts.agentOptions,
      workspace: cwd,
      config,
      sessionId: internalId,
      ...(host ? { host } : {}),
      ui: {
        onEvent: (e) => void this.onEvent(s, e),
        requestPermission: (req) => this.requestPermission(s, req),
        approvePlan: (plan) => this.approvePlan(s, plan),
      },
    });
    if (!s.id) s.id = s.agent.sessionId;
    writeAlias(config.homeDir, s.id, s.agent.sessionId);
    this.sessions.set(s.id, s);
    return s;
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const s = await this.makeSession(undefined, params.cwd, params.mcpServers);
    return { sessionId: s.id, modes: this.modes(s.agent.policy.mode) };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const probe = await (this.opts.configFor ?? ((ws, o) => loadConfig({ workspace: ws, overrides: o })))(params.cwd, {});
    const internal = readAliases(probe.homeDir)[params.sessionId] ?? params.sessionId;
    const saved = Journal.listSessions(probe.homeDir, params.cwd).find((x) => x.id === internal);
    if (!saved) throw acp.RequestError.resourceNotFound(params.sessionId);
    const old = this.sessions.get(params.sessionId);
    if (old) {
      old.agent.abort();
      await old.agent.dispose();
    }
    const s = await this.makeSession(params.sessionId, params.cwd, params.mcpServers);
    const history = Journal.loadMessages(saved.file);
    s.agent.loadHistory(history);
    // The new journal starts self-contained (a later load finds everything through the alias).
    s.agent.journalWrite({ type: 'compacted', reason: 'acp session/load', messages: s.agent.messages });
    await this.replay(s, history);
    return { modes: this.modes(s.agent.policy.mode) };
  }

  /** Stream a restored conversation back to the client (session/load contract). */
  private async replay(s: AcpSession, msgs: ChatMessage[]): Promise<void> {
    for (const m of msgs) {
      if (m._meta?.synthetic) continue;
      if (m.role === 'user') await this.update(s, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: contentToText(m.content) } });
      else if (m.role === 'assistant') {
        const text = contentToText(m.content);
        if (text) await this.update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        for (const c of m.tool_calls ?? []) await this.update(s, { sessionUpdate: 'tool_call', toolCallId: c.id, title: c.function.name, kind: 'other', status: 'completed', rawInput: safeJson(c.function.arguments) });
      }
    }
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const s = this.get(params.sessionId);
    if (!MODES.some((m) => m.id === params.modeId)) throw acp.RequestError.invalidParams(undefined, `unknown mode ${params.modeId}`);
    s.agent.setMode(params.modeId as PermissionMode);
    await this.update(s, { sessionUpdate: 'current_mode_update', currentModeId: s.agent.policy.mode });
    return {};
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const s = this.get(params.sessionId);
    if (s.agent.isRunning) throw acp.RequestError.invalidRequest(undefined, 'a prompt is already running in this session');
    s.started.clear();
    const res = await s.agent.run(promptText(params.prompt));
    if (res.stopReason !== 'end_turn' && res.stopReason !== 'aborted' && res.finalText) await this.update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${res.finalText}` } });
    return { stopReason: mapStop(res.stopReason) };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const s = this.sessions.get(params.sessionId);
    if (!s) return;
    for (const c of [...s.cancels]) c();
    s.agent.abort();
  }

  private get(id: string): AcpSession {
    const s = this.sessions.get(id);
    if (!s) throw acp.RequestError.resourceNotFound(id);
    return s;
  }

  private async update(s: AcpSession, update: acp.SessionUpdate): Promise<void> {
    try {
      await this.conn.sessionUpdate({ sessionId: s.id, update });
    } catch {
      /* client gone */
    }
  }

  private locations(args: any, cwd: string): acp.ToolCallLocation[] | undefined {
    const p = typeof args?.path === 'string' ? args.path : typeof args?.file_path === 'string' ? args.file_path : undefined;
    return p ? [{ path: path.resolve(cwd, p), ...(typeof args?.offset === 'number' ? { line: args.offset } : {}) }] : undefined;
  }

  private kindOf(s: AcpSession, tool: string): acp.ToolKind {
    const t = s.agent.toolList.find((x) => x.name === tool);
    return acpToolKind(tool, t?.kind ?? 'meta');
  }

  private async onEvent(s: AcpSession, e: AgentEvent): Promise<void> {
    switch (e.type) {
      case 'text_delta':
        return this.update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.text } });
      case 'reasoning_delta':
        return this.update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: e.text } });
      case 'tool_start':
        s.started.add(e.id);
        return this.update(s, { sessionUpdate: 'tool_call', toolCallId: e.id, title: e.title, kind: this.kindOf(s, e.name), status: 'in_progress', rawInput: e.args as any, locations: this.locations(e.args, s.cwd) });
      case 'tool_end': {
        const text = e.output.length > 20_000 ? `${e.output.slice(0, 20_000)}\n…[truncated]` : e.output;
        return this.update(s, { sessionUpdate: 'tool_call_update', toolCallId: e.id, status: e.ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }], rawOutput: { ok: e.ok, durationMs: e.durationMs } as any });
      }
      case 'todos':
        return this.update(s, { sessionUpdate: 'plan', entries: e.todos.map((t) => ({ content: t.content, priority: 'medium', status: t.status })) });
      case 'notice':
        if (e.level !== 'info') return this.update(s, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `[${e.level}] ${e.message}\n` } });
        return;
      default:
        return;
    }
  }

  /** Permission-engine "ask" → session/request_permission. Anything but an explicit allow is a denial. */
  private async requestPermission(s: AcpSession, req: PermissionRequest): Promise<PermissionAnswer> {
    const options: acp.PermissionOption[] = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      ...(req.suggestedRule ? [{ optionId: 'always', name: `Always allow (${req.suggestedRule})`, kind: 'allow_always' as const }] : []),
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ];
    const content: acp.ToolCallContent[] = [];
    if (req.diff) content.push({ type: 'diff', path: req.diff.path, oldText: req.diff.before, newText: req.diff.after });
    if (req.detail && !req.diff) content.push({ type: 'content', content: { type: 'text', text: req.detail } });
    if (req.reason) content.push({ type: 'content', content: { type: 'text', text: `Why this asks: ${req.reason}` } });
    let cancel!: () => void;
    const cancelled = new Promise<'cancelled'>((r) => (cancel = () => r('cancelled')));
    s.cancels.add(cancel);
    try {
      const r = await Promise.race([
        this.conn.requestPermission({ sessionId: s.id, toolCall: { toolCallId: req.id, title: req.title, kind: acpToolKind(req.tool, req.kind), status: 'pending', content }, options }),
        cancelled,
      ]);
      if (r === 'cancelled' || r.outcome.outcome !== 'selected') return { decision: 'deny', feedback: 'the request was cancelled' };
      if (r.outcome.optionId === 'allow') return { decision: 'allow' };
      if (r.outcome.optionId === 'always') return { decision: 'allow', always: true };
      return { decision: 'deny' };
    } catch (e) {
      return { decision: 'deny', feedback: `permission request failed: ${(e as Error).message}` };
    } finally {
      s.cancels.delete(cancel);
    }
  }

  private async approvePlan(s: AcpSession, plan: string): Promise<boolean> {
    const a = await this.requestPermission(s, { id: `plan_${crypto.randomBytes(4).toString('hex')}`, tool: 'exit_plan_mode', kind: 'meta', title: 'Approve the plan and start implementing', detail: plan });
    return a.decision === 'allow';
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.agent.abort();
      await s.agent.dispose().catch(() => undefined);
    }
    this.sessions.clear();
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Run an ACP agent over the given byte streams (stdio by default) until the client disconnects. */
export async function runAcp(opts: AcpOptions & { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  const { Readable, Writable } = await import('node:stream');
  const input = Readable.toWeb((opts.input ?? process.stdin) as any) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb((opts.output ?? process.stdout) as any) as unknown as WritableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);
  let agent: OhAcpAgent | undefined;
  const conn = new acp.AgentSideConnection((c) => (agent = new OhAcpAgent(c, opts)), stream);
  await conn.closed;
  await agent?.dispose();
}
