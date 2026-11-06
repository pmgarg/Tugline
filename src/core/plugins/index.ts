/**
 * Plugins at config load (SPEC G4): `applyPlugins` runs inside loadConfig just
 * BEFORE the governance step, so managed policy (allowMcpServers, allowSkills,
 * deny rules) applies to everything a plugin contributes.
 *
 * Per enabled plugin:
 *  - skills/  → cfg.skills.dirs (instructions; load without trust)
 *  - agents/  → extra agent definition dirs
 *  - commands/*.md → slash commands `/<plugin>:<command>`
 *  - MCP servers → cfg.mcpServers["<plugin>-<server>"], only while trusted
 *  - hooks → cfg.hooks, only while trusted AND each hook's hash is approved (WS3)
 * Anything withheld is reported once per session (notice) and by `tug plugin list`.
 */
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig, HookConfig } from '../config.js';
import { hookHash, isHookApproved } from '../agent/hooks.js';
import { registerAgentExtension } from '../agent/extensions.js';
import { bindMcpHome } from '../mcp/manager.js';
import { setExtraAgentDirs } from '../skills/manager.js';
import { loadMarkdownCommands, registerMarkdownCommands } from '../skills/compat.js';
import { readManifest } from './manifest.js';
import { isTrusted, pluginDir, readState } from './store.js';

export * from './manifest.js';
export * from './store.js';

declare module '../config.js' {
  interface HarnessConfigExtensions {
    plugins?: {
      /** Load installed plugins (default true). */
      enabled?: boolean;
    };
  }
}

export interface PluginLoadReport {
  loaded: string[];
  withheld: string[];
  errors: string[];
}

const reports = new WeakMap<object, PluginLoadReport>();
export function pluginReport(cfg: HarnessConfig): PluginLoadReport | undefined {
  return reports.get(cfg);
}

export function applyPlugins(cfg: HarnessConfig, opts: { workspace: string; noUserConfig?: boolean } = { workspace: process.cwd() }): HarnessConfig {
  bindMcpHome(cfg.mcpServers, cfg.homeDir);
  const report: PluginLoadReport = { loaded: [], withheld: [], errors: [] };
  reports.set(cfg, report);
  // noUserConfig (tests, eval) means "do not read the real ~/.tugline": plugins live there too.
  const defaultHome = path.join(os.homedir(), '.tugline');
  if (cfg.plugins?.enabled === false || (opts.noUserConfig && path.resolve(cfg.homeDir) === defaultHome)) {
    setExtraAgentDirs([]);
    return cfg;
  }
  const state = readState(cfg.homeDir);
  const agentDirs: string[] = [];
  for (const p of Object.values(state.plugins)) {
    if (!p.enabled) continue;
    const dir = pluginDir(cfg.homeDir, p.name);
    let m;
    try {
      m = readManifest(dir);
    } catch (e) {
      report.errors.push(`plugin ${p.name}: ${(e as Error).message}`);
      continue;
    }
    report.loaded.push(p.name);
    cfg.skills.dirs = [...cfg.skills.dirs, ...m.skillDirs.filter((d) => !cfg.skills.dirs.includes(d))];
    agentDirs.push(...m.agentDirs);
    if (m.commandDirs.length) {
      const prefix = `${p.name}:`;
      const plugin = p.name;
      // Resolved again at run time against the session's home: a removed or disabled plugin's command stops working.
      registerMarkdownCommands(loadMarkdownCommands(m.commandDirs, prefix), (name, _ws, config) => {
        if (!readState(config.homeDir).plugins[plugin]?.enabled) return undefined;
        return loadMarkdownCommands(readManifestSafe(pluginDir(config.homeDir, plugin))?.commandDirs ?? [], prefix).find((c) => c.name === name);
      });
    }
    const hasCode = Object.keys(m.mcpServers).length > 0 || Object.values(m.hooks).some((l) => l.length);
    if (!hasCode) continue;
    const trusted = isTrusted(cfg.homeDir, p);
    for (const [srv, def] of Object.entries(m.mcpServers)) {
      const key = `${p.name}-${srv}`;
      if (!trusted) {
        report.withheld.push(`plugin ${p.name}: MCP server ${srv}`);
        continue;
      }
      if (cfg.mcpServers[key]) continue; // the user's own definition wins
      cfg.mcpServers[key] = { ...def, trusted: false };
    }
    for (const [event, list] of Object.entries(m.hooks)) {
      for (const h of list) {
        if (!trusted || !isHookApproved(cfg.homeDir, dir, hookHash(event, h))) {
          report.withheld.push(`plugin ${p.name}: hook ${event} "${h.command}"`);
          continue;
        }
        (cfg.hooks[event] ??= [] as HookConfig[]).push(h);
      }
    }
  }
  setExtraAgentDirs(agentDirs);
  // Not added to cfg.trust.ignored: that list drives the *workspace* trust prompt, and trusting
  // the workspace must not be mistaken for trusting a plugin. Reported by the extension below.
  return cfg;
}

function readManifestSafe(dir: string) {
  try {
    return readManifest(dir);
  } catch {
    return undefined;
  }
}

registerAgentExtension({
  id: 'ws7-plugins',
  depths: [0],
  onSessionStart(a) {
    const r = pluginReport(a.config);
    if (!r) return;
    if (r.withheld.length) a.notice('warn', `plugin code not trusted, not running: ${r.withheld.join('; ')}. Review with "tug plugin info <name>", then "tug plugin trust <name>".`);
    for (const e of r.errors) a.notice('warn', e);
    if (r.loaded.length) a.journal({ type: 'plugins', loaded: r.loaded, withheld: r.withheld });
  },
});

export function pluginDirOf(homeDir: string, name: string): string {
  return path.join(homeDir, 'plugins', name);
}
