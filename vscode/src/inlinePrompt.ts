/**
 * Inline edit on a selection (SPEC B3, research ED §3.1): prompt builder and
 * lenient reply parser. Pure (no `vscode`), unit-tested.
 *
 * The selection is dedented before it is sent and the reply is re-indented with
 * the selection's base indentation, which removes most indentation mistakes of
 * small models. Parts are wrapped in markers the model cannot confuse with code;
 * the answer is expected inside <replacement>…</replacement>, with fallbacks for
 * fenced and plain replies and for English chatter around the code.
 */
import type { ChatMessage } from '../../src/core/types.js';

export interface InlineEditRequest {
  path: string;
  language: string;
  /** Text before the selection (whole lines). Only the last `maxPrefixLines` are sent. */
  prefix: string;
  /** The selected lines (may be '' for an insertion). */
  selection: string;
  /** Text after the selection. Only the first `maxSuffixLines` are sent. */
  suffix: string;
  instruction: string;
  /** Errors/warnings in or near the selection, one per line. */
  diagnostics?: string[];
  maxPrefixLines?: number;
  maxSuffixLines?: number;
}

export const MAX_PREFIX_LINES = 150;
export const MAX_SUFFIX_LINES = 60;

const lineBreak = (s: string) => (s.includes('\r\n') ? '\r\n' : '\n');

function lines(s: string): string[] {
  if (!s) return [];
  const out = s.split(/\r?\n/);
  if (out[out.length - 1] === '') out.pop();
  return out;
}

/** Leading whitespace of a line. */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/** Longest common leading whitespace of the non-blank lines. */
export function commonIndent(text: string): string {
  let common: string | undefined;
  for (const l of lines(text)) {
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (common === undefined) common = ind;
    else {
      let i = 0;
      while (i < common.length && i < ind.length && common[i] === ind[i]) i++;
      common = common.slice(0, i);
    }
  }
  return common ?? '';
}

export function dedent(text: string): { text: string; indent: string } {
  const indent = commonIndent(text);
  if (!indent) return { text, indent };
  const nl = lineBreak(text);
  const out = lines(text).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()));
  return { text: out.join(nl) + (/\r?\n$/.test(text) ? nl : ''), indent };
}

/**
 * Put the selection's base indentation back. If the model already indented its
 * reply at (or beyond) the base level, it is left alone.
 */
export function reindent(reply: string, indent: string): string {
  if (!indent) return reply;
  const ls = lines(reply);
  const nonBlank = ls.filter((l) => l.trim());
  if (nonBlank.length && nonBlank.every((l) => l.startsWith(indent))) return reply;
  const base = commonIndent(reply);
  return ls.map((l) => (l.trim() ? indent + (l.startsWith(base) ? l.slice(base.length) : l.trimStart()) : '')).join('\n') + (/\n$/.test(reply) ? '\n' : '');
}

export function buildInlineEditPrompt(r: InlineEditRequest): ChatMessage[] {
  const pre = lines(r.prefix).slice(-(r.maxPrefixLines ?? MAX_PREFIX_LINES)).join('\n');
  const suf = lines(r.suffix).slice(0, r.maxSuffixLines ?? MAX_SUFFIX_LINES).join('\n');
  const sel = dedent(r.selection).text.replace(/\r\n/g, '\n');
  const insertion = !r.selection.trim();
  const system =
    'You are a precise code editor inside an IDE. You rewrite one region of a file as instructed. ' +
    'Reply with the new code for the region ONLY, inside <replacement></replacement>. No explanations, no markdown fences, no line numbers. ' +
    'Keep the code style of the file. Do not repeat the prefix or the suffix. The selection was dedented; write it at the same (zero) base indentation.';
  const user = [
    `<file path="${r.path}" language="${r.language}">`,
    `<prefix>\n${pre}\n</prefix>`,
    insertion ? '<selection>\n[INSERT HERE]\n</selection>' : `<selection>\n${sel.replace(/\n$/, '')}\n</selection>`,
    `<suffix>\n${suf}\n</suffix>`,
    '</file>',
    r.diagnostics?.length ? `<diagnostics>\n${r.diagnostics.slice(0, 20).join('\n')}\n</diagnostics>` : '',
    `<instruction>\n${r.instruction.trim()}\n</instruction>`,
    insertion ? 'Write the code to insert at [INSERT HERE], inside <replacement></replacement>.' : 'Rewrite the selection as instructed. Answer with the complete replacement for the selection inside <replacement></replacement>.',
  ]
    .filter(Boolean)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

const ENGLISH = /^(here('s| is)|sure|certainly|of course|okay|ok[,.!]|i('ve| have| will|'ll)|this (code|version|change)|the (code|updated|following|above)|below is|note:|explanation:|changes?:|i renamed|i changed|i added|i updated)/i;

function stripFences(t: string): string {
  const m = t.match(/```[^\n]*\n([\s\S]*?)\n?```/);
  return m ? m[1] : t;
}

/** Drop chatter lines at the start and end ("Here is the updated code:", "This renames x to y."). */
function filterEnglish(ls: string[]): string[] {
  let s = 0;
  let e = ls.length;
  while (s < e && (ENGLISH.test(ls[s].trim()) || (!ls[s].trim() && s === 0))) s++;
  while (e > s && (ENGLISH.test(ls[e - 1].trim()) || !ls[e - 1].trim())) e--;
  return ls.slice(s, e);
}

/**
 * Extract the replacement from a model reply. Order: <replacement> tags →
 * fenced block → the whole reply; then chatter lines at either end are dropped.
 * Returns undefined when nothing usable is left.
 */
export function parseReplacement(reply: string): string | undefined {
  let t = reply.replace(/<think>[\s\S]*?<\/think>/g, '');
  const tag = t.match(/<replacement>\n?([\s\S]*?)\n?<\/replacement>/);
  if (tag) t = tag[1];
  else {
    const open = t.indexOf('<replacement>');
    if (open >= 0) t = t.slice(open + '<replacement>'.length).replace(/^\n/, '');
    t = stripFences(t);
  }
  if (tag && /```/.test(t)) t = stripFences(t);
  const ls = filterEnglish(t.replace(/\r\n/g, '\n').split('\n')).map((l) => l.replace(/[ \t]+$/, ''));
  if (!ls.length) return tag ? '' : undefined;
  return ls.join('\n');
}

/**
 * The text that replaces the selection: parsed, re-indented, with the
 * selection's line ending style and trailing newline.
 */
export function buildReplacement(reply: string, selection: string): string | undefined {
  const parsed = parseReplacement(reply);
  if (parsed === undefined) return undefined;
  const { indent } = dedent(selection);
  const nl = lineBreak(selection);
  let out = reindent(parsed, indent);
  if (nl === '\r\n') out = out.replace(/\r?\n/g, '\r\n');
  const trailing = /\r?\n$/.test(selection);
  if (trailing && out && !out.endsWith(nl)) out += nl;
  if (!trailing) out = out.replace(/\r?\n$/, '');
  return out;
}
