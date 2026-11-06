/**
 * N23: the security-event stream.
 *
 * One structured record per security-relevant decision:
 *   refusal           a call was refused (hard deny, deny rule, user/extension "no", hook block)
 *   approval          an `ask` was settled or escalated: by "human", or by an extension
 *                     (classifier approver, prefilter, PermissionRequest hook), with the decision
 *   taint             untrusted content (`<untrusted_*>` wrapped web, MCP, browser, desktop or
 *                     OCR text) entered the context; later events of the run carry `tainted: true`
 *   protected_restore the R1 guard undid a shell change to protected files
 *   sandbox           the sandbox state at run start, and blocked network hosts
 *   secret_redaction  a tool result held credential-shaped text (it is redacted in the journal)
 *   policy_violation  the managed policy overrode or refused a setting, or its source was unusable
 *
 * Every record goes, content-free unless `securityEvents.includeContent`, to:
 *   - a JSONL audit file `<homeDir>/audit/security-<time>-<pid>.jsonl`, one per
 *     process, hash-chained exactly like the run journal (WS4 R6): each line
 *     carries `_h` = sha256(previous hash + line body), from "genesis";
 *   - OpenTelemetry, as an `oh.safety_event` span event through WS8's telemetry
 *     module (when tracing is on);
 *   - the shared external anchor `audit.sink` (auditSink.ts), with the line's
 *     hash, so a rewritten or truncated audit file is detectable;
 *   - in-process listeners (`onSecurityEvent`).
 *
 * `tug audit verify [file…]` checks the chains; `tug audit export --since 7d
 * --format jsonl|sarif` exports them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import type { AgentEvent } from '../types.js';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';
import { registerCliCommand } from '../commands.js';
import { addTelemetryEvent } from '../telemetry/otel.js';
import { redactSecrets } from '../util/text.js';
import { auditSinkFor } from './auditSink.js';
import { parseSince } from './limits.js';

export const SECURITY_EVENT_TYPES = ['refusal', 'approval', 'taint', 'protected_restore', 'sandbox', 'secret_redaction', 'policy_violation'] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

export interface SecurityEvent {
  v: 1;
  type: SecurityEventType;
  ts: string;
  /** a short machine category, e.g. protected_path, outside_workspace, user_denied, prefilter:exfiltration */
  category: string;
  /** allow | ask | deny | restore | block | state | detected | override */
  decision: string;
  /** who decided: policy, human, prefilter, classifier, hook, guard, sandbox, managed … */
  by: string;
  reason: string;
  session: string;
  run?: string;
  depth: number;
  tool?: string;
  tainted?: boolean;
  user: string;
  host: string;
  /** only with securityEvents.includeContent */
  content?: unknown;
}

export interface SecurityEventsConfig {
  /** write the hash-chained JSONL audit file (default true) */
  file: boolean;
  /** put arguments and matched text on events (default false) */
  includeContent: boolean;
  /** emit `oh.safety_event` OTel span events when tracing is on (default true) */
  otel: boolean;
}
export const DEFAULT_SECURITY_EVENTS: SecurityEventsConfig = { file: true, includeContent: false, otel: true };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** N23 (WS3). The external anchor is `audit.sink` (shared with the journal, WS4 R6). */
    securityEvents?: Partial<SecurityEventsConfig>;
  }
}

export function securityEventsConfig(cfg: HarnessConfig): SecurityEventsConfig {
  return { ...DEFAULT_SECURITY_EVENTS, ...(cfg.securityEvents ?? {}) };
}

const sinkTarget = (cfg: HarnessConfig) => (cfg as unknown as { audit?: { sink?: string } }).audit?.sink;

// ------------------------------------------------------------ the chained audit file

export function auditDir(homeDir: string): string {
  return path.join(homeDir, 'audit');
}

interface Chain {
  file: string;
  prev: string;
  lines: number;
}
const chains = new Map<string, Chain>();

function chainFor(homeDir: string): Chain {
  let c = chains.get(homeDir);
  if (!c) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    c = { file: path.join(auditDir(homeDir), `security-${stamp}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.jsonl`), prev: 'genesis', lines: 0 };
    chains.set(homeDir, c);
  }
  return c;
}

/** Append one record to the chain. Returns its line number and hash. */
function appendChained(c: Chain, rec: Record<string, unknown>): { line: number; hash: string } {
  const body = JSON.stringify(rec);
  const hash = crypto.createHash('sha256').update(c.prev + body).digest('hex').slice(0, 32);
  fs.mkdirSync(path.dirname(c.file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(c.file, `${body.slice(0, -1)},"_h":"${hash}"}\n`, { mode: 0o600 });
  c.prev = hash;
  c.lines++;
  return { line: c.lines, hash };
}

/** Walk a hash chain (audit file or journal, same format): first broken line (0 = intact), line count, last hash. */
export function verifyHashChain(file: string): { broken: number; lines: number; last: string } {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let prev = 'genesis';
  for (let i = 0; i < lines.length; i++) {
    const m = /^(.*),"_h":"([0-9a-f]{32})"\}$/.exec(lines[i]!);
    if (!m) return { broken: i + 1, lines: lines.length, last: prev };
    const h = crypto.createHash('sha256').update(prev + m[1] + '}').digest('hex').slice(0, 32);
    if (h !== m[2]) return { broken: i + 1, lines: lines.length, last: prev };
    prev = h;
  }
  return { broken: 0, lines: lines.length, last: prev };
}

// ------------------------------------------------------------ recording

const listeners = new Set<(e: SecurityEvent) => void>();
/** In-process subscription (tests, embedding apps). Returns an unsubscribe function. */
export function onSecurityEvent(cb: (e: SecurityEvent) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const tainted = new WeakMap<object, boolean>();
const pendingOtel = new WeakMap<object, Record<string, string | number | boolean>[]>();
let userName: string | undefined;
function osUser(): string {
  if (userName === undefined) {
    try {
      userName = os.userInfo().username;
    } catch {
      userName = 'unknown';
    }
  }
  return userName;
}

export type SecurityEventInput = Pick<SecurityEvent, 'type' | 'category' | 'decision' | 'by' | 'reason'> & { tool?: string; content?: unknown };

/**
 * Record a security event that has no agent behind it (the channel gateway refusing an unpaired sender, a bad webhook
 * signature): same hash-chained audit file, OTel and listeners as an agent's events (S8). Never throws.
 */
export function recordStandaloneSecurityEvent(config: HarnessConfig, session: string, input: SecurityEventInput): SecurityEvent | undefined {
  return recordSecurityEvent({ config, sessionId: session, depth: 0, agent: { standalone: session } } as unknown as AgentApi, input);
}

/** Record a security event for an agent (file, OTel, external anchor, listeners). Never throws. */
export function recordSecurityEvent(a: AgentApi, input: SecurityEventInput): SecurityEvent | undefined {
  try {
    const sc = securityEventsConfig(a.config);
    const ev: SecurityEvent = {
      v: 1,
      type: input.type,
      ts: new Date().toISOString(),
      category: input.category,
      decision: input.decision,
      by: input.by,
      reason: redactSecrets(input.reason).slice(0, 500),
      session: a.sessionId,
      ...(a.runId ? { run: a.runId } : {}),
      depth: a.depth,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(tainted.get(a.agent as object) ? { tainted: true } : {}),
      user: osUser(),
      host: os.hostname(),
      ...(sc.includeContent && input.content !== undefined ? { content: JSON.parse(redactSecrets(JSON.stringify(input.content))) } : {}),
    };
    let anchor: { line: number; hash: string; file: string } | undefined;
    if (sc.file) {
      const c = chainFor(a.config.homeDir);
      anchor = { ...appendChained(c, ev as unknown as Record<string, unknown>), file: path.basename(c.file) };
    }
    if (sc.otel) {
      const attrs = {
        'tugline.safety.type': ev.type,
        'tugline.safety.category': ev.category,
        'tugline.safety.decision': ev.decision,
        'tugline.safety.by': ev.by,
        ...(ev.tool ? { 'gen_ai.tool.name': ev.tool } : {}),
        ...(ev.tainted ? { 'tugline.safety.tainted': true } : {}),
      };
      // Events before the run span exists (session start) are attached to the run once it does.
      const queue = pendingOtel.get(a.agent as object) ?? [];
      queue.push(attrs);
      while (queue.length && addTelemetryEvent(a, 'oh.safety_event', queue[0]!)) queue.shift();
      if (queue.length) pendingOtel.set(a.agent as object, queue.slice(-100));
      else pendingOtel.delete(a.agent as object);
    }
    try {
      const sink = auditSinkFor(sinkTarget(a.config), a.workspace);
      if (sink) {
        const { content: _c, ...lean } = ev;
        sink.send({ session: ev.session, file: anchor?.file ?? 'security', line: anchor?.line ?? 0, hash: anchor?.hash ?? '', ts: ev.ts, stream: 'security', event: lean as unknown as Record<string, unknown> });
      }
    } catch {
      /* an invalid sink was reported at journal creation */
    }
    for (const l of listeners) {
      try {
        l(ev);
      } catch {
        /* listeners never break the loop */
      }
    }
    return ev;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ mapping agent events

/** A short machine category for a refusal reason. */
export function refusalCategory(reason: string): string {
  // first: a denial because nobody could answer quotes the ask's own reason ("… (the command writes outside the
  // workspace …)"); it is a no-user denial, not a policy refusal (WS18: surfaces disagreed in the audit stream)
  if (/^no user is available/.test(reason)) return 'no_user';
  if (/protected pattern/.test(reason)) return 'protected_path';
  if (/controls the agent/.test(reason)) return 'agent_control';
  if (/outside the workspace/.test(reason)) return 'outside_workspace';
  if (/plan mode/.test(reason)) return 'plan_mode';
  if (/denied by rule/.test(reason)) return 'deny_rule';
  if (/no user is available/.test(reason)) return 'no_user';
  if (/hook/i.test(reason)) return 'hook';
  if (/sandbox/i.test(reason)) return 'sandbox';
  if (/approver|classifier|prefilter|blocked by/.test(reason)) return 'approver';
  if (/denied|said no|user/.test(reason)) return 'user_denied';
  return 'other';
}

const AUTO_BY = /auto-approved by ([^:;)]+)/;
const execSeen = new WeakMap<object, Set<string>>();

function fromAgentEvent(a: AgentApi, e: AgentEvent): void {
  switch (e.type) {
    case 'refusal':
      // the R1 guard records its own protected_restore event (with the same facts)
      if (/^shell command modified protected path/.test(e.reason)) return;
      recordSecurityEvent(a, { type: 'refusal', category: refusalCategory(e.reason), decision: 'deny', by: /hook/i.test(e.reason) ? 'hook' : /^(?:blocked by|denied by rule|refusing|plan mode)/.test(e.reason) ? 'policy' : 'human', reason: e.reason, tool: e.tool, content: e.args });
      return;
    case 'permission': {
      const by = e.auto ? (AUTO_BY.exec(e.request.reason ?? '')?.[1]?.trim() ?? 'extension') : 'human';
      recordSecurityEvent(a, { type: 'approval', category: e.request.kind, decision: e.answer.decision, by, reason: e.request.reason ?? '', tool: e.request.tool, content: e.request.detail });
      return;
    }
    case 'approval_auto':
      // an auto-approver's allow is recorded by the `permission` event that follows; escalations and denials are recorded here
      if (e.decision === 'allow') return;
      recordSecurityEvent(a, { type: 'approval', category: e.category ? `${e.by}:${e.category}` : e.by, decision: e.decision, by: e.by, reason: e.reason ?? '', tool: e.tool });
      return;
    default:
      return;
  }
}

registerAgentExtension({
  id: 'ws3-security-events',
  onEvent(a, e) {
    fromAgentEvent(a, e);
  },
  onSessionStart(a) {
    const m = a.config.managed;
    if (a.depth !== 0 || !m) return;
    for (const v of m.violations) recordSecurityEvent(a, { type: 'policy_violation', category: 'managed', decision: 'override', by: 'managed', reason: v });
  },
  async onRunStart(a) {
    if (a.depth !== 0) return;
    tainted.delete(a.agent as object);
    execSeen.delete(a.agent as object);
    try {
      const { sandboxStatus } = await import('../sandbox/index.js');
      const st = sandboxStatus(a.config);
      recordSecurityEvent(a, { type: 'sandbox', category: st.runner, decision: st.refusing ? 'refuse' : 'state', by: 'sandbox', reason: st.summary });
    } catch {
      /* status is best effort */
    }
  },
  afterTool(a, call) {
    const out = call.output ?? '';
    // N36 review finding 12 (SAC3): which sandbox a command ACTUALLY ran under, from the spawn path (the wrapper that
    // confined it), compared with what the config says is in force; a difference is recorded (once per run and
    // runner), so a surface that stops sandboxing its commands shows up in the audit stream
    const meta = call.meta as { sandbox?: unknown; sandboxExpected?: { runner: string; refusing: boolean } } | undefined;
    const ran = meta?.sandbox;
    const want = meta?.sandboxExpected;
    if (typeof ran === 'string' && want && !(ran === want.runner || (want.refusing && (ran === 'refused' || ran === want.runner)))) {
      let seen = execSeen.get(a.agent as object);
      if (!seen) execSeen.set(a.agent as object, (seen = new Set()));
      if (!seen.has(ran)) {
        seen.add(ran);
        recordSecurityEvent(a, { type: 'sandbox', category: ran, decision: 'exec_mismatch', by: 'sandbox', reason: `a command ran under ${ran === 'none' ? 'no OS sandbox' : ran}, but the sandbox in force is ${want.refusing ? 'refusing commands' : want.runner}`, tool: call.tool });
      }
    }
    if (/<untrusted_[a-z_]+[\s>]/.test(out) && !tainted.get(a.agent as object)) {
      tainted.set(a.agent as object, true);
      recordSecurityEvent(a, { type: 'taint', category: /<untrusted_([a-z_]+)/.exec(out)?.[1] ?? 'untrusted', decision: 'detected', by: 'harness', reason: `untrusted content entered the context through ${call.tool}; later decisions in this run are marked tainted`, tool: call.tool });
    }
    const red = redactSecrets(out);
    if (red !== out) {
      const n = red.split('[REDACTED]').length - out.split('[REDACTED]').length;
      recordSecurityEvent(a, { type: 'secret_redaction', category: 'tool_output', decision: 'detected', by: 'harness', reason: `${n} credential-shaped value(s) in the ${call.tool} result (redacted in the journal and the audit stream)`, tool: call.tool });
    }
  },
  async onSessionEnd() {
    const { flushAuditSinks } = await import('./auditSink.js');
    await flushAuditSinks();
  },
});

// ------------------------------------------------------------ tug audit

export function readAuditEvents(homeDir: string, sinceDate?: string): (SecurityEvent & { _file: string })[] {
  const dir = auditDir(homeDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^security-.*\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }
  const out: (SecurityEvent & { _file: string })[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SecurityEvent & { _h?: string };
        if (sinceDate && e.ts.slice(0, 10) < sinceDate) continue;
        out.push({ ...e, _file: f });
      } catch {
        /* a broken line is reported by verify */
      }
    }
  }
  return out.sort((x, y) => x.ts.localeCompare(y.ts));
}

const SARIF_LEVEL: Record<string, 'error' | 'warning' | 'note'> = { refusal: 'warning', protected_restore: 'error', policy_violation: 'warning', secret_redaction: 'warning', taint: 'note', approval: 'note', sandbox: 'note' };

/** SARIF 2.1.0: one rule per event type, one result per event. */
export function toSarif(events: SecurityEvent[]): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: { driver: { name: 'Tugline', informationUri: 'https://github.com/pmgarg/Tugline', rules: SECURITY_EVENT_TYPES.map((t) => ({ id: `oh.${t}`, name: t, shortDescription: { text: `Tugline security event: ${t}` } })) } },
        results: events.map((e) => ({
          ruleId: `oh.${e.type}`,
          ruleIndex: SECURITY_EVENT_TYPES.indexOf(e.type),
          level: SARIF_LEVEL[e.type] ?? 'note',
          message: { text: `${e.decision} by ${e.by} (${e.category})${e.tool ? ` on ${e.tool}` : ''}: ${e.reason}` },
          properties: { ts: e.ts, session: e.session, run: e.run, depth: e.depth, user: e.user, host: e.host, category: e.category, decision: e.decision, by: e.by, tainted: e.tainted ?? false },
        })),
      },
    ],
  };
}

export function auditCommand(argv: string[], ctx: { config: HarnessConfig; write: (t: string) => void }): number {
  const sub = argv[0];
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (sub === 'verify') {
    const files = argv.slice(1).filter((x) => !x.startsWith('-'));
    const dir = auditDir(ctx.config.homeDir);
    const list = files.length ? files : fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)) : [];
    let bad = 0;
    for (const f of list) {
      const r = verifyHashChain(f);
      if (r.broken) bad++;
      ctx.write(`${r.broken ? 'BROKEN' : 'ok    '} ${f}  ${r.lines} lines${r.broken ? `, chain breaks at line ${r.broken}` : ''}  last ${r.last}\n`);
    }
    if (!list.length) ctx.write('no audit files\n');
    return bad ? 1 : 0;
  }
  if (sub === 'export') {
    const format = opt('--format') ?? 'jsonl';
    const since = parseSince(opt('--since'));
    const events = readAuditEvents(ctx.config.homeDir, since).map(({ _file, ...e }) => {
      const { _h, ...clean } = e as SecurityEvent & { _h?: string };
      return clean as SecurityEvent;
    });
    const text = format === 'sarif' ? JSON.stringify(toSarif(events), null, 2) + '\n' : format === 'jsonl' ? events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '') : undefined;
    if (text === undefined) {
      ctx.write(`unknown --format ${format} (jsonl | sarif)\n`);
      return 2;
    }
    const out = opt('--out');
    if (out) fs.writeFileSync(out, text);
    else ctx.write(text);
    return 0;
  }
  ctx.write('usage: tug audit export [--since YYYY-MM-DD|Nd|today] [--format jsonl|sarif] [--out FILE] | tug audit verify [FILE…]\n');
  return sub ? 2 : 0;
}

registerCliCommand({ name: 'audit', description: 'security events: export (jsonl, sarif) and verify the hash chain', usage: 'export [--since 7d] [--format jsonl|sarif] [--out FILE] | verify [FILE…]', needsModel: false, run: (argv, ctx) => auditCommand(argv, ctx) });
