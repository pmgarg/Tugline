/**
 * TypeScript client for `tug serve` (SPEC G2/G6/H5). Used by `tug remote`, the
 * SDK and tests; an editor integration can use it too.
 *
 * Interaction requests from the server (permission, question, plan, MCP
 * elicitation) go to the handlers given here. Without a handler the client
 * answers "deny" / "" / false / "decline" at once, so a headless client never
 * leaves a run hanging and never approves anything by default.
 */
import WebSocket from 'ws';
import { RpcPeer, type Channel } from './rpc.js';
import type { AgentEvent, PermissionAnswer, PermissionRequest } from '../core/types.js';
import type { ElicitAnswer, ElicitRequestInfo } from '../core/mcp/manager.js';
import type { RemoteResult, RemoteRunParams, RunSummary, SessionInfo } from './protocol.js';

export interface ClientHandlers {
  onEvent?: (sessionId: string, e: AgentEvent) => void;
  onPermission?: (sessionId: string, req: PermissionRequest) => Promise<PermissionAnswer> | PermissionAnswer;
  onAsk?: (sessionId: string, question: string, options?: string[]) => Promise<string> | string;
  onPlan?: (sessionId: string, plan: string) => Promise<boolean> | boolean;
  onElicit?: (sessionId: string, req: ElicitRequestInfo) => Promise<ElicitAnswer> | ElicitAnswer;
}

export class OhClient {
  private constructor(readonly peer: RpcPeer, private readonly ws: WebSocket, public handlers: ClientHandlers) {
    peer.onNotification('session/event', (p) => this.handlers.onEvent?.(p.sessionId, p.event));
    peer.onNotification('session/permission', async (p) => {
      let a: PermissionAnswer = { decision: 'deny', feedback: 'the client has no approval handler' };
      try {
        if (this.handlers.onPermission) a = await this.handlers.onPermission(p.sessionId, p.request);
      } catch (e) {
        a = { decision: 'deny', feedback: `approval handler failed: ${(e as Error).message}` };
      }
      await this.peer.request('session/permissionReply', { sessionId: p.sessionId, requestId: p.requestId, ...a }).catch(() => undefined);
    });
    peer.onNotification('session/ask', async (p) => {
      const answer = this.handlers.onAsk ? await Promise.resolve(this.handlers.onAsk(p.sessionId, p.question, p.options)).catch(() => '') : '';
      await this.peer.request('session/askReply', { sessionId: p.sessionId, requestId: p.requestId, answer }).catch(() => undefined);
    });
    peer.onNotification('session/plan', async (p) => {
      const approved = this.handlers.onPlan ? await Promise.resolve(this.handlers.onPlan(p.sessionId, p.plan)).catch(() => false) : false;
      await this.peer.request('session/planReply', { sessionId: p.sessionId, requestId: p.requestId, approved }).catch(() => undefined);
    });
    peer.onNotification('session/elicit', async (p) => {
      const a: ElicitAnswer = this.handlers.onElicit ? await Promise.resolve(this.handlers.onElicit(p.sessionId, p.request)).catch(() => ({ action: 'cancel' as const })) : { action: 'decline' };
      await this.peer.request('session/elicitReply', { sessionId: p.sessionId, requestId: p.requestId, ...a }).catch(() => undefined);
    });
  }

  /** Connect and authenticate. Rejects on a wrong token. */
  static async connect(url: string, token: string, handlers: ClientHandlers = {}): Promise<OhClient> {
    if (!/^wss?:\/\//.test(url)) throw new Error(`server URL must start with ws:// or wss:// (${url})`);
    const ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`server refused the connection (HTTP ${res.statusCode})`)));
    });
    const channel: Channel = { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) };
    const peer = new RpcPeer(channel);
    ws.on('message', (d) => void peer.receive(String(d)));
    ws.on('close', () => peer.dispose('server closed the connection'));
    ws.on('error', () => undefined);
    const c = new OhClient(peer, ws, handlers);
    try {
      await peer.request('auth', { token }, 15_000);
    } catch (e) {
      ws.close();
      throw new Error(`authentication failed: ${(e as Error).message}`);
    }
    return c;
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    return this.peer.request<T>(method, params);
  }

  initialize(): Promise<{ server: string; version: string; protocol: number; capabilities: Record<string, boolean> }> {
    return this.request('initialize', { client: 'tugline-ts' });
  }

  createSession(p: { workspace?: string; mode?: string; profile?: string } = {}): Promise<SessionInfo> {
    return this.request('session/create', p);
  }

  prompt(sessionId: string, text: string): Promise<RunSummary> {
    return this.request('session/prompt', { sessionId, text });
  }

  steer(sessionId: string, text: string): Promise<{ queued: boolean }> {
    return this.request('session/steer', { sessionId, text });
  }

  abort(sessionId: string): Promise<{ aborted: boolean }> {
    return this.request('session/abort', { sessionId });
  }

  remoteRun(p: RemoteRunParams): Promise<RemoteResult> {
    return this.request('remote/run', p);
  }

  close(): void {
    this.peer.dispose();
    this.ws.close();
  }
}
