/**
 * Compatibility imports (SPEC G5): instructions written for other agents work here.
 *
 *  - `.cursor/rules/**\/*.mdc` (frontmatter `description`, `globs`, `alwaysApply`)
 *    and the legacy `.cursorrules` file;
 *  - `.clinerules` (a file, or a directory of .md/.txt rules; `paths`/`globs`
 *    frontmatter makes a rule conditional);
 *  - `GEMINI.md` at the workspace root;
 *  - `.codex/skills` and `~/.codex/skills` (in defaultSkillDirs) and
 *    `.claude/agents` (in loadAgentDefinitions);
 *  - `.claude/commands/*.md` (also `.tugline/commands`, `~/.claude/commands`)
 *    as slash commands, with `$ARGUMENTS` / `$1`…`$9` substitution.
 *
 * Always-on rules go into the system prompt once (byte-stable within a session).
 * Glob-scoped rules are injected only when a matching file enters the context:
 * appended to the result of the tool that read it, or to the prompt that
 * mentioned it. A rule is injected at most once per agent.
 *
 * Like AGENTS.md and skills, these are instructions, never authority: this
 * module has no path to the permission engine. Command files are prompt
 * templates only; Claude Code's "!`cmd`" shell interpolation is NOT executed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { parseFrontmatter } from './manager.js';
import { registerSlashCommand, getSlashCommand, type SlashContext } from '../commands.js';
import { registerAgentExtension, type AgentApi } from '../agent/extensions.js';

export interface ProjectRule {
  /** Workspace-relative source file. */
  source: string;
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
}

function readText(f: string, max = 64_000): string | undefined {
  try {
    const st = fs.statSync(f);
    if (!st.isFile()) return undefined;
    return fs.readFileSync(f, 'utf8').slice(0, max);
  } catch {
    return undefined;
  }
}

function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return [];
}

function walk(dir: string, exts: string[], depth = 3): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...walk(p, exts, depth - 1));
    else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

function ruleFromFile(workspace: string, file: string, defaults: { alwaysApply: boolean }): ProjectRule | undefined {
  const text = readText(file);
  if (text === undefined) return undefined;
  const { meta, body } = parseFrontmatter(text);
  const globs = toList(meta.globs ?? meta.paths);
  const explicitAlways = typeof meta.alwaysApply === 'boolean' ? (meta.alwaysApply as boolean) : undefined;
  return {
    source: path.relative(workspace, file),
    description: meta.description ? String(meta.description) : undefined,
    globs,
    // Cursor: alwaysApply decides; a rule with globs is conditional; Cline: rules without paths always apply.
    alwaysApply: explicitAlways ?? (globs.length ? false : defaults.alwaysApply),
    body: body.trim(),
  };
}

/** Every imported rule for a workspace (Cursor, Cline, Gemini), in a stable order. */
export function loadProjectRules(workspace: string): ProjectRule[] {
  const rules: ProjectRule[] = [];
  const push = (r: ProjectRule | undefined) => r && r.body && rules.push(r);
  for (const f of walk(path.join(workspace, '.cursor', 'rules'), ['.mdc', '.md'])) push(ruleFromFile(workspace, f, { alwaysApply: false }));
  push(ruleFromFile(workspace, path.join(workspace, '.cursorrules'), { alwaysApply: true }));
  const cline = path.join(workspace, '.clinerules');
  try {
    if (fs.statSync(cline).isDirectory()) for (const f of walk(cline, ['.md', '.txt'])) push(ruleFromFile(workspace, f, { alwaysApply: true }));
    else push(ruleFromFile(workspace, cline, { alwaysApply: true }));
  } catch {
    /* none */
  }
  const gemini = readText(path.join(workspace, 'GEMINI.md'));
  if (gemini?.trim()) rules.push({ source: 'GEMINI.md', globs: [], alwaysApply: true, body: gemini.trim() });
  return rules;
}

/** Does a workspace-relative path match any of the rule's globs? (`*.ts` matches at any depth, like Cursor.) */
export function ruleMatches(rule: ProjectRule, relPath: string): boolean {
  const rel = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  if (!rel || rel.startsWith('../')) return false;
  return rule.globs.some((g) => picomatch.isMatch(rel, g.replace(/^\.\//, ''), { dot: true, matchBase: !g.includes('/') }));
}

const RULES_BUDGET = 12_000;

/** System-prompt section for always-on rules plus an index of the conditional ones. */
export function rulesPromptSection(workspace: string, compact = false): string {
  const rules = loadProjectRules(workspace);
  if (!rules.length) return '';
  let budget = compact ? 4000 : RULES_BUDGET;
  const parts: string[] = [];
  for (const r of rules.filter((x) => x.alwaysApply)) {
    let body = r.body;
    if (budget <= 0) break;
    if (body.length > budget) body = body.slice(0, budget) + '\n…[truncated]';
    budget -= body.length;
    parts.push(`## ${r.source}\n${body}`);
  }
  const conditional = rules.filter((x) => !x.alwaysApply);
  const index = conditional.length
    ? `\nScoped rules (shown automatically when you read a matching file; others can be read with read_file when relevant):\n${conditional.map((r) => `- ${r.source}${r.globs.length ? ` (files: ${r.globs.join(', ')})` : ''}${r.description ? `: ${r.description}` : ''}`).join('\n')}`
    : '';
  if (!parts.length && !index) return '';
  return `# Project rules (imported from other agents' rule files)\nFollow these like project instructions.\n${parts.join('\n\n')}${index}`;
}

// ------------------------------------------------------------ scoped-rule activation

const activated = new WeakMap<object, Set<string>>();
const PATH_TOOLS = new Set(['read_file', 'edit_file', 'multi_edit', 'write_file', 'notebook_edit']);

function pathsOfCall(tool: string, args: any, workspace: string): string[] {
  const out: string[] = [];
  if (PATH_TOOLS.has(tool) && typeof args?.path === 'string') out.push(args.path);
  if (tool === 'apply_patch') {
    const text = String(args?.input ?? args?.patch ?? '');
    for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  }
  return out.map((p) => path.relative(workspace, path.resolve(workspace, p)));
}

function inject(a: AgentApi, rels: string[]): string | undefined {
  if (!rels.length) return undefined;
  const rules = loadProjectRules(a.workspace).filter((r) => !r.alwaysApply && r.globs.length);
  if (!rules.length) return undefined;
  const seen = activated.get(a.agent as object) ?? new Set<string>();
  activated.set(a.agent as object, seen);
  const fresh = rules.filter((r) => !seen.has(r.source) && rels.some((p) => ruleMatches(r, p)));
  if (!fresh.length) return undefined;
  for (const r of fresh) seen.add(r.source);
  a.journal({ type: 'rules_activated', rules: fresh.map((r) => r.source), paths: rels });
  return fresh.map((r) => `[project rule ${r.source} applies to ${r.globs.join(', ')}]\n${r.body}`).join('\n\n');
}

/** Path-like tokens in a prompt: @mentions and words that look like files. */
export function mentionedPaths(text: string, workspace: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s(`'"])@?((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z0-9]+)(?::\d+(?:-\d+)?)?/g)) {
    const rel = path.relative(workspace, path.resolve(workspace, m[1]));
    if (!rel.startsWith('..')) out.add(rel);
  }
  for (const m of text.matchAll(/<file path="([^"]+)"/g)) out.add(path.relative(workspace, path.resolve(workspace, m[1])));
  return [...out];
}

registerAgentExtension({
  id: 'ws7-compat-rules',
  afterTool(a, call) {
    if (!call.ok) return;
    return inject(a, pathsOfCall(call.tool, call.args, a.workspace));
  },
  onRunStart(a, prompt) {
    // Files mentioned in the prompt are "in context": attach their rules to the prompt itself.
    const text = inject(a, mentionedPaths(prompt, a.workspace));
    if (!text) return;
    const last = a.messages[a.messages.length - 1];
    if (last?.role !== 'user') return;
    if (typeof last.content === 'string') last.content = `${last.content}\n\n${text}`;
    else if (Array.isArray(last.content)) last.content.push({ type: 'text', text });
  },
});

// ------------------------------------------------------------ markdown commands

export interface MarkdownCommand {
  name: string;
  file: string;
  description: string;
  argumentHint?: string;
  body: string;
}

export function commandDirs(workspace: string): string[] {
  const home = os.homedir();
  return [path.join(workspace, '.tugline', 'commands'), path.join(workspace, '.claude', 'commands'), path.join(home, '.tugline', 'commands'), path.join(home, '.claude', 'commands')];
}

/** `dir/*.md` (subfolders become `ns:name`, as in Claude Code). First definition of a name wins. */
export function loadMarkdownCommands(dirs: string[], prefix = ''): MarkdownCommand[] {
  const out: MarkdownCommand[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const f of walk(d, ['.md'], 2)) {
      const rel = path.relative(d, f).replace(/\.md$/, '').split(path.sep);
      const name = `${prefix}${rel.join(':')}`.replace(/[^\w:.-]/g, '-');
      if (seen.has(name)) continue;
      const text = readText(f);
      if (text === undefined) continue;
      const { meta, body } = parseFrontmatter(text);
      seen.add(name);
      out.push({ name, file: f, description: String(meta.description ?? body.trim().split('\n')[0] ?? '').slice(0, 120) || `command from ${path.basename(f)}`, argumentHint: meta['argument-hint'] ? String(meta['argument-hint']) : undefined, body: body.trim() });
    }
  }
  return out;
}

/** Fill a command template: $ARGUMENTS, $1…$9; if it has no placeholder, arguments are appended. */
export function expandCommand(body: string, args: string): string {
  const argv = args.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? [];
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(body);
  let out = body.replace(/\$ARGUMENTS/g, args.trim()).replace(/\$([1-9])/g, (_m, n: string) => argv[Number(n) - 1] ?? '');
  if (!hasPlaceholder && args.trim()) out += `\n\n${args.trim()}`;
  return out;
}

const registeredCommands = new Map<string, MarkdownCommand['file']>();

/**
 * Register markdown commands as slash commands. The registry is process-wide,
 * so the command re-resolves its file for the session's workspace at run time.
 * Built-in and other registered commands keep precedence.
 */
export function registerMarkdownCommands(cmds: MarkdownCommand[], resolve: (name: string, workspace: string, config: SlashContext['config']) => MarkdownCommand | undefined): string[] {
  const added: string[] = [];
  for (const c of cmds) {
    if (registeredCommands.has(c.name)) continue;
    if (getSlashCommand(c.name)) continue;
    registeredCommands.set(c.name, c.file);
    registerSlashCommand({
      name: c.name,
      description: c.description,
      usage: c.argumentHint,
      run(args, ctx) {
        const cur = resolve(c.name, ctx.workspace, ctx.config);
        if (!cur) return void ctx.write(`  /${c.name} is not defined for this workspace`);
        return { prompt: expandCommand(cur.body, args) };
      },
    });
    added.push(c.name);
  }
  return added;
}

/** Register the workspace's (and user's) markdown commands. Called when an agent's tools are built. */
export function registerWorkspaceCommands(workspace: string): string[] {
  return registerMarkdownCommands(loadMarkdownCommands(commandDirs(workspace)), (name, ws) => loadMarkdownCommands(commandDirs(ws)).find((x) => x.name === name));
}
