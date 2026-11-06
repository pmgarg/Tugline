/**
 * `edit` config section (SPEC S0.4), owned by WS1. Declared by merging into
 * HarnessConfigExtensions so config.ts is not edited; defaults live here.
 */
import type { HarnessConfig } from '../config.js';

export type EditFormat = 'auto' | 'replace' | 'apply_patch' | 'whole';

export interface EditConfig {
  /** Which edit-tool family the model gets (A7). 'auto' picks per model; a profile's `editFormat` wins. */
  editFormat: EditFormat;
  /** write_file may overwrite an existing file (after a read) only up to this many lines; 0 = no limit (A5). */
  wholeFileMaxLines: number;
  /** Profile name of an optional apply model for failed anchors and lazy snippets (A8). Off when empty. */
  applyModel?: string;
  /** Formatter commands by glob, e.g. {"*.ts": "npx prettier --write {file}"} (A6). Off by default. */
  format: Record<string, string>;
  /** Post-edit verification: syntax check / IDE diagnostics appended to edit results (A6). */
  verify: boolean;
  /** Milliseconds to wait for IDE diagnostics after an edit. */
  diagnosticsWaitMs: number;
  /** Record per-model edit success in <homeDir>/model-stats.json (A7). */
  recordStats: boolean;
}

export const DEFAULT_EDIT: EditConfig = {
  editFormat: 'auto',
  wholeFileMaxLines: 400,
  applyModel: undefined,
  format: {},
  verify: true,
  diagnosticsWaitMs: 3000,
  recordStats: true,
};

declare module '../config.js' {
  interface HarnessConfigExtensions {
    edit?: Partial<EditConfig>;
  }
}

declare module '../types.js' {
  interface ModelProfileExtensions {
    /** Edit-tool family for this model (SPEC A7); overrides edit.editFormat. */
    editFormat?: EditFormat;
  }
}

export function editConfig(cfg: Pick<HarnessConfig, 'edit'> | undefined): EditConfig {
  const out = { ...DEFAULT_EDIT, ...(cfg?.edit ?? {}) };
  // D10 routing.editor names the apply model when edit.applyModel is not set explicitly.
  if (!out.applyModel) out.applyModel = (cfg as { routing?: { editor?: string } } | undefined)?.routing?.editor;
  return out;
}
