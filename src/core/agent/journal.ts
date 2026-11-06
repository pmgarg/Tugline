/**
 * Run journal: an append-only JSONL record of every event and message.
 *
 * EAG S18: "the raw run survives the score" — evaluations score journals, so a
 * scorer can change without re-running the model. S16: write it down before
 * acting, so a crashed run can be inspected and resumed. Secrets are redacted.
 *
 * Integrity contract (v1.1 R6):
 *  - each line carries `_h` = sha256(previous hash + line body), from "genesis";
 *  - reopening an existing session id verifies the whole chain and continues from
 *    its last hash; a file that fails verification is refused (JournalChainError)
 *    and the agent continues under a new session id, so evidence is never mixed
 *    into a broken chain;
 *  - writers are serialised per file: in-process, every Journal for a file shares
 *    one chain head (Node runs each write synchronously); each record is one
 *    O_APPEND write; if the file grew behind our back (another process), the
 *    head is re-read from the last line before appending. Across processes, the
 *    re-read and the append happen under a lock file (`<session>.jsonl.lock`,
 *    O_EXCL, holding the owner's pid: a dead owner's lock is taken at once, a live
 *    owner is waited for up to 10 s, a lock older than 10 s is stale), so several surfaces on
 *    one session (R14) keep one valid chain;
 *  - the chain is tamper-evident, not authenticated: anyone who can write the file
 *    can recompute it, and truncating a suffix leaves a valid chain. For audit,
 *    set `audit.sink` (an http(s) endpoint, or a file outside the workspace): each
 *    record's (session, line, hash) is sent there, so a separately controlled
 *    store can detect rewritten or truncated journals.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import { redactSecrets } from '../util/text.js';
import { loadStateForJournal } from '../context/sessionState.js';
import { auditSinkFor, type AuditSink } from '../permissions/auditSink.js';

export function projectKey(workspace: string): string {
  const base = path.basename(workspace).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  return `${base}-${crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 8)}`;
}

export class JournalChainError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

export interface JournalOptions {
  /** R6: where each record's hash is anchored: an http(s) URL (POST JSON) or an absolute file path outside the workspace */
  auditSink?: string;
  /** Tests: do not share the in-process chain head (simulates another process). */
  isolated?: boolean;
}

interface ChainHead {
  prev: string;
  lines: number;
  size: number;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Is the process that holds a lock still alive? (a lock without a readable pid counts as alive until stale) */
function ownerAlive(lock: string): boolean {
  let pid = NaN;
  try {
    pid = Number(fs.readFileSync(lock, 'utf8').trim());
  } catch {
    return false; // gone already
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run `fn` holding `<file>.lock` (O_EXCL, holds the owner's pid). A lock whose owner process is dead
 * (a crash) is taken at once; a live owner is waited for up to 10 s (each record is one short write),
 * a lock older than 10 s is stale. If the lock cannot be had, `fn` still runs: journaling never blocks a run.
 */
function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  let fd: number | undefined;
  // CI found it (GitHub, 3 writers under load): with a 1 s wait a writer gave up and appended without the lock,
  // breaking the chain. A live owner holds the lock for one short write, so waiting up to the stale age is safe.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') break;
      let stale = false;
      let seen: fs.Stats | undefined;
      try {
        seen = fs.statSync(lock);
        stale = !ownerAlive(lock) || Date.now() - seen.mtimeMs > 10_000;
      } catch {
        continue; // released meanwhile: try again
      }
      if (stale) {
        // remove only the lock we judged: another waiter may already have replaced it with its own
        try {
          const now = fs.statSync(lock);
          if (now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) fs.rmSync(lock, { force: true });
        } catch {
          /* gone already */
        }
        continue;
      }
      if (Date.now() > deadline) break;
      Atomics.wait(sleeper, 0, 0, 2);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
}

/** One chain head per journal file in this process (the in-process writer lock). */
const heads = new Map<string, ChainHead>();

/** The hash in the last complete line of a file, and the line count (for re-syncing after another writer). */
function tailHead(file: string): ChainHead {
  const r = Journal.inspect(file);
  if (r.broken) throw new JournalChainError(`journal ${path.basename(file, '.jsonl')} chain is broken at line ${r.broken}`, r.broken);
  return { prev: r.last, lines: r.lines, size: r.size };
}

export class Journal {
  readonly file: string;
  /** Hash chain: each line carries sha256(prev + line). Editing or deleting a line breaks verification. */
  private head: ChainHead;
  /** R6/N23: the shared external anchor (one implementation for journals and security events) */
  private readonly sink?: AuditSink;
  constructor(
    homeDir: string,
    workspace: string,
    readonly sessionId: string,
    private secrets: string[] = [],
    opts: JournalOptions = {},
  ) {
    const dir = path.join(homeDir, 'sessions', projectKey(workspace));
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${sessionId}.jsonl`);
    // validates like before: an http(s) URL, or an absolute file path outside the workspace
    if (opts.auditSink) this.sink = auditSinkFor(opts.auditSink, workspace);
    // Reopening an existing session: verify the whole chain and continue from its last hash, or refuse.
    const now = fs.existsSync(this.file) ? withFileLock(this.file, () => tailHead(this.file)) : { prev: 'genesis', lines: 0, size: 0 };
    const shared = opts.isolated ? undefined : heads.get(this.file);
    if (shared) this.head = Object.assign(shared, now);
    else {
      this.head = now;
      if (!opts.isolated) heads.set(this.file, this.head);
    }
  }

  write(record: Record<string, unknown>): void {
    try {
      withFileLock(this.file, () => this.append(record));
    } catch {
      /* journaling must never break a run */
    }
  }

  private append(record: Record<string, unknown>): void {
    {
      const h = this.head;
      // Another process appended since our last write: continue from the file's real last hash.
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      if (size !== h.size) Object.assign(h, size ? tailHead(this.file) : { prev: 'genesis', lines: 0, size: 0 });
      const body = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...record }), this.secrets);
      const hash = crypto.createHash('sha256').update(h.prev + body).digest('hex').slice(0, 32);
      const line = `${body.slice(0, -1)},"_h":"${hash}"}\n`;
      // one O_APPEND write per record
      const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
      try {
        fs.writeSync(fd, line);
      } finally {
        fs.closeSync(fd);
      }
      h.prev = hash;
      h.lines++;
      h.size += Buffer.byteLength(line);
      this.anchor(h.lines, hash);
    }
  }

  /** R6: send (session, line, hash) to the audit sink. Failures never break the run. */
  private anchor(line: number, hash: string): void {
    if (!this.sink) return;
    this.sink.send({ session: this.sessionId, file: path.basename(this.file), line, hash, ts: new Date().toISOString(), stream: 'journal' });
  }

  /** Wait for HTTP anchors in flight (tests, session end). */
  async flushAudit(): Promise<void> {
    await this.sink?.flush();
  }

  /** Walk a journal's chain: first broken line (0 = intact), line count, last hash, size. */
  static inspect(file: string): { broken: number; lines: number; last: string; size: number } {
    const raw = fs.readFileSync(file, 'utf8');
    let prev = 'genesis';
    const lines = raw.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(.*),"_h":"([0-9a-f]{32})"}$/);
      if (!m) return { broken: i + 1, lines: lines.length, last: prev, size: Buffer.byteLength(raw) };
      const h = crypto.createHash('sha256').update(prev + m[1] + '}').digest('hex').slice(0, 32);
      if (h !== m[2]) return { broken: i + 1, lines: lines.length, last: prev, size: Buffer.byteLength(raw) };
      prev = h;
    }
    return { broken: 0, lines: lines.length, last: prev, size: Buffer.byteLength(raw) };
  }

  static listSessions(homeDir: string, workspace: string): { id: string; file: string; mtime: number; firstPrompt: string }[] {
    const dir = path.join(homeDir, 'sessions', projectKey(workspace));
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(dir, f);
        let firstPrompt = '';
        try {
          const first = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.includes('"run_start"'));
          if (first) {
            const r = JSON.parse(first);
            firstPrompt = r.event?.prompt ?? r.prompt ?? '';
          }
        } catch {
          /* ignore */
        }
        return { id: f.replace(/\.jsonl$/, ''), file, mtime: fs.statSync(file).mtimeMs, firstPrompt };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Verify the hash chain of a journal file. Returns the first broken line number, or 0 if intact. */
  static verify(file: string): number {
    return Journal.inspect(file).broken;
  }

  /** R5: the task brief entries recorded in a journal (original request, later constraints). */
  static loadBrief(file: string): { entries: { kind: string; text: string; ts: string }[] } {
    const entries: { kind: string; text: string; ts: string }[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"task_brief"')) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === 'task_brief' && r.entry?.text) entries.push(r.entry);
      } catch {
        /* skip corrupt line */
      }
    }
    return { entries };
  }

  /** Rebuild the conversation (minus system prompt) from a journal file. The task brief rides along (non-enumerable `taskBrief`). */
  static loadMessages(file: string): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.type === 'message' && r.message?.role !== 'system') msgs.push(r.message);
        if (r.type === 'compacted') msgs.splice(0, msgs.length, ...(r.messages as ChatMessage[]).filter((m) => m.role !== 'system'));
      } catch {
        /* skip corrupt line */
      }
    }
    Object.defineProperty(msgs, 'taskBrief', { value: Journal.loadBrief(file), enumerable: false });
    // R14: the durable session state stored with this journal (requests, constraints, tasks, evidence)
    Object.defineProperty(msgs, 'sessionState', { value: loadStateForJournal(file, path.basename(file, '.jsonl'), ''), enumerable: false });
    return msgs;
  }
}
