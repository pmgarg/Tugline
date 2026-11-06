/**
 * Context breakdown for /context and the VS Code meter (SPEC B9/D13): where the
 * window goes — system prompt, tool schemas, conversation history, and
 * attachments (@-mentions, repo map, piped stdin, images).
 */
import type { ChatMessage, ToolSpec } from '../types.js';
import { contentToText, estimateTokens } from '../util/text.js';

export interface ContextBreakdown {
  system: number;
  tools: number;
  history: number;
  attachments: number;
  total: number;
  window: number;
  /** usable budget before compaction (window - output reserve - tools) × compactAt */
  compactAt: number;
  messages: number;
  toolCount: number;
  deferredTools: number;
}

const ATTACHMENT = /<(attached_context|repo_map|stdin)\b[^>]*>[\s\S]*?<\/\1>/g;

export function contextBreakdown(a: {
  systemPrompt(): string;
  toolSpecs(): ToolSpec[];
  messages: ChatMessage[];
  llm: { profile: { contextWindow: number; maxOutputTokens: number } };
  config: { agent: { compactAt: number } };
  deferredToolCount?: number;
}): ContextBreakdown {
  const sysMsg = a.messages[0]?.role === 'system' ? contentToText(a.messages[0].content) : a.systemPrompt();
  const system = estimateTokens(sysMsg) + 4;
  const specs = a.toolSpecs();
  const tools = specs.length ? estimateTokens(JSON.stringify(specs)) : 0;
  let history = 0;
  let attachments = 0;
  for (const m of a.messages) {
    if (m.role === 'system') continue;
    let text = contentToText(m.content);
    if (m.role === 'user') {
      for (const x of text.match(ATTACHMENT) ?? []) attachments += estimateTokens(x);
      text = text.replace(ATTACHMENT, '');
      if (Array.isArray(m.content)) attachments += m.content.filter((p) => p.type === 'image_url').length * 800;
    }
    history += 4 + estimateTokens(text);
    for (const tc of m.tool_calls ?? []) history += estimateTokens(tc.function.name + tc.function.arguments) + 6;
  }
  const p = a.llm.profile;
  return {
    system,
    tools,
    history,
    attachments,
    total: system + tools + history + attachments,
    window: p.contextWindow,
    compactAt: Math.max(2000, Math.floor((p.contextWindow - p.maxOutputTokens - tools) * a.config.agent.compactAt)),
    messages: a.messages.filter((m) => m.role !== 'system').length,
    toolCount: specs.length,
    deferredTools: a.deferredToolCount ?? 0,
  };
}

export function formatBreakdown(b: ContextBreakdown): string {
  const pct = (n: number) => `${((n / Math.max(1, b.window)) * 100).toFixed(1)}%`;
  const row = (name: string, n: number, extra = '') => `  ${name.padEnd(13)} ${String(n).padStart(7)} tok  ${pct(n).padStart(6)}${extra}`;
  return [
    `Context: ~${b.total} / ${b.window} tokens (${pct(b.total)}); compaction at ~${b.compactAt} message tokens`,
    row('system prompt', b.system),
    row('tools', b.tools, `  (${b.toolCount} loaded${b.deferredTools ? `, ${b.deferredTools} deferred` : ''})`),
    row('history', b.history, `  (${b.messages} messages)`),
    row('attachments', b.attachments, '  (@mentions, repo map, stdin, images)'),
  ].join('\n');
}
