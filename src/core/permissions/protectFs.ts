/**
 * R1: protected paths hold for shell writes too (file-system side).
 *
 * The protected set is `permissions.protectedPaths` plus the agent-control files
 * (AGENT_CONTROL_FILES). Four layers use it:
 *   1. static   policy.ts asks shellWrites.ts for the command's write targets
 *               and hard-denies a protected or agent-control target;
 *   2. dynamic  this module fingerprints the set before every shell command and
 *               compares after it (and while background jobs run). Any change is
 *               restored from a pre-command copy, recorded as a refusal and
 *               returned to the model as an error (fail closed: the parse in 1
 *               cannot see into `python -c` or scripts);
 *   3. sandbox  sandbox/index.ts mounts `readOnlyRoots()` read-only (bwrap
 *               --ro-bind, Seatbelt deny file-write*);
 *   4. judges   eval runners call `restorePristine()` so acceptance commands see
 *               the task's own test files, not the agent's.
 *
 * Git's own state under `.git/` (objects, refs, index, logs, HEAD …) is changed
 * by every `git commit` and is not guarded here; `.git/hooks/**` and
 * `.git/config` (code that runs later) are. File tools still refuse all of `.git/**`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

/** `.git/` paths the guard watches; everything else under `.git/` is git's own bookkeeping. */
const GIT_GUARDED = /^\.git(?:$|\/hooks(?:\/|$)|\/config$|\/info\/attributes$|\/modules\/(?:.+\/)?(?:config|hooks(?:\/.*)?|info\/attributes)$)/;
/** Inside `.git/modules/<name>/…` only these are walked (objects, refs and logs are git's own state). */
const GIT_MODULE_SKIP = new Set(['objects', 'refs', 'logs', 'lfs', 'index', 'packed-refs', 'FETCH_HEAD', 'ORIG_HEAD', 'HEAD', 'COMMIT_EDITMSG', 'description']);
/** Paths under the protected set the harness itself writes (never through the model's shell). */
const HARNESS_OWNED = /^\.tugline\/(?:artifacts|tmp|cache|runs|checks|bench|wiki|wiki\.json|jobs|recordings|browser-profiles|capabilities\.json|STOP)(?:\/|$)/;
/** Directories a `**`-rooted pattern does not descend into (huge, regenerated, never the judge). */
const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', '.next', '.turbo', '.cache', '.gradle', 'target']);
export const MAX_ENTRIES = 20_000;
const HASH_LIMIT = 1 << 20;

export interface ProtectedSet {
  patterns: string[];
  match: (rel: string) => boolean;
  /** Static directory prefixes the patterns live under ('' = the whole workspace). */
  bases: string[];
  /** Bases walked for `**`-rooted patterns, which skip SKIP_DIRS (node_modules …). */
  wild?: Set<string>;
}

export function guardedRel(rel: string): boolean {
  if (rel === '.git' || rel.startsWith('.git/')) return GIT_GUARDED.test(rel);
  return !HARNESS_OWNED.test(rel);
}

/** Compile glob patterns (workspace-relative) into the guarded set. Callers add AGENT_CONTROL_FILES when wanted. */
export function protectedSet(globs: string[]): ProtectedSet {
  const patterns = [...new Set(globs)];
  const m = picomatch(patterns, { dot: true, nocase: true });
  const bases = [...new Set(patterns.map((p) => picomatch.scan(p).base.replace(/^\.\//, '').replace(/\/$/, '')))];
  // A base that lies under another base is covered by the walk of the outer one.
  const outer = bases.filter((b) => !bases.some((o) => o !== b && (o === '' || b.startsWith(o + '/'))));
  return { patterns, match: (rel) => guardedRel(rel) && m(rel), bases: outer, wild: new Set(outer.includes('') ? [''] : []) };
}

export interface ProtectedEntry {
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtimeMs: number;
  mode: number;
  /** inode and change time: neither can be set from user space, so a same-size write with a reset mtime is still seen */
  ino?: number;
  ctimeMs?: number;
  hash?: string;
  link?: string;
}
export type ProtectedFingerprint = Map<string, ProtectedEntry>;

const hashCache = new Map<string, { key: string; hash: string }>();

function entryOf(abs: string, st: fs.Stats, hash = true): ProtectedEntry {
  const type = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
  const e: ProtectedEntry = { type, size: type === 'dir' ? 0 : st.size, mtimeMs: type === 'dir' ? 0 : Math.round(st.mtimeMs), mode: st.mode, ...(type === 'file' ? { ino: st.ino, ctimeMs: Math.round(st.ctimeMs) } : {}) };
  if (type === 'link') {
    try {
      e.link = fs.readlinkSync(abs);
    } catch {
      /* gone */
    }
  } else if (hash && type === 'file' && st.size <= HASH_LIMIT) {
    // re-hash only when the stat changed (the guard fingerprints after every tool call)
    const key = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const c = hashCache.get(abs);
    if (c?.key === key) e.hash = c.hash;
    else
      try {
        e.hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        hashCache.set(abs, { key, hash: e.hash });
        if (hashCache.size > 100_000) hashCache.clear();
      } catch {
        /* unreadable: size+mtime only */
      }
  }
  return e;
}

/**
 * Every existing path in the protected set, plus the directories that lead to
 * them (so replacing a parent with a file or a symlink is seen). Symlinks are
 * recorded, never followed.
 */
export function fingerprintProtected(workspace: string, set: ProtectedSet, maxEntries = MAX_ENTRIES, hash = true): { fp: ProtectedFingerprint; truncated: boolean } {
  const fp: ProtectedFingerprint = new Map();
  let count = 0;
  let truncated = false;
  const visit = (rel: string, wildRoot: boolean) => {
    if (count++ > maxEntries) {
      truncated = true;
      return;
    }
    const abs = path.join(workspace, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    const hit = rel !== '' && set.match(rel);
    if (hit) fp.set(rel, entryOf(abs, st, hash));
    if (!st.isDirectory()) return;
    if (rel === '.git') {
      // only code that runs later is guarded inside .git (objects, refs, index … are git's own state):
      // config, hooks, info/attributes (filters), and the same for every submodule under .git/modules
      for (const r of ['.git/config', '.git/hooks', '.git/info/attributes', '.git/modules']) visit(r, false);
      return;
    }
    if (rel.startsWith('.git/modules/') && !/\/hooks(?:\/|$)/.test(rel)) {
      // inside a submodule's git dir: descend, skipping git's own state
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs);
      } catch {
        return;
      }
      for (const n of names) if (!GIT_MODULE_SKIP.has(n)) visit(`${rel}/${n}`, false);
      return;
    }
    if (wildRoot && SKIP_DIRS.has(path.basename(rel)) && !hit) return;
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names) visit(rel ? `${rel}/${n}` : n, wildRoot);
  };
  for (const b of set.bases) {
    // The directories on the way to a base are part of the set: `mv tests x` changes `tests`.
    if (b) {
      const parts = b.split('/');
      for (let i = 1; i < parts.length; i++) {
        const rel = parts.slice(0, i).join('/');
        try {
          const st = fs.lstatSync(path.join(workspace, rel));
          if (!st.isDirectory() || st.isSymbolicLink()) fp.set(rel, entryOf(path.join(workspace, rel), st));
        } catch {
          /* missing parents show up as missing children */
        }
      }
    }
    visit(b, b === '' || !!set.wild?.has(b));
  }
  return { fp, truncated };
}

function same(a: ProtectedEntry, b: ProtectedEntry): boolean {
  if (a.type !== b.type || a.link !== b.link || (a.mode & 0o7777) !== (b.mode & 0o7777)) return false;
  if (a.type !== 'file') return true;
  if (a.ino !== b.ino || a.ctimeMs !== b.ctimeMs) return false;
  if (a.hash && b.hash) return a.hash === b.hash && a.size === b.size;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export interface ProtectedChange {
  rel: string;
  kind: 'modified' | 'deleted' | 'created' | 'replaced';
}

export function diffProtected(before: ProtectedFingerprint, after: ProtectedFingerprint): ProtectedChange[] {
  const out: ProtectedChange[] = [];
  for (const [rel, b] of before) {
    const a = after.get(rel);
    if (!a) out.push({ rel, kind: 'deleted' });
    else if (a.type !== b.type) out.push({ rel, kind: 'replaced' });
    else if (!same(a, b)) out.push({ rel, kind: 'modified' });
  }
  for (const rel of after.keys()) if (!before.has(rel)) out.push({ rel, kind: 'created' });
  return out.sort((x, y) => x.rel.localeCompare(y.rel));
}

/** Pre-command copies of protected files, keyed by content, so a violation can be undone. */
export class ProtectedContentStore {
  readonly dir: string;
  private have = new Map<string, string>();
  bytes = 0;
  constructor(readonly maxBytes = 512 * 1024 * 1024) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-protect-'));
  }
  private key(rel: string, e: ProtectedEntry): string {
    return crypto.createHash('sha1').update(`${rel}\0${e.hash ?? `${e.size}:${e.mtimeMs}`}`).digest('hex');
  }
  /** Copy every file of `fp` not stored yet. Returns the paths that could not be stored (over the size cap). */
  ensure(workspace: string, fp: ProtectedFingerprint): string[] {
    const skipped: string[] = [];
    for (const [rel, e] of fp) {
      if (e.type !== 'file') continue;
      const k = this.key(rel, e);
      if (this.have.has(k)) continue;
      if (this.bytes + e.size > this.maxBytes) {
        skipped.push(rel);
        continue;
      }
      const dst = path.join(this.dir, k);
      try {
        fs.copyFileSync(path.join(workspace, rel), dst);
        this.have.set(k, dst);
        this.bytes += e.size;
      } catch {
        skipped.push(rel);
      }
    }
    return skipped;
  }
  /** Store exactly these bytes as the copy of `rel` at entry `e` (a judged `.git/config`; never re-read from disk). */
  putBytes(rel: string, e: ProtectedEntry, bytes: Buffer): void {
    const k = this.key(rel, e);
    const dst = path.join(this.dir, k);
    fs.writeFileSync(dst, bytes, { mode: 0o600 });
    if (!this.have.has(k)) this.bytes += bytes.length;
    this.have.set(k, dst);
  }
  copyOf(rel: string, e: ProtectedEntry): string | undefined {
    const p = this.have.get(this.key(rel, e));
    // a copy that no longer matches what was stored (tampered with) is never written back
    return p && verifiedCopy(p, e) ? p : undefined;
  }
  /**
   * R1 (A): keep copies of `fp`'s files in `dir`, so a later session (or process) can restore this state. Copies come
   * from this store (taken when the state was trusted), never from the workspace as it is now; objects no longer in
   * `fp` are removed. Returns the paths with no copy to keep.
   */
  saveTo(dir: string, fp: ProtectedFingerprint): string[] {
    const missing: string[] = [];
    const want = new Set<string>();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [rel, e] of fp) {
      if (e.type !== 'file') continue;
      const k = this.key(rel, e);
      want.add(k);
      const dst = path.join(dir, k);
      if (fs.existsSync(dst) && verifiedCopy(dst, e)) continue; // an object changed since it was saved is replaced
      const src = this.copyOf(rel, e);
      if (!src) {
        missing.push(rel);
        continue;
      }
      try {
        fs.copyFileSync(src, `${dst}.tmp`);
        fs.renameSync(`${dst}.tmp`, dst);
      } catch {
        missing.push(rel);
      }
    }
    for (const n of fs.readdirSync(dir)) if (!want.has(n)) fs.rmSync(path.join(dir, n), { force: true });
    return missing;
  }
  /** R1 (A): take the copies of `fp`'s files that `saveTo` kept in `dir` (each verified like any copy before use). */
  loadFrom(dir: string, fp: ProtectedFingerprint): void {
    for (const [rel, e] of fp) {
      if (e.type !== 'file') continue;
      const k = this.key(rel, e);
      if (this.have.has(k)) continue;
      const src = path.join(dir, k);
      const dst = path.join(this.dir, k);
      try {
        fs.copyFileSync(src, dst);
      } catch {
        continue;
      }
      this.have.set(k, dst);
      if (!this.copyOf(rel, e)) this.have.delete(k); // not what was trusted: never written back
      else this.bytes += e.size;
    }
  }
  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Does the file at `p` hold exactly the content `e` describes (sha256, or the size above the hash limit)? */
function verifiedCopy(p: string, e: ProtectedEntry): boolean {
  try {
    if (e.hash) return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') === e.hash;
    return fs.statSync(p).size === e.size;
  } catch {
    return false;
  }
}

function removeAny(abs: string): void {
  fs.rmSync(abs, { recursive: true, force: true });
}

/** Make `rel`'s parent chain real directories again (a parent may have been replaced by a file or link). */
function ensureParents(workspace: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const abs = path.join(workspace, ...parts.slice(0, i));
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(abs);
    } catch {
      st = undefined;
    }
    if (st && (!st.isDirectory() || st.isSymbolicLink())) removeAny(abs);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) fs.mkdirSync(abs);
  }
}

/**
 * Put the protected set back to `before`: created paths are removed, deleted,
 * replaced or modified ones are rewritten from the store (content, mode, mtime).
 * Returns the paths it could not restore.
 */
export function restoreProtected(workspace: string, before: ProtectedFingerprint, changes: ProtectedChange[], store: ProtectedContentStore): string[] {
  const failed: string[] = [];
  // Removals first, deepest first, so a restored directory is not removed again.
  for (const c of [...changes].filter((x) => x.kind === 'created').sort((a, b) => b.rel.length - a.rel.length)) {
    try {
      removeAny(path.join(workspace, c.rel));
    } catch {
      failed.push(c.rel);
    }
  }
  const todo = changes.filter((x) => x.kind !== 'created').map((x) => x.rel);
  // Restoring a directory also restores everything that was under it.
  const restoreSet = new Set(todo);
  for (const rel of todo) {
    const e = before.get(rel);
    if (e?.type === 'dir') for (const k of before.keys()) if (k.startsWith(rel + '/')) restoreSet.add(k);
  }
  for (const rel of [...restoreSet].sort((a, b) => a.length - b.length)) {
    const e = before.get(rel)!;
    const abs = path.join(workspace, rel);
    try {
      ensureParents(workspace, rel);
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(abs);
      } catch {
        st = undefined;
      }
      if (e.type === 'dir') {
        if (st && (!st.isDirectory() || st.isSymbolicLink())) removeAny(abs);
        if (!st || !st.isDirectory() || st.isSymbolicLink()) fs.mkdirSync(abs);
        fs.chmodSync(abs, e.mode & 0o7777);
      } else if (e.type === 'link') {
        if (st) removeAny(abs);
        fs.symlinkSync(e.link ?? '', abs);
      } else if (e.type === 'file') {
        const src = store.copyOf(rel, e);
        if (!src) {
          failed.push(rel);
          continue;
        }
        if (st && (!st.isFile() || st.isSymbolicLink())) removeAny(abs);
        // Write through a fresh inode: a hard link to the old inode elsewhere must not keep the new content.
        const tmp = `${abs}.oh-restoreProtected-${process.pid}`;
        fs.copyFileSync(src, tmp);
        fs.chmodSync(tmp, e.mode & 0o7777);
        fs.renameSync(tmp, abs);
        fs.utimesSync(abs, new Date(), new Date(e.mtimeMs));
      } else failed.push(rel);
    } catch {
      failed.push(rel);
    }
  }
  return failed;
}

/**
 * Absolute paths to mount read-only in the OS sandbox: for `dir/**` patterns the
 * directory itself (so new files are refused too), otherwise every existing
 * match. Expanded at spawn time.
 */
export function readOnlyRoots(workspace: string, set: ProtectedSet): string[] {
  const { fp } = fingerprintProtected(workspace, set, MAX_ENTRIES, false);
  const roots: string[] = [];
  const rels = [...fp.keys()].sort((a, b) => a.length - b.length);
  for (const rel of rels) {
    if (roots.some((r) => rel === r || rel.startsWith(r + '/'))) continue;
    // A directory whose every descendant is in the set (`tests/**`) is mounted whole.
    const e = fp.get(rel)!;
    if (e.type === 'dir' && set.match(`${rel}/__oh_probe__/x`)) roots.push(rel);
    else if (e.type === 'file') roots.push(rel); // links are not mounted over (a bind follows them)
  }
  return roots.map((r) => path.join(workspace, r));
}

/** Copy the protected files of a pristine source tree over a workspace, removing protected files the source does not have. */
export function restorePristine(source: string, workspace: string, patterns: string[]): string[] {
  const set = protectedSet(patterns);
  const want = fingerprintProtected(source, set).fp;
  const have = fingerprintProtected(workspace, set).fp;
  const changed = diffProtected(want, have);
  for (const c of changed) {
    const dst = path.join(workspace, c.rel);
    if (c.kind === 'created') {
      fs.rmSync(dst, { recursive: true, force: true });
      continue;
    }
    const e = want.get(c.rel)!;
    ensureParents(workspace, c.rel);
    fs.rmSync(dst, { recursive: true, force: true });
    if (e.type === 'dir') fs.mkdirSync(dst, { recursive: true });
    else if (e.type === 'link') fs.symlinkSync(e.link ?? '', dst);
    else fs.copyFileSync(path.join(source, c.rel), dst);
  }
  // a restored directory's children
  for (const c of changed) if (c.kind !== 'created' && want.get(c.rel)?.type === 'dir') fs.cpSync(path.join(source, c.rel), path.join(workspace, c.rel), { recursive: true, force: true });
  return changed.map((c) => `${c.rel} (${c.kind})`);
}


/**
 * The first guarded path at or below `relDir` (workspace-relative, '' = the root),
 * or null. Used to refuse removing a directory that holds protected files. A
 * walk that hits the entry cap answers `relDir` itself (fail closed).
 */
export const TOO_MANY = Symbol('too many entries to check');
export function firstGuardedUnder(workspace: string, set: ProtectedSet, relDir: string): string | null | typeof TOO_MANY {
  const dir = relDir.replace(/^\.\/?/, '').replace(/\/$/, '');
  // Only bases that overlap the directory can match under it.
  const bases = set.bases.filter((b) => b === '' || dir === '' || b === dir || b.startsWith(dir + '/') || dir.startsWith(b + '/'));
  if (!bases.length) return null;
  const wild = new Set<string>();
  const sub = bases.map((b) => {
    const nb = b === '' || dir.startsWith(b + '/') ? dir : b;
    if (b === '' || set.wild?.has(b)) wild.add(nb);
    return nb;
  });
  const { fp, truncated } = fingerprintProtected(workspace, { ...set, bases: [...new Set(sub)], wild }, 100_000);
  for (const rel of fp.keys()) if (dir === '' || rel === dir || rel.startsWith(dir + '/')) return rel;
  return truncated ? TOO_MANY : null;
}
