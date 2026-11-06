/**
 * Line diff (Myers O((N+M)·D) after trimming the common prefix/suffix). Used to
 * locate changed regions for post-edit snippets (A6) and to size-check apply-model
 * output (A8). No dependency.
 */

export interface Hunk {
  /** 0-based start and length in the old lines */
  oldStart: number;
  oldLines: number;
  /** 0-based start and length in the new lines */
  newStart: number;
  newLines: number;
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Diff two line arrays into change hunks. `maxD` bounds the work; beyond it one coarse hunk is returned. */
export function diffLines(a: string[], b: string[], maxD = 4000): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length) return [{ oldStart: pre, oldLines: A.length, newStart: pre, newLines: B.length }];

  const N = A.length;
  const M = B.length;
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const nv = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      nv[off + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
    v = nv;
  }
  if (!found) return [{ oldStart: pre, oldLines: N, newStart: pre, newLines: M }];
  trace.push(v);
  // backtrack into a list of edit operations
  const ops: ('=' | '-' | '+')[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      ops.push('+');
      y--;
    } else {
      ops.push('-');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('=');
    x--;
    y--;
  }
  ops.reverse();
  const hunks: Hunk[] = [];
  let ia = 0;
  let ib = 0;
  let cur: Hunk | null = null;
  for (const op of ops) {
    if (op === '=') {
      if (cur) hunks.push(cur);
      cur = null;
      ia++;
      ib++;
      continue;
    }
    if (!cur) cur = { oldStart: pre + ia, oldLines: 0, newStart: pre + ib, newLines: 0 };
    if (op === '-') {
      cur.oldLines++;
      ia++;
    } else {
      cur.newLines++;
      ib++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

export function diffCounts(before: string, after: string): { removed: number; added: number; hunks: Hunk[] } {
  const hunks = diffLines(splitLines(before), splitLines(after));
  return { removed: hunks.reduce((s, h) => s + h.oldLines, 0), added: hunks.reduce((s, h) => s + h.newLines, 0), hunks };
}
