/**
 * A minimal Language Server Protocol client (N3) over stdio: JSON-RPC 2.0 with
 * Content-Length framing, no dependency. It does just what the code_* tools and
 * A6 need: initialize, open/sync documents, definition / references / symbols /
 * hover / rename requests, and publishDiagnostics collection.
 *
 * The server is spawned from a SpawnSpec built by the caller (servers.ts), so
 * the OS sandbox and other command wrappers apply (SPEC S0.7).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { SpawnSpec } from '../tools/shell.js';
import { LANGUAGE_ID } from './config.js';

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class LspError extends Error {}

export const toUri = (abs: string) => pathToFileURL(abs).href;
export const fromUri = (uri: string) => {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
};

export class LspClient {
  private proc?: ChildProcess;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private open = new Map<string, { version: number; text: string }>();
  /** uri → latest published diagnostics and when they arrived */
  readonly diagnostics = new Map<string, { items: LspDiagnostic[]; at: number; seq: number }>();
  /** uri → resultId of the last pull (sent back as previousResultId) */
  private readonly pullIds = new Map<string, string>();
  private diagSeq = 0;
  private diagWaiters: (() => void)[] = [];
  /** active $/progress tokens (project loading, indexing) */
  private progress = new Set<string | number>();
  private lastProgressAt = 0;
  /** debugging: publish/progress timeline */
  readonly trace: string[] = [];
  private stderr = '';
  private exited: string | undefined;
  capabilities: any = {};
  /** server-initiated workspace/applyEdit requests refused (tests, status) */
  refusedApplyEdits = 0;
  /** crash restarts so far (set by the server manager) */
  restarts = 0;

  constructor(
    readonly name: string,
    private spec: SpawnSpec,
    private opts: { root: string; initializationOptions?: unknown; requestTimeoutMs: number; startTimeoutMs: number; settings?: Record<string, unknown>; languageId?: (abs: string) => string },
  ) {}

  get pid(): number | undefined {
    return this.proc?.pid;
  }
  get alive(): boolean {
    return !!this.proc && this.exited === undefined;
  }

  /** Spawn and initialize. Rejects with an actionable LspError when the binary is missing or the handshake fails. */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let p: ChildProcess;
      try {
        p = spawn(this.spec.file, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new LspError(`cannot start ${this.spec.file}: ${(e as Error).message}`));
        return;
      }
      this.proc = p;
      p.once('error', (e: NodeJS.ErrnoException) => {
        this.exited = e.message;
        reject(new LspError(e.code === 'ENOENT' ? `${this.spec.file} not found on PATH` : `cannot start ${this.spec.file}: ${e.message}`));
      });
      p.once('spawn', () => resolve());
      p.on('exit', (code, sig) => {
        this.exited = `exited (${sig ?? code})`;
        for (const [, w] of this.pending) {
          clearTimeout(w.timer);
          w.reject(new LspError(`${this.name} ${this.exited}${this.stderr ? `: ${this.stderr.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
        }
        this.pending.clear();
      });
      p.stdout!.on('data', (d: Buffer) => this.onData(d));
      p.stderr!.on('data', (d: Buffer) => {
        this.stderr = (this.stderr + d.toString()).slice(-4000);
      });
      p.stdin!.on('error', () => undefined);
    });
    const root = toUri(this.opts.root);
    const init = await this.request(
      'initialize',
      {
        processId: null, // a sandboxed server (own PID namespace) cannot see our pid; null = no parent watch
        clientInfo: { name: 'tugline' },
        rootUri: root,
        rootPath: this.opts.root,
        workspaceFolders: [{ uri: root, name: path.basename(this.opts.root) }],
        initializationOptions: this.opts.initializationOptions,
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          // N46: no applyEdit: a server never writes files; every edit goes through our edit engine and permissions
          workspace: { workspaceFolders: true, configuration: true, applyEdit: false, workspaceEdit: { documentChanges: true }, symbol: { dynamicRegistration: false }, didChangeWatchedFiles: { dynamicRegistration: false }, diagnostics: { refreshSupport: false } },
          textDocument: {
            synchronization: { didSave: false, dynamicRegistration: false },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            implementation: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ['plaintext', 'markdown'] },
            rename: { prepareSupport: false },
            callHierarchy: { dynamicRegistration: false },
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } }, resolveSupport: { properties: ['edit'] }, dataSupport: true },
            publishDiagnostics: { relatedInformation: false, versionSupport: true },
            // v1.2 N46 (review F11): pull diagnostics (LSP 3.17), used when the server offers them
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          window: { workDoneProgress: true },
        },
      },
      this.opts.startTimeoutMs,
    );
    this.capabilities = init?.capabilities ?? {};
    this.notify('initialized', {});
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = this.buf.subarray(0, sep).toString('ascii');
      const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(len)) {
        this.buf = this.buf.subarray(sep + 4); // garbage: skip the header
        continue;
      }
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const w = this.pending.get(Number(msg.id));
      if (!w) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(w.timer);
      if (msg.error) w.reject(new LspError(`${w.method}: ${msg.error.message ?? 'error'}`));
      else w.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // server → client requests: answer the few servers need, null otherwise
      let result: unknown = null;
      if (msg.method === 'workspace/configuration') result = (msg.params?.items ?? []).map((it: any) => settingFor(this.opts.settings, it?.section));
      else if (msg.method === 'workspace/applyEdit') {
        // never: the server does not get to write files behind the permission engine (Qwen applies them directly)
        this.refusedApplyEdits++;
        result = { applied: false, failureReason: 'Tugline applies edits only through its own edit engine (code_apply), with permissions and checkpoints' };
      }
      else if (msg.method === 'window/workDoneProgress/create') this.lastProgressAt = Date.now();
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: toUri(this.opts.root), name: path.basename(this.opts.root) }];
      this.write({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    if (msg.method === '$/progress') {
      const kind = msg.params?.value?.kind;
      if (kind === 'begin') this.progress.add(msg.params.token);
      else if (kind === 'end') this.progress.delete(msg.params.token);
      this.lastProgressAt = Date.now();
      if (this.trace.length < 200) this.trace.push(`${Date.now()} progress ${kind} ${msg.params?.value?.title ?? ''}`);
      this.wake();
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      if (this.trace.length < 200) this.trace.push(`${Date.now()} publish ${msg.params.uri.split('/').pop()} ${(msg.params.diagnostics ?? []).length}`);
      this.diagnostics.set(msg.params.uri, { items: msg.params.diagnostics ?? [], at: Date.now(), seq: ++this.diagSeq });
      this.wake();
    }
  }

  private wake(): void {
    const ws = this.diagWaiters;
    this.diagWaiters = [];
    for (const w of ws) w();
  }

  /** True while the server reports work in progress (project loading, indexing). */
  get busy(): boolean {
    return this.progress.size > 0;
  }

  /** Wait until no progress is active and none ended within `graceMs` (bounded by `timeoutMs`). */
  async waitIdle(timeoutMs: number, graceMs = 300): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.alive && (this.progress.size > 0 || Date.now() - this.lastProgressAt < graceMs)) {
      await this.nextPublish(Math.min(deadline - Date.now(), this.progress.size ? deadline - Date.now() : graceMs - (Date.now() - this.lastProgressAt)));
    }
  }

  private write(msg: unknown): void {
    if (!this.alive) throw new LspError(`${this.name} is not running${this.exited ? ` (${this.exited})` : ''}`);
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.proc!.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  request<T = any>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`${this.name}: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Open a document (or sync its full text if it changed). Returns the diagnostics sequence to wait after, and whether anything was sent. */
  sync(abs: string, text?: string): number {
    return this.syncInfo(abs, text).seq;
  }

  syncInfo(abs: string, text?: string): { seq: number; sent: boolean } {
    const uri = toUri(abs);
    const content = text ?? safeRead(abs);
    const cur = this.open.get(uri);
    const seq = this.diagSeq;
    if (!cur) {
      this.open.set(uri, { version: 1, text: content });
      if (text === undefined && !fs.existsSync(abs)) return { seq, sent: false };
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId: this.opts.languageId?.(abs) ?? LANGUAGE_ID[path.extname(abs).toLowerCase()] ?? 'plaintext', version: 1, text: content } });
      return { seq, sent: true };
    }
    if (text === undefined && !fs.existsSync(abs)) {
      // the agent deleted it: close the document so the server stops reporting on a file that is gone
      this.open.delete(uri);
      this.diagnostics.delete(uri);
      this.notify('textDocument/didClose', { textDocument: { uri } });
      this.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 3 }] });
      return { seq, sent: true };
    }
    if (cur.text !== content) {
      cur.version++;
      cur.text = content;
      this.notify('textDocument/didChange', { textDocument: { uri, version: cur.version }, contentChanges: [{ text: content }] });
      return { seq, sent: true };
    }
    return { seq, sent: false };
  }

  isOpen(abs: string): boolean {
    return this.open.has(toUri(abs));
  }

  /** Paths of the open documents (replayed into a restarted server). */
  openPaths(): string[] {
    return [...this.open.keys()].map(fromUri);
  }

  /** Does the server answer pull diagnostics (`textDocument/diagnostic`, LSP 3.17)? */
  get pullDiagnostics(): boolean {
    return !!this.capabilities?.diagnosticProvider;
  }

  /** Does it also answer `workspace/diagnostic` (every file, open or not)? */
  get workspacePullDiagnostics(): boolean {
    return !!this.capabilities?.diagnosticProvider?.workspaceDiagnostics;
  }

  /** Pull the diagnostics of one document (it must be synced first). Undefined when the server does not support it. */
  async pullDocumentDiagnostics(abs: string): Promise<LspDiagnostic[] | undefined> {
    if (!this.pullDiagnostics) return undefined;
    const uri = toUri(abs);
    const prev = this.pullIds.get(uri);
    const r = await this.request<any>('textDocument/diagnostic', { textDocument: { uri }, ...(this.capabilities.diagnosticProvider?.identifier ? { identifier: this.capabilities.diagnosticProvider.identifier } : {}), ...(prev ? { previousResultId: prev } : {}) });
    if (r?.resultId) this.pullIds.set(uri, r.resultId);
    if (r?.kind === 'unchanged') return this.diagnostics.get(uri)?.items ?? [];
    const items: LspDiagnostic[] = Array.isArray(r?.items) ? r.items : [];
    this.diagnostics.set(uri, { items, at: Date.now(), seq: ++this.diagSeq });
    return items;
  }

  /** Pull the diagnostics of the whole workspace (`workspace/diagnostic`). Undefined when unsupported. */
  async pullWorkspaceDiagnostics(): Promise<Map<string, LspDiagnostic[]> | undefined> {
    if (!this.workspacePullDiagnostics) return undefined;
    const r = await this.request<any>('workspace/diagnostic', { previousResultIds: [...this.pullIds].map(([uri, value]) => ({ uri, value })), ...(this.capabilities.diagnosticProvider?.identifier ? { identifier: this.capabilities.diagnosticProvider.identifier } : {}) });
    const out = new Map<string, LspDiagnostic[]>();
    for (const rep of Array.isArray(r?.items) ? r.items : []) {
      if (typeof rep?.uri !== 'string') continue;
      if (rep.resultId) this.pullIds.set(rep.uri, rep.resultId);
      const items: LspDiagnostic[] = rep.kind === 'unchanged' ? this.diagnostics.get(rep.uri)?.items ?? [] : Array.isArray(rep.items) ? rep.items : [];
      out.set(rep.uri, items);
      this.diagnostics.set(rep.uri, { items, at: Date.now(), seq: ++this.diagSeq });
    }
    return out;
  }

  /**
   * Wait for diagnostics of `abs` published after sequence `since`, then for a
   * short quiet period (servers often publish syntax, then semantic results).
   * Resolves the latest set, or undefined if nothing arrived within `timeoutMs`.
   */
  async waitDiagnostics(abs: string, since: number, timeoutMs: number, quietMs = 400): Promise<LspDiagnostic[] | undefined> {
    const uri = toUri(abs);
    const deadline = Date.now() + timeoutMs;
    const fresh = () => {
      const d = this.diagnostics.get(uri);
      return d && d.seq > since ? d : undefined;
    };
    while (!fresh() && Date.now() < deadline && this.alive) await this.nextPublish(deadline - Date.now());
    const first = fresh();
    if (!first) return undefined;
    // quiet period: take later publishes for the same file (servers often
    // publish syntax first, semantic results later), and wait out reported work
    let last = first.seq;
    for (;;) {
      if (Date.now() >= deadline) break;
      if (this.progress.size) {
        await this.nextPublish(deadline - Date.now());
        continue;
      }
      const left = Math.min(quietMs, deadline - Date.now());
      await this.nextPublish(left);
      const d = this.diagnostics.get(uri)!;
      if (d.seq === last && !this.progress.size) break;
      last = d.seq;
    }
    return this.diagnostics.get(uri)!.items;
  }

  private nextPublish(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, Math.max(1, ms));
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.diagWaiters.push(done);
    });
  }

  /** shutdown + exit, then SIGKILL if it lingers. */
  async stop(): Promise<void> {
    if (!this.proc) return;
    const p = this.proc;
    if (this.alive) {
      try {
        await this.request('shutdown', null, 2000);
        this.notify('exit', null);
      } catch {
        /* kill below */
      }
    }
    await new Promise<void>((resolve) => {
      if (this.exited !== undefined) return resolve();
      const t = setTimeout(() => {
        try {
          p.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, 1500);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  /** Synchronous last resort (process exit). */
  kill(): void {
    try {
      this.proc?.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

/** `workspace/configuration` answer for a section ("python.analysis" → settings.python.analysis), or null. */
export function settingFor(settings: Record<string, unknown> | undefined, section: string | undefined): unknown {
  if (!settings) return null;
  if (!section) return settings;
  if (section in settings) return settings[section];
  let cur: any = settings;
  for (const k of section.split('.')) {
    if (cur && typeof cur === 'object' && k in cur) cur = cur[k];
    else return null;
  }
  return cur ?? null;
}

function safeRead(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}
