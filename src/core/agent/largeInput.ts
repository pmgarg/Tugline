/**
 * A user message too large for the model's context (a pasted log or stack trace is the usual case).
 *
 * Sent whole, the server rejects it ("maximum context length exceeded"), and compaction cannot help: the oversized
 * part is the new message itself. Instead the full text is saved under .tugline/pastes/ in the workspace, and the
 * model gets the head and the tail (where a log's first error and a stack trace's exception are) with a note
 * saying how much was left out and where the full text is, so it can grep or read the rest with its tools.
 */
import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from '../util/text.js';

export interface FittedInput {
  text: string;
  /** set when the text was shortened */
  saved?: { file: string; rel: string; lines: number; chars: number; keptLines: number; tokens: number };
}

/** The share of the shortened text given to its head; the rest goes to the tail. */
const HEAD_SHARE = 0.4;

/**
 * Shorten `text` to at most `maxTokens` (estimated) when it is longer, saving the full text in the workspace.
 * `now` and `id` are for tests.
 */
export function fitLargeInput(text: string, maxTokens: number, workspace: string, now = new Date(), id = Math.random().toString(36).slice(2, 8)): FittedInput {
  const tokens = estimateTokens(text);
  if (tokens <= maxTokens) return { text };
  const dir = path.join(workspace, '.tugline', 'pastes');
  fs.mkdirSync(dir, { recursive: true });
  // never committed: pasted logs can hold hostnames, tokens and customer data
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `paste-${stamp}-${id}.txt`);
  fs.writeFileSync(file, text);
  const rel = path.relative(workspace, file).split(path.sep).join('/');
  const lines = text.split('\n');
  // characters per token of this text, so the kept part lands near the token budget
  const ratio = text.length / tokens;
  const budget = Math.max(200, Math.floor(maxTokens * ratio) - 600);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget * HEAD_SHARE) break;
    head.push(l);
    used += l.length + 1;
  }
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    if (used + lines[i].length + 1 > budget * (1 - HEAD_SHARE)) break;
    tail.unshift(lines[i]);
    used += lines[i].length + 1;
  }
  // an enormous first or last line (minified output, base64): keep its start or its end by characters
  if (!head.length) head.push(lines[0].slice(0, Math.floor(budget * HEAD_SHARE)));
  if (!tail.length && lines.length > 1) tail.push(lines[lines.length - 1].slice(-Math.floor(budget * (1 - HEAD_SHARE))));
  else if (!tail.length) tail.push(text.slice(text.length - Math.floor(budget * (1 - HEAD_SHARE))));
  const omitted = lines.length - head.length - tail.length;
  const note = `[… ${omitted > 0 ? `${omitted.toLocaleString('en-US')} lines` : 'part of a line'} left out: this message was about ${tokens.toLocaleString('en-US')} tokens, too large for the model's context. The full text (${lines.length.toLocaleString('en-US')} lines) is saved at ${rel}; search it with grep or read a line range with read_file. …]`;
  return { text: `${head.join('\n')}\n\n${note}\n\n${tail.join('\n')}`, saved: { file, rel, lines: lines.length, chars: text.length, keptLines: head.length + tail.length, tokens } };
}
