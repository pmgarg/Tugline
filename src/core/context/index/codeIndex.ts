/**
 * N2 local code index: chunks (chunker.ts) + an inverted BM25 index (bm25.ts)
 * + optional embedding vectors from an OpenAI-compatible endpoint (embed.ts),
 * ranked by reciprocal rank fusion.
 *
 * Storage (per project, under `<homeDir>/index/<projectKey>/`):
 *   meta.json     version, embedder, dimension, per-file {hash, mtime, size}
 *   chunks.jsonl  one chunk per line (path, lines, symbol, redacted text, hash, vector row)
 *   vectors.f32   row-major Float32, L2-normalised (cosine = dot product)
 * Brute-force cosine is fine up to ~200k chunks, with no new dependency.
 *
 * Updates are incremental: a file whose mtime+size are unchanged is not read; a
 * file whose content hash is unchanged is not re-chunked; a chunk whose hash is
 * unchanged keeps its vector. Files that are no longer visible (secret,
 * ignored, hidden, denied by the read policy, excluded) are dropped from the
 * stored index on the next update.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { Bm25Index } from './bm25.js';
import { chunkDocument, chunkFile, type Chunk } from './chunker.js';
import type { EmbedderSpec } from './config.js';
import { embedAll, embedBatch, EmbedError } from './embed.js';
import { listFiles } from './files.js';

export const INDEX_VERSION = 1;
const MAX_BYTES = 512 * 1024;
const RRF_K = 60;
const CANDIDATES = 100;

export const INDEX_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.scala', '.swift', '.dart', '.rb', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.php',
  '.md', '.mdx', '.yaml', '.yml', '.toml', '.sh', '.bash', '.sql', '.css', '.scss', '.html', '.vue', '.svelte', '.proto', '.graphql',
]);

export interface StoredChunk extends Chunk {
  /** row in vectors.f32, or -1 */
  row: number;
}

interface FileMeta {
  hash: string;
  size: number;
  mtimeMs: number;
}

interface Meta {
  version: number;
  workspace: string;
  /** "<baseUrl>|<model>" of the vectors, or "" */
  embedder: string;
  dim: number;
  updatedAt: string;
  files: Record<string, FileMeta>;
}

export interface UpdateStats {
  files: number;
  chunks: number;
  /** files read and re-chunked */
  changedFiles: number;
  removedFiles: number;
  embedded: number;
  vectors: number;
  ms: number;
  embedError?: string;
}

export interface SearchHit {
  chunk: StoredChunk;
  score: number;
  bm25Rank?: number;
  vectorRank?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  engine: 'hybrid' | 'bm25';
  note?: string;
}

export { indexDir, projectKey } from './key.js';
import { indexDir } from './key.js';

function atomicWrite(file: string, data: string | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export interface IndexOptions {
  /** file filter over absolute paths (visibility rules) */
  visible: (abs: string) => boolean;
  embedder?: EmbedderSpec;
  maxFiles?: number;
  exclude?: string[];
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
}

export class CodeIndex {
  private meta: Meta;
  private chunks: StoredChunk[] = [];
  private vectors = new Float32Array(0);
  private bm25?: Bm25Index;
  private loaded = false;

  constructor(
    readonly workspace: string,
    readonly dir: string,
  ) {
    this.meta = { version: INDEX_VERSION, workspace: path.resolve(workspace), embedder: '', dim: 0, updatedAt: '', files: {} };
  }

  get size(): { files: number; chunks: number; vectors: number; dim: number; embedder: string; updatedAt: string } {
    this.load();
    return { files: Object.keys(this.meta.files).length, chunks: this.chunks.length, vectors: this.chunks.filter((c) => c.row >= 0).length, dim: this.meta.dim, embedder: this.meta.embedder, updatedAt: this.meta.updatedAt };
  }

  /** All stored chunks (tests assert what entered the index). */
  storedChunks(): StoredChunk[] {
    this.load();
    return this.chunks;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8')) as Meta;
      if (meta.version !== INDEX_VERSION) return;
      const chunks = fs.readFileSync(path.join(this.dir, 'chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as StoredChunk);
      let vectors = new Float32Array(0);
      if (meta.dim > 0 && fs.existsSync(path.join(this.dir, 'vectors.f32'))) {
        const b = fs.readFileSync(path.join(this.dir, 'vectors.f32'));
        vectors = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      }
      this.meta = meta;
      this.chunks = chunks;
      this.vectors = vectors;
    } catch {
      /* no index yet, or a damaged one: rebuild */
    }
  }

  private save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    atomicWrite(path.join(this.dir, 'chunks.jsonl'), this.chunks.map((c) => JSON.stringify(c)).join('\n') + (this.chunks.length ? '\n' : ''));
    atomicWrite(path.join(this.dir, 'vectors.f32'), new Uint8Array(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
    atomicWrite(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta));
  }

  /** Forget everything (tug index rebuild). */
  clear(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.meta = { version: INDEX_VERSION, workspace: path.resolve(this.workspace), embedder: '', dim: 0, updatedAt: '', files: {} };
    this.chunks = [];
    this.vectors = new Float32Array(0);
    this.bm25 = undefined;
    this.loaded = true;
  }

  vector(c: StoredChunk): Float32Array | undefined {
    if (c.row < 0 || !this.meta.dim) return undefined;
    return this.vectors.subarray(c.row * this.meta.dim, (c.row + 1) * this.meta.dim);
  }

  async update(o: IndexOptions): Promise<UpdateStats> {
    const t0 = Date.now();
    this.load();
    const ws = path.resolve(this.workspace);
    const excluded = o.exclude?.length ? picomatch(o.exclude, { dot: true }) : () => false;
    const rels = listFiles(ws, { extensions: INDEX_EXT, max: o.maxFiles ?? 20_000 }).filter((r) => !excluded(r) && o.visible(path.join(ws, r)));
    const oldByFile = new Map<string, StoredChunk[]>();
    for (const c of this.chunks) {
      let a = oldByFile.get(c.rel);
      if (!a) oldByFile.set(c.rel, (a = []));
      a.push(c);
    }
    const files: Record<string, FileMeta> = {};
    const next: StoredChunk[] = [];
    let changedFiles = 0;
    for (const rel of rels) {
      const abs = path.join(ws, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const prev = this.meta.files[rel];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && oldByFile.has(rel)) {
        files[rel] = prev;
        next.push(...oldByFile.get(rel)!);
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      files[rel] = { hash, size: st.size, mtimeMs: st.mtimeMs };
      if (prev && prev.hash === hash && oldByFile.has(rel)) {
        next.push(...oldByFile.get(rel)!);
        continue;
      }
      changedFiles++;
      const { chunks } = await chunkFile(rel, text);
      next.push(...chunks.map((c) => ({ ...c, row: -1 })));
    }
    const removedFiles = Object.keys(this.meta.files).filter((r) => !files[r]).length;

    // vectors: reuse by chunk hash when the embedder is unchanged
    const embedderKey = o.embedder ? `${o.embedder.baseUrl}|${o.embedder.model}` : '';
    const cache = new Map<string, Float32Array>();
    if (embedderKey && embedderKey === this.meta.embedder) for (const c of this.chunks) {
      const v = this.vector(c);
      if (v) cache.set(c.hash, v);
    }
    let embedded = 0;
    let embedError: string | undefined;
    let dim = embedderKey === this.meta.embedder ? this.meta.dim : 0;
    const vecs: (Float32Array | undefined)[] = next.map((c) => cache.get(c.hash));
    if (o.embedder) {
      const todo = next.map((c, i) => (vecs[i] ? -1 : i)).filter((i) => i >= 0);
      if (todo.length) {
        o.onProgress?.(`embedding ${todo.length} chunk(s) with ${o.embedder.model}…`);
        try {
          const got = await embedAll(o.embedder, todo.map((i) => o.embedder!.documentPrefix + chunkDocument(next[i])), (d, n) => o.onProgress?.(`embedded ${d}/${n}`), o.signal);
          got.forEach((v, j) => (vecs[todo[j]] = v));
          embedded = got.length;
        } catch (e) {
          embedError = (e as Error).message;
        }
      }
      dim = vecs.find((v) => v)?.length ?? dim;
    }
    // re-pack rows
    let rows = 0;
    const packed = new Float32Array(dim ? vecs.filter((v) => v && v.length === dim).length * dim : 0);
    next.forEach((c, i) => {
      const v = vecs[i];
      if (dim && v && v.length === dim) {
        packed.set(v, rows * dim);
        c.row = rows++;
      } else c.row = -1;
    });
    const changed = changedFiles > 0 || removedFiles > 0 || embedded > 0 || embedderKey !== this.meta.embedder || next.length !== this.chunks.length;
    this.chunks = next;
    this.vectors = packed;
    this.meta = { ...this.meta, embedder: rows ? embedderKey : '', dim: rows ? dim : 0, files, updatedAt: changed ? new Date().toISOString() : this.meta.updatedAt };
    if (changed || !fs.existsSync(path.join(this.dir, 'meta.json'))) {
      this.bm25 = undefined;
      this.save();
    } else {
      // mtimes may have moved without content changes
      atomicWrite(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta));
    }
    return { files: Object.keys(files).length, chunks: next.length, changedFiles, removedFiles, embedded, vectors: rows, ms: Date.now() - t0, embedError };
  }

  /** Hybrid search: BM25 and cosine candidate lists fused by reciprocal rank (k = 60). */
  async search(query: string, o: { k?: number; path?: string; embedder?: EmbedderSpec; perFile?: number; signal?: AbortSignal } = {}): Promise<SearchResult> {
    this.load();
    const k = Math.max(1, Math.min(o.k ?? 8, 50));
    const scope = o.path ? pathScope(o.path) : undefined;
    const allow = scope ? (i: number) => scope(this.chunks[i].rel) : undefined;
    this.bm25 ??= new Bm25Index(this.chunks.map((c) => ({ head: `${c.rel} ${c.symbol ?? ''}`, body: c.text })));
    const kw = this.bm25.search(query, CANDIDATES, allow);
    let vec: [number, number][] = [];
    let note: string | undefined;
    let engine: 'hybrid' | 'bm25' = 'bm25';
    if (o.embedder && this.meta.dim && `${o.embedder.baseUrl}|${o.embedder.model}` === this.meta.embedder) {
      try {
        const [qv] = await embedBatch(o.embedder, [o.embedder.queryPrefix + query], o.signal);
        vec = this.cosine(qv, allow);
        engine = 'hybrid';
      } catch (e) {
        note = `${(e as EmbedError).message}; keyword (BM25) ranking only`;
      }
    } else if (o.embedder) note = 'no embeddings in the index yet; keyword (BM25) ranking only';
    const fused = new Map<number, SearchHit>();
    kw.forEach(([i], r) => fused.set(i, { chunk: this.chunks[i], score: 1 / (RRF_K + r + 1), bm25Rank: r + 1 }));
    vec.forEach(([i], r) => {
      const h = fused.get(i) ?? { chunk: this.chunks[i], score: 0 };
      h.score += 1 / (RRF_K + r + 1);
      h.vectorRank = r + 1;
      fused.set(i, h);
    });
    const perFile = o.perFile ?? 2;
    const count = new Map<string, number>();
    const hits: SearchHit[] = [];
    for (const h of [...fused.values()].sort((a, b) => b.score - a.score)) {
      const n = count.get(h.chunk.rel) ?? 0;
      if (n >= perFile) continue;
      count.set(h.chunk.rel, n + 1);
      hits.push(h);
      if (hits.length >= k) break;
    }
    return { hits, engine, note };
  }

  private cosine(q: Float32Array, allow?: (i: number) => boolean): [number, number][] {
    const dim = this.meta.dim;
    if (q.length !== dim) return [];
    const top: [number, number][] = [];
    let floor = -Infinity;
    this.chunks.forEach((c, i) => {
      if (c.row < 0 || (allow && !allow(i))) return;
      let s = 0;
      const off = c.row * dim;
      for (let j = 0; j < dim; j++) s += q[j] * this.vectors[off + j];
      if (top.length < CANDIDATES || s > floor) {
        top.push([i, s]);
        if (top.length > CANDIDATES * 2) {
          top.sort((a, b) => b[1] - a[1]);
          top.length = CANDIDATES;
          floor = top[top.length - 1][1];
        }
      }
    });
    return top.sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES);
  }
}

/** `path` argument: a directory prefix, a file, or a glob. */
function pathScope(p: string): (rel: string) => boolean {
  const norm = p.replace(/^\.\//, '').replace(/\/+$/, '');
  if (/[*?[{]/.test(norm)) return picomatch(norm, { dot: true });
  return (rel) => rel === norm || rel.startsWith(norm + '/');
}

const instances = new Map<string, CodeIndex>();

/** The (cached) index of a workspace. */
export function codeIndexFor(homeDir: string, workspace: string): CodeIndex {
  const dir = indexDir(homeDir, workspace);
  let i = instances.get(dir);
  if (!i) instances.set(dir, (i = new CodeIndex(workspace, dir)));
  return i;
}

export function forgetIndexes(): void {
  instances.clear();
}
