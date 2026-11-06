/**
 * The extension's HarnessConfig: config files (loadConfig) + VS Code settings +
 * the user's MCP toggles, with GOVERNANCE APPLIED LAST (SPEC C4 in VS Code).
 *
 * loadConfig ends with applyGovernance, but VS Code settings are layered on top
 * of it (they win over config files so everything can be configured in the UI).
 * Without a second governance pass a user setting could add an MCP server the
 * managed allowlist forbids, re-enable the approver under disableAutoMode, or
 * point the API key at an endpoint other than the locked one. So the managed
 * policy is applied again after the settings, and every LLM client the
 * extension creates takes its profile from this governed config
 * (`clientProfile`). Pure (settings are injected); unit-tested.
 */
import { isPermissionMode } from '../../src/core/approver/modes.js';
import { loadConfig, resolveProfile, type HarnessConfig } from '../../src/core/config.js';
import { applyGovernance } from '../../src/core/policy/managed.js';
import type { ModelProfile, PermissionMode } from '../../src/core/types.js';
import { ideConfig } from '../../src/core/host/vscode-contract.js';
import { rawAdmission, type AdmitHook } from '../../src/core/llm/admission.js';
import { applyMcpToggles, configFile, readConfigFile } from './configEdit.js';
import { applyPlanProfile } from './modelPick.js';

/**
 * A settings reader that returns ONLY values the user set (undefined otherwise).
 * Build it from `WorkspaceConfiguration.inspect` with `explicitSettings`: plain
 * `WorkspaceConfiguration.get` returns the contributed default for unset keys,
 * which would silently override ~/.tugline/config.json and project config.
 */
export type SettingsGet = (key: string) => any;

/** The subset of `WorkspaceConfiguration.inspect(key)` we read. */
export interface SettingInspect {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}
export type SettingsInspect = (key: string) => SettingInspect | undefined;

/**
 * Keys contributed with `"scope": "application"` in vscode/package.json. VS Code
 * ignores workspace/folder values for them (a cloned repo's .vscode/settings.json
 * must not redirect the API key or loosen permissions), so only the user's
 * global value counts. A unit test keeps this list in sync with package.json.
 */
export const APPLICATION_SCOPED = new Set([
  'baseUrl', 'extraHeaders', 'permissionMode', 'shellMode', 'autoValidate', 'webSearchProvider', 'searxngUrl', 'mcpServers', 'maxTurns', 'visibleTerminal',
  'autocomplete.enabled', 'autocomplete.profile', 'autocomplete.endpoint', 'autocomplete.template', 'browser.enabled', 'approver.enabled', 'approver.profile',
  // v1.1: preview hosts (N24), next-edit model (N15) and the voice transcriber (N25) move code, audio or authority
  'preview.allowHosts', 'nes.enabled', 'nes.profile', 'voice.enabled', 'voice.transcriber', 'voice.url',
]);

/**
 * The value the user actually set for a key, never the contributed default.
 * Precedence is VS Code's own (folder > workspace > user); application-scoped
 * keys read the user (global) value only.
 */
export function explicitSettings(inspect: SettingsInspect): SettingsGet {
  return (key) => {
    const i = inspect(key);
    if (!i) return undefined;
    if (APPLICATION_SCOPED.has(key)) return i.globalValue;
    return i.workspaceFolderValue ?? i.workspaceValue ?? i.globalValue;
  };
}

/** The `ide` section from VS Code settings: only the keys the user set (defaults come from config files, then DEFAULT_IDE). */
export function ideFromSettings(get: SettingsGet): NonNullable<HarnessConfig['ide']> {
  const pick = <T>(k: string): T | undefined => {
    const v = get(k);
    return v === undefined || v === null || v === '' ? undefined : (v as T);
  };
  const secs = pick<number>('notifyAfterSeconds');
  const ide: Record<string, unknown> = {
    autoSave: pick('autoSave'),
    visibleTerminal: pick('visibleTerminal'),
    inlineEditProfile: pick('inlineEditProfile'),
    planProfile: pick('planProfile'),
    visionProfile: pick('visionProfile'),
    ocr: pick('ocr'),
    notifications: pick('notifications'),
    notifyAfterMs: secs === undefined ? undefined : secs * 1000,
  };
  const ac: Record<string, unknown> = {};
  for (const k of ['enabled', 'profile', 'endpoint', 'template', 'debounceMs', 'maxTokens']) ac[k] = pick(`autocomplete.${k}`);
  const nes: Record<string, unknown> = {};
  for (const k of ['enabled', 'profile', 'latencyMs', 'maxTokens', 'debounceMs']) nes[k] = pick(`nes.${k}`);
  const voice: Record<string, unknown> = {};
  for (const k of ['enabled', 'transcriber', 'url', 'model', 'language', 'recorder', 'maxSeconds']) voice[k] = pick(`voice.${k}`);
  const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const out = strip(ide) as NonNullable<HarnessConfig['ide']>;
  const a = strip(ac);
  if (Object.keys(a).length) out.autocomplete = a;
  const n = strip(nes);
  if (Object.keys(n).length) out.nes = n;
  const v = strip(voice);
  if (Object.keys(v).length) out.voice = v;
  return out;
}

/** Config-file `ide` overlaid with the settings `ide` (autocomplete merged per key, not replaced). */
export function mergeIde(base: HarnessConfig['ide'], over: HarnessConfig['ide']): NonNullable<HarnessConfig['ide']> {
  const out = { ...(base ?? {}), ...(over ?? {}) };
  if (base?.autocomplete || over?.autocomplete) out.autocomplete = { ...(base?.autocomplete ?? {}), ...(over?.autocomplete ?? {}) };
  if (base?.nes || over?.nes) out.nes = { ...(base?.nes ?? {}), ...(over?.nes ?? {}) };
  if (base?.voice || over?.voice) out.voice = { ...(base?.voice ?? {}), ...(over?.voice ?? {}) };
  return out;
}

export interface GovernedOptions {
  workspace: string;
  /** only user-set values (see `explicitSettings`); unset keys fall back to config files, then core defaults */
  get: SettingsGet;
  /** from SecretStorage (or TUG_API_KEY) */
  apiKey?: string;
  /** VS Code workspace trust: false forces project config to restrict-only */
  vscodeTrusted?: boolean;
  env?: NodeJS.ProcessEnv;
  /** the ide section from settings */
  ide?: HarnessConfig['ide'];
  /** tests: skip ~/.tugline */
  noUserConfig?: boolean;
  /** tests: managed policy system path */
  systemPath?: string;
}

export function governedConfig(o: GovernedOptions): HarnessConfig {
  const g = o.get;
  const cfg = loadConfig({ workspace: o.workspace, trusted: o.vscodeTrusted === false ? false : undefined, env: o.env, noUserConfig: o.noUserConfig });
  const profile = cfg.profile;
  // VS Code settings win over config files for the endpoint (UI configuration) — governance re-applied below.
  const def = <T>(k: string): T | undefined => {
    const v = g(k);
    return v === undefined || v === null || v === '' ? undefined : v;
  };
  const p: Record<string, unknown> = { ...(cfg.profiles[profile] ?? {}) };
  for (const [k, key] of [['baseUrl', 'baseUrl'], ['model', 'model'], ['contextWindow', 'contextWindow'], ['maxOutputTokens', 'maxOutputTokens'], ['temperature', 'temperature'], ['toolMode', 'toolMode'], ['vision', 'vision'], ['headers', 'extraHeaders']] as const) {
    const v = def(key);
    if (v !== undefined) p[k] = v;
  }
  if (o.apiKey) p.apiKey = o.apiKey;
  cfg.profiles[profile] = p as Partial<ModelProfile>;
  // N43: only a real mode name (an old or mistyped value keeps the config's mode)
  const pm = def<PermissionMode>('permissionMode');
  if (isPermissionMode(pm)) cfg.permissionMode = pm;
  cfg.agent.promptStyle = def('promptStyle') ?? cfg.agent.promptStyle;
  cfg.agent.autoValidate = def<boolean>('autoValidate') ?? cfg.agent.autoValidate;
  cfg.agent.maxTurns = def<number>('maxTurns') ?? cfg.agent.maxTurns;
  cfg.shell.mode = def('shellMode') ?? cfg.shell.mode;
  cfg.permissions.protectedPaths = [...new Set([...cfg.permissions.protectedPaths, ...(def<string[]>('protectedPaths') ?? [])])];
  cfg.web.searchProvider = def('webSearchProvider') ?? cfg.web.searchProvider;
  if (def<string>('searxngUrl')) cfg.web.searxngUrl = def<string>('searxngUrl');
  // MCP: settings add user-level servers; the user's enable/trust toggles (B11) apply on top.
  let userCfg: Record<string, any> = {};
  if (!o.noUserConfig) {
    try {
      userCfg = readConfigFile(configFile('user', cfg.homeDir));
    } catch {
      /* invalid user config is reported by loadConfig */
    }
  }
  const settingServers = (def<Record<string, any>>('mcpServers') ?? {}) as Record<string, any>;
  cfg.mcpServers = { ...cfg.mcpServers, ...settingServers };
  const sources: Record<string, 'user' | 'project'> = {};
  for (const n of Object.keys(cfg.mcpServers)) sources[n] = n in settingServers || n in (userCfg.mcpServers ?? {}) ? 'user' : 'project';
  cfg.mcpServers = applyMcpToggles(cfg.mcpServers, userCfg.ide?.mcp, sources, o.workspace);
  cfg.ide = mergeIde(cfg.ide, o.ide);
  // Wave-1 features exposed as settings: browser tools (E1) and the classifier approver (C3).
  const browserEnabled = def<boolean>('browser.enabled');
  if (browserEnabled !== undefined) cfg.browser = { ...(cfg.browser ?? {}), enabled: browserEnabled };
  const approverEnabled = def<boolean>('approver.enabled');
  if (approverEnabled !== undefined) cfg.approver = { ...(cfg.approver ?? {}), enabled: approverEnabled };
  const approverProfile = def<string>('approver.profile');
  if (approverProfile) cfg.approver = { ...(cfg.approver ?? {}), profile: approverProfile };
  applyPlanProfile(cfg, ideConfig(cfg).planProfile);
  // C4: the managed policy wins over every layer, VS Code settings included.
  applyGovernance(cfg, { workspace: o.workspace, env: o.env, trusted: cfg.trust?.workspaceTrusted ?? false, noUserConfig: o.noUserConfig, systemPath: o.systemPath });
  for (const n of Object.keys(sources)) if (!(n in cfg.mcpServers)) delete sources[n];
  (cfg as any).__mcpSources = sources;
  return cfg;
}

/** The managed lockedProfile fields (without the name), if any. */
export function lockedFields(cfg: HarnessConfig): Partial<ModelProfile> | undefined {
  const lp = cfg.managed?.policy?.lockedProfile;
  if (!lp || !Object.keys(lp).length) return undefined;
  const { name: _n, ...rest } = lp as Partial<ModelProfile>;
  return rest;
}

/**
 * The profile for a client the extension creates outside the agent loop
 * (model list, connection test, inline edit, autocomplete, image description):
 * resolved from the governed config, with the managed lock re-applied on top.
 */
export function clientProfile(cfg: HarnessConfig, name?: string): ModelProfile {
  const p = resolveProfile(cfg, name && cfg.profiles[name] ? name : cfg.profile);
  const locked = lockedFields(cfg);
  return locked ? { ...p, ...locked } : p;
}

/**
 * R4 (batch 4 low): admission for an autocomplete request, priced like the profile it posts to, so
 * dollar caps apply and the ledger records its cost (next-edit already passed its profile's pricing).
 */
export function autocompleteAdmission(cfg: HarnessConfig, profileName?: string): AdmitHook {
  return rawAdmission(cfg, { kind: 'fim', role: 'autocomplete', pricing: clientProfile(cfg, profileName).pricing });
}
