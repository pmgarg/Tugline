/**
 * @-mentions for the chat composer (SPEC B4). Pure: every editor/terminal/git
 * access goes through `MentionEnv`, which the extension implements with the
 * VS Code API and tests implement with fakes.
 *
 * Syntax (what the composer's autocomplete inserts):
 *   @path/to/file[:10-20]   @folder/          file and folder (core expandMentions)
 *   @problems[:path]        diagnostics (workspace, or one file)
 *   @terminal               last output of the active terminal
 *   @git[:<commit>]         git status + diff, or one commit
 *   @url:<https://…>        a web page through web_fetch (SSRF guard, untrusted wrapping)
 *   @skill:<name>           a skill's instructions
 *
 * Resolved context is appended as <attached_context source="…"> blocks, each
 * capped per provider.
 */
import { attachmentBlock } from '../../src/core/util/attachments.js';
import { expandMentions } from '../../src/core/context/mentions.js';
import type { PermissionPolicy } from '../../src/core/permissions/policy.js';

export interface MentionDiagnostic {
  path: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: string;
  /** a few lines of code around the problem */
  context?: string;
}

export interface MentionEnv {
  workspace: string;
  policy?: Pick<PermissionPolicy, 'check'>;
  /** Diagnostics for one file (absolute path) or the whole workspace. */
  diagnostics(abs?: string): Promise<MentionDiagnostic[]> | MentionDiagnostic[];
  /** Last command output of the active terminal, or undefined when unknown. */
  terminalOutput(): Promise<{ command?: string; exitCode?: number; output: string; via: 'shell-integration' | 'selection' } | undefined>;
  /** Run git with argv in the workspace (the extension applies the command wrappers). */
  git(args: string[]): Promise<{ code: number | null; output: string }>;
  /** Fetch a URL through the core web_fetch tool (SSRF guard + untrusted wrapping). Throws on refusal. */
  fetchUrl(url: string): Promise<string>;
  /** A skill's body, or undefined when unknown. */
  skill(name: string): Promise<string | undefined> | string | undefined;
}

export interface Attached {
  source: string;
  kind: string;
  chars: number;
}

export interface MentionResolution {
  text: string;
  attached: Attached[];
  skipped: { source: string; reason: string }[];
}

/** Per-provider caps (characters). */
export const CAPS = { problems: 8000, terminal: 8000, git: 20000, url: 20000, skill: 12000, file: 20000 } as const;

const SPECIAL = /(^|[\s(])@(problems|terminal|git|url|skill)(?::(\S+)|(?=$|[\s),;!?\]]|\.(?:\s|$)))/g;

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n… [truncated: ${s.length - n} more chars]` : s;
}

function block(source: string, kind: string, body: string): string {
  return attachmentBlock('attached_context', { source, kind }, body);
}

export function formatProblems(diags: MentionDiagnostic[], workspace: string, max = CAPS.problems): string {
  const rel = (p: string) => (p.startsWith(workspace + '/') ? p.slice(workspace.length + 1) : p);
  const sorted = [...diags].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : b.severity === 'error' ? 1 : a.severity === 'warning' ? -1 : 1));
  const out: string[] = [];
  for (const d of sorted) {
    out.push(`${rel(d.path)}:${d.line}:${d.col} ${d.severity}: ${d.message}${d.source ? ` [${d.source}]` : ''}${d.context ? `\n${d.context}` : ''}`);
    if (out.join('\n').length > max) break;
  }
  return cap(out.join('\n'), max);
}

export async function resolveProblems(env: MentionEnv, arg?: string): Promise<string> {
  const abs = arg ? (arg.startsWith('/') ? arg : `${env.workspace}/${arg}`) : undefined;
  const diags = await env.diagnostics(abs);
  if (!diags.length) return 'No problems reported.';
  return formatProblems(diags, env.workspace);
}

export async function resolveTerminal(env: MentionEnv): Promise<string | undefined> {
  const t = await env.terminalOutput();
  if (!t || !t.output.trim()) return undefined;
  const tail = t.output.split('\n').slice(-200).join('\n');
  const head = t.command ? `$ ${t.command}${t.exitCode !== undefined ? `  [exit code ${t.exitCode}]` : ''}\n` : '';
  return cap(head + tail, CAPS.terminal);
}

const COMMIT = /^[0-9a-fA-F]{4,40}$|^HEAD(~\d+|\^+)?$/;

export async function resolveGit(env: MentionEnv, arg?: string): Promise<string> {
  if (arg) {
    if (!COMMIT.test(arg)) throw new Error(`not a commit: ${arg}`);
    const r = await env.git(['show', '--stat', '--patch', '--no-color', arg]);
    if (r.code !== 0) throw new Error(r.output.trim().slice(0, 200) || 'git show failed');
    return cap(r.output, CAPS.git);
  }
  const st = await env.git(['status', '--short', '--branch']);
  if (st.code !== 0) throw new Error(st.output.trim().slice(0, 200) || 'not a git repository');
  const diff = await env.git(['diff', 'HEAD', '--no-color']);
  const body = `git status:\n${st.output.trim()}\n\ngit diff HEAD:\n${diff.code === 0 ? diff.output.trim() || '(no changes)' : diff.output.trim()}`;
  return cap(body, CAPS.git);
}

export async function resolveUrl(env: MentionEnv, arg?: string): Promise<string> {
  if (!arg) throw new Error('usage: @url:https://…');
  let u: URL;
  try {
    u = new URL(arg);
  } catch {
    throw new Error(`invalid URL: ${arg}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs');
  return cap(await env.fetchUrl(u.toString()), CAPS.url);
}

export async function resolveSkill(env: MentionEnv, arg?: string): Promise<string> {
  if (!arg) throw new Error('usage: @skill:<name>');
  const body = await env.skill(arg);
  if (body === undefined) throw new Error(`unknown skill "${arg}"`);
  return cap(body, CAPS.skill);
}

/** Resolve every mention in `input`. Mentions that fail are reported in `skipped` and never block the message. */
export async function resolveMentions(input: string, env: MentionEnv): Promise<MentionResolution> {
  const res: MentionResolution = { text: input, attached: [], skipped: [] };
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const m of input.matchAll(SPECIAL)) {
    const kind = m[2];
    const arg = m[3]?.replace(/[.,;:!?)\]]+$/, '') || undefined;
    const source = `@${kind}${arg ? `:${arg}` : ''}`;
    if (seen.has(source)) continue;
    seen.add(source);
    try {
      let body: string | undefined;
      if (kind === 'problems') body = await resolveProblems(env, arg);
      else if (kind === 'terminal') {
        body = await resolveTerminal(env);
        if (body === undefined) throw new Error('no terminal output available (run the command in a terminal with shell integration, or select the output first)');
      } else if (kind === 'git') body = await resolveGit(env, arg);
      else if (kind === 'url') body = await resolveUrl(env, arg);
      else if (kind === 'skill') body = await resolveSkill(env, arg);
      if (body === undefined) continue;
      blocks.push(block(source, kind, body));
      res.attached.push({ source, kind, chars: body.length });
    } catch (e) {
      res.skipped.push({ source, reason: (e as Error).message });
    }
  }
  // Files and folders: the core resolver (permission check as a read; secrets and outside paths are not attached).
  const withoutSpecial = input.replace(SPECIAL, '$1');
  const files = expandMentions(withoutSpecial, env.workspace, { policy: env.policy, maxFileChars: CAPS.file, maxEntries: 200 });
  for (const a of files.attached) res.attached.push({ source: a.source, kind: a.kind, chars: 0 });
  res.skipped.push(...files.skipped);
  const fileBlocks = files.text.slice(withoutSpecial.length).trim();
  if (fileBlocks) blocks.push(fileBlocks);
  if (blocks.length) res.text = `${input}\n\n${blocks.join('\n\n')}`;
  return res;
}

/** Composer autocomplete: the special providers matching a typed query. */
export const SPECIAL_ITEMS = [
  { label: '@problems', insert: '@problems ', detail: 'Errors and warnings (workspace)' },
  { label: '@terminal', insert: '@terminal ', detail: 'Last output of the active terminal' },
  { label: '@git', insert: '@git ', detail: 'git status + diff (or @git:<commit>)' },
  { label: '@url:', insert: '@url:https://', detail: 'Fetch a web page' },
  { label: '@skill:', insert: '@skill:', detail: 'Attach a skill' },
];

/** Subsequence fuzzy score (higher is better), or -1 for no match. */
export function fuzzyScore(query: string, candidate: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let score = 0;
  let last = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) {
      score += last === i - 1 ? 3 : 1;
      if (i === 0 || c[i - 1] === '/' || c[i - 1] === '.' || c[i - 1] === '_' || c[i - 1] === '-') score += 2;
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  const base = c.slice(c.lastIndexOf('/') + 1);
  if (base.startsWith(q)) score += 10;
  if (base.replace(/\.[^.]*$/, '') === q) score += 5;
  return score - c.length / 100;
}

export function rankFiles(query: string, files: string[], limit = 30): string[] {
  return files
    .map((f) => ({ f, s: fuzzyScore(query, f) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}
