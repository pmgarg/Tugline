/**
 * Plugin layout (SPEC G4). A plugin is a directory with a manifest,
 * `tugline-plugin.json` or the Claude Code `.claude-plugin/plugin.json`,
 * and any of: skills/, agents/, commands/, hooks.json (or hooks/hooks.json),
 * .mcp.json. Manifest fields may point elsewhere (Claude Code semantics):
 * `skills`, `agents`, `commands` (path or paths), `hooks` (path or inline
 * object), `mcpServers` (path or inline object).
 *
 * `${CLAUDE_PLUGIN_ROOT}` / `${TUG_PLUGIN_ROOT}` in hook commands and MCP server
 * definitions expand to the installed plugin directory. Claude Code tool names
 * in hook matchers (Write, Edit, Bash…) are mapped to ours.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HookConfig, McpServerConfig } from '../config.js';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** Which manifest file was found. */
  format: 'tugline' | 'claude';
  dir: string;
  skillDirs: string[];
  agentDirs: string[];
  commandDirs: string[];
  hooks: Record<string, HookConfig[]>;
  mcpServers: Record<string, McpServerConfig>;
}

export const MANIFEST_FILES = ['tugline-plugin.json', path.join('.claude-plugin', 'plugin.json')];

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`);
  }
}

/** Resolve a manifest-relative path, refusing anything that leaves the plugin directory. */
function inside(dir: string, rel: string): string {
  const abs = path.resolve(dir, rel);
  const r = path.relative(dir, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`plugin path "${rel}" points outside the plugin directory`);
  return abs;
}

function dirList(dir: string, value: unknown, fallback: string): string[] {
  const vals = value === undefined ? [fallback] : Array.isArray(value) ? value.map(String) : [String(value)];
  return vals.map((v) => inside(dir, v)).filter((d) => fs.existsSync(d));
}

/** Claude Code tool names → Tugline tool names (for hook matchers). */
const CC_TOOLS: Record<string, string> = {
  Write: 'write_file',
  Edit: 'edit_file|multi_edit|apply_patch',
  MultiEdit: 'multi_edit',
  Read: 'read_file',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_dir',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  Task: 'task',
  TodoWrite: 'todo_write',
  NotebookEdit: 'notebook_edit',
};

export function mapMatcher(m: string | undefined): string | undefined {
  if (!m) return m;
  return m
    .split('|')
    .map((x) => CC_TOOLS[x.trim()] ?? x.trim())
    .join('|');
}

function expandRoot(s: string, dir: string): string {
  return s.replace(/\$\{(CLAUDE_PLUGIN_ROOT|TUG_PLUGIN_ROOT)\}/g, dir);
}

/** Accepts our flat hook format and Claude Code's nested one ({matcher, hooks:[{type:"command", command, timeout}]}). */
export function normalizeHooks(raw: any, dir: string): Record<string, HookConfig[]> {
  const src = raw && typeof raw === 'object' && raw.hooks && typeof raw.hooks === 'object' ? raw.hooks : raw;
  const out: Record<string, HookConfig[]> = {};
  if (!src || typeof src !== 'object') return out;
  for (const [event, list] of Object.entries(src)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list as any[]) {
      const matcher = mapMatcher(typeof entry?.matcher === 'string' ? entry.matcher : undefined);
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : [entry];
      for (const h of inner) {
        if (!h || typeof h.command !== 'string' || (h.type && h.type !== 'command')) continue;
        (out[event] ??= []).push({ ...(matcher ? { matcher } : {}), command: expandRoot(h.command, dir), ...(typeof h.timeout === 'number' ? { timeoutMs: h.timeout * 1000 } : typeof h.timeoutMs === 'number' ? { timeoutMs: h.timeoutMs } : {}) });
      }
    }
  }
  return out;
}

function normalizeMcp(raw: any, dir: string): Record<string, McpServerConfig> {
  const src = raw && typeof raw === 'object' && raw.mcpServers && typeof raw.mcpServers === 'object' ? raw.mcpServers : raw;
  const out: Record<string, McpServerConfig> = {};
  if (!src || typeof src !== 'object') return out;
  for (const [name, s] of Object.entries(src as Record<string, any>)) {
    if (!s || typeof s !== 'object' || (!s.command && !s.url)) continue;
    out[name] = {
      ...(s.command ? { command: expandRoot(String(s.command), dir) } : {}),
      ...(Array.isArray(s.args) ? { args: s.args.map((a: unknown) => expandRoot(String(a), dir)) } : {}),
      ...(s.env && typeof s.env === 'object' ? { env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expandRoot(String(v), dir)])) } : {}),
      ...(s.cwd ? { cwd: expandRoot(String(s.cwd), dir) } : {}),
      ...(s.url ? { url: String(s.url) } : {}),
      ...(s.headers && typeof s.headers === 'object' ? { headers: s.headers } : {}),
      ...(s.oauth ? { oauth: s.oauth } : {}),
      // a plugin can never mark its own server trusted (auto-allowed); that is the user's call
    };
  }
  return out;
}

export function findManifestFile(dir: string): { file: string; format: 'tugline' | 'claude' } | undefined {
  for (const f of MANIFEST_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return { file: p, format: f.startsWith('.claude') ? 'claude' : 'tugline' };
  }
  return undefined;
}

export function readManifest(dir: string): PluginManifest {
  const found = findManifestFile(dir);
  if (!found) throw new Error(`no plugin manifest in ${dir} (expected ${MANIFEST_FILES.join(' or ')})`);
  const m = readJson(found.file) ?? {};
  const name = String(m.name ?? '');
  if (!NAME_RE.test(name)) throw new Error(`invalid plugin name "${name}" in ${found.file} (letters, digits, . _ -; max 64)`);
  let hooksRaw: any = undefined;
  if (typeof m.hooks === 'string') hooksRaw = readJson(inside(dir, m.hooks));
  else if (m.hooks && typeof m.hooks === 'object') hooksRaw = m.hooks;
  else hooksRaw = readJson(path.join(dir, 'hooks.json')) ?? readJson(path.join(dir, 'hooks', 'hooks.json'));
  let mcpRaw: any = undefined;
  if (typeof m.mcpServers === 'string') mcpRaw = readJson(inside(dir, m.mcpServers));
  else if (m.mcpServers && typeof m.mcpServers === 'object') mcpRaw = m.mcpServers;
  else mcpRaw = readJson(path.join(dir, '.mcp.json'));
  return {
    name,
    version: m.version ? String(m.version) : undefined,
    description: m.description ? String(m.description) : undefined,
    author: typeof m.author === 'string' ? m.author : m.author?.name ? String(m.author.name) : undefined,
    format: found.format,
    dir,
    skillDirs: dirList(dir, m.skills, 'skills'),
    agentDirs: dirList(dir, m.agents, 'agents'),
    commandDirs: dirList(dir, m.commands, 'commands'),
    hooks: normalizeHooks(hooksRaw, dir),
    mcpServers: normalizeMcp(mcpRaw, dir),
  };
}

/** Does the plugin contain anything that executes code (hooks, MCP servers)? */
export function runsCode(m: PluginManifest): boolean {
  return Object.values(m.hooks).some((l) => l.length > 0) || Object.keys(m.mcpServers).length > 0;
}
