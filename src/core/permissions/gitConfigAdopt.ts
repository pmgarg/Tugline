/**
 * R1 guard, v1.2 UI tour: which edits to `.git/config` the protected-file guard keeps instead of restoring.
 *
 * `.git/config` is protected because some of its keys make git run programs later: `core.hooksPath`,
 * `core.fsmonitor`, `core.sshCommand`, `filter.*`, `diff.*.command`, `alias.*`, `include.path` and others. Restoring
 * every edit also rolled back routine changes from the user and from git itself, such as VS Code's "Publish Branch" or
 * `git push -u` (branch tracking) and `git remote add`, and reported them as errors.
 *
 * A change is kept only when every key it adds, removes or changes is on a short allowlist, and every value passes
 * the rules below. Anything else in the same change (one unsafe key is enough) gets the old behaviour: restored, with
 * a backup.
 *
 * Two tiers:
 *  - **Tracking and identity**, kept from any source, including the agent's own commands:
 *    `branch.<b>.remote|pushremote|merge|rebase|description|vscode-merge-base*` and `user.name|email`. A branch's
 *    remote/pushremote must be `.` or a remote that already exists: git reads any other value as a URL or path.
 *  - **Remote URLs** (`remote.<r>.url|pushurl|fetch`), kept only for the user's own edits, and only when the agent
 *    could not have made them: no command or job in flight, no agent process alive, and an OS sandbox that mounts
 *    `.git/config` read-only for agent commands (protect.ts). An agent that points `origin` at another host would
 *    send the user's next push there, outside the sandbox's network rules. Without a sandbox there is no reliable way
 *    to tell the two apart, so remote edits are restored as before.
 *
 * Values that name a remote or URL never contain `::`, which is git's transport-helper syntax: `ext::<command>` runs a
 * command, and `<x>::` runs a `git-remote-<x>` helper. They never start with `-` (option injection) and never contain
 * control characters. `branch.<b>.rebase` takes only `true`, `false` or `merges`.
 *
 * Both versions are parsed by git itself (`git config --file … --no-includes --list -z`), with no system or global
 * config and nothing to run: listing config never executes anything. A file git cannot parse is not kept.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRACKING: RegExp[] = [
  /^branch\..+\.(?:remote|pushremote|merge|description)$/,
  /^branch\..+\.vscode-merge-base[a-z0-9-]*$/,
  /^branch\..+\.rebase$/,
  /^user\.(?:name|email)$/,
];
const REMOTES: RegExp[] = [/^remote\..+\.(?:url|pushurl|fetch)$/];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function valueOk(key: string, v: string): boolean {
  if (CONTROL.test(v) && !/\.description$/.test(key)) return false;
  if (/\.rebase$/.test(key)) return ['true', 'false', 'merges'].includes(v.toLowerCase());
  if (/\.(?:url|pushurl|remote|pushremote)$/.test(key)) return !v.includes('::') && !v.startsWith('-') && v.length > 0 && v.length <= 2048;
  if (/\.(?:merge|fetch)$/.test(key)) return !v.startsWith('-') && v.length <= 1024;
  return v.length <= 4096;
}

/** Parse a config file with git: key → values in file order. Undefined when git cannot read it. */
export function listGitConfig(file: string): Map<string, string[]> | undefined {
  try {
    const out = execFileSync('git', ['config', '--no-includes', '--file', file, '--null', '--list'], {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 << 20,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, HOME: os.tmpdir(), LC_ALL: 'C' },
    });
    const m = new Map<string, string[]>();
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const nl = rec.indexOf('\n');
      const k = nl < 0 ? rec : rec.slice(0, nl);
      const v = nl < 0 ? '' : rec.slice(nl + 1); // a key with no "=" is a boolean true
      m.set(k, [...(m.get(k) ?? []), v]);
    }
    return m;
  } catch {
    return undefined;
  }
}

export interface GitConfigVerdict {
  keep: boolean;
  /** the keys that changed (for the record) */
  keys: string[];
  reason?: string;
}

/**
 * Decide whether the change from `before` to `after` (two config files' contents) can be kept.
 * `userEdit`: the change happened outside any agent command, with no agent process left running.
 */
export function judgeGitConfigChange(before: Buffer, after: Buffer, o: { userEdit: boolean }): GitConfigVerdict {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-gitcfg-'));
  try {
    const a = path.join(dir, 'before');
    const b = path.join(dir, 'after');
    fs.writeFileSync(a, before, { mode: 0o600 });
    fs.writeFileSync(b, after, { mode: 0o600 });
    const A = listGitConfig(a);
    const B = listGitConfig(b);
    if (!A || !B) return { keep: false, keys: [], reason: 'git could not parse the file' };
    const keys = [...new Set([...A.keys(), ...B.keys()])].filter((k) => JSON.stringify(A.get(k) ?? []) !== JSON.stringify(B.get(k) ?? []));
    if (!keys.length) return { keep: true, keys }; // formatting or comments only
    const allowed = o.userEdit ? [...TRACKING, ...REMOTES] : TRACKING;
    // review H1: git reads a branch's remote/pushremote that is not a configured remote as a URL or a path, so a
    // tracking edit may only name '.' or a remote that already exists (for the user's own edit, also one added in the
    // same change, whose URL is judged above). Otherwise `pushremote = ./evil.git` runs that repo's hooks on push.
    const remotesIn = (m: Map<string, string[]>) => new Set([...m.keys()].map((k) => /^remote\.(.+)\.url$/.exec(k)?.[1]).filter((x): x is string => !!x));
    const known = new Set([...remotesIn(A), ...(o.userEdit ? remotesIn(B) : [])]);
    for (const k of keys) {
      if (!allowed.some((r) => r.test(k))) return { keep: false, keys, reason: `${k} is not a key the guard keeps${!o.userEdit && REMOTES.some((r) => r.test(k)) ? ' from an agent command' : ''}` };
      for (const v of B.get(k) ?? []) {
        if (!valueOk(k, v)) return { keep: false, keys, reason: `${k} has a value the guard does not keep` };
        if (/^branch\..+\.(?:remote|pushremote)$/.test(k) && v !== '.' && !known.has(v)) return { keep: false, keys, reason: `${k} names "${v}", which is not a configured remote` };
      }
    }
    return { keep: true, keys };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export const sha256Buf = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
