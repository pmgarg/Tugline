/**
 * Durable task brief (v1.1 R5).
 *
 * Compaction is lossy: v1.0 kept the original request only when the summary
 * did not already contain its first 200 characters (a constraint after that
 * prefix could vanish), and after a second compaction the "first user message"
 * was the previous summary note, so the original request was lost entirely.
 * Steers and corrections depended on the summariser.
 *
 * The brief is the authoritative record of what the user asked: the original
 * request plus every later user message that can add constraints (follow-up
 * prompts, steers, corrections, queued prompts). It lives outside the message
 * history (on the Agent, journaled as `task_brief` records, rebuilt on resume)
 * and is re-inserted verbatim after every compaction: in full when it is
 * bounded (≤ BRIEF_FULL_CHARS), otherwise as a structured excerpt (the head of
 * the original request, every constraint-like sentence, the latest messages)
 * plus a pointer to the `task_brief` tool, which returns the full text.
 */
import type { ChatMessage } from '../types.js';
import { contentToText } from '../util/text.js';

export const BRIEF_FULL_CHARS = 4000;

export type BriefKind = 'original' | 'follow_up' | 'steer' | 'correction';

export interface BriefEntry {
  kind: BriefKind;
  text: string;
  ts: string;
}

export interface TaskBrief {
  entries: BriefEntry[];
}

/** Text that the harness itself wraps around a prompt and that is not the user's own words. */
function cleanPrompt(text: string): string {
  return text
    .replace(/\n*<repo_map\b[^>]*>[\s\S]*?<\/repo_map>\s*$/, '')
    .replace(/^\[user steer\]\s*/, '')
    .trim();
}

const CORRECTION = /^(?:no[,.!]|nope|actually|wait|instead|correction|don'?t|do not|stop|not that|rather|i meant|scratch that|undo)\b/i;

export function briefKind(text: string, first: boolean, steer: boolean): BriefKind {
  if (first) return 'original';
  if (CORRECTION.test(text.trim())) return 'correction';
  return steer ? 'steer' : 'follow_up';
}

export function addToBrief(b: TaskBrief, text: string, opts: { steer?: boolean; ts?: string } = {}): BriefEntry | undefined {
  const t = cleanPrompt(text);
  if (!t) return undefined;
  const last = b.entries[b.entries.length - 1];
  if (last && last.text === t) return undefined; // the same message delivered twice (a steer that became the next prompt)
  const e: BriefEntry = { kind: briefKind(t, b.entries.length === 0, !!opts.steer || /^\[user steer\]/.test(text)), text: t, ts: opts.ts ?? new Date().toISOString() };
  b.entries.push(e);
  return e;
}

/** Rebuild a brief from history (resume without brief records, older journals). */
export function briefFromMessages(msgs: ChatMessage[]): TaskBrief {
  const b: TaskBrief = { entries: [] };
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const text = contentToText(m.content);
    if (m._meta?.synthetic && !m._meta?.compactedSummary) continue;
    // A compacted note from an older version carries the original request inside it.
    const carried = text.match(/<task_brief[^>]*>([\s\S]*?)<\/task_brief>/);
    if (carried) {
      // "### <kind> (<n>: <label>[, <ts>])" headers, each followed by the entry's text
      const parts = carried[1]!.split(/^### (original|follow_up|steer|correction) \([^\n]*\)\n/m);
      b.entries = [];
      for (let i = 1; i + 1 < parts.length; i += 2) b.entries.push({ kind: parts[i] as BriefKind, text: parts[i + 1]!.trim(), ts: '' });
      continue;
    }
    if (m._meta?.compactedSummary) continue;
    addToBrief(b, text);
  }
  return b;
}

const LABEL: Record<BriefKind, string> = { original: 'original request', follow_up: 'later request', steer: 'steer during the run', correction: 'correction' };

function fullText(b: TaskBrief): string {
  return b.entries.map((e, i) => `### ${e.kind} (${i + 1}: ${LABEL[e.kind]}${e.ts ? `, ${e.ts}` : ''})\n${e.text}`).join('\n\n');
}

/** Sentences that carry constraints: imperatives, prohibitions, requirements, exact names. */
const CONSTRAINT = /\b(?:must|mustn'?t|never|always|only|do not|don'?t|avoid|without|required?|requirement|constraint|critical|important|ensure|make sure|keep|preserve|no\s+\w+|not\s+(?:to|allowed)|forbidden|exactly|at least|at most|before|after|deadline)\b|[A-Z][A-Z0-9_]{5,}/;

/**
 * The bounded structured form of a long request (R5): the goal, every constraint-like sentence
 * verbatim, the paths and names it mentions, and its opening, plus where to read the source.
 */
export function structuredExcerpt(text: string, max: number, entry: number): string {
  if (text.length <= max) return text;
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
  const goal = (sentences[0] ?? text).slice(0, Math.min(300, Math.floor(max * 0.2)));
  const names = [...new Set([...text.matchAll(/(?:^|[\s(`'"])((?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|cs|c|h|cpp|json|ya?ml|toml|md|sql|sh)|[A-Z][A-Z0-9_]{5,})(?=$|[\s),.:;`'"])/g)].map((m) => m[1]!))].slice(0, 30);
  const budget = max - goal.length - 300;
  const constraints: string[] = [];
  let used = 0;
  for (const s of sentences.slice(1)) {
    if (!CONSTRAINT.test(s)) continue;
    const line = s.slice(0, 400);
    if (used + line.length + 3 > budget * 0.7) break;
    constraints.push(line);
    used += line.length + 3;
  }
  const headLen = Math.max(0, Math.floor(budget - used - names.join(', ').length));
  const head = headLen > 80 ? text.slice(0, headLen) : '';
  return [
    `Goal: ${goal}`,
    constraints.length ? `Constraints (verbatim):\n${constraints.map((c) => `- ${c}`).join('\n')}` : '',
    names.length ? `Mentioned paths and names: ${names.join(', ')}` : '',
    head ? `Opening (verbatim): ${head} […]` : '',
    `[${text.length} chars in full: call task_brief with {"entry": ${entry + 1}} for the source text]`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** The brief as it is re-inserted after compaction. */
export function renderBrief(b: TaskBrief, maxChars = BRIEF_FULL_CHARS): { text: string; truncated: boolean } {
  if (!b.entries.length) return { text: '', truncated: false };
  const full = fullText(b);
  const intro = 'The user\'s requests in this session, verbatim and authoritative (later entries refine or correct earlier ones; they override the summary):';
  if (full.length <= maxChars) return { text: `<task_brief>\n${intro}\n\n${full}\n</task_brief>`, truncated: false };
  // Bounded form: the original (excerpted), every correction and the last few entries (excerpted), constraint lines kept.
  const n = b.entries.length;
  const keep = new Set<number>([0, ...b.entries.map((e, i) => (e.kind === 'correction' ? i : -1)).filter((i) => i >= 0), n - 1, n - 2, n - 3].filter((i) => i >= 0 && i < n));
  const per = Math.max(400, Math.floor((maxChars - 400) / keep.size));
  const parts = [...keep].sort((x, y) => x - y).map((i) => `### ${b.entries[i]!.kind} (${i + 1}: ${LABEL[b.entries[i]!.kind]})\n${structuredExcerpt(b.entries[i]!.text, per, i)}`);
  const omitted = n - keep.size;
  return {
    text: `<task_brief truncated="true">\n${intro}\n(The full brief is ${full.length} chars${omitted ? `, ${omitted} entries not shown` : ''}; call the task_brief tool to read it in full before deciding anything that depends on it.)\n\n${parts.join('\n\n')}\n</task_brief>`,
    truncated: true,
  };
}

/** Full text for the task_brief tool: one entry (1-based) or the whole brief, paged. */
export function briefToolText(b: TaskBrief, offset = 0, limit = 20_000, entry?: number): string {
  if (entry !== undefined) {
    const e = b.entries[entry - 1];
    if (!e) return `No entry ${entry}: the brief has ${b.entries.length} entries.`;
    const page = e.text.slice(offset, offset + limit);
    return `### ${e.kind} (${entry}: ${LABEL[e.kind]}${e.ts ? `, ${e.ts}` : ''})\n${page}${offset + limit < e.text.length ? `\n[${e.text.length - offset - limit} more chars: call task_brief with {"entry": ${entry}, "offset": ${offset + limit}}]` : ''}`;
  }
  const full = fullText(b);
  if (!full) return 'No task brief recorded in this session.';
  const page = full.slice(offset, offset + limit);
  return `${page}${offset + limit < full.length ? `\n[${full.length - offset - limit} more chars: call task_brief with offset ${offset + limit}]` : ''}`;
}
