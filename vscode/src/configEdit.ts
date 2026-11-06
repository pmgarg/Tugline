/**
 * Reading and writing Tugline config files from the settings and manager
 * views (SPEC B11, B12). Pure node (no `vscode`), unit-tested.
 *
 * Files: user = ~/.tugline/config.json, project =
 * <workspace>/.tugline/config.json. Writes keep every other key, and use a
 * temp file + rename so a crash never leaves half a file. Project config only
 * takes effect in full when the workspace is trusted; the UI shows that caveat.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HookConfig, McpServerConfig } from '../../src/core/config.js';

export type ConfigScope = 'user' | 'project';

export function configFile(scope: ConfigScope, homeDir: string, workspace?: string): string {
  if (scope === 'user') return path.join(homeDir, 'config.json');
  if (!workspace) throw new Error('no workspace folder open');
  return path.join(workspace, '.tugline', 'config.json');
}

/** Parse a config file the way loadConfig does (whole-line // comments allowed). Missing → {}. */
export function readConfigFile(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  const j = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error(`${file}: not a JSON object`);
  return j;
}

export function writeConfigFile(file: string, data: Record<string, any>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read-modify-write one config file. */
export function updateConfig(file: string, mutate: (c: Record<string, any>) => void): Record<string, any> {
  const c = readConfigFile(file);
  mutate(c);
  writeConfigFile(file, c);
  return c;
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('expected a list');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

/** B12 AC1: replace the protected-paths list (other permission keys untouched). */
export function setProtectedPaths(file: string, globs: string[]): Record<string, any> {
  const list = cleanList(globs);
  return updateConfig(file, (c) => {
    c.permissions = { ...(c.permissions ?? {}), protectedPaths: list };
  });
}

export function setPermissionRules(file: string, rules: { allow?: string[]; deny?: string[] }): Record<string, any> {
  return updateConfig(file, (c) => {
    c.permissions = { ...(c.permissions ?? {}) };
    if (rules.allow) c.permissions.allow = cleanList(rules.allow);
    if (rules.deny) c.permissions.deny = cleanList(rules.deny);
  });
}

export function setPermissionMode(file: string, mode: string): Record<string, any> {
  if (!['ask', 'acceptEdits', 'plan', 'auto'].includes(mode)) throw new Error(`unknown permission mode ${mode}`);
  return updateConfig(file, (c) => {
    c.permissionMode = mode;
  });
}

/** Hooks: event → list of {matcher?, command}. Empty lists are removed. */
export function setHooks(file: string, event: string, hooks: HookConfig[]): Record<string, any> {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`bad hook event ${event}`);
  const list = hooks.filter((h) => h && typeof h.command === 'string' && h.command.trim()).map((h) => ({ ...(h.matcher ? { matcher: h.matcher } : {}), command: h.command.trim(), ...(h.timeoutMs ? { timeoutMs: h.timeoutMs } : {}) }));
  return updateConfig(file, (c) => {
    c.hooks = { ...(c.hooks ?? {}) };
    if (list.length) c.hooks[event] = list;
    else delete c.hooks[event];
  });
}

/** Project/memory rules file (AGENTS.md) — B12 "rules". */
export function rulesFile(scope: ConfigScope, homeDir: string, workspace?: string): string {
  if (scope === 'user') return path.join(homeDir, 'AGENTS.md');
  if (!workspace) throw new Error('no workspace folder open');
  return path.join(workspace, 'AGENTS.md');
}

// ------------------------------------------------------------ MCP (B11)

/**
 * Per-server toggles live in the user config under `ide.mcp`, keyed by server
 * name for user-level servers and by `<name>@<workspace>` for project servers.
 * A project can therefore never inherit a "trusted" toggle the user gave a
 * same-named server elsewhere.
 */
export function mcpToggleKey(name: string, source: 'user' | 'project', workspace?: string): string {
  return source === 'project' && workspace ? `${name}@${path.resolve(workspace)}` : name;
}

export function setMcpToggle(userFile: string, key: string, patch: { disabled?: boolean; trusted?: boolean }): Record<string, any> {
  return updateConfig(userFile, (c) => {
    c.ide = { ...(c.ide ?? {}) };
    c.ide.mcp = { ...(c.ide.mcp ?? {}) };
    const cur = { ...(c.ide.mcp[key] ?? {}), ...patch };
    for (const k of Object.keys(cur)) if (cur[k] === undefined) delete cur[k];
    c.ide.mcp[key] = cur;
  });
}

/** Apply the user's toggles to the effective server map (returns a new map). */
export function applyMcpToggles(servers: Record<string, McpServerConfig>, toggles: Record<string, { disabled?: boolean; trusted?: boolean }> | undefined, sources: Record<string, 'user' | 'project'>, workspace?: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(servers)) {
    const t = toggles?.[mcpToggleKey(name, sources[name] ?? 'project', workspace)];
    out[name] = { ...s, ...(t?.disabled !== undefined ? { disabled: t.disabled } : {}), ...(t?.trusted !== undefined ? { trusted: t.trusted } : {}) };
  }
  return out;
}

/** Add a server definition to the user config (from the registry search or by hand). */
export function addMcpServer(userFile: string, name: string, def: McpServerConfig): Record<string, any> {
  if (!/^[\w.-]{1,64}$/.test(name)) throw new Error(`bad server name "${name}"`);
  if (!def.command && !def.url) throw new Error('a server needs a command or a url');
  return updateConfig(userFile, (c) => {
    c.mcpServers = { ...(c.mcpServers ?? {}), [name]: def };
  });
}

export function removeMcpServer(userFile: string, name: string): Record<string, any> {
  return updateConfig(userFile, (c) => {
    if (c.mcpServers) delete c.mcpServers[name];
  });
}

// ------------------------------------------------------------ skills (B11)

export function setSkillEnabled(userFile: string, name: string, enabled: boolean): Record<string, any> {
  return updateConfig(userFile, (c) => {
    c.skills = { ...(c.skills ?? {}) };
    const dis = new Set<string>(Array.isArray(c.skills.disabled) ? c.skills.disabled : []);
    if (enabled) dis.delete(name);
    else dis.add(name);
    c.skills.disabled = [...dis];
  });
}

// ------------------------------------------------------------ MCP registry (B11)

export interface RegistryServer {
  name: string;
  description: string;
  version?: string;
  /** suggested config */
  config?: McpServerConfig;
  repository?: string;
}

/**
 * Parse the official MCP registry's `GET /v0/servers?search=` reply into
 * install suggestions (npm/pypi stdio packages, or remote streamable-http).
 */
export function parseRegistry(j: any): RegistryServer[] {
  const list: any[] = Array.isArray(j?.servers) ? j.servers : [];
  const out: RegistryServer[] = [];
  for (const item of list) {
    const s = item?.server ?? item;
    if (!s?.name) continue;
    let config: McpServerConfig | undefined;
    const remote = (s.remotes ?? []).find((r: any) => r?.url && /streamable|sse|http/i.test(String(r.type ?? 'http')));
    const pkg = (s.packages ?? [])[0];
    if (pkg?.identifier && (pkg.registryType ?? pkg.registry_type) === 'npm') config = { command: 'npx', args: ['-y', `${pkg.identifier}${pkg.version ? `@${pkg.version}` : ''}`] };
    else if (pkg?.identifier && (pkg.registryType ?? pkg.registry_type) === 'pypi') config = { command: 'uvx', args: [pkg.identifier] };
    else if (remote) config = { url: remote.url };
    out.push({ name: String(s.name), description: String(s.description ?? ''), version: s.version, config, repository: s.repository?.url });
  }
  return out;
}

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

/** Short local name for a registry entry ("io.github.foo/bar-mcp" → "bar-mcp"). */
export function localServerName(registryName: string): string {
  return (registryName.split('/').pop() ?? registryName).replace(/[^\w.-]/g, '-').slice(0, 64) || 'server';
}
