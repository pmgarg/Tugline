/**
 * Taint tracking with the "Rule of Two" (G2; Meta's Agents Rule of Two, EAG S12).
 *
 * An agent may combine at most two of: (A) processing untrusted input, (B)
 * access to private data or systems, (C) changing state or communicating
 * externally. A coding agent always has (B). So once untrusted content (web
 * pages, MCP output, browser/desktop text, OCR, channel messages from anyone
 * but the owner) has entered the session, actions in the outbound categories
 * (C): exfiltration, publishing, persistence, writes outside the workspace,
 * must reach a human, in every mode, and no approver extension may settle them.
 * Ordinary local work (edits, builds, tests without network egress) stays as
 * the policy decided, so normal coding flow is not slowed.
 *
 * The taint signal is structural, not textual guesswork:
 *  - `meta.untrusted: true` on a tool result (web_search, web_fetch, screenshot,
 *    MCP, browser_* and desktop_* via withUntrustedMeta in util/untrusted.ts);
 *  - any MCP tool output (also when the call failed);
 *  - as a backstop, and for prompts and resumed history, the shared envelope
 *    `<untrusted_*>` (wrapUntrusted) opening a line. Content cannot forge the
 *    envelope closed, and a forged opening only errs towards asking.
 * Hard denies stay hard: taint only ever turns an allow or an ask into a human ask.
 */
import type { CheckInput } from '../permissions/policy.js';
import type { ToolDef, ToolOutput } from '../tools/types.js';
import path from 'node:path';
import { splitCommandSegments } from '../permissions/policy.js';
import { prefilter, shellCStrings, type PrefilterHit } from '../approver/prefilter.js';
import { selectRunner } from '../sandbox/index.js';
import { requestedRunner } from '../sandbox/settings.js';
import type { HarnessConfig } from '../config.js';

export const TAINT_CATEGORIES = ['exfiltration', 'publishing', 'persistence', 'outside-workspace-write'] as const;
export type TaintCategory = (typeof TAINT_CATEGORIES)[number];

// An envelope as wrapUntrusted writes it: at the start of a line. Anchoring keeps a file or grep
// result that merely quotes the tag (read_file prefixes line numbers) from tainting the session.
const ENVELOPE = /(?:^|\n)<untrusted_([a-z_]+)((?:\s+[A-Za-z_-]+="[^"]*")*)\s*>/g;

/** The first untrusted envelope in a text that is not the owner's own message, described for the user. */
export function untrustedEnvelope(text: string): string | undefined {
  for (const m of text.matchAll(ENVELOPE)) {
    const attrs = m[2] ?? '';
    // Channel messages from the paired owner are the user speaking (S11 trust envelope).
    if (/\btrust="owner"/.test(attrs)) continue;
    const src = attrs.match(/\b(?:source|server|channel|resource)="([^"]*)"/)?.[1];
    return `${m[1].replace(/_/g, ' ')}${src ? ` from ${src.slice(0, 80)}` : ''}`;
  }
  return undefined;
}

/**
 * H5: the goal loop's verifier findings block (`<untrusted_verifier_findings source="independent verifier"
 * relay="harness">`): data for the agent, but its taint is decided by what the verifier read, not by the envelope.
 * Removed only from a PROMPT before the prompt check (never from tool results); its body is neutralised, so content
 * can neither close it early nor forge another one.
 */
const HARNESS_RELAY = /(^|\n)<untrusted_verifier_findings source="independent verifier" relay="harness">\n[\s\S]*?\n<\/untrusted_verifier_findings>/g;
export function withoutHarnessRelay(prompt: string): string {
  return prompt.replace(HARNESS_RELAY, '$1');
}

/** Why this tool result taints the session, or undefined. */
export function untrustedResult(tool: Pick<ToolDef, 'name' | 'kind' | 'mcpServer'>, out: Pick<ToolOutput, 'output' | 'meta'>): string | undefined {
  if (tool.kind === 'mcp' || tool.mcpServer) return `MCP tool ${tool.name}`;
  if (out.meta?.untrusted === true) return `${tool.name} output`;
  const env = untrustedEnvelope(out.output ?? '');
  return env ? `${env} (${tool.name})` : undefined;
}

/**
 * Shell commands that talk to the network. Builds and tests that stay local do
 * not match; package installs and plain `git pull` are not treated as egress
 * (normal flow), which is a documented residual risk. Inline interpreter code
 * that opens connections is caught by the prefilter's exfiltration rules.
 */
const NET_PROGS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'lftp', 'xh', 'http', 'https', 'aria2c', 'websocat', 'rclone', 'mail', 'sendmail', 'mutt']);
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'stdbuf', 'unbuffer', 'sudo', 'doas', 'xargs', 'timeout', 'watch']);
const EGRESS_RE = /\/dev\/(?:tcp|udp)\/|\brsync\b[^;&|]*\s\S*[\w\]]:\S*|\bgit\s+(?:-\S+\s+)*(?:push|send-email|request-pull)\b|\bgit\b[^;&|]*\s["']?(?:https?:\/\/|ssh:\/\/|git@)|\bdocker\s+(?:push|login)\b/;

/** Why this shell command reaches the network, or null. Judged per simple command, by program name (not by any word in it). */
export function shellEgress(command: string, depth = 0): string | null {
  if (EGRESS_RE.test(command)) return 'the command sends data to a remote host';
  for (const seg of splitCommandSegments(command.replace(/\$\(|[`()]/g, ';'))) {
    const t = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((x) => x.replace(/^["']|["']$/g, ''));
    for (;;) {
      if (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]!)) t.shift();
      else if (t.length && WRAPPERS.has(path.basename(t[0]!))) {
        t.shift();
        while (t.length && (t[0]!.startsWith('-') || /^\d+[smh]?$/.test(t[0]!))) t.shift();
      } else break;
    }
    const prog = path.basename(t[0] ?? '');
    if (NET_PROGS.has(prog)) return `the command runs ${prog}, which talks to the network`;
  }
  if (depth < 3) {
    // command substitution inside double quotes, and `sh -c '…'` bodies
    const inner = [...command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)].map((m) => m[1] ?? m[2] ?? '').concat(shellCStrings(command));
    for (const c of inner) {
      const r = c.trim() && c !== command ? shellEgress(c, depth + 1) : null;
      if (r) return r;
    }
  }
  return null;
}

// ------------------------------------------------------------ containment (enforcement, not patterns)

/**
 * Pattern lists cannot close egress: a script the model just wrote, `python3 -c` with urllib,
 * an npm script or a Makefile can all reach the network while looking like ordinary local work.
 * So while a run is tainted, shell commands are contained by the OS sandbox with network access
 * off (or, with `agent.taintShellNetwork: "registries"`, only the package registries through the
 * N30 proxy preset). Where no sandbox runner is available, every shell command needs a human.
 */
export interface TaintContainment {
  /** the config shell commands run with while tainted (sandbox forced on, network off/registries) */
  config?: HarnessConfig;
  /** the runner that contains them */
  runner?: string;
  network?: 'none' | 'registries';
  /** set when no sandbox can contain commands: why every shell command asks */
  ask?: string;
  /** one sentence for the taint notice: exactly what is and is not covered */
  coverage: string;
}

export function taintContainment(cfg: HarnessConfig, network: 'none' | 'registries' = 'none'): TaintContainment {
  const want = requestedRunner(cfg);
  if (want === 'docker' || want === 'podman') {
    const c = { ...cfg, shell: { ...cfg.shell, dockerNetwork: 'none' as const } };
    return { config: c, runner: want, network: 'none', coverage: `shell commands now run in the ${want} sandbox with network off` };
  }
  // N36: the runner is set explicitly (sandbox.runner wins over shell.sandbox), so "none" is lifted to "auto" whichever key said it
  const runner = want === 'none' ? 'auto' : want;
  const sandbox = { ...(cfg.sandbox ?? {}), runner, mode: undefined, network: network === 'registries' ? ('proxy' as const) : ('none' as const), allowDomains: [], allowDomainsPreset: network === 'registries' ? ['registries'] : [] };
  const c: HarnessConfig = { ...cfg, shell: { ...cfg.shell, sandbox: runner === 'landlock' ? 'auto' : runner }, sandbox };
  const sel = selectRunner(c);
  if (sel.kind === 'none')
    return {
      ask: `no OS sandbox is available to cut off network access (${sel.unavailable ?? 'none selected'}), so every shell command needs your approval`,
      coverage: `no OS sandbox is available (${sel.unavailable ?? 'none selected'}), so every shell command now needs approval too`,
    };
  return { config: c, runner: sel.kind, network, coverage: `shell commands now run in the ${sel.kind} sandbox with ${network === 'registries' ? 'network access only to package registries' : 'network access off'}` };
}

/** Data a network tool's URL can carry out: a query, a fragment, userinfo, or a long token-like path segment. */
export function urlCarriesData(u: string): string | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.username || url.password) return 'the URL embeds credentials';
  if (url.search.length > 1) return 'the URL has a query string, which can carry data out';
  if (url.hash.length > 1) return 'the URL has a fragment, which can carry data out';
  if (url.pathname.split('/').some((seg) => seg.length >= 20 && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg) && !/^[a-z]+(?:-[a-z]+)+$/.test(seg))) return 'a URL path segment looks like encoded data';
  return null;
}

export interface TaintGateQuery {
  tool: string;
  input: CheckInput;
  args: unknown;
  /** the policy's reason for its decision */
  reason: string;
}

/** The outbound category this call falls in once the session is tainted, or null (stays as the policy decided). */
export function taintCategory(q: TaintGateQuery, workspace: string): { category: TaintCategory; reason: string } | null {
  // Writes to files that control the agent (config, hooks, AGENTS.md, CI) persist into later sessions.
  if (/controls the agent|always need approval/.test(q.reason)) return { category: 'persistence', reason: q.reason };
  if (q.input.alwaysAsk) return { category: 'persistence', reason: q.input.alwaysAsk };
  const ws = path.resolve(workspace);
  for (const p of q.input.paths ?? []) {
    if (!p.write) continue;
    const rel = path.relative(ws, path.resolve(ws, p.path));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { category: 'outside-workspace-write', reason: `writes outside the workspace: ${p.path}` };
  }
  // The prefilter reports its first hit, which may be another category (credential access, destructive …);
  // judged again without the policy's reason so its path, command, network and MCP checks all get a say.
  for (const reason of [q.reason, '']) {
    let hit: PrefilterHit | null = null;
    try {
      hit = prefilter({ tool: q.tool, input: q.input, args: q.args, reason }, workspace);
    } catch {
      hit = null;
    }
    if (hit && (TAINT_CATEGORIES as readonly string[]).includes(hit.category)) return { category: hit.category as TaintCategory, reason: hit.reason };
  }
  const egress = typeof q.input.command === 'string' ? shellEgress(q.input.command) : null;
  if (egress) return { category: 'exfiltration', reason: egress };
  // network tools (web_fetch, fetch-like MCP/extra tools): a URL can carry data even as a GET. Browser and desktop
  // navigation is governed by their own fence and site allowlist (WS5/WS6): gating every navigation with a query
  // after browser_open (which taints) would make the browser unusable — a documented residual.
  if (q.input.kind === 'network' && !/^(?:browser|desktop)_/.test(q.tool) && q.args && typeof q.args === 'object') {
    const a = q.args as Record<string, unknown>;
    const u = a.url ?? a.uri ?? a.href;
    const why = typeof u === 'string' ? urlCarriesData(u) : null;
    if (why) return { category: 'exfiltration', reason: why };
  }
  return null;
}
