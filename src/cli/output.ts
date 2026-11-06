/**
 * Headless output formats (v1.2 N49), compatible in shape with Qwen Code / Claude Code:
 *   --output-format text         the final answer on stdout (default)
 *   --output-format json         one JSON object at the end: the `result` document
 *   --output-format stream-json  JSON lines: an `init` line, every agent event, then the `result` line
 *   --json                       = stream-json (v1.0 flag, kept)
 *
 * The schema is published at docs/schemas/headless-output.schema.json (generated from the zod schemas below;
 * a test keeps the file in sync and validates real output against it with ajv). `version` is bumped on any
 * breaking change.
 */
import { redactSecrets } from '../core/util/text.js';
import { z } from 'zod';
import type { AgentEvent } from '../core/types.js';
import type { RunResult } from '../core/agent/agent.js';

export const HEADLESS_SCHEMA_VERSION = 1;
export type OutputFormat = 'text' | 'json' | 'stream-json';

export const InitLine = z
  .object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    version: z.literal(HEADLESS_SCHEMA_VERSION),
    session_id: z.string(),
    cwd: z.string(),
    model: z.string(),
    permission_mode: z.string(),
    tools: z.array(z.string()),
  })
  .strict();

/** One agent event (the AgentEvent union, as emitted; `type` is always present). */
export const EventLine = z
  .object({
    type: z.string().regex(/^[a-z_]+$/),
  })
  .passthrough();

export const ResultLine = z
  .object({
    type: z.literal('result'),
    version: z.literal(HEADLESS_SCHEMA_VERSION),
    session_id: z.string(),
    /** true when the run ended normally (stop reason end_turn) */
    ok: z.boolean(),
    stop_reason: z.string(),
    result: z.string(),
    /** v1.1 R2: verified | failed | unverified | not_applicable */
    completion: z.object({ state: z.string(), summary: z.string().optional() }).strict().optional(),
    stats: z
      .object({
        turns: z.number().int().nonnegative(),
        tool_calls: z.number().int().nonnegative(),
        tool_errors: z.number().int().nonnegative(),
        refusals: z.number().int().nonnegative(),
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        cost_usd: z.number().nonnegative(),
        duration_ms: z.number().nonnegative(),
      })
      .strict(),
    files_changed: z.array(z.string()),
    /** tools the run asked for but nobody approved (headless) or the policy refused */
    permission_denials: z.array(z.object({ tool: z.string(), reason: z.string() }).strict()),
  })
  .strict();

export const StreamLine = z.union([InitLine, ResultLine, EventLine]);

/** The published JSON Schema document (both formats). */
export function headlessJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://tugline.dev/schemas/headless-output.schema.json',
    title: 'Tugline headless output',
    description: `tug -p … --output-format json prints one "result" document; --output-format stream-json prints one "line" per JSON line (an init line, agent events, then the result). Version ${HEADLESS_SCHEMA_VERSION}.`,
    $defs: {
      init: z.toJSONSchema(InitLine, { target: 'draft-2020-12' }),
      event: z.toJSONSchema(EventLine, { target: 'draft-2020-12' }),
      result: z.toJSONSchema(ResultLine, { target: 'draft-2020-12' }),
      line: { anyOf: [{ $ref: '#/$defs/init' }, { $ref: '#/$defs/result' }, { $ref: '#/$defs/event' }] },
    },
    $ref: '#/$defs/result',
  };
}

export interface Denial {
  tool: string;
  reason: string;
}

export function initLine(o: { sessionId: string; cwd: string; model: string; mode: string; tools: string[] }): z.infer<typeof InitLine> {
  return { type: 'system', subtype: 'init', version: HEADLESS_SCHEMA_VERSION, session_id: o.sessionId, cwd: o.cwd, model: o.model, permission_mode: o.mode, tools: o.tools };
}

export function resultLine(sessionId: string, r: RunResult, denials: Denial[]): z.infer<typeof ResultLine> {
  const s = r.stats;
  return {
    type: 'result',
    version: HEADLESS_SCHEMA_VERSION,
    session_id: sessionId,
    ok: r.stopReason === 'end_turn',
    stop_reason: r.stopReason,
    result: r.finalText ?? '',
    ...(r.completion ? { completion: { state: r.completion.state, ...(r.completion.summary ? { summary: r.completion.summary } : {}) } } : {}),
    stats: { turns: s.turns, tool_calls: s.toolCalls, tool_errors: s.toolErrors, refusals: s.refusals, prompt_tokens: s.promptTokens, completion_tokens: s.completionTokens, cost_usd: s.costUsd, duration_ms: s.durationMs },
    files_changed: s.filesChanged,
    permission_denials: denials,
  };
}

/** Denials seen in the event stream: every refused call (policy deny, an ask answered "deny" or unanswered) ends in one refusal. */
export function collectDenial(e: AgentEvent, into: Denial[]): void {
  if (e.type === 'refusal') into.push({ tool: e.tool, reason: e.reason });
}

/**
 * Review F15: headless output passes through the journal's redaction (secret patterns and the secret values the
 * harness knows). Streamed text arrives in chunks that can split a secret, so the last `keep` characters are held
 * back until more text (or the end of the message) shows they are not part of one.
 */
export class StreamRedactor {
  private buf = '';
  constructor(private secrets: () => string[], private keep = 256) {}
  private get hold(): number {
    return Math.max(this.keep, ...this.secrets().map((s) => s.length));
  }
  push(chunk: string): string {
    const out = redactSecrets(this.buf + chunk, this.secrets());
    const cut = Math.max(0, out.length - this.hold);
    this.buf = out.slice(cut);
    return out.slice(0, cut);
  }
  flush(): string {
    const out = redactSecrets(this.buf, this.secrets());
    this.buf = '';
    return out;
  }
  /** a complete value (an event, the final text): redacted as a whole */
  whole<T>(v: T): T {
    return typeof v === 'string' ? (redactSecrets(v, this.secrets()) as T) : (JSON.parse(redactSecrets(JSON.stringify(v), this.secrets())) as T);
  }
}
