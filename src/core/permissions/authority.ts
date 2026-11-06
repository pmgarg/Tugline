/**
 * v1.1 R13: the authority-inheritance invariant.
 *
 * A child worker (a subagent, a worktree subagent, and through them the tools they
 * call: browser, desktop, remote host, MCP) never gets broader authority than the
 * task that started it. "Authority" is what the permission engine and the tool list
 * let an agent do; it is compared dimension by dimension, so a child can be narrower
 * in any of them and is refused if it is broader in one.
 *
 * The check runs at the one place a child is created (`Agent.runSubagentNow`) and
 * fails closed: a child that would be broader is not started.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionPolicy } from './policy.js';

export interface Authority {
  mode: string;
  /** Tool names the agent can call (visible or deferred). */
  tools: string[];
  allow: string[];
  deny: string[];
  protectedPaths: string[];
  additionalDirectories: string[];
  /** When set, the only paths the agent may write. */
  writeOnly?: string[];
}

/** Permission modes from narrowest to broadest. `default` and `ask` are the same. */
// N43: `auto` (classifier) is narrower than `yolo` (no classifier).
const MODE_RANK: Record<string, number> = { plan: 0, ask: 1, default: 1, acceptEdits: 2, auto: 3, yolo: 4, bypassPermissions: 4 };
export function modeRank(mode: string): number {
  return MODE_RANK[mode] ?? 4; // an unknown mode counts as the broadest, so it can never be a child's escape
}

/**
 * N43 (review finding 8): the S2 order of modes is partial. `auto` and `acceptEdits` are incomparable: acceptEdits
 * edits and fetches with no classifier, auto runs classifier-approved commands. A child may be the parent's mode or
 * one below it in this order, never a sideways move.
 */
const WITHIN: Record<string, string[]> = {
  plan: ['plan'],
  ask: ['plan', 'ask', 'default'],
  default: ['plan', 'ask', 'default'],
  acceptEdits: ['plan', 'ask', 'default', 'acceptEdits'],
  auto: ['plan', 'ask', 'default', 'auto'],
  yolo: ['plan', 'ask', 'default', 'acceptEdits', 'auto', 'yolo'],
  bypassPermissions: ['plan', 'ask', 'default', 'acceptEdits', 'auto', 'yolo', 'bypassPermissions'],
};
export function modeWithin(child: string, parent: string): boolean {
  return (WITHIN[parent] ?? []).includes(child);
}

export function authorityOf(policy: PermissionPolicy, tools: Iterable<string>): Authority {
  const o = policy.opts;
  return {
    mode: policy.mode,
    tools: [...new Set(tools)].sort(),
    allow: [...o.allow],
    deny: [...o.deny],
    protectedPaths: [...o.protectedPaths],
    additionalDirectories: [...o.additionalDirectories],
    writeOnly: o.writeOnly ? [...o.writeOnly] : undefined,
  };
}

/** Tools only the main agent has; a child never needs them to be "as broad" as its parent. */
const PARENT_ONLY = new Set(['task', 'task_result', 'worktree_merge', 'exit_plan_mode', 'ask_user']);

/**
 * Every way `child` is broader than `parent`, as readable reasons (empty: the
 * invariant holds). The workspace root itself is not compared: a worktree child
 * works in its own checkout, which is a copy of the parent's tree, not more of it.
 */
export function broaderThan(child: Authority, parent: Authority): string[] {
  const out: string[] = [];
  if (!modeWithin(child.mode, parent.mode)) out.push(modeWithin(parent.mode, child.mode) || modeRank(child.mode) > modeRank(parent.mode) ? `permission mode ${child.mode} is broader than the parent's ${parent.mode}` : `permission mode ${child.mode} is not comparable with the parent's ${parent.mode} (neither is narrower)`);
  const pt = new Set(parent.tools);
  const extraTools = child.tools.filter((t) => !pt.has(t) && !PARENT_ONLY.has(t));
  if (extraTools.length) out.push(`tools the parent does not have: ${extraTools.join(', ')}`);
  const extraAllow = child.allow.filter((r) => !parent.allow.includes(r));
  if (extraAllow.length) out.push(`allow rules the parent does not have: ${extraAllow.join(', ')}`);
  const lostDeny = parent.deny.filter((r) => !child.deny.includes(r));
  if (lostDeny.length) out.push(`deny rules dropped: ${lostDeny.join(', ')}`);
  const lostProtected = parent.protectedPaths.filter((p) => !child.protectedPaths.includes(p));
  if (lostProtected.length) out.push(`protected paths dropped: ${lostProtected.join(', ')}`);
  // v1.2 F8: by containment of real paths (a subdirectory of a parent directory is not broader; a symlink out is)
  const real = (d: string) => {
    try {
      return fs.realpathSync(d);
    } catch {
      return path.resolve(d);
    }
  };
  const within = (c: string, p: string) => {
    const rel = path.relative(real(p), real(c));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const extraDirs = child.additionalDirectories.filter((d) => !parent.additionalDirectories.some((p) => within(d, p)));
  if (extraDirs.length) out.push(`additional directories the parent does not have: ${extraDirs.join(', ')}`);
  if (parent.writeOnly) {
    if (!child.writeOnly) out.push(`the parent may only write ${parent.writeOnly.join(', ')}; the child is unrestricted`);
    else {
      const extra = child.writeOnly.filter((g) => !parent.writeOnly!.includes(g));
      if (extra.length) out.push(`write globs the parent does not have: ${extra.join(', ')}`);
    }
  }
  return out;
}

/** The tools a child may be given: what it asks for, cut down to what the parent has. */
export function narrowTools<T extends { name: string }>(requested: T[], parentTools: Iterable<string>): T[] {
  const pt = new Set(parentTools);
  return requested.filter((t) => pt.has(t.name));
}
