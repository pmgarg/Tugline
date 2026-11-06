/**
 * Slash commands added for CLI parity (v1.2 N49), registered in the shared registry so they also work in VS Code
 * (vscode/src/extension.ts imports this module) and through `tug serve` (session/command). Each is a thin layer
 * over existing core features; none bypasses the permission engine (the ones that change files hand the work to
 * the agent as a prompt, so its edits and commands are asked and journaled like any other).
 *
 * Qwen Code / Cline equivalents: /export, /copy, /diff, /permissions, /rename, /language, /effort, /btw,
 * /recap (/summary), /commit, /bug, /about, /settings, /plan, /approval-mode, /stats, /history, /directory,
 * /trust, /tasks, /docs.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerSlashCommand, type SlashContext } from '../core/commands.js';
import { withAdmissionScope } from '../core/llm/admission.js';
import { reasoningBody, selectOverlay, type ReasoningEffort } from '../core/llm/overlays.js';
import { sandboxStatus } from '../core/sandbox/index.js';
import { TUGLINE_VERSION } from '../core/policy/managed.js';
import { redactSecrets, contentToText } from '../core/util/text.js';
import type { ChatMessage, PermissionMode } from '../core/types.js';
import { exportMessages, listSessions, renameSession } from './sessions.js';
import { NO_EXEC_CONFIG } from '../core/context/worktreeGit.js';

export const TUG_VERSION = TUGLINE_VERSION;

function lastAssistant(msgs: ChatMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && contentToText(msgs[i].content).trim()) return contentToText(msgs[i].content);
  return '';
}

/** Copy text to the clipboard: the OS tool when there is one, else OSC 52 (works over SSH in most terminals). */
export function copyToClipboard(text: string, write: (t: string) => void, opts: { tty?: boolean; run?: (cmd: string, args: string[], input: string) => void } = {}): string {
  const run = opts.run ?? ((cmd, args, input) => execFileSync(cmd, args, { input, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 }));
  const tools: [string, string[]][] = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) {
    try {
      run(cmd, args, text);
      return cmd;
    } catch {
      /* next */
    }
  }
  if (opts.tty ?? process.stdout.isTTY) {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    return 'osc52';
  }
  write(text);
  return 'printed';
}

const reg = (name: string, description: string, run: (args: string, ctx: SlashContext) => Promise<{ prompt?: string } | void> | { prompt?: string } | void, usage?: string) => registerSlashCommand({ name, description, usage, run });

reg('export', 'export this conversation (md, json or html) to a file', async (args, ctx) => {
  const [fmt0, file] = args.trim().split(/\s+/);
  const fmt = (['md', 'json', 'html'].includes(fmt0) ? fmt0 : 'md') as 'md' | 'json' | 'html';
  const out = path.resolve(ctx.workspace, file || path.join('.tugline', 'exports', `${ctx.agent.sessionId}.${fmt}`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // journals and messages are secret-redacted; redact again in case of a pasted key
  fs.writeFileSync(out, redactSecrets(exportMessages(ctx.agent.messages, fmt, `Tugline session ${ctx.agent.sessionId}`)), { mode: 0o600 });
  ctx.write(`exported ${ctx.agent.messages.length} messages to ${out}`);
}, '[md|json|html] [file]');

reg('copy', 'copy the last answer to the clipboard', (_a, ctx) => {
  const t = lastAssistant(ctx.agent.messages);
  if (!t) return void ctx.write('nothing to copy yet');
  const how = copyToClipboard(t, ctx.write, { tty: ctx.surface === 'cli' ? undefined : false });
  ctx.write(how === 'printed' ? '(no clipboard available: printed above)' : `copied ${t.length} characters (${how})`);
});

reg('diff', 'what changed in the workspace (git diff --stat, then the patch of files this session changed)', (_a, ctx) => {
  const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...NO_EXEC_CONFIG, ...args], { cwd: ctx.workspace, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).toString();
  try {
    const stat = git(['diff', '--no-ext-diff', '--no-textconv', '--stat', 'HEAD']).trim();
    const untracked = git(['ls-files', '--others', '--exclude-standard']).trim();
    const files: string[] = (ctx.agent.stats?.filesChanged ?? []).map((f: string) => path.relative(ctx.workspace, path.resolve(ctx.workspace, f)));
    const patch = files.length ? git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...files]).slice(0, 12_000) : '';
    ctx.write([stat || '(no changes to tracked files)', untracked ? `untracked:\n${untracked}` : '', patch ? `\n${redactSecrets(patch)}` : ''].filter(Boolean).join('\n'));
  } catch (e) {
    ctx.write(`not a git repository, or git failed: ${(e as Error).message.split('\n')[0]}`);
  }
});

reg('permissions', 'the permission rules in force (mode, allow, deny, protected paths, extra directories)', (_a, ctx) => {
  const o = ctx.agent.policy.opts;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `    ${x}`).join('\n') : '    (none)');
  ctx.write(`mode: ${o.mode}\nallow:\n${list(o.allow)}\ndeny:\n${list(o.deny)}\nprotected paths:\n${list(o.protectedPaths)}\nextra directories:\n${list(o.additionalDirectories)}${o.writeOnly ? `\nwrites limited to:\n${list(o.writeOnly)}` : ''}\n(edit rules in ~/.tugline/config.json "permissions"; a project config can only add deny rules and protected paths)`);
});

reg('rename', 'give this session a title (shown in history)', (args, ctx) => {
  if (!args.trim()) return void ctx.write('usage: /rename <title>');
  renameSession(ctx.config.homeDir, ctx.workspace, ctx.agent.sessionId, args);
  ctx.write(`session ${ctx.agent.sessionId} renamed to "${args.trim().slice(0, 120)}"`);
}, '<title>');

reg('language', 'reply in another language from now on', (args) => {
  const lang = args.trim();
  if (!lang) return { prompt: undefined };
  return { prompt: `From now on, write your replies in ${lang}. Keep code, identifiers, file paths and command output as they are.` };
}, '<language>');

export const EFFORTS: ReasoningEffort[] = ['off', 'low', 'medium', 'high'];

/** Map an effort onto a profile's request body (the same table as the VS Code picker, B8). */
export function withEffort<P extends { model?: string; extraBody?: Record<string, unknown> }>(p: P, effort: ReasoningEffort): P {
  const extra: Record<string, unknown> = { ...(p.extraBody ?? {}) };
  for (const k of ['reasoning_effort', 'chat_template_kwargs', 'thinking']) delete extra[k];
  return { ...p, extraBody: { ...extra, ...reasoningBody(selectOverlay(p.model ?? ''), effort) } };
}

reg('effort', 'reasoning effort for the next requests (off, low, medium, high)', (args, ctx) => {
  const e = args.trim() as ReasoningEffort;
  if (!EFFORTS.includes(e)) return void ctx.write(`usage: /effort ${EFFORTS.join('|')}`);
  const name = ctx.agent.llm.profile.name ?? ctx.config.profile;
  ctx.config.profiles[name] = withEffort(ctx.config.profiles[name] ?? {}, e);
  ctx.agent.setProfile(name);
  ctx.write(`reasoning effort ${e} (${JSON.stringify(ctx.config.profiles[name].extraBody)})`);
}, 'off|low|medium|high');

reg('btw', 'ask a side question; the answer is not added to the conversation', async (args, ctx) => {
  const q = args.trim();
  if (!q) return void ctx.write('usage: /btw <question>');
  const history = ctx.agent.messages.filter((m: ChatMessage) => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls)).slice(-12);
  const res = await withAdmissionScope({ config: ctx.config, sessionId: ctx.agent.sessionId, depth: 0, kind: 'agent', role: 'btw' }, () =>
    ctx.agent.llm.complete({ messages: [{ role: 'system', content: 'Answer the side question briefly, from the conversation so far. Do not call tools.' }, ...history.map((m: ChatMessage) => ({ role: m.role, content: contentToText(m.content) })), { role: 'user', content: q }], noStream: true, temperature: 0.2 }),
  );
  ctx.write(String(res.text ?? '').trim() || '(no answer)');
}, '<question>');

reg('recap', 'summarize what was done in this session so far', () => ({ prompt: 'Recap this session for me in a few bullet points: what I asked, what you changed (files), what you verified and how, and anything left open. Do not change anything.' }));

reg('commit', 'have the agent write a commit message and commit this task\'s changes (asks like any command)', (args) => ({
  prompt: `Commit the changes made for this task. Look at \`git status\` and \`git diff\` first; stage only files that belong to this task (never unrelated or generated files); write a concise commit message (imperative subject ≤ 72 characters, then a short body explaining why)${args.trim() ? `; the user adds: ${args.trim()}` : ''}. Show me the message, then commit. Do not push.`,
}), '[extra instructions]');

reg('bug', 'open a pre-filled bug report (version, platform, model family; no prompts, keys or paths)', (args, ctx) => {
  const body = `**What happened**\n${args.trim() || '<describe the problem>'}\n\n**Environment**\n- Tugline ${TUG_VERSION}\n- ${os.platform()} ${os.release()} ${os.arch()}, node ${process.version}\n- model family: ${selectOverlay(ctx.agent.llm.profile.model ?? '')?.family ?? 'unknown'}\n- surface: ${ctx.surface}\n- sandbox: ${sandboxStatus(ctx.config).runner}`;
  ctx.write(`Open this URL to file the report (nothing is sent until you submit it):\nhttps://github.com/pmgarg/Tugline/issues/new?title=${encodeURIComponent('bug: ')}&body=${encodeURIComponent(body)}`);
}, '[description]');

reg('about', 'version, platform, model, endpoint, sandbox', (_a, ctx) => {
  const p = ctx.agent.llm.profile;
  let host = '';
  try {
    host = new URL(p.baseUrl).host;
  } catch {
    host = '(invalid base URL)';
  }
  ctx.write(`Tugline ${TUG_VERSION} · node ${process.version} · ${os.platform()}/${os.arch()}\nmodel ${p.model} @ ${host} (profile ${p.name ?? ctx.config.profile}, tool mode ${ctx.agent.llm.dialect})\nmode ${ctx.agent.policy.opts.mode} · sandbox: ${sandboxStatus(ctx.config).summary}\nsession ${ctx.agent.sessionId} · workspace ${ctx.workspace}${ctx.config.trust ? ` (${ctx.config.trust.workspaceTrusted ? 'trusted' : 'untrusted'})` : ''}`);
});

/** The effective config with every secret-looking value removed. */
export function redactedConfig(cfg: any): any {
  const SECRET = /key|token|secret|password|authorization|cookie/i;
  const walk = (v: any, k = ''): any => {
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'managed').map(([kk, vv]) => [kk, walk(vv, kk)]));
    if (Array.isArray(v)) return v.map((x) => walk(x, k));
    if (typeof v === 'string' && (SECRET.test(k) || /^(sk|pk|ghp|gho|xox[abp])[-_]/.test(v)) && v) return '***';
    return v;
  };
  return walk(cfg);
}

reg('settings', 'the effective settings (secrets redacted)', (args, ctx) => {
  const all = redactedConfig(ctx.config);
  const key = args.trim();
  const v = key ? key.split('.').reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), all) : all;
  ctx.write(v === undefined ? `no setting ${key}` : redactSecrets(JSON.stringify(v, null, 2)).slice(0, 8000));
}, '[key.path]');

reg('plan', 'switch to plan mode (read-only until you approve a plan)', (_a, ctx) => {
  ctx.agent.setMode('plan');
  ctx.write('mode: plan');
});

reg('approval-mode', 'show or set the approval mode (ask, acceptEdits, plan, auto)', (args, ctx) => {
  const m = args.trim() as PermissionMode;
  if (['ask', 'acceptEdits', 'plan', 'auto'].includes(m)) {
    ctx.agent.setMode(m);
    ctx.write(`mode: ${ctx.agent.policy.opts.mode}`);
  } else ctx.write(`mode: ${ctx.agent.policy.opts.mode}  (ask | acceptEdits | plan | auto)`);
}, '[mode]');

reg('history', 'saved sessions of this workspace', (_a, ctx) => {
  const s = listSessions(ctx.config.homeDir, ctx.workspace).slice(0, 20);
  ctx.write(s.length ? s.map((x) => `${x.id}  ${new Date(x.mtime).toISOString().slice(0, 16)}  ${x.title}`).join('\n') : 'no saved sessions');
});

reg('stats', 'tokens, cost and tool calls of this session', (_a, ctx) => {
  const t = ctx.agent.totals ?? {};
  ctx.write(`llm calls ${t.llmCalls ?? 0} · prompt ${t.promptTokens ?? 0} + completion ${t.completionTokens ?? 0} tokens · $${(t.costUsd ?? 0).toFixed(4)}`);
});

reg('tasks', 'the task list and background jobs', async (_a, ctx) => {
  const todos = (ctx.agent.todos ?? []).map((t: any) => `  [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`);
  ctx.write(todos.length ? `tasks:\n${todos.join('\n')}` : 'no tasks');
});

reg('directory', 'add a directory the agent may use this session (asks you first)', async (args, ctx) => {
  const [sub, dir] = args.trim().split(/\s+/);
  if (sub === 'show' || !sub) return void ctx.write(`extra directories: ${ctx.agent.policy.opts.additionalDirectories.join(', ') || '(none)'}`);
  if (sub !== 'add' || !dir) return void ctx.write('usage: /directory add <path> | /directory show');
  const abs = path.resolve(ctx.workspace, dir.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return void ctx.write(`${abs} is not a directory`);
  // widening the agent's reach is the human's decision, asked here (never from the model)
  if (!ctx.ask) return void ctx.write('adding a directory needs a person to confirm it, and this surface cannot ask');
  const a = await ctx.ask(`Let the agent read and write ${abs} for this session?`, ['yes', 'no']);
  if (!/^y/i.test(a.trim())) return void ctx.write('not added');
  ctx.agent.policy.opts.additionalDirectories.push(fs.realpathSync(abs));
  ctx.write(`added ${abs} for this session`);
}, 'add <path> | show');

reg('trust', 'whether this workspace\'s own config is trusted, and what was ignored', (_a, ctx) => {
  const t = ctx.config.trust;
  if (!t) return void ctx.write('trust information is not available on this surface');
  ctx.write(t.workspaceTrusted ? 'this workspace is trusted: its .tugline/config.json and .mcp.json apply' : `this workspace is not trusted.${t.ignored.length ? ` Ignored:\n${t.ignored.map((x) => `  - ${x}`).join('\n')}` : ''}\nTrust it (from a terminal, as yourself): tug --trust`);
});

registerSlashCommand({
  name: 'docs',
  description: 'where the documentation is',
  run: (_a, ctx) => void ctx.write('README.md (overview), docs/USER_GUIDE.md (every feature), docs/DESIGN.md (architecture and threat model). Online: https://github.com/pmgarg/Tugline#readme'),
});
