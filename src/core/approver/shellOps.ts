/**
 * N43 inventory "build" (capability from Qwen Code shell-semantics.ts, c726d2c; our own code): the
 * virtual file and network operations a shell command performs, so a user's deny or ask rule on a
 * file or web tool (`read_file(secrets/**)`, `Read(.env)`, `write_file(docs/**)`, `web_fetch(domain:x)`)
 * also applies to the shell spelling of the same operation (`cat secrets/k`, `echo > docs/x`,
 * `curl https://x/…`). Escalation only: an op can make a call deny or ask, never allow it.
 *
 * Static analysis has limits (variables, interpreters, `xargs`); those spellings are what the
 * prefilter's obfuscation rules, the sandbox and the classifier are for.
 */
import path from 'node:path';
import { normalizeCommand } from './normalize.js';
import { shellWriteTargets } from '../permissions/shellWrites.js';

export interface ShellOps {
  reads: string[];
  writes: string[];
  domains: string[];
}

/** Programs whose non-flag arguments (after the pattern, for grep-likes) are files they read. */
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'tac', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'jq', 'yq', 'wc', 'sort', 'uniq', 'cut', 'diff', 'cmp', 'md5sum', 'sha256sum', 'sha1sum', 'file', 'stat', 'source', '.', 'zcat', 'gunzip', 'openssl', 'iconv', 'awk', 'gawk', 'sed', 'cp', 'scp', 'rsync', 'tar', 'zip', 'gpg', 'sqlite3', 'python', 'python3', 'node', 'ruby', 'perl']);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const FETCHERS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'aria2c', 'httpie']);
/** Flags whose next argument is a value, not a file. */
const VALUE_FLAGS = new Set(['-e', '-f', '-m', '-n', '-A', '-B', '-C', '-o', '-O', '-H', '-X', '-d', '-u', '-t', '-T', '-c', '-i', '-I', '-k']);
const GREP_VALUE_FLAGS = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-g', '--glob', '-t', '--type', '-T', '--max-count']);

function hostOf(arg: string): string | undefined {
  const m = arg.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^/@\s]*@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i);
  return m?.[1]?.toLowerCase();
}

export function shellOps(command: string, cwd: string, depth = 0): ShellOps {
  const out: ShellOps = { reads: [], writes: [], domains: [] };
  let n;
  try {
    n = normalizeCommand(command);
  } catch {
    return out;
  }
  let dir = cwd;
  for (const c of n.commands) {
    const [prog, ...args] = c.argv;
    if (!prog) continue;
    if (prog === 'cd' && args.length <= 1) {
      if (args[0] && !/^[$~-]/.test(args[0])) dir = path.resolve(dir, args[0]);
      continue;
    }
    for (const r of c.redirs) if (/^<(?!<)/.test(r.op) && r.target) out.reads.push(path.resolve(dir, r.target));
    const valueFlags = GREPS.has(prog) ? GREP_VALUE_FLAGS : VALUE_FLAGS;
    const pos: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--') {
        pos.push(...args.slice(i + 1));
        break;
      }
      if (a.startsWith('-')) {
        if (valueFlags.has(a)) i++;
        continue;
      }
      pos.push(a);
    }
    if (FETCHERS.has(prog) || (prog === 'git' && ['clone', 'fetch', 'pull', 'ls-remote'].includes(args[0] ?? ''))) {
      for (const a of args) {
        const h = /^[a-z]+:\/\//i.test(a) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(a) || /^git@/.test(a) ? hostOf(a.replace(/^git@([^:]+):/, 'https://$1/')) : undefined;
        if (h) out.domains.push(h);
      }
      continue;
    }
    if (GREPS.has(prog)) {
      const explicitPattern = args.some((a) => a === '-e' || a === '-f' || a.startsWith('--regexp') || a.startsWith('--file'));
      for (const p of explicitPattern ? pos : pos.slice(1)) out.reads.push(path.resolve(dir, p));
      continue;
    }
    if (READERS.has(prog)) {
      // `sed 's/a/b/' f` / `awk '{…}' f`: the first positional is the script
      const files = prog === 'sed' || prog === 'awk' || prog === 'gawk' ? pos.slice(1) : prog === 'cp' || prog === 'scp' || prog === 'rsync' ? pos.slice(0, -1) : pos;
      for (const p of files) if (!/^[a-z]+:\/\//i.test(p) && !/^[\w.-]+@[\w.-]+:/.test(p)) out.reads.push(path.resolve(dir, p));
    }
  }
  try {
    out.writes.push(...shellWriteTargets(command, cwd).map((w) => w.path));
  } catch {
    /* best effort */
  }
  if (depth < 3)
    for (const inner of [...n.shell, ...n.subst]) {
      const o = shellOps(inner, dir, depth + 1);
      out.reads.push(...o.reads);
      out.writes.push(...o.writes);
      out.domains.push(...o.domains);
    }
  return { reads: [...new Set(out.reads)], writes: [...new Set(out.writes)], domains: [...new Set(out.domains)] };
}
