/**
 * Output styles (SPEC G7): `outputStyle: default | concise | explanatory | custom:<name|file>`.
 * The style is a section appended to the system prompt. It is part of the
 * config, so it is fixed for a run (the prompt stays byte-stable); `/output-style`
 * switches it from the next prompt on.
 *
 * Custom styles are markdown files (frontmatter optional, as in Claude Code):
 * `custom:<path>` (absolute, or relative to the workspace) or `custom:<name>`,
 * looked up in .tugline/output-styles, .claude/output-styles and the same
 * folders under the home directory. Only .md/.txt files are read: the style is
 * sent to the model endpoint, so it must not become a way to ship other files.
 * Untrusted project config cannot set outputStyle (loadConfig drops unknown keys).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './manager.js';
import { registerSlashCommand } from '../commands.js';
import type { HarnessConfig } from '../config.js';

declare module '../config.js' {
  interface HarnessConfigExtensions {
    /** SPEC G7: default | concise | explanatory | custom:<name|file>. Default "default". */
    outputStyle?: string;
  }
}

export const BUILTIN_STYLES: Record<string, string> = {
  default: '',
  concise: `# Output style: concise
- Keep every reply as short as the task allows: lead with the result, no preamble, no recap of what the user said.
- Prefer a few bullet points over paragraphs. Show code only when the user needs to see it.
- Final reports: one line per change (file and what changed), then how it was verified.`,
  explanatory: `# Output style: explanatory
- While you work, briefly explain why you choose each step and what you learn about the codebase.
- After significant changes, add a short "Insight" note: the design pattern, trade-off or convention involved, so the user learns the codebase.
- Keep explanations factual and specific to this code; do not pad.`,
};

const MAX_STYLE_CHARS = 8000;

function styleDirs(workspace: string, homeDir?: string): string[] {
  const home = os.homedir();
  return [
    path.join(workspace, '.tugline', 'output-styles'),
    path.join(workspace, '.claude', 'output-styles'),
    path.join(homeDir ?? path.join(home, '.tugline'), 'output-styles'),
    path.join(home, '.claude', 'output-styles'),
  ];
}

/** Resolve a custom style to its file, or explain why not. */
export function resolveCustomStyle(spec: string, workspace: string, homeDir?: string): { file?: string; error?: string } {
  const raw = spec.replace(/^~(?=\/|\\|$)/, os.homedir());
  const candidates = /[\\/]|\.(md|txt)$/i.test(raw) ? [path.resolve(workspace, raw)] : styleDirs(workspace, homeDir).flatMap((d) => [path.join(d, `${raw}.md`), path.join(d, raw, 'STYLE.md')]);
  for (const f of candidates) {
    if (!/\.(md|txt)$/i.test(f)) return { error: `custom output styles must be .md or .txt files (${f})` };
    try {
      if (fs.statSync(f).isFile()) return { file: f };
    } catch {
      /* next */
    }
  }
  return { error: `output style "${spec}" not found (looked in ${candidates.join(', ')})` };
}

/** The system-prompt section for the configured style ('' for default). */
export function outputStyleSection(cfg: Pick<HarnessConfig, 'outputStyle' | 'homeDir'>, workspace: string): string {
  const spec = (cfg.outputStyle ?? 'default').trim();
  if (spec in BUILTIN_STYLES) return BUILTIN_STYLES[spec];
  if (!spec.startsWith('custom:')) return '';
  const r = resolveCustomStyle(spec.slice(7).trim(), workspace, cfg.homeDir);
  if (!r.file) return '';
  const { meta, body } = parseFrontmatter(fs.readFileSync(r.file, 'utf8'));
  const text = body.trim().slice(0, MAX_STYLE_CHARS);
  if (!text) return '';
  return `# Output style: ${String(meta.name ?? path.basename(r.file, path.extname(r.file)))}\n${text}`;
}

registerSlashCommand({
  name: 'output-style',
  description: 'show or set the output style (default, concise, explanatory, custom:<name|file>)',
  usage: '[style]',
  run(args, ctx) {
    const want = args.trim();
    if (!want) return void ctx.write(`  output style: ${ctx.config.outputStyle ?? 'default'}  (default | concise | explanatory | custom:<name|file>)`);
    if (!(want in BUILTIN_STYLES)) {
      if (!want.startsWith('custom:')) return void ctx.write(`  unknown style "${want}"`);
      const r = resolveCustomStyle(want.slice(7).trim(), ctx.workspace, ctx.config.homeDir);
      if (!r.file) return void ctx.write(`  ${r.error}`);
    }
    ctx.config.outputStyle = want;
    ctx.write(`  output style set to ${want} (applies from the next prompt)`);
  },
});
