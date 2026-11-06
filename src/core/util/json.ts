/**
 * Lenient JSON parsing for tool-call arguments.
 *
 * Open-weight models (and some OpenAI-compatible servers) frequently emit
 * almost-JSON: code fences, trailing commas, single quotes, raw newlines inside
 * strings, Python literals, or a truncated closing brace. A harness that rejects
 * these wastes a whole turn; one that silently guesses corrupts the call. We
 * repair only well-understood, lossless defects and report everything else back
 * to the model as an error it can fix.
 */

export function stripCodeFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```(?:json|JSON|javascript|js)?\s*\n?([\s\S]*?)\n?```$/);
  return m ? m[1].trim() : t;
}

/** Escape raw control characters that appear inside JSON string literals. */
function escapeControlCharsInStrings(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/** Close unbalanced brackets/braces/strings at the end (truncated output). */
function closeUnbalanced(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length) stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  while (stack.length) out += stack.pop();
  return out;
}

export interface LenientResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  repaired?: boolean;
}

export function parseJsonLenient<T = unknown>(input: string | null | undefined): LenientResult<T> {
  if (input == null) return { ok: true, value: {} as T };
  const raw = String(input).trim();
  if (raw === '') return { ok: true, value: {} as T };
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    /* fall through to repairs */
  }
  const attempts: ((s: string) => string)[] = [
    stripCodeFences,
    (s) => s.replace(/,\s*([}\]])/g, '$1'),
    escapeControlCharsInStrings,
    (s) => s.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null'),
    closeUnbalanced,
  ];
  let cur = raw;
  for (const fix of attempts) {
    cur = fix(cur);
    try {
      return { ok: true, value: JSON.parse(cur) as T, repaired: true };
    } catch {
      /* keep going */
    }
  }
  // Last resort: single-quoted JSON (only if there are no double quotes at all).
  if (!cur.includes('"') && cur.includes("'")) {
    try {
      return { ok: true, value: JSON.parse(cur.replace(/'/g, '"')) as T, repaired: true };
    } catch {
      /* ignore */
    }
  }
  // Extract the first {...} object if the model wrapped JSON in prose.
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first && (first > 0 || last < raw.length - 1)) {
    const inner = parseJsonLenient<T>(raw.slice(first, last + 1));
    if (inner.ok) return { ...inner, repaired: true };
  }
  return { ok: false, error: `could not parse arguments as JSON: ${raw.slice(0, 200)}` };
}

export function safeStringify(v: unknown, max = 100_000): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + '…' : s;
}
