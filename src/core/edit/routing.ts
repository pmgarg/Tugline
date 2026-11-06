/**
 * Model-adaptive edit format (SPEC A7, ED §2.6–2.7).
 *
 * One edit-tool family per session: models trained on V4A patches (gpt-*, gpt-oss,
 * codex) get `apply_patch`; everything else gets exact-anchor `edit_file` +
 * `multi_edit`; `whole` exposes only `write_file`. The choice is made when the
 * tool list is built and never changes mid-session (a changing tool list breaks
 * the prompt-prefix cache).
 *
 * Per-model outcomes are kept in <homeDir>/model-stats.json as
 * {model: {tool: {ok, fail}}}. Only match failures count as failures (not
 * permission denials or read-before-edit refusals). When `replace` succeeds
 * < 60 % over ≥ 20 attempts and apply_patch was never tried, the harness
 * suggests switching (a notice; it never switches by itself).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import { resolveProfile } from '../config.js';
import { editConfig, type EditFormat } from './config.js';

export type ResolvedEditFormat = Exclude<EditFormat, 'auto'>;

/** Static routing table for `auto`. */
export function autoEditFormat(model: string): 'replace' | 'apply_patch' {
  const m = model.toLowerCase();
  if (/gpt-oss|codex|(^|[/:])gpt-/.test(m)) return 'apply_patch';
  return 'replace';
}

export function resolveEditFormat(cfg: HarnessConfig): ResolvedEditFormat {
  let model = '';
  let profileFormat: EditFormat | undefined;
  try {
    const p = resolveProfile(cfg);
    model = p.model;
    profileFormat = p.editFormat;
  } catch {
    /* unknown profile: fall through to defaults */
  }
  const f = profileFormat ?? editConfig(cfg).editFormat;
  if (f === 'replace' || f === 'apply_patch' || f === 'whole') return f;
  return autoEditFormat(model);
}

/** Tool names in each family. write_file is always available for creating files. */
export const EDIT_FAMILIES: Record<ResolvedEditFormat, string[]> = {
  replace: ['edit_file', 'multi_edit', 'write_file'],
  apply_patch: ['apply_patch', 'write_file'],
  whole: ['write_file'],
};

export const EDIT_TOOL_NAMES = ['edit_file', 'multi_edit', 'apply_patch', 'write_file'];

// ------------------------------------------------------------ stats

export type ModelStats = Record<string, Record<string, { ok: number; fail: number }>>;

export function statsFile(homeDir: string): string {
  return path.join(homeDir, 'model-stats.json');
}

export function readModelStats(homeDir: string): ModelStats {
  try {
    const j = JSON.parse(fs.readFileSync(statsFile(homeDir), 'utf8'));
    return j && typeof j === 'object' ? (j as ModelStats) : {};
  } catch {
    return {};
  }
}

/** Count one edit outcome. Best effort: stats must never break an edit. */
export function recordEditOutcome(homeDir: string | undefined, model: string | undefined, tool: string, ok: boolean): void {
  if (!homeDir || !model) return;
  try {
    const stats = readModelStats(homeDir);
    const m = (stats[model] ??= {});
    const t = (m[tool] ??= { ok: 0, fail: 0 });
    if (ok) t.ok++;
    else t.fail++;
    fs.mkdirSync(homeDir, { recursive: true });
    const file = statsFile(homeDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    /* ignore */
  }
}

/** Advice when the replace family is failing for this model; undefined when there is nothing to say. */
export function switchAdvice(stats: ModelStats, model: string): string | undefined {
  const m = stats[model];
  if (!m) return undefined;
  const ok = (m.edit_file?.ok ?? 0) + (m.multi_edit?.ok ?? 0);
  const fail = (m.edit_file?.fail ?? 0) + (m.multi_edit?.fail ?? 0);
  const n = ok + fail;
  const triedPatch = (m.apply_patch?.ok ?? 0) + (m.apply_patch?.fail ?? 0) > 0;
  if (n < 20 || triedPatch || ok / n >= 0.6) return undefined;
  return `edit_file/multi_edit succeed only ${Math.round((100 * ok) / n)}% of the time for ${model} (${n} attempts). Consider setting "editFormat": "apply_patch" on this profile (or edit.editFormat) for the next session.`;
}
