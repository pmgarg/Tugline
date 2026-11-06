/**
 * Navigation without a language server (N3 fallback): definitions and
 * references by NAME, using the D7 definition extractor (tree-sitter when
 * installed, regexes otherwise) plus scope heuristics:
 *
 *  - a file that defines a name at top level uses its own definition (shadowing);
 *  - a module-private definition (not exported / `_name` / lower-case Go) is
 *    only referenced from its own file;
 *  - an exported definition is referenced from files of the same language
 *    family that import it (an import / from / use / require line names it, or
 *    for Go, the same package directory; Java, the same package or an import);
 *  - a method is referenced only through qualified uses (`.name`, `::name`), in
 *    files that mention its class;
 *  - comments and strings never count.
 *
 * It is a heuristic and says so in the tool output; precise results come from
 * the editor (host.navigate) or a configured language server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defsForFile, langOf, visibleNames, type Def, type Lang } from '../context/repomap.js';
import { listFiles } from '../context/index/files.js';
import type { NavLocation } from '../host/workspace.js';

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.scala', '.swift', '.dart', '.rb', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.php']);
const MAX_BYTES = 512 * 1024;

export interface FileSyms {
  rel: string;
  abs: string;
  lang: Lang;
  text: string;
  lines: string[];
  /** comments and strings blanked, same offsets and line breaks */
  code: string[];
  defs: Def[];
  visible: Set<string> | null;
  mtimeMs: number;
  size: number;
}

const cache = new Map<string, Map<string, FileSyms>>();

export function clearNavCache(): void {
  cache.clear();
}

/** Blank comments and string literals, keeping every offset and newline (unlike repomap.codeOnly). */
export function maskNonCode(text: string, lang: Lang): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  // one pass, leftmost match wins, so `//` inside a string and quotes inside comments are handled
  const parts = [String.raw`\/\*[\s\S]*?\*\/`, lang === 'py' ? String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''` : '', String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`, lang === 'ts' ? String.raw`\x60(?:[^\x60\\]|\\[\s\S])*\x60` : '', lang === 'py' || lang === 'rb' ? '#.*' : String.raw`\/\/.*`].filter(Boolean);
  return text.replace(new RegExp(parts.join('|'), 'g'), (m) => {
    if (lang === 'rs' && /^'/.test(m) && m.length > 3 && !m.endsWith("'")) return m; // lifetimes
    return blank(m);
  });
}

async function load(workspace: string, rel: string): Promise<FileSyms | undefined> {
  const lang = langOf(rel);
  if (!lang) return undefined;
  const abs = path.join(workspace, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return undefined;
  }
  if (!st.isFile() || st.size > MAX_BYTES) return undefined;
  let byRel = cache.get(workspace);
  if (!byRel) cache.set(workspace, (byRel = new Map()));
  const hit = byRel.get(rel);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
  const { defs } = await defsForFile(rel, text);
  const info: FileSyms = { rel, abs, lang, text, lines: text.split('\n'), code: maskNonCode(text, lang).split('\n'), defs, visible: visibleNames(lang, text, defs), mtimeMs: st.mtimeMs, size: st.size };
  byRel.set(rel, info);
  return info;
}

/** All visible source files of the workspace with their definitions. */
export async function symbolTable(workspace: string, visible: (abs: string) => boolean, max = 20_000): Promise<FileSyms[]> {
  const out: FileSyms[] = [];
  for (const rel of listFiles(workspace, { extensions: CODE_EXT, max })) {
    const abs = path.join(workspace, rel);
    if (!visible(abs)) continue;
    const f = await load(workspace, rel);
    if (f) out.push(f);
  }
  return out;
}

export async function fileSymbols(workspace: string, abs: string): Promise<FileSyms | undefined> {
  return load(workspace, path.relative(workspace, abs).split(path.sep).join('/'));
}

const IDENT_CHAR = /[\w$]/;

/** The identifier at (line, col) (1-based), or the first identifier of the line when col is missing. */
export function identifierAt(lineText: string, col?: number): string | undefined {
  if (col === undefined) return /[A-Za-z_$][\w$]*/.exec(lineText.replace(/^\s*(?:export\s+|public\s+|private\s+|async\s+|def\s+|func\s+|fn\s+|class\s+|function\s+|const\s+|let\s+|var\s+)*/, ''))?.[0];
  let i = Math.max(0, Math.min(lineText.length - 1, col - 1));
  if (!IDENT_CHAR.test(lineText[i] ?? '') && IDENT_CHAR.test(lineText[i - 1] ?? '')) i--;
  if (!IDENT_CHAR.test(lineText[i] ?? '')) return undefined;
  let s = i;
  let e = i;
  while (s > 0 && IDENT_CHAR.test(lineText[s - 1])) s--;
  while (e < lineText.length - 1 && IDENT_CHAR.test(lineText[e + 1])) e++;
  const w = lineText.slice(s, e + 1);
  return /^[A-Za-z_$]/.test(w) ? w : undefined;
}

const FAMILY: Record<Lang, string> = { ts: 'ts', py: 'py', go: 'go', rs: 'rs', java: 'java', rb: 'rb', c: 'c', php: 'php' };

function nameRe(name: string, qualified = false): RegExp {
  const n = name.replace(/[$]/g, '\\$');
  return qualified ? new RegExp(`(?:\\.|::)\\s*(${n})(?![\\w$])`, 'g') : new RegExp(`(?<![\\w$])(${n})(?![\\w$])`, 'g');
}

/** Does `f` import `name` (or, for Go/Java, share the package with `from`)? */
function imports(f: FileSyms, name: string, from: FileSyms): boolean {
  if (f.lang === 'go') return path.posix.dirname(f.rel) === path.posix.dirname(from.rel) || f.code.some((l) => /^\s*(import|")/.test(l) && l.includes(path.posix.basename(path.posix.dirname(from.rel))));
  if (f.lang === 'java') {
    const pkg = /^\s*package\s+([\w.]+)/m.exec(from.text)?.[1];
    if (pkg && new RegExp(`^\\s*package\\s+${pkg.replace(/\./g, '\\.')}\\s*;`, 'm').test(f.text)) return true;
  }
  const re = nameRe(name);
  const base = path.posix.basename(from.rel).replace(/\.[^.]+$/, '');
  return f.lines.some((l, i) => /^\s*(import|from|use|require|export\s+(\*|\{)|const\s.*=\s*require\()|\brequire\(/.test(l) && ((re.lastIndex = 0), re.test(f.code[i]) || l.includes(base)));
}

export interface ResolvedDef {
  file: FileSyms;
  def: Def;
}

const isTop = (d: Def) => !d.parent;

/**
 * Definitions of `name`, best first: the requesting file's own, then those it
 * imports, then exported ones of the same language family, then the rest.
 */
export function rankDefinitions(table: FileSyms[], name: string, from?: FileSyms, qualified?: boolean): ResolvedDef[] {
  const all: ResolvedDef[] = [];
  for (const f of table) for (const d of f.defs) if (d.name === name) all.push({ file: f, def: d });
  const score = (r: ResolvedDef) => {
    let s = 0;
    if (from) {
      if (r.file.rel === from.rel) s += 100;
      if (FAMILY[r.file.lang] === FAMILY[from.lang]) s += 20;
      else s -= 50;
      if (r.file.rel !== from.rel && imports(from, name, r.file)) s += 40;
    }
    if (r.file.visible === null || r.file.visible.has(name)) s += 10;
    if (qualified !== undefined) s += (qualified ? !isTop(r.def) : isTop(r.def)) ? 15 : -5;
    if (/(^|\/)(test|tests|__tests__)\/|\.test\.|_test\./.test(r.file.rel)) s -= 8;
    return s;
  };
  return all.map((r) => ({ r, s: score(r) })).sort((a, b) => b.s - a.s || a.r.file.rel.localeCompare(b.r.file.rel) || a.r.def.line - b.r.def.line).map((x) => x.r);
}

/** Is the use at `line` of `f` qualified (`obj.name`, `Type::name`)? */
export function usedQualified(f: FileSyms, line: number, name: string): boolean {
  const l = f.code[line - 1] ?? '';
  return nameRe(name, true).test(l);
}

/**
 * References to the definition `target` (the declaration included), following
 * the scope rules in the header. Returns 1-based locations.
 */
export function findReferences(table: FileSyms[], target: ResolvedDef): NavLocation[] {
  const { file: home, def } = target;
  const name = def.name;
  const method = !!def.parent;
  const exported = method ? home.visible === null || home.visible.has(name) || home.lang === 'java' : home.visible === null || home.visible.has(name);
  const out: NavLocation[] = [];
  const scanFile = (f: FileSyms, qualifiedOnly: boolean) => {
    for (let i = 0; i < f.code.length; i++) {
      const line = f.code[i];
      if (!line.includes(name)) continue;
      const re = nameRe(name, qualifiedOnly);
      for (const m of line.matchAll(re)) {
        const col = (m.index ?? 0) + m[0].length - name.length + 1;
        out.push({ path: f.abs, line: i + 1, col });
      }
    }
  };
  for (const f of table) {
    if (FAMILY[f.lang] !== FAMILY[home.lang]) continue;
    if (f.rel === home.rel) {
      // own file: every use; for a method also the unqualified declaration line
      if (method) {
        scanFile(f, true);
        if (!out.some((o) => o.path === f.abs && o.line === def.line)) {
          const c = (f.code[def.line - 1] ?? '').search(nameRe(name));
          out.push({ path: f.abs, line: def.line, col: c >= 0 ? c + 1 : 1 });
        }
      } else scanFile(f, false);
      continue;
    }
    if (!exported) continue;
    if (method) {
      if (def.parent && !nameRe(def.parent).test(f.code.join('\n')) && f.lang !== 'py') continue;
      scanFile(f, true);
      continue;
    }
    // shadowed: the file defines its own top-level `name`
    if (f.defs.some((d) => d.name === name && isTop(d))) continue;
    if (!imports(f, name, home)) continue;
    scanFile(f, false);
  }
  return out.sort((a, b) => (a.path === home.abs ? -1 : 0) - (b.path === home.abs ? -1 : 0) || a.path.localeCompare(b.path) || a.line - b.line || a.col - b.col);
}

/** Workspace symbols by fuzzy name: exact, then prefix, then substring, then camel humps. */
export function searchSymbols(table: FileSyms[], query: string, limit = 50): ResolvedDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const humps = (n: string) => n.replace(/[a-z0-9_$]+/g, (m, off) => (off === 0 ? m[0] : '')).toLowerCase();
  const scored: { r: ResolvedDef; s: number }[] = [];
  for (const f of table)
    for (const d of f.defs) {
      const n = d.name.toLowerCase();
      const s = n === q ? 4 : n.startsWith(q) ? 3 : n.includes(q) ? 2 : humps(d.name).startsWith(q) ? 1 : 0;
      if (s) scored.push({ r: { file: f, def: d }, s: s * 10 + (f.visible === null || f.visible.has(d.name) ? 1 : 0) });
    }
  return scored.sort((a, b) => b.s - a.s || a.r.def.name.length - b.r.def.name.length || a.r.file.rel.localeCompare(b.r.file.rel)).slice(0, limit).map((x) => x.r);
}
