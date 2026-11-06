/**
 * WS3 (safety, recovery, governance) side-effect registrations: agent
 * extensions, slash commands and the sandbox command wrapper. Imported once
 * from src/core/tools/providers.ts (the per-workstream import seam, SPEC §2).
 */
import '../checkpoint/index.js';
import '../sandbox/index.js';
import '../approver/index.js';
import './limits.js';
import '../agent/hooks.js';
import './protect.js';
import './audit.js';

import { registerAgentExtension } from '../agent/extensions.js';
import type { PermissionPolicy } from './policy.js';

/**
 * SPEC C5 config → policy. agent.ts builds the PermissionPolicy from the v0.1
 * permission keys only; the ignore-file keys under `permissions` are applied
 * here before each run (shared-file edit avoided; see WS3-NOTES).
 */
registerAgentExtension({
  id: 'ws3-ignore-config',
  onRunStart(a) {
    const pol = (a.agent as { policy?: PermissionPolicy }).policy;
    if (!pol) return;
    const p = a.config.permissions as { ignoreMode?: 'ask' | 'deny'; gitignoreReads?: 'allow' | 'ask'; hideGitignored?: boolean };
    if (p.ignoreMode === 'ask' || p.ignoreMode === 'deny') pol.opts.ignoreMode = p.ignoreMode;
    if (p.gitignoreReads === 'allow' || p.gitignoreReads === 'ask') pol.opts.gitignoreReads = p.gitignoreReads;
    if (typeof p.hideGitignored === 'boolean') pol.opts.hideGitignored = p.hideGitignored;
  },
});
