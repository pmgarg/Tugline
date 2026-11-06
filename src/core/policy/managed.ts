/**
 * Managed (enterprise) policy (SPEC C4).
 *
 * An administrator places a JSON file at the platform's system location:
 *   Linux   /etc/tugline/managed.json
 *   macOS   /Library/Application Support/Tugline/managed.json
 *   Windows %ProgramData%\Tugline\managed.json
 * and/or points TUG_MANAGED_POLICY at one (deployments without root, tests). When
 * both exist they are combined restrictively (union of denies, intersection of
 * allowlists, the lower cost cap); the system file's locked profile wins.
 *
 * Fields:
 *   lockedProfile    { baseUrl?, model?, apiKey?, headers?, … } forced onto every profile
 *   deny             permission deny rules, added to every layer's
 *   protectedPaths   extra protected globs
 *   allowMcpServers  MCP server names, commands or URLs that may start; others are removed
 *   allowSkills      skill names that may load; others are disabled
 *   disableAutoMode  forbids permissionMode "auto" and "yolo" and the classifier approver (N43: both modes
 *                    approve without a human)
 *   disableYoloMode  N43: forbids permissionMode "yolo" (the classifier-less mode) only
 *   maxCostUsdPerDay caps limits.maxCostUsdPerDay (v1.1 R4 semantics: absent = no cap, 0 = exhausted;
 *                    two sources combine to the lower value, so a second file can only tighten)
 *   forceSandbox     true | "auto" | "bwrap" | "seatbelt" | "docker": commands never run unsandboxed
 *   remote           N22: { url, publicKey, refreshSeconds?, maxStaleSeconds?, failClosed?, headers? }
 *                    a signed company policy, combined restrictively with this file (policy/remote.ts)
 *   minVersion, maxVersion, allowedVersions
 *                    N22: Tugline refuses to start outside the range
 *   usage            N22: { url, headers?, intervalSeconds?, failClosed?, user? } org-wide usage
 *                    reporting and per-user quotas at admission (policy/orgUsage.ts)
 *   audit            N23 / R6: { sink: "<https URL | absolute file>" } forced as `audit.sink`, where
 *                    journal hashes (WS4 R6) and security events (N23) are anchored
 *
 * `applyGovernance` is the ONE call WS3 adds to loadConfig (SPEC §2). It runs
 * after every other layer (files, env vars, CLI/VS Code overrides), so managed
 * values beat all of them, and an agent extension re-checks the two settings
 * that can change at runtime (permission mode, active model profile).
 * Violations (attempts by other layers to loosen the policy) are recorded in
 * `cfg.managed.violations` and reported at session start. A managed file that
 * exists but cannot be parsed stops the harness (fail closed).
 *
 * The same call also applies hook trust (C6): unapproved project hooks are
 * removed from the config here, so they can never run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessConfig } from '../config.js';
import type { ModelProfile } from '../types.js';
import { registerAgentExtension } from '../agent/extensions.js';
import { gateProjectHooks } from '../agent/hooks.js';
import { defaultSkillDirs, parseFrontmatter } from '../skills/manager.js';
import { compareVersions, loadRemotePolicy, versionRefusal, type RemotePolicyConfig } from './remote.js';
import { recordSecurityEvent } from '../permissions/audit.js';
import { projectAllowProblem } from '../approver/ruleScope.js';

export interface ManagedPolicy {
  lockedProfile?: Partial<ModelProfile>;
  deny?: string[];
  protectedPaths?: string[];
  allowMcpServers?: string[];
  allowSkills?: string[];
  disableAutoMode?: boolean;
  /** N43: forbid the classifier-less mode only (auto mode stays available). */
  disableYoloMode?: boolean;
  maxCostUsdPerDay?: number;
  forceSandbox?: boolean | 'auto' | 'bwrap' | 'seatbelt' | 'docker';
  /** N22: fetch a signed policy from the company (only honoured in a local managed file or the TUG_MANAGED_POLICY_URL env). */
  remote?: RemotePolicyConfig;
  minVersion?: string;
  maxVersion?: string;
  allowedVersions?: string[];
  /** N22: org-wide usage reporting and per-user quotas. */
  usage?: OrgUsagePolicy;
  /** N23 / R6: the external anchor every client must use (`audit.sink`: an http(s) URL or an absolute file path). */
  audit?: { sink?: string };
}

export interface OrgUsagePolicy {
  /** POST endpoint that receives this client's daily totals and answers with the org aggregate and quota. */
  url: string;
  headers?: Record<string, string>;
  /** Re-sync at admission when the last answer is older than this (default 30). 0 = before every model call. */
  intervalSeconds?: number;
  /** Usage server unreachable and no previous answer → stop at admission (default false). */
  failClosed?: boolean;
  /** User id reported (default $TUG_USER, else the OS user name). */
  user?: string;
}

/** This harness's version (package.json when it is found, else the release constant). */
export const TUGLINE_VERSION: string = (() => {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, 'package.json');
      if (fs.existsSync(f)) {
        const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (pkg.name === 'tugline' && typeof pkg.version === 'string') return pkg.version as string;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* bundled */
  }
  return '1.0.0';
})();

export interface ManagedState {
  /** Files the policy came from (empty = no managed policy). */
  sources: string[];
  policy: ManagedPolicy;
  /** What other layers tried that the policy overrode. */
  violations: string[];
  /** N22: the remote policy in use (from the managed file or the environment), for `tug doctor`. */
  remote?: { url: string; highWaterFile?: string };
}

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** Set by loadConfig from the managed policy (SPEC C4). Never read from user/project files. */
    managed?: ManagedState;
  }
}

export function systemManagedPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return '/Library/Application Support/Tugline/managed.json';
  if (platform === 'win32') return path.join(env.ProgramData ?? 'C:\\ProgramData', 'Tugline', 'managed.json');
  return '/etc/tugline/managed.json';
}

const KNOWN = new Set(['lockedProfile', 'deny', 'protectedPaths', 'allowMcpServers', 'allowSkills', 'disableAutoMode', 'disableYoloMode', 'maxCostUsdPerDay', 'forceSandbox', 'remote', 'minVersion', 'maxVersion', 'allowedVersions', 'usage', 'audit', '$schema', 'comment']);

function validate(p: any, file: string): ManagedPolicy {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`managed policy ${file}: expected a JSON object`);
  const bad = Object.keys(p).filter((k) => !KNOWN.has(k));
  if (bad.length) throw new Error(`managed policy ${file}: unknown field(s) ${bad.join(', ')}`);
  const strArr = (k: string) => {
    if (p[k] !== undefined && (!Array.isArray(p[k]) || p[k].some((x: unknown) => typeof x !== 'string'))) throw new Error(`managed policy ${file}: ${k} must be an array of strings`);
  };
  for (const k of ['deny', 'protectedPaths', 'allowMcpServers', 'allowSkills']) strArr(k);
  if (p.lockedProfile !== undefined && (typeof p.lockedProfile !== 'object' || Array.isArray(p.lockedProfile))) throw new Error(`managed policy ${file}: lockedProfile must be an object`);
  if (p.maxCostUsdPerDay !== undefined && !(typeof p.maxCostUsdPerDay === 'number' && p.maxCostUsdPerDay >= 0)) throw new Error(`managed policy ${file}: maxCostUsdPerDay must be a number ≥ 0`);
  if (p.forceSandbox !== undefined && ![true, false, 'auto', 'bwrap', 'seatbelt', 'docker'].includes(p.forceSandbox)) throw new Error(`managed policy ${file}: forceSandbox must be true/false or auto|bwrap|seatbelt|docker`);
  for (const k of ['minVersion', 'maxVersion']) {
    if (p[k] === undefined) continue;
    try {
      compareVersions(String(p[k]), '0.0.0');
    } catch {
      throw new Error(`managed policy ${file}: ${k} must be a version like "1.2.0"`);
    }
  }
  strArr('allowedVersions');
  const url = (o: any, k: string) => {
    if (o[k] === undefined) return;
    if (!o[k] || typeof o[k] !== 'object' || typeof o[k].url !== 'string' || !/^https?:\/\//.test(o[k].url)) throw new Error(`managed policy ${file}: ${k}.url must be an http(s) URL`);
  };
  url(p, 'remote');
  if (p.remote !== undefined && typeof p.remote.publicKey !== 'string') throw new Error(`managed policy ${file}: remote.publicKey (Ed25519, pinned here) is required`);
  url(p, 'usage');
  if (p.audit !== undefined && (typeof p.audit !== 'object' || (p.audit.sink !== undefined && (typeof p.audit.sink !== 'string' || !(/^https?:\/\//.test(p.audit.sink) || path.isAbsolute(p.audit.sink))))))
    throw new Error(`managed policy ${file}: audit.sink must be an http(s) URL or an absolute file path`);
  return p as ManagedPolicy;
}

/** Combine two policies so the result is at least as strict as each. */
export function combinePolicies(a: ManagedPolicy, b: ManagedPolicy): ManagedPolicy {
  const inter = (x?: string[], y?: string[]) => (x && y ? x.filter((v) => y.includes(v)) : (x ?? y));
  const union = (x?: string[], y?: string[]) => (x || y ? [...new Set([...(x ?? []), ...(y ?? [])])] : undefined);
  const min = (x?: number, y?: number) => (x === undefined ? y : y === undefined ? x : Math.min(x, y));
  return {
    lockedProfile: a.lockedProfile || b.lockedProfile ? { ...(b.lockedProfile ?? {}), ...(a.lockedProfile ?? {}) } : undefined,
    deny: union(a.deny, b.deny),
    protectedPaths: union(a.protectedPaths, b.protectedPaths),
    allowMcpServers: inter(a.allowMcpServers, b.allowMcpServers),
    allowSkills: inter(a.allowSkills, b.allowSkills),
    disableAutoMode: a.disableAutoMode || b.disableAutoMode || undefined,
    disableYoloMode: a.disableYoloMode || b.disableYoloMode || undefined,
    maxCostUsdPerDay: min(a.maxCostUsdPerDay, b.maxCostUsdPerDay),
    forceSandbox: a.forceSandbox || b.forceSandbox || undefined,
    // the stricter range of the two
    minVersion: [a.minVersion, b.minVersion].filter((x): x is string => !!x).sort(compareVersions).at(-1),
    maxVersion: [a.maxVersion, b.maxVersion].filter((x): x is string => !!x).sort(compareVersions)[0],
    allowedVersions: inter(a.allowedVersions, b.allowedVersions),
    remote: a.remote ?? b.remote,
    usage: a.usage ?? b.usage,
    audit: a.audit || b.audit ? { sink: a.audit?.sink ?? b.audit?.sink } : undefined,
  };
}

/** Load the managed policy (system file first, then TUG_MANAGED_POLICY). Throws on an unreadable/invalid file. */
export function loadManagedPolicy(env: NodeJS.ProcessEnv = process.env, systemPath = systemManagedPath(process.platform, env)): { policy: ManagedPolicy; sources: string[] } {
  const files = [systemPath, env.TUG_MANAGED_POLICY].filter((f): f is string => !!f);
  let policy: ManagedPolicy = {};
  const sources: string[] = [];
  for (const f of [...new Set(files)]) {
    if (!fs.existsSync(f)) {
      if (f === env.TUG_MANAGED_POLICY) throw new Error(`TUG_MANAGED_POLICY points to a missing file: ${f}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      throw new Error(`managed policy ${f} is not valid JSON (${(e as Error).message}); fix it or remove it`);
    }
    policy = sources.length ? combinePolicies(policy, validate(parsed, f)) : validate(parsed, f);
    sources.push(f);
  }
  return { policy, sources };
}

function bundledSkillsDir(): string | undefined {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (fs.existsSync(path.join(dir, 'skills')) && fs.existsSync(path.join(dir, 'package.json'))) return path.join(dir, 'skills');
      dir = path.dirname(dir);
    }
  } catch {
    /* bundled (VS Code): no file URL */
  }
  return undefined;
}

/** Names of all skills the harness could load for this workspace. */
export function discoverSkillNames(cfg: HarnessConfig, workspace: string): string[] {
  const names = new Set<string>();
  for (const { dir } of defaultSkillDirs(workspace, bundledSkillsDir(), cfg.skills.dirs)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'));
        names.add(String(meta.name ?? e.name).trim());
      } catch {
        /* not a skill */
      }
    }
  }
  return [...names];
}

function mcpAllowed(name: string, server: { command?: string; args?: string[]; url?: string }, allow: string[]): boolean {
  const cmd = server.command ? [server.command, ...(server.args ?? [])].join(' ') : undefined;
  return allow.some((a) => a === name || (server.command && (a === server.command || a === path.basename(server.command) || a === cmd)) || (server.url && a === server.url));
}

/** N43: the permission modes a managed policy forbids. */
export function forbiddenModes(policy: ManagedPolicy): string[] {
  if (policy.disableAutoMode) return ['auto', 'yolo'];
  if (policy.disableYoloMode) return ['yolo'];
  return [];
}

/** Apply a policy to a fully merged config. Returns the violations. */
export function applyManagedPolicy(cfg: HarnessConfig, policy: ManagedPolicy, opts: { workspace: string }): string[] {
  const v: string[] = [];
  const lp = policy.lockedProfile;
  if (lp && Object.keys(lp).length) {
    const locked = { ...lp };
    delete (locked as any).name;
    for (const [name, prof] of Object.entries(cfg.profiles)) {
      for (const [k, val] of Object.entries(locked)) {
        const cur = (prof as any)[k];
        if (cur !== undefined && JSON.stringify(cur) !== JSON.stringify(val)) v.push(`profile ${name}: ${k} is locked by managed policy (was ${k === 'apiKey' ? '***' : JSON.stringify(cur)})`);
      }
      cfg.profiles[name] = { ...prof, ...locked };
    }
    if (!cfg.profiles[cfg.profile]) cfg.profiles[cfg.profile] = { ...locked };
  }
  if (policy.deny?.length) cfg.permissions.deny = [...new Set([...cfg.permissions.deny, ...policy.deny])];
  if (policy.protectedPaths?.length) cfg.permissions.protectedPaths = [...new Set([...cfg.permissions.protectedPaths, ...policy.protectedPaths])];
  if (policy.allowMcpServers) {
    for (const [name, s] of Object.entries(cfg.mcpServers)) {
      if (!mcpAllowed(name, s, policy.allowMcpServers)) {
        delete cfg.mcpServers[name];
        v.push(`MCP server "${name}" is not in the managed allowMcpServers list; it will not start`);
      }
    }
  }
  if (policy.allowSkills) {
    const blocked = discoverSkillNames(cfg, opts.workspace).filter((n) => !policy.allowSkills!.includes(n));
    if (blocked.length) {
      cfg.skills.disabled = [...new Set([...cfg.skills.disabled, ...blocked])];
      v.push(`skills not in the managed allowSkills list are disabled: ${blocked.join(', ')}`);
    }
  }
  const forbidden = forbiddenModes(policy);
  if (forbidden.includes(cfg.permissionMode)) {
    v.push(`permissionMode "${cfg.permissionMode}" is disabled by managed policy; using "ask"`);
    cfg.permissionMode = 'ask';
  }
  if (policy.disableAutoMode) {
    if (cfg.approver?.enabled) v.push('the classifier approver (auto mode) is disabled by managed policy');
    cfg.approver = { ...(cfg.approver ?? {}), enabled: false };
  }
  if (policy.maxCostUsdPerDay !== undefined) {
    // R4 semantics: undefined = unlimited, 0 = exhausted. The stricter of the user's limit and the cap wins,
    // so a user's 0 stays 0 and a managed 0 exhausts every budget.
    const cap = policy.maxCostUsdPerDay;
    const cur: unknown = cfg.limits?.maxCostUsdPerDay;
    // only a finite number ≥ 0 can keep its value; anything else (null, a string, an object) becomes the cap
    const valid = typeof cur === 'number' && Number.isFinite(cur) && cur >= 0;
    if (cur !== undefined && !valid) v.push(`limits.maxCostUsdPerDay ${JSON.stringify(cur)} is not a number ≥ 0; replaced by the managed cap ${cap}`);
    else if (valid && cur > cap) v.push(`limits.maxCostUsdPerDay ${cur} lowered to the managed cap ${cap}`);
    if (!valid || (cur as number) > cap) cfg.limits = { ...(cfg.limits ?? {}), maxCostUsdPerDay: cap };
  }
  if (policy.audit?.sink) {
    // R6/N23: the company's anchor wins over any configured one (read through a cast until WS4's `audit` key lands on main)
    const c = cfg as unknown as { audit?: { sink?: string } };
    if (c.audit?.sink && c.audit.sink !== policy.audit.sink) v.push(`audit.sink ${c.audit.sink} replaced by the managed sink`);
    c.audit = { ...(c.audit ?? {}), sink: policy.audit.sink };
  }
  if (policy.forceSandbox) {
    const want = policy.forceSandbox === true ? 'auto' : policy.forceSandbox;
    // N36: the runner may be spelled sandbox.runner / sandbox.mode / shell.sandbox; the managed choice replaces all three
    const sbx = (cfg.sandbox ?? {}) as { runner?: string; mode?: string };
    const cur = sbx.runner ?? sbx.mode ?? cfg.shell.sandbox;
    const isOs = cur === 'bwrap' || cur === 'seatbelt' || cur === 'docker' || cur === 'podman' || cur === 'landlock';
    const next = !(want === 'auto' && isOs) && cur !== want ? want : cur;
    if (next !== cur && cur !== 'none') v.push(`shell.sandbox "${cur}" replaced by the managed sandbox "${want}"`);
    if (next !== cur) cfg.shell.sandbox = want;
    cfg.sandbox = { ...(cfg.sandbox ?? {}), required: true, runner: next as never, mode: undefined };
  }
  return v;
}

/** limits.* must be absent or a finite number ≥ 0 (v1.1 R4: absent = unlimited, 0 = exhausted). Anything else stops loadConfig with a clear error. */
export function validateLimits(cfg: HarnessConfig): void {
  const l = cfg.limits as Record<string, unknown> | undefined;
  if (l === undefined) return;
  if (!l || typeof l !== 'object' || Array.isArray(l)) throw new Error('config: limits must be an object, e.g. { "maxCostUsdPerDay": 5 }');
  for (const k of ['maxCostUsdPerDay', 'maxTokensPerDay', 'maxCostUsdPerSession']) {
    const v = l[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
      throw new Error(`config: limits.${k} must be a number ≥ 0 (got ${JSON.stringify(v)}). Remove the key for no limit; 0 means the budget is exhausted.`);
  }
}

/**
 * The single governance step at the end of loadConfig (SPEC §2 amendment):
 * managed policy (C4) and project-hook trust (C6).
 */
/**
 * N43 / S7 (review finding 5): an allow rule from a (trusted) project layer may not allow every command or tool, a
 * floor-category command or self-modification edits (`ruleScope.ts`); it is dropped with a notice unless the user's
 * own config has the same rule. Same check as `/permissions add allow … --project`.
 */
function gateProjectAllowRules(cfg: HarnessConfig, workspace: string, noUserConfig?: boolean): void {
  const asked = cfg.trust?.projectAllow ?? [];
  if (!asked.length) return;
  let userAllow: unknown[] = [];
  if (!noUserConfig) {
    try {
      const u = JSON.parse(fs.readFileSync(path.join(cfg.homeDir, 'config.json'), 'utf8'));
      if (Array.isArray(u?.permissions?.allow)) userAllow = u.permissions.allow;
    } catch {
      /* no user config */
    }
  }
  for (const { rule, source } of asked) {
    const why = projectAllowProblem(rule, workspace);
    if (!why || userAllow.includes(rule)) continue;
    cfg.permissions.allow = cfg.permissions.allow.filter((r) => r !== rule);
    const msg = `${source}: permissions.allow ${JSON.stringify(rule)} (${why}; only your user config can allow that)`;
    if (cfg.trust && !cfg.trust.ignored.includes(msg)) cfg.trust.ignored.push(msg);
  }
}

export function applyGovernance(cfg: HarnessConfig, opts: { workspace: string; env?: NodeJS.ProcessEnv; trusted: boolean; noUserConfig?: boolean; systemPath?: string; version?: string; now?: Date }): HarnessConfig {
  // A user/project file must never be able to pose as the managed state.
  delete cfg.managed;
  validateLimits(cfg);
  gateProjectHooks(cfg, { workspace: opts.workspace, trusted: opts.trusted, noUserConfig: opts.noUserConfig });
  gateProjectAllowRules(cfg, opts.workspace, opts.noUserConfig);
  const env = opts.env ?? process.env;
  let { policy, sources } = loadManagedPolicy(env, opts.systemPath);
  const problems: string[] = [];
  // N22: a signed company policy, named by the local managed file (or the environment), never by user/project config.
  const rc: RemotePolicyConfig | undefined = policy.remote ?? (env.TUG_MANAGED_POLICY_URL ? { url: env.TUG_MANAGED_POLICY_URL, publicKey: env.TUG_MANAGED_POLICY_PUBLIC_KEY ?? '', failClosed: env.TUG_MANAGED_POLICY_FAIL_CLOSED === '1' || undefined } : undefined);
  if (rc) {
    if (!rc.publicKey) throw new Error('TUG_MANAGED_POLICY_URL is set but no public key is pinned (TUG_MANAGED_POLICY_PUBLIC_KEY or remote.publicKey in the managed file); refusing to trust an unsigned policy');
    const r = loadRemotePolicy(rc, cfg.homeDir, opts.now);
    problems.push(...r.problems);
    let remote: ManagedPolicy | undefined;
    if (r.policy) {
      try {
        remote = validate(r.policy, rc.url);
      } catch (e) {
        if (rc.failClosed) throw e;
        problems.push(`remote managed policy ignored: ${(e as Error).message}`);
      }
    }
    if (remote) {
      delete remote.remote; // a served policy cannot redirect where policy comes from
      policy = sources.length ? combinePolicies(policy, remote) : remote;
      sources = [...sources, r.source];
    } else sources = [...sources, `${rc.url} (unavailable)`];
  }
  if (!sources.length) return cfg;
  const refusal = versionRefusal(opts.version ?? TUGLINE_VERSION, policy);
  if (refusal) throw new Error(refusal);
  const violations = [...problems, ...applyManagedPolicy(cfg, policy, { workspace: opts.workspace })];
  cfg.managed = { sources, policy, violations, ...(rc ? { remote: { url: rc.url, highWaterFile: rc.highWaterFile } } : {}) };
  return cfg;
}

// ------------------------------------------------------------ runtime enforcement

registerAgentExtension({
  id: 'ws3-managed',
  onSessionStart(a) {
    const m = a.config.managed;
    if (a.depth !== 0 || !m) return;
    a.journal({ type: 'managed_policy', sources: m.sources, violations: m.violations });
    if (m.violations.length) a.notice('warn', `managed policy (${m.sources.join(', ')}) overrode: ${m.violations.join('; ')}`);
  },
  onModeChange(a, _from, to) {
    // N43: refuse a forbidden mode the moment it is selected (/mode, VS Code, tug serve, SDK), not only at the next turn
    const m = a.config.managed;
    const agent = a.agent as { setMode?: (x: string) => void };
    if (!m || !forbiddenModes(m.policy).includes(to) || !agent.setMode) return;
    agent.setMode('ask');
    m.violations.push(`runtime switch to permissionMode "${to}" refused`);
    recordSecurityEvent(a, { type: 'policy_violation', category: 'managed', decision: 'override', by: 'managed', reason: `runtime switch to permissionMode "${to}" refused` });
    a.notice('warn', `managed policy: permission mode "${to}" is disabled; switched to "ask"`);
  },
  beforeTurn(a) {
    const m = a.config.managed;
    if (!m) return;
    const agent = a.agent as { setMode?: (x: string) => void; setProfileObject?: (p: ModelProfile) => void };
    // Modes and profiles can be switched at runtime (/mode, /model, VS Code); re-assert the policy.
    const mode = a.mode;
    if (forbiddenModes(m.policy).includes(mode) && agent.setMode) {
      agent.setMode('ask');
      m.violations.push(`runtime switch to permissionMode "${mode}" refused`);
      recordSecurityEvent(a, { type: 'policy_violation', category: 'managed', decision: 'override', by: 'managed', reason: `runtime switch to permissionMode "${mode}" refused` });
      a.notice('warn', `managed policy: permission mode "${mode}" is disabled; switched to "ask"`);
    }
    const lp = m.policy.lockedProfile;
    if (lp && agent.setProfileObject) {
      const p = a.llm.profile as unknown as Record<string, unknown>;
      const drift = Object.entries(lp).filter(([k, val]) => k !== 'name' && JSON.stringify(p[k]) !== JSON.stringify(val));
      if (drift.length) {
        agent.setProfileObject({ ...a.llm.profile, ...lp, name: a.llm.profile.name } as ModelProfile);
        m.violations.push(`runtime profile change of ${drift.map(([k]) => k).join(', ')} refused`);
        recordSecurityEvent(a, { type: 'policy_violation', category: 'managed', decision: 'override', by: 'managed', reason: `runtime profile change of ${drift.map(([k]) => k).join(', ')} refused` });
        a.notice('warn', `managed policy: ${drift.map(([k]) => k).join(', ')} is locked; restored the managed value`);
      }
    }
  },
});

/**
 * N22: what an admin should fix about the managed setup (`tug doctor`). The default high-water mark lives in the user's
 * home, which the user can delete; offline, an older signed policy is then accepted again (bounded by maxStaleSeconds).
 */
export function managedWarnings(cfg: HarnessConfig): string[] {
  const r = cfg.managed?.remote;
  const out: string[] = [];
  if (r && !r.highWaterFile)
    out.push(`remote managed policy ${r.url} has no remote.highWaterFile: the rollback high-water mark is only in the user-writable ~/.tugline/managed-state/. Set remote.highWaterFile in the managed file to a path MDM manages and the user cannot write.`);
  return out;
}

/** For `tug doctor`-style reporting. */
export function describeManaged(cfg: HarnessConfig): string {
  const m = cfg.managed;
  if (!m) return `no managed policy (looked for ${systemManagedPath()} and $TUG_MANAGED_POLICY)`;
  return `managed policy from ${m.sources.join(', ')}: ${Object.keys(m.policy).filter((k) => (m.policy as any)[k] !== undefined).join(', ')}${m.violations.length ? `; overrode: ${m.violations.join('; ')}` : ''}`;
}

