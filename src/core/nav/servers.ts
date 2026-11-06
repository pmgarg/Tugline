/**
 * Language-server lifecycle (N3): started lazily on the first request for a
 * file of their language, one per (session, server), spawned through the
 * command wrappers (OS sandbox, S0.7) with a scrubbed env, and stopped when the
 * agent session ends (onSessionEnd) or the process exits.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readUserConfigFile, type HarnessConfig } from '../config.js';
import { sandboxStatus } from '../sandbox/index.js';
import { buildSpawnSpec, commandWrapperFor, scrubbedEnv } from '../tools/shell.js';
import { registerAgentExtension } from '../agent/extensions.js';
import { listFiles } from '../context/index/files.js';
import { LspClient, LspError } from './lsp.js';
import { languageIdFor, lspConfig, LSP_PRESETS, resolvedServers, serverFor, setAutoDetector, type ResolvedServer } from './config.js';

interface Entry {
  client?: LspClient;
  starting?: Promise<LspClient>;
  error?: string;
  /** crash restarts so far in this session (N46 AC4) */
  restarts?: number;
  /** documents open when it crashed, replayed into the new process */
  reopen?: string[];
}

/** Absolute path of `bin` on PATH (or the path itself), without running anything. */
export function whichBin(bin: string, PATH = process.env.PATH ?? ''): string | null {
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin) ? path.resolve(bin) : null;
  for (const d of PATH.split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, bin);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** User-scope LSP settings that loosen safety (never from a project config). */
function userLsp(cfg: HarnessConfig): { allowWorkspaceBinaries?: boolean; allowUnsandboxed?: boolean } {
  return readUserConfigFile(cfg.homeDir)?.lsp ?? {};
}

/** Environment variables that make an interpreter load code from a path (review F3). */
export const CODE_PATH_ENV = ['PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'NODE_PATH', 'NODE_OPTIONS', 'PERL5LIB', 'PERL5OPT', 'RUBYLIB', 'RUBYOPT', 'CLASSPATH', 'JAVA_TOOL_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'GOFLAGS', 'BASH_ENV', 'ENV'];

/** Path-like strings in a value (argv words, `--opt=value`, `a:b` lists, nested option objects). */
function pathWords(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    for (const part of [v, ...v.split('=').slice(1), ...v.split(path.delimiter), ...v.split(/\s+/)]) if (part && /[/\\.]/.test(part)) out.push(part.replace(/^-+[\w-]*=/, ''));
  } else if (Array.isArray(v)) v.forEach((x) => pathWords(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => pathWords(x, out));
  return out;
}

/** Whether `word` names an existing file or directory inside the workspace (relative words resolve against it: the server's cwd). */
function namesWorkspacePath(word: string, ws: string): string | undefined {
  const abs = path.resolve(ws, word);
  if (!fs.existsSync(abs)) return undefined;
  return inside(realOr(abs), ws) || inside(abs, ws) ? abs : undefined;
}

/**
 * N46 SAC1 + review F3: code a language server would load from the workspace (where the agent writes) is refused
 * unless the user allowed it at USER scope (`lsp.allowWorkspaceBinaries`): the server binary, any argument or
 * `--option=value` naming a workspace path (`node ./x.js`, `--tsserver-path …`, `-cp …`), interpreter code-path
 * variables in its env (PYTHONPATH, NODE_OPTIONS, …) and paths in its initializationOptions.
 */
export function binaryRefusal(cfg: HarnessConfig, workspace: string, s: ResolvedServer): string | undefined {
  if (s.refused) return s.refused;
  if (userLsp(cfg).allowWorkspaceBinaries === true) return undefined;
  const ws = realOr(workspace);
  const how = 'Install the server (and its TypeScript, interpreter or modules) outside the project, or allow workspace code in ~/.tugline/config.json ("lsp": {"allowWorkspaceBinaries": true}).';
  const bin = whichBin(s.argv[0]);
  if (bin && (inside(realOr(bin), ws) || inside(path.resolve(bin), ws))) return `language server "${s.name}" resolves to ${bin}, inside the workspace, where the agent can write; it was not started. ${how}`;
  for (const a of s.argv.slice(1)) for (const w of pathWords(a)) {
    const hit = namesWorkspacePath(w, ws);
    if (hit) return `language server "${s.name}" would load ${hit} (argument "${a}"), inside the workspace, where the agent can write; it was not started. ${how}`;
  }
  for (const [k, v] of Object.entries(s.env ?? {})) {
    if (!CODE_PATH_ENV.includes(k.toUpperCase())) continue;
    const hit = pathWords(v).map((w) => namesWorkspacePath(w, ws)).find(Boolean) ?? (/(?:^|[:;\s=])\.{0,2}(?:[:;]|$)|(?:^|[:;\s=])(?!\/)[\w.-]+\//.test(v) ? '(a relative path)' : undefined);
    if (hit) return `language server "${s.name}" has ${k}=${v}, which loads code from ${hit} inside the workspace; it was not started. ${how}`;
  }
  for (const w of pathWords(s.initializationOptions)) {
    const hit = namesWorkspacePath(w, ws);
    if (hit) return `language server "${s.name}" is configured to load ${hit} (initializationOptions), inside the workspace; it was not started. ${how}`;
  }
  return undefined;
}

/** Is this the TypeScript language server (which loads the workspace's node_modules/typescript by default)? */
export function isTypeScriptServer(s: ResolvedServer): boolean {
  return s.argv.some((a) => /typescript-language-server/.test(a));
}

/** A tsserver.js outside the workspace: next to the server's install, the harness's own TypeScript, or the global one. */
export function externalTsserver(s: ResolvedServer, workspace: string): string | undefined {
  const ws = realOr(workspace);
  const tries: string[] = [];
  const bin = whichBin(s.argv[0]);
  const starts = [bin, ...s.argv.slice(1).filter((a) => /typescript-language-server/.test(a))].filter((x): x is string => !!x).map(realOr);
  for (const st of starts) for (let d = path.dirname(st), i = 0; i < 8 && d !== path.dirname(d); d = path.dirname(d), i++) tries.push(path.join(d, 'node_modules', 'typescript', 'lib', 'tsserver.js'), path.join(d, 'typescript', 'lib', 'tsserver.js'));
  try {
    tries.push(createRequire(import.meta.url).resolve('typescript/lib/tsserver.js'));
  } catch {
    /* bundled (VS Code): no TypeScript of our own */
  }
  for (const t of tries) if (fs.existsSync(t) && !inside(realOr(t), ws)) return t;
  return undefined;
}

/**
 * Review F3: the TypeScript server is pointed at a tsserver outside the workspace (`initializationOptions.tsserver.path`);
 * without one it would load `<workspace>/node_modules/typescript/lib/tsserver.js`, which the agent can write.
 */
export function withExternalTypeScript(cfg: HarnessConfig, workspace: string, s: ResolvedServer): ResolvedServer | { refused: string } {
  if (!isTypeScriptServer(s) || userLsp(cfg).allowWorkspaceBinaries === true) return s;
  const io = (s.initializationOptions && typeof s.initializationOptions === 'object' ? s.initializationOptions : {}) as { tsserver?: { path?: string } };
  if (io.tsserver?.path) return s; // the user's own path (binaryRefusal refuses one inside the workspace)
  const ts = externalTsserver(s, workspace);
  if (!ts) return { refused: `language server "${s.name}" would load the workspace's own TypeScript (node_modules/typescript), which the agent can write, and no TypeScript was found outside the workspace; it was not started. Install TypeScript next to the server (npm i -g typescript typescript-language-server) or set lsp.servers.${s.name}.initializationOptions.tsserver.path.` };
  return { ...s, initializationOptions: { ...io, tsserver: { ...(io.tsserver ?? {}), path: ts } } };
}

/**
 * Review F3: language servers always run in the OS sandbox, whatever shell.sandbox says for commands. Where none is
 * available they start only when the user allowed it at user scope (`lsp.allowUnsandboxed`).
 */
export function lspSandboxConfig(cfg: HarnessConfig): { config: HarnessConfig; refused?: string; runner: string } {
  const sh = (cfg as { shell?: { sandbox?: string } }).shell ?? {};
  const forced = !sh.sandbox || sh.sandbox === 'none' || sh.sandbox === 'docker' ? ({ ...cfg, shell: { ...(cfg as any).shell, sandbox: 'auto' } } as HarnessConfig) : cfg;
  const st = sandboxStatus(forced);
  if (st.runner !== 'none' && st.runner !== 'docker') return { config: forced, runner: st.runner };
  // a required sandbox (shell.requireSandbox, managed forceSandbox) cannot be waived for language servers either
  if (userLsp(cfg).allowUnsandboxed === true && !st.required) return { config: { ...cfg, shell: { ...(cfg as any).shell, sandbox: 'none' } } as HarnessConfig, runner: 'none' };
  return { config: forced, runner: 'none', refused: `language servers run in the OS sandbox, and none is available here (${st.unavailable ?? 'no runner'}); the server was not started. Allow unsandboxed language servers in ~/.tugline/config.json ("lsp": {"allowUnsandboxed": true}) if you trust them and the project.` };
}

setAutoDetector((cfg, workspace) =>
  Object.entries(LSP_PRESETS)
    .filter(([, p]) => {
      const bin = whichBin(p.command[0]);
      if (!bin) return false;
      try {
        if (inside(fs.realpathSync(bin), fs.realpathSync(workspace))) return false;
      } catch {
        return false;
      }
      return listFiles(workspace, { extensions: new Set(p.extensions), max: 1 }).length > 0;
    })
    .map(([n]) => n),
);

/** sessionKey → server name → entry */
const sessions = new Map<string, Map<string, Entry>>();

/** Subagents (`<session>-sub-<n>`) share their parent's servers. */
export function rootSession(sessionId: string): string {
  return sessionId.replace(/(-sub-\d+)+$/, '');
}

export interface LspTarget {
  config: HarnessConfig;
  workspace: string;
  sessionId: string;
}

/** Actionable text for a server that could not start. */
export function startError(s: ResolvedServer, e: Error): string {
  const how = s.install ? ` Install it (${s.install})` : ' Install it';
  // behind a sandbox wrapper the spawn itself succeeds and the wrapper exits 127 with ENOENT
  const missing = /ENOENT|not found|exited \(127\)/.test(e.message);
  const why = missing ? `${s.argv[0]} not found on PATH` : e.message;
  return `language server "${s.name}" (${s.argv.join(' ')}) failed: ${why}.${how} or change lsp.servers.${s.name}; until then name matching is used.`;
}

async function startClient(t: LspTarget, s: ResolvedServer, reopen: string[] = []): Promise<LspClient> {
  const cfg = lspConfig(t.config);
  const refusal = binaryRefusal(t.config, t.workspace, s);
  if (refusal) throw new LspError(refusal);
  const ts = withExternalTypeScript(t.config, t.workspace, s);
  if ('refused' in ts && !('name' in ts)) throw new LspError(ts.refused);
  s = ts as ResolvedServer;
  const sb = lspSandboxConfig(t.config);
  if (sb.refused) throw new LspError(sb.refused);
  // never import modules from the server's cwd (the workspace): Python's `-m` puts it first on sys.path otherwise
  const env = { ...scrubbedEnv((t.config as { shell?: { scrubEnv?: string[] } }).shell?.scrubEnv ?? []), PYTHONSAFEPATH: '1', ...(s.env ?? {}) };
  // SAC1: spawned through the command wrappers (the OS sandbox: bwrap / Landlock / Seatbelt), never directly
  const spec = buildSpawnSpec({ argv: s.argv, cwd: t.workspace, env, wrap: commandWrapperFor(sb.config) });
  const c = new LspClient(s.name, spec, { root: t.workspace, initializationOptions: s.initializationOptions, requestTimeoutMs: cfg.requestTimeoutMs, startTimeoutMs: s.startTimeoutMs ?? cfg.startTimeoutMs, settings: s.settings, languageId: (abs) => languageIdFor(s, abs) });
  try {
    await c.start();
  } catch (e) {
    c.kill();
    throw e;
  }
  // replay the documents open before a crash, and let the server load the project again before answering
  let firstSeq: { f: string; seq: number } | undefined;
  for (const f of reopen) {
    if (!fs.existsSync(f)) continue;
    const { seq } = c.syncInfo(f);
    firstSeq ??= { f, seq };
  }
  if (firstSeq) {
    await c.waitDiagnostics(firstSeq.f, firstSeq.seq, 20_000, 0);
    await c.waitIdle(20_000);
  }
  return c;
}

/** The running client for a server (starting it on first use). Throws LspError with an actionable message. */
export async function clientFor(t: LspTarget, s: ResolvedServer): Promise<LspClient> {
  const key = `${rootSession(t.sessionId)}\u0000${path.resolve(t.workspace)}`;
  let m = sessions.get(key);
  if (!m) sessions.set(key, (m = new Map()));
  let e = m.get(s.name);
  if (e?.client?.alive) return e.client;
  if (e?.error) throw new LspError(e.error);
  // AC4: a crashed server is restarted (bounded), with its open documents replayed; the session carries on
  if (e?.client && !e.client.alive) {
    const restarts = (e.restarts ?? 0) + 1;
    if (!s.restartOnCrash || restarts > s.maxRestarts) {
      e.error = `language server "${s.name}" crashed ${restarts - 1 ? `${restarts} times` : ''} and is not restarted again (lsp.servers.${s.name}.maxRestarts = ${s.maxRestarts}); name matching is used until the session restarts.`.replace('  ', ' ');
      throw new LspError(e.error);
    }
    e = { restarts, reopen: e.client.openPaths() };
    m.set(s.name, e);
  }
  if (!e?.starting) {
    e = { ...(e ?? {}), starting: startClient(t, s, e?.reopen ?? []) };
    m.set(s.name, e);
    const entry = e;
    entry.starting!.then(
      (c) => ((entry.client = c), (c.restarts = entry.restarts ?? 0)),
      (err) => (entry.error = startError(s, err as Error)),
    );
  }
  try {
    return await e.starting!;
  } catch {
    throw new LspError(m.get(s.name)?.error ?? `language server ${s.name} failed to start`);
  }
}

/** The client for the server handling `file`, or undefined when none is configured. */
export async function clientForFile(t: LspTarget, file: string): Promise<{ client: LspClient; server: ResolvedServer } | undefined> {
  const s = serverFor(t.config, file, t.workspace);
  if (!s) return undefined;
  return { client: await clientFor(t, s), server: s };
}

export function configuredServers(cfg: HarnessConfig, workspace?: string): ResolvedServer[] {
  return resolvedServers(cfg, workspace);
}

/** Status of a session's servers (`/lsp`, `tug lsp status`). */
export function serverStatus(cfg: HarnessConfig, workspace: string, sessionId: string): { name: string; source: string; command: string; state: string; pid?: number; restarts: number; open: number; error?: string }[] {
  const m = sessions.get(`${rootSession(sessionId)}\u0000${path.resolve(workspace)}`);
  return resolvedServers(cfg, workspace).map((s) => {
    const e = m?.get(s.name);
    const ts = withExternalTypeScript(cfg, workspace, s);
    const refusal = binaryRefusal(cfg, workspace, s) ?? ('name' in ts ? undefined : ts.refused) ?? lspSandboxConfig(cfg).refused;
    const state = refusal ? 'refused' : e?.error ? 'failed' : e?.client?.alive ? 'running' : e?.client ? 'crashed' : e?.starting ? 'starting' : 'not started';
    return { name: s.name, source: s.source, command: s.argv.join(' '), state, pid: e?.client?.alive ? e.client.pid : undefined, restarts: e?.restarts ?? 0, open: e?.client?.openPaths().length ?? 0, error: refusal ?? e?.error };
  });
}

/** Stop one server (or all) of a session; the next request starts it fresh (`/lsp restart`). */
export async function restartServers(sessionId: string, workspace: string, name?: string): Promise<string[]> {
  const m = sessions.get(`${rootSession(sessionId)}\u0000${path.resolve(workspace)}`);
  if (!m) return [];
  const names = [...m.keys()].filter((n) => !name || n === name);
  for (const n of names) {
    const e = m.get(n)!;
    m.delete(n);
    await (e.client ?? (await e.starting?.catch(() => undefined)))?.stop();
  }
  return names;
}

/** Running clients of a session (tests, status). */
export function sessionClients(sessionId: string): LspClient[] {
  const out: LspClient[] = [];
  for (const [k, m] of sessions) if (k.startsWith(`${rootSession(sessionId)}\u0000`)) for (const e of m.values()) if (e.client) out.push(e.client);
  return out;
}

export async function stopSession(sessionId: string): Promise<void> {
  const prefix = `${rootSession(sessionId)}\u0000`;
  for (const [k, m] of [...sessions]) {
    if (!k.startsWith(prefix)) continue;
    sessions.delete(k);
    await Promise.all([...m.values()].map(async (e) => (e.client ?? (await e.starting?.catch(() => undefined)))?.stop()));
  }
}

export async function stopAllServers(): Promise<void> {
  const all = [...sessions.keys()];
  await Promise.all(all.map((k) => stopSession(k.split('\u0000')[0])));
}

process.once('exit', () => {
  for (const m of sessions.values()) for (const e of m.values()) e.client?.kill();
});

registerAgentExtension({
  id: 'nav-lsp',
  depths: [0],
  async onSessionEnd(a) {
    await stopSession(a.sessionId);
  },
});
