/**
 * A minimal bidirectional JSON-RPC 2.0 peer over any text channel (a WebSocket
 * or newline-delimited stdio). Both ends can send requests and notifications.
 * Kept dependency-free so the server, the TypeScript client and the SDK share it.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  UNAUTHORIZED: -32001,
  BUSY: -32002,
  NOT_FOUND: -32004,
  FORBIDDEN: -32003,
} as const;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export interface Channel {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

type Handler = (params: any) => Promise<unknown> | unknown;

export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private handlers = new Map<string, Handler>();
  private notifyHandlers = new Map<string, ((params: any) => void)[]>();
  /** Called for every incoming request before dispatch; throw RpcError to refuse (auth gate). */
  gate?: (method: string, params: any) => void;
  closed = false;

  constructor(private readonly channel: Channel, private readonly opts: { requestTimeoutMs?: number } = {}) {}

  handle(method: string, h: Handler): void {
    this.handlers.set(method, h);
  }

  onNotification(method: string, h: (params: any) => void): () => void {
    const list = this.notifyHandlers.get(method) ?? [];
    list.push(h);
    this.notifyHandlers.set(method, list);
    return () => {
      const l = this.notifyHandlers.get(method) ?? [];
      const i = l.indexOf(h);
      if (i >= 0) l.splice(i, 1);
    };
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch {
      /* channel gone */
    }
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = this.opts.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = { resolve, reject };
      if (timeoutMs) entry.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, entry);
      try {
        this.channel.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  /** Feed one incoming message (a JSON text). */
  async receive(text: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.sendError(null, ERR.PARSE, 'parse error');
    }
    if (Array.isArray(msg)) return this.sendError(null, ERR.INVALID_REQUEST, 'batches are not supported');
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return this.sendError(msg?.id ?? null, ERR.INVALID_REQUEST, 'not a JSON-RPC 2.0 message');
    if (msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? 'error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== 'string') return this.sendError(msg.id ?? null, ERR.INVALID_REQUEST, 'missing method');
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      this.gate?.(msg.method, msg.params);
    } catch (e) {
      if (isRequest) this.sendError(msg.id, e instanceof RpcError ? e.code : ERR.INTERNAL, (e as Error).message);
      return;
    }
    if (!isRequest) {
      for (const h of this.notifyHandlers.get(msg.method) ?? []) {
        try {
          h(msg.params);
        } catch {
          /* notification handlers never break the connection */
        }
      }
      return;
    }
    const h = this.handlers.get(msg.method);
    if (!h) return this.sendError(msg.id, ERR.METHOD_NOT_FOUND, `unknown method ${msg.method}`);
    try {
      const result = await h(msg.params ?? {});
      if (!this.closed) this.channel.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? null }));
    } catch (e) {
      this.sendError(msg.id, e instanceof RpcError ? e.code : ERR.INTERNAL, (e as Error).message, e instanceof RpcError ? e.data : undefined);
    }
  }

  private sendError(id: unknown, code: number, message: string, data?: unknown): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }));
    } catch {
      /* gone */
    }
  }

  /** Mark closed and fail every request still waiting for an answer. */
  dispose(reason = 'connection closed'): void {
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
