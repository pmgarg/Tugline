/**
 * The external anchor shared by the run journal (WS4 R6) and the security-event
 * stream (N23): `audit.sink` is an http(s) URL (each record is POSTed as JSON) or
 * an absolute file path outside the workspace (one JSON line per record). A store
 * the agent cannot write is what makes a locally rewritten or truncated hash
 * chain detectable.
 *
 * Record shape (the journal's R6 anchor, plus `stream` and an optional
 * content-free `event` for security events):
 *   { session, file, line, hash, ts, stream?: 'journal' | 'security', event?: {…} }
 *
 * Failures never break a run. One sink object per target, so the journal and the
 * security stream can share it (WS4: Journal.anchor can call `auditSinkFor`).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AnchorRecord {
  session: string;
  file: string;
  line: number;
  hash: string;
  ts: string;
  stream?: 'journal' | 'security';
  event?: Record<string, unknown>;
}

export class AuditSink {
  readonly kind: 'http' | 'file';
  readonly target: string;
  private inflight = new Set<Promise<unknown>>();
  failures = 0;

  constructor(target: string, workspace?: string) {
    if (/^https?:\/\//.test(target)) {
      this.kind = 'http';
      this.target = target;
      return;
    }
    if (!path.isAbsolute(target)) throw new Error(`audit.sink must be an http(s) URL or an absolute file path (got ${target})`);
    const abs = path.resolve(target);
    if (workspace) {
      const ws = path.resolve(workspace);
      if (abs === ws || abs.startsWith(ws + path.sep)) throw new Error(`audit.sink ${target} must be outside the workspace (the agent can write the workspace)`);
    }
    this.kind = 'file';
    this.target = abs;
  }

  send(rec: AnchorRecord): void {
    try {
      if (this.kind === 'file') {
        fs.mkdirSync(path.dirname(this.target), { recursive: true });
        fs.appendFileSync(this.target, JSON.stringify(rec) + '\n', { mode: 0o600 });
        return;
      }
      const p = fetch(this.target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), signal: AbortSignal.timeout(10_000) })
        .then((r) => {
          if (!r.ok) this.failures++;
        })
        .catch(() => {
          this.failures++;
        });
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    } catch {
      this.failures++;
    }
  }

  /** Wait for HTTP records in flight (session end, tests). */
  async flush(): Promise<void> {
    await Promise.all([...this.inflight]);
  }
}

const sinks = new Map<string, AuditSink>();

/** The shared sink for a target (validated against the workspace each time). */
export function auditSinkFor(target: string | undefined, workspace?: string): AuditSink | undefined {
  if (!target) return undefined;
  const s = sinks.get(target) ?? new AuditSink(target, workspace);
  if (workspace && s.kind === 'file') new AuditSink(target, workspace); // re-check: this workspace may contain the file
  sinks.set(target, s);
  return s;
}

export async function flushAuditSinks(): Promise<void> {
  await Promise.all([...sinks.values()].map((s) => s.flush()));
}
