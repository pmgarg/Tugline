/**
 * Next-edit suggestions with an open model (v1.1 N15), pure part: the recent
 * edit history, the prompt (Zeta format), the reply parser, the edit the reply
 * implies, and the request with its latency budget. No `vscode` import.
 *
 * Model: Zed's Zeta (`zed-industries/zeta`, a Qwen2.5-Coder-7B fine-tune;
 * Apache-2.0 on its model card, training data Apache-2.0 too), served by
 * vLLM or llama.cpp on an OpenAI-style `/v1/completions` endpoint. Any model
 * trained on the same format works.
 *
 * Prompt (Zeta): an instruction, the user's recent edits as small diffs, and an
 * excerpt of the current file where an editable region is marked with
 * `<|editable_region_start|>` / `<|editable_region_end|>` and the cursor with
 * `<|user_cursor_is_here|>`. The model answers with the excerpt, the region
 * rewritten; the difference between the old and new region is the suggestion.
 * It may be away from the cursor (a "jump").
 */
import type { AdmitHook } from '../../src/core/llm/admission.js';

export const ZETA = {
  regionStart: '<|editable_region_start|>',
  regionEnd: '<|editable_region_end|>',
  cursor: '<|user_cursor_is_here|>',
  startOfFile: '<|start_of_file|>',
};

const INSTRUCTION =
  'You are a code completion assistant and your task is to analyze user edits and then rewrite an excerpt that the user provides, suggesting the appropriate edits within the excerpt, taking into account the cursor location.';

export interface EditEvent {
  path: string;
  /** 1-based first line of the change */
  line: number;
  /** the changed lines before and after the edit (whole lines, no trailing newline) */
  removed: string;
  added: string;
}

/** Recent edits, newest last. Edits that stay on the same single line of a file are merged (typing a word is one event). */
export class EditHistory {
  readonly events: EditEvent[] = [];
  constructor(private max = 8) {}

  record(e: EditEvent): void {
    if (e.removed === e.added) return;
    const last = this.events[this.events.length - 1];
    const single = (x: EditEvent) => !x.removed.includes('\n') && !x.added.includes('\n');
    if (last && last.path === e.path && last.line === e.line && single(last) && single(e)) {
      last.added = e.added;
      if (last.added === last.removed) this.events.pop();
      return;
    }
    this.events.push({ ...e });
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
  }
}

/** One edit as Zeta's "User edited" block. */
export function formatEvent(e: EditEvent): string {
  const minus = e.removed !== '' ? e.removed.split('\n').map((l) => `-${l}`) : [];
  const plus = e.added !== '' ? e.added.split('\n').map((l) => `+${l}`) : [];
  return `User edited "${e.path}":\n\`\`\`diff\n@@ -${e.line},${minus.length} +${e.line},${plus.length} @@\n${[...minus, ...plus].join('\n')}\n\`\`\``;
}

export interface ZetaInput {
  path: string;
  text: string;
  /** cursor offset in `text` */
  cursor: number;
  events: EditEvent[];
  /** lines of the editable region before / after the cursor line */
  regionBefore?: number;
  regionAfter?: number;
  /** extra context lines outside the region */
  context?: number;
  /** cap for the edit history part (chars) */
  maxEventChars?: number;
}

export interface ZetaPrompt {
  prompt: string;
  /** offsets of the editable region in the document */
  regionStart: number;
  regionEnd: number;
  /** the region's text (without markers) */
  region: string;
}

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

export function buildZetaPrompt(i: ZetaInput): ZetaPrompt {
  const starts = lineStarts(i.text);
  const lineOf = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const cur = Math.max(0, Math.min(i.cursor, i.text.length));
  const cl = lineOf(cur);
  const last = starts.length - 1;
  const rFrom = Math.max(0, cl - (i.regionBefore ?? 3));
  const rTo = Math.min(last, cl + (i.regionAfter ?? 8));
  const ctx = i.context ?? 20;
  const cFrom = Math.max(0, rFrom - ctx);
  const cTo = Math.min(last, rTo + ctx);
  const off = (line: number) => starts[line];
  const endOf = (line: number) => (line + 1 < starts.length ? starts[line + 1] : i.text.length);
  const regionStart = off(rFrom);
  const regionEnd = endOf(rTo);
  const region = i.text.slice(regionStart, regionEnd);
  const before = i.text.slice(off(cFrom), regionStart);
  const after = i.text.slice(regionEnd, endOf(cTo));
  const inRegion = region.slice(0, cur - regionStart) + ZETA.cursor + region.slice(cur - regionStart);
  const excerpt = `\`\`\`${i.path}\n${cFrom === 0 ? `${ZETA.startOfFile}\n` : ''}${before}${ZETA.regionStart}\n${inRegion}${inRegion.endsWith('\n') || !inRegion ? '' : '\n'}${ZETA.regionEnd}\n${after}${after && !after.endsWith('\n') ? '\n' : ''}\`\`\``;
  let events = '';
  const cap = i.maxEventChars ?? 3000;
  for (const e of [...i.events].reverse()) {
    const block = formatEvent(e);
    if (events.length + block.length > cap) break;
    events = events ? `${block}\n\n${events}` : block;
  }
  const prompt = `### Instruction:\n${INSTRUCTION}\n\n### User Edits:\n\n${events}\n\n### User Excerpt:\n\n${excerpt}\n\n### Response:\n`;
  return { prompt, regionStart, regionEnd, region };
}

/**
 * The rewritten region from a Zeta reply, or undefined when the reply has no
 * usable region. The reply repeats the excerpt; only the part between the
 * region markers counts (a reply cut by a `<|editable_region_end|>` stop
 * sequence is accepted). The cursor marker is dropped.
 */
export function parseZetaReply(reply: string, oldRegion: string): string | undefined {
  const s = reply.indexOf(ZETA.regionStart);
  if (s < 0) return undefined;
  let body = reply.slice(s + ZETA.regionStart.length);
  const e = body.indexOf(ZETA.regionEnd);
  if (e >= 0) body = body.slice(0, e);
  else body = body.replace(/\n?```\s*$/, '');
  if (body.startsWith('\n')) body = body.slice(1);
  body = body.split(ZETA.cursor).join('');
  // the prompt put the end marker on its own line: the region keeps its trailing newline
  if (oldRegion.endsWith('\n') && !body.endsWith('\n')) body += '\n';
  if (!oldRegion.endsWith('\n') && body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}

export interface TextEdit {
  /** offsets in the document */
  start: number;
  end: number;
  text: string;
}

/** The smallest single replacement turning `oldRegion` into `newRegion`, in document offsets; undefined when equal. */
export function regionEdit(regionStart: number, oldRegion: string, newRegion: string): TextEdit | undefined {
  if (oldRegion === newRegion) return undefined;
  let p = 0;
  while (p < oldRegion.length && p < newRegion.length && oldRegion[p] === newRegion[p]) p++;
  let q = 0;
  while (q < oldRegion.length - p && q < newRegion.length - p && oldRegion[oldRegion.length - 1 - q] === newRegion[newRegion.length - 1 - q]) q++;
  return { start: regionStart + p, end: regionStart + oldRegion.length - q, text: newRegion.slice(p, newRegion.length - q) };
}

/** Whether a suggestion is far enough from the cursor to need a jump first (another line, beyond the next one). */
export function needsJump(text: string, cursor: number, edit: TextEdit): boolean {
  const lineAt = (o: number) => text.slice(0, o).split('\n').length - 1;
  const d = lineAt(edit.start) - lineAt(cursor);
  return d < 0 || d > 1;
}

export interface NesRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens: number;
  /** cancel when the model has not answered within this budget */
  latencyMs: number;
  /** v1.1 R4: admission for each request (limits, reservation, ledger); refused → reason 'budget', nothing sent */
  admit?: AdmitHook;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface NesOutcome {
  edit?: TextEdit;
  /** why there is no suggestion */
  reason?: 'cancelled' | 'timeout' | 'http' | 'no-region' | 'no-change' | 'error' | 'budget';
  ms: number;
}

/**
 * Ask the model for the next edit. Resolves `{reason:'timeout'}` once the
 * latency budget is spent (the request is aborted), `{reason:'cancelled'}`
 * when the caller's signal fires (the user typed on).
 */
export async function requestNextEdit(fetchFn: FetchLike, r: NesRequest, p: ZetaPrompt, signal?: AbortSignal): Promise<NesOutcome> {
  const t0 = Date.now();
  const ticket = r.admit?.(p.prompt, r.maxTokens, r.model);
  if (ticket && !ticket.ok) return { reason: 'budget', ms: 0 };
  let settled = false;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, r.latencyMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const url = `${r.baseUrl.replace(/\/+$/, '')}/completions`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(r.apiKey ? { Authorization: `Bearer ${r.apiKey}` } : {}), ...(r.headers ?? {}) },
      body: JSON.stringify({ model: r.model, prompt: p.prompt, max_tokens: r.maxTokens, temperature: 0, stop: [ZETA.regionEnd], stream: false }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      if (ticket?.ok) ticket.done(); // refused by the server: nothing to count
      settled = true;
      return { reason: 'http', ms: Date.now() - t0 };
    }
    const j = await res.json();
    const text: string = j?.choices?.[0]?.text ?? j?.content ?? '';
    if (ticket?.ok) ticket.done(j?.usage ? { promptTokens: Number(j.usage.prompt_tokens) || 0, completionTokens: Number(j.usage.completion_tokens) || 0 } : undefined, text);
    settled = true;
    const region = parseZetaReply(text, p.region);
    if (region === undefined) return { reason: 'no-region', ms: Date.now() - t0 };
    const edit = regionEdit(p.regionStart, p.region, region);
    return edit ? { edit, ms: Date.now() - t0 } : { reason: 'no-change', ms: Date.now() - t0 };
  } catch (e) {
    // cancelled or timed out in flight: the server spent the prompt (batch 4 low); a plain network error spent nothing
    if (ticket?.ok && !settled) {
      if (timedOut || ctl.signal.aborted || signal?.aborted || (e as Error)?.name === 'AbortError') ticket.cancelled();
      else ticket.done();
      settled = true;
    }
    return { reason: timedOut ? 'timeout' : signal?.aborted ? 'cancelled' : 'error', ms: Date.now() - t0 };
  } finally {
    if (ticket?.ok && !settled) ticket.done();
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
