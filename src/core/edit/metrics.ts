/**
 * Edit metrics for eval reports (SPEC A9), computed from raw run records (the
 * same journals `tug rescore` uses), so they can be recomputed without a model:
 *
 *  - first-try edit success: per (run, file), the first edit call on the file applied;
 *  - recovered after error: per (run, file) whose first edit failed, a later one applied;
 *  - corrupted file: runs whose integrity acceptance command (": integrity; …")
 *    failed, i.e. bytes outside the intended change were damaged;
 *  - tier histogram: which matcher tier (A1) / patch tier each applied edit needed.
 *
 * Only edit-format failures count as failed attempts (not found, ambiguous,
 * malformed patch or block); policy refusals and read-before-edit errors are not
 * the edit engine's doing and are left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RawRunRecord } from '../eval/scorer.js';
import { patchPaths } from './applyPatch.js';

export const INTEGRITY_PREFIX = ': integrity;';
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit', 'apply_patch']);
const EDIT_FAILURE = /was not found in|appears? \d+ times|Failed to find (expected lines|context)|invalid patch|invalid hunk|malformed edit block|edit block .*(no SEARCH|not closed|no path)|identical; nothing to change|No files were modified/;

export interface Ratio {
  ok: number;
  total: number;
}

export interface EditMetrics {
  runs: number;
  editCalls: { ok: number; failed: number };
  firstTry: Ratio;
  recovered: Ratio;
  corrupted: Ratio;
  tiers: Record<string, number>;
}

function pathsOf(name: string, args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  if (name === 'apply_patch') return patchPaths(String(args.input ?? args.patch ?? ''), (p) => p.trim());
  return typeof args.path === 'string' ? [args.path.replace(/^\.\//, '')] : [];
}

export function editMetrics(records: RawRunRecord[]): EditMetrics {
  const m: EditMetrics = { runs: records.length, editCalls: { ok: 0, failed: 0 }, firstTry: { ok: 0, total: 0 }, recovered: { ok: 0, total: 0 }, corrupted: { ok: 0, total: 0 }, tiers: {} };
  for (const r of records) {
    const starts = new Map<string, { name: string; args?: Record<string, unknown> }>();
    const perFile = new Map<string, boolean[]>();
    for (const e of r.events) {
      if (e.type === 'tool_start' && typeof e.id === 'string') starts.set(e.id, { name: String(e.name), args: e.args as Record<string, unknown> | undefined });
      if (e.type !== 'tool_end' || typeof e.id !== 'string') continue;
      const name = String(e.name);
      const meta = (e.meta ?? {}) as Record<string, unknown>;
      if (e.ok && name === 'write_file' && meta.created === false) m.tiers[String(meta.editTier ?? 'whole')] = (m.tiers[String(meta.editTier ?? 'whole')] ?? 0) + 1;
      if (!EDIT_TOOLS.has(name)) continue;
      if (!e.ok && !EDIT_FAILURE.test(String(e.output ?? ''))) continue;
      const ok = !!e.ok;
      if (ok) {
        m.editCalls.ok++;
        const tiers = Array.isArray(meta.editTiers) && meta.editTiers.length ? (meta.editTiers as string[]) : [String(meta.editTier ?? 'exact')];
        for (const t of tiers) m.tiers[t] = (m.tiers[t] ?? 0) + 1;
      } else m.editCalls.failed++;
      for (const p of pathsOf(name, starts.get(e.id)?.args)) {
        if (!perFile.has(p)) perFile.set(p, []);
        perFile.get(p)!.push(ok);
      }
    }
    for (const outcomes of perFile.values()) {
      m.firstTry.total++;
      if (outcomes[0]) m.firstTry.ok++;
      else {
        m.recovered.total++;
        if (outcomes.slice(1).some(Boolean)) m.recovered.ok++;
      }
    }
    const integrity = r.acceptance.filter((a) => a.command.startsWith(INTEGRITY_PREFIX));
    if (integrity.length) {
      m.corrupted.total++;
      if (integrity.some((a) => a.exitCode !== 0)) m.corrupted.ok++;
    }
  }
  return m;
}

const pct = (r: Ratio) => (r.total ? `${r.ok}/${r.total} (${Math.round((100 * r.ok) / r.total)}%)` : 'n/a');

export function renderEditMetrics(rows: { arm: string; m: EditMetrics }[]): string {
  const lines = [
    '## Edit metrics (SPEC A9)',
    '',
    '| arm | runs | first-try edit success | recovered after error | corrupted file | edit calls ok / failed | tier histogram |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const { arm, m } of rows) {
    const tiers = Object.entries(m.tiers).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || '—';
    lines.push(`| ${arm} | ${m.runs} | ${pct(m.firstTry)} | ${pct(m.recovered)} | ${pct(m.corrupted)} | ${m.editCalls.ok} / ${m.editCalls.failed} | ${tiers} |`);
  }
  lines.push('', 'first-try: per (run, file), the first edit call applied. recovered: per (run, file) whose first edit failed, a later edit applied. corrupted: the integrity acceptance check failed (bytes outside the change were damaged). Policy refusals are not counted as edit failures.');
  return lines.join('\n');
}

/**
 * Append the edit metrics to <outDir>/report.md and write edit-metrics.json, when
 * the runs contain edit calls or integrity checks. Returns the markdown ('' if none).
 */
export function appendEditMetrics(outDir: string): string {
  const runsDir = path.join(outDir, 'runs');
  if (!fs.existsSync(runsDir)) return '';
  const records = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')) as RawRunRecord);
  const all = editMetrics(records);
  if (!all.editCalls.ok && !all.editCalls.failed && !all.corrupted.total) return '';
  const arms = [...new Set(records.map((r) => r.manifest.arm))];
  const rows = [...arms.map((arm) => ({ arm, m: editMetrics(records.filter((r) => r.manifest.arm === arm)) })), ...(arms.length > 1 ? [{ arm: 'all', m: all }] : [])];
  const md = renderEditMetrics(rows);
  fs.writeFileSync(path.join(outDir, 'edit-metrics.json'), JSON.stringify(Object.fromEntries(rows.map((r) => [r.arm, r.m])), null, 2));
  const report = path.join(outDir, 'report.md');
  if (fs.existsSync(report)) fs.appendFileSync(report, `\n${md}\n`);
  return md;
}
