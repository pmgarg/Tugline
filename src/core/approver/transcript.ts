/**
 * N43: the transcript the auto-mode classifier sees.
 *
 * Idea from Qwen Code packages/core/src/permissions/classifier-transcript.ts
 * (commit c726d2c, Apache-2.0): strip assistant prose and tool results, keep the
 * user's words and the agent's prior actions, bound everything. Rewritten (not
 * ported) for our message format, with these differences:
 *  - Everything (brief, user messages, answers, prior actions AND the pending
 *    call) is rendered as JSON lines whose tag-like `<` is escaped as \u003c
 *    inside ONE `<untrusted_transcript>` envelope, so no text (a README
 *    quoted by the user, a planted command, a forged `</untrusted_transcript>`)
 *    can close the envelope or pose as rubric. Qwen sends user text and
 *    historical calls as plain user turns.
 *  - The durable task brief (R5) comes first, so the original request survives
 *    compaction; then the last N user messages; then recent actions.
 *  - A user message that carries an untrusted envelope (a channel message from a
 *    non-owner, a webhook) is labelled `untrusted_message`, never `user`.
 *  - Answers to the built-in `ask_user` tool are included as `user_answer`
 *    (the host writes that result from the human's reply), the only tool
 *    output that is ever included.
 *  - Prior actions that auto mode blocked are marked, so a retry of the same
 *    action (or an equivalent) is visible to the classifier.
 *  - Secrets are redacted from every string.
 */
import { ATTACHMENT_BLOCK } from '../util/attachments.js';
import path from 'node:path';
import type { ChatMessage } from '../types.js';
import { contentToText, redactSecrets } from '../util/text.js';
import { untrustedEnvelope } from '../context/taint.js';
import type { BriefEntry } from '../context/brief.js';

export const ENVELOPE_OPEN = '<untrusted_transcript>';
export const ENVELOPE_CLOSE = '</untrusted_transcript>';
export const PENDING_OPEN = '<pending_call>';
export const PENDING_CLOSE = '</pending_call>';

export interface TranscriptLimits {
  /** Last N real user messages (default 6). */
  userMessages: number;
  /** Last N prior tool calls (default 12). */
  actions: number;
  /** Characters kept per text entry (default 1200). */
  entryChars: number;
  /** Characters kept for the brief (default 2000). */
  briefChars: number;
}

export const DEFAULT_TRANSCRIPT_LIMITS: TranscriptLimits = { userMessages: 6, actions: 12, entryChars: 1200, briefChars: 2000 };

export interface PendingCall {
  tool: string;
  kind: string;
  command?: string;
  paths?: { path: string; write: boolean }[];
  domain?: string;
  args?: unknown;
  /** Working directory of a command when it is not the workspace. */
  cwd?: string;
}

export interface TranscriptInput {
  workspace: string;
  brief?: BriefEntry[];
  messages: ChatMessage[];
  pending: PendingCall;
  /** Fingerprints of actions auto mode blocked in this session. */
  blocked?: (tool: string, args: unknown) => boolean;
  limits?: Partial<TranscriptLimits>;
}

/**
 * JSON whose every tag-like `<` (before `/`, `!`, `?` or a letter) is escaped as \u003c: the line cannot open or
 * close a tag, whatever it contains, while shell redirections (`>`, `2>&1`, `< in.txt`) stay readable for a small model.
 */
export function inertJson(v: unknown): string {
  return JSON.stringify(v).replace(/<(?=[/!?A-Za-z])/g, '\\u003c');
}

function clip(s: string, n: number): string {
  const r = redactSecrets(s);
  return r.length > n ? `${r.slice(0, n)}…[${r.length - n} more chars]` : r;
}

function clipDeep(v: unknown, n: number, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, n);
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => clipDeep(x, n, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) out[k] = clipDeep(x, n, depth + 1);
  return out;
}

/** What of a tool call's arguments the classifier needs: commands and paths in full, bodies shortened. */
export function projectArgs(tool: string, args: unknown, n = 600): unknown {
  if (!args || typeof args !== 'object') return args ?? {};
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    // file bodies matter less than where they go; keep a head so a planted payload is still visible
    const body = /^(?:content|new_string|old_string|patch|text|code|input|body|data)$/.test(k);
    out[k] = typeof v === 'string' ? clip(v, body ? Math.min(n, 400) : n) : clipDeep(v, body ? 200 : n);
  }
  return out;
}

function relPath(p: string, ws: string): string {
  const r = path.relative(ws, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p;
}

/**
 * Context the harness or the editor attaches to a prompt (`@file` mentions, IDE context, hook context, the repo map,
 * piped stdin, ACP resources). It is file content, not the user's words (review finding 4): it is cut out of every
 * user entry and listed by source only, as an `attachment` entry the rubric says never shows intent.
 */
// re-check D/J: only harness-built blocks (util/attachments.ts: an id in the opening tag, tag-like text inside the
// body escaped) are attachments; the first closing tag after such an opening is the real one. Tag-like text the
// user typed (no id) stays part of their words.
export function splitAttachments(text: string): { text: string; sources: string[] } {
  const sources: string[] = [];
  const rest = text.replace(new RegExp(ATTACHMENT_BLOCK.source, 'g'), (_m, tag: string, attrs: string) => {
    const src = attrs.match(/\b(?:source|path)="([^"]*)"/)?.[1];
    sources.push(`${tag}${src ? `:${src}` : ''}`.slice(0, 200));
    return ' ';
  });
  return { text: rest.replace(/[ \t]+\n/g, '\n').trim(), sources };
}

/** The entries of the transcript, oldest first (exported for tests). */
export function transcriptEntries(t: TranscriptInput): Record<string, unknown>[] {
  const lim = { ...DEFAULT_TRANSCRIPT_LIMITS, ...(t.limits ?? {}) };
  const out: Record<string, unknown>[] = [];
  // 1. the durable brief: what the user asked for in this session (survives compaction)
  const brief = t.brief ?? [];
  if (brief.length) {
    let budget = lim.briefChars;
    const keep: BriefEntry[] = [];
    // newest constraints matter most, but the original request always stays
    for (let i = brief.length - 1; i >= 1 && budget > 0; i--) {
      keep.unshift(brief[i]!);
      budget -= brief[i]!.text.length;
    }
    keep.unshift(brief[0]!);
    for (const e of keep) {
      const a = splitAttachments(e.text);
      if (a.text) out.push({ kind: 'task_brief', type: e.kind, text: clip(a.text, e.kind === 'original' ? lim.briefChars : lim.entryChars) });
      for (const src of a.sources) out.push({ kind: 'attachment', source: clip(src, 200) });
    }
  }
  const briefTexts = new Set(brief.map((e) => e.text.trim()));
  // 2. user messages, user answers and prior actions, in order (tool results never)
  const items: Record<string, unknown>[] = [];
  // questions the agent asked with the built-in ask_user tool, by call id (their results are the human's answers)
  const askIds = new Map<string, string>();
  for (const m of t.messages) {
    for (const c of m.role === 'assistant' ? (m.tool_calls ?? []) : []) {
      if (c.function.name !== 'ask_user') continue;
      try {
        askIds.set(c.id, String(JSON.parse(c.function.arguments || '{}').question ?? ''));
      } catch {
        askIds.set(c.id, '');
      }
    }
  }
  let users = 0;
  let actions = 0;
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]!;
    if (m.role === 'user' && !m._meta?.synthetic && !m._meta?.compactedSummary) {
      if (users >= lim.userMessages) continue;
      const text = contentToText(m.content).replace(/\n*<repo_map>[\s\S]*?<\/repo_map>\s*$/, '').trim();
      if (!text) continue;
      users++;
      if (briefTexts.has(text)) continue; // already in the brief
      const untrusted = untrustedEnvelope(text);
      if (untrusted) {
        items.unshift({ kind: 'untrusted_message', source: untrusted, text: clip(text, lim.entryChars) });
        continue;
      }
      const a = splitAttachments(text);
      for (const src of a.sources.reverse()) items.unshift({ kind: 'attachment', source: clip(src, 200) });
      if (a.text) items.unshift({ kind: 'user', text: clip(a.text, lim.entryChars) });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (let j = m.tool_calls.length - 1; j >= 0; j--) {
        const c = m.tool_calls[j]!;
        if (actions >= lim.actions) continue;
        actions++;
        let args: unknown;
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {
          args = clip(String(c.function.arguments ?? ''), 300);
        }
        const e: Record<string, unknown> = { kind: 'prior_action', tool: c.function.name, args: projectArgs(c.function.name, args, 300) };
        if (t.blocked?.(c.function.name, args)) e.note = 'auto mode BLOCKED this action earlier';
        items.unshift(e);
      }
    } else if (m.role === 'tool' && m.name === 'ask_user' && m.tool_call_id && askIds.has(m.tool_call_id)) {
      // the host writes this result from the human's reply; any other tool output is never shown
      const ans = contentToText(m.content).match(/^User answered: ([\s\S]*)$/);
      if (ans) items.unshift({ kind: 'user_answer', question: clip(askIds.get(m.tool_call_id)!, 200), answer: clip(ans[1]!, lim.entryChars) });
    }
  }
  return [...out, ...items];
}

/** The pending call as the classifier sees it. */
export function pendingEntry(p: PendingCall, workspace: string): Record<string, unknown> {
  const d: Record<string, unknown> = { tool: p.tool, kind: p.kind };
  if (p.command !== undefined) d.command = clip(p.command, 4000);
  if (p.cwd && path.resolve(p.cwd) !== path.resolve(workspace)) d.cwd = relPath(p.cwd, workspace);
  if (p.paths?.length) d.paths = p.paths.map((x) => ({ path: relPath(x.path, workspace), write: x.write }));
  if (p.domain) d.domain = p.domain;
  if (p.command === undefined) d.args = projectArgs(p.tool, p.args, 1500);
  return d;
}

/** The envelope: one JSON line per entry, inert, between fixed markers. */
export function renderTranscript(t: TranscriptInput): string {
  const lines = transcriptEntries(t).map(inertJson);
  return `${ENVELOPE_OPEN}\n${lines.join('\n') || '(empty)'}\n${ENVELOPE_CLOSE}\n${PENDING_OPEN}\n${inertJson(pendingEntry(t.pending, t.workspace))}\n${PENDING_CLOSE}`;
}
