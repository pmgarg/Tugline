/**
 * N43 inventory row 40 (review finding 5; capability from Qwen Code permission-manager.ts `listRules`,
 * `addPersistentRule`, `removePersistentRule` and its /permissions dialog): list the permission rules with where each
 * comes from, and add or remove allow / ask / deny rules persistently. Works in the CLI, the VS Code chat and
 * `tug serve` (slash-command registry).
 *
 *   /permissions                                   list rules by source, and what auto mode ignores
 *   /permissions add <allow|ask|deny> <rule> [--project]
 *   /permissions remove <allow|ask|deny> <rule> [--project]
 *
 * User scope (~/.tugline/config.json) is the default and touches only the user file. `--project` writes
 * .tugline/config.local.json and only tightens (add ask/deny, remove allow). Managed rules cannot be changed
 * from any surface. After a change the live lists are rebuilt from their sources (re-check C); every change is
 * journaled and recorded as a security event (S8, re-check F); `tug serve` clients cannot change rules (F).
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerSlashCommand, type SlashContext } from '../commands.js';
import { isDangerousAllowRule } from './dangerousRules.js';
import { projectAllowProblem } from './ruleScope.js';
import { projectMayLoosen } from '../config.js';
import { recordSecurityEvent } from '../permissions/audit.js';
import type { AgentApi } from '../agent/extensions.js';

type Kind = 'allow' | 'ask' | 'deny';
const KINDS: Kind[] = ['allow', 'ask', 'deny'];

function readJsonFile(file: string): Record<string, any> {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '')) ?? {};
  } catch (e) {
    throw new Error(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function rulesIn(file: string): Record<Kind, string[]> {
  const j = readJsonFile(file);
  const p = j.permissions ?? {};
  return { allow: Array.isArray(p.allow) ? p.allow : [], ask: Array.isArray(p.ask) ? p.ask : [], deny: Array.isArray(p.deny) ? p.deny : [] };
}

export function userConfigFile(ctx: Pick<SlashContext, 'config'>): string {
  return path.join(ctx.config.homeDir, 'config.json');
}
export function projectConfigFile(workspace: string): string {
  return path.join(workspace, '.tugline', 'config.local.json');
}

/** The rule listing (exported for tests). */
export function listPermissions(ctx: Pick<SlashContext, 'config' | 'workspace' | 'agent'>): string {
  const lines: string[] = [];
  const show = (title: string, r: Partial<Record<Kind, string[]>>, note = '') => {
    const parts = KINDS.filter((k) => r[k]?.length).map((k) => `    ${k}: ${r[k]!.join(', ')}`);
    lines.push(`  ${title}${note}${parts.length ? '' : ': (none)'}`, ...parts);
  };
  const m = ctx.config.managed;
  if (m) show(`managed policy (${m.sources.join(', ')})`, { deny: m.policy.deny ?? [] }, ' [cannot be changed here]');
  show(`user (${userConfigFile(ctx)})`, rulesIn(userConfigFile(ctx)));
  const trusted = ctx.config.trust?.workspaceTrusted !== false;
  for (const f of ['config.json', 'config.local.json']) {
    const file = path.join(ctx.workspace, '.tugline', f);
    if (fs.existsSync(file)) show(`project (${path.relative(ctx.workspace, file)})`, rulesIn(file), trusted ? '' : ' [untrusted workspace: only ask/deny apply]');
  }
  const pol = ctx.agent?.policy;
  if (pol?.sessionRules) show('session ("always allow" answers)', { allow: pol.sessionRules() });
  const ignored: string[] = pol?.suspendedAllowRules?.() ?? [];
  if (ignored.length) lines.push(`  ignored in auto mode (would let code run unchecked): ${ignored.join(', ')}`);
  const dropped = (ctx.config.trust?.ignored ?? []).filter((x) => /permissions\.allow/.test(x));
  if (dropped.length) lines.push(`  refused from project scope: ${dropped.join('; ')}`);
  lines.push(`  mode: ${pol?.mode ?? ctx.config.permissionMode}. Rules apply deny > ask > allow; a hard deny (protected paths, the workspace jail) is never lifted by a rule.`);
  return lines.join('\n');
}

type Rules = Record<Kind, string[]>;
const empty = (): Rules => ({ allow: [], ask: [], deny: [] });
const uniq = (xs: string[]) => [...new Set(xs)];

/** The rules each source provides right now (re-check C: rules carry their source). */
function sources(ctx: Pick<SlashContext, 'config' | 'workspace'>): { managed: Rules; user: Rules; project: Rules } {
  const managed = empty();
  managed.deny = [...(ctx.config.managed?.policy.deny ?? [])];
  const user = rulesIn(userConfigFile(ctx));
  const project = empty();
  const trusted = ctx.config.trust?.workspaceTrusted !== false;
  // N36 SAC1 (merged with WS18): a project's allow rules load only where the user lets that project loosen settings
  const mayLoosen = projectMayLoosen(readJsonFile(userConfigFile(ctx)), ctx.workspace);
  for (const f of ['config.json', 'config.local.json']) {
    const r = rulesIn(path.join(ctx.workspace, '.tugline', f));
    project.ask.push(...r.ask);
    project.deny.push(...r.deny);
    // the same gates as loading: untrusted projects only restrict; S7 project allow rules (unless the user has them)
    if (trusted && mayLoosen) project.allow.push(...r.allow.filter((x) => !projectAllowProblem(x, ctx.workspace) || user.allow.includes(x)));
  }
  return { managed, user, project };
}

/** What the live policy holds that no config file provides (defaults, flags, SDK options, plugins), per policy. */
const bases = new WeakMap<object, Rules>();

/**
 * Re-check C: never edit the merged live lists in place. The live allow/ask/deny lists are rebuilt from their
 * sources after every change: the base captured before the first change, managed policy, the user file and the
 * project files. A rule another source provides stays.
 */
function rebuildLive(ctx: Pick<SlashContext, 'config' | 'workspace' | 'agent'>, base: Rules): void {
  const pol = ctx.agent?.policy;
  if (!pol?.opts) return;
  const s = sources(ctx);
  for (const k of KINDS) pol.opts[k] = uniq([...base[k], ...s.managed[k], ...s.user[k], ...s.project[k]]);
}

function baseFor(ctx: Pick<SlashContext, 'config' | 'workspace' | 'agent'>): Rules | undefined {
  const pol = ctx.agent?.policy;
  if (!pol?.opts) return undefined;
  let b = bases.get(pol);
  if (!b) {
    const s = sources(ctx);
    b = empty();
    for (const k of KINDS) b[k] = (pol.opts[k] ?? []).filter((r: string) => !s.user[k].includes(r) && !s.project[k].includes(r) && !s.managed[k].includes(r));
    bases.set(pol, b);
  }
  return b;
}

/** S8 (re-check F): every change is journaled and goes into the security-event stream (and so the audit export). */
function record(ctx: Pick<SlashContext, 'config' | 'agent' | 'surface'>, op: 'add' | 'remove', kind: Kind, rule: string, scope: string, file: string, outcome: 'applied' | 'refused', why = ''): void {
  const a = ctx.agent;
  try {
    a?.journalWrite?.({ type: 'permission_change', op, kind, rule, scope, file, outcome, ...(why ? { reason: why } : {}), surface: ctx.surface });
  } catch {
    /* never fails the command */
  }
  recordSecurityEvent({ config: ctx.config, sessionId: a?.sessionId ?? 'no-session', runId: undefined, depth: 0, agent: a ?? {} } as unknown as AgentApi, {
    // an `approval`-type event (a decision about what may run without asking), category permission_rule:<scope>:<kind>
    type: 'approval',
    category: `permission_rule:${scope}:${kind}`,
    decision: outcome === 'applied' ? op : 'refused',
    by: 'user',
    reason: `${op} ${kind} rule ${rule} at ${scope} scope (${file})${why ? `: ${why}` : ''}`,
  });
}

/** Add or remove a rule at user or project scope (exported for tests). Returns what to print. */
export function changePermission(ctx: Pick<SlashContext, 'config' | 'workspace' | 'agent'> & { surface?: SlashContext['surface'] }, op: 'add' | 'remove', kind: Kind, rule: string, project: boolean): string {
  const surface = ctx.surface ?? 'cli';
  if (!KINDS.includes(kind)) return `  usage: /permissions ${op} <allow|ask|deny> <rule> [--project]`;
  if (!/^[\w*.-]+(?:\(.*\))?$/s.test(rule)) return `  not a rule: ${rule} (forms: tool, tool(spec), e.g. bash(npm test*), edit_file(src/**), web_fetch(domain:docs.python.org))`;
  const scope = project ? 'project' : 'user';
  const file = project ? projectConfigFile(ctx.workspace) : userConfigFile(ctx);
  const refuse = (why: string) => {
    record({ ...ctx, surface }, op, kind, rule, scope, file, 'refused', why);
    return `  refused: ${why}`;
  };
  // F: a remote client of tug serve may not change persistent rules (config/set has its own allowlist)
  if (surface === 'server') return refuse('permission rules cannot be changed over tug serve; edit the config file or use the CLI or VS Code');
  const s = sources(ctx);
  // C: managed rules are immutable from every surface
  if (s.managed[kind].includes(rule) && op === 'remove') return refuse(`${kind} ${rule} comes from managed policy (${ctx.config.managed?.sources.join(', ')}) and cannot be changed here`);
  if (project) {
    // project rules change only in the tightening direction
    const tightening = (op === 'add' && kind !== 'allow') || (op === 'remove' && kind === 'allow');
    if (!tightening) return refuse(`project rules can only be tightened from here (add ask/deny, remove allow); ${op} ${kind} at project scope would loosen them. Use your user config instead (without --project)`);
  }
  const base = baseFor(ctx); // captured before anything changes
  const j = readJsonFile(file);
  j.permissions = j.permissions ?? {};
  const list: string[] = Array.isArray(j.permissions[kind]) ? j.permissions[kind] : [];
  if (op === 'add') {
    if (list.includes(rule)) return `  already there: ${kind} ${rule} (${file})`;
    list.push(rule);
  } else {
    const i = list.indexOf(rule);
    if (i < 0) {
      if (!project && kind === 'allow' && ctx.agent?.policy?.removeSessionRule?.(rule)) {
        record({ ...ctx, surface }, op, kind, rule, 'session', '(session)', 'applied');
        return `  removed session rule ${rule}`;
      }
      const where = s.project[kind].includes(rule) && !project ? ` (it comes from the project config: /permissions remove ${kind} ${rule} --project${kind === 'allow' ? '' : ', or edit the file'})` : '';
      return `  not found: ${kind} ${rule} in ${file}${where}`;
    }
    list.splice(i, 1);
  }
  j.permissions[kind] = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  if (base) rebuildLive(ctx, base);
  record({ ...ctx, surface }, op, kind, rule, scope, file, 'applied');
  const still = op === 'remove' && [...s.managed[kind], ...(project ? s.user[kind] : s.project[kind]), ...(base?.[kind] ?? [])].includes(rule) ? ' It is still in force from another source (see /permissions).' : '';
  const warn = op === 'add' && kind === 'allow' && isDangerousAllowRule(rule) ? ' Note: auto mode ignores this rule (it would let code run unchecked).' : '';
  const live = !project || ctx.config.trust?.workspaceTrusted !== false;
  return `  ${op === 'add' ? 'added' : 'removed'} ${kind} ${rule} (${file})${live ? '' : ' [applies once the workspace is trusted]'}.${still}${warn}`;
}

registerSlashCommand({
  name: 'permissions',
  description: 'list permission rules by source; add or remove allow/ask/deny rules',
  usage: '[add|remove <allow|ask|deny> <rule> [--project]]',
  run(args, ctx) {
    const t = args.trim();
    if (!t || t === 'list') return void ctx.write(listPermissions(ctx));
    const project = /\s--project\b/.test(` ${t}`);
    const words = t.replace(/\s--project\b/, '').trim();
    const m = words.match(/^(add|remove)\s+(allow|ask|deny)\s+(.+)$/s);
    if (!m) return void ctx.write('  usage: /permissions [add|remove <allow|ask|deny> <rule> [--project]]');
    try {
      ctx.write(changePermission(ctx, m[1] as 'add' | 'remove', m[2] as Kind, m[3]!.trim(), project));
    } catch (e) {
      ctx.write(`  ${(e as Error).message}`);
    }
  },
});
