/**
 * Fallback checkpoint backend for machines without git (SPEC C1): content-
 * addressed copies of the workspace's files.
 *
 * Layout under `<homeDir>/checkpoints/<projectKey>/copy/`:
 *   objects/<sha256>          file contents (deduplicated across checkpoints)
 *   manifests/<id>.json       { path: [sha256, mode] } for one checkpoint
 *   checkpoints.jsonl         one line per checkpoint (the commit point)
 *   statcache.json            path → size/mtime/hash, so unchanged files are not re-hashed
 *
 * Write order is blobs → manifest → journal line, so a crash mid-snapshot never
 * leaves a listed checkpoint pointing at missing content. The same ignore rules
 * as the git backend apply (.gitignore, .tuglineignore, built-in excludes,
 * size cap). Symlinks are skipped (as in Claude Code).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ignoreIndexFor, matchRuleSets, parseIgnoreFile, type RuleSet } from '../permissions/ignore.js';
import { ALWAYS_EXCLUDE, type CheckpointBackend, type CheckpointMeta, type FileChange, type RestoreResult, type SnapshotInput } from './types.js';

type Manifest = Record<string, [hash: string, mode: number]>;
type StatCache = Record<string, { size: number; mtimeMs: number; hash: string }>;

export class CopyBackend implements CheckpointBackend {
  readonly kind = 'copy' as const;
  private builtin: RuleSet[] = [{ base: '', rules: parseIgnoreFile(ALWAYS_EXCLUDE.join('\n')) }];

  constructor(readonly workspace: string, readonly storeDir: string, readonly maxFileBytes: number) {}

  private get dir(): string {
    return path.join(this.storeDir, 'copy');
  }

  private ensure(): void {
    for (const d of ['objects', 'manifests']) fs.mkdirSync(path.join(this.dir, d), { recursive: true, mode: 0o700 });
  }

  private excluded(rel: string, isDir: boolean): boolean {
    if (matchRuleSets(this.builtin, rel, isDir) === true) return true;
    const ix = ignoreIndexFor(this.workspace);
    return ix.gitIgnored(rel, isDir) || ix.harnessIgnored(rel, isDir);
  }

  /** Current workspace state as a manifest (hashing only files whose size/mtime changed). */
  private scan(): Manifest {
    const cacheFile = path.join(this.dir, 'statcache.json');
    let cache: StatCache = {};
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
    const next: StatCache = {};
    const out: Manifest = {};
    const walk = (dirRel: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(path.join(this.workspace, dirRel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!this.excluded(rel, true)) walk(rel);
          continue;
        }
        if (!e.isFile() || this.excluded(rel, false)) continue;
        const abs = path.join(this.workspace, rel);
        let st: fs.Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > this.maxFileBytes) continue;
        const c = cache[rel];
        let hash: string;
        if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) hash = c.hash;
        else {
          const buf = fs.readFileSync(abs);
          hash = crypto.createHash('sha256').update(buf).digest('hex');
          const obj = path.join(this.dir, 'objects', hash);
          if (!fs.existsSync(obj)) {
            const tmp = `${obj}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, buf, { mode: 0o600 });
            fs.renameSync(tmp, obj);
          }
        }
        next[rel] = { size: st.size, mtimeMs: st.mtimeMs, hash };
        out[rel] = [hash, st.mode & 0o777];
      }
    };
    walk('');
    // Make sure every referenced object exists (a cached hash may predate a pruned store).
    for (const [rel, [hash]] of Object.entries(out)) {
      const obj = path.join(this.dir, 'objects', hash);
      if (!fs.existsSync(obj)) fs.writeFileSync(obj, fs.readFileSync(path.join(this.workspace, rel)), { mode: 0o600 });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(next), { mode: 0o600 });
    return out;
  }

  private manifest(id: string): Manifest {
    if (!/^[0-9a-f]{4,40}$/i.test(id)) throw new Error(`invalid checkpoint id "${id}"`);
    const all = this.readJournal();
    const hit = all.find((m) => m.id === id) ?? all.find((m) => m.id.startsWith(id));
    if (!hit) throw new Error(`unknown checkpoint "${id}"`);
    return JSON.parse(fs.readFileSync(path.join(this.dir, 'manifests', `${hit.id}.json`), 'utf8'));
  }

  private readJournal(): CheckpointMeta[] {
    try {
      return fs
        .readFileSync(path.join(this.dir, 'checkpoints.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CheckpointMeta);
    } catch {
      return [];
    }
  }

  private static changes(from: Manifest, to: Manifest): FileChange[] {
    const res: FileChange[] = [];
    for (const [p, [h]] of Object.entries(to)) {
      if (!from[p]) res.push({ path: p, status: 'A' });
      else if (from[p][0] !== h) res.push({ path: p, status: 'M' });
    }
    for (const p of Object.keys(from)) if (!to[p]) res.push({ path: p, status: 'D' });
    return res.sort((a, b) => a.path.localeCompare(b.path));
  }

  async snapshot(meta: SnapshotInput): Promise<CheckpointMeta | undefined> {
    this.ensure();
    const cur = this.scan();
    const prev = this.readJournal().at(-1);
    let files = Object.keys(cur).length;
    if (prev) {
      const changed = CopyBackend.changes(this.manifest(prev.id), cur).length;
      if (changed === 0 && meta.kind === 'shell') return undefined;
      files = changed;
    }
    const ts = Date.now();
    const id = crypto.createHash('sha1').update(`${ts}:${Math.random()}:${JSON.stringify(meta)}`).digest('hex').slice(0, 12);
    fs.writeFileSync(path.join(this.dir, 'manifests', `${id}.json`), JSON.stringify(cur), { mode: 0o600 });
    const rec: CheckpointMeta = { id, ts, files, ...meta };
    fs.appendFileSync(path.join(this.dir, 'checkpoints.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
    return rec;
  }

  async list(limit = 200): Promise<CheckpointMeta[]> {
    return this.readJournal().reverse().slice(0, limit);
  }

  async diff(id: string): Promise<{ files: FileChange[] }> {
    this.ensure();
    return { files: CopyBackend.changes(this.manifest(id), this.scan()) };
  }

  async restoreFiles(id: string): Promise<RestoreResult> {
    this.ensure();
    const target = this.manifest(id);
    const cur = this.scan();
    const changes = CopyBackend.changes(target, cur);
    const restored: string[] = [];
    const removed: string[] = [];
    for (const c of changes) {
      const abs = path.join(this.workspace, c.path);
      if (c.status === 'A') {
        fs.rmSync(abs, { force: true });
        removed.push(c.path);
        // remove directories left empty, up to the workspace root
        let d = path.dirname(abs);
        while (d !== this.workspace && d.startsWith(this.workspace)) {
          try {
            fs.rmdirSync(d);
          } catch {
            break;
          }
          d = path.dirname(d);
        }
      } else {
        const [hash, mode] = target[c.path];
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(path.join(this.dir, 'objects', hash)));
        try {
          fs.chmodSync(abs, mode);
        } catch {
          /* best effort */
        }
        restored.push(c.path);
      }
    }
    // the stat cache now refers to rewritten files; it self-heals on the next scan (size/mtime differ)
    return { restored, removed };
  }
}
