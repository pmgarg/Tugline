/**
 * Installed plugins and marketplaces (SPEC G4).
 *
 *   <homeDir>/plugins/<name>/            the plugin files
 *   <homeDir>/plugins/installed.json     { plugins: {name: entry}, marketplaces: {name: entry} }
 *   <homeDir>/plugins/.marketplaces/<m>/ cloned or copied marketplace indexes
 *
 * Trust (R3): skills, agents and commands are markdown instructions and load as
 * soon as a plugin is enabled. Hooks and MCP servers execute code, so they run
 * only after `tug plugin trust <name>`, which records a hash of every file in the
 * plugin. Any change to the plugin (an update, a tampered file) changes the hash
 * and the plugin's code stops running until it is trusted again. Hook approval
 * also goes through WS3's hook-trust store (hash per hook, keyed by the plugin
 * directory), so `/hooks` and the C6 rules apply to plugin hooks too.
 * Installing from a git URL or a marketplace never trusts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { approveHookHashes, hookHash } from '../agent/hooks.js';
import { readManifest, runsCode, type PluginManifest } from './manifest.js';

const execFileP = promisify(execFile);

export interface InstalledPlugin {
  name: string;
  source: string;
  sourceType: 'path' | 'git' | 'marketplace';
  marketplace?: string;
  version?: string;
  commit?: string;
  installedAt: string;
  enabled: boolean;
  /** Content hash approved by `tug plugin trust`. Absent = untrusted. */
  trustedHash?: string;
}

export interface MarketplaceEntry {
  name: string;
  source: string;
  dir: string;
  addedAt: string;
}

export interface PluginState {
  plugins: Record<string, InstalledPlugin>;
  marketplaces: Record<string, MarketplaceEntry>;
}

export function pluginsRoot(homeDir: string): string {
  return path.join(homeDir, 'plugins');
}

function stateFile(homeDir: string): string {
  return path.join(pluginsRoot(homeDir), 'installed.json');
}

export function readState(homeDir: string): PluginState {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile(homeDir), 'utf8'));
    return { plugins: j.plugins ?? {}, marketplaces: j.marketplaces ?? {} };
  } catch {
    return { plugins: {}, marketplaces: {} };
  }
}

export function writeState(homeDir: string, s: PluginState): void {
  fs.mkdirSync(pluginsRoot(homeDir), { recursive: true, mode: 0o700 });
  const tmp = `${stateFile(homeDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stateFile(homeDir));
}

export function pluginDir(homeDir: string, name: string): string {
  return path.join(pluginsRoot(homeDir), name);
}

// ------------------------------------------------------------ content hashing

const MAX_HASH_BYTES = 200 * 1024 * 1024;

/** sha256 over every file's relative path, mode bit x and content (sorted; .git excluded). Symlinks are refused at install. */
export function contentHash(dir: string): string {
  const h = crypto.createHash('sha256');
  let total = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (e.isSymbolicLink()) {
        h.update(`L ${rel} -> ${fs.readlinkSync(p)}\0`);
      } else if (e.isDirectory()) {
        h.update(`D ${rel}\0`);
        walk(p);
      } else if (e.isFile()) {
        const st = fs.statSync(p);
        total += st.size;
        if (total > MAX_HASH_BYTES) throw new Error(`plugin ${dir} is larger than ${MAX_HASH_BYTES / 1024 / 1024} MB`);
        h.update(`F ${rel} ${st.mode & 0o111 ? 'x' : '-'} ${st.size}\0`);
        h.update(fs.readFileSync(p));
        h.update('\0');
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Symlinks inside a plugin could expose files outside it through the skill read roots; they are refused. */
function findSymlinks(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.push(path.relative(dir, p));
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

// ------------------------------------------------------------ sources

export function isGitUrl(s: string): boolean {
  return /^(https:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(s) || /\.git$/.test(s);
}

/**
 * Environment for the harness's own git calls on untrusted content (plugin and
 * remote clones): the user's global and system git config are ignored, so a
 * `url.<base>.insteadOf`, `core.hooksPath`, `init.templateDir`, credential
 * helper or alias in ~/.gitconfig or /etc/gitconfig cannot redirect the clone
 * or run code; inherited GIT_* variables that inject config or relocate the
 * repository are dropped too. SSH settings (GIT_SSH, GIT_SSH_COMMAND) are kept
 * so private ssh remotes still authenticate.
 */
export function hardenedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('GIT_') || k === 'GIT_SSH' || k === 'GIT_SSH_COMMAND') env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' };
}

/** `-c` flags applied to every hardened git call (belt and braces with the env above). */
export const HARDENED_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.ext.allow=never', '-c', 'init.templateDir=', '-c', 'core.fsmonitor=false', '-c', 'credential.helper='];

/** Clone without prompts, submodules, repo hooks or the user's global/system git config. `--` stops the URL being read as an option. */
export async function gitClone(url: string, dest: string, ref?: string): Promise<string> {
  if (url.startsWith('-')) throw new Error('invalid git URL');
  const env = hardenedGitEnv();
  const args = [...HARDENED_GIT_FLAGS, 'clone', '--depth', '1', '--no-recurse-submodules', '--template=', ...(ref ? ['--branch', ref] : []), '--', url, dest];
  await execFileP('git', args, { env, timeout: 120_000 });
  const { stdout } = await execFileP('git', [...HARDENED_GIT_FLAGS, '-C', dest, 'rev-parse', 'HEAD'], { env, timeout: 10_000 });
  return stdout.trim();
}

function tmpDir(homeDir: string): string {
  fs.mkdirSync(pluginsRoot(homeDir), { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(pluginsRoot(homeDir), '.tmp-'));
}

// ------------------------------------------------------------ marketplaces

export interface MarketplacePlugin {
  name: string;
  source: unknown;
  version?: string;
  description?: string;
}

export function readMarketplaceIndex(dir: string): { name: string; plugins: MarketplacePlugin[] } {
  for (const f of ['marketplace.json', path.join('.claude-plugin', 'marketplace.json'), path.join('.tugline-plugin', 'marketplace.json')]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const plugins: MarketplacePlugin[] = (Array.isArray(j.plugins) ? j.plugins : []).filter((x: any) => x && typeof x.name === 'string');
    return { name: String(j.name ?? path.basename(dir)), plugins };
  }
  throw new Error(`no marketplace.json in ${dir}`);
}

export async function addMarketplace(homeDir: string, source: string): Promise<MarketplaceEntry> {
  const tmp = tmpDir(homeDir);
  try {
    if (/^https:\/\/.+\.json$/.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source}`);
      fs.writeFileSync(path.join(tmp, 'marketplace.json'), await res.text());
    } else if (isGitUrl(source)) await gitClone(source, path.join(tmp, 'repo')).then(() => moveContents(path.join(tmp, 'repo'), tmp));
    else {
      const abs = path.resolve(source);
      const st = fs.statSync(abs);
      if (st.isFile()) fs.copyFileSync(abs, path.join(tmp, 'marketplace.json'));
      else fs.cpSync(abs, tmp, { recursive: true, filter: (s) => path.basename(s) !== '.git' });
    }
    const idx = readMarketplaceIndex(tmp);
    if (!/^[\w.-]+$/.test(idx.name)) throw new Error(`invalid marketplace name "${idx.name}"`);
    const dir = path.join(pluginsRoot(homeDir), '.marketplaces', idx.name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(tmp, dir);
    const entry: MarketplaceEntry = { name: idx.name, source: path.isAbsolute(source) || fs.existsSync(source) ? path.resolve(source) : source, dir, addedAt: new Date().toISOString() };
    const s = readState(homeDir);
    s.marketplaces[idx.name] = entry;
    writeState(homeDir, s);
    return entry;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function moveContents(from: string, to: string): void {
  for (const e of fs.readdirSync(from)) fs.renameSync(path.join(from, e), path.join(to, e));
  fs.rmSync(from, { recursive: true, force: true });
}

/** Turn a marketplace `source` into something installPlugin understands. */
function resolveMarketSource(m: MarketplaceEntry, p: MarketplacePlugin): string {
  const s: any = p.source;
  if (typeof s === 'string') {
    if (isGitUrl(s)) return s;
    const abs = path.resolve(m.dir, s);
    const rel = path.relative(m.dir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      // Local marketplaces may point at sibling directories of their source.
      if (fs.existsSync(m.source) && fs.statSync(m.source).isDirectory()) return path.resolve(m.source, s);
      throw new Error(`marketplace ${m.name}: source "${s}" points outside the marketplace`);
    }
    // relative to a local marketplace: prefer the original location (keeps the copy small)
    if (fs.existsSync(m.source) && fs.statSync(m.source).isDirectory()) return path.resolve(m.source, s);
    return abs;
  }
  if (s && typeof s === 'object') {
    if (s.source === 'github' && typeof s.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s.repo)) return `https://github.com/${s.repo}.git`;
    if ((s.source === 'git' || s.source === 'url') && typeof s.url === 'string' && isGitUrl(s.url)) return s.url;
  }
  throw new Error(`marketplace ${m.name}: unsupported source for plugin ${p.name}`);
}

export function findInMarketplaces(homeDir: string, spec: string): { market: MarketplaceEntry; plugin: MarketplacePlugin; source: string } {
  const s = readState(homeDir);
  let name = spec.replace(/^marketplace:/, '');
  let market: string | undefined;
  const at = name.lastIndexOf('@');
  if (at > 0) {
    market = name.slice(at + 1);
    name = name.slice(0, at);
  }
  const markets = Object.values(s.marketplaces).filter((m) => !market || m.name === market);
  if (!markets.length) throw new Error(market ? `unknown marketplace "${market}"` : 'no marketplaces added (tug plugin marketplace add <path|url>)');
  for (const m of markets) {
    const idx = readMarketplaceIndex(m.dir);
    const p = idx.plugins.find((x) => x.name === name);
    if (p) return { market: m, plugin: p, source: resolveMarketSource(m, p) };
  }
  throw new Error(`plugin "${name}" not found in ${markets.map((m) => m.name).join(', ')}`);
}

// ------------------------------------------------------------ install / remove / enable / trust

export interface InstallResult {
  manifest: PluginManifest;
  entry: InstalledPlugin;
  trusted: boolean;
  notes: string[];
}

export async function installPlugin(homeDir: string, spec: string, opts: { trust?: boolean; ref?: string } = {}): Promise<InstallResult> {
  const notes: string[] = [];
  let sourceType: InstalledPlugin['sourceType'] = 'path';
  let source = spec;
  let marketplace: string | undefined;
  if (spec.startsWith('marketplace:') || (/^[\w.-]+@[\w.-]+$/.test(spec) && !fs.existsSync(spec))) {
    const f = findInMarketplaces(homeDir, spec);
    source = f.source;
    marketplace = f.market.name;
    sourceType = 'marketplace';
  } else if (isGitUrl(spec) && !fs.existsSync(spec)) sourceType = 'git';
  const tmp = tmpDir(homeDir);
  let commit: string | undefined;
  try {
    const stage = path.join(tmp, 'p');
    if (isGitUrl(source) && !fs.existsSync(source)) {
      commit = await gitClone(source, stage, opts.ref);
      fs.rmSync(path.join(stage, '.git'), { recursive: true, force: true });
    } else {
      const abs = path.resolve(source);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`plugin source not found: ${source}`);
      fs.cpSync(abs, stage, { recursive: true, verbatimSymlinks: true, filter: (s) => !['.git', 'node_modules'].includes(path.basename(s)) || s === abs });
    }
    const links = findSymlinks(stage);
    if (links.length) throw new Error(`plugin contains symbolic links (${links.slice(0, 5).join(', ')}); refusing to install`);
    const manifest = readManifest(stage);
    const dest = pluginDir(homeDir, manifest.name);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(stage, dest);
    const final = readManifest(dest);
    const s = readState(homeDir);
    const entry: InstalledPlugin = { name: final.name, source: sourceType === 'path' ? path.resolve(source) : source, sourceType, marketplace, version: final.version, commit, installedAt: new Date().toISOString(), enabled: true };
    s.plugins[final.name] = entry;
    writeState(homeDir, s);
    let trusted = false;
    if (runsCode(final)) {
      if (opts.trust && sourceType === 'path') {
        trustPlugin(homeDir, final.name);
        trusted = true;
      } else {
        if (opts.trust) notes.push(`--trust is only honoured for local paths; review this ${sourceType} plugin first`);
        notes.push(`plugin "${final.name}" has ${describeCode(final)}; nothing in it runs until you review it (tug plugin info ${final.name}) and run: tug plugin trust ${final.name}`);
      }
    }
    return { manifest: final, entry: readState(homeDir).plugins[final.name], trusted, notes };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function describeCode(m: PluginManifest): string {
  const hooks = Object.values(m.hooks).reduce((n, l) => n + l.length, 0);
  const mcp = Object.keys(m.mcpServers).length;
  return [hooks ? `${hooks} hook(s)` : '', mcp ? `${mcp} MCP server(s)` : ''].filter(Boolean).join(' and ') || 'no code';
}

export function removePlugin(homeDir: string, name: string): boolean {
  const s = readState(homeDir);
  const had = !!s.plugins[name];
  delete s.plugins[name];
  writeState(homeDir, s);
  const dir = pluginDir(homeDir, name);
  const existed = fs.existsSync(dir);
  // name is validated by the manifest; still make sure we only ever delete inside the plugins root
  if (existed && path.dirname(dir) === pluginsRoot(homeDir)) fs.rmSync(dir, { recursive: true, force: true });
  return had || existed;
}

export function setEnabled(homeDir: string, name: string, enabled: boolean): void {
  const s = readState(homeDir);
  if (!s.plugins[name]) throw new Error(`plugin "${name}" is not installed`);
  s.plugins[name].enabled = enabled;
  writeState(homeDir, s);
}

/** Approve the plugin's current content: its hooks (WS3 hook trust) and MCP servers may run. */
export function trustPlugin(homeDir: string, name: string): { hash: string; manifest: PluginManifest } {
  const s = readState(homeDir);
  if (!s.plugins[name]) throw new Error(`plugin "${name}" is not installed`);
  const dir = pluginDir(homeDir, name);
  const manifest = readManifest(dir);
  const hash = contentHash(dir);
  const hashes = Object.entries(manifest.hooks).flatMap(([ev, list]) => list.map((h) => hookHash(ev, h)));
  if (hashes.length) approveHookHashes(homeDir, dir, hashes);
  s.plugins[name].trustedHash = hash;
  writeState(homeDir, s);
  return { hash, manifest };
}

export function untrustPlugin(homeDir: string, name: string): void {
  const s = readState(homeDir);
  if (!s.plugins[name]) throw new Error(`plugin "${name}" is not installed`);
  delete s.plugins[name].trustedHash;
  writeState(homeDir, s);
}

export function isTrusted(homeDir: string, p: InstalledPlugin): boolean {
  if (!p.trustedHash) return false;
  try {
    return contentHash(pluginDir(homeDir, p.name)) === p.trustedHash;
  } catch {
    return false;
  }
}

/** Human review of what a plugin would run. */
export function describePlugin(homeDir: string, name: string): string {
  const s = readState(homeDir);
  const p = s.plugins[name];
  if (!p) return `plugin "${name}" is not installed`;
  const m = readManifest(pluginDir(homeDir, name));
  const lines = [`${m.name}${m.version ? ` ${m.version}` : ''} (${m.format} layout) from ${p.source}${p.commit ? ` @ ${p.commit.slice(0, 12)}` : ''}`, m.description ? `  ${m.description}` : '', `  enabled: ${p.enabled}; trusted: ${isTrusted(homeDir, p) ? 'yes' : p.trustedHash ? 'NO (changed since it was trusted)' : 'no'}`];
  if (m.skillDirs.length) lines.push(`  skills: ${m.skillDirs.map((d) => path.relative(m.dir, d)).join(', ')}`);
  if (m.agentDirs.length) lines.push(`  agents: ${m.agentDirs.map((d) => path.relative(m.dir, d)).join(', ')}`);
  if (m.commandDirs.length) lines.push(`  commands: ${m.commandDirs.map((d) => path.relative(m.dir, d)).join(', ')}`);
  for (const [ev, list] of Object.entries(m.hooks)) for (const h of list) lines.push(`  hook ${ev}${h.matcher ? `(${h.matcher})` : ''}: ${h.command}`);
  for (const [n, srv] of Object.entries(m.mcpServers)) lines.push(`  MCP server ${n}: ${srv.command ? [srv.command, ...(srv.args ?? [])].join(' ') : srv.url}`);
  return lines.filter(Boolean).join('\n');
}

export function homeDefault(): string {
  return path.join(os.homedir(), '.tugline');
}
