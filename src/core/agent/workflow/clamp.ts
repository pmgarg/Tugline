/**
 * v1.2 N18 SAC1 / N34 SAC1 / SPEC_V1_2 S2 "narrow only": what a child (nested
 * subagent, workflow item, teammate, goal verifier) may have, given what it
 * asked for and what its parent has.
 *
 * A child's tools, permission mode, allowed roots, network domains, model
 * profile and budget are each a subset of, or stricter than, its parent's.
 * Anything a spec (written by a model, or by a user in a workflow file) asks
 * for beyond that is CLAMPED here: removed or lowered to the parent's level.
 * The caller journals every clamp (S8), so a widening attempt is visible.
 *
 * This is pure: the caller passes the parent's authority and gets back the
 * granted spec plus one reason per clamp. `Agent.spawnChild` applies it, and
 * `broaderThan` (permissions/authority.ts) still runs on the created child as
 * the fail-closed backstop.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '../../types.js';
import { modeWithin } from '../../permissions/authority.js';
import { matchDomain } from '../../sandbox/proxy.js';
import { limitState } from '../../llm/admission.js';
import { ToolError } from '../../tools/types.js';

/** What a child asks for. Every field is optional: absent = inherit the parent's. */
export interface ChildRequest {
  tools?: string[];
  mode?: PermissionMode | string;
  /** extra directories the child may use (permissions.additionalDirectories) */
  roots?: string[];
  /** network domains (sandbox.allowDomains) */
  domains?: string[];
  /** model profile name */
  profile?: string;
  budget?: { maxTokens?: number; maxCostUsd?: number };
}

export interface ParentAuthority {
  tools: string[];
  mode: PermissionMode;
  roots: string[];
  domains: string[];
  profiles: string[];
  /** what the parent may still spend (undefined = unlimited) */
  remaining: { maxTokens?: number; maxCostUsd?: number };
}

export interface Clamp {
  field: 'tools' | 'mode' | 'roots' | 'domains' | 'profile' | 'budget' | 'mcpServers' | 'hooks' | 'sandbox';
  requested: unknown;
  granted: unknown;
  reason: string;
}

export interface Granted {
  tools?: string[];
  mode?: PermissionMode;
  roots?: string[];
  domains?: string[];
  profile?: string;
  budget: { maxTokens?: number; maxCostUsd?: number };
  clamps: Clamp[];
}

/** F8: containment by REAL path (a symlink that leads out is outside); a path that does not exist is never inside. */
export function realInside(child: string, parent: string): boolean {
  let c: string;
  let p: string;
  try {
    c = fs.realpathSync(child);
    p = fs.realpathSync(parent);
  } catch {
    return false;
  }
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Narrow a request to the parent's authority. Never widens; reports every cut. */
export function clampChild(req: ChildRequest, parent: ParentAuthority): Granted {
  const clamps: Clamp[] = [];
  const out: Granted = { budget: {}, clamps };
  if (req.tools) {
    const have = new Set(parent.tools);
    const ok = req.tools.filter((t) => have.has(t));
    const extra = req.tools.filter((t) => !have.has(t));
    if (extra.length) clamps.push({ field: 'tools', requested: req.tools, granted: ok, reason: `tools the parent does not have were removed: ${extra.join(', ')}` });
    out.tools = ok;
  }
  if (req.mode !== undefined) {
    const known = ['plan', 'ask', 'acceptEdits', 'auto', 'yolo'].includes(String(req.mode));
    // N43: S2 is a partial order (modeWithin): a child mode must be the parent's or narrower; `auto` and `acceptEdits`
    // are incomparable, so neither can be granted under the other, and `yolo` only under `yolo`
    if (!known || !modeWithin(String(req.mode), parent.mode)) {
      clamps.push({ field: 'mode', requested: req.mode, granted: parent.mode, reason: known ? `permission mode ${req.mode} is broader than the parent's ${parent.mode} or not comparable with it (S2: only the parent's mode or a narrower one)` : `unknown permission mode ${String(req.mode)}` });
      out.mode = parent.mode;
    } else out.mode = req.mode as PermissionMode;
  }
  if (req.roots) {
    const ok = req.roots.filter((r) => parent.roots.some((p) => realInside(r, p))).map((r) => fs.realpathSync(r));
    const extra = req.roots.filter((r) => !parent.roots.some((p) => realInside(r, p)));
    if (extra.length) clamps.push({ field: 'roots', requested: req.roots, granted: ok, reason: `directories outside the parent's allowed roots (by real path) were removed: ${extra.join(', ')}` });
    out.roots = ok;
  }
  if (req.domains) {
    // a requested domain is kept only when the parent's own allowlist would let that exact host through
    // (a wildcard request like "*.example.com" needs the same wildcard, or "*", in the parent's list)
    const ok = req.domains.filter((d) => parent.domains.includes(d) || parent.domains.includes('*') || (!d.includes('*') && !!matchDomain(d, parent.domains)));
    const extra = req.domains.filter((d) => !ok.includes(d));
    if (extra.length) clamps.push({ field: 'domains', requested: req.domains, granted: ok, reason: `network domains the parent may not reach were removed: ${extra.join(', ')}` });
    out.domains = ok;
  }
  if (req.profile !== undefined) {
    if (parent.profiles.includes(req.profile)) out.profile = req.profile;
    else clamps.push({ field: 'profile', requested: req.profile, granted: undefined, reason: `model profile "${req.profile}" is not configured (a spec cannot add a model endpoint); the parent's model is used` });
  }
  // budget: min(requested cap, what the parent has left)
  for (const k of ['maxTokens', 'maxCostUsd'] as const) {
    const want = req.budget?.[k];
    const left = parent.remaining[k];
    const leftState = limitState(left);
    if (want === undefined) {
      if (leftState !== 'unlimited') out.budget[k] = left;
      continue;
    }
    if (typeof want !== 'number' || !Number.isFinite(want) || want < 0) {
      clamps.push({ field: 'budget', requested: { [k]: want }, granted: { [k]: 0 }, reason: `invalid ${k} ${String(want)}: treated as exhausted` });
      out.budget[k] = 0;
    } else if (leftState !== 'unlimited' && want > left!) {
      clamps.push({ field: 'budget', requested: { [k]: want }, granted: { [k]: Math.max(0, left!) }, reason: `${k} ${want} is more than the parent has left (${Math.max(0, left!)})` });
      out.budget[k] = Math.max(0, left!);
    } else out.budget[k] = want;
  }
  return out;
}

/** Typed refusals for child creation (depth, member count, workflow size, ...). The code is what callers match on. */
export type ChildRefusalCode = 'resume_refused' | 'sandbox_unavailable' | 'depth_limit' | 'member_limit' | 'workflow_too_large' | 'not_approved' | 'invalid_spec' | 'team_exists' | 'no_team' | 'rate_limited' | 'unknown_member' | 'claim_conflict' | 'blocked_by_dependencies';

export class ChildRefusal extends ToolError {
  constructor(
    readonly code: ChildRefusalCode,
    message: string,
  ) {
    super(`Refused (${code}): ${message}`);
    this.name = 'ChildRefusal';
  }
}

/** v1.2 N18: agent.maxDepth, default 2, clamped to 1..4. */
export function maxDepthOf(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 2;
  return Math.min(4, Math.max(1, n));
}
