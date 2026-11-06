/**
 * Skills: behaviour as markdown (EAG S17 §12, Agent Skills open format).
 *
 * A skill is a directory containing SKILL.md:
 *   ---
 *   name: python-bugfix
 *   description: Use when a pytest run fails and code must be fixed ...
 *   ---
 *   <instructions in English>
 *
 * Progressive disclosure, three levels:
 *   1. listing  — name + description, always in the system prompt
 *   2. body     — returned only when the agent calls load_skill(name)
 *   3. files    — extra files in the skill dir, read on demand with read_file
 *
 * One generic class reads every skill. And a skill is INSTRUCTION, NEVER
 * AUTHORITY: this module has no reference to the permission engine, so
 * frontmatter like `allowed-tools` or prose saying "ignore the guard" cannot
 * grant anything (a test asserts this module never imports the policy).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  source: string;
  meta: Record<string, unknown>;
}

export interface AgentDefinition {
  name: string;
  description: string;
  /** Allowed tool names; undefined = default set for the type */
  tools?: string[];
  /** Model profile name */
  profile?: string;
  systemPrompt: string;
  readOnly?: boolean;
  file?: string;
  /** v1.2 N18: the raw frontmatter (disallowedTools, permissionMode, maxTurns are read by the child spawner, narrow-only) */
  meta?: Record<string, unknown>;
}

/** Minimal YAML frontmatter parser (scalars, quoted strings, inline lists, block lists, folded/literal blocks). */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      meta[key] = val.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
      continue;
    }
    if (val === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
      meta[key] = items.length ? items : '';
      continue;
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
      continue;
    }
    if (val === 'true' || val === 'false') {
      meta[key] = val === 'true';
      continue;
    }
    meta[key] = unquote(val);
  }
  return { meta, body: m[2] };
}

function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

export function defaultSkillDirs(workspace: string, bundledDir?: string, extra: string[] = []): { dir: string; source: string }[] {
  const home = os.homedir();
  const dirs = [
    { dir: path.join(workspace, '.tugline', 'skills'), source: 'project' },
    { dir: path.join(workspace, '.claude', 'skills'), source: 'project(.claude)' },
    { dir: path.join(workspace, '.agents', 'skills'), source: 'project(.agents)' },
    // G5: Codex keeps skills in .codex/skills (project) and ~/.codex/skills (user).
    { dir: path.join(workspace, '.codex', 'skills'), source: 'project(.codex)' },
    ...extra.map((d) => ({ dir: path.resolve(workspace, d), source: d.includes(`${path.sep}plugins${path.sep}`) ? 'plugin' : 'config' })),
    { dir: path.join(home, '.tugline', 'skills'), source: 'user' },
    { dir: path.join(home, '.claude', 'skills'), source: 'user(.claude)' },
    { dir: path.join(home, '.codex', 'skills'), source: 'user(.codex)' },
  ];
  if (bundledDir) dirs.push({ dir: bundledDir, source: 'bundled' });
  return dirs;
}

export class SkillManager {
  private skills = new Map<string, Skill>();
  readonly roots: string[] = [];

  constructor(dirs: { dir: string; source: string }[], private disabled: string[] = []) {
    for (const { dir, source } of dirs) this.scan(dir, source);
  }

  private scan(root: string, source: string): void {
    if (!fs.existsSync(root)) return;
    this.roots.push(root);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(root, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      try {
        const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const name = String(meta.name ?? e.name).trim();
        const description = String(meta.description ?? '').trim();
        if (!name || this.skills.has(name) || this.disabled.includes(name)) continue; // first (most specific) wins
        this.skills.set(name, { name, description: description || '(no description)', dir: path.join(root, e.name), file, source, meta });
      } catch {
        /* skip malformed skill */
      }
    }
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name) ?? [...this.skills.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /** Level-1 listing for the system prompt. */
  listing(): string {
    const s = this.list();
    if (!s.length) return '';
    return s.map((k) => `- ${k.name}: ${k.description}`).join('\n');
  }

  /** Level-2: the body plus an index of level-3 files. */
  load(name: string): string | undefined {
    const sk = this.get(name);
    if (!sk) return undefined;
    const { body } = parseFrontmatter(fs.readFileSync(sk.file, 'utf8'));
    const extra: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 2) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (p !== sk.file) extra.push(p);
      }
    };
    walk(sk.dir, 0);
    const files = extra.length ? `\n\n## Files in this skill (read with read_file when the instructions refer to them)\n${extra.slice(0, 50).map((f) => `- ${f}`).join('\n')}` : '';
    return `# Skill: ${sk.name}\n(base directory: ${sk.dir})\n\n${body.trim()}${files}`;
  }
}

/**
 * Agent directories contributed by enabled plugins (SPEC G4). Set by
 * applyPlugins at config load; read here because the agent loads definitions
 * without a config in hand.
 */
let extraAgentDirs: string[] = [];
export function setExtraAgentDirs(dirs: string[]): void {
  extraAgentDirs = [...dirs];
}

/** Custom subagents: .tugline/agents/*.md (and .claude/agents for compatibility), user agents, plugin agents, bundled. */
export function loadAgentDefinitions(workspace: string, bundledDir?: string, extraDirs: string[] = extraAgentDirs): AgentDefinition[] {
  const home = os.homedir();
  const dirs = [path.join(workspace, '.tugline', 'agents'), path.join(workspace, '.claude', 'agents'), path.join(home, '.tugline', 'agents'), path.join(home, '.claude', 'agents'), ...extraDirs, ...(bundledDir ? [bundledDir] : [])];
  const out: AgentDefinition[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.md')) continue;
      const file = path.join(d, f);
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      const name = String(meta.name ?? f.replace(/\.md$/, ''));
      if (seen.has(name)) continue;
      seen.add(name);
      const toolsRaw = meta.tools;
      const tools = Array.isArray(toolsRaw) ? toolsRaw.map(String) : typeof toolsRaw === 'string' && toolsRaw ? toolsRaw.split(',').map((s) => s.trim()) : undefined;
      out.push({ name, description: String(meta.description ?? ''), tools, profile: meta.model ? String(meta.model) : undefined, systemPrompt: body.trim(), readOnly: meta.readOnly === true, file, meta });
    }
  }
  return out;
}
