/**
 * Optional apply model (SPEC A8, ED §2.10). Off unless `edit.applyModel` names a
 * profile. Used for:
 *  - an anchor edit that failed twice on the same file (the snippet is new_string);
 *  - a write_file whose content has lazy "... existing code ..." markers.
 *
 * The apply model sees <original> and <update> and returns the full file. The
 * output is never trusted: it must have no lazy markers, introduce no new syntax
 * errors (A6), not delete more than half the file, and change at most 3× as many
 * lines as the snippet has. Anything else is refused and the model is told to
 * edit by anchor instead.
 */
import { withScopeOverride } from '../llm/admission.js';
import { LLMClient } from '../llm/client.js';
import { resolveProfile, type HarnessConfig } from '../config.js';
import { diffCounts, splitLines } from './diff.js';
import { findLazyPlaceholders } from './text.js';
import { newProblems, syntaxProblems } from './verify.js';

export interface ApplyRequest {
  path: string;
  original: string;
  snippet: string;
  instruction?: string;
}

export type ApplyResult = { ok: true; text: string; model: string } | { ok: false; reason: string };

const SYSTEM = `You merge a code edit into a file. You receive the ORIGINAL file and an UPDATE snippet.
The snippet shows only the changed parts; comments like "// ... existing code ..." stand for unchanged code that must be copied from the original.
Output the COMPLETE updated file inside <updated-code>...</updated-code> and nothing else. Copy every unchanged line exactly. Never add placeholders or comments of your own.`;

/** Exposed so tests can drive the prompt without a server. */
export function applyPrompt(r: ApplyRequest): string {
  return `${r.instruction ? `<instruction>${r.instruction}</instruction>\n` : ''}<original path="${r.path}">\n${r.original}\n</original>\n<update>\n${r.snippet}\n</update>`;
}

export function extractUpdated(text: string): string | undefined {
  const tag = /<updated-code>\n?([\s\S]*?)\n?<\/updated-code>/.exec(text);
  if (tag) return tag[1];
  const fence = /```[\w-]*\n([\s\S]*?)\n```/.exec(text);
  if (fence) return fence[1];
  return undefined;
}

/** Validate an apply-model output against the original and the snippet. */
export async function checkApplyOutput(path: string, original: string, snippet: string, out: string): Promise<string | undefined> {
  const lazy = findLazyPlaceholders(out, original);
  if (lazy.length) return `the merged file still contains placeholder lines (${lazy.join(' | ')})`;
  const origLines = splitLines(original).length;
  const { removed, added } = diffCounts(original, out);
  if (origLines > 0 && removed - added > origLines * 0.5) return `the merged file deletes ${removed - added} of ${origLines} lines (more than 50%)`;
  const snippetLines = splitLines(snippet).filter((l) => l.trim() && !findLazyPlaceholders(l, '').length).length;
  if (removed + added > Math.max(3, 3 * snippetLines)) return `the merge changed ${removed + added} lines for a ${snippetLines}-line snippet (more than 3×)`;
  const post = await syntaxProblems(path, out);
  if (post.length) {
    const fresh = newProblems(await syntaxProblems(path, original), original, post, out);
    if (fresh.length) return `the merged file has a new syntax error: L${fresh[0].line}: ${fresh[0].message}`;
  }
  return undefined;
}

export async function runApplyModel(cfg: HarnessConfig, profileName: string, req: ApplyRequest, signal?: AbortSignal): Promise<ApplyResult> {
  let client: LLMClient;
  try {
    client = new LLMClient({ ...resolveProfile(cfg, profileName), toolMode: 'native' });
  } catch (e) {
    return { ok: false, reason: `apply model profile "${profileName}": ${(e as Error).message}` };
  }
  let text: string;
  try {
    // v1.1 R4: admitted (and recorded) at the admission point of the agent run that called edit_file
    const r = await withScopeOverride({ kind: 'apply', role: 'editor' }, () => client.complete({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: applyPrompt(req) }], temperature: 0, signal }));
    text = r.text;
  } catch (e) {
    return { ok: false, reason: `apply model failed: ${(e as Error).message}` };
  }
  let out = extractUpdated(text);
  if (out === undefined) return { ok: false, reason: 'apply model returned no <updated-code> block' };
  // keep the original's trailing newline and line endings
  if (req.original.endsWith('\n') && !out.endsWith('\n')) out += '\n';
  if (req.original.includes('\r\n') && !out.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  const bad = await checkApplyOutput(req.path, req.original, req.snippet, out);
  if (bad) return { ok: false, reason: `apply-model output refused: ${bad}` };
  return { ok: true, text: out, model: client.profile.model };
}
