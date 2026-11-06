/**
 * Context management.
 *
 * "Reading everything is filling" (EAG S17): the window is the budget. Two
 * stages, cheapest first:
 *   1. Clear old tool results (keep the most recent ones). The call stays in the
 *      transcript so the model knows it happened and can re-run it.
 *   2. Summarise the older part of the conversation with the (small) model into a
 *      structured hand-off note. The user's original request is carried VERBATIM
 *      (S17: a rewrite must never drop what the user said), along with files
 *      touched, decisions and the open task list.
 * If summarisation fails, a mechanical summary is used — compaction never
 * blocks a run.
 *
 * v1.0 (SPEC D8): the summary can be pre-built in the background (the agent
 * starts it at 60% of the budget over a span fingerprinted here); at the
 * threshold a still-valid precomputed summary is swapped in without another
 * blocking model call. `summarizeUpTo` and `/compact <instructions>` reuse the
 * same assembly. Messages after the cut are kept verbatim (the note is its own
 * user message; the client merges adjacent user turns at the edge).
 */
import crypto from 'node:crypto';
import type { ChatMessage, TodoItem, Usage } from '../types.js';
import type { LLMClient } from '../llm/client.js';
import { contentToText, estimateMessagesTokens, capOutput } from '../util/text.js';
import { briefFromMessages, renderBrief } from '../context/brief.js';

export const CLEARED_NOTE = '[earlier tool output cleared to save context — re-run the tool if you need it again]';

export function clearOldToolResults(messages: ChatMessage[], keepRecent = 6, minChars = 400): number {
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const clearable = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  let freed = 0;
  for (const i of clearable) {
    const m = messages[i];
    const text = contentToText(m.content);
    if (m._meta?.cleared || text.length < minChars) continue;
    freed += text.length;
    m.content = `${CLEARED_NOTE}\n(first line was: ${text.split('\n')[0].slice(0, 160)})`;
    m._meta = { ...(m._meta ?? {}), cleared: true };
  }
  return freed;
}

/** Index where the kept tail starts; never splits a tool result from its call. */
export function findCut(messages: ChatMessage[], tailTokenBudget: number): number {
  let tokens = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    tokens += estimateMessagesTokens([messages[i]]);
    if (tokens > tailTokenBudget) break;
    cut = i;
  }
  // Keep at least the last message, and never start the tail on a tool result:
  // walk BACK to the assistant message that issued the call so the pair stays together.
  cut = Math.min(cut, messages.length - 1);
  while (cut > 1 && messages[cut].role === 'tool') cut--;
  return cut;
}

const SUMMARY_PROMPT = `You are compressing an AI coding agent's working history so it can continue the task with less context.
Write a structured hand-off note in markdown with these sections:
## User requests
(Quote every user request VERBATIM, in order. Do not paraphrase.)
## Progress so far
(What was done: files read and changed with their paths and purpose, commands run and their outcomes, key facts discovered.)
## Decisions and constraints
## Errors and dead ends
(What failed and why, so it is not repeated.)
## Current state and next steps
Be specific (paths, function names, exact error messages). Max ~800 words.`;

export interface SummarizeOptions {
  signal?: AbortSignal;
  /** Extra focus from the user (/compact <instructions>) */
  instructions?: string;
  /** Called with the summariser's usage so it is metered (role "summarizer") */
  onUsage?: (usage: Usage, latencyMs: number, model: string) => void;
}

export async function summarize(llm: LLMClient, history: ChatMessage[], todos: TodoItem[], signalOrOpts?: AbortSignal | SummarizeOptions): Promise<string> {
  const o: SummarizeOptions = signalOrOpts && !(signalOrOpts instanceof AbortSignal) ? signalOrOpts : { signal: signalOrOpts as AbortSignal | undefined };
  const lines: string[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const text = contentToText(m.content);
    if (m.role === 'user') lines.push(`USER: ${capOutput(text, 6000)}`);
    else if (m.role === 'assistant') {
      if (text) lines.push(`ASSISTANT: ${capOutput(text, 3000)}`);
      for (const tc of m.tool_calls ?? []) lines.push(`TOOL CALL ${tc.function.name}: ${capOutput(tc.function.arguments, 600)}`);
    } else if (m.role === 'tool') lines.push(`TOOL RESULT (${m.name}): ${capOutput(text, 1500)}`);
  }
  const transcript = capOutput(lines.join('\n'), Math.max(8000, (llm.profile.contextWindow - 3000) * 3));
  const res = await llm.complete({
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: `Transcript to compress:\n\n${transcript}\n\nOpen task list: ${JSON.stringify(todos)}${o.instructions ? `\n\nThe user asks the summary to focus on: ${o.instructions}` : ''}` },
    ],
    maxTokens: 1500,
    signal: o.signal,
  });
  o.onUsage?.(res.usage, res.latencyMs, res.model);
  if (!res.text.trim()) throw new Error('empty summary');
  return res.text.trim();
}

export function mechanicalSummary(history: ChatMessage[]): string {
  const users = history.filter((m) => m.role === 'user' && !m._meta?.synthetic).map((m) => `> ${contentToText(m.content).slice(0, 2000)}`);
  const calls = history.flatMap((m) => m.tool_calls ?? []).map((tc) => `- ${tc.function.name} ${tc.function.arguments.slice(0, 160)}`);
  return `## User requests\n${users.join('\n')}\n## Tool calls made (results dropped)\n${calls.slice(-60).join('\n')}`;
}

export interface CompactResult {
  messages: ChatMessage[];
  before: number;
  after: number;
  strategy: string;
}

/** Stable fingerprint of a span: a precomputed summary is valid only while its span is unchanged. */
export function spanFingerprint(msgs: ChatMessage[]): string {
  const h = crypto.createHash('sha1');
  for (const m of msgs) h.update(JSON.stringify([m.role, m.content, m.tool_calls ?? null, m.tool_call_id ?? null])).update('\u0000');
  return h.digest('hex');
}

/**
 * Replace messages[1..cut) with a summary note; everything from `cut` on is kept verbatim.
 * v1.1 R5: the note always carries the task brief (the user's requests, verbatim and authoritative):
 * `brief` is the rendered brief the agent keeps outside the history; without one it is rebuilt from
 * the compacted span (its user messages and any brief an earlier note carried). There is no longer a
 * "the summary already contains the first 200 chars" shortcut: a constraint after that prefix was lost.
 */
export function assembleCompacted(msgs: ChatMessage[], cut: number, summary: string, brief?: string): ChatMessage[] {
  const head = msgs.slice(1, cut);
  const briefText = brief ?? renderBrief(briefFromMessages(head)).text;
  const note: ChatMessage = {
    role: 'user',
    content: `<conversation_summary>\nThe earlier part of this session was compacted to save context. Summary:\n\n${summary}\n</conversation_summary>\n${briefText ? `${briefText}\n` : ''}Continue the task from where it stopped.`,
    _meta: { compactedSummary: true, synthetic: true },
  };
  const first = msgs[0]?.role === 'system' ? [msgs[0]] : [];
  return [...first, note, ...msgs.slice(cut)];
}

/** Move a cut back so the kept tail never starts on a tool result (the call stays with its results). */
export function safeCut(messages: ChatMessage[], cut: number): number {
  let c = Math.max(1, Math.min(cut, messages.length));
  while (c > 1 && messages[c]?.role === 'tool') c--;
  return c;
}

export async function compact(opts: {
  messages: ChatMessage[];
  budgetTokens: number;
  llm: LLMClient;
  todos: TodoItem[];
  force?: boolean;
  signal?: AbortSignal;
  /** D8: a summary built in the background for messages[1..cut) (validated by the caller) */
  precomputed?: { cut: number; summary: string };
  instructions?: string;
  onUsage?: SummarizeOptions['onUsage'];
  /** R5: the rendered task brief, re-inserted after the summary */
  brief?: string;
}): Promise<CompactResult> {
  const msgs = opts.messages;
  const before = estimateMessagesTokens(msgs);
  if (!opts.force && before <= opts.budgetTokens) return { messages: msgs, before, after: before, strategy: 'none' };
  if (opts.precomputed && opts.precomputed.cut > 1 && opts.precomputed.cut < msgs.length) {
    const next = assembleCompacted(msgs, opts.precomputed.cut, opts.precomputed.summary, opts.brief);
    // still too big (a huge tail)? the cheap stage runs on the tail too
    if (estimateMessagesTokens(next) > opts.budgetTokens) clearOldToolResults(next);
    return { messages: next, before, after: estimateMessagesTokens(next), strategy: 'precomputed-summary' };
  }
  clearOldToolResults(msgs);
  let after = estimateMessagesTokens(msgs);
  if (!opts.force && after <= opts.budgetTokens * 0.85) return { messages: msgs, before, after, strategy: 'clear-tool-results' };
  const cut = findCut(msgs, Math.floor(opts.budgetTokens * 0.35));
  if (cut <= 1) return { messages: msgs, before, after, strategy: 'clear-tool-results' };
  const head = msgs.slice(1, cut);
  let summary: string;
  let strategy = 'summarize';
  try {
    summary = await summarize(opts.llm, head, opts.todos, { signal: opts.signal, instructions: opts.instructions, onUsage: opts.onUsage });
  } catch {
    summary = mechanicalSummary(head);
    strategy = 'mechanical-summary';
  }
  const next = assembleCompacted(msgs, cut, summary, opts.brief);
  // If a single huge tool result still overflows, cap it (the call stays; the model can re-run it narrower).
  const maxChars = Math.floor(opts.budgetTokens * 3.6 * 0.4);
  for (const m of next) if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > maxChars) m.content = capOutput(m.content, maxChars);
  after = estimateMessagesTokens(next);
  return { messages: next, before, after, strategy };
}
