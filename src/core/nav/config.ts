/**
 * `lsp` config section (N3), declaration-merged into HarnessConfigExtensions.
 *
 * Language servers are OFF by default: a server loads project code and plugins
 * (tsserver plugins from tsconfig, rust-analyzer build scripts, …), so the user
 * opts in per language. Without one, the code_* tools use tree-sitter/regex
 * name matching.
 *
 *   "lsp": { "servers": { "typescript": true,                         // preset command
 *                         "python": "pyright-langserver --stdio",     // custom command
 *                         "go": { "command": ["gopls"], "extensions": [".go"] } } }
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { isTrusted, pluginDir, readState } from '../plugins/store.js';

export interface LspServerSpec {
  /** argv, or a command line split on whitespace (quotes respected) */
  command: string[] | string;
  /** extra arguments appended to `command` (Qwen/Claude-plugin `.lsp.json` shape) */
  args?: string[];
  /** file extensions this server handles (default: the preset's) */
  extensions?: string[];
  /** extension → LSP languageId overrides, e.g. {".tsx": "typescriptreact"} (also adds the extension) */
  extensionToLanguage?: Record<string, string>;
  /** sent as `initializationOptions` (e.g. {"tsserver":{"path":"…/tsserver.js"}}) */
  initializationOptions?: unknown;
  /** answers the server's `workspace/configuration` requests (looked up by section, e.g. "python.analysis") */
  settings?: Record<string, unknown>;
  /** extra environment for the server (added after the scrub; never put secrets here) */
  env?: Record<string, string>;
  /** restart after a crash (default true), at most `maxRestarts` times per session (default 3) */
  restartOnCrash?: boolean;
  maxRestarts?: number;
  /** per-server start + initialize timeout (default lsp.startTimeoutMs) */
  startTimeoutMs?: number;
  /** only "stdio": a server we do not spawn ourselves cannot run under the sandbox (tcp/socket are refused) */
  transport?: 'stdio' | 'tcp' | 'socket';
}

export interface LspConfig {
  /**
   * When the code_* tools are offered. "auto" (default): only when a configured
   * server handles a language present in the workspace. true: also with name
   * matching alone (any supported language). false: never. Not on by default
   * without a server because the default CLI session sits at the tool-search
   * threshold (20 tools): four more tools would defer everyone's other tools.
   */
  enabled: boolean | 'auto';
  /** name → true (preset) | command line | spec. Empty = no servers (default). */
  servers: Record<string, true | string | string[] | LspServerSpec>;
  /** per-request timeout (definition, references, …) */
  requestTimeoutMs: number;
  /** server start + initialize timeout */
  startTimeoutMs: number;
  /** In the CLI, feed A6 post-edit verification with the server's diagnostics. */
  diagnostics: boolean;
  /** Max results a code_* tool prints. */
  maxResults: number;
  /**
   * N46: enable every preset whose language is in the workspace and whose binary is on PATH (outside the
   * workspace). Off by default: a language server loads project code. `tug lsp detect` shows what it would enable.
   */
  autoDetect: boolean;
  /**
   * Allow a server binary that lives inside the workspace (e.g. node_modules/.bin). USER SCOPE ONLY: the agent can
   * write the workspace, so a binary there is code the model could have planted. Default false.
   */
  allowWorkspaceBinaries: boolean;
}

export const DEFAULT_LSP: LspConfig = { enabled: 'auto', servers: {}, requestTimeoutMs: 15_000, startTimeoutMs: 30_000, diagnostics: true, maxResults: 50, autoDetect: false, allowWorkspaceBinaries: false };

declare module '../config.js' {
  interface HarnessConfigExtensions {
    lsp?: Partial<LspConfig>;
  }
}

export function lspConfig(cfg: Pick<HarnessConfig, 'lsp'> | undefined): LspConfig {
  return { ...DEFAULT_LSP, ...(cfg?.lsp ?? {}), servers: { ...(cfg?.lsp?.servers ?? {}) } };
}

const TS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Known servers (enable with `"<name>": true`). Commands are what each project documents. */
export const LSP_PRESETS: Record<string, { command: string[]; extensions: string[]; install: string }> = {
  typescript: { command: ['typescript-language-server', '--stdio'], extensions: TS_EXT, install: 'npm i -g typescript-language-server typescript' },
  python: { command: ['pyright-langserver', '--stdio'], extensions: ['.py', '.pyi'], install: 'npm i -g pyright (or pip install pyright)' },
  go: { command: ['gopls'], extensions: ['.go'], install: 'go install golang.org/x/tools/gopls@latest' },
  rust: { command: ['rust-analyzer'], extensions: ['.rs'], install: 'rustup component add rust-analyzer' },
  java: { command: ['jdtls'], extensions: ['.java'], install: 'install Eclipse JDT LS and put `jdtls` on PATH' },
  cpp: { command: ['clangd', '--background-index'], extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'], install: 'install clangd (apt install clangd, brew install llvm) and add compile_commands.json' },
};

export const LANGUAGE_ID: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascriptreact',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp',
};

export interface ResolvedServer {
  name: string;
  argv: string[];
  extensions: string[];
  initializationOptions?: unknown;
  install?: string;
  languageIds?: Record<string, string>;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  restartOnCrash: boolean;
  maxRestarts: number;
  startTimeoutMs?: number;
  /** where the definition came from */
  source: 'config' | 'plugin' | 'auto';
  /** set when the definition cannot be used (e.g. a tcp transport) */
  refused?: string;
}

/** Split a command line on whitespace, honouring '…' and "…". */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function readJson(f: string): any {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}

function toResolved(name: string, v: true | string | string[] | LspServerSpec, source: ResolvedServer['source']): ResolvedServer | undefined {
  const preset = LSP_PRESETS[name];
  const spec: LspServerSpec = v === true ? { command: preset?.command ?? [name] } : typeof v === 'string' || Array.isArray(v) ? { command: v } : v;
  if (!spec || (spec.command === undefined && !preset)) return undefined;
  const argv = [...(Array.isArray(spec.command) ? spec.command : splitCommand(String(spec.command ?? preset?.command.join(' ') ?? ''))), ...(Array.isArray(spec.args) ? spec.args.map(String) : [])];
  if (!argv.length) return undefined;
  const langIds = spec.extensionToLanguage && typeof spec.extensionToLanguage === 'object' ? Object.fromEntries(Object.entries(spec.extensionToLanguage).map(([k, l]) => [k.toLowerCase().startsWith('.') ? k.toLowerCase() : `.${k.toLowerCase()}`, String(l)])) : undefined;
  const exts = [...new Set([...(spec.extensions ?? preset?.extensions ?? []).map((e) => e.toLowerCase()), ...Object.keys(langIds ?? {})])];
  return {
    name,
    argv,
    extensions: exts,
    initializationOptions: spec.initializationOptions,
    install: preset?.install,
    languageIds: langIds,
    settings: spec.settings && typeof spec.settings === 'object' ? spec.settings : undefined,
    env: spec.env && typeof spec.env === 'object' ? Object.fromEntries(Object.entries(spec.env).map(([k, x]) => [k, String(x)])) : undefined,
    restartOnCrash: spec.restartOnCrash !== false,
    maxRestarts: Math.max(0, Math.min(10, Number(spec.maxRestarts ?? 3) || 0)),
    startTimeoutMs: spec.startTimeoutMs,
    source,
    refused: spec.transport && spec.transport !== 'stdio' ? `transport "${spec.transport}" is not supported: only stdio servers run under the sandbox (a server listening on a socket is outside it)` : undefined,
  };
}

/** `lspServers` of enabled AND trusted plugins (a plugin's server is code from the plugin: trust required, like its MCP servers). */
export function pluginServers(cfg: HarnessConfig): ResolvedServer[] {
  const out: ResolvedServer[] = [];
  try {
    for (const p of Object.values(readState(cfg.homeDir).plugins)) {
      if (!p?.enabled || !isTrusted(cfg.homeDir, p)) continue;
      const dir = pluginDir(cfg.homeDir, p.name);
      const decl = readJson(path.join(dir, '.lsp.json')) ?? readJson(path.join(dir, '.claude-plugin', 'plugin.json'))?.lspServers ?? readJson(path.join(dir, 'plugin.json'))?.lspServers;
      for (const [n, spec] of Object.entries<any>(decl ?? {})) {
        const r = toResolved(`${p.name}:${n}`, spec, 'plugin');
        if (r) out.push(r);
      }
    }
  } catch {
    /* no plugins */
  }
  return out;
}

/** Presets that would be enabled by autoDetect: language present in the workspace and binary on PATH (outside it). */
export function detectServers(workspace: string, has: (ext: string[]) => boolean, which: (bin: string) => string | null): { name: string; binary: string | null; present: boolean }[] {
  return Object.entries(LSP_PRESETS).map(([name, p]) => ({ name, present: has(p.extensions), binary: which(p.command[0]) }));
}

/** The configured servers with presets applied (config, then trusted plugins, then auto-detected presets). */
export function resolvedServers(cfg: HarnessConfig, workspace?: string): ResolvedServer[] {
  const out: ResolvedServer[] = [];
  for (const [name, v] of Object.entries(lspConfig(cfg).servers)) {
    if (v === undefined || v === null || (v as unknown) === false) continue;
    const r = toResolved(name, v, 'config');
    if (r) out.push(r);
  }
  for (const r of pluginServers(cfg)) if (!out.some((x) => x.name === r.name)) out.push(r);
  if (lspConfig(cfg).autoDetect && workspace && autoDetector) {
    for (const name of autoDetector(cfg, workspace)) {
      if (out.some((x) => x.name === name || x.extensions.some((e) => LSP_PRESETS[name].extensions.includes(e)))) continue;
      const r = toResolved(name, true, 'auto');
      if (r) out.push(r);
    }
  }
  return out;
}

let autoDetector: ((cfg: HarnessConfig, workspace: string) => string[]) | undefined;
export function setAutoDetector(f: (cfg: HarnessConfig, workspace: string) => string[]): void {
  autoDetector = f;
}

export function languageIdFor(s: ResolvedServer | undefined, abs: string): string {
  const ext = path.extname(abs).toLowerCase();
  return s?.languageIds?.[ext] ?? LANGUAGE_ID[ext] ?? 'plaintext';
}

export function serverFor(cfg: HarnessConfig, file: string, workspace?: string): ResolvedServer | undefined {
  const ext = path.extname(file).toLowerCase();
  return resolvedServers(cfg, workspace).find((s) => s.extensions.includes(ext));
}
