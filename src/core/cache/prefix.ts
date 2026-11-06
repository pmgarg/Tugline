/**
 * Stable-prefix guard (v1.1 N10).
 *
 * Prefix caches (llama.cpp `cache_prompt`, vLLM APC, SGLang) reuse a request
 * only up to the first token that differs from the previous one. The order is
 * [model] → system prompt → tool schemas (rendered into the system turn by
 * most chat templates) → history, so a change early in that order re-processes
 * everything after it. Two parts:
 *
 * 1. **Detection.** Before each turn the guard snapshots the model, the system
 *    prompt (split into its sections), the tool list and a hash per history
 *    message, and compares with the previous turn of the same agent. Any
 *    difference emits one `cache_break` event naming its causes: `mode`,
 *    `memory` (project instructions), `overlay` (model notes), `skills`,
 *    `environment`, `tools added/removed`, `tool order`, `tool schema`,
 *    `compaction`, `history rewrite`, `model`… A normal loop (append-only
 *    history, same prompt and tools) produces none.
 *
 * 2. **Prevention.** The system prompt is rebuilt at the start of every run
 *    (memory or mode may have changed), but its Environment section carries
 *    volatile lines: the date and the git status, which change whenever the
 *    agent edits a file. Rebuilding it would re-process the whole conversation
 *    on every new prompt. `stabilizeSystemPrompt` keeps the previous system
 *    prompt byte-identical when only those lines differ and returns the fresh
 *    lines as an `<environment_update>` note that rides on the user's message
 *    (history is append-only, so the cache stays valid). Any other change
 *    (memory, mode, skills, overlay…) uses the fresh prompt and is reported.
 */
import crypto from 'node:crypto';
import type { ChatMessage, ToolSpec } from '../types.js';
import { contentToText, estimateMessagesTokens, estimateTokens } from '../util/text.js';

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

// ------------------------------------------------------------ system prompt sections

const MODE_LINE = /\n\nPermission mode: [^\n]*$/;

const SECTION_CAUSE: [RegExp, string][] = [
  [/^# (How to work|Rules)\b/, 'rules'],
  [/^# Environment\b/, 'environment'],
  [/^# Model notes\b/, 'overlay'],
  [/^# Project instructions\b/, 'memory'],
  [/^# Available skills\b/, 'skills'],
  [/^# Custom subagent types\b/, 'subagents'],
  [/^# Deferred tools\b/, 'deferred tools'],
  [/^# (Output style|Style)\b/i, 'output style'],
];

/** The system prompt as named sections (prompt.ts joins parts with blank lines; each part after the role starts with "# "). */
export function systemSections(system: string): Map<string, string> {
  const out = new Map<string, string>();
  let body = system;
  const mode = body.match(MODE_LINE);
  if (mode) {
    out.set('mode', mode[0].trim());
    body = body.slice(0, mode.index);
  }
  const parts = body.split(/\n\n(?=# )/);
  out.set('role', parts[0] ?? '');
  for (const p of parts.slice(1)) {
    const heading = p.split('\n', 1)[0];
    let name = SECTION_CAUSE.find(([re]) => re.test(heading))?.[1] ?? heading.replace(/^#\s*/, '').toLowerCase().slice(0, 40);
    while (out.has(name)) name += "'";
    out.set(name, p);
  }
  return out;
}

// ------------------------------------------------------------ snapshots and diffs

export interface PrefixSnapshot {
  model: string;
  system: string;
  sections: Map<string, string>;
  tools: { name: string; hash: string }[];
  history: string[];
}

export function messageHash(m: ChatMessage): string {
  return sha(JSON.stringify([m.role, m.content, m.tool_calls ?? null, m.tool_call_id ?? null, m.name ?? null, m.reasoning_content ?? null]));
}

export function takeSnapshot(model: string, messages: ChatMessage[], tools: ToolSpec[]): PrefixSnapshot {
  const system = messages[0]?.role === 'system' ? contentToText(messages[0].content) : '';
  const hist = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  return {
    model,
    system,
    sections: systemSections(system),
    tools: tools.map((t) => ({ name: t.name, hash: sha(JSON.stringify([t.name, t.description, t.parameters])) })),
    history: hist.map(messageHash),
  };
}

export interface PrefixBreak {
  scope: ('model' | 'system' | 'tools' | 'history')[];
  causes: string[];
  detail: string;
  invalidatedTokens: number;
}

/**
 * What changed between two consecutive turns, in prefix order. `compacted`:
 * a compaction ran since `prev` (history changes are then attributed to it).
 */
export function diffSnapshots(prev: PrefixSnapshot, cur: PrefixSnapshot, messages: ChatMessage[], tools: ToolSpec[], compacted = false): PrefixBreak | undefined {
  const scope: PrefixBreak['scope'] = [];
  const causes: string[] = [];
  const details: string[] = [];
  const add = (s: PrefixBreak['scope'][number], cause: string, detail?: string) => {
    if (!scope.includes(s)) scope.push(s);
    if (!causes.includes(cause)) causes.push(cause);
    if (detail) details.push(detail);
  };
  if (prev.model !== cur.model) add('model', 'model', `model ${prev.model} → ${cur.model}`);
  if (prev.system !== cur.system) {
    const names = new Set([...prev.sections.keys(), ...cur.sections.keys()]);
    const changed = [...names].filter((n) => prev.sections.get(n) !== cur.sections.get(n));
    for (const n of changed) add('system', n.replace(/'+$/, ''), `${n}: ${!prev.sections.has(n) ? 'added' : !cur.sections.has(n) ? 'removed' : 'changed'}`);
    if (!changed.length) add('system', 'system prompt', 'system prompt changed');
  }
  const pn = prev.tools.map((t) => t.name);
  const cn = cur.tools.map((t) => t.name);
  if (pn.join('\u0000') !== cn.join('\u0000') || prev.tools.some((t, i) => t.hash !== cur.tools[i]?.hash)) {
    const added = cn.filter((n) => !pn.includes(n));
    const removed = pn.filter((n) => !cn.includes(n));
    if (added.length) add('tools', 'tools added', `tools added: ${added.join(', ')}`);
    if (removed.length) add('tools', 'tools removed', `tools removed: ${removed.join(', ')}`);
    if (pn.filter((x) => cn.includes(x)).join('\u0000') !== cn.filter((x) => pn.includes(x)).join('\u0000')) add('tools', 'tool order', 'tool order changed');
    const schema = cur.tools.filter((t) => {
      const p = prev.tools.find((x) => x.name === t.name);
      return p && p.hash !== t.hash;
    });
    if (schema.length) add('tools', 'tool schema', `tool schema changed: ${schema.map((t) => t.name).join(', ')}`);
  }
  let at = -1;
  const n = Math.min(prev.history.length, cur.history.length);
  for (let i = 0; i < n; i++) if (prev.history[i] !== cur.history[i]) {
    at = i;
    break;
  }
  if (at < 0 && cur.history.length < prev.history.length) at = cur.history.length;
  if (at >= 0) add('history', compacted ? 'compaction' : 'history rewrite', `${compacted ? 'compaction' : 'history rewritten'} from message ${at + 1}`);
  if (!scope.length) return undefined;
  const hist = messages[0]?.role === 'system' ? messages.slice(1) : messages;
  const fromHistory = scope.length === 1 && scope[0] === 'history';
  const invalidatedTokens = fromHistory ? estimateMessagesTokens(hist.slice(Math.max(0, at))) : estimateMessagesTokens(messages) + (scope.includes('system') || scope.includes('model') || scope.includes('tools') ? estimateTokens(JSON.stringify(tools)) : 0);
  return { scope, causes, detail: details.join('; '), invalidatedTokens };
}

// ------------------------------------------------------------ prevention: stable environment

/** The Environment section's volatile part: the OS/date line and the git summary to the end of the section. */
export function volatileEnvironment(system: string): { normalized: string; volatile: string } | undefined {
  const m = system.match(/(^|\n\n)# Environment\n[\s\S]*?(?=\n\n|$)/);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[1].length;
  const section = m[0].slice(m[1].length);
  const lines = section.split('\n');
  const vol: string[] = [];
  const keep: string[] = [];
  let inGit = false;
  for (const l of lines) {
    if (/^- (git branch:|not a git repository)/.test(l)) inGit = true;
    if (inGit || /^- OS: .*; date: \d{4}-\d{2}-\d{2}/.test(l)) vol.push(l);
    else keep.push(l);
  }
  if (!vol.length) return undefined;
  const normalized = system.slice(0, start) + keep.join('\n') + '\n<volatile>' + system.slice(start + section.length);
  return { normalized, volatile: vol.join('\n') };
}

/** Per agent: the volatile environment the model last saw (system prompt or an update note). */
const lastShown = new WeakMap<object, string>();

/**
 * Called when a run starts with the previous and the freshly built system
 * prompt. Keeps `prev` when only volatile environment lines changed, and
 * returns those lines as a note for the user message (once per change).
 */
export function stabilizeSystemPrompt(owner: object, prev: string | undefined, fresh: string, enabled = true): { system: string; note?: string } {
  const f = volatileEnvironment(fresh);
  if (!enabled || prev === undefined || prev === fresh) {
    if (f) lastShown.set(owner, f.volatile);
    return { system: fresh };
  }
  const p = volatileEnvironment(prev);
  if (!f || !p || f.normalized !== p.normalized) {
    // a real change (memory, mode, skills, overlay…): the fresh prompt is used and the guard reports the break
    lastShown.set(owner, f?.volatile ?? '');
    return { system: fresh };
  }
  const shown = lastShown.get(owner) ?? p.volatile;
  lastShown.set(owner, f.volatile);
  if (shown === f.volatile) return { system: prev };
  return {
    system: prev,
    note: `<environment_update>\nThe environment changed since the system prompt was written (the system prompt is kept unchanged so the server's prompt cache stays valid). Current state:\n${f.volatile}\n</environment_update>`,
  };
}
