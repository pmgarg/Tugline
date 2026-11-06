/**
 * Shadow-git checkpoint backend (SPEC C1, research ED §5).
 *
 * A private repository at `<homeDir>/checkpoints/<projectKey>/.git` records the
 * workspace with `git --git-dir=<shadow> --work-tree=<workspace>`. The user's
 * own `.git` is never read or written: git always skips `.git` entries in a
 * work tree, every call runs with an environment stripped of GIT_* variables,
 * and the user's global/system git config is disabled (no hooks, fsmonitor,
 * excludesFile or autocrlf can leak in).
 *
 * Snapshots are commits on `refs/heads/checkpoints` built with plumbing only
 * (`add -A`, `write-tree`, `commit-tree`, `update-ref`): no hooks run, no
 * signing, and the index's stat cache makes later snapshots incremental.
 * Restore is `read-tree --reset -u <commit>` after staging the current state,
 * which rewrites changed files, recreates deleted ones and removes files created
 * since, while ignored and oversized files are untouched because they were never
 * in the index.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ignoreIndexFor, escapeIgnorePath } from '../permissions/ignore.js';
import { ALWAYS_EXCLUDE, type CheckpointBackend, type CheckpointKind, type CheckpointMeta, type FileChange, type RestoreResult, type SnapshotInput } from './types.js';

const REF = 'refs/heads/checkpoints';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

let gitChecked: boolean | undefined;
/** Is a usable git on PATH? (cached) */
export async function gitAvailable(): Promise<boolean> {
  if (gitChecked !== undefined) return gitChecked;
  gitChecked = await new Promise<boolean>((resolve) => {
    const p = spawn('git', ['--version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
  return gitChecked;
}

interface State {
  oversized: string[];
  nested: string[];
}

export class ShadowGitBackend implements CheckpointBackend {
  readonly kind = 'git' as const;
  private ready = false;

  constructor(readonly workspace: string, readonly storeDir: string, readonly maxFileBytes: number) {}

  get gitDir(): string {
    return path.join(this.storeDir, '.git');
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    return {
      ...env,
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.workspace,
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Tugline',
      GIT_AUTHOR_EMAIL: 'checkpoints@tugline.local',
      GIT_COMMITTER_NAME: 'Tugline',
      GIT_COMMITTER_EMAIL: 'checkpoints@tugline.local',
    };
  }

  private git(args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const p = spawn('git', args, { cwd: this.workspace, env: this.env(), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      p.stdout!.on('data', (d) => (stdout += d));
      p.stderr!.on('data', (d) => (stderr += d));
      p.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
      p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (input !== undefined && p.stdin) {
        p.stdin.on('error', () => undefined); // git may exit before reading everything
        p.stdin.end(input);
      }
    });
  }

  private async gitOk(args: string[], input?: string): Promise<string> {
    const r = await this.git(args, input);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  private stateFile(): string {
    return path.join(this.storeDir, 'state.json');
  }

  private readState(): State {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile(), 'utf8'));
      return { oversized: Array.isArray(s.oversized) ? s.oversized : [], nested: Array.isArray(s.nested) ? s.nested : [] };
    } catch {
      return { oversized: [], nested: [] };
    }
  }

  private writeState(s: State): void {
    fs.writeFileSync(this.stateFile(), JSON.stringify(s), { mode: 0o600 });
  }

  private async ensure(): Promise<void> {
    if (this.ready && fs.existsSync(path.join(this.gitDir, 'HEAD'))) return;
    // Snapshots can contain secrets from the workspace: keep them private to the user.
    fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      const r = await new Promise<GitResult>((resolve) => {
        const env = this.env();
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        const p = spawn('git', ['init', '-q', '--template=', this.storeDir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += d));
        p.on('error', (e) => resolve({ code: 127, stdout: '', stderr: e.message }));
        p.on('close', (code) => resolve({ code: code ?? 1, stdout: '', stderr }));
      });
      if (r.code !== 0) throw new Error(`git init failed: ${r.stderr.trim()}`);
      for (const [k, v] of [['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.quotepath', 'false'], ['gc.auto', '0'], ['commit.gpgsign', 'false']]) await this.gitOk(['config', k, v]);
      fs.writeFileSync(path.join(this.storeDir, 'WORKSPACE'), this.workspace + '\n');
    }
    this.ready = true;
  }

  private writeExcludes(state: State): void {
    const lines = ['# Tugline checkpoint excludes (generated)', ...ALWAYS_EXCLUDE];
    // .tuglineignore applies to snapshots too: hidden files are not copied into the store.
    try {
      lines.push('# .tuglineignore', ...ignoreIndexFor(this.workspace).harnessPatternsAsRootExcludes());
    } catch {
      /* best effort */
    }
    lines.push('# oversized', ...state.oversized.map((p) => '/' + escapeIgnorePath(p)));
    lines.push('# nested repositories (not snapshotted)', ...state.nested.map((p) => '/' + escapeIgnorePath(p) + '/'));
    fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), lines.join('\n') + '\n');
  }

  /** Stage the current workspace into the shadow index and return its tree id. */
  private async stage(): Promise<string> {
    await this.ensure();
    const state = this.readState();
    // Previously oversized files stay excluded while they are still too big.
    state.oversized = state.oversized.filter((p) => {
      try {
        return fs.statSync(path.join(this.workspace, p)).size > this.maxFileBytes;
      } catch {
        return false;
      }
    });
    state.nested = state.nested.filter((p) => fs.existsSync(path.join(this.workspace, p, '.git')));
    this.writeExcludes(state);
    // Candidates = new or modified files; only they can have become oversized.
    const cand = (await this.gitOk(['ls-files', '-z', '--others', '--modified', '--exclude-standard'])).split('\0').filter(Boolean);
    const big: string[] = [];
    for (const rel of cand) {
      try {
        const st = fs.lstatSync(path.join(this.workspace, rel));
        if (st.isFile() && st.size > this.maxFileBytes) big.push(rel);
      } catch {
        /* vanished */
      }
    }
    if (big.length) {
      state.oversized = [...new Set([...state.oversized, ...big])];
      this.writeExcludes(state);
      // An already-tracked file that grew past the cap leaves the index (its old version stays in older checkpoints).
      await this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', ...big]);
    }
    const add = await this.git(['add', '-A', '--ignore-errors', '--', '.']);
    const nested = [...add.stderr.matchAll(/adding embedded git repository: (.+)/g)].map((m) => m[1].trim());
    if (nested.length) {
      state.nested = [...new Set([...state.nested, ...nested])];
      this.writeExcludes(state);
      await this.git(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...nested]);
    }
    if (add.code !== 0 && !/warning/i.test(add.stderr) && !nested.length) throw new Error(`git add failed: ${add.stderr.trim()}`);
    this.writeState(state);
    return (await this.gitOk(['write-tree'])).trim();
  }

  private async head(): Promise<string | undefined> {
    const r = await this.git(['rev-parse', '--verify', '-q', REF]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private async changes(from: string, to: string): Promise<FileChange[]> {
    const out = await this.gitOk(['diff-tree', '-r', '-z', '--no-renames', '--name-status', from, to]);
    const parts = out.split('\0').filter((x) => x !== '');
    const res: FileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const s = parts[i][0];
      res.push({ path: parts[i + 1], status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M' });
    }
    return res;
  }

  async snapshot(meta: SnapshotInput): Promise<CheckpointMeta | undefined> {
    const tree = await this.stage();
    const parent = await this.head();
    let files: number;
    if (parent) {
      const parentTree = (await this.gitOk(['rev-parse', `${parent}^{tree}`])).trim();
      if (parentTree === tree && meta.kind === 'shell') return undefined; // nothing new to protect
      files = parentTree === tree ? 0 : (await this.changes(parentTree, tree)).length;
    } else {
      files = (await this.gitOk(['ls-tree', '-r', '-z', '--name-only', tree])).split('\0').filter(Boolean).length;
    }
    const ts = Date.now();
    const trailers = [
      `oh-kind: ${meta.kind}`,
      `oh-ts: ${ts}`,
      `oh-files: ${files}`,
      meta.sessionId ? `oh-session: ${meta.sessionId}` : '',
      meta.runId ? `oh-run: ${meta.runId}` : '',
      meta.turn !== undefined ? `oh-turn: ${meta.turn}` : '',
      meta.messageIndex !== undefined ? `oh-message-index: ${meta.messageIndex}` : '',
    ].filter(Boolean);
    const msg = `${meta.label.replace(/\n/g, ' ').slice(0, 200)}\n\n${trailers.join('\n')}\n`;
    const commit = (await this.gitOk(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-F', '-'], msg)).trim();
    await this.gitOk(['update-ref', REF, commit, ...(parent ? [parent] : [])]);
    return { id: commit.slice(0, 12), ts, label: meta.label, kind: meta.kind, sessionId: meta.sessionId, runId: meta.runId, turn: meta.turn, messageIndex: meta.messageIndex, files };
  }

  async list(limit = 200): Promise<CheckpointMeta[]> {
    await this.ensure();
    if (!(await this.head())) return [];
    const out = await this.gitOk(['log', `-n${limit}`, '--format=%H%x1f%B%x1e', REF]);
    const res: CheckpointMeta[] = [];
    for (const rec of out.split('\x1e')) {
      const [hash, body] = rec.replace(/^\s+/, '').split('\x1f');
      if (!hash || body === undefined) continue;
      const t = (k: string) => body.match(new RegExp(`^${k}: (.*)$`, 'm'))?.[1]?.trim();
      const num = (k: string) => (t(k) !== undefined ? Number(t(k)) : undefined);
      res.push({
        id: hash.slice(0, 12),
        ts: num('oh-ts') ?? 0,
        label: body.split('\n')[0],
        kind: (t('oh-kind') as CheckpointKind) ?? 'manual',
        sessionId: t('oh-session'),
        runId: t('oh-run'),
        turn: num('oh-turn'),
        messageIndex: num('oh-message-index'),
        files: num('oh-files') ?? 0,
      });
    }
    return res;
  }

  private async resolve(id: string): Promise<string> {
    if (!/^[0-9a-f]{4,40}$/i.test(id)) throw new Error(`invalid checkpoint id "${id}"`);
    const r = await this.git(['rev-parse', '--verify', '-q', `${id}^{commit}`]);
    if (r.code !== 0) throw new Error(`unknown checkpoint "${id}"`);
    return r.stdout.trim();
  }

  async diff(id: string): Promise<{ files: FileChange[]; patch?: string }> {
    const commit = await this.resolve(id);
    const tree = await this.stage();
    const files = await this.changes(commit, tree);
    const patch = (await this.git(['diff-tree', '-p', '--no-color', '--no-renames', commit, tree])).stdout;
    return { files, patch: patch.length > 200_000 ? patch.slice(0, 200_000) + '\n… (truncated)' : patch };
  }

  async restoreFiles(id: string): Promise<RestoreResult> {
    const commit = await this.resolve(id);
    const tree = await this.stage();
    const changes = await this.changes(commit, tree);
    await this.gitOk(['read-tree', '--reset', '-u', commit]);
    return { restored: changes.filter((c) => c.status !== 'A').map((c) => c.path), removed: changes.filter((c) => c.status === 'A').map((c) => c.path) };
  }
}
