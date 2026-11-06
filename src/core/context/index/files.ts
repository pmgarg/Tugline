/**
 * Which workspace files code search (N2) and navigation (N3) may see. Same
 * rules as the D7 repo map: secret-file families never, the root
 * `.tuglineignore`, configured exclusions, the policy's ignore layers
 * (C5 `isHidden`) and the read policy (only reads allowed without asking).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { harnessIgnore, isSecretPath } from '../repomap.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.next', 'coverage', '.tugline', '.tox', '.mypy_cache', '.cache']);

export interface PolicyLike {
  check(i: { tool: string; kind: 'read'; paths: { path: string; write: boolean }[] }): { decision: string };
  isHidden?(abs: string): boolean;
}

export interface VisibilityOptions {
  /** read policy: only reads allowed without asking */
  policy?: PolicyLike;
  /** extra glob exclusions (workspace-relative) */
  exclude?: string[];
  /** tool name for the policy check */
  tool?: string;
}

/** A predicate over absolute paths: may this file's content reach the model / the index? */
export function visibility(workspace: string, opts: VisibilityOptions = {}): (abs: string) => boolean {
  const ws = path.resolve(workspace);
  const ignored = harnessIgnore(ws);
  const excluded = opts.exclude?.length ? picomatch(opts.exclude, { dot: true }) : () => false;
  const cache = new Map<string, boolean>();
  return (abs) => {
    const a = path.resolve(abs);
    let v = cache.get(a);
    if (v !== undefined) return v;
    const rel = path.relative(ws, a).split(path.sep).join('/');
    v = true;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      // outside the workspace: only what the read policy allows (never secret files)
      v = !isSecretPath(a.split(path.sep).join('/'));
    } else if (isSecretPath(rel) || ignored(rel) || excluded(rel) || rel.split('/').some((p) => SKIP_DIRS.has(p))) v = false;
    if (v && opts.policy?.isHidden?.(a)) v = false;
    if (v && opts.policy) v = opts.policy.check({ tool: opts.tool ?? 'code_search', kind: 'read', paths: [{ path: a, write: false }] }).decision === 'allow';
    cache.set(a, v);
    return v;
  };
}

/** Workspace files (git ls-files -co --exclude-standard, else a bounded walk), workspace-relative, sorted. `max` 0 = no limit. */
export function listFiles(workspace: string, opts: { extensions?: Set<string>; max?: number } = {}): string[] {
  const max = opts.max ?? 5000;
  let files: string[] = [];
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: workspace, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
    files = out.split('\n').filter(Boolean);
  } catch {
    const walk = (dir: string, depth: number) => {
      if (depth > 12 || files.length > (max ? max * 2 : 200_000)) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(path.join(workspace, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel, depth + 1);
        } else if (e.isFile()) files.push(rel);
      }
    };
    walk('', 0);
  }
  return files
    .filter((f) => (!opts.extensions || opts.extensions.has(path.extname(f).toLowerCase())) && !f.split('/').some((p) => SKIP_DIRS.has(p)) && !/\.min\.(js|css)$/.test(f))
    .sort()
    .slice(0, max > 0 ? max : undefined);
}
