/**
 * Visible terminal for the agent's bash calls (SPEC B10). Pure logic with the
 * VS Code terminal API injected (`TermApi`), so the shell-integration path and
 * the fallback are unit-tested with a mock.
 *
 * The command arrives as a spawn spec that already went through every command
 * wrapper (`commandWrapperFor(cfg)`, the OS sandbox; SPEC S0.8): the terminal
 * runs exactly `file args…` with exactly that env (strictEnv) and cwd, so a
 * visible command is sandboxed like a hidden one.
 *
 * Shell integration (stable since 1.93) gives the output and exit code. If it
 * does not come up within `integrationTimeoutMs`, run() resolves undefined
 * BEFORE sending anything and the bash tool spawns the hidden child process.
 */
import type { HostCommand, HostCommandResult } from '../../src/core/host/workspace.js';

export interface Disposable {
  dispose(): void;
}

export interface ExecutionLike {
  read(): AsyncIterable<string>;
}

export interface ShellIntegrationLike {
  executeCommand(commandLine: string): ExecutionLike;
}

export interface TermLike {
  readonly name: string;
  readonly shellIntegration?: ShellIntegrationLike;
  readonly exitStatus?: unknown;
  show(preserveFocus?: boolean): void;
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

export interface TermApi {
  createTerminal(o: { name: string; cwd: string; env: Record<string, string | null | undefined>; strictEnv: boolean }): TermLike;
  onDidChangeTerminalShellIntegration(cb: (e: { terminal: TermLike; shellIntegration: ShellIntegrationLike }) => void): Disposable;
  onDidEndTerminalShellExecution(cb: (e: { terminal: TermLike; execution: ExecutionLike; exitCode: number | undefined }) => void): Disposable;
  /** when the shell actually starts a command (optional: without it there is no start watchdog) */
  onDidStartTerminalShellExecution?(cb: (e: { terminal: TermLike; execution: ExecutionLike }) => void): Disposable;
  onDidCloseTerminal(cb: (t: TermLike) => void): Disposable;
}

/** Remove ANSI/OSC escape sequences and carriage-return redraws from terminal output. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (incl. shell-integration markers)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/^.*\r(?=[^\n])/gm, '') // progress redraws: keep what was drawn last on the line
    .replace(/\r/g, '');
}

export function shellQuote(a: string): string {
  if (/^[\w@%+=:,./-]+$/.test(a)) return a;
  // Control characters (a newline in a sandbox bridge script, a multi-line commit message) would make the
  // typed line span several lines: the interactive shell then waits at a continuation prompt and shell
  // integration never sees the command end. ANSI-C quoting keeps it on one line (bash, zsh, ksh).
  if (/[\x00-\x1f\x7f]/.test(a)) return ansiCQuote(a);
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

/** `$'…'` with every control character, backslash and single quote escaped: one line, exact bytes. */
export function ansiCQuote(a: string): string {
  const esc: Record<string, string> = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\\': '\\\\', "'": "\\'" };
  return `$'${a.replace(/[\x00-\x1f\x7f\\']/g, (c) => esc[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}'`;
}

/** POSIX shells whose interactive line can carry `$'…'` (dash and busybox sh cannot). */
export function posixHasAnsiC(shellPath: string | undefined): boolean {
  const base = (shellPath ?? '').split(/[\\/]/).pop()!.toLowerCase();
  return ['bash', 'zsh', 'ksh', 'mksh'].includes(base);
}

/**
 * The exact command line for a spawn spec (the terminal is a POSIX shell).
 *
 * The terminal's interactive shell sources ~/.bashrc / ~/.zshrc, which often
 * export credentials (OPENAI_API_KEY, GITHUB_TOKEN …) that the harness scrubs
 * from command environments. `strictEnv` only fixes the shell's STARTING env,
 * so the command is run through `/usr/bin/env -i KEY=VALUE…`: it sees exactly
 * the scrubbed spec env, as on the hidden path (review fix 1).
 */
export function commandLineFor(cmd: Pick<HostCommand, 'file' | 'args' | 'cwd' | 'env'>, terminalCwd?: string): string {
  const env = Object.entries(cmd.env ?? {})
    .filter(([k, v]) => v !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => shellQuote(`${k}=${v}`));
  const line = ['/usr/bin/env', '-i', ...env, ...[cmd.file, ...cmd.args].map(shellQuote)].join(' ');
  return terminalCwd === cmd.cwd ? line : `cd ${shellQuote(cmd.cwd)} && ${line}`;
}

// ------------------------------------------------------------ Windows shells (v1.1 Q3)

export type ShellKind = 'posix' | 'pwsh' | 'cmd';

/**
 * Which command-line dialect the terminal's shell speaks, from its path
 * (`vscode.env.shell`). Unknown shells (fish, nu, Git Bash on Windows …) give
 * undefined: the runner then declines before creating or sending anything, and
 * bash runs the hidden, scrubbed process. (The v1.0 code sent a POSIX line to
 * every shell, which failed closed on Windows; FINAL_REVIEW Q3.)
 */
export function shellKindOf(shellPath: string | undefined, platform: NodeJS.Platform = process.platform): ShellKind | undefined {
  if (!shellPath) return platform === 'win32' ? undefined : 'posix';
  const base = shellPath.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'powershell') return 'pwsh';
  if (base === 'cmd') return platform === 'win32' ? 'cmd' : undefined;
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash'].includes(base)) return platform === 'win32' ? undefined : 'posix';
  return undefined;
}

/** One argv element quoted for CommandLineToArgvW / the MSVC runtime (the same rules as libuv's quote_cmd_arg). */
export function msvcQuote(a: string): string {
  if (a && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === '\\') {
      bs++;
      continue;
    }
    out += ch === '"' ? '\\'.repeat(bs * 2 + 1) + '"' : '\\'.repeat(bs) + ch;
    bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

const isCmdExe = (file: string) => /(^|[\\/])cmd(\.exe)?$/i.test(file);

/**
 * The Windows argument string for a spawn spec. bash's Windows spec is
 * `ComSpec /d /s /c <command>`: cmd.exe gets `/d /s /c "<command>"` with the
 * command verbatim, as Node's own `shell: true` passes it (cmd.exe does not
 * understand MSVC backslash escapes, so quoting the command as one argv
 * element would change it). Any other program gets MSVC-quoted arguments.
 */
export function windowsArguments(file: string, args: string[]): string {
  if (isCmdExe(file) && args.length === 4 && args[0].toLowerCase() === '/d' && args[1].toLowerCase() === '/s' && args[2].toLowerCase() === '/c') return `/d /s /c "${args[3]}"`;
  return args.map(msvcQuote).join(' ');
}

export function windowsCommandLine(file: string, args: string[]): string {
  const a = windowsArguments(file, args);
  return a ? `${msvcQuote(file)} ${a}` : msvcQuote(file);
}

/** A PowerShell single-quoted literal (also doubles the typographic quotes PowerShell treats as single quotes). */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (m) => m + m)}'`;
}

/** The spec's env as sorted [name, value] pairs; names that no shell can set safely are dropped. */
function specEnv(env: NodeJS.ProcessEnv): [string, string][] {
  return Object.entries(env)
    .filter((e): e is [string, string] => e[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_.()-]*$/.test(e[0]))
    .sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The script a child `pwsh -NoProfile -NonInteractive` runs, in a `& { … }`
 * block: drop every inherited variable that is not in the spec (the
 * interactive shell's profile may have set credentials; `-cnotcontains`, so on
 * Unix a differently-cased name is dropped too, and on Windows a variable that
 * is dropped and then set again is harmless), set the spec's variables, then
 * start the spec's command line verbatim (ProcessStartInfo: no second round of
 * PowerShell argument parsing), wait, and exit with its code.
 */
export function pwshScript(cmd: Pick<HostCommand, 'file' | 'args' | 'cwd' | 'env'>): string {
  const env = specEnv(cmd.env ?? {});
  return [
    '& {',
    `$keep = @(${env.map(([k]) => psQuote(k)).join(', ')});`,
    'foreach ($n in @(Get-ChildItem Env: | ForEach-Object Name)) { if ($keep -cnotcontains $n) { [Environment]::SetEnvironmentVariable($n, $null) } };',
    ...env.map(([k, v]) => `[Environment]::SetEnvironmentVariable(${psQuote(k)}, ${psQuote(v)});`),
    `$psi = [System.Diagnostics.ProcessStartInfo]::new(${psQuote(cmd.file)}, ${psQuote(windowsArguments(cmd.file, cmd.args))});`,
    `$psi.UseShellExecute = $false; $psi.WorkingDirectory = ${psQuote(cmd.cwd)};`,
    '$p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode',
    '}',
  ].join(' ');
}

/**
 * Escape text for ONE cmd.exe parse of an unquoted command line.
 * - Phase 2 (specials): `^ & | < > ( ) "` get a caret. Quotes are escaped too,
 *   so the parser never enters quote mode, where carets would stop working.
 * - Phase 1 (`%VAR%` expansion, which ignores carets and quotes): every `%`
 *   that has a character after it is followed by a caret, so every name cmd
 *   could try to expand starts with `^` and is undefined; phase 2 then drops
 *   the caret. A `%` at the very end of the text has nothing to pair with.
 * Callers decline text that this cannot express (`!`, newlines, see below).
 */
export function cmdEscape(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let e = '^&|<>()"'.includes(s[i]) ? '^' + s[i] : s[i];
    if (i > 0 && s[i - 1] === '%' && !e.startsWith('^')) e = '^' + e; // `^x` is just x after phase 2
    out += e;
  }
  return out;
}

/** Limits of the Windows command lines (cmd.exe: 8191 chars; CreateProcess: 32767). */
const CMD_MAX = 8000;
const PWSH_MAX = 32000;

/**
 * The clearing loop run by the child cmd.exe: unset every inherited variable
 * (`set` lists them). Its two `%A` are the only unescaped `%` in the child
 * line: the first could only pair with a variable literally named
 * `A in ('set') do @set "`, and every name starting at the second contains
 * `=`, which no variable name can.
 */
const CMD_CLEAR_ENV = 'for /f "delims==" %A in (\'set\') do @set "%A="';

/**
 * The child cmd.exe's own command line (one parse, by that child): clear the
 * inherited env, set the spec's, cd, and run the spec's command line literally.
 * The `&&` before the command stops it if `cd` fails.
 *
 * A spec value or cwd that ends in `%` is not expressible: the separator that
 * follows cannot be caret-protected, so the `%` could pair with a later one.
 */
export function cmdInnerLine(cmd: Pick<HostCommand, 'file' | 'args' | 'cwd' | 'env'>): string | undefined {
  const env = specEnv(cmd.env ?? {});
  if ([...env.map(([, v]) => v), cmd.cwd].some((v) => v.endsWith('%'))) return undefined;
  const pre = ['setlocal', CMD_CLEAR_ENV, ...env.map(([k, v]) => `set ${cmdEscape(k)}=${cmdEscape(v)}`), `cd /d ${cmdEscape(cmd.cwd)}`].join('& ');
  return `${pre}&& ${cmdEscape(windowsCommandLine(cmd.file, cmd.args))}`;
}

/**
 * The line typed into the terminal for a spec, by shell kind, or undefined when
 * it cannot be expressed safely: the runner then declines BEFORE sending and
 * bash runs the hidden, scrubbed process.
 *
 * - posix: `/usr/bin/env -i …` (commandLineFor).
 * - pwsh: `& '<pwsh>' -NoProfile -NonInteractive -EncodedCommand <base64>`; the
 *   script (pwshScript) travels base64-encoded, so no character of it is ever
 *   parsed by the interactive shell.
 * - cmd: `<cmd> /d /v:off /c <child line>`. `setlocal` has no effect in the
 *   interactive shell, so the env is changed in a child cmd.exe that exits
 *   after the command. The child line is escaped once for that child
 *   (cmdInnerLine) and once more for the interactive shell, which parses the
 *   whole line first and passes the rest to the child with one layer of carets
 *   removed. Declined: `!` (the interactive shell's delayed expansion is
 *   unknown), newlines and NUL, a program path that needs quotes (cmd would
 *   split the caret-escaped quotes), a UNC cwd (cmd cannot `cd` there), values
 *   or cwd ending in `%`, and lines over 8000 characters.
 */
export function commandLineForShell(kind: ShellKind, cmd: Pick<HostCommand, 'file' | 'args' | 'cwd' | 'env'>, o: { terminalCwd?: string; shellPath?: string } = {}): string | undefined {
  if (kind === 'posix') {
    const values = [...Object.values(cmd.env ?? {}).filter((v): v is string => v !== undefined), cmd.file, ...cmd.args, cmd.cwd];
    if (values.some((v) => v.includes('\0'))) return undefined;
    // a value with control characters needs $'…', which plain sh/dash cannot read: the hidden process runs it
    if (values.some((v) => /[\x01-\x1f\x7f]/.test(v)) && !posixHasAnsiC(o.shellPath)) return undefined;
    return commandLineFor(cmd, o.terminalCwd);
  }
  const values = [...specEnv(cmd.env ?? {}).flat(), cmd.file, ...cmd.args, cmd.cwd];
  if (kind === 'pwsh') {
    if (values.some((v) => v.includes('\0'))) return undefined;
    const b64 = Buffer.from(pwshScript(cmd), 'utf16le').toString('base64');
    const line = `& ${psQuote(o.shellPath ?? 'pwsh')} -NoProfile -NonInteractive -EncodedCommand ${b64}`;
    return line.length > PWSH_MAX ? undefined : line;
  }
  if (values.some((v) => /[\r\n\0!]/.test(v))) return undefined;
  if (msvcQuote(cmd.file) !== cmd.file || cmd.cwd.startsWith('\\\\') || cmd.cwd.startsWith('//')) return undefined;
  const inner = cmdInnerLine(cmd);
  if (inner === undefined) return undefined;
  const exe = o.shellPath && /^[^"%!^&|<>()\r\n]+$/.test(o.shellPath) ? msvcQuote(o.shellPath) : 'cmd.exe';
  const line = `${exe} /d /v:off /c ${cmdEscape(inner)}`;
  return line.length > CMD_MAX ? undefined : line;
}

function envKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(Object.entries(env).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
}

export interface RunnerOptions {
  name: string;
  integrationTimeoutMs?: number;
  /** grace period after Ctrl+C before giving up on the end event */
  killGraceMs?: number;
  /** show the terminal without taking focus */
  reveal?: boolean;
  /** the terminal's shell (VS Code: `vscode.env.shell`); decides the command-line dialect */
  shellPath?: () => string | undefined;
  platform?: NodeJS.Platform;
  /** how long the shell may take to start a sent command before it is cancelled (default 15 s) */
  startTimeoutMs?: number;
}

export class VisibleTerminalRunner {
  private term?: TermLike;
  private key = '';
  private cwd?: string;
  private noIntegration = new WeakSet<TermLike>();
  /** the terminal once accepted a command and never started it: commands run hidden from then on (CI found it) */
  private unreliable = false;
  private busy: Promise<unknown> = Promise.resolve();
  private subs: Disposable[] = [];
  /** Last result, for tests and the UI. */
  last?: { commandLine: string; result: HostCommandResult; terminal: string };

  constructor(private api: TermApi, private o: RunnerOptions) {
    this.subs.push(
      api.onDidCloseTerminal((t) => {
        if (t === this.term) this.term = undefined;
      }),
    );
  }

  get terminal(): TermLike | undefined {
    return this.term;
  }

  /** Ctrl+C in the terminal (emergency stop). */
  interrupt(): void {
    this.term?.sendText('\x03', false);
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.term?.dispose();
    this.term = undefined;
  }

  run(cmd: HostCommand): Promise<HostCommandResult | undefined> {
    // one command at a time per terminal
    const p = this.busy.then(() => this.runNow(cmd));
    this.busy = p.catch(() => undefined);
    return p;
  }

  private ensureTerminal(cmd: HostCommand): TermLike {
    const key = envKey(cmd.env);
    if (this.term && (this.key !== key || this.term.exitStatus !== undefined)) {
      this.term.dispose();
      this.term = undefined;
    }
    if (!this.term) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(cmd.env)) if (v !== undefined) env[k] = v;
      this.term = this.api.createTerminal({ name: this.o.name, cwd: cmd.cwd, env, strictEnv: true });
      this.key = key;
      this.cwd = cmd.cwd;
    }
    return this.term;
  }

  private waitIntegration(t: TermLike): Promise<ShellIntegrationLike | undefined> {
    if (t.shellIntegration) return Promise.resolve(t.shellIntegration);
    if (this.noIntegration.has(t)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        this.noIntegration.add(t);
        resolve(t.shellIntegration);
      }, this.o.integrationTimeoutMs ?? 4000);
      const sub = this.api.onDidChangeTerminalShellIntegration((e) => {
        if (e.terminal !== t) return;
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration);
      });
    });
  }

  private async runNow(cmd: HostCommand): Promise<HostCommandResult | undefined> {
    if (cmd.signal?.aborted) return undefined;
    // Decide the dialect first: an unknown shell or an inexpressible line declines before anything is sent.
    const shellPath = this.o.shellPath?.();
    if (this.unreliable) return undefined; // run hidden: this terminal did not start a sent command before
    const kind = shellKindOf(shellPath, this.o.platform ?? process.platform);
    if (!kind) return undefined;
    const probe = commandLineForShell(kind, cmd, { terminalCwd: undefined, shellPath });
    if (probe === undefined) return undefined;
    const t = this.ensureTerminal(cmd);
    if (this.o.reveal !== false) t.show(true);
    const si = await this.waitIntegration(t);
    if (!si) return undefined; // fallback: nothing was sent to the terminal
    const started = Date.now();
    const line = commandLineForShell(kind, cmd, { terminalCwd: this.cwd, shellPath })!;
    let timedOut = false;
    let execution: ExecutionLike | undefined;
    let resolveEnd!: (code: number | undefined) => void;
    const ended = new Promise<number | undefined>((r) => (resolveEnd = r));
    // The start and end events are matched by terminal too: VS Code does not always hand back the execution object
    // that executeCommand returned (seen with the start event), and this runner sends one command at a time.
    let other: ExecutionLike | undefined;
    let otherRaw = '';
    const endSub = this.api.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution || (execution && e.terminal === t)) resolveEnd(e.exitCode);
    });
    // Start watchdog: VS Code can accept a command line that the shell then never starts (shell integration up,
    // command detection not working: seen on GitHub's Ubuntu runners). Without it every such command waited for
    // its whole timeout with no output.
    let startedRun = !this.api.onDidStartTerminalShellExecution;
    let resolveNoStart!: () => void;
    const noStart = new Promise<'nostart'>((r) => (resolveNoStart = () => r('nostart')));
    // matched by terminal, not by execution object: VS Code's start event does not always carry the same object
    // that executeCommand returned (it did for the end event), and this runner sends one command at a time
    const startSub = this.api.onDidStartTerminalShellExecution?.((e) => {
      if (e.execution !== execution && e.terminal !== t) return;
      startedRun = true;
      if (e.execution !== execution && !other) {
        // the shell's own execution object: its output stream is the one that carries the data
        other = e.execution;
        void (async () => {
          for await (const d of other!.read()) if (otherRaw.length < 2_000_000) otherRaw += d;
        })().catch(() => undefined);
      }
    });
    const startTimer = this.api.onDidStartTerminalShellExecution
      ? setTimeout(() => {
          if (!startedRun) resolveNoStart();
        }, this.o.startTimeoutMs ?? 15_000)
      : undefined;
    const interrupt = () => t.sendText('\x03', false);
    const timer = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, cmd.timeoutMs);
    cmd.signal?.addEventListener('abort', interrupt, { once: true });
    let raw = '';
    try {
      execution = si.executeCommand(line);
    } catch {
      // nothing was started: let the bash tool spawn the hidden process
      clearTimeout(timer);
      clearTimeout(startTimer);
      cmd.signal?.removeEventListener('abort', interrupt);
      endSub.dispose();
      startSub?.dispose();
      return undefined;
    }
    // From here on the command is running: never throw (the caller would run it a second time).
    let check: ReturnType<typeof setInterval> | undefined;
    try {
      this.cwd = cmd.cwd;
      const reading = (async () => {
        for await (const d of execution!.read()) if (raw.length < 2_000_000) raw += d;
      })().catch(() => undefined);
      // After an interrupt, give the shell a grace period to report the end.
      const grace = new Promise<'grace'>((r) => {
        check = setInterval(() => {
          if (timedOut || cmd.signal?.aborted) {
            clearInterval(check);
            setTimeout(() => r('grace'), this.o.killGraceMs ?? 3000).unref?.();
          }
        }, 100);
        void ended.then(() => clearInterval(check));
        void noStart.then(() => clearInterval(check));
      });
      const notStarted = noStart.then<number | undefined | 'nostart'>(() => (startedRun || raw || otherRaw ? ended : 'nostart'));
      const code: number | undefined | 'grace' | 'nostart' = await Promise.race([ended, grace, notStarted]);
      if (code === 'nostart') {
        interrupt(); // clear the typed line so it cannot start later
        this.unreliable = true;
        const result: HostCommandResult = {
          exitCode: null,
          output: `the Tugline terminal did not start the command within ${Math.round((this.o.startTimeoutMs ?? 15_000) / 1000)} s (VS Code's shell integration did not report it); it was cancelled and did not run. Commands run in the background from now on; run it again.`,
          timedOut: false,
          durationMs: Date.now() - started,
        };
        this.last = { commandLine: line, result, terminal: t.name };
        return result;
      }
      await Promise.race([reading, new Promise((r) => setTimeout(r, 500))]);
      const result: HostCommandResult = {
        exitCode: timedOut || cmd.signal?.aborted ? null : code === 'grace' ? null : (code ?? null),
        output: stripAnsi(otherRaw.length > raw.length ? otherRaw : raw).replace(/\n+$/, ''),
        timedOut,
        durationMs: Date.now() - started,
      };
      this.last = { commandLine: line, result, terminal: t.name };
      return result;
    } catch (e) {
      const result: HostCommandResult = { exitCode: null, output: `${stripAnsi(raw)}\n[the Tugline terminal failed while the command ran: ${(e as Error).message}; it was not run again]`.trim(), timedOut, durationMs: Date.now() - started };
      this.last = { commandLine: line, result, terminal: t.name };
      return result;
    } finally {
      clearInterval(check);
      clearTimeout(timer);
      clearTimeout(startTimer);
      cmd.signal?.removeEventListener('abort', interrupt);
      endSub.dispose();
      startSub?.dispose();
    }
  }
}
