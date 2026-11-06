/**
 * v1.2 N49 (review F13, Qwen `qwen memory import codex`): `tug memory` lists the durable memory records and imports
 * notes from another agent's memory folder.
 *
 *   tug memory list [--scope user|project]
 *   tug memory import codex [--source <dir>] [--scope user|project] [--select 1,3,…|all] [--json]
 *
 * Without `--select` the import is a preview (numbered items, nothing written). Only the items the user selects
 * become records, through the same `addMemory` as the remember tool: one line each, secrets refused, 500 characters
 * at most, older records with the same key superseded. Memory enters the system prompt, so nothing is imported
 * without that explicit selection. Qwen consolidates the selection with a model call; here each item is kept as written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerCliCommand } from '../core/commands.js';
import { addMemory, deriveKey, memoryFile, parseMemoryLine, type MemoryScope } from '../core/memory/memory.js';

export interface ImportItem {
  n: number;
  file: string;
  section: string;
  text: string;
}

/** Items in a Codex memories folder (MEMORY.md, memory_summary.md, other .md files): bullet lines and paragraphs, with their section. */
export function codexItems(dir: string): ImportItem[] {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
  if (!files.some((f) => f === 'MEMORY.md' || f === 'memory_summary.md')) throw new Error(`${dir} is not a Codex memories folder (no MEMORY.md or memory_summary.md); give it with --source`);
  const out: ImportItem[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (text.length > 1_000_000) continue;
    let section = '';
    let para: string[] = [];
    const flush = () => {
      const t = para.join(' ').replace(/\s+/g, ' ').trim();
      if (t) out.push({ n: out.length + 1, file: f, section, text: t });
      para = [];
    };
    for (const line of text.split('\n')) {
      const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        flush();
        section = h[1]!;
      } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        flush();
        para = [line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')];
        flush();
      } else if (!line.trim()) flush();
      else para.push(line.trim());
    }
    flush();
  }
  return out;
}

export function parseSelection(sel: string, max: number): number[] {
  if (sel === 'all') return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of sel.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`--select takes numbers and ranges (1,3,5-7) or "all"; got "${part}"`);
    for (let i = Number(m[1]); i <= Number(m[2] ?? m[1]); i++) if (i >= 1 && i <= max) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

registerCliCommand({
  name: 'memory',
  description: 'durable memory: list records, import notes from another agent (Codex) by explicit selection',
  usage: 'list [--scope user|project] | import codex [--source dir] [--scope user|project] [--select 1,3|all] [--json]',
  needsModel: false,
  run(argv, ctx) {
    const flag = (k: string) => {
      const i = argv.indexOf(`--${k}`);
      return i >= 0 ? argv[i + 1] : undefined;
    };
    const scope = (flag('scope') ?? 'user') as MemoryScope;
    if (scope !== 'user' && scope !== 'project') throw new Error('--scope must be user or project');
    const file = memoryFile(scope, ctx.workspace, ctx.config.homeDir);
    const [sub, from] = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]!.startsWith('--')));
    if (!sub || sub === 'list') {
      const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map(parseMemoryLine).filter((p) => p && !p.superseded) : [];
      ctx.write(lines.length ? `${file}\n${lines.map((p) => `  [${p!.kind}] ${p!.key}: ${p!.text}`).join('\n')}` : `no ${scope} memory records (${file})`);
      return 0;
    }
    if (sub === 'import') {
      if (from !== 'codex') throw new Error('usage: tug memory import codex [--source dir] [--select 1,3|all]');
      const dir = path.resolve(flag('source') ?? path.join(os.homedir(), '.codex', 'memories'));
      const items = codexItems(dir);
      const sel = flag('select');
      if (!sel) {
        if (argv.includes('--json')) ctx.write(JSON.stringify(items, null, 2));
        else ctx.write(`${items.length} item(s) in ${dir} (preview; nothing is written):\n${items.map((it) => `  ${it.n}. [${it.file}${it.section ? ` › ${it.section}` : ''}] ${it.text.slice(0, 160)}`).join('\n')}\nImport with --select 1,3,5-7 (or all) into the ${scope} memory (${file}).`);
        return 0;
      }
      const chosen = parseSelection(sel, items.length).map((n) => items[n - 1]!);
      const done: string[] = [];
      const refused: string[] = [];
      for (const it of chosen) {
        try {
          const r = addMemory(file, { kind: 'fact', key: deriveKey(it.text, it.section ? `${it.section} ${it.n}` : undefined), text: it.text.slice(0, 500) });
          done.push(r.line);
        } catch (e) {
          refused.push(`${it.n}: ${(e as Error).message}`);
        }
      }
      ctx.write(`imported ${done.length} item(s) into ${file}${refused.length ? `\nnot imported:\n  ${refused.join('\n  ')}` : ''}`);
      return refused.length ? 1 : 0;
    }
    ctx.write('usage: tug memory list | tug memory import codex [--source dir] [--select …]');
    return 2;
  },
});
