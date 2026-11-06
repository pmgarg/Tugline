#!/usr/bin/env node
/**
 * Tugline CLI.
 *
 *   oh                          interactive session in the current directory
 *   tug -p "fix the failing test" headless: run once, print the answer, exit
 *   tug setup                    configure base URL / API key / model (+ probe)
 *   tug doctor                   check endpoint, tool calling, ripgrep, browser, MCP
 *   tug models                   list models served by the endpoint
 *   tug eval <suite> [...]       run an evaluation suite (EAG S18 style)
 *   tug rescore <outDir>         re-score saved raw runs without calling a model
 *   tug sessions                 list saved sessions for this workspace
 */
import { attachmentBlock } from '../core/util/attachments.js';
import { isPermissionMode, invalidModeMessage, PERMISSION_MODES, YOLO_WARNING } from '../core/approver/modes.js';
import { cliCommands, getCliCommand, getSlashCommand, slashCommands } from '../core/commands.js';
import '../core/tools/providers.js';
import './batch.js';
import './memoryCli.js';
import '../server/register.js'; // WS7: tug serve, tug remote, tug acp
import { statusLineText } from '../core/plugins/statusLine.js'; // WS7 G7
import { costReport, hitPercent } from '../core/cache/meter.js'; // WS10 N10
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { Agent, bundledDirs, type AgentUI } from '../core/agent/agent.js';
import { defaultConfig, loadConfig, readUserConfigFile, resolveProfile, trustWorkspace, writeStarterConfig, type HarnessConfig, type HookConfig } from '../core/config.js';
import { addPendingProjectHooks, hookHash, isHookApproved, type ProjectHook } from '../core/agent/hooks.js';
import { Journal } from '../core/agent/journal.js';
import { LLMClient } from '../core/llm/client.js';
import { probeEndpoint } from '../core/llm/probe.js';
import { cachedProbe } from '../core/llm/overlays.js';
import { expandMentions } from '../core/context/mentions.js';
import { rescore, runEval } from '../core/eval/runner.js';
import { summarizeScores } from '../core/eval/scorer.js';
import type { AgentEvent, PermissionAnswer, PermissionMode, PermissionRequest } from '../core/types.js';
import { killAutomation } from '../core/automation/policy/index.js';
import { sandboxStatus } from '../core/sandbox/index.js';
import { describeManaged, managedWarnings, TUGLINE_VERSION } from '../core/policy/managed.js';
// v1.2 N49 (WS24): CLI parity+
import { collectDenial, initLine, resultLine, StreamRedactor, type Denial, type OutputFormat } from './output.js';
import { knownSecretValues } from '../core/tools/shell.js';
import { isTheme, palette, resolveTheme, THEMES, type Palette } from './theme.js';
import { attachVim } from './vim.js';
import { completionScript } from './completion.js';
import { deleteSession, exportMessages, findSession, listSessions, renameSession } from './sessions.js';
import { checkManaged, ForbiddenFlagError, looseningFlags, looseningWarning } from './flags.js';
import { applySystemCa, describeSystemCa, type SystemCaResult } from './certs.js';
/** RC7: the certificate trust applied at start-up, shown by `tug doctor` */
let caStatus: SystemCaResult | undefined;
import { doctorFix, logTail, RuntimeLog, runtimeLogSettings } from './runtimeLog.js';

/** Subcommands whose `--yes` only confirms their own merge step (review F4). */
const SUBCOMMAND_YES = new Set(['board', 'arena']);
import { EFFORTS, redactedConfig, withEffort } from './slash.js';
import type { ReasoningEffort } from '../core/llm/overlays.js';

/** A wrong flag or flag value: reported without a stack trace (exit 2). */
class UsageError extends Error {}

/** RC3–RC5: notes about flag inputs, printed once on stderr */
const cliNotes: string[] = [];

/** review F13: the runtime log (replaced once the config is known) */
let rlog = new RuntimeLog({ enabled: false, level: 'silent', file: '' });

const VERSION = TUGLINE_VERSION; // package.json (one place to bump at release)
const isTTY = !!stdout.isTTY;
// v1.2 N49: themes (--theme, /theme, cli.theme); NO_COLOR and non-TTY output are plain
let c: Palette = palette(resolveTheme({ tty: isTTY }));

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  const bool = new Set(['no-system-ca', 'trust', 'yes', 'auto', 'json', 'continue', 'text-tools', 'native-tools', 'compact-prompt', 'help', 'version', 'no-mcp', 'verbose', 'allowlist', 'validate', 'acp', 'yolo', 'no-sandbox', 'plan', 'fork-session', 'screen-reader', 'vim']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') out.print = argv[++i] ?? '';
    // N36: `--container` alone, or `--container docker|podman|auto`
    else if (a === '--container') out.container = ['docker', 'podman', 'auto'].includes(argv[i + 1] ?? '') ? argv[++i]! : 'auto';
    else if (a === '-y') (out.yes = true), (out.yesSpelling = '-y');
    else if (a === '-t') out.timeout = argv[++i] ?? '';
    else if (a === '-V') out.version = true;
    else if (a === '-h') out.help = true;
    else if (a === '-v') out.version = true;
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (bool.has(k)) out[k] = true;
      else out[k] = argv[++i] ?? '';
    } else out._.push(a);
  }
  return out;
}

const help = () => `${c.bold('Tugline')} ${VERSION} — an agentic coding harness for any OpenAI-compatible LLM

${c.bold('Usage')}
  tug [options]                 interactive session in the current directory
  tug -p "<prompt>" [options]   run once headless and print the result
  tug setup                     configure your LLM endpoint (base URL, API key, model)
  tug doctor                    diagnose endpoint, tool calling and optional tools
  tug attach [<session>]        join a session running in \`tug serve\` (--server URL --token T, or server.json)
  tug doctor fix                remove stale leases, locks, server.json and leftover worktrees (never kills a process)
  tug doctor log                where the runtime log is, and its last lines (TUG_LOG_ENABLED/TUG_LOG_LEVEL/TUG_LOG_PATH)
  tug models                    list models available at the endpoint
  tug sessions [list|show|export|delete|rename]   saved sessions of this workspace
  tug completion bash|zsh|fish  shell completion script
  tug config [show|get <key>|path]  effective settings (secrets redacted)
  tug eval <suiteDir> [--arms a,b] [--repeats N] [--tasks t1,t2] [--out dir]
  tug rescore <outDir>          re-score saved eval runs (no model calls)

${c.bold('Options')}
  --base-url <url>      OpenAI-compatible base URL (e.g. http://localhost:11434/v1)
  --api-key <key>       API key (or set TUG_API_KEY)
  --model <name>        model name
  --profile <name>      model profile from config
  --mode <m>            ask | acceptEdits | plan | auto | yolo   (default ask)
  --auto                same as --mode auto: a safety classifier approves routine commands, risky ones ask
  --yolo                same as --mode yolo: no approval prompts, no classifier (loud warning)
  -y, --yes             same as --mode yolo (kept for scripts; was "auto" before v1.2)
  --container [engine]  run the whole session in a container (docker | podman; N36): workspace mounted,
                        host home not mounted, network only through the allowlist proxy
  --cwd <dir>           workspace directory (default: current directory)
  --ctx <tokens>        context window of the model (default 32768)
  --text-tools          force the text tool-calling protocol (no native tools)
  --native-tools        force native OpenAI tool calling
  --compact-prompt      shorter system prompt for small models
  --allowlist           run commands without a shell, allowlisted programs only
  --validate            run an independent validator subagent before finishing
  --max-turns <n>       maximum agent turns per prompt
  --max-output <n>      maximum tokens the model may generate per call
  --verbose             show every tool call in headless/eval output
  --acp                 speak the Agent Client Protocol on stdio (same as tug acp)
  --resume <id>         resume a saved session      --continue  resume the latest
  --session-id <id>     use this session id          --fork-session  resume into a new session id
  --output-format <f>   text | json (one result document) | stream-json (JSON lines)   (headless)
  --json                same as --output-format stream-json
  --input-format <f>    text | stream-json (one {"type":"user","text":…} per line on stdin; multi-turn)
  --input-file <path>   read the prompt from a file
  --max-wall-time <s>, -t <s>   stop the run after s seconds      --max-tool-calls <n>   stop after n tool calls
  --allowed-tools a,b   only these tools          --exclude-tools a,b   never these tools
  --allowed-mcp-server-names a,b   start only these MCP servers
  --include-directories a,b        extra directories the agent may use
  --system-prompt <text|@file>     replace the role line of the system prompt (the safety rules stay)
  --append-system-prompt <text|@file>  add instructions to the system prompt
  --output-style <name>  default | concise | explanatory | custom:<name>
  --effort <e>          reasoning effort: off | low | medium | high
  --plan                same as --mode plan
  --yolo                same as --mode auto, with a warning (journaled; managed policy can forbid it)
  --no-sandbox          run commands without the OS sandbox (warning, journaled; managed policy can forbid it)
  --theme <t>           dark | light | high-contrast | none   (NO_COLOR is honoured)   --screen-reader  plain output
  --vim                 vim keys at the prompt (Esc for normal mode)
  --no-system-ca        do not trust the OS certificate store (trusted by default, with NODE_EXTRA_CA_CERTS)
  --home <dir>          use <dir> instead of ~/.tugline for config, sessions and state (TUG_HOME)
  --no-mcp              do not start MCP servers
  --mcp-config <file>   start the MCP servers in <file> ({"mcpServers": …}; warning, journaled; managed policy filters)
  --disable-mcp-server <a,b>  do not start these MCP servers   --allowed-mcp-server-names <a,b>  only these
  --hooks-dir <dir>     add the hooks in <dir>/hooks.json (warning, journaled)
  --disabled-slash-commands <a,b>  switch these /commands off in the REPL
  --trust               trust this workspace's .tugline/config.json and .mcp.json

${c.bold('Config')}  ~/.tugline/config.json, <workspace>/.tugline/config.json, .mcp.json
${c.bold('Env')}     TUG_BASE_URL, TUG_API_KEY, TUG_MODEL, TUG_CONTEXT_WINDOW, TUG_TOOL_MODE`;

function overridesFromArgs(a: Args): any {
  const prof: any = {};
  if (a['base-url']) prof.baseUrl = a['base-url'];
  if (a['api-key']) prof.apiKey = a['api-key'];
  if (a.model) prof.model = a.model;
  if (a.ctx) prof.contextWindow = Number(a.ctx);
  if (a['max-output']) prof.maxOutputTokens = Number(a['max-output']);
  if (a['text-tools']) prof.toolMode = 'text';
  if (a['native-tools']) prof.toolMode = 'native';
  const o: any = { agent: {}, shell: {} };
  if (a.profile) o.profile = a.profile;
  if (Object.keys(prof).length) o.__profile = prof;
  if (a.mode) {
    if (!isPermissionMode(a.mode)) throw new UsageError(invalidModeMessage(a.mode));
    o.permissionMode = a.mode;
  }
  if (a.plan) o.permissionMode = 'plan';
  // N43: `-y/--yes` keeps its meaning (no approval prompts), which is now the mode named yolo.
  // `tug board … --yes` / `tug arena … --yes` confirm the subcommand's own merge; they never set the session mode (review F4)
  const subYes = SUBCOMMAND_YES.has(String(a._[0] ?? ''));
  if ((a.yes && !subYes) || a.yolo) o.permissionMode = 'yolo';
  if (a.auto) o.permissionMode = 'auto';
  if (a['no-sandbox']) o.shell.sandbox = 'none';
  const loosening = looseningFlags(a, { subcommandYes: subYes });
  if (loosening.length) o.cliFlags = { loosening };
  if (a['include-directories']) o.permissions = { additionalDirectories: String(a['include-directories']).split(',').map((d) => path.resolve(d.trim())).filter(Boolean) };
  // review F13: MCP servers from a file (Claude Code's --mcp-config); hooks from a directory (Cline's --hooks-dir).
  // Both run programs the user named: warned and journaled (loosening), and managed policy still filters them.
  if (typeof a['mcp-config'] === 'string') {
    const f = path.resolve(String(a['mcp-config']));
    let j: any;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      throw new UsageError(`--mcp-config ${a['mcp-config']}: ${(e as Error).message}`);
    }
    const servers = j && typeof j === 'object' ? (j.mcpServers ?? j) : undefined;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new UsageError(`--mcp-config ${a['mcp-config']}: expected {"mcpServers": {"name": {...}}}`);
    // RC4: servers from the file are added to the user's (never replace them, never take over one of theirs), and a
    // file can not mark a server trusted: trust stays the user's decision per server (their config, `tug mcp`)
    const mine = (readUserConfigFile(defaultConfig().homeDir).mcpServers ?? {}) as Record<string, unknown>;
    const added: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(servers as Record<string, any>)) {
      if (name in mine) {
        cliNotes.push(`--mcp-config: "${name}" is already one of your servers; the file's definition is ignored`);
        continue;
      }
      if (!def || typeof def !== 'object') continue;
      const { trusted: _trusted, ...rest } = def;
      if (_trusted) cliNotes.push(`--mcp-config: "${name}" asks to be trusted; servers from a file are not (their tools ask until you trust the server)`);
      added[name] = { ...rest, trusted: false };
    }
    o.mcpServers = added;
  }
  if (typeof a['hooks-dir'] === 'string') {
    // RC3: read here, ADDED to the user's hooks after the config is loaded (buildConfig)
    const f = path.join(path.resolve(String(a['hooks-dir'])), 'hooks.json');
    let j: any;
    try {
      j = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      throw new UsageError(`--hooks-dir ${a['hooks-dir']}: ${f}: ${(e as Error).message}`);
    }
    o.__hooksDir = { dir: path.resolve(String(a['hooks-dir'])), hooks: j?.hooks ?? j };
  }
  if (typeof a['output-style'] === 'string') o.outputStyle = a['output-style'];
  if (typeof a.theme === 'string' || a.vim) o.cli = { ...(typeof a.theme === 'string' ? { theme: a.theme } : {}), ...(a.vim ? { vim: true } : {}) };
  if (a['compact-prompt']) o.agent.promptStyle = 'compact';
  if (a['max-turns']) o.agent.maxTurns = Number(a['max-turns']);
  if (a.validate) o.agent.autoValidate = true;
  if (a.allowlist) o.shell.mode = 'allowlist';
  return o;
}

function buildConfig(a: Args, workspace: string): HarnessConfig {
  const o = overridesFromArgs(a);
  const prof = o.__profile;
  delete o.__profile;
  const hooksDir = o.__hooksDir as { dir: string; hooks: Record<string, HookConfig[]> } | undefined;
  delete o.__hooksDir;
  const cfg = loadConfig({ workspace, overrides: o });
  if (hooksDir) {
    // RC3: added per event to the user's (and managed) hooks; RC5: from a directory inside the workspace, each hook
    // needs the approval project hooks need (`/hooks approve`), otherwise it does not run
    const real = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    const rel = path.relative(real(workspace), real(hooksDir.dir));
    const inWorkspace = !rel.startsWith('..') && !path.isAbsolute(rel);
    const pending: ProjectHook[] = [];
    for (const [event, list] of Object.entries(hooksDir.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (!h || typeof h.command !== 'string') continue;
        const hash = hookHash(event, h);
        if (inWorkspace && !isHookApproved(cfg.homeDir, workspace, hash)) {
          pending.push({ event, hook: h, hash, source: `--hooks-dir ${path.relative(workspace, hooksDir.dir) || '.'}`, approved: false });
          continue;
        }
        const cur = (cfg.hooks[event] ??= []);
        if (!cur.some((x) => hookHash(event, x) === hash)) cur.push(h);
      }
    }
    if (pending.length) {
      addPendingProjectHooks(cfg, pending);
      cliNotes.push(`--hooks-dir is inside the workspace: ${pending.length} hook(s) from it wait for your approval and do not run (/hooks approve in the REPL)`);
    }
  }
  if (prof) cfg.profiles[cfg.profile] = { ...(cfg.profiles[cfg.profile] ?? {}), ...prof };
  // v1.2 N49: narrowing flags apply after every config layer
  if (typeof a['disable-mcp-server'] === 'string') {
    // review F13: narrowing only (Qwen --disable-mcp-server)
    const drop = new Set(String(a['disable-mcp-server']).split(',').map((x) => x.trim()));
    cfg.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers).filter(([n]) => !drop.has(n)));
  }
  if (typeof a['allowed-mcp-server-names'] === 'string') {
    const keep = new Set(String(a['allowed-mcp-server-names']).split(',').map((x) => x.trim()));
    cfg.mcpServers = Object.fromEntries(Object.entries(cfg.mcpServers).filter(([n]) => keep.has(n)));
  }
  if (typeof a.effort === 'string') {
    if (!EFFORTS.includes(a.effort as ReasoningEffort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
    cfg.profiles[cfg.profile] = withEffort(cfg.profiles[cfg.profile] ?? {}, a.effort as ReasoningEffort);
  }
  return cfg;
}

function summarizeArgs(args: unknown): string {
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return s.length > 140 ? s.slice(0, 139) + '…' : s;
}

function diffPreview(before: string, after: string, max = 40): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const lines: string[] = [];
  for (let i = Math.max(0, s - 2); i < s; i++) lines.push(c.dim(`  ${a[i]}`));
  for (let i = s; i <= ea; i++) lines.push(c.red(`- ${a[i]}`));
  for (let i = s; i <= eb; i++) lines.push(c.green(`+ ${b[i]}`));
  for (let i = ea + 1; i < Math.min(a.length, ea + 3); i++) lines.push(c.dim(`  ${a[i]}`));
  return lines.length > max ? lines.slice(0, max).join('\n') + c.dim(`\n  … ${lines.length - max} more lines`) : lines.join('\n');
}

/**
 * Buffered line input. readline's question() only captures the line typed while
 * it is pending; lines typed ahead (or piped in) while a run or a command is
 * busy would be lost. Here every line is queued until something asks for it.
 */
class LineInput {
  private lines: string[] = [];
  private waiters: ((l: string | null) => void)[] = [];
  private closed = false;
  constructor(readonly rl: readline.Interface) {
    rl.on('line', (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    rl.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }
  /**
   * Show the prompt. Piped input (`printf '/context\n' | tug`) is often read to
   * EOF before the first prompt, and since Node 24 `rl.prompt()` on a closed
   * interface throws ERR_USE_AFTER_CLOSE (Node 22 ignored it), which ended
   * scripted sessions before their first queued line (R7: D13 AC1, G7 AC2 on
   * Node 26). Without a TTY readline only writes the prompt anyway, so write it
   * ourselves; on a TTY let readline draw it while the interface is open.
   */
  private showPrompt(prompt: string): void {
    if (this.closed || !stdin.isTTY) {
      stdout.write(prompt);
      return;
    }
    this.rl.setPrompt(prompt);
    this.rl.prompt(true);
  }
  async question(prompt: string): Promise<string> {
    this.showPrompt(prompt);
    if (this.lines.length) {
      const l = this.lines.shift()!;
      if (!stdin.isTTY) stdout.write(l + '\n');
      return l;
    }
    if (this.closed) throw new Error('input closed');
    const l = await new Promise<string | null>((r) => this.waiters.push(r));
    if (l === null) throw new Error('input closed');
    if (!stdin.isTTY) stdout.write(l + '\n');
    return l;
  }
}

class TerminalUI {
  private streaming = false;
  private inReasoning = false;
  rl?: LineInput;
  json = false;
  verbose = false;

  out: NodeJS.WritableStream;
  constructor(private headless: boolean) {
    this.out = headless ? process.stderr : stdout;
  }

  ui(): AgentUI {
    return {
      onEvent: (e) => this.onEvent(e),
      requestPermission: this.headless ? undefined : (r) => this.permission(r),
      askUser: this.headless ? undefined : (q, o) => this.ask(q, o),
      approvePlan: this.headless ? undefined : (p) => this.approvePlan(p),
    };
  }

  private endStream(): void {
    if (this.streaming || this.inReasoning) this.out.write('\n');
    this.streaming = false;
    this.inReasoning = false;
  }

  /** review F15: what the CLI prints goes through the journal's redaction */
  readonly redactor = new StreamRedactor(knownSecretValues);

  onEvent(e: AgentEvent): void {
    if (e.type === 'text_delta') {
      const safe = this.redactor.push(e.text);
      if (!safe) return;
      e = { ...e, text: safe };
    } else if (e.type !== 'reasoning_delta') {
      const rest = this.redactor.flush();
      if (rest) this.emitOut({ type: 'text_delta', text: rest } as AgentEvent);
      e = this.redactor.whole(e);
    }
    this.emitOut(e);
  }

  /** print text still held back by the redactor (end of the run) */
  flushText(): void {
    const rest = this.redactor.flush();
    if (rest) this.emitOut({ type: 'text_delta', text: rest } as AgentEvent);
  }

  private emitOut(e: AgentEvent): void {
    if (this.json) {
      if (e.type !== 'reasoning_delta') stdout.write(JSON.stringify(e) + '\n');
      return;
    }
    switch (e.type) {
      case 'reasoning_delta':
        if (!this.verbose) return;
        if (!this.inReasoning) {
          this.endStream();
          this.out.write(c.dim('thinking: '));
          this.inReasoning = true;
        }
        this.out.write(c.dim(e.text));
        return;
      case 'text_delta':
        if (this.inReasoning) {
          this.out.write('\n');
          this.inReasoning = false;
        }
        if (!this.streaming) {
          this.out.write(c.bold('● ') );
          this.streaming = true;
        }
        this.out.write(e.text);
        return;
      case 'tool_start':
        this.endStream();
        this.out.write(`${c.cyan('⏺')} ${c.bold(e.title)}\n`);
        return;
      case 'tool_end': {
        const first = e.output.split('\n').find((l) => l.trim()) ?? '';
        const lines = e.output.split('\n').length;
        const status = e.ok ? c.dim(`  ⎿ ${first.slice(0, 110)}${lines > 1 ? c.dim(` (+${lines - 1} lines)`) : ''}`) : c.red(`  ⎿ ${first.slice(0, 160)}`);
        this.out.write(`${status}\n`);
        return;
      }
      case 'refusal':
        this.out.write(c.yellow(`  ⛔ refused ${e.tool}: ${e.reason}\n`));
        return;
      case 'todos':
        this.endStream();
        if (!e.todos.length) return;
        this.out.write(c.magenta('  Tasks:\n') + e.todos.map((t) => `   ${t.status === 'completed' ? c.green('✔') : t.status === 'in_progress' ? c.yellow('▶') : '○'} ${t.status === 'completed' ? c.dim(t.content) : t.content}`).join('\n') + '\n');
        return;
      case 'compaction':
        this.out.write(c.dim(`  [context compacted: ~${e.beforeTokens} → ~${e.afterTokens} tokens (${e.strategy})]\n`));
        return;
      case 'usage': {
        // N10: per-call prompt-cache reuse (verbose only)
        if (!this.verbose) return;
        const pct = hitPercent(e.usage.cachedTokens, e.usage.promptTokens);
        this.endStream();
        this.out.write(c.dim(`  [call ${e.role ?? 'main'}: ${e.usage.promptTokens} prompt${pct !== undefined ? ` (${pct}% cached)` : ''} + ${e.usage.completionTokens} out · ${(e.latencyMs / 1000).toFixed(1)}s]\n`));
        return;
      }
      case 'cache_break':
        // N10: compaction is already reported above; other prefix changes say why the next call is slower
        if (e.causes.length === 1 && e.causes[0] === 'compaction' && !this.verbose) return;
        this.endStream();
        this.out.write(c.dim(`  [cache] prompt prefix changed (${e.detail}); the server re-reads ~${e.invalidatedTokens} tokens\n`));
        return;
      case 'notice':
        rlog.write(e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info', e.message);
        this.endStream();
        this.out.write((e.level === 'error' ? c.red : e.level === 'warn' ? c.yellow : c.dim)(`  [${e.level}] ${e.message}\n`));
        return;
      case 'subagent':
        this.endStream();
        this.out.write(c.magenta(`  ${e.phase === 'start' ? '↳ subagent' : '↲ subagent done'} (${e.agentType}): ${e.description}\n`));
        return;
      case 'assistant_message':
        this.endStream();
        return;
      case 'run_end': {
        this.endStream();
        const s = e.stats;
        this.out.write(c.dim(`  [${e.stopReason} · ${s.turns} turns · ${s.toolCalls} tools · ${s.promptTokens + s.completionTokens} tok${s.costUsd ? ` · $${s.costUsd.toFixed(4)}` : ''} · ${(s.durationMs / 1000).toFixed(1)}s]\n`));
        if (e.stopReason !== 'end_turn' && e.finalText) this.out.write(c.yellow(`  ${e.finalText}\n`));
        // v1.1 R2: whether the work was verified, separate from why the loop stopped
        if (e.completion && e.completion.state !== 'not_applicable') {
          const k = e.completion.state;
          const paint = k === 'verified' ? c.green : k === 'failed' ? c.red : c.yellow;
          this.out.write(paint(`  ${k === 'verified' ? '✓ verified' : k === 'failed' ? '✗ check failed' : '? unverified'}: ${e.completion.summary}\n`));
        }
        return;
      }
      default:
        return;
    }
  }

  async permission(r: PermissionRequest): Promise<PermissionAnswer> {
    this.endStream();
    this.out.write(c.yellow(`\n  ⚠ Permission needed: ${r.title}`) + (r.reason ? c.dim(` (${r.reason})`) : '') + '\n');
    if (r.diff) this.out.write(diffPreview(r.diff.before, r.diff.after) + '\n');
    else if (r.detail && r.detail !== r.title) this.out.write(c.dim(r.detail.split('\n').slice(0, 20).join('\n')) + '\n');
    const ans = ((await this.rl!.question(`  Allow? ${c.bold('[y]')}es${r.suggestedRule ? ` / ${c.bold('[a]')}lways ${c.dim(`(${r.suggestedRule})`)}` : ''} / ${c.bold('[N]')}o: `)) || 'n').trim().toLowerCase();
    if ((ans === 'a' || ans === 'always') && r.suggestedRule) return { decision: 'allow', always: true };
    if (ans === 'y' || ans === 'yes') return { decision: 'allow' };
    const fb = (await this.rl!.question('  Tell the agent what to do instead (optional): ')).trim();
    return { decision: 'deny', feedback: fb || undefined };
  }

  async ask(q: string, options?: string[]): Promise<string> {
    this.endStream();
    this.out.write(c.cyan(`\n  ? ${q}\n`));
    options?.forEach((o, i) => this.out.write(`    ${i + 1}. ${o}\n`));
    const a = (await this.rl!.question('  > ')).trim();
    const n = Number(a);
    return options && n >= 1 && n <= options.length ? options[n - 1] : a;
  }

  async approvePlan(plan: string): Promise<boolean> {
    this.endStream();
    this.out.write(c.cyan('\n  ── Proposed plan ──\n') + plan + '\n');
    const a = ((await this.rl!.question('  Approve and start implementing? [y/n]: ')) || 'n').trim().toLowerCase();
    return a.startsWith('y');
  }
}

async function cmdSetup(a: Args): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY });
  // Buffered like the REPL: piped answers (`printf 'default\n…' | tug setup`) are queued, not lost; a missing answer takes the default.
  const lines = new LineInput(rl);
  const ask = (q: string) => lines.question(q).catch(() => '');
  const home = path.join(os.homedir(), '.tugline');
  stdout.write(`${c.bold('Tugline setup')}\nPoint the harness at any OpenAI-compatible endpoint. Examples:\n  Ollama     http://localhost:11434/v1\n  LM Studio  http://localhost:1234/v1\n  llama.cpp  http://localhost:8080/v1\n  vLLM       http://<host>:8000/v1\n  OpenRouter https://openrouter.ai/api/v1\n  DeepSeek   https://api.deepseek.com/v1\n\n`);
  const name = ((await ask('Profile name [default]: ')) || 'default').trim();
  const baseUrl = ((a['base-url'] as string) || (await ask('Base URL [http://localhost:11434/v1]: ')) || 'http://localhost:11434/v1').trim();
  const apiKey = ((a['api-key'] as string) || (await ask('API key (leave empty if none; "env:VAR" to read from an env var): '))).trim();
  const profile: any = { name, baseUrl, apiKey, toolMode: 'auto' };
  const client = new LLMClient({ ...resolveProfile(loadConfig({ workspace: process.cwd(), noUserConfig: true })), ...profile, apiKey: apiKey.startsWith('env:') ? process.env[apiKey.slice(4)] ?? '' : apiKey });
  let models: string[] = [];
  try {
    models = await client.listModels();
    stdout.write(c.green(`✔ reachable; ${models.length} model(s)\n`) + models.slice(0, 30).map((m) => `   - ${m}`).join('\n') + '\n');
  } catch (e) {
    stdout.write(c.yellow(`! could not list models: ${(e as Error).message}\n`));
  }
  profile.model = ((a.model as string) || (await ask(`Model name${models[0] ? ` [${models[0]}]` : ''}: `)) || models[0] || '').trim();
  profile.contextWindow = Number((await ask('Context window in tokens [32768]: ')) || 32768);
  rl.close();
  stdout.write('Probing tool-calling support…\n');
  const rep = (await cachedProbe({ ...resolveProfile(loadConfig({ workspace: process.cwd(), noUserConfig: true })), ...profile, apiKey: apiKey.startsWith('env:') ? process.env[apiKey.slice(4)] ?? '' : apiKey }, home, { force: true })).report;
  printProbe(rep);
  profile.toolMode = rep.nativeTools ? 'native' : rep.textTools ? 'text' : 'auto';
  const file = writeStarterConfig(home, profile);
  stdout.write(c.green(`\n✔ saved profile "${name}" to ${file}\n`) + `Run ${c.bold('tug')} in a project directory to start.\n`);
}

function printProbe(r: Awaited<ReturnType<typeof probeEndpoint>>): void {
  const ok = (b: boolean) => (b ? c.green('yes') : c.red('no'));
  stdout.write(`  reachable:          ${ok(r.reachable)}\n  model listed:       ${r.modelListed === undefined ? 'n/a' : ok(r.modelListed)}\n  chat works:         ${ok(r.chatOk)}\n  native tool calls:  ${ok(r.nativeTools)}\n  text tool protocol: ${r.textToolsTested ? ok(r.textTools) : 'not needed (native tool calls work)'}\n  usage reported:     ${ok(r.usageReported)}\n  reasoning channel:  ${r.reasoningSeen ? 'yes' : 'no'}\n  latency:            ${r.latencyMs ?? '?'} ms${r.tokensPerSecond ? ` (~${r.tokensPerSecond} tok/s incl. prompt)` : ''}\n  → recommended toolMode: ${c.bold(r.recommendedToolMode)}\n`);
  for (const e of r.errors) stdout.write(c.yellow(`  ! ${e}\n`));
}

async function cmdDoctor(cfg: HarnessConfig, workspace: string): Promise<void> {
  const p = resolveProfile(cfg);
  stdout.write(`${c.bold('Endpoint')} ${p.baseUrl}  model=${p.model}  toolMode=${p.toolMode}  ctx=${p.contextWindow}\n`);
  printProbe((await cachedProbe(p, cfg.homeDir, { force: true })).report);
  const { spawnSync } = await import('node:child_process');
  const rg = spawnSync('rg', ['--version']);
  stdout.write(`${c.bold('ripgrep')}     ${rg.status === 0 ? c.green('found') : c.yellow('not found (JS fallback grep is used)')}\n`);
  let pw = false;
  try {
    await import('playwright' as string);
    pw = true;
  } catch {
    /* none */
  }
  stdout.write(`${c.bold('playwright')}  ${pw ? c.green('found') : c.yellow('not found (screenshot tool unavailable: npm i -g playwright)')}\n`);
  stdout.write(`${c.bold('search')}      ${cfg.web.searchProvider}\n`);
  // RC7: the OS certificate store (review F13)
  if (caStatus) stdout.write(`${c.bold('certificates')} ${caStatus.applied ? c.green(describeSystemCa(caStatus)) : c.yellow(describeSystemCa(caStatus))}\n`);
  // N30: what model commands run under
  const sbx = sandboxStatus(cfg);
  stdout.write(`${c.bold('sandbox')}     ${sbx.runner !== 'none' ? c.green(sbx.summary) : sbx.refusing ? c.red(sbx.summary) : c.yellow(sbx.summary)}\n`);
  // C4/N22: the managed policy, and what an admin should fix about it
  stdout.write(`${c.bold('managed')}     ${describeManaged(cfg)}\n`);
  for (const w of managedWarnings(cfg)) stdout.write(`${c.bold('managed')}     ${c.yellow(`warning: ${w}`)}\n`);
  const agent = await Agent.create({ workspace, config: cfg, journal: false, ...dirs() });
  for (const s of agent.mcp?.status() ?? []) stdout.write(`${c.bold('mcp')} ${s.name}: ${s.status === 'connected' ? c.green(`connected (${s.tools} tools)`) : c.red(`${s.status} ${s.error ?? ''}`)}\n`);
  stdout.write(`${c.bold('skills')}      ${agent.skills.list().map((s) => s.name).join(', ') || '(none)'}\n`);
  await agent.dispose();
}

function dirs(): { bundledSkillsDir?: string; bundledAgentsDir?: string } {
  const d = bundledDirs(fileURLToPath(import.meta.url));
  return { bundledSkillsDir: d.skills, bundledAgentsDir: d.agents };
}

const SLASH_HELP = `  /help                 this help
  /mode <ask|acceptEdits|plan|auto|yolo>   change permission mode
  /model [profile]      show or switch model profile
  /models               list models at the endpoint
  /cost                 token and cost totals for this session
  /todos                show the task list
  /tools  /skills  /mcp list what the agent can use
  /compact [focus]      compact the conversation now (optional focus for the summary)
  /undo [n|all]         revert the agent's last file change(s)
  /clear                start a fresh conversation
  /sessions             list saved sessions   /resume <id>  load one
  /init                 create an AGENTS.md describing this project
  /theme [name]         colour theme (dark, light, high-contrast, none)
  /vim                  toggle vim keys at the prompt
  /fork                 continue in a new session with a copy of this conversation
  line ending in \      continue the prompt on the next line
  @path  @dir/          attach a file (optionally @file:10-40) or a folder listing to your prompt
  /<skill-name> [args]  run a skill explicitly
  /exit                 quit            (Ctrl+C during a run cancels it)`;

async function interactive(agent: Agent, ui: TerminalUI, cfg: HarnessConfig, workspace: string, a: Args = { _: [] }): Promise<void> {
  const disabledSlash = new Set(typeof a['disabled-slash-commands'] === 'string' ? a['disabled-slash-commands'].split(',').map((x) => x.trim().replace(/^\//, '').toLowerCase()).filter(Boolean) : []);
  // terminal mode only on a real TTY, so scripted sessions (`printf '/context\n' | tug`) work too
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: !!stdin.isTTY, historySize: 500 });
  const input = new LineInput(rl);
  // v1.2 N49: vim keys at the prompt (--vim, /vim, or "cli": {"vim": true})
  let detachVim: (() => void) | undefined = stdin.isTTY && (a.vim || cfg.cli?.vim) ? attachVim(rl) : undefined;
  ui.rl = input;
  const p = agent.llm.profile;
  stdout.write(`${c.bold('Tugline')} ${VERSION} · ${c.cyan(p.model)} @ ${p.baseUrl} · mode ${c.yellow(agent.policy.mode)} · ${workspace}\n${c.dim(sandboxStatus(cfg).summary)}\n${c.dim('Type a request, /help for commands, Ctrl+C to cancel a run, /exit to quit.')}\n`);
  if (!p.apiKey && /openrouter|deepseek|together|groq|fireworks|nebius|deepinfra|mistral/.test(p.baseUrl)) stdout.write(c.yellow('  ! no API key set for a hosted endpoint. Run "tug setup" or set TUG_API_KEY.\n'));
  let ctrlC = 0;
  let lastRunCtrlC = 0;
  rl.on('SIGINT', () => {
    if (agent.isRunning) {
      // SPEC F7: Ctrl+C twice during a run is the automation kill switch (desktop and browser input stops too).
      if (Date.now() - lastRunCtrlC < 2000) {
        killAutomation('Ctrl+C ×2');
        stdout.write(c.yellow('\n  [automation kill switch: all desktop/browser automation stopped; /desktop resume to allow it again]\n'));
      }
      lastRunCtrlC = Date.now();
      agent.abort();
      stdout.write(c.yellow('\n  [cancelling…]\n'));
    } else if (++ctrlC >= 2) process.exit(0);
    else stdout.write(c.dim('\n  (press Ctrl+C again or type /exit to quit)\n'));
  });
  for (;;) {
    let line: string;
    try {
      const status = await statusLineText(agent, cfg, workspace).catch(() => ''); // WS7 G7
      line = await input.question((status ? `\n${status}` : '') + c.bold('\n› '));
    } catch (e) {
      if ((e as Error).message !== 'input closed') process.stderr.write(c.red(`input error: ${(e as Error).message}\n`));
      break;
    }
    ctrlC = 0;
    // multi-line input: a line ending in a backslash continues on the next line
    while (line.endsWith('\\')) {
      let more: string;
      try {
        more = await input.question(c.dim('… '));
      } catch {
        break;
      }
      line = `${line.slice(0, -1)}\n${more}`;
    }
    line = line.trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd0, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      // review F13 (Qwen --disabled-slash-commands): commands switched off for this session
      if (disabledSlash.has(cmd0.toLowerCase()) && !['exit', 'quit', 'help'].includes(cmd0)) {
        stdout.write(c.yellow(`/${cmd0} is disabled for this session (--disabled-slash-commands)\n`));
        continue;
      }
      // Registered commands may replace built-ins (e.g. /undo on checkpoints), except the essentials.
      const cmd = getSlashCommand(cmd0) && !['exit', 'quit', 'help'].includes(cmd0) ? `__registered__${cmd0}` : cmd0;
      switch (cmd) {
        case 'exit':
        case 'quit':
          rl.close();
          await agent.dispose();
          return;
        case 'help':
          {
            // Registered commands replace built-ins of the same name (e.g. /undo on checkpoints): list each once.
            const reg = slashCommands();
            const builtin = SLASH_HELP.split('\n').filter((l) => !reg.some((x) => new RegExp(`^\\s+/${x.name}\\b`).test(l) && !['exit', 'quit', 'help'].includes(x.name)));
            stdout.write(builtin.join('\n') + '\n' + reg.map((x) => `  /${x.name}${x.usage ? ' ' + x.usage : ''}  ${x.description}`).join('\n') + '\n');
          }
          continue;
        case 'theme':
          if (isTheme(arg)) {
            c = palette(resolveTheme({ flag: arg, tty: isTTY }));
            stdout.write(`  theme: ${arg}${resolveTheme({ flag: arg, tty: isTTY }) !== arg ? ' (colour is off: NO_COLOR or not a terminal)' : ''}\n`);
          } else stdout.write(`  themes: ${THEMES.join(', ')}  (set "cli": {"theme": "…"} in ~/.tugline/config.json to keep one)\n`);
          continue;
        case 'vim':
          if (detachVim) {
            detachVim();
            detachVim = undefined;
            stdout.write('  vim mode off\n');
          } else if (stdin.isTTY) {
            detachVim = attachVim(rl);
            stdout.write('  vim mode on (Esc: normal mode, i/a: insert)\n');
          } else stdout.write('  vim mode needs a terminal\n');
          continue;
        case 'fork': {
          // continue in a new session with a copy of this conversation (the original stays as it was)
          const forked = await Agent.create({ workspace, config: cfg, ui: ui.ui(), surface: 'terminal', mcp: true, ...dirs() });
          forked.loadHistory(agent.messages.slice());
          await agent.dispose();
          agent = forked;
          stdout.write(`  forked into session ${agent.sessionId} (${agent.messages.length} messages)\n`);
          continue;
        }
        case 'mode':
          if (isPermissionMode(arg)) {
            agent.setMode(arg);
            if (arg === 'yolo') stdout.write(c.yellow(`  ${YOLO_WARNING}\n`));
          } else stdout.write(`  ${arg ? invalidModeMessage(arg) + '\n  ' : ''}mode: ${agent.policy.mode}  (${PERMISSION_MODES.join(' | ')})\n`);
          continue;
        case 'model':
          if (arg) {
            try {
              const np = agent.setProfile(arg);
              stdout.write(`  switched to ${np.model} @ ${np.baseUrl}\n`);
            } catch (e) {
              stdout.write(c.red(`  ${(e as Error).message}\n`));
            }
          } else stdout.write(`  ${agent.llm.profile.name}: ${agent.llm.profile.model} @ ${agent.llm.profile.baseUrl} (tool mode ${agent.llm.dialect})\n  profiles: ${Object.keys(cfg.profiles).join(', ')}\n`);
          continue;
        case 'models':
          try {
            stdout.write((await agent.llm.listModels()).map((m) => `  - ${m}`).join('\n') + '\n');
          } catch (e) {
            stdout.write(c.red(`  ${(e as Error).message}\n`));
          }
          continue;
        case 'cost':
          stdout.write(`  ${costReport(agent).replace(/\n/g, '\n  ')}\n`); // N10: + prompt-cache hit rate
          continue;
        case 'todos':
          stdout.write(agent.todos.map((t) => `  [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`).join('\n') + '\n');
          continue;
        case 'tools':
          stdout.write(agent.toolList.map((t) => `  - ${t.name} (${t.kind})`).join('\n') + '\n');
          continue;
        case 'skills':
          stdout.write(agent.skills.list().map((s) => `  - ${s.name} [${s.source}]: ${s.description}`).join('\n') + '\n' || '  (no skills)\n');
          continue;
        case 'mcp':
          stdout.write((agent.mcp?.status() ?? []).map((s) => `  - ${s.name}: ${s.status} (${s.tools} tools)${s.error ? ' ' + s.error : ''}`).join('\n') + '\n' || '  (no MCP servers configured)\n');
          continue;
        case 'compact':
          await agent.compactNow(true, arg || undefined);
          continue;
        case 'undo': {
          const n = arg === 'all' ? agent.editHistory.length : Math.max(1, Number(arg) || 1);
          const r = agent.undo(n);
          stdout.write(r.restored.length ? `  restored: ${r.restored.join(', ')}\n` : '  nothing to undo\n');
          if (r.skipped.length) stdout.write(c.yellow(`  skipped: ${r.skipped.join(', ')}\n`));
          continue;
        }
        case 'clear':
          agent.clear();
          stdout.write('  conversation cleared\n');
          continue;
        case 'sessions':
          for (const s of Journal.listSessions(cfg.homeDir, workspace).slice(0, 15)) stdout.write(`  ${s.id}  ${c.dim(new Date(s.mtime).toLocaleString())}  ${s.firstPrompt.slice(0, 60)}\n`);
          continue;
        case 'resume': {
          const s = Journal.listSessions(cfg.homeDir, workspace).find((x) => x.id.startsWith(arg));
          if (!s) stdout.write(c.red('  no such session\n'));
          else {
            agent.loadHistory(Journal.loadMessages(s.file));
            stdout.write(`  resumed ${s.id} (${agent.messages.length} messages)\n`);
          }
          continue;
        }
        case 'init':
          line = 'Analyse this repository (structure, languages, build/test/lint commands, conventions, key modules) and create or update AGENTS.md at the workspace root with concise, accurate instructions for AI coding agents working here. Verify commands exist before documenting them.';
          break;
        default: {
          const reg = getSlashCommand(cmd.replace(/^__registered__/, ''));
          if (reg) {
            try {
              const r = await reg.run(arg, { agent, config: cfg, workspace, write: (t) => stdout.write(t.endsWith('\n') ? t : t + '\n'), surface: 'cli' });
              if (r && r.prompt) {
                line = r.prompt;
                break;
              }
            } catch (e) {
              stdout.write(c.red(`  /${cmd0} failed: ${(e as Error).message}\n`));
            }
            continue;
          }
          const sk = agent.skills.get(cmd0);
          if (sk) {
            line = `Use the "${sk.name}" skill (call load_skill first). ${arg}`.trim();
            break;
          }
          stdout.write(c.red(`  unknown command /${cmd0}. /help for the list\n`));
          continue;
        }
      }
    }
    try {
      await agent.run(attachMentions(line, workspace, agent));
      await agent.idle(); // prompts queued/steered during the run
    } catch (e) {
      stdout.write(c.red(`  error: ${(e as Error).message}\n`));
    }
  }
}

/** Expand @file / @folder mentions (SPEC D13); reads go through the permission engine. */
function attachMentions(line: string, workspace: string, agent: Agent): string {
  const r = expandMentions(line, workspace, { policy: agent.policy });
  for (const a of r.attached) process.stderr.write(c.dim(`  [attached ${a.source}${a.kind === 'file' ? ` (${a.lines} lines)` : ` (${a.entries} entries)`}]\n`));
  for (const x of r.skipped) process.stderr.write(c.yellow(`  [not attached ${x.source}: ${x.reason}]\n`));
  return r.text;
}

/** v1.2 N49: `--system-prompt` / `--append-system-prompt` (text or @file) → the role line of the system prompt. */
function roleFromArgs(a: Args, surface: string): string | undefined {
  const read = (v: unknown) => (typeof v === 'string' && v.startsWith('@') ? fs.readFileSync(path.resolve(v.slice(1)), 'utf8') : typeof v === 'string' ? v : undefined);
  const replace = read(a['system-prompt']);
  const append = read(a['append-system-prompt']);
  if (!replace && !append) return undefined;
  const base = replace ?? `You are Tugline, an autonomous AI agent for software engineering, research and automation, running in the user's ${surface}. You complete tasks by calling tools, then report back concisely.`;
  return append ? `${base}\n\n# Additional instructions from the user\n${append.trim()}` : base;
}

/** v1.2 N49: `--allowed-tools` / `--exclude-tools` (narrowing only). */
function toolFilterFromArgs(a: Args): ((t: { name: string }) => boolean) | undefined {
  const list = (v: unknown) => (typeof v === 'string' ? new Set(v.split(',').map((x) => x.trim()).filter(Boolean)) : undefined);
  const allow = list(a['allowed-tools']);
  const deny = list(a['exclude-tools']);
  if (!allow && !deny) return undefined;
  return (t) => (!allow || allow.has(t.name)) && !deny?.has(t.name);
}

async function sessionsCommand(a: Args, cfg: HarnessConfig, workspace: string): Promise<void> {
  const [, sub = 'list', id, ...rest] = a._;
  const need = () => {
    const s = id ? findSession(cfg.homeDir, workspace, id) : undefined;
    if (!s) throw new Error(`no saved session ${id ?? ''} (tug sessions list)`);
    return s;
  };
  switch (sub) {
    case 'list':
      if (a['output-format'] === 'json' || a.json) stdout.write(JSON.stringify(listSessions(cfg.homeDir, workspace).map((s) => ({ id: s.id, title: s.title, mtime: s.mtime })), null, 2) + '\n');
      else {
        const all = listSessions(cfg.homeDir, workspace);
        // review F17: say so when there is nothing to list
        if (!all.length) stdout.write(`no saved sessions for ${workspace}\n`);
        for (const s of all) stdout.write(`${s.id}  ${new Date(s.mtime).toISOString()}  ${s.title}\n`);
      }
      return;
    case 'show': {
      const s = need();
      const msgs = Journal.loadMessages(s.file);
      stdout.write(`${s.id} · ${s.title} · ${msgs.length} messages\n${exportMessages(msgs, 'md', s.title)}\n`);
      return;
    }
    case 'export': {
      const s = need();
      const fmt = (typeof a.format === 'string' ? a.format : 'md') as 'md' | 'json' | 'html';
      if (!['md', 'json', 'html'].includes(fmt)) throw new Error('--format must be md, json or html');
      const text = exportMessages(Journal.loadMessages(s.file), fmt, s.title);
      if (typeof a.out === 'string') {
        fs.writeFileSync(path.resolve(a.out), text, { mode: 0o600 });
        stdout.write(`exported ${s.id} to ${path.resolve(a.out)}\n`);
      } else stdout.write(text + '\n');
      return;
    }
    case 'delete': {
      const s = need();
      stdout.write(`moved ${s.id} to ${deleteSession(cfg.homeDir, workspace, s.id)} (recoverable)\n`);
      return;
    }
    case 'rename': {
      const s = need();
      renameSession(cfg.homeDir, workspace, s.id, rest.join(' '));
      stdout.write(`renamed ${s.id}\n`);
      return;
    }
    default:
      throw new Error('usage: tug sessions [list|show <id>|export <id> [--format md|json|html] [--out f]|delete <id>|rename <id> <title>]');
  }
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (typeof a.home === 'string') process.env.TUG_HOME = path.resolve(a.home);
  if (a.version || a._[0] === 'version') return void stdout.write(VERSION + '\n');
  if (typeof a.theme === 'string' && !isTheme(a.theme)) throw new UsageError(`--theme must be one of ${THEMES.join(', ')}`);
  c = palette(resolveTheme({ flag: a.theme as string, tty: isTTY, screenReader: !!a['screen-reader'] }));
  // `tug <registered-subcommand> --help`: that command's full help (docs checks compare documented flags with it)
  const helpSub = a.help && a._[0] ? getCliCommand(a._[0]) : undefined;
  if (helpSub) return void stdout.write(`${helpSub.help?.() ?? `tug ${helpSub.name}${helpSub.usage ? ` ${helpSub.usage}` : ''}`}\n\n${helpSub.description}\n`);
  if (a.help) return void stdout.write(help() + '\n' + cliCommands().map((x) => `  tug ${x.name}${x.usage ? ' ' + x.usage : ''}  ${x.description}`).join('\n') + '\n');
  const workspace = path.resolve((a.cwd as string) || process.cwd());
  const sub = a.acp ? 'acp' : a._[0]; // WS7 G1: `tug --acp` = `tug acp`
  if (sub === 'setup') return cmdSetup(a);
  if (sub === 'completion') return void stdout.write(completionScript(a._[1] ?? 'bash'));
  let cfg = buildConfig(a, workspace);
  c = palette(resolveTheme({ flag: a.theme as string, config: cfg.cli?.theme, tty: isTTY, screenReader: !!a['screen-reader'] }));
  // review F13: the CLI's runtime log (TUG_LOG_ENABLED / TUG_LOG_LEVEL / TUG_LOG_PATH)
  rlog = new RuntimeLog(runtimeLogSettings(cfg.homeDir), Object.values(cfg.profiles).map((p) => p.apiKey ?? '').filter((k) => k.length >= 8));
  rlog.write('info', 'start', { version: VERSION, command: sub ?? (typeof a.print === 'string' ? 'print' : 'repl'), workspace });
  // review F13: trust the OS certificate store too (corporate proxies, internal endpoints)
  const ca = applySystemCa(!a['no-system-ca'] && cfg.cli?.systemCa !== false);
  caStatus = ca;
  if (process.env.TUG_DEBUG) process.stderr.write(`certificates: ${ca.applied ? `${ca.system} from the system store, ${ca.total} in all` : ca.reason}\n`);
  rlog.write('debug', 'certificates', { ...ca });
  // N49 SAC1: loosening flags are announced, and refused when managed policy forbids them
  const loosening = looseningFlags(a, { subcommandYes: SUBCOMMAND_YES.has(String(sub ?? '')) });
  try {
    checkManaged(cfg, loosening);
  } catch (e) {
    if (e instanceof ForbiddenFlagError) {
      rlog.write('error', e.message, { code: e.code });
      process.stderr.write(c.red(`error [${e.code}]: ${e.message}\n`));
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  for (const f of loosening) process.stderr.write(c.yellow(`warning: ${looseningWarning(f)}\n`));
  for (const n of new Set(cliNotes)) process.stderr.write(c.yellow(`note: ${n}\n`));
  // Workspace trust: project config may start MCP servers, run hooks or change the endpoint.
  if (cfg.trust && !cfg.trust.workspaceTrusted && cfg.trust.ignored.length) {
    let trust = !!a.trust;
    const headlessRun = typeof a.print === 'string' || ['eval', 'models', 'sessions', 'rescore', 'config'].includes(sub ?? '') || !!(sub && getCliCommand(sub));
    if (!trust && !headlessRun && stdin.isTTY) {
      process.stderr.write(c.yellow(`This workspace's config wants to:\n${cfg.trust.ignored.map((x) => `  - ${x}`).join('\n')}\nThese can run code or change where your API key is sent. `));
      const rl = readline.createInterface({ input: stdin, output: process.stderr });
      trust = /^y/i.test((await rl.question('Trust this workspace? [y/N] ')).trim());
      rl.close();
    }
    if (trust) {
      trustWorkspace(cfg.homeDir, workspace);
      cfg = buildConfig(a, workspace);
    } else process.stderr.write(c.yellow(`[untrusted workspace] ignored: ${cfg.trust.ignored.join('; ')}. Use --trust to apply them.\n`));
  }
  // N43: yolo is loud on every start (stderr, so -p output stays clean)
  if (cfg.permissionMode === 'yolo') process.stderr.write(c.yellow(`${YOLO_WARNING}\n`));
  // N36: whole-session container mode (tug --container, sandbox.session: "container"); never recurses inside one
  const wantContainer = typeof a.container === 'string' || (cfg.sandbox as { session?: string } | undefined)?.session === 'container';
  // sessions only: the REPL, -p, --acp and serve; other subcommands (doctor, schedule, sandbox …) run on the host
  const sessionEntry = !sub || typeof a.print === 'string' || sub === 'acp' || sub === 'serve' || (!getCliCommand(sub) && !['eval', 'models', 'sessions', 'rescore', 'doctor', 'setup'].includes(sub));
  if (typeof a.container === 'string' && !sessionEntry) {
    process.stderr.write(c.red(`--container runs agent sessions (the REPL, -p, --acp, serve --stdio); \`tug ${sub}\` runs on the host.\n`));
    process.exitCode = 2;
    return;
  }
  if (wantContainer && sessionEntry && !process.env.TUG_CONTAINER_SESSION) {
    if (sub === 'serve' && !process.argv.includes('--stdio')) {
      process.stderr.write(c.red('tug serve --container: a WebSocket server inside the session container would need a published port; use `tug serve --stdio --container` (or run `tug serve` on the host with sandbox.runner set).\n'));
      process.exitCode = 2;
      return;
    }
    const { runContainerSession } = await import('../core/sandbox/container.js');
    const raw = process.argv.slice(2);
    const ci = raw.indexOf('--container');
    if (ci >= 0) raw.splice(ci, ['docker', 'podman', 'auto'].includes(raw[ci + 1] ?? '') ? 2 : 1);
    try {
      const r = await runContainerSession({ cfg, workspace, args: raw, engine: typeof a.container === 'string' ? a.container : undefined });
      process.exitCode = r.code;
    } catch (e) {
      process.stderr.write(c.red(`${(e as Error).message}\n`));
      process.exitCode = 125;
    }
    return;
  }
  const regCmd = sub ? getCliCommand(sub) : undefined;
  if (regCmd) {
    const raw = process.argv.slice(2);
    const code = await regCmd.run(raw.slice(raw.indexOf(sub!) + 1), { config: cfg, workspace, write: (t) => stdout.write(t.endsWith('\n') ? t : t + '\n') });
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
    return;
  }
  if (sub === 'attach') {
    // review F13 (Qwen attach): this terminal joins a session running in `tug serve`
    const { attach, serverFromHome } = await import('./attach.js');
    const srv = serverFromHome(cfg.homeDir);
    const url = typeof a.server === 'string' ? a.server : srv.url;
    const token = typeof a.token === 'string' ? a.token : srv.token;
    if (!url || !token) throw new UsageError('no server to attach to: start `tug serve` (it writes server.json), or give --server ws://… and --token');
    const rl = readline.createInterface({ input: stdin, output: process.stderr, terminal: !!stdin.isTTY });
    const lines = (async function* () {
      for await (const l of rl) yield l;
    })();
    process.exitCode = await attach({ url, token, session: a._[1], io: { write: (t) => void stdout.write(t), lines, ask: stdin.isTTY ? async (q) => /^y/i.test((await rl.question(`${q} [y/N] `)).trim()) : undefined } });
    rl.close();
    return;
  }
  if (sub === 'doctor' && a._[1] === 'log') return void stdout.write(logTail(runtimeLogSettings(cfg.homeDir)) + '\n');
  if (sub === 'doctor' && a._[1] === 'fix') {
    const { Board } = await import('../core/context/worktreeBoard.js');
    const lines = await doctorFix(cfg.homeDir, workspace, { boardGc: async () => (await Board.open(cfg, workspace)).gc() });
    rlog.write('info', 'doctor fix', { actions: lines });
    return void stdout.write(lines.map((l) => `  ${l}`).join('\n') + '\n');
  }
  if (sub === 'doctor') return cmdDoctor(cfg, workspace);
  if (sub === 'models') {
    for (const m of await new LLMClient(resolveProfile(cfg)).listModels()) stdout.write(m + '\n');
    return;
  }
  if (sub === 'sessions') return sessionsCommand(a, cfg, workspace);
  if (sub === 'config') {
    const what = a._[1] ?? 'show';
    if (what === 'path') return void stdout.write(`${path.join(cfg.homeDir, 'config.json')}\n${path.join(workspace, '.tugline', 'config.json')}\n`);
    const all = redactedConfig(cfg);
    const v = what === 'get' && a._[2] ? String(a._[2]).split('.').reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), all) : all;
    stdout.write(JSON.stringify(v ?? null, null, 2) + '\n');
    return;
  }
  if (sub === 'rescore') {
    const rows = rescore(path.resolve(a._[1] ?? '.'));
    stdout.write(summarizeScores(rows) + '\n');
    return;
  }
  if (sub === 'eval') {
    const suiteDir = path.resolve(a._[1] ?? 'evals/coding-basics');
    const outDir = path.resolve((a.out as string) || path.join('eval-results', `${path.basename(suiteDir)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
    const rows = await runEval({
      suiteDir,
      outDir,
      baseConfig: cfg,
      arms: a.arms ? String(a.arms).split(',') : undefined,
      repeats: a.repeats ? Number(a.repeats) : undefined,
      tasks: a.tasks ? String(a.tasks).split(',') : undefined,
      log: (s) => stdout.write(s + '\n'),
      onEvent: a.verbose ? (t, arm, e) => {
        if (e.type === 'tool_start') stdout.write(c.dim(`    [${t}/${arm}] ${e.title}\n`));
        if (e.type === 'tool_end' && !e.ok) stdout.write(c.dim(`    [${t}/${arm}]   ✗ ${e.output.split('\n')[0].slice(0, 120)}\n`));
      } : undefined,
    });
    stdout.write('\n' + summarizeScores(rows) + `\n\nReport: ${outDir}\n`);
    return;
  }

  const headless = typeof a.print === 'string' || typeof a['input-file'] === 'string' || a['input-format'] === 'stream-json';
  const format: OutputFormat = a.json ? 'stream-json' : ((a['output-format'] as OutputFormat) || 'text');
  if (!['text', 'json', 'stream-json'].includes(format)) throw new UsageError('--output-format must be text, json or stream-json');
  const ui = new TerminalUI(headless);
  ui.json = format === 'stream-json';
  ui.verbose = !!a.verbose;
  const denials: Denial[] = [];
  const surface = headless ? 'terminal (headless, no user available to answer questions)' : 'terminal';
  const base = ui.ui();
  const uiWithDenials = { ...base, onEvent: (e: AgentEvent) => (collectDenial(e, denials), base.onEvent?.(e)) };
  // --resume / --continue / --session-id / --fork-session
  const sessions = a.continue || a.resume ? Journal.listSessions(cfg.homeDir, workspace) : [];
  const resumed = a.resume && typeof a.resume === 'string' ? sessions.find((x) => x.id.startsWith(a.resume as string)) : a.continue || a.resume ? sessions[0] : undefined;
  if ((a.resume || a.continue) && !resumed && typeof a.resume === 'string') throw new Error(`no saved session ${a.resume} (tug sessions list)`);
  const sessionId = typeof a['session-id'] === 'string' ? a['session-id'] : resumed && !a['fork-session'] ? resumed.id : undefined;
  if (sessionId !== undefined && !/^[\w.-]{1,80}$/.test(sessionId)) throw new Error('--session-id: letters, digits, ".", "_" and "-" only');
  const agent = await Agent.create({ workspace, config: cfg, ui: uiWithDenials, surface, mcp: !a['no-mcp'], sessionId, roleOverride: roleFromArgs(a, surface), toolFilter: toolFilterFromArgs(a), ...dirs() });
  if (resumed && !(sessionId === resumed.id && agent.messages.length)) agent.loadHistory(Journal.loadMessages(resumed.file));
  if (headless) {
    // limits for unattended runs (Qwen --max-wall-time / --max-tool-calls, Cline -t)
    const wall = Number(a['max-wall-time'] ?? a.timeout ?? 0);
    const wallTimer = wall > 0 ? setTimeout(() => agent.abort(), wall * 1000) : undefined;
    const maxCalls = Number(a['max-tool-calls'] ?? 0);
    if (maxCalls > 0) {
      let n = 0;
      const prev = uiWithDenials.onEvent;
      uiWithDenials.onEvent = (e) => {
        prev(e);
        if (e.type === 'tool_start' && ++n >= maxCalls) agent.abort();
      };
    }
    let lastCtrlC = 0;
    process.on('SIGINT', () => {
      if (Date.now() - lastCtrlC < 2000) killAutomation('Ctrl+C ×2'); // SPEC F7 kill switch
      lastCtrlC = Date.now();
      agent.abort();
    });
    if (format === 'stream-json') stdout.write(JSON.stringify(initLine({ sessionId: agent.sessionId, cwd: workspace, model: agent.llm.profile.model, mode: agent.policy.opts.mode, tools: agent.toolList.map((t) => t.name) })) + '\n');
    // the prompts: -p, --input-file, piped stdin; or one {"type":"user","text":…} per stdin line (multi-turn)
    const prompts: string[] = [];
    if (a['input-format'] === 'stream-json') {
      const raw = stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
      for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          throw new Error(`--input-format stream-json: not JSON: ${line.slice(0, 80)}`);
        }
        const text = m?.type === 'user' ? (typeof m.text === 'string' ? m.text : typeof m.message?.content === 'string' ? m.message.content : undefined) : undefined;
        if (text === undefined) throw new Error('--input-format stream-json: each line must be {"type":"user","text":"…"}');
        prompts.push(text);
      }
    } else {
      let prompt = typeof a['input-file'] === 'string' ? fs.readFileSync(path.resolve(a['input-file']), 'utf8') : (a.print as string);
      if (!stdin.isTTY && typeof a.print === 'string') {
        const piped = fs.readFileSync(0, 'utf8');
        if (piped.trim()) prompt = `${prompt}\n\n${attachmentBlock('stdin', {}, piped)}`;
      }
      prompts.push(prompt);
    }
    let res: Awaited<ReturnType<Agent['run']>> | undefined;
    for (const p of prompts) {
      res = await agent.run(attachMentions(p, workspace, agent));
      if (res.stopReason !== 'end_turn') break;
    }
    if (wallTimer) clearTimeout(wallTimer);
    if (!res) throw new Error('no prompt given');
    ui.flushText();
    if (format === 'text') stdout.write(ui.redactor.whole(res.finalText || '') + '\n');
    else stdout.write(JSON.stringify(ui.redactor.whole(resultLine(agent.sessionId, res, denials))) + '\n');
    await agent.dispose();
    process.exitCode = res.stopReason === 'end_turn' ? 0 : 1;
    return;
  }
  await interactive(agent, ui, cfg, workspace, a);
}

main().catch((e) => {
  // review F17: a wrong flag value is the user's typo, not a crash: the message alone, exit 2
  if (e instanceof UsageError) {
    console.error(c.red(`error: ${e.message}`));
    process.exit(2);
  }
  rlog.write('error', `fatal: ${(e as Error).message ?? e}`, { stack: (e as Error).stack });
  console.error(c.red(`fatal: ${(e as Error).stack ?? e}`));
  process.exit(1);
});
