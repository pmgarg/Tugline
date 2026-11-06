/**
 * OpenAI-compatible chat client with dialect healing.
 *
 * One client talks to every OpenAI-compatible server (Ollama, LM Studio,
 * llama.cpp, vLLM, SGLang, TGI, LiteLLM, OpenRouter, Groq, Together, DeepSeek,
 * Nebius, company gateways...). Provider differences are healed here, at the
 * edge, so the agent loop never sees them (EAG Session 15: "provider-specific
 * syntax belongs inside the gateway"):
 *
 *  - servers that reject `stream_options`, `max_tokens` vs `max_completion_tokens`,
 *    `temperature`, or `tools` are retried with the offending field adapted;
 *  - models without native tools switch to the text protocol (toolMode=auto);
 *  - tool calls leaked as text in native mode are parsed anyway;
 *  - <think> blocks and `reasoning_content` are separated from visible text;
 *  - "HTTP 200 but empty because the reasoning ate max_tokens" is detected and
 *    reported instead of being treated as an answer (Session 15's billing bug);
 *  - tool-call ids are 9 alphanumeric chars (the strictest common format).
 */
import { admitCall, settleCall, withAdmissionScope, type AdmissionScope } from './admission.js';
import type { ChatMessage, ModelProfile, ToolSpec, Usage } from '../types.js';
import { parseJsonLenient } from '../util/json.js';
import { publishedPricing } from './pricing.js';
import { estimateMessagesTokens, estimateTokens, splitThinking } from '../util/text.js';
import { looksLikeTextToolCall, parseToolCallsFromText, renderMessagesForTextMode, type ParsedCall } from './textProtocol.js';
import { cacheBodyFields, cachedTokensFrom, looksLikeLlamaCpp, type CacheSlotRequest, type ServerKind } from './promptCache.js';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind: 'http' | 'network' | 'timeout' | 'context_overflow' | 'aborted' | 'auth' | 'rate_limit' | 'bad_request' | 'budget',
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
  }
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onTextDelta?: (t: string) => void;
  onReasoningDelta?: (t: string) => void;
  /** Disable streaming for this call. */
  noStream?: boolean;
  /** N10: who is calling, so llama.cpp pins a stable slot per agent (absent = the shared "aux" slot). */
  cacheSlot?: CacheSlotRequest;
}

export interface CompletionToolCall extends ParsedCall {
  id: string;
}

export interface CompletionResult {
  text: string;
  reasoning: string;
  toolCalls: CompletionToolCall[];
  finishReason: string;
  usage: Usage;
  latencyMs: number;
  dialect: 'native' | 'text';
  /** The visible reply was empty because generation was cut by max_tokens. */
  emptyDueToLength: boolean;
  /** Attempts made (retries + heals) */
  attempts: number;
  model: string;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function newToolCallId(): string {
  let s = '';
  for (let i = 0; i < 9; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
  return s;
}

interface Heals {
  noStreamOptions: boolean;
  useMaxCompletionTokens: boolean;
  noTemperature: boolean;
  noStream: boolean;
  /** N10: the server rejected `id_slot` (e.g. out of range); keep `cache_prompt` only. */
  noSlot?: boolean;
}

/**
 * Make a transcript acceptable to strict chat templates (Mistral, Gemma, some
 * llama.cpp jinja) and to OpenAI-style validators, whatever happened before
 * (compaction, aborts, nudges):
 *  - a tool message must answer a tool_call of the nearest preceding assistant;
 *    orphans become plain user text
 *  - every assistant tool_call gets a result (synthetic "not executed" if missing)
 *  - consecutive user messages are merged
 */
export function normalizeMessages(input: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let open = new Set<string>();
  const closeOpen = () => {
    for (const id of open) out.push({ role: 'tool', tool_call_id: id, name: '', content: 'Not executed (the run was interrupted).' });
    open = new Set();
  };
  for (const m0 of input) {
    const m: ChatMessage = { ...m0 };
    if (m.role === 'tool') {
      if (m.tool_call_id && open.has(m.tool_call_id)) {
        open.delete(m.tool_call_id);
        out.push(m);
      } else {
        m.role = 'user';
        m.content = `[earlier tool result${m.name ? ` from ${m.name}` : ''}]\n${typeof m.content === 'string' ? m.content : ''}`;
        delete m.tool_call_id;
        pushUser(out, m);
      }
      continue;
    }
    closeOpen();
    if (m.role === 'assistant' && m.tool_calls?.length) open = new Set(m.tool_calls.map((t) => t.id));
    if (m.role === 'user') pushUser(out, m);
    else out.push(m);
  }
  closeOpen();
  return out;
}

function pushUser(out: ChatMessage[], m: ChatMessage): void {
  const prev = out[out.length - 1];
  if (prev && prev.role === 'user') {
    const toParts = (c: ChatMessage['content']) => (typeof c === 'string' ? [{ type: 'text' as const, text: c }] : (c ?? []));
    if (typeof prev.content === 'string' && typeof m.content === 'string') prev.content = `${prev.content}\n\n${m.content}`;
    else prev.content = [...toParts(prev.content), ...toParts(m.content)];
    return;
  }
  out.push({ ...m });
}

export class LLMClient {
  /** Resolved dialect once auto-detection has decided. */
  private resolvedMode: 'native' | 'text' | null = null;
  private heals: Heals = { noStreamOptions: false, useMaxCompletionTokens: false, noTemperature: false, noStream: false };
  /** `system_fingerprint` of the last reply (Ollama answers "fp_ollama"): a passive server hint, no extra request. */
  systemFingerprint?: string;
  /** N10: server kind seen in a reply (llama.cpp `timings`), used when the profile/probe did not say. */
  detectedServer?: ServerKind;

  constructor(public profile: ModelProfile, private readonly log: (level: 'info' | 'warn', msg: string) => void = () => {}) {
    if (profile.toolMode === 'native' || profile.toolMode === 'text') this.resolvedMode = profile.toolMode;
  }

  /**
   * Adjust the profile in place (e.g. the context window and tool mode detected
   * from Ollama) without losing heals. The agent's budget reads `profile`, so a
   * smaller contextWindow takes effect at the next turn.
   */
  retune(patch: Partial<ModelProfile>): void {
    this.profile = { ...this.profile, ...patch };
    if (patch.toolMode === 'native' || patch.toolMode === 'text') this.resolvedMode = patch.toolMode;
  }

  get dialect(): 'native' | 'text' {
    return this.resolvedMode ?? 'native';
  }

  private url(): string {
    const base = this.profile.baseUrl.replace(/\/+$/, '');
    return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
    if (this.profile.apiKey) h.Authorization = `Bearer ${this.profile.apiKey}`;
    // OpenRouter attribution headers are harmless elsewhere
    h['HTTP-Referer'] = 'https://github.com/pmgarg/Tugline';
    h['X-Title'] = 'Tugline';
    return { ...h, ...(this.profile.headers ?? {}) };
  }

  /** List models (GET /models) — used by the setup UI to validate a connection. */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const base = this.profile.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    const res = await fetch(`${base}/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new LLMError(`GET /models failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 400), 'http', res.status);
    const j = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
    return (j.data?.map((d) => d.id) ?? j.models?.map((m) => m.name) ?? []).sort();
  }

  private buildBody(req: CompletionRequest, mode: 'native' | 'text'): Record<string, unknown> {
    const tools = req.tools ?? [];
    const normalized = normalizeMessages(req.messages);
    let messages: ChatMessage[];
    if (mode === 'text') messages = renderMessagesForTextMode(normalized, tools);
    else messages = normalized;
    const clean = messages.map((m) => {
      const o: Record<string, unknown> = { role: m.role, content: m.content ?? (m.role === 'assistant' ? '' : '') };
      if (m.tool_calls?.length) {
        o.tool_calls = m.tool_calls;
        if (o.content === '') o.content = null;
      }
      if (m.role === 'assistant' && mode === 'native' && m.reasoning_content) o.reasoning_content = m.reasoning_content;
      if (m.role === 'tool') {
        o.tool_call_id = m.tool_call_id;
        if (m.name) o.name = m.name;
      }
      return o;
    });
    const stream = !(req.noStream || this.heals.noStream);
    const body: Record<string, unknown> = { model: this.profile.model, messages: clean, stream };
    const maxTokens = req.maxTokens ?? this.profile.maxOutputTokens;
    if (maxTokens) body[this.heals.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
    const temp = req.temperature ?? this.profile.temperature;
    if (temp !== undefined && !this.heals.noTemperature) body.temperature = temp;
    if (stream && !this.heals.noStreamOptions) body.stream_options = { include_usage: true };
    if (mode === 'native' && tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (mode === 'text') body.stop = ['<tool_result', '</tool_call>\n\n<tool_result'];
    // N10: llama.cpp prompt cache and per-agent slot (user extraBody still wins)
    Object.assign(body, cacheBodyFields(this.profile, this.detectedServer, req.cacheSlot, !!this.heals.noSlot));
    return { ...body, ...(this.profile.extraBody ?? {}) };
  }

  /** Inspect a 4xx body and adapt. Returns true if a heal was applied (retry). */
  private heal(status: number, body: string, mode: 'native' | 'text'): 'retry' | 'switch_text' | 'overflow' | 'none' {
    const b = body.toLowerCase();
    if (/context length|context_length|maximum context|too many tokens|n_ctx|exceeds the (model'?s )?context|prompt is too long|input is too long|reduce the length/.test(b)) return 'overflow';
    if (b.includes('stream_options') && !this.heals.noStreamOptions) {
      this.heals.noStreamOptions = true;
      return 'retry';
    }
    if (b.includes('max_tokens') && /max_completion_tokens|not supported|unsupported/.test(b) && !this.heals.useMaxCompletionTokens) {
      this.heals.useMaxCompletionTokens = true;
      return 'retry';
    }
    if (b.includes('temperature') && /unsupported|not supported|does not support|only the default/.test(b) && !this.heals.noTemperature) {
      this.heals.noTemperature = true;
      return 'retry';
    }
    // Only switch dialect when the server says tools/functions are unsupported — not for
    // message-sequencing errors that merely mention "tool" (e.g. "role 'tool' must follow…").
    const sequencing = /role|tool_call_id|must be a response|must follow|preceding|messages\[/.test(b);
    if (mode === 'native' && this.profile.toolMode === 'auto' && !sequencing && /(does not support tools|tools? (is|are) not supported|tool use is not supported|not support (function|tool)|enable-auto-tool-choice|tool-call-parser|unsupported.{0,20}(tools|functions)|(tools|functions).{0,30}(unsupported|not allowed|unrecognized|unknown (field|parameter|argument))|extra (inputs|fields).{0,40}tools|unknown (field|parameter|argument).{0,20}tools)/.test(b)) {
      return 'switch_text';
    }
    // N10: a server that rejects the pinned slot (out of range, slots disabled) keeps working unpinned
    if (/id_slot|\bslot\b/.test(b) && !this.heals.noSlot && (this.profile.server ?? this.detectedServer) === 'llamacpp') {
      this.heals.noSlot = true;
      return 'retry';
    }
    if (/\bstream\b/.test(b) && /not supported|unsupported/.test(b) && !this.heals.noStream) {
      this.heals.noStream = true;
      return 'retry';
    }
    return 'none';
  }

  /**
   * v1.1 R4: every request goes through one admission point (llm/admission.ts): the C7 limits and the
   * enclosing run's budget are checked against the worst case before anything is sent (refused →
   * LLMError 'budget', no request), the worst case is reserved while the call is in flight, and the
   * actual usage is reconciled afterwards.
   */
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const ticket = admitCall(this.profile, req, (message) => {
      throw new LLMError(message, 'budget');
    });
    let result: CompletionResult | undefined;
    try {
      result = await this.send(req);
      return result;
    } finally {
      settleCall(ticket, result?.usage, result?.model ?? this.profile.model, this.profile);
    }
  }

  /**
   * v1.1 R4: `complete` inside an admission scope of the caller's choosing (IDE helpers without an agent).
   * Uses this module's admission point, so it works however the caller loaded the core.
   */
  completeIn(scope: AdmissionScope, req: CompletionRequest): Promise<CompletionResult> {
    return withAdmissionScope(scope, () => this.complete(req));
  }

  private async send(req: CompletionRequest): Promise<CompletionResult> {
    const started = Date.now();
    let attempts = 0;
    let transientRetries = 0;
    for (;;) {
      attempts++;
      const mode = this.dialect;
      const body = this.buildBody(req, mode);
      const timeout = this.profile.timeoutMs ?? 600_000;
      const signals = [AbortSignal.timeout(timeout)];
      if (req.signal) signals.push(req.signal);
      const signal = AbortSignal.any(signals);
      let res: Response;
      try {
        res = await fetch(this.url(), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal });
      } catch (e) {
        if (req.signal?.aborted) throw new LLMError('aborted', 'aborted');
        const err = e as Error;
        const isTimeout = err.name === 'TimeoutError';
        if (transientRetries < 3) {
          transientRetries++;
          this.log('warn', `LLM ${isTimeout ? 'timeout' : 'network error'} (${err.message}); retry ${transientRetries}/3`);
          await sleep(backoff(transientRetries), req.signal);
          continue;
        }
        throw new LLMError(`cannot reach ${this.url()}: ${err.message}`, isTimeout ? 'timeout' : 'network');
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (res.status === 401 || res.status === 403) throw new LLMError(`authentication failed (${res.status}): ${text.slice(0, 300)}`, 'auth', res.status, text);
        if (res.status === 429 || res.status >= 500) {
          if (transientRetries < 4) {
            transientRetries++;
            const ra = Number(res.headers.get('retry-after'));
            const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : backoff(transientRetries);
            this.log('warn', `LLM HTTP ${res.status}; retrying in ${Math.round(wait / 1000)}s (${transientRetries}/4)`);
            await sleep(wait, req.signal);
            continue;
          }
          throw new LLMError(`LLM HTTP ${res.status}: ${text.slice(0, 300)}`, res.status === 429 ? 'rate_limit' : 'http', res.status, text);
        }
        const h = this.heal(res.status, text, mode);
        if (h === 'overflow') throw new LLMError(`context window exceeded: ${text.slice(0, 300)}`, 'context_overflow', res.status, text);
        if (h === 'switch_text') {
          this.resolvedMode = 'text';
          this.log('info', 'Server/model has no native tool calling; switched to text tool protocol.');
          continue;
        }
        if (h === 'retry' && attempts < 8) {
          this.log('info', `healed request after HTTP ${res.status}: ${text.slice(0, 160)}`);
          continue;
        }
        throw new LLMError(`LLM HTTP ${res.status}: ${text.slice(0, 500)}`, 'bad_request', res.status, text);
      }

      const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      let raw: RawReply;
      try {
        raw = isStream ? await this.readStream(res, req) : await this.readJson(res, req);
      } catch (e) {
        const err = e as LLMError;
        if (err.kind === 'network' && transientRetries < 3) {
          transientRetries++;
          this.log('warn', `${err.message}; retrying the request (${transientRetries}/3)`);
          await sleep(backoff(transientRetries), req.signal);
          continue;
        }
        throw e;
      }
      const result = this.finish(raw, req, mode, started, attempts);
      // Auto mode: first successful native call with leaked text tool-calls → switch.
      if (this.profile.toolMode === 'auto' && this.resolvedMode === null) {
        this.resolvedMode = result.dialect === 'text' && raw.nativeCalls.length === 0 && (req.tools?.length ?? 0) > 0 ? 'text' : raw.nativeCalls.length ? 'native' : null;
        if (this.resolvedMode === 'text') this.log('info', 'Model emits tool calls as text; using text tool protocol.');
      }
      return result;
    }
  }

  private async readJson(res: Response, req: CompletionRequest): Promise<RawReply> {
    const j = (await res.json()) as any;
    if (j.error) throw new LLMError(`LLM error: ${JSON.stringify(j.error).slice(0, 300)}`, 'bad_request');
    if (typeof j.system_fingerprint === 'string') this.systemFingerprint = j.system_fingerprint;
    if (looksLikeLlamaCpp(j)) this.detectedServer ??= 'llamacpp';
    const choice = j.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const content: string = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
    const reasoning: string = msg.reasoning_content ?? msg.reasoning ?? '';
    if (content) req.onTextDelta?.(content);
    const nativeCalls = (msg.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name ?? '',
      args: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
    }));
    return { content, reasoning, nativeCalls, finishReason: choice.finish_reason ?? 'stop', usage: mapUsage(j.usage, j.timings) };
  }

  private async readStream(res: Response, req: CompletionRequest): Promise<RawReply> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    let finishReason = '';
    let usage: Usage | undefined;
    let timings: any;
    const calls = new Map<number, { id?: string; name: string; args: string }>();
    // Streamed <think> handling: route think content to reasoning, not text deltas.
    let inThink = false;
    let pendingTag = '';
    const emitText = (t: string) => {
      let s = pendingTag + t;
      pendingTag = '';
      while (s.length) {
        if (inThink) {
          const end = s.indexOf('</think>');
          if (end < 0) {
            const keep = partialSuffix(s, '</think>');
            req.onReasoningDelta?.(s.slice(0, s.length - keep));
            pendingTag = s.slice(s.length - keep);
            return;
          }
          req.onReasoningDelta?.(s.slice(0, end));
          s = s.slice(end + 8);
          inThink = false;
        } else {
          const start = s.indexOf('<think>');
          if (start < 0) {
            const keep = partialSuffix(s, '<think>');
            const out = s.slice(0, s.length - keep);
            if (out) req.onTextDelta?.(out);
            pendingTag = s.slice(s.length - keep);
            return;
          }
          if (start > 0) req.onTextDelta?.(s.slice(0, start));
          s = s.slice(start + 7);
          inThink = true;
        }
      }
    };
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (req.signal?.aborted) throw new LLMError('aborted', 'aborted');
        throw new LLMError(`stream interrupted: ${(e as Error).message}`, 'network');
      }
      const { value, done } = chunk;
      if (done) {
        if (buf.trim()) buf += '\n'; // process a final line that had no trailing newline
        else break;
      } else buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j: any;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new LLMError(`LLM stream error: ${JSON.stringify(j.error).slice(0, 300)}`, 'http');
        if (typeof j.system_fingerprint === 'string') this.systemFingerprint = j.system_fingerprint;
        if (looksLikeLlamaCpp(j)) {
          this.detectedServer ??= 'llamacpp';
          timings = j.timings;
        }
        if (j.usage) usage = mapUsage(j.usage, j.timings ?? timings);
        else if (timings && usage && usage.cachedTokens === undefined) usage = { ...usage, cachedTokens: cachedTokensFrom(undefined, timings, usage.promptTokens) };
        const choice = j.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? choice.message ?? {};
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === 'string' && r) {
          reasoning += r;
          req.onReasoningDelta?.(r);
        }
        if (typeof d.content === 'string' && d.content) {
          content += d.content;
          emitText(d.content);
        }
        for (const tc of d.tool_calls ?? []) {
          // Some servers omit `index`: a new id starts a new call, otherwise continue the last one.
          let i: number;
          if (typeof tc.index === 'number') i = tc.index;
          else {
            const lastIdx = calls.size ? Math.max(...calls.keys()) : -1;
            i = lastIdx < 0 || (tc.id && calls.get(lastIdx)?.id && calls.get(lastIdx)!.id !== tc.id) ? lastIdx + 1 : lastIdx;
          }
          const cur = calls.get(i) ?? { name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          // Some servers repeat the full name in every delta; others stream it in pieces.
          if (tc.function?.name && cur.name !== tc.function.name) cur.name = cur.name && tc.function.name.startsWith(cur.name) ? tc.function.name : cur.name + tc.function.name;
          const a = tc.function?.arguments;
          if (typeof a === 'string') cur.args += a;
          else if (a && typeof a === 'object') cur.args = JSON.stringify(a);
          calls.set(i, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (done) break;
    }
    if (pendingTag && !inThink) req.onTextDelta?.(pendingTag);
    const nativeCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, name: c.name, args: c.args }));
    return { content, reasoning, nativeCalls, finishReason: finishReason || 'stop', usage };
  }

  private finish(raw: RawReply, req: CompletionRequest, mode: 'native' | 'text', started: number, attempts: number): CompletionResult {
    const { visible: noThink, thinking } = splitThinking(raw.content);
    let reasoning = [raw.reasoning, thinking].filter(Boolean).join('\n');
    const known = (req.tools ?? []).map((t) => t.name);
    let toolCalls: CompletionToolCall[] = [];
    let text = noThink;
    let dialect: 'native' | 'text' = mode;
    if (raw.nativeCalls.length) {
      toolCalls = raw.nativeCalls.map((c) => {
        const p = parseJsonLenient<Record<string, unknown>>(c.args);
        return { id: c.id && /^[A-Za-z0-9_-]{1,64}$/.test(c.id) ? c.id : newToolCallId(), name: c.name, argsRaw: c.args, args: p.ok ? (p.value ?? {}) : undefined, parseError: p.ok ? undefined : p.error };
      });
    } else if (known.length && (mode === 'text' || looksLikeTextToolCall(noThink))) {
      const parsed = parseToolCallsFromText(noThink, known);
      if (parsed.calls.length) {
        toolCalls = parsed.calls.map((c) => ({ ...c, id: newToolCallId() }));
        text = parsed.visible;
        dialect = 'text';
      }
    }
    if (!reasoning) reasoning = '';
    // Output cut by max_tokens: arguments that needed repair are truncated, not malformed.
    // Executing them would write half a file (e.g. write_file with a cut-off body).
    if (raw.finishReason === 'length') {
      for (const c of toolCalls) {
        const strict = (() => {
          try {
            JSON.parse(c.argsRaw);
            return true;
          } catch {
            return false;
          }
        })();
        if (!strict || dialect === 'text') {
          c.args = undefined;
          c.parseError = 'the reply hit the output-token limit and the tool-call arguments were cut off. Re-send the call with less content (e.g. split a large file into a smaller write_file plus several edit_file calls)';
        }
      }
    }
    const usage: Usage = raw.usage ?? {
      promptTokens: estimateMessagesTokens(req.messages),
      completionTokens: estimateTokens(raw.content + raw.reasoning + raw.nativeCalls.map((c) => c.args).join('')),
      estimated: true,
    };
    const emptyDueToLength = raw.finishReason === 'length' && !text.trim() && toolCalls.length === 0;
    return { text, reasoning, toolCalls, finishReason: raw.finishReason, usage, latencyMs: Date.now() - started, dialect, emptyDueToLength, attempts, model: this.profile.model };
  }
}

interface RawReply {
  content: string;
  reasoning: string;
  nativeCalls: { id?: string; name: string; args: string }[];
  finishReason: string;
  usage?: Usage;
}

export function mapUsage(u: any, timings?: any): Usage | undefined {
  // llama.cpp without usage still reports timings (prompt_n = processed, cache_n = reused)
  if (!u && timings && typeof timings.prompt_n === 'number') u = { prompt_tokens: timings.prompt_n + (timings.cache_n ?? 0), completion_tokens: timings.predicted_n ?? 0 };
  if (!u) return undefined;
  const p = u.prompt_tokens ?? u.input_tokens;
  const c = u.completion_tokens ?? u.output_tokens;
  if (typeof p !== 'number' && typeof c !== 'number') return undefined;
  // N10: every server's spelling of "prompt tokens served from the cache" (undefined = not reported)
  return { promptTokens: p ?? 0, completionTokens: c ?? 0, cachedTokens: cachedTokensFrom(u, timings, p) };
}

function partialSuffix(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) return k;
  return 0;
}

function backoff(n: number): number {
  return Math.min(30_000, 1000 * 2 ** (n - 1)) + Math.floor(Math.random() * 400);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new LLMError('aborted', 'aborted'));
    }, { once: true });
  });
}

export function costOf(usage: Usage, profile: ModelProfile): number {
  // a configured price wins; otherwise the endpoint's published price (OpenRouter), else unknown (0)
  const pricing = profile.pricing ?? publishedPricing(profile);
  if (!pricing) return 0;
  return (usage.promptTokens * pricing.inputPerM + usage.completionTokens * pricing.outputPerM) / 1_000_000;
}
