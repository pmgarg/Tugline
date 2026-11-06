/**
 * The sandbox state in VS Code's status bar (v1.1 N30): the same one-line
 * `sandboxStatus(cfg).summary` the CLI banner and `tug doctor` print, as a
 * status bar item. Warning style when commands run unsandboxed in `auto` mode
 * (nothing asks before a command runs), error style when a required sandbox is
 * missing and commands are refused. Pure (no `vscode` import).
 */
import type { SandboxStatus } from '../../src/core/sandbox/index.js';
import type { PermissionMode } from '../../src/core/types.js';

export interface SandboxBadge {
  text: string;
  tooltip: string;
  level: 'ok' | 'info' | 'warn' | 'error';
}

export function sandboxBadge(st: Pick<SandboxStatus, 'runner' | 'refusing' | 'summary'>, mode: PermissionMode | string | undefined): SandboxBadge {
  if (st.refusing) return { text: '$(error) sandbox required', tooltip: `Tugline ${st.summary}`, level: 'error' };
  if (st.runner !== 'none') return { text: `$(shield) sandbox: ${st.runner}`, tooltip: `Tugline ${st.summary}`, level: 'ok' };
  if (mode === 'auto')
    return { text: '$(warning) unsandboxed (auto mode)', tooltip: `Tugline ${st.summary}. In auto mode commands run without asking; turn on shell.sandbox ("auto") or use another permission mode.`, level: 'warn' };
  return { text: '$(unlock) no sandbox', tooltip: `Tugline ${st.summary}`, level: 'info' };
}
