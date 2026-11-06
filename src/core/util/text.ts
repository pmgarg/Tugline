import type { ChatMessage, ContentPart } from '../types.js';

/** Rough token estimate (no tokenizer dependency). ~3.6 chars/token for code+English. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function contentToText(c: string | ContentPart[] | null | undefined): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  return c.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

export function estimateMessagesTokens(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) {
    n += 4;
    n += estimateTokens(contentToText(m.content));
    if (Array.isArray(m.content)) n += m.content.filter((p) => p.type === 'image_url').length * 800;
    for (const tc of m.tool_calls ?? []) n += estimateTokens(tc.function.name + tc.function.arguments) + 6;
  }
  return n;
}

/**
 * Cap tool output. Keeps the head and the tail because for test runs and
 * compilers the summary is usually at the end and the cause near the start.
 */
export function capOutput(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… [${omitted} characters omitted to protect the context window] …\n\n${s.slice(-tail)}`;
}

/** Remove <think>…</think> blocks (Qwen3 / DeepSeek-R1 style) from visible text. */
export function splitThinking(text: string): { visible: string; thinking: string } {
  let thinking = '';
  let visible = text.replace(/<think>([\s\S]*?)<\/think>/g, (_m, t: string) => {
    thinking += t;
    return '';
  });
  // Unclosed <think> at the start (stream cut or template quirk)
  const open = visible.indexOf('<think>');
  if (open >= 0) {
    thinking += visible.slice(open + 7);
    visible = visible.slice(0, open);
  }
  // Some templates emit only the closing tag.
  const close = visible.indexOf('</think>');
  if (close >= 0) {
    thinking += visible.slice(0, close);
    visible = visible.slice(close + 8);
  }
  return { visible: visible.trim(), thinking: thinking.trim() };
}

export function truncateLine(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

export function shortId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9_-]{16,})\b/g,
  /\b(sk-or-v1-[A-Za-z0-9]{20,})\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g,
  /\b(AKIA[0-9A-Z]{16})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  /\b(AIza[0-9A-Za-z_-]{30,})\b/g,
  /\b(gsk_[A-Za-z0-9]{20,})\b/g,
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
];

/** Redact things that look like credentials before they reach logs/journals. */
export function redactSecrets(s: string, extra: string[] = []): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  for (const e of extra) if (e && e.length >= 8) out = out.split(e).join('[REDACTED]');
  return out;
}
