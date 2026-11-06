/**
 * Hooks: deterministic shell commands run at lifecycle points (Claude-Code style).
 *
 * The command receives a JSON payload on stdin (`hook_event_name`, `cwd`, event
 * fields). Exit code 0 = continue; stdout may be JSON:
 *   {"decision":"block","reason":"…"}                      (v0.1 contract)
 *   {"hookSpecificOutput":{"permissionDecision":"deny|allow|ask","permissionDecisionReason":"…"}}
 *   {"hookSpecificOutput":{"decision":{"behavior":"allow|deny"}}}  (PermissionRequest)
 *   {"additionalContext":"…"} / {"hookSpecificOutput":{"additionalContext":"…"}}
 * Exit code 2 = block, and stderr is fed back to the model as the reason. Any
 * other exit code is a non-blocking hook error (reported, ignored).
 *
 * Events (SPEC C6): PreToolUse, PostToolUse, UserPromptSubmit, Stop (run by the
 * agent loop) and SessionStart, SessionEnd, PreCompact, SubagentStart,
 * SubagentStop, PermissionRequest, Notification (run by the extension below).
 *
 * Hook trust (SPEC C6): a hook defined by the *project* (.tugline/config*.json)
 * runs only if the workspace is trusted AND the hash of that hook (event,
 * matcher, command) was approved by the user. Approvals live next to the
 * workspace trust file (~/.tugline/trusted-hooks.json); editing a hook
 * changes its hash, so a modified hook needs approval again. Unapproved project
 * hooks are removed from the config at load time (gateProjectHooks, called once
 * from loadConfig), so no code path can run them.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig, HookConfig } from '../config.js';
import { scrubbedEnv } from '../tools/shell.js';
import { platformSpawnArgs } from '../util/procs.js';
import { registerAgentExtension, type AgentApi } from './extensions.js';
import { registerSlashCommand } from '../commands.js';
import { prefilter } from '../approver/prefilter.js';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PermissionRequest', 'Notification', 'PermissionDenied'] as const; // N43: PermissionDenied fires when auto mode blocks a call
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookOutcome {
  block: boolean;
  reason?: string;
  /** Extra context to give the model */
  context?: string;
  /** hookSpecificOutput.permissionDecision (or PermissionRequest decision.behavior) */
  decision?: 'allow' | 'deny' | 'ask';
}

function matches(matcher: string | undefined, tool: string | undefined): boolean {
  if (!matcher || matcher === '*' || !tool) return true;
  return matcher.split('|').some((m) => new RegExp('^' + m.trim().replace(/[.+?^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(tool));
}

export async function runHooks(hooks: HookConfig[] | undefined, event: HookEvent | string, payload: Record<string, unknown>, cwd: string): Promise<HookOutcome> {
  const outcome: HookOutcome = { block: false };
  for (const h of hooks ?? []) {
    if (!matches(h.matcher, (payload.tool ?? payload.agentType) as string | undefined)) continue;
    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const file = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
      const sp = platformSpawnArgs(file, process.platform === 'win32' ? ['/d', '/s', '/c', h.command] : ['-c', h.command]); // R7: cmd.exe gets the command verbatim
      const p = spawn(file, sp.args, { cwd, env: { ...scrubbedEnv([]), TUGLINE_HOOK: event }, windowsVerbatimArguments: sp.windowsVerbatimArguments, windowsHide: true });
      let stdout = '';
      let stderr = '';
      const t = setTimeout(() => p.kill('SIGKILL'), h.timeoutMs ?? 60_000);
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.stdin.on('error', () => undefined);
      p.on('error', (e) => {
        clearTimeout(t);
        resolve({ code: 1, stdout, stderr: e.message });
      });
      p.on('close', (code) => {
        clearTimeout(t);
        resolve({ code, stdout, stderr });
      });
      p.stdin.end(JSON.stringify({ event, hook_event_name: event, cwd, ...payload }));
    });
    if (res.code === 2) return { block: true, decision: 'deny', reason: res.stderr.trim() || `blocked by ${event} hook` };
    if (res.code === 0 && res.stdout.trim()) {
      try {
        const j = JSON.parse(res.stdout);
        const hso = j.hookSpecificOutput ?? {};
        const pd = String(hso.permissionDecision ?? hso.decision?.behavior ?? '').toLowerCase();
        const pdReason = hso.permissionDecisionReason ?? hso.decision?.message ?? j.reason;
        if (j.decision === 'block' || pd === 'deny') return { block: true, decision: 'deny', reason: pdReason ?? `blocked by ${event} hook` };
        if (pd === 'allow' || pd === 'ask') {
          outcome.decision = outcome.decision === 'ask' ? 'ask' : (pd as 'allow' | 'ask');
          if (pdReason) outcome.reason = pdReason;
        }
        const ctx = j.context ?? j.additionalContext ?? hso.additionalContext;
        if (ctx) outcome.context = [outcome.context, ctx].filter(Boolean).join('\n');
      } catch {
        if (event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'SessionStart') outcome.context = [outcome.context, res.stdout.trim()].filter(Boolean).join('\n');
      }
    }
  }
  return outcome;
}

// ------------------------------------------------------------ hook trust

export function hookHash(event: string, h: HookConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify([event, h.matcher ?? '', h.command])).digest('hex');
}

function hookTrustFile(homeDir: string): string {
  return path.join(homeDir, 'trusted-hooks.json');
}

function readTrust(homeDir: string): Record<string, string[]> {
  try {
    const j = JSON.parse(fs.readFileSync(hookTrustFile(homeDir), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function isHookApproved(homeDir: string, workspace: string, hash: string): boolean {
  return (readTrust(homeDir)[path.resolve(workspace)] ?? []).includes(hash);
}

export function approveHookHashes(homeDir: string, workspace: string, hashes: string[]): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const t = readTrust(homeDir);
  const ws = path.resolve(workspace);
  t[ws] = [...new Set([...(t[ws] ?? []), ...hashes])];
  fs.writeFileSync(hookTrustFile(homeDir), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export interface ProjectHook {
  event: string;
  hook: HookConfig;
  hash: string;
  source: string;
  approved: boolean;
}

function readHooksFrom(file: string): Record<string, HookConfig[]> {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    return j && typeof j.hooks === 'object' && j.hooks ? j.hooks : {};
  } catch {
    return {};
  }
}

/** Hooks declared by the project's own config files, with their approval state. */
export function projectHooks(workspace: string, homeDir: string): ProjectHook[] {
  const out: ProjectHook[] = [];
  for (const f of ['config.json', 'config.local.json']) {
    const hooks = readHooksFrom(path.join(workspace, '.tugline', f));
    for (const [event, list] of Object.entries(hooks)) {
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        if (!h || typeof h.command !== 'string') continue;
        const hash = hookHash(event, h);
        out.push({ event, hook: h, hash, source: `.tugline/${f}`, approved: isHookApproved(homeDir, workspace, hash) });
      }
    }
  }
  return out;
}

const pendingByConfig = new WeakMap<object, ProjectHook[]>();
/** v1.2 WS24 (RC5): hooks from a workspace directory given to `tug --hooks-dir` wait for the same approval (/hooks approve). */
export function addPendingProjectHooks(cfg: HarnessConfig, hooks: ProjectHook[]): void {
  pendingByConfig.set(cfg, [...(pendingByConfig.get(cfg) ?? []), ...hooks]);
}
/** Project hooks removed from this config because they are not approved yet. */
export function pendingProjectHooks(cfg: HarnessConfig): ProjectHook[] {
  return pendingByConfig.get(cfg) ?? [];
}

/**
 * Remove project-defined hooks that are not approved from `cfg.hooks`. Hooks that
 * the user's own config (~/.tugline/config.json) defines identically count as
 * the user's. Called once at the end of loadConfig.
 */
export function gateProjectHooks(cfg: HarnessConfig, opts: { workspace: string; trusted: boolean; noUserConfig?: boolean }): void {
  if (!opts.trusted) return; // untrusted: project hooks were already dropped by restrictOnly
  const userHooks = opts.noUserConfig ? {} : readHooksFrom(path.join(cfg.homeDir, 'config.json'));
  const pending: ProjectHook[] = [];
  for (const ph of projectHooks(opts.workspace, cfg.homeDir)) {
    if (ph.approved) continue;
    const mine = (userHooks[ph.event] ?? []).some((u) => u && hookHash(ph.event, u) === ph.hash);
    if (mine) continue;
    const list = cfg.hooks[ph.event];
    if (!list) continue;
    const kept = list.filter((h) => hookHash(ph.event, h) !== ph.hash);
    if (kept.length !== list.length) {
      cfg.hooks[ph.event] = kept;
      pending.push(ph);
    }
  }
  if (pending.length) {
    pendingByConfig.set(cfg, pending);
    cfg.trust?.ignored.push(...pending.map((p) => `${p.source}: hooks.${p.event} "${p.hook.command}" (hook not approved; /hooks approve)`));
  }
}

// ------------------------------------------------------------ extension: new events

function hooksOf(cfg: HarnessConfig, event: HookEvent): HookConfig[] | undefined {
  const list = cfg.hooks[event];
  return list && list.length ? list : undefined;
}

async function fire(a: AgentApi, event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome | undefined> {
  const hooks = hooksOf(a.config, event);
  if (!hooks) return undefined;
  const r = await runHooks(hooks, event, { session_id: a.sessionId, ...payload }, a.workspace);
  a.journal({ type: 'hook', event, block: r.block, decision: r.decision });
  return r;
}

registerAgentExtension({
  id: 'ws3-hooks',
  async onSessionStart(a) {
    if (a.depth !== 0) return;
    const pending = pendingProjectHooks(a.config);
    if (pending.length) a.notice('warn', `${pending.length} project hook(s) are not approved and will not run: ${pending.map((p) => `${p.event} "${p.hook.command}"`).join('; ')}. Review them with /hooks, approve with /hooks approve.`);
    const r = await fire(a, 'SessionStart', { source: 'startup' });
    if (r?.context) a.journal({ type: 'hook_context', event: 'SessionStart', context: r.context });
  },
  async onSessionEnd(a) {
    if (a.depth !== 0) return;
    await fire(a, 'SessionEnd', { reason: 'dispose' });
  },
  async beforeCompact(a, info) {
    await fire(a, 'PreCompact', { trigger: info.force ? 'manual' : 'auto', tokens: info.tokens });
  },
  async onSubagent(a, info) {
    await fire(a, info.phase === 'start' ? 'SubagentStart' : 'SubagentStop', { agentType: info.agentType, description: info.description, result: info.result });
  },
  async approve(a, q) {
    const r = await fire(a, 'PermissionRequest', { tool: q.tool, args: q.args, title: q.title, reason: q.reason, command: q.input.command, paths: q.input.paths?.map((p) => p.path) });
    if (!r) return undefined;
    if (r.block || r.decision === 'deny') return { decision: 'deny', by: 'PermissionRequest hook', reason: r.reason };
    // A hook may approve ordinary calls, but never the red-team categories (same rule as the classifier).
    if (r.decision === 'allow' && !prefilter(q, a.workspace)) return { decision: 'allow', by: 'PermissionRequest hook', reason: r.reason };
    return undefined;
  },
  async onRunEnd(a, info) {
    if (a.depth !== 0) return;
    await fire(a, 'Notification', { notification_type: 'idle', message: `Tugline finished (${info.stopReason})`, stopReason: info.stopReason });
  },
});

// ------------------------------------------------------------ /hooks

registerSlashCommand({
  name: 'hooks',
  description: 'list hooks and approve project hooks (hook trust)',
  usage: '[approve [all|n]]',
  run(args, ctx) {
    const [sub, which] = args.trim().split(/\s+/);
    const pending = pendingProjectHooks(ctx.config);
    if (sub === 'approve') {
      if (!pending.length) return void ctx.write('  no project hooks waiting for approval');
      if (ctx.config.trust && !ctx.config.trust.workspaceTrusted) return void ctx.write('  trust the workspace first (tug --trust): project hooks only run in trusted workspaces');
      const pick = !which || which === 'all' ? pending : [pending[Number(which) - 1]].filter(Boolean);
      approveHookHashes(ctx.config.homeDir, ctx.workspace, pick.map((p) => p.hash));
      for (const p of pick) (ctx.config.hooks[p.event] ??= []).push(p.hook);
      pendingByConfig.set(ctx.config, pending.filter((p) => !pick.includes(p)));
      ctx.write(`  approved ${pick.length} hook(s): ${pick.map((p) => `${p.event} "${p.hook.command}"`).join('; ')}`);
      return;
    }
    const lines: string[] = [];
    for (const [event, list] of Object.entries(ctx.config.hooks)) for (const h of list ?? []) lines.push(`  ${event}${h.matcher ? `(${h.matcher})` : ''}: ${h.command}`);
    if (!lines.length) lines.push('  (no active hooks)');
    if (pending.length) lines.push('  not approved (will not run):', ...pending.map((p, i) => `  ${i + 1}. [${p.source}] ${p.event}${p.hook.matcher ? `(${p.hook.matcher})` : ''}: ${p.hook.command}`), '  approve with /hooks approve [all|n]');
    ctx.write(lines.join('\n'));
  },
});
