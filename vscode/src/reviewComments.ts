/**
 * Diff-line comments sent back to the agent (v1.1 N14), pure part: where
 * comments can be placed (the lines of the agent's pending hunks, B2) and the
 * message they become. No `vscode` import (unit-tested with node).
 *
 * Every comment becomes one block:
 *
 *   <review_comment path="src/a.ts" line="12" end_line="14">
 *   <code>
 *   …the commented lines as they are now…
 *   </code>
 *   the user's comment
 *   </review_comment>
 *
 * Text is XML-escaped (& < > "), so a comment or a code line can never close
 * the block or forge another one.
 */
import path from 'node:path';
import type { ReviewHunk } from './hunks.js';

export interface ReviewComment {
  /** absolute path */
  path: string;
  /** 1-based first line */
  line: number;
  /** 1-based last line, when the comment covers several */
  endLine?: number;
  body: string;
  /** the commented lines as they are now */
  code?: string;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 0-based [start, end] line ranges where comments may be placed: the current
 * side of each pending hunk. A pure deletion (no current lines) gets the line
 * where the text was removed.
 */
export function commentRanges(hunks: ReviewHunk[], lineCount: number): [number, number][] {
  const last = Math.max(0, lineCount - 1);
  return hunks.map((h) => {
    const start = Math.min(h.newStart, last);
    return [start, Math.min(last, start + Math.max(1, h.newLines) - 1)];
  });
}

const MAX_CODE_LINES = 20;

/** Comments in reading order (path, then line), as one message for the agent. Paths are relative to the workspace when inside it. */
export function buildReviewCommentMessage(comments: ReviewComment[], workspace?: string): string {
  const sorted = [...comments].filter((c) => c.body.trim()).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  if (!sorted.length) return '';
  const rel = (p: string) => {
    if (!workspace) return p;
    const r = path.relative(workspace, p);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p;
  };
  const blocks = sorted.map((c) => {
    const attrs = `path="${escapeXml(rel(c.path))}" line="${c.line}"${c.endLine && c.endLine > c.line ? ` end_line="${c.endLine}"` : ''}`;
    let code = '';
    if (c.code !== undefined) {
      const lines = c.code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
      const shown = lines.slice(0, MAX_CODE_LINES).join('\n') + (lines.length > MAX_CODE_LINES ? `\n… ${lines.length - MAX_CODE_LINES} more lines` : '');
      code = `<code>\n${escapeXml(shown)}\n</code>\n`;
    }
    return `<review_comment ${attrs}>\n${code}${escapeXml(c.body.trim().replace(/\r\n/g, '\n'))}\n</review_comment>`;
  });
  const n = sorted.length;
  return `The user reviewed your changes and left ${n} comment${n === 1 ? '' : 's'} on specific lines. Address each one at its path and line (line numbers are for the files as they are now), then say briefly what you changed.\n\n${blocks.join('\n\n')}`;
}
