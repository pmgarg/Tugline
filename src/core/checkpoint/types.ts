/** Shared checkpoint types (SPEC C1). */

export type CheckpointKind = 'turn' | 'shell' | 'manual' | 'pre-restore';

export interface CheckpointMeta {
  id: string;
  ts: number;
  label: string;
  kind: CheckpointKind;
  sessionId?: string;
  runId?: string;
  turn?: number;
  /** Conversation length to truncate to when restoring the conversation. */
  messageIndex?: number;
  /** Files that differ from the previous checkpoint. */
  files: number;
}

export type SnapshotInput = Omit<CheckpointMeta, 'id' | 'ts' | 'files'>;

export interface FileChange {
  path: string;
  /** Relative to the checkpoint: A = exists now but not in the checkpoint, D = deleted since, M = modified since. */
  status: 'A' | 'D' | 'M';
}

export interface RestoreResult {
  /** Files written back to their checkpoint content (modified or deleted since). */
  restored: string[];
  /** Files removed because they did not exist at the checkpoint. */
  removed: string[];
}

export interface CheckpointBackend {
  readonly kind: 'git' | 'copy';
  /** Record the workspace state. Returns undefined when the snapshot was skipped (no change, shell kind). */
  snapshot(meta: SnapshotInput): Promise<CheckpointMeta | undefined>;
  /** Newest first. */
  list(limit?: number): Promise<CheckpointMeta[]>;
  /** What changed between checkpoint `id` and the current workspace. */
  diff(id: string): Promise<{ files: FileChange[]; patch?: string }>;
  /** Make the workspace match checkpoint `id` (ignored and oversized files untouched). */
  restoreFiles(id: string): Promise<RestoreResult>;
}

export interface CheckpointConfig {
  /** Snapshot before each turn and each shell command. Default true. */
  enabled: boolean;
  /** Files larger than this are not snapshotted. Default 5. */
  maxFileMB: number;
  /** 'auto' = shadow git when git is installed, else content-addressed copies. */
  backend: 'auto' | 'git' | 'copy';
  /** If one snapshot takes longer than this, stop snapshotting before shell commands for the session. */
  slowSnapshotMs: number;
}

export const DEFAULT_CHECKPOINTS: CheckpointConfig = { enabled: true, maxFileMB: 5, backend: 'auto', slowSnapshotMs: 3000 };

/**
 * Always excluded from snapshots (gitignore syntax): the harness's own state
 * (config, artifacts, skills: rewinding must never silently change agent-control
 * files) and dependency caches.
 */
export const ALWAYS_EXCLUDE = ['.git/', '/.tugline/', 'node_modules/', '.venv/', '__pycache__/', '.DS_Store'];
