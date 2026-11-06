/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: ported from Qwen Code
 * packages/core/src/permissions/autoMode.ts (commit c726d2c):
 * hasRawProtectedRedirect, hasRawProtectedWriteCommand, rawProtectedWriteTargets,
 * rawFlagValue, containsProtectedPathFragment, stripRawRedirectTargetToken.
 * Changes: the predicate is our self-modification list (approver/automode.ts)
 * passed in by the caller; `cd` is tracked per segment (a relative write after
 * `cd <dir>` resolves against that dir, and after a `cd` whose target is
 * computed at run time it counts as a possible self-modification write, as in
 * Qwen's shell-semantics); `-exec … {} <target>` and the `-t` form are covered
 * for more programs; and a hit is a FLOOR (the human decides), where Qwen only
 * forces its classifier to review the call.
 */
import path from 'node:path';

const RAW_WRITE_PROGRAMS = /\b(?:cp|mv|install|ln|rsync|patch|perl|sed|tee|dd|sort|awk|gawk|node|nodejs|deno|bun|python3?|ruby|php|curl|wget|tar|unzip|cpio|truncate|touch)\b/;

function stripRawRedirectTargetToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && (token[start] === "'" || token[start] === '"' || token[start] === '$')) {
    if (token[start] === '$' && token[start + 1] !== "'") break;
    start++;
  }
  while (end > start) {
    const ch = token[end - 1];
    if (ch !== "'" && ch !== '"' && ch !== ')' && ch !== '}' && ch !== '&' && ch !== ';') break;
    end--;
  }
  return token.slice(start, end);
}

function rawFlagValue(token: string, line: string): string | undefined {
  const eq = token.indexOf('=');
  if (token.startsWith('--directory=') && /\btar\b/.test(line) && eq > 2) return token.slice(eq + 1);
  if (token.startsWith('--output=') && /\b(?:patch|sort|curl)\b/.test(line) && eq > 2) return token.slice(eq + 1);
  if (token.startsWith('--target-directory=') && /\b(?:cp|mv|install|ln)\b/.test(line) && eq > 2) return token.slice(eq + 1);
  for (const { flag, command } of [
    { flag: '-C', command: /\btar\b/ },
    { flag: '-d', command: /\bunzip\b/ },
    { flag: '-D', command: /\bcpio\b/ },
    { flag: '-o', command: /\b(?:curl|sort|patch)\b/ },
    { flag: '-O', command: /\bwget\b/ },
    { flag: '-t', command: /\b(?:cp|mv|install|ln)\b/ },
  ]) {
    if (command.test(line) && token.startsWith(flag) && token.length > 2) return token.slice(flag.length).replace(/^=/, '');
  }
  return undefined;
}

/** Path-like tokens a write-capable command line may write (the flag value when the token is a value-taking flag). */
function rawTargets(token: string, line: string, next: string | undefined): string[] {
  if (!token) return [];
  const v = rawFlagValue(token, line);
  if (v) return [v];
  // split flags: `-C dir`, `-d dir`, `-o file`, `-t dir`
  if (/^-[CdDoOt]$/.test(token) && next && rawFlagValue(token + next, line)) return [next];
  return token.startsWith('-') ? [] : [token];
}

export interface RawWriteHit {
  /** The path (as written, resolved) that may be written. */
  target: string;
  how: string;
}

/**
 * A self-modification path that a shell command may write, judged on the raw text: redirections (`>`, `>>`, `>|`,
 * `>&`, `<>`), and every path-like token of a line that runs a write-capable program (in-place sed/perl only).
 * Conservative by design: it can name a path the command only reads, which costs a prompt, never a missed write.
 */
export function rawSelfModWrite(command: string, cwd: string, isSelfMod: (absPath: string) => boolean): RawWriteHit | null {
  // `cd` tracking across `&&`, `;`, newlines and `{ … }` / `( … )` groups (a simple, conservative walk)
  let dir: string | null = cwd;
  const pieces = command.split(/(?:&&|\|\||;|\n|\|(?!\|))/);
  for (const raw of pieces) {
    const piece = raw.replace(/^[\s({]+|[\s)}]+$/g, '');
    const cd = piece.match(/^(?:builtin\s+)?(?:cd|pushd)\s+(.+)$/);
    if (cd) {
      const t = stripRawRedirectTargetToken(cd[1]!.trim());
      dir = /[$`*?]/.test(t) || !t ? null : dir === null ? null : path.resolve(dir, t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      continue;
    }
    const resolve = (t: string): string | null => {
      if (/\$[{(A-Za-z_]/.test(t)) return null; // computed at run time
      if (path.isAbsolute(t) || t.startsWith('~')) return t.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
      return dir === null ? null : path.resolve(dir, t);
    };
    const check = (t: string, how: string): RawWriteHit | null => {
      const target = stripRawRedirectTargetToken(t).replace(/^[({]+|[),;]+$/g, '');
      if (!target || target.startsWith('&') || target === '/dev/null') return null;
      const abs = resolve(target);
      // a relative target after a computed `cd`, or a computed target: we cannot know it is safe
      if (abs === null) return dir === null || /\$[{(A-Za-z_]/.test(target) ? { target, how: `${how} (target computed at run time)` } : null;
      for (const cand of target.match(/[A-Za-z0-9_./~@+-]+/g) ?? [target]) {
        const a = resolve(cand);
        if (a && isSelfMod(a)) return { target: a, how };
      }
      return null;
    };
    // redirections, including inside heredoc bodies and nested `bash -c '…'` strings
    for (let i = 0; i < piece.length; i++) {
      if (piece[i] !== '>') continue;
      const bidir = piece[i - 1] === '<';
      while (piece[i] === '>' || piece[i] === '|' || piece[i] === '&') i++;
      while (piece[i] === ' ' || piece[i] === '\t') i++;
      let tok = '';
      while (i < piece.length && !/[\s;&|<>]/.test(piece[i]!)) tok += piece[i++];
      const hit = check(tok, bidir ? 'read-write redirection' : 'redirection');
      if (hit) return hit;
    }
    if (!RAW_WRITE_PROGRAMS.test(piece)) continue;
    // sed/perl write only in place
    if (/\b(?:sed|perl)\b/.test(piece) && !/\b(?:node|python3?|ruby|cp|mv|tee|dd)\b/.test(piece) && !/(?:^|\s)(?:-[A-Za-z]*i|--in-place(?:=|\s|$))/.test(piece)) continue;
    // awk only in place
    if (/\b(?:g?awk)\b/.test(piece) && !/\b(?:node|python3?|ruby|cp|mv|tee|dd|sort|tar|curl|wget)\b/.test(piece) && !/-i\s+inplace\b/.test(piece)) continue;
    const toks = piece.split(/\s+/);
    for (let k = 0; k < toks.length; k++) {
      for (const t of rawTargets(stripRawRedirectTargetToken(toks[k]!), piece, toks[k + 1])) {
        // `D=.tugline/x; cp p "$D"`: an assignment names a target too
        const val = t.includes('=') && !t.startsWith('-') ? t.slice(t.indexOf('=') + 1) : t;
        const hit = check(val, 'a write-capable command names it');
        if (hit && !/computed/.test(hit.how)) return hit;
        if (hit && /computed/.test(hit.how) && /^(?:cp|mv|install|ln|tee|dd|rsync)$/.test(path.basename(toks[0] ?? ''))) return hit;
      }
    }
  }
  return null;
}
