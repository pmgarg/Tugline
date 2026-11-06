/**
 * Text tool-calling protocol: for models/servers without native function calling.
 *
 * Many company deployments run an LLM behind a plain chat endpoint (older vLLM
 * without --enable-auto-tool-choice, TGI, custom gateways, base models). The
 * harness must still work there. We describe the tools in the system prompt and
 * ask for <tool_call>{json}</tool_call> blocks (the Hermes/Qwen convention most
 * open models were trained on), and we also accept the other formats open models
 * commonly emit: Qwen3-Coder XML (<function=name><parameter=k>v</parameter>),
 * fenced ```json {"name":..,"arguments":..}``` blocks and bare JSON objects.
 *
 * The transcript stays canonical (OpenAI shape); this module renders it into the
 * text dialect at request time and parses replies back into canonical calls.
 */
import type { ChatMessage, ToolSpec } from '../types.js';
import { contentToText } from '../util/text.js';
import { parseJsonLenient } from '../util/json.js';

export interface ParsedCall {
  name: string;
  argsRaw: string;
  args?: Record<string, unknown>;
  parseError?: string;
}

export function renderToolsForPrompt(tools: ToolSpec[]): string {
  const lines: string[] = [
    '# Tool calling protocol',
    'You can call tools. To call a tool, write a block exactly in this form (JSON inside the tags):',
    '<tool_call>',
    '{"name": "<tool name>", "arguments": { ...arguments as JSON... }}',
    '</tool_call>',
    'Rules:',
    '- You may write several <tool_call> blocks in one reply. Write them at the END of your reply.',
    '- After writing tool calls, STOP and wait. Results come back in <tool_result> blocks in the next message.',
    '- Arguments must be valid JSON: escape newlines inside strings as \\n and quotes as \\".',
    '- Never invent tool results. When the task is complete, reply normally with NO <tool_call> block.',
    '',
    '# Available tools',
  ];
  if (tools.some((t) => t.name === 'multi_edit')) lines.push(...EDIT_CHANNEL_DOC, '');
  for (const t of tools) {
    lines.push(`## ${t.name}`, t.description.trim(), `Parameters (JSON Schema): ${JSON.stringify(t.parameters)}`, '');
  }
  return lines.join('\n');
}

/** Convert canonical transcript into the text dialect. */
export function renderMessagesForTextMode(messages: ChatMessage[], tools: ToolSpec[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const toolBlock = tools.length ? renderToolsForPrompt(tools) : '';
  let pendingResults: string[] = [];
  const flush = () => {
    if (pendingResults.length) {
      const text = pendingResults.join('\n\n');
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        if (typeof prev.content === 'string') prev.content = `${prev.content}\n\n${text}`;
        else prev.content = [...(prev.content ?? []), { type: 'text', text }];
      } else out.push({ role: 'user', content: text });
      pendingResults = [];
    }
  };
  for (const m of messages) {
    if (m.role === 'tool') {
      pendingResults.push(`<tool_result name="${m.name ?? ''}" id="${m.tool_call_id ?? ''}">\n${contentToText(m.content)}\n</tool_result>`);
      continue;
    }
    flush();
    if (m.role === 'system') {
      out.push({ role: 'system', content: toolBlock ? `${contentToText(m.content)}\n\n${toolBlock}` : m.content });
    } else if (m.role === 'assistant') {
      let text = contentToText(m.content);
      for (const tc of m.tool_calls ?? []) {
        let args: unknown = {};
        const p = parseJsonLenient(tc.function.arguments);
        if (p.ok) args = p.value;
        const block = tc.function.name === 'multi_edit' ? renderEditBlock(args) : null;
        text += block ? `\n${block}` : `\n<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`;
      }
      out.push({ role: 'assistant', content: text.trim() });
    } else {
      // user: if the previous message is also user (e.g. tool results then a nudge) merge them
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user') {
        const toParts = (c: ChatMessage['content']) => (typeof c === 'string' ? [{ type: 'text' as const, text: c }] : (c ?? []));
        if (typeof prev.content === 'string' && typeof m.content === 'string') prev.content = `${prev.content}\n\n${m.content}`;
        else prev.content = [...toParts(prev.content), ...toParts(m.content)];
      } else {
        out.push({ role: 'user', content: m.content });
      }
    }
  }
  flush();
  return out;
}

function toCall(obj: unknown): ParsedCall | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const fn = (o.function && typeof o.function === 'object' ? (o.function as Record<string, unknown>) : null);
  const name = (o.name ?? o.tool ?? o.tool_name ?? fn?.name) as string | undefined;
  if (!name || typeof name !== 'string') return null;
  let args = o.arguments ?? o.args ?? o.parameters ?? o.input ?? fn?.arguments ?? {};
  if (typeof args === 'string') {
    const p = parseJsonLenient<Record<string, unknown>>(args);
    if (!p.ok) return { name, argsRaw: args, parseError: p.error };
    args = p.value ?? {};
  }
  return { name, argsRaw: JSON.stringify(args), args: args as Record<string, unknown> };
}

/**
 * Parse tool calls out of free text. Returns the calls plus the visible text with
 * the call blocks removed.
 */
export function parseToolCallsFromText(text: string, knownTools: string[] = []): { calls: ParsedCall[]; visible: string } {
  // 0. Raw-code edit channel: <edit path="…"> SEARCH/REPLACE blocks → multi_edit (SPEC A4)
  if (EDIT_OPEN_RE.test(text)) {
    const { calls: editCalls, rest } = parseEditBlocks(text);
    const others = rest.trim() ? parseToolCallsFromText(rest, knownTools) : { calls: [], visible: '' };
    return { calls: [...editCalls, ...others.calls], visible: others.visible };
  }
  const calls: ParsedCall[] = [];
  let visible = text;

  // 1. <tool_call> ... </tool_call>  (closing tag optional at the very end)
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g;
  if (/<tool_call>/.test(text)) {
    visible = text.replace(tagRe, (_m, body: string) => {
      const inner = body.trim();
      // Qwen3-Coder XML inside tool_call tags
      if (inner.startsWith('<function=')) {
        calls.push(...parseXmlFunctions(inner));
        return '';
      }
      const p = parseJsonLenient(inner);
      if (p.ok) {
        const arr = Array.isArray(p.value) ? p.value : [p.value];
        for (const item of arr) {
          const c = toCall(item);
          if (c) calls.push(c);
        }
        if (!arr.length) calls.push({ name: 'unknown', argsRaw: inner, parseError: 'empty tool_call block' });
      } else {
        const nameGuess = inner.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? 'unknown';
        calls.push({ name: nameGuess, argsRaw: inner, parseError: p.error });
      }
      return '';
    });
    return { calls, visible: visible.trim() };
  }

  // 2. Bare Qwen3-Coder XML function blocks
  if (/<function=[\w.-]+>/.test(text)) {
    const xmlCalls = parseXmlFunctions(text);
    if (xmlCalls.length) {
      visible = text.replace(/<function=[\w.-]+>[\s\S]*?(?:<\/function>|$)/g, '').trim();
      return { calls: xmlCalls, visible };
    }
  }

  // 3. Fenced JSON blocks that look like a tool call with a known tool name
  const fenceRe = /```(?:json|tool_call|tool)?\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  const fenced: { full: string; call: ParsedCall }[] = [];
  while ((m = fenceRe.exec(text))) {
    const p = parseJsonLenient(m[1]);
    if (!p.ok) continue;
    const arr = Array.isArray(p.value) ? p.value : [p.value];
    for (const item of arr) {
      const c = toCall(item);
      if (c && (knownTools.length === 0 || knownTools.includes(c.name))) fenced.push({ full: m[0], call: c });
    }
  }
  if (fenced.length) {
    for (const f of fenced) visible = visible.replace(f.full, '');
    return { calls: fenced.map((f) => f.call), visible: visible.trim() };
  }

  // 4. The whole reply is one JSON object naming a known tool
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const p = parseJsonLenient(trimmed);
    const c = p.ok ? toCall(p.value) : null;
    if (c && knownTools.includes(c.name)) return { calls: [c], visible: '' };
  }
  return { calls: [], visible: text.trim() };
}

function parseXmlFunctions(text: string): ParsedCall[] {
  const calls: ParsedCall[] = [];
  const fnRe = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(text))) {
    const name = fm[1];
    const body = fm[2];
    const args: Record<string, unknown> = {};
    const pRe = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRe.exec(body))) {
      const raw = pm[2];
      // Code-carrying parameters are always raw text: never JSON-parsed or unescaped (SPEC A4)
      if (RAW_PARAMS.has(pm[1])) {
        args[pm[1]] = raw;
        continue;
      }
      const asJson = parseJsonLenient(raw);
      // Keep strings as strings unless they clearly are JSON values
      args[pm[1]] = asJson.ok && !asJson.repaired && /^[\s]*[[{0-9tfn-]/.test(raw) && raw.trim() !== '' ? asJson.value : raw;
    }
    calls.push({ name, argsRaw: JSON.stringify(args), args });
  }
  return calls;
}

/** Quick heuristic: did a "native" reply leak a textual tool call? */
export function looksLikeTextToolCall(text: string): boolean {
  return /<tool_call>|<function=[\w.-]+>/.test(text) || EDIT_OPEN_RE.test(text);
}

// ------------------------------------------------------------ edit channel (WS1, SPEC A4)
//
// Code inside JSON tool arguments must be escaped (\n, \"), which is the hardest
// thing a small model is asked to produce (ED §2.8). In text mode the model can
// instead write an <edit> block whose SEARCH/REPLACE sections carry code
// verbatim. Each block becomes one canonical multi_edit call (or write_file for
// a single empty SEARCH), so permissions, hooks and checkpoints apply as usual.
// Nothing inside a block is ever unescaped.

/** Parameters that carry code; the Qwen-XML parser keeps them raw. */
const RAW_PARAMS = new Set(['old_string', 'new_string', 'content', 'input', 'patch']);

const EDIT_OPEN_RE = /<edit\b[^>\n]*>/;
const EDIT_BLOCK_RE = /<edit\b([^>\n]*)>([\s\S]*?)(<\/edit>|$)/g;
const SEARCH_RE = /^\s*(?:<{5,9}|-{5,9})\s*SEARCH\s*$/;
const DIVIDER_RE = /^\s*={5,9}\s*$/;
const REPLACE_RE = /^\s*(?:>{5,9}|\+{5,9})\s*REPLACE\s*$/;
const FENCE_RE = /^\s*```[\w-]*\s*$/;

export const EDIT_CHANNEL_DOC = [
  '# Editing files (preferred in this mode)',
  'To change a file, write an edit block instead of a JSON tool call. Everything between the markers is copied verbatim: do NOT escape quotes, backslashes or newlines.',
  '<edit path="src/app.py">',
  '<<<<<<< SEARCH',
  'exact existing lines, copied from read_file without the line numbers',
  '=======',
  'the new lines',
  '>>>>>>> REPLACE',
  '</edit>',
  '- One <edit> block per file; it may hold several SEARCH/REPLACE pairs, applied in order and atomically (it runs as the multi_edit tool).',
  '- SEARCH must match exactly one place: include 2-3 unchanged lines around the change. Marker lines must stand alone on their line.',
  '- To create a new file, leave the SEARCH section empty. You must read an existing file before editing it.',
  '- Edit blocks are tool calls: put them at the end of your reply (with any <tool_call> blocks) and wait for the result.',
];

function editError(path: string, message: string): ParsedCall {
  const args = { path, edits: [], edit_block_error: `${message} Expected format:\n${EDIT_CHANNEL_DOC.slice(2, 9).join('\n')}` };
  return { name: 'multi_edit', argsRaw: JSON.stringify(args), args };
}

/** Parse one <edit> block body into a canonical call. */
export function parseEditBlock(path: string, body: string, closed = true): ParsedCall {
  const where = path ? ` for ${path}` : '';
  if (!path) return editError('', `the <edit> block has no path attribute; write <edit path="relative/file">.`);
  if (!closed) return editError(path, `the <edit> block${where} is not closed with </edit> (the reply may have been cut off); nothing was changed.`);
  const lines = body.split('\n');
  const pairs: { search: string; replace: string }[] = [];
  let state: 'outside' | 'search' | 'replace' = 'outside';
  let s: string[] = [];
  let r: string[] = [];
  for (const line of lines) {
    const l = line.replace(/\r$/, '');
    if (state === 'outside') {
      if (SEARCH_RE.test(l)) {
        state = 'search';
        s = [];
      } else if (l.trim() === '' || FENCE_RE.test(l)) continue;
      else if (DIVIDER_RE.test(l) || REPLACE_RE.test(l)) return editError(path, `malformed edit block${where}: found "${l.trim()}" before a <<<<<<< SEARCH line (pair #${pairs.length + 1}); nothing was changed.`);
      else return editError(path, `malformed edit block${where}: unexpected text outside a SEARCH/REPLACE pair: "${l.trim().slice(0, 80)}"; nothing was changed.`);
    } else if (state === 'search') {
      if (DIVIDER_RE.test(l)) {
        state = 'replace';
        r = [];
      } else if (SEARCH_RE.test(l) || REPLACE_RE.test(l)) return editError(path, `malformed edit block${where}: pair #${pairs.length + 1} has no ======= line between SEARCH and REPLACE; nothing was changed.`);
      else s.push(line);
    } else {
      if (REPLACE_RE.test(l)) {
        pairs.push({ search: s.join('\n'), replace: r.join('\n') });
        state = 'outside';
      } else if (SEARCH_RE.test(l) || DIVIDER_RE.test(l)) return editError(path, `malformed edit block${where}: pair #${pairs.length + 1} is missing its >>>>>>> REPLACE line; nothing was changed.`);
      else r.push(line);
    }
  }
  if (state !== 'outside') return editError(path, `malformed edit block${where}: pair #${pairs.length + 1} is not finished (missing ${state === 'search' ? '=======' : '>>>>>>> REPLACE'}); nothing was changed.`);
  if (!pairs.length) return editError(path, `the edit block${where} contains no SEARCH/REPLACE pair; nothing was changed.`);
  if (pairs.length === 1 && pairs[0].search.trim() === '') {
    const content = pairs[0].replace ? pairs[0].replace + '\n' : '';
    const args = { path, content };
    return { name: 'write_file', argsRaw: JSON.stringify(args), args };
  }
  const empty = pairs.findIndex((p) => p.search.trim() === '');
  if (empty !== -1) return editError(path, `pair #${empty + 1} of the edit block${where} has an empty SEARCH section; only a block with a single pair may have an empty SEARCH (to create a file).`);
  const args = { path, edits: pairs.map((p) => ({ old_string: p.search, new_string: p.replace })) };
  return { name: 'multi_edit', argsRaw: JSON.stringify(args), args };
}

/** Extract every <edit> block; returns the calls and the text with the blocks removed. */
export function parseEditBlocks(text: string): { calls: ParsedCall[]; rest: string } {
  const calls: ParsedCall[] = [];
  const rest = text.replace(EDIT_BLOCK_RE, (_m, attrs: string, body: string, close: string) => {
    const path = /path\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/.exec(attrs);
    calls.push(parseEditBlock((path?.[1] ?? path?.[2] ?? path?.[3] ?? '').trim(), body, close === '</edit>'));
    return '';
  });
  return { calls, rest };
}

/** Render a canonical multi_edit call back as an <edit> block (text-mode history), when lossless. */
export function renderEditBlock(args: unknown): string | null {
  const a = args as { path?: unknown; edits?: unknown };
  if (typeof a?.path !== 'string' || !Array.isArray(a.edits) || !a.edits.length) return null;
  const parts: string[] = [`<edit path="${a.path}">`];
  for (const e of a.edits as Record<string, unknown>[]) {
    if (typeof e?.old_string !== 'string' || typeof e.new_string !== 'string' || e.replace_all || !e.old_string) return null;
    const all = `${e.old_string}\n${e.new_string}`.split('\n');
    if (all.some((l) => SEARCH_RE.test(l) || DIVIDER_RE.test(l) || REPLACE_RE.test(l) || /<\/edit>/.test(l))) return null;
    parts.push('<<<<<<< SEARCH', e.old_string, '=======', ...(e.new_string ? [e.new_string] : []), '>>>>>>> REPLACE');
  }
  parts.push('</edit>');
  return parts.join('\n');
}
