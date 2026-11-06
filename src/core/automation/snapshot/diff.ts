/**
 * Line diff between two rendered snapshots (SPEC E2): after an action the model
 * gets only the changed lines ("+ " added, "- " removed), not the page again.
 * That is S10's verify step at small token cost.
 */

export interface LineDiff {
  added: string[];
  removed: string[];
  /** "+ …" / "- …" lines in document order */
  text: string;
  changed: boolean;
}

/** Snapshot lines start with "- "; drop it so a diff line reads "+ button …", not "+ - button …". */
function strip(l: string): string {
  return l.trimStart().replace(/^- /, '');
}

/** LCS diff on the middle section after trimming the common prefix and suffix. */
export function lineDiff(before: string, after: string, maxLines = 80): LineDiff {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const ops: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  if (am.length * bm.length <= 4_000_000) {
    // Classic DP; the trimmed middle is small in practice (one action's effect).
    const n = am.length;
    const m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push(`- ${strip(am[i])}`);
        removed.push(am[i++]);
      } else {
        ops.push(`+ ${strip(bm[j])}`);
        added.push(bm[j++]);
      }
    }
    while (i < n) {
      ops.push(`- ${strip(am[i])}`);
      removed.push(am[i++]);
    }
    while (j < m) {
      ops.push(`+ ${strip(bm[j])}`);
      added.push(bm[j++]);
    }
  } else {
    // Too large for DP: fall back to multiset difference (order is approximate).
    const count = new Map<string, number>();
    for (const l of bm) count.set(l, (count.get(l) ?? 0) + 1);
    for (const l of am) {
      const c = count.get(l) ?? 0;
      if (c > 0) count.set(l, c - 1);
      else {
        removed.push(l);
        ops.push(`- ${strip(l)}`);
      }
    }
    const left = new Map<string, number>();
    for (const l of am) left.set(l, (left.get(l) ?? 0) + 1);
    for (const l of bm) {
      const c = left.get(l) ?? 0;
      if (c > 0) left.set(l, c - 1);
      else {
        added.push(l);
        ops.push(`+ ${strip(l)}`);
      }
    }
  }
  const shown = ops.length > maxLines ? [...ops.slice(0, maxLines), `… ${ops.length - maxLines} more changed lines (call browser_snapshot for the full page)`] : ops;
  return { added, removed, text: shown.join('\n'), changed: ops.length > 0 };
}
