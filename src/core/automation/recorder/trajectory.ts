/**
 * Trajectory recorder (SPEC E7, research CU §5.7). One JSONL line per
 * automation tool call under `runs/<session>/trajectory.jsonl`, plus
 * `meta.json`. Secrets appear only as `secret://` refs (the driver resolves
 * them; the recorder never sees values) and diffs are already masked.
 *
 * A recording is three things at once: audit evidence, a regression test
 * (strict replay, no model), and the source of an L2a recipe (export).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CascadePath, Expect } from '../types.js';
import type { SemanticKey } from '../snapshot/keys.js';

export interface TrajectoryStep {
  seq: number;
  turn?: number | string;
  ts: string;
  tool: string;
  path?: CascadePath | string;
  args: Record<string, unknown>;
  url?: string;
  target?: { role: string; name?: string; key?: SemanticKey; selector?: string };
  preHash?: string;
  outcome?: string;
  errorCode?: string;
  diff?: string;
  expect?: Expect;
  screenshot?: string;
}

export interface TrajectoryMeta {
  session: string;
  surface: 'browser' | 'desktop';
  goal?: string;
  model?: string;
  startedAt: string;
  endedAt?: string;
  versions: Record<string, string>;
  pathStats?: Record<string, number>;
  steps?: number;
}

export function pathStats(steps: Pick<TrajectoryStep, 'path'>[]): Record<string, number> {
  const s: Record<string, number> = {};
  for (const x of steps) if (x.path) s[x.path] = (s[x.path] ?? 0) + 1;
  return s;
}

export function formatPathStats(s: Record<string, number>): string {
  const order = ['L0', 'L1', 'L2a', 'L2b', 'L3'];
  const keys = [...order.filter((k) => s[k]), ...Object.keys(s).filter((k) => !order.includes(k))];
  return keys.length ? keys.map((k) => `${k}×${s[k]}`).join(' ') : '(no automation steps)';
}

export class TrajectoryRecorder {
  readonly file: string;
  readonly metaFile: string;
  private seq = 0;
  readonly steps: TrajectoryStep[] = [];
  meta: TrajectoryMeta;

  constructor(readonly dir: string, meta: Omit<TrajectoryMeta, 'startedAt'> & { startedAt?: string }) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'trajectory.jsonl');
    this.metaFile = path.join(dir, 'meta.json');
    this.meta = { startedAt: new Date().toISOString(), ...meta };
    if (fs.existsSync(this.file)) {
      for (const s of readTrajectory(dir).steps) {
        this.steps.push(s);
        this.seq = Math.max(this.seq, s.seq);
      }
    }
    this.flushMeta();
  }

  write(step: Omit<TrajectoryStep, 'seq' | 'ts'>): TrajectoryStep {
    const full: TrajectoryStep = { seq: ++this.seq, ts: new Date().toISOString(), ...step };
    this.steps.push(full);
    try {
      fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
    } catch {
      /* recording never breaks a run */
    }
    return full;
  }

  flushMeta(extra: Partial<TrajectoryMeta> = {}): void {
    this.meta = { ...this.meta, ...extra, pathStats: pathStats(this.steps), steps: this.steps.length };
    try {
      fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2));
    } catch {
      /* ignore */
    }
  }
}

export function readTrajectory(dir: string): { meta?: TrajectoryMeta; steps: TrajectoryStep[] } {
  const file = path.join(dir, 'trajectory.jsonl');
  const steps: TrajectoryStep[] = [];
  if (fs.existsSync(file))
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try {
        steps.push(JSON.parse(l));
      } catch {
        /* skip a torn line */
      }
    }
  let meta: TrajectoryMeta | undefined;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    meta = undefined;
  }
  return { meta, steps };
}
