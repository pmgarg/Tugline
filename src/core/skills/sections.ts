/**
 * System-prompt sections contributed by WS7 (SPEC G5 imported rules, G7 output
 * style). prompt.ts (WS4) calls these at two fixed places, so the prompt layout
 * and its byte-stability stay under prompt.ts's control.
 */
import type { HarnessConfig } from '../config.js';
import { rulesPromptSection } from './compat.js';
import { outputStyleSection } from './outputStyles.js';

/** After the project instructions (AGENTS.md …): rules imported from Cursor, Cline and Gemini files. */
export function importedRulesSection(workspace: string, compact: boolean): string {
  try {
    return rulesPromptSection(workspace, compact);
  } catch {
    return '';
  }
}

/** Near the end: the configured output style. */
export function styleSection(cfg: HarnessConfig, workspace: string): string {
  try {
    return outputStyleSection(cfg, workspace);
  } catch {
    return '';
  }
}
