/**
 * Tab autocomplete with fill-in-the-middle models (SPEC B14, research ED §7).
 * Opt-in MVP: off by default and not registered at all when disabled.
 *
 * Pure: prompt builders, request bodies, post-processing and a debounced,
 * cancellable provider core with `fetch` and the registration API injected.
 */
import type { AutocompleteConfig, FimTemplate } from '../../src/core/host/vscode-contract.js';

export interface FimInput {
  prefix: string;
  suffix: string;
  /** workspace-relative path of the file */
  path?: string;
  /** other files as context (llama.cpp input_extra / Qwen file_sep) */
  extra?: { filename: string; text: string }[];
}

export const FIM_TOKENS: Record<Exclude<FimTemplate, 'suffix'>, { prefix: string; suffix: string; middle: string; stop: string[] }> = {
  qwen: { prefix: '<|fim_prefix|>', suffix: '<|fim_suffix|>', middle: '<|fim_middle|>', stop: ['<|endoftext|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|file_sep|>', '<|repo_name|>', '<|im_end|>'] },
  codestral: { prefix: '[PREFIX]', suffix: '[SUFFIX]', middle: '', stop: ['[PREFIX]', '[SUFFIX]', '</s>'] },
  deepseek: { prefix: '<｜fim▁begin｜>', suffix: '<｜fim▁hole｜>', middle: '<｜fim▁end｜>', stop: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<|EOT|>'] },
};

/** Raw FIM prompt for /completions. Qwen: <|fim_prefix|>…<|fim_suffix|>…<|fim_middle|>, with repo context as <|file_sep|> blocks. */
export function buildFimPrompt(template: Exclude<FimTemplate, 'suffix'>, i: FimInput): string {
  if (template === 'qwen') {
    const t = FIM_TOKENS.qwen;
    const ctx = i.extra?.length ? `<|repo_name|>workspace\n${i.extra.map((e) => `<|file_sep|>${e.filename}\n${e.text}\n`).join('')}<|file_sep|>${i.path ?? 'current'}\n` : '';
    return `${ctx}${t.prefix}${i.prefix}${t.suffix}${i.suffix}${t.middle}`;
  }
  if (template === 'codestral') return `[SUFFIX]${i.suffix}[PREFIX]${i.prefix}`;
  const t = FIM_TOKENS.deepseek;
  return `${t.prefix}${i.prefix}${t.suffix}${i.suffix}${t.middle}`;
}

/** llama.cpp server POST /infill body (the server applies the model's FIM template). */
export function buildInfillBody(i: FimInput, maxTokens: number): Record<string, unknown> {
  return {
    input_prefix: i.prefix,
    input_suffix: i.suffix,
    input_extra: (i.extra ?? []).map((e) => ({ filename: e.filename, text: e.text })),
    n_predict: maxTokens,
    temperature: 0.1,
    stream: false,
    cache_prompt: true,
  };
}

/** OpenAI-style POST /completions body. */
export function buildCompletionsBody(model: string, template: FimTemplate, i: FimInput, maxTokens: number): Record<string, unknown> {
  if (template === 'suffix') return { model, prompt: i.prefix, suffix: i.suffix, max_tokens: maxTokens, temperature: 0.1, stream: false };
  return { model, prompt: buildFimPrompt(template, i), max_tokens: maxTokens, temperature: 0.1, stream: false, stop: [...FIM_TOKENS[template].stop, '\n\n\n'] };
}

/** Endpoint URL from an OpenAI base URL (…/v1). llama.cpp's /infill lives at the server root. */
export function fimUrl(baseUrl: string, endpoint: AutocompleteConfig['endpoint']): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (endpoint === 'llama-infill') return `${b.replace(/\/v1$/, '')}/infill`;
  return `${b}/completions`;
}

/** Text of a /infill or /completions reply. */
export function parseFimReply(j: any): string {
  if (typeof j?.content === 'string') return j.content;
  const c = j?.choices?.[0];
  if (typeof c?.text === 'string') return c.text;
  if (typeof c?.message?.content === 'string') return c.message.content;
  return '';
}

/**
 * Trim a completion: strip FIM tokens, stop where it starts repeating the
 * suffix, and keep a single line unless the cursor sits on an empty line after
 * an opener (`{`, `:`, `(`), where a block is expected.
 */
export function postProcess(text: string, i: FimInput): string {
  let t = text;
  for (const tok of [...FIM_TOKENS.qwen.stop, ...FIM_TOKENS.codestral.stop, ...FIM_TOKENS.deepseek.stop]) {
    const k = t.indexOf(tok);
    if (k >= 0) t = t.slice(0, k);
  }
  const suffixHead = i.suffix.split('\n').find((l) => l.trim())?.trim();
  if (suffixHead && suffixHead.length > 3) {
    const k = t.indexOf(suffixHead);
    if (k > 0) t = t.slice(0, k);
  }
  const lineBefore = i.prefix.slice(i.prefix.lastIndexOf('\n') + 1);
  const prevLine = i.prefix.slice(0, Math.max(0, i.prefix.lastIndexOf('\n'))).split('\n').pop() ?? '';
  const multiline = !lineBefore.trim() && /[{:(\[]\s*$/.test(prevLine);
  if (!multiline) t = t.split('\n')[0];
  return t.trimEnd();
}

export interface CancelToken {
  isCancellationRequested: boolean;
  onCancellationRequested?(cb: () => void): { dispose(): void };
}

import type { AdmitHook } from '../../src/core/llm/admission.js';

export interface FimDeps {
  /** v1.1 R4: admission for each request (limits, reservation, ledger); refused → no request, '' (quiet) */
  admit?: AdmitHook;
  /** undefined while the (governed) config is not ready: no completion */
  config: () => (AutocompleteConfig & { baseUrl: string; model: string; apiKey?: string; headers?: Record<string, string> }) | undefined;
  fetch: typeof fetch;
  sleep?: (ms: number, token: CancelToken) => Promise<void>;
}

const defaultSleep = (ms: number, token: CancelToken) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    token.onCancellationRequested?.(() => {
      clearTimeout(t);
      r();
    });
  });

/** The text a /completions or /infill body sends to the model (prompt, suffix and repo-context blocks): what admission must count. */
export function requestPromptText(body: Record<string, unknown>): string {
  if (typeof body.prompt === 'string') return `${body.prompt}${typeof body.suffix === 'string' ? body.suffix : ''}`;
  const extra = Array.isArray(body.input_extra) ? (body.input_extra as { filename?: string; text?: string }[]).map((e) => `${e.filename ?? ''}\n${e.text ?? ''}\n`).join('') : '';
  return `${extra}${String(body.input_prefix ?? '')}${String(body.input_suffix ?? '')}`;
}

/** Debounced, cancellable completion. Returns '' when cancelled or nothing useful came back. */
export async function completeFim(deps: FimDeps, input: FimInput, token: CancelToken): Promise<string> {
  const c0 = deps.config();
  if (!c0) return '';
  const c = c0;
  await (deps.sleep ?? defaultSleep)(c.debounceMs, token);
  if (token.isCancellationRequested) return '';
  const ctl = new AbortController();
  const sub = token.onCancellationRequested?.(() => ctl.abort());
  let admitted: ReturnType<AdmitHook> | undefined;
  // sent and then cancelled / timed out: the server spent the prompt (batch 4 low)
  let inFlight = false;
  try {
    const body = c.endpoint === 'llama-infill' ? buildInfillBody(input, c.maxTokens) : buildCompletionsBody(c.model, c.template, input, c.maxTokens);
    // the whole request is counted, repo-context blocks included (batch 4 low)
    const ticket = deps.admit?.(requestPromptText(body), c.maxTokens, c.model);
    if (ticket && !ticket.ok) return ''; // budget exhausted: no suggestion, no noise
    admitted = ticket;
    inFlight = true;
    const res = await deps.fetch(fimUrl(c.baseUrl, c.endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}), ...(c.headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) {
      inFlight = false; // refused by the server: nothing to count
      return '';
    }
    const j = await res.json();
    const reply = parseFimReply(j);
    // the reply arrived: its usage counts even when the user typed on meanwhile
    if (admitted?.ok) admitted.done(j?.usage ? { promptTokens: Number(j.usage.prompt_tokens) || 0, completionTokens: Number(j.usage.completion_tokens) || 0 } : undefined, reply);
    admitted = undefined;
    if (token.isCancellationRequested) return '';
    return postProcess(reply, input);
  } catch (e) {
    // a network error before the server answered (connection refused …) spent nothing; an abort or timeout did
    if (!(ctl.signal.aborted || token.isCancellationRequested || (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError')) inFlight = false;
    return '';
  } finally {
    if (admitted?.ok) inFlight ? admitted.cancelled() : admitted.done();
    sub?.dispose();
  }
}

export interface LanguagesLike {
  registerInlineCompletionItemProvider(selector: unknown, provider: unknown): { dispose(): void };
}

/** Register the provider only when enabled (B14 AC2). Returns the registration or undefined. */
export function registerAutocomplete(languages: LanguagesLike, enabled: boolean, provider: unknown): { dispose(): void } | undefined {
  if (!enabled) return undefined;
  return languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider);
}
