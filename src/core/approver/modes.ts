/**
 * N43: the permission modes every surface offers (CLI, /mode, VS Code picker, `tug serve`, ACP, SDKs,
 * schedules), in one place so no surface can drift or offer a mode the core does not have.
 */
import type { PermissionMode } from '../types.js';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'acceptEdits', 'plan', 'auto', 'yolo'];

export function isPermissionMode(x: unknown): x is PermissionMode {
  return typeof x === 'string' && (PERMISSION_MODES as readonly string[]).includes(x);
}

export const MODE_INFO: Record<PermissionMode, { name: string; description: string }> = {
  ask: { name: 'Ask', description: 'Edits, commands and network access ask for approval' },
  acceptEdits: { name: 'Accept edits', description: 'Workspace edits run without asking; commands ask' },
  plan: { name: 'Plan', description: 'Read-only: investigate and propose a plan' },
  auto: { name: 'Auto', description: 'Safe edits and reads run at once; commands, network and MCP calls are checked by a safety classifier that knows your request; risky calls ask you' },
  yolo: { name: 'YOLO', description: 'Run commands without asking and without a classifier (only dangerous commands ask). Use in a sandbox or a throwaway checkout' },
};

export const YOLO_WARNING =
  'WARNING: yolo mode runs commands and MCP tools WITHOUT approval and without the auto-mode safety classifier. Hard denies, protected paths and the sandbox still apply. Prefer `auto` unless you run in a container or a throwaway checkout.';

/** A user-facing error for a mode name that does not exist (with the migration hint for old configs). */
export function invalidModeMessage(x: unknown): string {
  return `unknown permission mode ${JSON.stringify(x)}: use ${PERMISSION_MODES.join(' | ')}`;
}
