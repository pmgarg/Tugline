/**
 * The permission engine for a config, built the way an agent session builds it (v1.2 WS24 review F7): the board and
 * arena merge and the tree check decide with the same options as the agent (allow/deny rules, protected paths,
 * additional directories, the user-scope read-only setting), not a reduced copy.
 */
import os from 'node:os';
import path from 'node:path';
import { readUserConfigFile, type HarnessConfig } from '../config.js';
import { PermissionPolicy } from './policy.js';

export function policyForConfig(cfg: HarnessConfig, workspace: string, o: { readOnlyRoots?: string[]; mode?: HarnessConfig['permissionMode'] } = {}): PermissionPolicy {
  return new PermissionPolicy({
    workspace,
    mode: o.mode ?? cfg.permissionMode,
    allow: cfg.permissions.allow,
    deny: cfg.permissions.deny,
    protectedPaths: cfg.permissions.protectedPaths,
    additionalDirectories: cfg.permissions.additionalDirectories ?? [],
    readOnlyRoots: o.readOnlyRoots ?? [path.join(os.tmpdir())],
    readOnlyCommands: readUserConfigFile(cfg.homeDir).permissions?.readOnlyCommands === true,
  });
}
