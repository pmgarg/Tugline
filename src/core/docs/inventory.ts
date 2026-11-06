/**
 * WS12: the file inventory every docs feature works from (wiki, docs check,
 * ask, changelog).
 *
 * One rule for what may be read, summarised or cited: tracked or untracked but
 * not git-ignored files (`git ls-files -co --exclude-standard`), minus
 * `.tuglineignore`, minus secret-looking files (the policy's secret-file
 * families), minus build/vendor directories and anything over 256 KB. The
 * wiki never cites a file outside this set (N8 AC4), and citations are only
 * validated against it.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { extractDefsRegex, ignoreMatcher, type Def } from '../context/repomap.js';

export type Lang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'rb' | 'c' | 'php';

export const LANG_BY_EXT: Record<string, Lang> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.pyi': 'py', '.go': 'go', '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.cs': 'java', '.scala': 'java', '.swift': 'java', '.dart': 'java',
  '.rb': 'rb', '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c', '.cxx': 'c', '.php': 'php',
};

const DOC_EXT = new Set(['.md', '.mdx', '.markdown', '.rst', '.txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.next', 'coverage', '.tugline', '.tox', '.mypy_cache']);
export const SECRET_PATH = picomatch(['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/.aws/**', '**/.ssh/**', '**/.gnupg/**', '**/.docker/config.json', '**/.kube/config'], { dot: true, nocase: true });
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 5000;

export interface SourceFile {
  rel: string;
  kind: 'code' | 'doc';
  lang?: Lang;
  hash: string;
  lines: number;
  defs: Def[];
  /** workspace-relative files this one imports (resolved where possible) */
  imports: string[];
}

export interface Inventory {
  workspace: string;
  files: SourceFile[];
  byRel: Map<string, SourceFile>;
  /** HEAD sha (short) when the workspace is a git repo */
  sha?: string;
  read(rel: string): string;
}

export interface InventoryOptions {
  /** extra glob exclusions (wiki.json `exclude`) */
  exclude?: string[];
  /** only these globs (wiki.json `include`) */
  include?: string[];
  /** policy read check: only files readable without asking */
  canRead?: (abs: string) => boolean;
}

function gitFiles(ws: string): string[] | undefined {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ws, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

function walk(ws: string): string[] {
  const out: string[] = [];
  const rec = (dir: string, depth: number) => {
    if (depth > 10 || out.length > MAX_FILES * 2) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(path.join(ws, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) rec(rel, depth + 1);
      } else if (e.isFile()) out.push(rel);
    }
  };
  rec('', 0);
  return out;
}

export function headSha(ws: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ws, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Is this workspace-relative path one the docs features may read and cite? (without listing everything) */
export function readablePath(ws: string, rel: string, o: InventoryOptions = {}): boolean {
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (SECRET_PATH(rel) || rel.split('/').some((p) => SKIP_DIRS.has(p))) return false;
  const ign = ignoreMatcher(readLines(path.join(ws, '.tuglineignore')));
  if (ign(rel)) return false;
  if (o.exclude?.length && picomatch(o.exclude, { dot: true })(rel)) return false;
  return !o.canRead || o.canRead(path.join(ws, rel));
}

function readLines(f: string): string[] {
  try {
    return fs.readFileSync(f, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

const RESOLVE_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js', '.py', '/__init__.py'];

/** Import edges: relative JS/TS imports and Python imports, resolved against the file set. */
export function importsOf(rel: string, lang: Lang | undefined, text: string, all: Set<string>): string[] {
  const out = new Set<string>();
  const dir = path.posix.dirname(rel);
  const tryAdd = (base: string) => {
    const b = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
    for (const ext of RESOLVE_EXT) {
      for (const cand of [base + ext, b + ext]) if (all.has(cand) && cand !== rel) return void out.add(cand);
    }
  };
  if (lang === 'ts') {
    for (const m of text.matchAll(/(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec?.startsWith('.')) tryAdd(path.posix.normalize(path.posix.join(dir, spec)));
    }
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import|^\s*import\s+([\w.]+)/gm)) {
      const dots = m[1] ?? '';
      const mod = (m[2] ?? m[3] ?? '').replace(/\./g, '/');
      if (dots) {
        let base = dir;
        for (let i = 1; i < dots.length; i++) base = path.posix.dirname(base);
        tryAdd(path.posix.normalize(path.posix.join(base, mod || '__init__')));
      } else if (mod) {
        tryAdd(mod);
        tryAdd(path.posix.join(dir, mod));
      }
    }
  }
  return [...out].sort();
}

export function langOf(rel: string): Lang | undefined {
  return LANG_BY_EXT[path.extname(rel).toLowerCase()];
}

/** Build the inventory (code + docs) of a workspace. */
export function buildInventory(workspace: string, o: InventoryOptions = {}): Inventory {
  const ws = path.resolve(workspace);
  const ign = ignoreMatcher(readLines(path.join(ws, '.tuglineignore')));
  const exclude = o.exclude?.length ? picomatch(o.exclude, { dot: true }) : () => false;
  const include = o.include?.length ? picomatch(o.include, { dot: true }) : () => true;
  const rels = (gitFiles(ws) ?? walk(ws))
    .filter((r) => !r.split('/').some((p) => SKIP_DIRS.has(p)))
    .filter((r) => LANG_BY_EXT[path.extname(r).toLowerCase()] || DOC_EXT.has(path.extname(r).toLowerCase()))
    .filter((r) => !SECRET_PATH(r) && !ign(r) && !exclude(r) && include(r) && !/\.min\.js$/.test(r))
    .filter((r) => !o.canRead || o.canRead(path.join(ws, r)))
    .sort()
    .slice(0, MAX_FILES);
  const all = new Set(rels);
  const texts = new Map<string, string>();
  const files: SourceFile[] = [];
  for (const rel of rels) {
    let text: string;
    try {
      const st = fs.statSync(path.join(ws, rel));
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      text = fs.readFileSync(path.join(ws, rel), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    texts.set(rel, text);
    const lang = langOf(rel);
    files.push({
      rel,
      kind: lang ? 'code' : 'doc',
      lang,
      hash: crypto.createHash('sha1').update(text).digest('hex'),
      lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
      defs: lang ? extractDefsRegex(lang, text) : [],
      imports: lang ? importsOf(rel, lang, text, all) : [],
    });
  }
  const byRel = new Map(files.map((f) => [f.rel, f]));
  return {
    workspace: ws,
    files,
    byRel,
    sha: headSha(ws),
    read: (rel) => texts.get(rel) ?? fs.readFileSync(path.join(ws, rel), 'utf8'),
  };
}

/** Lines `from..to` (1-based, inclusive) prefixed with their numbers, for the model. */
export function numbered(text: string, from = 1, to = Number.MAX_SAFE_INTEGER): string {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const end = Math.min(to, lines.length);
  const w = String(end).length;
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= end; i++) out.push(`${String(i).padStart(w)}| ${lines[i - 1]}`);
  return out.join('\n');
}
