/**
 * CLI status line (SPEC G7): `statusLine.command` gets a JSON description of the
 * session on stdin (Claude Code's shape: model, cost, context, mode, workspace)
 * and its first lines of stdout are shown above the prompt.
 *
 * The command runs code, so like a hook it must come from the user: a command
 * defined only by the project's .tugline/config*.json runs only after
 * `/statusline approve` (WS3 hook-trust store, event "StatusLine"). Untrusted
 * workspaces never get here (loadConfig drops the key). It runs with the
 * scrubbed environment and a short timeout; failures show nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { HarnessConfig } from '../config.js';
import { scrubbedEnv } from '../tools/shell.js';
import { platformSpawnArgs } from '../util/procs.js';
import { approveHookHashes, hookHash, isHookApproved } from '../agent/hooks.js';
import { estimateMessagesTokens } from '../util/text.js';
import { registerSlashCommand } from '../commands.js';
import { cacheSummary, cacheTallyFor } from '../cache/meter.js'; // WS10 N10

export interface StatusLineConfig {
  command: string;
  timeoutMs?: number;
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC G7: CLI status line command. */
    statusLine?: StatusLineConfig;
  }
}

export interface StatusInput {
  session_id: string;
  version: string;
  model: { id: string; display_name: string; profile: string };
  workspace: { current_dir: string };
  cwd: string;
  mode: string;
  cost: { total_cost_usd: number; total_tokens: number; llm_calls: number };
  context: { used_tokens: number; window: number; percent: number };
  /** v1.1 N10: prompt-cache hit rate of this session (null when the server does not report caching) */
  cache?: ReturnType<typeof cacheSummary>;
}

/** Minimal view of the agent (avoids importing agent.ts). */
export interface StatusAgent {
  sessionId: string;
  messages: unknown[];
  llm: { profile: { model: string; name: string; contextWindow: number } };
  policy: { mode: string };
  totals: { promptTokens: number; completionTokens: number; costUsd: number; llmCalls: number };
}

export function statusInput(agent: StatusAgent, workspace: string, version = '1.0.0'): StatusInput {
  const used = estimateMessagesTokens(agent.messages as any);
  const window = agent.llm.profile.contextWindow || 1;
  return {
    session_id: agent.sessionId,
    version,
    model: { id: agent.llm.profile.model, display_name: agent.llm.profile.model, profile: agent.llm.profile.name },
    workspace: { current_dir: workspace },
    cwd: workspace,
    mode: agent.policy.mode,
    cost: { total_cost_usd: Number(agent.totals.costUsd.toFixed(6)), total_tokens: agent.totals.promptTokens + agent.totals.completionTokens, llm_calls: agent.totals.llmCalls },
    context: { used_tokens: used, window, percent: Math.min(100, Math.round((used / window) * 1000) / 10) },
    cache: cacheSummary(cacheTallyFor(agent.sessionId)),
  };
}

function projectStatusCommands(workspace: string): string[] {
  const out: string[] = [];
  for (const f of ['config.json', 'config.local.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(workspace, '.tugline', f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
      if (typeof j?.statusLine?.command === 'string') out.push(j.statusLine.command);
    } catch {
      /* none */
    }
  }
  return out;
}

function userStatusCommand(homeDir: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(homeDir, 'config.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    return typeof j?.statusLine?.command === 'string' ? j.statusLine.command : undefined;
  } catch {
    return undefined;
  }
}

/** Why the configured command may not run (undefined = it may). */
export function statusLineBlocked(cfg: HarnessConfig, workspace: string): string | undefined {
  const cmd = cfg.statusLine?.command;
  if (!cmd) return 'no statusLine.command configured';
  const fromProject = projectStatusCommands(workspace).includes(cmd) && userStatusCommand(cfg.homeDir) !== cmd;
  if (fromProject && !isHookApproved(cfg.homeDir, workspace, hookHash('StatusLine', { command: cmd }))) return `the project's statusLine.command is not approved (/statusline approve)`;
  return undefined;
}

/** Run the status-line command; '' when none, blocked or failing. */
export async function statusLineText(agent: StatusAgent, cfg: HarnessConfig, workspace: string): Promise<string> {
  if (!cfg.statusLine?.command || statusLineBlocked(cfg, workspace)) return '';
  const input = JSON.stringify(statusInput(agent, workspace));
  const out = await new Promise<string>((resolve) => {
    const file = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const sp = platformSpawnArgs(file, process.platform === 'win32' ? ['/d', '/s', '/c', cfg.statusLine!.command] : ['-c', cfg.statusLine!.command]); // R7: cmd.exe gets the command verbatim
    const p = spawn(file, sp.args, { cwd: workspace, env: { ...scrubbedEnv([]), TUGLINE_STATUSLINE: '1' }, windowsVerbatimArguments: sp.windowsVerbatimArguments, windowsHide: true });
    let stdout = '';
    const t = setTimeout(() => p.kill('SIGKILL'), cfg.statusLine!.timeoutMs ?? 2000);
    p.stdout.on('data', (d) => (stdout += d));
    p.stdin.on('error', () => undefined);
    p.on('error', () => {
      clearTimeout(t);
      resolve('');
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0 ? stdout : '');
    });
    p.stdin.end(input);
  });
  // Keep colours (SGR), drop other control sequences; at most 3 lines of 300 chars.
  return out
    .replace(/\x1b\[(?![\d;]*m)[\d;?]*[A-Za-z]/g, '')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '')
    .split('\n')
    .map((l) => l.trimEnd().slice(0, 300))
    .filter(Boolean)
    .slice(0, 3)
    .join('\n');
}

registerSlashCommand({
  name: 'statusline',
  description: 'show the status-line command; approve a project-defined one',
  usage: '[approve]',
  run(args, ctx) {
    const cmd = ctx.config.statusLine?.command;
    if (args.trim() === 'approve') {
      if (!cmd) return void ctx.write('  no statusLine.command configured');
      approveHookHashes(ctx.config.homeDir, ctx.workspace, [hookHash('StatusLine', { command: cmd })]);
      return void ctx.write(`  approved status line command: ${cmd}`);
    }
    const blocked = cmd ? statusLineBlocked(ctx.config, ctx.workspace) : undefined;
    ctx.write(cmd ? `  status line: ${cmd}${blocked ? ` (not running: ${blocked})` : ''}` : '  no status line (set statusLine.command in ~/.tugline/config.json)');
  },
});
