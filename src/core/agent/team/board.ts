/**
 * v1.2 N34: the shared task board and the message log of a team, in `.tugline/teams/<id>/`.
 *
 * Storage is append-only JSONL (`board.jsonl`, `messages.jsonl`) plus a lock file (in the temp dir, keyed by the board). Every mutation
 * (add, claim, update, message) takes the lock (O_CREAT|O_EXCL, holding the owner's pid), re-reads the
 * log, checks the transition against the current state, appends one line, and releases. So a claim is
 * atomic across async callers in one process AND across processes: a task can be claimed once; a second
 * claimant gets a typed `claim_conflict`. A lock whose owner died is taken over; one that cannot be had
 * within the wait is a typed refusal, never a silent unlocked write (unlike a journal record, a lost
 * claim would corrupt work).
 *
 * Entries record their author and, when the author had read untrusted content, that taint. A reader of a
 * tainted entry becomes tainted (taint flows through the board as it does through messages).
 *
 * `.tugline/**` is an agent-control path (permissions/policy.ts): an agent writing these files
 * directly needs a human, so the board cannot be forged by a member's file tools without approval.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteHarnessWrite } from '../../permissions/harnessWrites.js';
import { ChildRefusal } from '../workflow/clamp.js';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';

export interface BoardTask {
  id: string;
  title: string;
  description: string;
  deps: string[];
  status: TaskStatus;
  owner?: string;
  result?: string;
  note?: string;
  /** who wrote the current text (title/description/result), and their taint if any */
  by: string;
  taint?: string;
  /** how many times it was claimed (exactly once for a task that finished without a release) */
  claims: number;
  updatedAt: string;
  /** F6: an in-progress claim expires at this time unless its owner renews it */
  leaseUntil?: number;
  /** G5: its current text was written by something other than this process (whatever name it claims) */
  foreign?: boolean;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  taint?: string;
  ts: string;
}

/**
 * F12 (Cline outcome documents, advisory): a document with required sections that team agents fill with
 * fragments. Nothing in it is an approval: there is no agent "review/approved" step (S4: an agent marking another
 * agent's text approved would be approval by untrusted text); the lead assembles it and the human decides.
 */
export interface OutcomeFragment {
  /** G5: written by something other than this process */
  foreign?: boolean;
  id: string;
  section: string;
  content: string;
  by: string;
  taint?: string;
  ts: string;
}

export interface Outcome {
  id: string;
  title: string;
  sections: string[];
  by: string;
  taint?: string;
  status: 'draft' | 'in_progress' | 'finalized';
  fragments: OutcomeFragment[];
  createdAt: string;
  finalizedAt?: string;
  /** the assembled document (outside the workspace, in the team directory) */
  file?: string;
}

type OutcomeOp =
  | { op: 'outcome'; outcome: { id: string; title: string; sections: string[] }; by: string; taint?: string; ts: string }
  | { op: 'fragment'; outcomeId: string; fragment: OutcomeFragment }
  | { op: 'finalize'; outcomeId: string; by: string; file: string; ts: string };

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run `fn` holding `<file>` as an exclusive lock. Throws (typed) if it cannot be had within `waitMs`. */
export function withLock<T>(lock: string, fn: () => T, waitMs = 10_000): T {
  const deadline = Date.now() + waitMs;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(lock, 'utf8').trim());
        stale = (!Number.isNaN(pid) && !pidAlive(pid)) || Date.now() - fs.statSync(lock).mtimeMs > 30_000;
      } catch {
        stale = false; // vanished between open and read: retry
      }
      if (stale) {
        try {
          fs.rmSync(lock);
        } catch {
          /* someone else removed it */
        }
        continue;
      }
      if (Date.now() > deadline) throw new ChildRefusal('claim_conflict', `the team board is locked by another process (${lock}); try again`);
      Atomics.wait(sleeper, 0, 0, 1 + Math.floor(Math.random() * 4));
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd!);
    fs.rmSync(lock, { force: true });
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a torn final line from a crash: ignored */
    }
  }
  return out;
}

type Op =
  | { op: 'add'; task: { id: string; title: string; description: string; deps: string[] }; by: string; taint?: string; ts: string }
  | { op: 'claim'; id: string; by: string; taint?: string; ts: string; leaseUntil?: number }
  | { op: 'renew'; by: string; leaseUntil: number; ts: string }
  | { op: 'update'; id: string; by: string; status: TaskStatus; result?: string; note?: string; taint?: string; ts: string }
  | { op: 'requeue'; id: string; by: string; reason: string; ts: string };

export class Board {
  readonly boardFile: string;
  readonly messagesFile: string;
  readonly lockFile: string;
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.boardFile = path.join(dir, 'board.jsonl');
    this.messagesFile = path.join(dir, 'messages.jsonl');
    // the lock lives outside the workspace (the protected-path guard would see it come and go), keyed by the board
    this.lockFile = path.join(os.tmpdir(), `oh-team-${crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24)}.lock`);
  }

  /**
   * G5 + H3: a team's own board (in its lead process) signs every record it appends: a monotonic sequence number and
   * an HMAC over sequence + content, keyed by a per-team secret that only this process holds. Folding, a record
   * with a valid MAC and a higher sequence than the last one is the team's own; a valid MAC with a sequence already
   * passed is a replay (or out of order) and is ignored; anything else (a board host, another process, a hand edit,
   * the process before a resume) is untrusted whatever taint it declares.
   */
  private key?: Buffer;
  private seq = 0;
  get localOnly(): boolean {
    return !!this.key;
  }
  /** turning it on gives this board a fresh per-process key (what `trustWith` does with a given one) */
  set localOnly(on: boolean) {
    this.key = on ? (this.key ?? crypto.randomBytes(32)) : undefined;
  }
  trustWith(key: Buffer): void {
    this.key = key;
  }

  private mac(seq: number, body: string): string {
    return crypto.createHmac('sha256', this.key!).update(`${seq}\n${body}`).digest('hex');
  }

  private seal(o: object): string {
    if (!this.key) return JSON.stringify(o);
    const seq = ++this.seq;
    return JSON.stringify({ ...o, seq, mac: this.mac(seq, JSON.stringify(o)) });
  }

  /** Strip and check a record's seal: 'own' (signed by this process, in order), 'foreign', or 'replay' (ignored). */
  private unseal<T>(raw: T & { seq?: unknown; mac?: unknown }, state: { last: number }): { o: T; kind: 'own' | 'foreign' | 'replay' } {
    const { seq, mac, ...rest } = raw as Record<string, unknown>;
    const o = rest as T;
    if (!this.key) return { o, kind: 'own' };
    if (typeof seq !== 'number' || typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) return { o, kind: 'foreign' };
    const want = Buffer.from(this.mac(seq, JSON.stringify(rest)), 'hex');
    if (!crypto.timingSafeEqual(want, Buffer.from(mac, 'hex'))) return { o, kind: 'foreign' };
    if (seq <= state.last) return { o, kind: 'replay' };
    state.last = seq;
    return { o, kind: 'own' };
  }

  private foreignTaint(kind: 'own' | 'foreign', by: string, declared: string | undefined): string | undefined {
    if (kind === 'own') return declared;
    return declared ?? `written outside this team's process by ${by}`;
  }

  /** Fold the log into the current tasks (in insertion order). */
  tasks(): BoardTask[] {
    const m = new Map<string, BoardTask>();
    const state = { last: 0 };
    for (const raw of readJsonl<Op>(this.boardFile)) {
      const { o, kind } = this.unseal(raw, state);
      if (kind === 'replay') continue;
      if (o.op === 'add') {
        // H3: a task id is added once; a later add (a replayed or forged line) never resets it
        if (!m.has(o.task.id)) m.set(o.task.id, { ...o.task, status: 'pending', by: o.by, taint: this.foreignTaint(kind, o.by, o.taint), foreign: kind === 'foreign', claims: 0, updatedAt: o.ts });
        continue;
      }
      if (o.op === 'renew') {
        for (const x of m.values()) if (x.status === 'in_progress' && x.owner === o.by) x.leaseUntil = o.leaseUntil;
        continue;
      }
      const t = 'id' in o ? m.get(o.id) : undefined;
      if (!t) continue;
      if (o.op === 'claim') Object.assign(t, { status: 'in_progress', owner: o.by, claims: t.claims + 1, updatedAt: o.ts, leaseUntil: o.leaseUntil });
      if (o.op === 'update') Object.assign(t, { status: o.status, result: o.result ?? t.result, note: o.note ?? t.note, by: o.by, taint: this.foreignTaint(kind, o.by, o.taint) ?? t.taint, foreign: kind === 'foreign' || t.foreign, updatedAt: o.ts, owner: o.status === 'pending' ? undefined : t.owner });
      if (o.op === 'requeue') Object.assign(t, { status: 'pending', owner: undefined, note: o.reason, updatedAt: o.ts });
    }
    // F6: an expired lease puts the task back on the board (its owner stopped renewing: crashed, stuck, gone)
    const now = Date.now();
    for (const t of m.values()) if (t.status === 'in_progress' && t.leaseUntil !== undefined && t.leaseUntil < now) Object.assign(t, { status: 'pending', owner: undefined, note: `the claim by ${t.owner} expired`, leaseUntil: undefined });
    return [...m.values()];
  }

  /** F6: extend the leases of everything `owner` holds. */
  renew(owner: string, leaseMs: number): void {
    withLock(this.lockFile, () => this.append({ op: 'renew', by: owner, leaseUntil: Date.now() + leaseMs, ts: new Date().toISOString() }));
  }

  private append(o: Op): void {
    fs.appendFileSync(this.boardFile, this.seal(o) + '\n', { mode: 0o600 });
    // R1: the harness wrote this agent-control file itself; the protected-path guard adopts it
    noteHarnessWrite(this.boardFile);
  }

  /** Ready = pending with every dependency done. */
  static ready(tasks: BoardTask[]): BoardTask[] {
    const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return tasks.filter((t) => t.status === 'pending' && t.deps.every((d) => done.has(d)));
  }

  add(t: { id?: string; title: string; description?: string; deps?: string[] }, by: string, taint?: string): BoardTask {
    return withLock(this.lockFile, () => {
      const cur = this.tasks();
      const id = t.id && /^[A-Za-z0-9._-]{1,32}$/.test(t.id) ? t.id : `t${cur.length + 1}`;
      if (cur.some((x) => x.id === id)) throw new ChildRefusal('invalid_spec', `task id ${id} already exists`);
      const deps = [...new Set(t.deps ?? [])];
      const unknown = deps.filter((d) => !cur.some((x) => x.id === d));
      if (unknown.length) throw new ChildRefusal('invalid_spec', `unknown dependencies: ${unknown.join(', ')} (add those tasks first)`);
      const ts = new Date().toISOString();
      this.append({ op: 'add', task: { id, title: String(t.title).slice(0, 200), description: String(t.description ?? '').slice(0, 4000), deps }, by, taint, ts });
      return this.tasks().find((x) => x.id === id)!;
    });
  }

  /** Atomic claim: only a pending task whose dependencies are all done, by exactly one claimant. */
  claim(id: string, by: string, taint?: string, leaseMs?: number): BoardTask {
    return withLock(this.lockFile, () => {
      const cur = this.tasks();
      const t = cur.find((x) => x.id === id);
      if (!t) throw new ChildRefusal('invalid_spec', `no task ${id}`);
      if (t.status !== 'pending') throw new ChildRefusal('claim_conflict', `task ${id} is ${t.status}${t.owner ? ` (claimed by ${t.owner})` : ''}`);
      const done = new Set(cur.filter((x) => x.status === 'done').map((x) => x.id));
      const waiting = t.deps.filter((d) => !done.has(d));
      if (waiting.length) throw new ChildRefusal('blocked_by_dependencies', `task ${id} waits for ${waiting.join(', ')}`);
      this.append({ op: 'claim', id, by, taint, ts: new Date().toISOString(), ...(leaseMs ? { leaseUntil: Date.now() + leaseMs } : {}) });
      return this.tasks().find((x) => x.id === id)!;
    });
  }

  /** Only the owner (or the lead) changes a claimed task. */
  update(id: string, by: string, u: { status: TaskStatus; result?: string; note?: string }, o: { taint?: string; lead?: boolean } = {}): BoardTask {
    return withLock(this.lockFile, () => {
      const t = this.tasks().find((x) => x.id === id);
      if (!t) throw new ChildRefusal('invalid_spec', `no task ${id}`);
      if (!o.lead && t.owner !== by) throw new ChildRefusal('claim_conflict', `task ${id} is ${t.owner ? `owned by ${t.owner}` : 'not claimed'}; claim it first`);
      this.append({ op: 'update', id, by, status: u.status, result: u.result?.slice(0, 8000), note: u.note?.slice(0, 2000), taint: o.taint, ts: new Date().toISOString() });
      return this.tasks().find((x) => x.id === id)!;
    });
  }

  /** Put in-progress tasks of members that are gone back to pending (a stopped member, a dead lead process). */
  requeue(owners: string[], reason: string): string[] {
    return withLock(this.lockFile, () => {
      const ids = this.tasks().filter((t) => t.status === 'in_progress' && t.owner && owners.includes(t.owner)).map((t) => t.id);
      for (const id of ids) this.append({ op: 'requeue', id, by: 'harness', reason, ts: new Date().toISOString() });
      return ids;
    });
  }

  get outcomesFile(): string {
    return path.join(this.dir, 'outcomes.jsonl');
  }

  /** F12: the outcome documents, folded from their log. */
  outcomes(): Outcome[] {
    const m = new Map<string, Outcome>();
    const state = { last: 0 };
    for (const raw of readJsonl<OutcomeOp>(this.outcomesFile)) {
      const { o, kind } = this.unseal(raw, state);
      if (kind === 'replay') continue;
      if (o.op === 'outcome') {
        if (!m.has(o.outcome.id)) m.set(o.outcome.id, { ...o.outcome, by: o.by, taint: this.foreignTaint(kind, o.by, o.taint), status: 'draft', fragments: [], createdAt: o.ts });
        continue;
      }
      const x = m.get(o.outcomeId);
      if (!x) continue;
      if (o.op === 'fragment') {
        if (x.fragments.some((g) => g.id === o.fragment.id)) continue;
        x.fragments.push({ ...o.fragment, taint: this.foreignTaint(kind, o.fragment.by, o.fragment.taint), ...(kind === 'foreign' ? { foreign: true } : {}) });
        if (x.status === 'draft') x.status = 'in_progress';
      }
      if (o.op === 'finalize') Object.assign(x, { status: 'finalized', finalizedAt: o.ts, file: o.file });
    }
    return [...m.values()];
  }

  private appendOutcome(o: OutcomeOp): void {
    fs.appendFileSync(this.outcomesFile, this.seal(o) + '\n', { mode: 0o600 });
    noteHarnessWrite(this.outcomesFile);
  }

  createOutcome(o: { id?: string; title: string; sections: string[] }, by: string, taint?: string): Outcome {
    return withLock(this.lockFile, () => {
      const cur = this.outcomes();
      const id = o.id && /^[A-Za-z0-9._-]{1,32}$/.test(o.id) ? o.id : `o${cur.length + 1}`;
      if (cur.some((x) => x.id === id)) throw new ChildRefusal('invalid_spec', `outcome ${id} already exists`);
      const sections = [...new Set((o.sections ?? []).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 20);
      if (!sections.length) throw new ChildRefusal('invalid_spec', 'an outcome needs at least one section');
      this.appendOutcome({ op: 'outcome', outcome: { id, title: String(o.title ?? id).slice(0, 200), sections }, by, taint, ts: new Date().toISOString() });
      return this.outcomes().find((x) => x.id === id)!;
    });
  }

  attachFragment(outcomeId: string, section: string, content: string, by: string, taint?: string): OutcomeFragment {
    return withLock(this.lockFile, () => {
      const x = this.outcomes().find((o) => o.id === outcomeId);
      if (!x) throw new ChildRefusal('invalid_spec', `no outcome ${outcomeId}`);
      if (x.status === 'finalized') throw new ChildRefusal('invalid_spec', `outcome ${outcomeId} is finalized`);
      if (!x.sections.includes(section)) throw new ChildRefusal('invalid_spec', `"${section}" is not a section of ${outcomeId} (sections: ${x.sections.join(', ')})`);
      const fragment: OutcomeFragment = { id: `f${x.fragments.length + 1}`, section, content: String(content).slice(0, 8000), by, taint, ts: new Date().toISOString() };
      this.appendOutcome({ op: 'fragment', outcomeId, fragment });
      return fragment;
    });
  }

  /**
   * Assemble the document: per section the chosen fragment (default: the latest). Every required section needs
   * one. The file is advisory: it says so, names each fragment's author, and envelopes tainted fragments.
   */
  finalizeOutcome(outcomeId: string, by: string, choose: Record<string, string> = {}, wrap: (f: OutcomeFragment) => string = (f) => f.content): Outcome {
    return withLock(this.lockFile, () => {
      const x = this.outcomes().find((o) => o.id === outcomeId);
      if (!x) throw new ChildRefusal('invalid_spec', `no outcome ${outcomeId}`);
      if (x.status === 'finalized') throw new ChildRefusal('invalid_spec', `outcome ${outcomeId} is already finalized`);
      const picked = x.sections.map((sec) => {
        const all = x.fragments.filter((f) => f.section === sec);
        const f = choose[sec] ? all.find((g) => g.id === choose[sec]) : all.at(-1);
        if (!f) throw new ChildRefusal('invalid_spec', `section "${sec}" of ${outcomeId} has ${choose[sec] ? `no fragment ${choose[sec]}` : 'no fragment yet'}`);
        return [sec, f] as const;
      });
      const doc = [
        `# ${x.title}`,
        '',
        `> Advisory outcome document assembled by ${by} from fragments written by team agents. No agent reviewed or approved it; it is input for your decision.`,
        '',
        ...picked.flatMap(([sec, f]) => [`## ${sec}`, '', `_(fragment ${f.id} by ${f.by}${f.taint ? `; read untrusted content: ${f.taint}` : ''})_`, '', wrap(f), '']),
      ].join('\n');
      const dir = path.join(this.dir, 'outcomes');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, `${x.id}.md`);
      fs.writeFileSync(file, doc, { mode: 0o600 });
      noteHarnessWrite(file);
      this.appendOutcome({ op: 'finalize', outcomeId, by, file, ts: new Date().toISOString() });
      return this.outcomes().find((o) => o.id === outcomeId)!;
    });
  }

  postMessage(m: Omit<TeamMessage, 'id' | 'ts'>): TeamMessage {
    return withLock(this.lockFile, () => {
      const msg: TeamMessage = { id: `m${readJsonl(this.messagesFile).length + 1}`, ts: new Date().toISOString(), ...m };
      fs.appendFileSync(this.messagesFile, JSON.stringify(msg) + '\n', { mode: 0o600 });
      noteHarnessWrite(this.messagesFile);
      return msg;
    });
  }

  messages(): TeamMessage[] {
    return readJsonl<TeamMessage>(this.messagesFile);
  }
}
