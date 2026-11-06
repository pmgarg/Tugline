/**
 * Ignore files (SPEC C5): full gitignore semantics for `.gitignore` and
 * `.tuglineignore`.
 *
 * Semantics follow gitignore(5):
 *  - blank lines and `#` comments are skipped; `\#` and `\!` escape a leading # or !;
 *  - trailing spaces are dropped unless escaped with a backslash;
 *  - `!pattern` re-includes a path excluded by an earlier pattern;
 *  - a trailing `/` matches directories only;
 *  - a `/` at the start or in the middle anchors the pattern to the ignore
 *    file's directory, otherwise it matches a name at any depth below it;
 *  - `*`, `?`, `[...]` do not cross `/`; `**` handles leading, trailing and
 *    middle globstars;
 *  - deeper ignore files take precedence over shallower ones (last match wins);
 *  - a path whose parent directory is excluded cannot be re-included.
 *
 * Two independent layers are kept: the git layer (`.git/info/exclude` plus every
 * nested `.gitignore`) and the harness layer (every nested `.tuglineignore`).
 * The harness layer controls what the *agent* may see; the git layer only hides
 * noise. Secret protection stays in the permission policy (authority in code),
 * not in these files (research ED §6.4).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface IgnoreRule {
  /** Original line, for diagnostics */
  source: string;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
  /** Matches a path relative to the ignore file's directory */
  re: RegExp;
}

/** Translate one gitignore glob (no leading `/`, no trailing `/`) to a regex body. */
function globToRegex(glob: string): string {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          if (i + 2 === glob.length) {
            // trailing "/**" (or a bare "**"): everything inside
            re += i === 0 ? '.*' : '.+';
            i += 2;
          } else {
            // "**/": zero or more directories
            re += '(?:[^/]*/)*';
            i += 3;
          }
          continue;
        }
        // "**" glued to other characters behaves like "*"
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > i) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!') || body.startsWith('^')) body = '^' + body.slice(1);
        body = body.replace(/\\/g, '\\\\');
        re += `[${body}]`;
        i = close + 1;
        continue;
      }
      re += '\\[';
      i++;
      continue;
    }
    if (c === '\\' && i + 1 < glob.length) {
      re += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      i += 2;
      continue;
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i++;
  }
  return re;
}

/** Parse one line of an ignore file. Returns undefined for blanks and comments. */
export function parseIgnoreLine(line: string, nocase = false): IgnoreRule | undefined {
  let s = line.replace(/\r$/, '');
  // trailing spaces are ignored unless escaped
  s = s.replace(/(?<!\\)\s+$/, '');
  if (s.endsWith('\\ ')) s = s.slice(0, -2) + ' ';
  if (!s || s.startsWith('#')) return undefined;
  let negate = false;
  if (s.startsWith('!')) {
    negate = true;
    s = s.slice(1);
  } else if (s.startsWith('\\!') || s.startsWith('\\#')) s = s.slice(1);
  if (!s) return undefined;
  let dirOnly = false;
  if (s.endsWith('/') && !s.endsWith('\\/')) {
    dirOnly = true;
    s = s.replace(/\/+$/, '');
  }
  if (!s) return undefined;
  const anchored = s.includes('/');
  if (s.startsWith('/')) s = s.slice(1);
  const body = globToRegex(s);
  const re = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, nocase ? 'i' : '');
  return { source: line, negate, dirOnly, anchored, re };
}

export function parseIgnoreFile(text: string, nocase = false): IgnoreRule[] {
  return text.split('\n').map((l) => parseIgnoreLine(l, nocase)).filter((r): r is IgnoreRule => !!r);
}

/** Rules of one ignore file plus the directory (workspace-relative, '' = root) they apply to. */
export interface RuleSet {
  base: string;
  rules: IgnoreRule[];
}

/**
 * Evaluate rule sets (ordered shallow → deep) against one path.
 * Returns true (ignored), false (explicitly re-included) or undefined (no rule matched).
 */
export function matchRuleSets(sets: RuleSet[], rel: string, isDir: boolean): boolean | undefined {
  let result: boolean | undefined;
  for (const set of sets) {
    let sub: string;
    if (!set.base) sub = rel;
    else if (rel.startsWith(set.base + '/')) sub = rel.slice(set.base.length + 1);
    else continue;
    for (const r of set.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(sub)) result = !r.negate;
    }
  }
  return result;
}

/** Full gitignore evaluation including "a parent directory is excluded" for a relative path. */
export function isIgnoredBy(setsFor: (dirRel: string) => RuleSet[], rel: string, isDir: boolean): boolean {
  const parts = rel.split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    const dir = parts.slice(0, i - 1).join('/');
    const subIsDir = i < parts.length ? true : isDir;
    if (matchRuleSets(setsFor(dir), sub, subIsDir) === true) return true;
  }
  return false;
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

interface CachedFile {
  mtimeMs: number;
  size: number;
  rules: IgnoreRule[];
  checkedAt: number;
}

/**
 * Lazily loads and caches the ignore files of one workspace. Each file is
 * re-validated (stat) at most once per `staleMs`, so filtering thousands of
 * glob results costs one stat per directory, not per file.
 */
export class IgnoreIndex {
  private cache = new Map<string, CachedFile>();
  constructor(readonly root: string, private staleMs = 1000) {}

  private load(file: string): IgnoreRule[] {
    const now = Date.now();
    const c = this.cache.get(file);
    if (c && now - c.checkedAt < this.staleMs) return c.rules;
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(file);
    } catch {
      st = undefined;
    }
    if (!st || !st.isFile()) {
      this.cache.set(file, { mtimeMs: 0, size: -1, rules: [], checkedAt: now });
      return [];
    }
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
      c.checkedAt = now;
      return c.rules;
    }
    let rules: IgnoreRule[] = [];
    try {
      rules = parseIgnoreFile(fs.readFileSync(file, 'utf8'), CASE_INSENSITIVE_FS);
    } catch {
      rules = [];
    }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rules, checkedAt: now });
    return rules;
  }

  /** Rule sets that apply to entries of directory `dirRel` (root first). */
  private sets(fileName: string, dirRel: string, extraRoot?: string): RuleSet[] {
    const out: RuleSet[] = [];
    if (extraRoot) out.push({ base: '', rules: this.load(extraRoot) });
    const parts = dirRel ? dirRel.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      const base = parts.slice(0, i).join('/');
      const rules = this.load(path.join(this.root, base, fileName));
      if (rules.length) out.push({ base, rules });
    }
    return out;
  }

  private relOf(absOrRel: string): string | null {
    const rel = path.isAbsolute(absOrRel) ? path.relative(this.root, absOrRel) : absOrRel;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  private isDir(rel: string): boolean {
    try {
      return fs.statSync(path.join(this.root, rel)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Matched by `.gitignore` files (or `.git/info/exclude`). */
  gitIgnored(absOrRel: string, isDir?: boolean): boolean {
    const rel = this.relOf(absOrRel);
    if (!rel) return false;
    if (rel === '.git' || rel.startsWith('.git/')) return true;
    const exclude = path.join(this.root, '.git', 'info', 'exclude');
    return isIgnoredBy((d) => this.sets('.gitignore', d, exclude), rel, isDir ?? this.isDir(rel));
  }

  /** Matched by `.tuglineignore` files. */
  harnessIgnored(absOrRel: string, isDir?: boolean): boolean {
    const rel = this.relOf(absOrRel);
    if (!rel) return false;
    return isIgnoredBy((d) => this.sets('.tuglineignore', d), rel, isDir ?? this.isDir(rel));
  }

  /**
   * Translate every nested `.tuglineignore` into root-level exclude lines
   * (for the checkpoint shadow repo's info/exclude). Walks at most `maxDirs` dirs.
   */
  harnessPatternsAsRootExcludes(maxDirs = 5000): string[] {
    const out: string[] = [];
    const stack = [''];
    let seen = 0;
    while (stack.length && seen < maxDirs) {
      const dir = stack.pop()!;
      seen++;
      const file = path.join(this.root, dir, '.tuglineignore');
      let text: string | undefined;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        text = undefined;
      }
      if (text !== undefined) out.push(...rebaseIgnoreLines(text, dir));
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(path.join(this.root, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (this.gitIgnored(rel, true)) continue;
        stack.push(rel);
      }
    }
    return out;
  }
}

/** Escape a literal path for use as a gitignore pattern. */
export function escapeIgnorePath(p: string): string {
  return p.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ');
}

/** Rewrite the lines of an ignore file living in `dir` so they mean the same thing from the root. */
export function rebaseIgnoreLines(text: string, dir: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const r = parseIgnoreLine(raw);
    if (!r) continue;
    let s = raw.replace(/\r$/, '').replace(/(?<!\\)\s+$/, '');
    if (r.negate) s = s.slice(1);
    else if (s.startsWith('\\!') || s.startsWith('\\#')) s = s.slice(1);
    if (!dir) {
      out.push((r.negate ? '!' : '') + (s.startsWith('#') || s.startsWith('!') ? '\\' + s : s));
      continue;
    }
    const base = '/' + escapeIgnorePath(dir);
    const trimmed = s.startsWith('/') ? s.slice(1) : s;
    out.push((r.negate ? '!' : '') + (r.anchored ? `${base}/${trimmed}` : `${base}/**/${trimmed}`));
  }
  return out;
}

const indexes = new Map<string, IgnoreIndex>();
/** Shared per-workspace index (cheap to call repeatedly). */
export function ignoreIndexFor(root: string): IgnoreIndex {
  let ix = indexes.get(root);
  if (!ix) {
    ix = new IgnoreIndex(root);
    indexes.set(root, ix);
  }
  return ix;
}
