/**
 * Configuration: where the LLM is, what the agent may do, which MCP servers and
 * skills to load.
 *
 * Precedence (later wins): built-in defaults → ~/.tugline/config.json →
 * <workspace>/.tugline/config.json → <workspace>/.tugline/config.local.json
 * (git-ignored, for secrets) → environment variables → explicit overrides (CLI
 * flags / VS Code settings).
 *
 * Env vars: TUG_BASE_URL, TUG_API_KEY, TUG_MODEL, TUG_CONTEXT_WINDOW, TUG_TOOL_MODE,
 * TUG_PROFILE. OPENAI_BASE_URL / OPENAI_API_KEY are honoured as fallbacks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelProfile, PermissionMode, ToolMode } from './types.js';
import { applyGovernance } from './policy/managed.js';
import { modeWithin } from './permissions/authority.js';
import { applyPlugins } from './plugins/index.js';
import { requestedRunner, type RunnerName } from './sandbox/settings.js';

export interface McpServerConfig {
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** streamable HTTP / SSE */
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  /** Trust: auto-allow this server's tools without asking. Default false. */
  trusted?: boolean;
}

export interface HookConfig {
  /** Tool name glob, e.g. "bash" or "edit_file|write_file" or "*" */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

/**
 * Namespaced config sections added by v1.0 workstreams (SPEC S0.4). Each
 * workstream augments this interface from its own module:
 *
 *   declare module '../config.js' { interface HarnessConfigExtensions { edit?: EditConfig } }
 *
 * Unknown sections pass through deepMerge; untrusted project config drops them.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HarnessConfigExtensions {}
/** Extra keys under `agent` (SPEC S0.4), e.g. maxParallelSubagents, toolSearchThreshold. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AgentConfigExtensions {}
/** Extra keys under `shell` (e.g. sandbox runner options). */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ShellConfigExtensions {}

export interface HarnessConfig extends HarnessConfigExtensions {
  /** Active profile name */
  profile: string;
  profiles: Record<string, Partial<ModelProfile>>;
  /** Optional cheaper model for summaries, web extraction, explore subagents */
  smallProfile?: string;
  permissionMode: PermissionMode;
  permissions: {
    allow: string[];
    deny: string[];
    /** N43: rules that always ask a human (in every mode; the auto-mode classifier never settles them). */
    ask?: string[];
    /** Paths the agent may never write: the "judge" (EAG S17). Glob, workspace-relative. */
    protectedPaths: string[];
    /** Extra directories (absolute) the agent may read/write outside the workspace */
    additionalDirectories: string[];
  };
  shell: ShellConfigExtensions & {
    /** 'shell' = bash -c with permission prompts; 'allowlist' = no shell, argv only, allowlisted programs (EAG S17) */
    mode: 'shell' | 'allowlist';
    allowlist: string[];
    timeoutMs: number;
    maxOutputChars: number;
    /** 'none' runs on the host; 'docker' runs each command in a throwaway container; the OS sandboxes (SPEC C2) are provided by a command wrapper */
    sandbox: 'none' | 'docker' | 'auto' | 'seatbelt' | 'bwrap';
    dockerImage: string;
    dockerNetwork: 'none' | 'bridge';
    /** Environment variables never passed to child processes */
    scrubEnv: string[];
  };
  web: {
    searchProvider: 'duckduckgo' | 'searxng' | 'brave' | 'tavily' | 'none';
    searxngUrl?: string;
    braveApiKey?: string;
    tavilyApiKey?: string;
    fetchMaxChars: number;
    /** Hosts web_fetch may reach even if they resolve to private addresses (intranet docs). Supports *.corp.example */
    allowHosts?: string[];
  };
  agent: AgentConfigExtensions & {
    maxTurns: number;
    /** Same failing command this many times in a row → stop (EAG S17) */
    maxRepeatFailures: number;
    /** Fraction of the context window at which to compact */
    compactAt: number;
    maxToolOutputChars: number;
    /** Per-run cost budget (USD). Absent = unlimited; 0 = exhausted (v1.1 R4: no model call is admitted). */
    maxCostUsd?: number;
    /** Per-run token budget. Absent = unlimited; 0 = exhausted. */
    maxTokens?: number;
    /** 'full' system prompt or a 'compact' one for small local models */
    promptStyle: 'full' | 'compact';
    /** Run a fresh-context validator subagent before finishing coding tasks */
    autoValidate: boolean;
    /** If files changed but no command ran after the last edit, nudge once to verify before accepting the answer */
    requireVerification: boolean;
    parallelReadOnlyTools: boolean;
  };
  skills: { dirs: string[]; disabled: string[] };
  mcpServers: Record<string, McpServerConfig>;
  /** Hook event name → hooks. v0.1 events: PreToolUse, PostToolUse, UserPromptSubmit, Stop; more in SPEC C6. */
  hooks: { PreToolUse?: HookConfig[]; PostToolUse?: HookConfig[]; UserPromptSubmit?: HookConfig[]; Stop?: HookConfig[]; [event: string]: HookConfig[] | undefined };
  /** Directory for sessions/journals; default ~/.tugline */
  homeDir: string;
  /**
   * Set by loadConfig: whether project config was applied in full, and what was ignored. `clamped` (N36 SAC1, S7):
   * project settings that would have loosened the sandbox, network or approval mode, ignored even in a trusted
   * workspace unless the user lists it in sandbox.trustProjectConfig (user scope). `projectAllow` (N43, S7): allow
   * rules a project layer that may set them asked for (governance drops the ones it may not set).
   */
  trust?: { workspaceTrusted: boolean; ignored: string[]; clamped?: string[]; projectAllow?: { rule: string; source: string }[] };
}

export const DEFAULT_PROFILE: ModelProfile = {
  name: 'default',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  model: 'qwen3-coder:30b',
  contextWindow: 32768,
  maxOutputTokens: 8192,
  toolMode: 'auto',
  vision: false,
  temperature: 0.2,
  timeoutMs: 600_000,
};

export function defaultConfig(): HarnessConfig {
  return {
    profile: 'default',
    profiles: { default: { ...DEFAULT_PROFILE } },
    permissionMode: 'ask',
    permissions: {
      allow: [],
      deny: [],
      protectedPaths: ['.git/**', '.tugline/config*.json', '.mcp.json'],
      additionalDirectories: [],
    },
    shell: {
      mode: 'shell',
      allowlist: ['pytest', 'python', 'python3', 'uv', 'pip', 'ruff', 'mypy', 'git', 'node', 'npm', 'pnpm', 'yarn', 'tsc', 'go', 'cargo', 'make', 'ls', 'cat', 'echo', 'mkdir', 'java', 'mvn', 'gradle', 'dotnet'],
      timeoutMs: 120_000,
      maxOutputChars: 30_000,
      // N30: OS sandbox where available (bwrap / Seatbelt), else unsandboxed with a warning (src/core/sandbox)
      sandbox: 'auto',
      dockerImage: 'node:22-bookworm',
      dockerNetwork: 'none',
      scrubEnv: ['TUG_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'GH_TOKEN'],
    },
    web: { searchProvider: 'duckduckgo', fetchMaxChars: 40_000 },
    agent: {
      maxTurns: 60,
      maxRepeatFailures: 4,
      compactAt: 0.75,
      maxToolOutputChars: 30_000,
      promptStyle: 'full',
      autoValidate: false,
      requireVerification: true,
      parallelReadOnlyTools: true,
    },
    skills: { dirs: [], disabled: [] },
    mcpServers: {},
    hooks: {},
    // v1.2 N49: TUG_HOME (tug --home <dir>) isolates config, sessions and state, like Cline's --data-dir
    homeDir: process.env.TUG_HOME ? path.resolve(process.env.TUG_HOME) : path.join(os.homedir(), '.tugline'),
  };
}

function readJson(file: string): any {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: any): T {
  if (!isObj(over)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

export interface LoadOptions {
  workspace: string;
  overrides?: any;
  env?: NodeJS.ProcessEnv;
  /** Skip reading ~/.tugline (tests) */
  noUserConfig?: boolean;
  /** Force trust on/off for project config (default: look up the trust store) */
  trusted?: boolean;
}

// ------------------------------------------------------------ workspace trust
//
// Project config (.tugline/config*.json, .mcp.json) comes from the repository,
// i.e. from whoever wrote the repo. Until the user trusts the workspace, it may
// only ADD restrictions (deny rules, protected paths, disabled skills). It may not
// change the model endpoint (which would send your API key elsewhere), start MCP
// servers, run hooks, add allow rules or loosen modes (EAG S12: authority never
// comes from content the agent reads).

function trustFile(homeDir: string): string {
  return path.join(homeDir, 'trusted-workspaces.json');
}

/**
 * The user config file alone (`<homeDir>/config.json`), for settings that loosen safety and must never come from a
 * project config (v1.2 WS24: `permissions.readOnlyCommands`, `worktree.trustHooks`, `lsp.allowWorkspaceBinaries` …).
 */
export function readUserConfigFile(homeDir: string): any {
  return readJsonSafe(path.join(homeDir, 'config.json')) ?? {};
}

export function isWorkspaceTrusted(homeDir: string, workspace: string): boolean {
  const t = readJsonSafe(trustFile(homeDir));
  return !!t && t[path.resolve(workspace)] === true;
}

export function trustWorkspace(homeDir: string, workspace: string): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const t = readJsonSafe(trustFile(homeDir)) ?? {};
  t[path.resolve(workspace)] = true;
  fs.writeFileSync(trustFile(homeDir), JSON.stringify(t, null, 2), { mode: 0o600 });
}

function readJsonSafe(f: string): any {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Keep only the restrictive parts of an untrusted project config; report the rest. */
function restrictOnly(layer: any, source: string, ignored: string[]): any {
  if (!isObj(layer)) return undefined;
  const out: any = {};
  for (const [k, v] of Object.entries(layer)) {
    if (k === 'permissions' && isObj(v)) {
      out.permissions = {};
      if (Array.isArray(v.deny)) out.permissions.deny = v.deny;
      if (Array.isArray(v.ask)) out.permissions.ask = v.ask;
      if (Array.isArray(v.protectedPaths)) out.permissions.protectedPaths = v.protectedPaths;
      for (const pk of Object.keys(v)) if (pk !== 'deny' && pk !== 'ask' && pk !== 'protectedPaths') ignored.push(`${source}: permissions.${pk}`);
    } else if (k === 'skills' && isObj(v) && Array.isArray(v.disabled)) {
      out.skills = { disabled: v.disabled };
    } else ignored.push(`${source}: ${k}`);
  }
  return out;
}

/**
 * N43 / S7: whatever the trust, a project layer can never loosen the approval mode. It may ask for a STRICTER
 * mode (ask, plan); `acceptEdits`, `auto` and `yolo`, and the auto-mode and classifier-approver settings, are
 * user or managed scope only.
 */
const PROJECT_MODES = new Set(['ask', 'plan']);
function noProjectLoosening(layer: any, source: string, ignored: string[], projectAllow: { rule: string; source: string }[]): any {
  if (!isObj(layer)) return layer;
  const out = { ...layer };
  // N43 / S7 (review finding 5): a project allow rule may not pre-approve what auto mode's floor keeps for a human;
  // recorded here, judged in applyGovernance (managed.ts `gateProjectAllowRules`), next to the project-hook gate.
  if (isObj(out.permissions) && Array.isArray(out.permissions.allow)) {
    const keep: string[] = [];
    for (const r of out.permissions.allow) {
      if (typeof r !== 'string') ignored.push(`${source}: permissions.allow ${JSON.stringify(r)} (not a rule)`);
      else (keep.push(r), projectAllow.push({ rule: r, source }));
    }
    out.permissions = { ...out.permissions, allow: keep };
  }
  if (out.permissionMode !== undefined && !PROJECT_MODES.has(out.permissionMode)) {
    ignored.push(`${source}: permissionMode ${JSON.stringify(out.permissionMode)} (only your user config, a CLI flag or managed policy can choose a looser approval mode)`);
    delete out.permissionMode;
  }
  for (const k of ['autoMode', 'approver']) {
    if (out[k] === undefined) continue;
    ignored.push(`${source}: ${k} (user or managed config only)`);
    delete out[k];
  }
  return out;
}

// ------------------------------------------------------------ N36 SAC1 / S7: project config can only tighten

/**
 * Re-check RC-2: the runner a config's "auto" resolves to on this machine, supplied by the sandbox module (a seam:
 * config.ts must not import it). Without it, "auto" counts as bwrap (the strongest it can be), so nothing loosens.
 */
let effectiveRunner: ((cfg: HarnessConfig) => RunnerName) | undefined;
export function setEffectiveRunnerHook(f: typeof effectiveRunner): void {
  effectiveRunner = f;
}
/** review finding 6b: runner strength for the project clamp (auto may fall back to none; Landlock has no PID namespace or kernel protected paths) */
const RUNNER_STRENGTH: Record<RunnerName, number> = { none: 0, auto: 1, landlock: 2, bwrap: 3, seatbelt: 3, docker: 4, podman: 4 };
const NET_RANK: Record<string, number> = { host: 0, auto: 1, proxy: 1, none: 2 };

function subset(a: unknown, b: unknown): boolean {
  return Array.isArray(a) && a.every((x) => Array.isArray(b) && b.includes(x));
}

/**
 * S7: a project layer (.tugline/config*.json) may never loosen sandbox, network or approval settings, even when
 * the workspace is trusted. Returns the layer with loosening keys removed, and records each one in `clamped`.
 * Tightening keys pass (a stricter runner, sandbox.require: true, network "none", a read-only workspace, a stricter
 * permission mode, fewer allowed domains). The user can let one workspace's config loosen them by listing it in
 * sandbox.trustProjectConfig in their user config.
 */
export function clampProjectLayer(layer: any, base: HarnessConfig, source: string, clamped: string[]): any {
  if (!isObj(layer)) return layer;
  const out: any = { ...layer };
  const drop = (obj: any, key: string, label: string, why: string) => {
    delete obj[key];
    clamped.push(`${source}: ${label} ignored: ${why}`);
  };
  // review finding 6a: a security section that is not an object would replace the user's whole section
  for (const k of ['sandbox', 'shell', 'web', 'permissions', 'container', 'approver']) {
    if (out[k] !== undefined && !isObj(out[k])) drop(out, k, `${k} ${JSON.stringify(out[k]).slice(0, 40)}`, 'not an object (it would replace your whole section)');
  }
  /** review finding 6: per section, the keys a project may set at all; anything else is dropped and reported */
  const onlyKeys = (obj: any, section: string, allowed: string[]) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) drop(obj, k, `${section}.${k}`, 'a project may not set it (user scope)');
  };
  const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const baseRunner = requestedRunner(base);
  // re-check RC-2: what the user's runner actually is on this machine ("auto" is bwrap, Landlock or nothing)
  const effective = baseRunner === 'auto' ? effectiveRunner?.(base) : undefined;
  const baseStrength = baseRunner === 'auto' ? (effective ? RUNNER_STRENGTH[effective] : RUNNER_STRENGTH.bwrap) : RUNNER_STRENGTH[baseRunner];
  const sb: any = isObj(out.sandbox) ? { ...out.sandbox } : undefined;
  const sh: any = isObj(out.shell) ? { ...out.shell } : undefined;
  // review finding 6b: strength, not equal rank: none < auto < landlock < bwrap = seatbelt < docker = podman; a
  // different runner of the same strength is taken only when it is the same runner
  const runnerOk = (v: unknown) => typeof v === 'string' && v in RUNNER_STRENGTH && v !== 'none' && (RUNNER_STRENGTH[v as RunnerName] > baseStrength || v === baseRunner || (effective !== undefined && v === effective));
  for (const [obj, key, label] of [[sb, 'runner', 'sandbox.runner'], [sb, 'mode', 'sandbox.mode'], [sh, 'sandbox', 'shell.sandbox']] as const) {
    if (obj && obj[key] !== undefined && !runnerOk(obj[key])) drop(obj, key, `${label} ${JSON.stringify(obj[key])}`, `it would loosen the sandbox (the user's runner is "${baseRunner}"${effective ? `, which is ${effective} here` : ''})`);
  }
  const bsb: any = base.sandbox ?? {};
  if (sb) {
    onlyKeys(sb, 'sandbox', ['runner', 'mode', 'require', 'required', 'network', 'allowDomains', 'allowDomainsPreset', 'allowWrite', 'readOnlyPaths', 'denyRead', 'filesystem', 'session', 'macosSeatbelt', 'seatbelt', 'unixSockets', 'container']);
    for (const k of ['require', 'required']) if (sb[k] !== undefined && sb[k] !== true) drop(sb, k, `sandbox.${k} ${JSON.stringify(sb[k])}`, 'a project cannot turn the sandbox requirement off');
    if (sb.network !== undefined && (typeof sb.network !== 'string' || (NET_RANK[sb.network] ?? -1) < (NET_RANK[bsb.network ?? 'auto'] ?? 1))) drop(sb, 'network', `sandbox.network ${JSON.stringify(sb.network)}`, 'it would open more network than the user allows');
    const baseDomains = bsb.allowDomains ?? [];
    if (sb.allowDomains !== undefined && !subset(sb.allowDomains, baseDomains)) drop(sb, 'allowDomains', `sandbox.allowDomains (${(Array.isArray(sb.allowDomains) ? sb.allowDomains : []).filter((d: string) => !baseDomains.includes(d)).join(', ') || 'invalid'})`, 'a project cannot add reachable hosts');
    const basePresets = bsb.allowDomainsPreset ?? ['npm', 'pypi', 'cargo', 'go', 'maven', 'github-releases'];
    if (sb.allowDomainsPreset !== undefined && !subset(sb.allowDomainsPreset, basePresets)) drop(sb, 'allowDomainsPreset', 'sandbox.allowDomainsPreset', 'a project cannot add reachable hosts');
    const baseWrite = bsb.allowWrite ?? ['~/.cache', '~/.npm', '~/.yarn', '~/.pnpm-store', '~/.cargo/registry', '~/go/pkg/mod', '~/.m2', '~/.gradle', '~/.nuget/packages'];
    if (sb.allowWrite !== undefined && !subset(sb.allowWrite, baseWrite)) drop(sb, 'allowWrite', 'sandbox.allowWrite', 'a project cannot add writable directories');
    if (sb.filesystem !== undefined && sb.filesystem !== 'read-only' && (bsb.filesystem === 'read-only' || sb.filesystem !== 'workspace-write')) drop(sb, 'filesystem', `sandbox.filesystem ${JSON.stringify(sb.filesystem)}`, 'the user keeps the workspace read-only');
    if (sb.session !== undefined && sb.session !== 'container' && (bsb.session === 'container' || sb.session !== 'host')) drop(sb, 'session', `sandbox.session ${JSON.stringify(sb.session)}`, 'the user runs sessions in a container');
    if (sb.macosSeatbelt !== undefined && sb.macosSeatbelt !== true) drop(sb, 'macosSeatbelt', 'sandbox.macosSeatbelt', 'a project cannot turn Seatbelt off');
    if (sb.seatbelt !== undefined && sb.seatbelt !== 'restrictive' && (bsb.seatbelt === 'restrictive' || sb.seatbelt !== 'permissive')) drop(sb, 'seatbelt', `sandbox.seatbelt ${JSON.stringify(sb.seatbelt)}`, 'the user runs the restrictive profile');
    if (sb.unixSockets !== undefined && sb.unixSockets !== 'deny' && bsb.unixSockets !== sb.unixSockets) drop(sb, 'unixSockets', `sandbox.unixSockets ${JSON.stringify(sb.unixSockets)}`, 'host daemon sockets (Docker: host root) stay closed');
    if (sb.container !== undefined) {
      if (!isObj(sb.container)) drop(sb, 'container', 'sandbox.container', 'not an object');
      else {
        const c = { ...sb.container };
        for (const k of Object.keys(c)) if (k !== 'image' || typeof c[k] !== 'string') drop(c, k, `sandbox.container.${k}`, 'host mounts, environment and limits of the session container are user-scope settings');
        sb.container = c;
      }
    }
    // lists that only protect: kept as a union with the user's (never a replacement); denyRead adds to the defaults
    // wherever it is set (settings.ts denyReadPaths), so a project list can only add stores
    for (const k of ['readOnlyPaths', 'denyRead']) {
      if (sb[k] === undefined) continue;
      if (!strs(sb[k])) drop(sb, k, `sandbox.${k}`, 'not a list of paths');
      else sb[k] = [...new Set([...((bsb[k] as string[] | undefined) ?? (k === 'readOnlyPaths' ? ['.git/hooks', '.git/config', '.tugline', '.mcp.json', '.vscode', '.claude', '.envrc'] : [])), ...sb[k]])];
    }
    out.sandbox = sb;
  }
  if (sh) {
    onlyKeys(sh, 'shell', ['sandbox', 'requireSandbox', 'dockerNetwork', 'processLifetime', 'mode', 'allowlist', 'scrubEnv', 'timeoutMs', 'maxOutputChars', 'dockerImage']);
    if (sh.requireSandbox !== undefined && sh.requireSandbox !== true) drop(sh, 'requireSandbox', `shell.requireSandbox ${JSON.stringify(sh.requireSandbox)}`, 'a project cannot turn the sandbox requirement off');
    if (sh.dockerNetwork !== undefined && sh.dockerNetwork !== 'none' && base.shell.dockerNetwork !== sh.dockerNetwork) drop(sh, 'dockerNetwork', `shell.dockerNetwork ${JSON.stringify(sh.dockerNetwork)}`, 'it would give container commands network access');
    if (sh.processLifetime !== undefined && sh.processLifetime !== 'session') drop(sh, 'processLifetime', `shell.processLifetime ${JSON.stringify(sh.processLifetime)}`, 'commands would outlive the session');
    // review finding 6c: shell mode, allowlist and env scrubbing
    if (sh.mode !== undefined && sh.mode !== 'allowlist' && (base.shell.mode === 'allowlist' || sh.mode !== 'shell')) drop(sh, 'mode', `shell.mode ${JSON.stringify(sh.mode)}`, 'the user runs commands from an allowlist only');
    if (sh.allowlist !== undefined && (!strs(sh.allowlist) || (base.shell.mode === 'allowlist' && !subset(sh.allowlist, base.shell.allowlist)))) drop(sh, 'allowlist', 'shell.allowlist', 'a project cannot add allowed programs');
    if (sh.scrubEnv !== undefined) {
      if (!strs(sh.scrubEnv)) drop(sh, 'scrubEnv', 'shell.scrubEnv', 'not a list of names');
      else sh.scrubEnv = [...new Set([...base.shell.scrubEnv, ...sh.scrubEnv])]; // only adds names to scrub
    }
    if (sh.dockerImage !== undefined && typeof sh.dockerImage !== 'string') drop(sh, 'dockerImage', 'shell.dockerImage', 'not a string');
    for (const k of ['timeoutMs', 'maxOutputChars']) if (sh[k] !== undefined && typeof sh[k] !== 'number') drop(sh, k, `shell.${k}`, 'not a number');
    out.shell = sh;
  }
  if (isObj(out.web)) {
    const w: any = { ...out.web };
    const baseHosts = base.web.allowHosts ?? [];
    if (w.allowHosts !== undefined && !subset(w.allowHosts, baseHosts)) drop(w, 'allowHosts', 'web.allowHosts', 'a project cannot open private hosts to web_fetch');
    for (const k of ['braveApiKey', 'tavilyApiKey']) if (w[k] !== undefined) drop(w, k, `web.${k}`, 'keys are user-scope settings');
    out.web = w;
  }
  if (isObj(out.permissions)) {
    // review finding 6c: allow rules and extra directories are approvals and sandbox-writable roots: user scope
    const pm: any = { ...out.permissions };
    // N43: `ask` rules only ever add prompts (restrictive), so a project may set them
    onlyKeys(pm, 'permissions', ['deny', 'ask', 'protectedPaths', 'ignoreMode', 'gitignoreReads', 'hideGitignored']);
    for (const k of ['deny', 'ask', 'protectedPaths']) if (pm[k] !== undefined && !strs(pm[k])) drop(pm, k, `permissions.${k}`, 'not a list');
    if (pm.ignoreMode !== undefined && pm.ignoreMode !== 'deny' && pm.ignoreMode !== 'ask') drop(pm, 'ignoreMode', 'permissions.ignoreMode', 'invalid');
    if (pm.ignoreMode === 'ask' && (base.permissions as { ignoreMode?: string }).ignoreMode === 'deny') drop(pm, 'ignoreMode', 'permissions.ignoreMode "ask"', 'the user denies ignored files');
    if (pm.gitignoreReads !== undefined && pm.gitignoreReads !== 'ask') drop(pm, 'gitignoreReads', `permissions.gitignoreReads ${JSON.stringify(pm.gitignoreReads)}`, 'a project can only make reads stricter');
    if (pm.hideGitignored !== undefined && pm.hideGitignored !== true) drop(pm, 'hideGitignored', 'permissions.hideGitignored', 'a project can only hide more');
    out.permissions = pm;
  }
  if (isObj(out.container)) {
    const c: any = { ...out.container };
    for (const k of Object.keys(c)) if (k !== 'image' || typeof c[k] !== 'string') drop(c, k, `container.${k}`, 'host mounts, environment and limits of the session container are user-scope settings');
    out.container = c;
  }
  // N43: modes are a partial order (`auto` and `acceptEdits` incomparable, `yolo` loosest): a project mode must be within the user's
  if (out.permissionMode !== undefined && !modeWithin(String(out.permissionMode), base.permissionMode)) drop(out, 'permissionMode', `permissionMode ${JSON.stringify(out.permissionMode)}`, `it is looser than the user's "${base.permissionMode}"`);
  if (isObj(out.approver)) {
    const ap: any = { ...out.approver };
    if (ap.enabled !== undefined && ap.enabled !== false && (base as any).approver?.enabled !== true) drop(ap, 'enabled', 'approver.enabled', 'a project cannot turn on auto-approval');
    out.approver = ap;
  }
  return out;
}

/** Does the user (at user scope) let this workspace's project config loosen sandbox and network settings? */
export function projectMayLoosen(userLayer: any, workspace: string): boolean {
  const list = userLayer?.sandbox?.trustProjectConfig;
  return Array.isArray(list) && list.some((p: unknown) => typeof p === 'string' && path.resolve(p) === path.resolve(workspace));
}

export function loadConfig(opts: LoadOptions): HarnessConfig {
  const env = opts.env ?? process.env;
  let cfg = defaultConfig();
  const userFile = path.join(cfg.homeDir, 'config.json');
  const userLayer = opts.noUserConfig ? undefined : readJson(userFile);
  if (!opts.noUserConfig) cfg = deepMerge(cfg, userLayer);
  const trusted = opts.trusted ?? (opts.noUserConfig ? false : isWorkspaceTrusted(cfg.homeDir, opts.workspace));
  const ignored: string[] = [];
  const projectAllow: { rule: string; source: string }[] = [];
  const clamped: string[] = [];
  // N36 SAC1: only the user's own config (or an explicit override) can say a project may loosen the sandbox
  const mayLoosen = projectMayLoosen(userLayer, opts.workspace) || projectMayLoosen(opts.overrides, opts.workspace);
  const unionLists = (base: HarnessConfig, layer: any) => {
    // Restrictive lists accumulate across layers instead of replacing each other.
    const merged = deepMerge(base, layer);
    if (layer?.permissions?.deny) merged.permissions.deny = [...new Set([...base.permissions.deny, ...layer.permissions.deny])];
    if (layer?.permissions?.ask) merged.permissions.ask = [...new Set([...(base.permissions.ask ?? []), ...layer.permissions.ask])];
    if (layer?.permissions?.protectedPaths) merged.permissions.protectedPaths = [...new Set([...base.permissions.protectedPaths, ...layer.permissions.protectedPaths])];
    return merged;
  };
  for (const f of ['config.json', 'config.local.json']) {
    const layer = readJson(path.join(opts.workspace, '.tugline', f));
    if (layer === undefined) continue;
    // v1.2 F16 (WS17): commands to run as external team members and container images for agents come only from the
    // user or managed config, never from a project file (trusted or not)
    // v1.2 gate 3 (S7): chat channels (listener host, tokens, trust, apiBase) are the user's alone
    if (layer && typeof layer === 'object' && 'channels' in layer) {
      delete layer.channels;
      ignored.push(`.tugline/${f}: channels (user config only)`);
    }
    for (const [sec, key] of [['team', 'externalAgents'], ['team', 'externalReadOnly'], ['agent', 'containerImages']] as const) {
      if (layer?.[sec] && typeof layer[sec] === 'object' && key in layer[sec]) {
        delete layer[sec][key];
        ignored.push(`.tugline/${f}: ${sec}.${key} (user or managed config only)`);
      }
    }
    const src = `.tugline/${f}`;
    // N43 / S7: never a looser approval mode, autoMode or approver from a project; allow rules (only kept where the
    // user lets this project loosen settings) go through the governance gate
    if (trusted) {
      cfg = unionLists(cfg, noProjectLoosening(mayLoosen ? layer : clampProjectLayer(layer, cfg, src, clamped), src, ignored, projectAllow));
    }
    else {
      // untrusted: only restrictions; tightening sandbox keys are honoured too (a project may always ask for more safety)
      const tight = clampProjectLayer({ sandbox: layer?.sandbox, shell: isObj(layer?.shell) ? { requireSandbox: layer.shell.requireSandbox, sandbox: layer.shell.sandbox } : undefined }, cfg, src, []);
      const keep: any = {};
      if (isObj(tight.sandbox)) keep.sandbox = Object.fromEntries(Object.entries(tight.sandbox).filter(([k]) => ['runner', 'mode', 'require', 'required', 'network', 'filesystem', 'session', 'readOnlyPaths', 'denyRead'].includes(k)));
      if (isObj(tight.shell)) keep.shell = Object.fromEntries(Object.entries(tight.shell).filter(([, v]) => v !== undefined));
      cfg = unionLists(cfg, { ...restrictOnly(layer, src, ignored), ...keep });
    }
  }
  // Claude-Code-compatible .mcp.json at the project root (starting servers = running code → trust required)
  const mcpJson = readJson(path.join(opts.workspace, '.mcp.json'));
  if (isObj(mcpJson?.mcpServers)) {
    if (trusted) cfg.mcpServers = { ...mcpJson.mcpServers, ...cfg.mcpServers };
    else ignored.push(`.mcp.json: mcpServers (${Object.keys(mcpJson.mcpServers).join(', ')})`);
  }
  cfg.trust = { workspaceTrusted: trusted, ignored, clamped, projectAllow };

  if (env.TUG_PROFILE) cfg.profile = env.TUG_PROFILE;
  const envProfile: Partial<ModelProfile> = {};
  const baseUrl = env.TUG_BASE_URL ?? env.OPENAI_BASE_URL;
  const apiKey = env.TUG_API_KEY ?? env.OPENAI_API_KEY;
  if (baseUrl) envProfile.baseUrl = baseUrl;
  if (apiKey) envProfile.apiKey = apiKey;
  if (env.TUG_MODEL) envProfile.model = env.TUG_MODEL;
  if (env.TUG_CONTEXT_WINDOW) envProfile.contextWindow = Number(env.TUG_CONTEXT_WINDOW);
  if (env.TUG_MAX_OUTPUT_TOKENS) envProfile.maxOutputTokens = Number(env.TUG_MAX_OUTPUT_TOKENS);
  if (env.TUG_TOOL_MODE) envProfile.toolMode = env.TUG_TOOL_MODE as ToolMode;
  if (env.TUG_VISION) envProfile.vision = env.TUG_VISION === '1' || env.TUG_VISION === 'true';
  if (Object.keys(envProfile).length) cfg.profiles[cfg.profile] = { ...(cfg.profiles[cfg.profile] ?? {}), ...envProfile };
  if (env.TUG_PERMISSION_MODE) cfg.permissionMode = env.TUG_PERMISSION_MODE as PermissionMode;
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  // N43: a mode name that does not exist is an error the user can act on, never a silent fallback
  if (!['ask', 'acceptEdits', 'plan', 'auto', 'yolo'].includes(cfg.permissionMode as string)) throw new Error(`config: unknown permissionMode ${JSON.stringify(cfg.permissionMode)}: use ask | acceptEdits | plan | auto | yolo ("auto" now uses a safety classifier; the old no-classifier behaviour is "yolo")`);
  // N43 (capability from Qwen Code's MCP grant-ambiguity checks): two servers whose names collide once sanitised
  // (`a.b` / `a_b` → mcp__a_b__*) would share one tool namespace, so an allow rule or trust meant for one could reach
  // the other. Fail closed with a message the user can act on.
  const seenMcp = new Map<string, string>();
  for (const name of Object.keys(cfg.mcpServers ?? {})) {
    const key = name.replace(/[^A-Za-z0-9_-]/g, '_');
    const other = seenMcp.get(key);
    if (other !== undefined) throw new Error(`config: MCP servers "${other}" and "${name}" both become mcp__${key}__… tool names; rename one so permission rules cannot apply to the wrong server`);
    seenMcp.set(key, name);
  }
  // The harness's own config is always protected from the agent.
  for (const p of ['.tugline/config*.json', '.mcp.json']) if (!cfg.permissions.protectedPaths.includes(p)) cfg.permissions.protectedPaths.push(p);
  // WS7 (SPEC G4): installed plugins add skills/agents/commands, and trusted MCP servers and hooks — before governance, so managed policy applies to them too.
  cfg = applyPlugins(cfg, { workspace: opts.workspace, noUserConfig: opts.noUserConfig });
  // WS3 (SPEC C4/C6): managed policy beats every layer above; unapproved project hooks are dropped.
  return applyGovernance(cfg, { workspace: opts.workspace, env, trusted, noUserConfig: opts.noUserConfig });
}

export function resolveProfile(cfg: HarnessConfig, name = cfg.profile): ModelProfile {
  const p = cfg.profiles[name];
  if (!p) throw new Error(`unknown model profile "${name}". Known: ${Object.keys(cfg.profiles).join(', ')}`);
  const merged: ModelProfile = { ...DEFAULT_PROFILE, ...p, name };
  if (merged.apiKey?.startsWith('env:')) merged.apiKey = process.env[merged.apiKey.slice(4)] ?? '';
  return merged;
}

/** Write a starter user config if none exists. Returns the path. */
export function writeStarterConfig(homeDir: string, profile: Partial<ModelProfile>): string {
  const file = path.join(homeDir, 'config.json');
  fs.mkdirSync(homeDir, { recursive: true });
  const existing = readJson(file) ?? {};
  const next = deepMerge(existing, { profile: profile.name ?? 'default', profiles: { [profile.name ?? 'default']: profile } });
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return file;
}
