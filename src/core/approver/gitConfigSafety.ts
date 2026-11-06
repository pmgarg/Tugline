/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: ported from Qwen Code
 * packages/core/src/utils/git-config-safety.ts (commit c726d2c) for the N43 read-only
 * fast path. Added `core.pager`, `diff.*.textconv`/`diff.*.command` and `core.sshCommand`
 * to the keys that make a "read-only" git command run a program; re-check finding H (2026-11-05): also
 * `filter.*.clean|smudge|process`, any `gpg.*` and `log.showSignature`, `merge.*.driver`, `core.askPass`,
 * `credential.*`, any `includeIf.*` (a conditional include can point anywhere), and repository attribute files
 * (`.gitattributes` anywhere in the work tree, `.git/info/attributes`) that select a filter, diff or merge driver.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface LocalGitConfigRisk {
  diffExternal: boolean;
  fsmonitor: boolean;
  /** Tugline: a pager, a diff driver command or textconv filter configured in the repository's own config */
  helper: boolean;
}

const NO_RISK: LocalGitConfigRisk = {
  diffExternal: false,
  fsmonitor: false,
  helper: false,
};
const PROBE_FAILED: LocalGitConfigRisk = {
  diffExternal: true,
  fsmonitor: true,
  helper: true,
};

export function getLocalGitConfigRisk(cwd: string): LocalGitConfigRisk {
  try {
    if (!statSync(cwd).isDirectory()) return NO_RISK;
  } catch {
    return NO_RISK;
  }

  const result = spawnSync(
    'git',
    [
      '-C',
      cwd,
      'config',
      '--includes',
      '--show-scope',
      '--null',
      '--get-regexp',
      '^diff\\.external$|^core\\.fsmonitor$|^core\\.pager$|^pager\\.|^diff\\..*\\.(textconv|command)$|^core\\.sshcommand$|^filter\\.|^gpg\\.|^log\\.showsignature$|^merge\\..*\\.driver$|^core\\.askpass$|^credential\\.|^includeif\\.',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 1000,
      windowsHide: true,
    },
  );

  if (result.status === 1) return NO_RISK;
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return PROBE_FAILED;
  }

  const effective = new Map<string, { scope: string; value: string }>();
  const fields = result.stdout.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const entry = fields[i + 1]!;
    const newline = entry.indexOf('\n');
    if (newline < 0) return PROBE_FAILED;
    effective.set(entry.slice(0, newline), {
      scope: fields[i]!,
      value: entry.slice(newline + 1),
    });
  }

  const localValue = (key: string): string | undefined => {
    const entry = effective.get(key);
    return entry && (entry.scope === 'local' || entry.scope === 'worktree')
      ? entry.value.trim()
      : undefined;
  };
  const diffExternal = localValue('diff.external');
  const fsmonitor = localValue('core.fsmonitor');

  const helper =
    [...effective.entries()].some(
      ([k, e]) =>
        (e.scope === 'local' || e.scope === 'worktree') &&
        /^(?:core\.pager|pager\..*|diff\..*\.(?:textconv|command)|core\.sshcommand|filter\..*|gpg\..*|log\.showsignature|merge\..*\.driver|core\.askpass|credential\..*|includeif\..*)$/i.test(k) &&
        e.value.trim() !== '',
    ) || attributesSelectDriver(cwd);
  return {
    helper,
    diffExternal: diffExternal !== undefined && diffExternal !== '',
    fsmonitor:
      fsmonitor !== undefined &&
      fsmonitor !== '' &&
      !/^(?:true|false|yes|no|on|off|0|1)$/i.test(fsmonitor),
  };
}

/**
 * Tugline (re-check finding H): attribute files in the repository that select a filter, diff or merge driver.
 * The driver itself is defined in some config (often the user's global one, e.g. git-lfs), but which files it runs
 * on is decided by the repository, so a "read-only" status/diff/log is not read-only there. Any attribute file we
 * cannot list or read counts as selecting one.
 */
function attributesSelectDriver(cwd: string): boolean {
  const DRIVER = /(?:^|\s)(?:filter|diff|merge)=/m;
  const top = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--git-path', 'info/attributes'], { encoding: 'utf8', timeout: 1000, windowsHide: true });
  if (top.status === 128 && /not a git repository/i.test(String(top.stderr))) return false; // no repository: no attributes
  const files = spawnSync('git', ['-C', cwd, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name', '--', ':(top,glob)**/.gitattributes', ':(top).gitattributes'], { encoding: 'utf8', maxBuffer: 1 << 20, timeout: 2000, windowsHide: true });
  if (files.status !== 0 || top.status !== 0) return true;
  const [root, info] = top.stdout.split('\n');
  if (!root) return true;
  const paths = [...new Set(files.stdout.split('\0').filter(Boolean))].map((f) => path.join(root, f));
  if (info) paths.push(path.resolve(cwd, info));
  for (const f of paths) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return true;
    }
    if (DRIVER.test(text)) return true;
  }
  return false;
}
