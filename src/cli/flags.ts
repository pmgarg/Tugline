/**
 * Flags that loosen safety (v1.2 N49 SAC1): `--yolo` and its spellings `-y`, `--yes`, `--mode yolo` (review F14: no
 * approval prompts, permission mode yolo since N43), `--no-sandbox` (commands run on the host) and `--include-directories`
 * (more roots the agent may read and write). Each one
 *   - prints a warning on stderr before the session starts;
 *   - is recorded in the hash-chained journal (`cli_flag` record) and as an N23 security event;
 *   - is refused, with a typed reason and exit code 2, when managed policy forbids it
 *     (`disableAutoMode` forbids every spelling of --yolo; `forceSandbox` forbids --no-sandbox), never silently clamped.
 * Qwen Code and Cline accept both flags silently.
 */
import { registerAgentExtension } from '../core/agent/extensions.js';
import { recordSecurityEvent } from '../core/permissions/audit.js';
import type { HarnessConfig } from '../core/config.js';

export type LooseningFlag = '--yolo' | '--no-sandbox' | '--include-directories' | '--mcp-config' | '--hooks-dir';

/** A loosening flag as the user typed it (`-y` is the flag `--yolo`). */
export interface Loosening {
  flag: LooseningFlag;
  given: string;
}

declare module '../core/config.js' {
  interface HarnessConfigExtensions {
    /** set by the CLI: safety-loosening flags given on this command line */
    cliFlags?: { loosening: Loosening[] };
  }
}

export const LOOSENING_WARNINGS: Record<LooseningFlag, string> = {
  '--yolo': '--yolo: every tool call runs without asking you and without the auto-mode classifier (permission mode "yolo"). Deny rules, protected paths and the sandbox still apply.',
  '--no-sandbox': '--no-sandbox: commands run directly on your machine, with your user\'s access to files and network.',
  '--include-directories': '--include-directories: the agent may read and write these directories too, as if they were part of the workspace.',
  '--mcp-config': '--mcp-config: the MCP servers in this file start as programs on your machine, and their tools are offered to the agent.',
  '--hooks-dir': '--hooks-dir: the hooks in this directory run as programs on your machine around the agent\'s tool calls.',
};

/** The stderr warning for one flag, naming the spelling the user typed. */
export function looseningWarning(l: Loosening): string {
  const w = LOOSENING_WARNINGS[l.flag];
  return l.given === l.flag ? w : w.replace(`${l.flag}:`, `${l.flag} (given as ${l.given}):`);
}

/** `subcommandYes`: `--yes` belongs to a subcommand (`tug board … --yes`, `tug arena … --yes`), not the session mode. */
export function looseningFlags(a: Record<string, unknown>, o: { subcommandYes?: boolean } = {}): Loosening[] {
  const out: Loosening[] = [];
  const yolo = (given: string) => out.some((x) => x.flag === '--yolo') || out.push({ flag: '--yolo', given });
  if (a.yolo) yolo('--yolo');
  if (a.yes && !o.subcommandYes) yolo(a.yesSpelling === '-y' ? '-y' : '--yes');
  if (a.mode === 'yolo') yolo('--mode yolo');
  if (a['no-sandbox']) out.push({ flag: '--no-sandbox', given: '--no-sandbox' });
  if (a['include-directories']) out.push({ flag: '--include-directories', given: `--include-directories ${a['include-directories']}` });
  if (a['mcp-config']) out.push({ flag: '--mcp-config', given: `--mcp-config ${a['mcp-config']}` });
  if (a['hooks-dir']) out.push({ flag: '--hooks-dir', given: `--hooks-dir ${a['hooks-dir']}` });
  return out;
}

export class ForbiddenFlagError extends Error {
  readonly code = 'forbidden_by_managed_policy';
  constructor(readonly flag: string, readonly policyKey: string) {
    super(`${flag} is forbidden by your organisation's managed policy (${policyKey}); remove the flag or ask your administrator.`);
  }
}

/** Refuse a loosening flag the managed policy forbids (checked after loadConfig applied the policy). */
export function checkManaged(cfg: HarnessConfig, flags: Loosening[]): void {
  const p = cfg.managed?.policy as ({ disableAutoMode?: boolean; disableYoloMode?: boolean; forceSandbox?: boolean } | undefined);
  if (!p) return;
  for (const f of flags) {
    if (f.flag === '--yolo' && p.disableAutoMode) throw new ForbiddenFlagError(f.given, 'disableAutoMode');
    if (f.flag === '--yolo' && p.disableYoloMode) throw new ForbiddenFlagError(f.given, 'disableYoloMode');
    if (f.flag === '--no-sandbox' && p.forceSandbox) throw new ForbiddenFlagError(f.given, 'forceSandbox');
  }
}

registerAgentExtension({
  id: 'ws24-cli-flags',
  depths: [0],
  onSessionStart(a) {
    for (const l of a.config.cliFlags?.loosening ?? []) {
      a.journal({ type: 'cli_flag', flag: l.flag, given: l.given, warning: looseningWarning(l) });
      recordSecurityEvent(a, { type: l.flag === '--no-sandbox' ? 'sandbox' : 'approval', category: `cli_flag:${l.flag.slice(2)}`, decision: 'allow', by: 'user', reason: looseningWarning(l) });
    }
  },
});
