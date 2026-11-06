/**
 * N36 (first layer, before the OS sandbox): does a file read or a shell command reach a credential store?
 *
 * Reading one asks in every mode, auto included (policy.ts). This is the only layer when no OS sandbox runs
 * (sandbox.runner "none", or the policy-only fallback), so it resolves a command the way the shell would rather than
 * matching text (review finding 13):
 *   - quotes are removed and adjacent parts joined (`~/".ssh"/id`, `.s''sh`), `~`, `$HOME`, `${HOME}` and variables
 *     assigned earlier in the command (`H=$HOME; cat $H/.ssh/id`) are expanded, `$(echo ~)` / `` `printf ~` `` too;
 *   - `cd` is followed (`cd ~/ ; cat .ssh/id`, `cd .. && cat .ssh/id`);
 *   - unquoted globs are matched against the stores segment by segment (`~/.ss?/*`, `/proc/1/env*on`);
 *   - recursive readers (`grep -r`, `rg`, `tar`, `zip`, `cp -r`, `rsync`, `scp -r`, `find … -exec`) aimed at a
 *     directory that CONTAINS a store (the home directory, `/`) count as reading it;
 *   - `echo` / `printf` only mention a path (no read);
 *   - inline code (`python -c "open('…')"`) is scanned for store paths.
 * A path inside the workspace is exempt only when a store contains the workspace (an H5 clone under ~/.tugline),
 * never when the workspace contains a store (workspace = the home directory: review finding 5).
 * It stays best-effort (a command can build a path at run time); the OS sandbox is the control that holds.
 */
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';
import { DAEMON_CLIENT, DAEMON_SOCKET, DEFAULT_DENY_READ, expandTilde, runtimeSocketDirs } from '../sandbox/settings.js';
import { isInside, realResolve, splitCommandSegments } from './policy.js';

export interface CredentialQuery {
  command?: string;
  paths?: string[];
  cwd: string;
  workspace: string;
  /** stores in addition to the defaults (sandbox.denyRead, the harness home) */
  credentialPaths?: string[];
  /** default stores the user lets commands read (sandbox.allowRead, user scope) */
  allowRead?: string[];
}

interface Word {
  text: string;
  /** an unquoted glob character is present */
  glob: boolean;
}

const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env', 'xargs', 'sudo', 'doas', 'timeout', 'stdbuf', 'ionice', 'chroot', 'unbuffer']);
const MENTION_ONLY = new Set(['echo', 'printf', 'true', ':', 'false']);
const RECURSIVE_ALWAYS = new Set(['rg', 'ag', 'ack', 'rgrep', 'tar', 'bsdtar', 'zip', '7z', '7za', 'rsync', 'borg', 'restic', 'duplicity', 'zstd', 'cpio']);
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'rgrep']);

/** Words of one simple command: quotes removed and joined, variables and ~ expanded, glob-ness kept. */
function words(seg: string, vars: Map<string, string>, home: string): Word[] {
  const out: Word[] = [];
  let cur = '';
  let glob = false;
  let started = false;
  let atWordStart = true;
  const expandVars = (s: string) =>
    s.replace(/\$\{HOME[%#:/][^}]*\}/g, home).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
      const n = a ?? b;
      if (n === 'HOME') return home;
      return vars.has(n) ? vars.get(n)! : m;
    });
  const push = () => {
    if (started) out.push({ text: cur, glob });
    cur = '';
    glob = false;
    started = false;
    atWordStart = true;
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i]!;
    // redirections separate words (`cat<~/.ssh/id`): the operand after `<` is read like any other argument
    if (/\s/.test(c) || c === '<' || c === '>') {
      push();
      continue;
    }
    started = true;
    if (c === '$' && seg[i + 1] === "'") {
      // $'…' (ANSI-C quoting): the escapes are dropped, the rest is literal
      const j = seg.indexOf("'", i + 2);
      cur += (j < 0 ? seg.slice(i + 2) : seg.slice(i + 2, j)).replace(/\\(.)/g, '$1');
      i = j < 0 ? seg.length : j;
      atWordStart = false;
      continue;
    }
    if (c === "'") {
      const j = seg.indexOf("'", i + 1);
      cur += j < 0 ? seg.slice(i + 1) : seg.slice(i + 1, j);
      i = j < 0 ? seg.length : j;
      atWordStart = false;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < seg.length && seg[j] !== '"') {
        if (seg[j] === '\\' && j + 1 < seg.length) s += seg[++j];
        else s += seg[j];
        j++;
      }
      cur += expandVars(s);
      i = j;
      atWordStart = false;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) {
      cur += seg[++i];
      atWordStart = false;
      continue;
    }
    // an unquoted run
    let j = i;
    let s = '';
    while (j < seg.length && !/[\s'"\\<>]/.test(seg[j]!) && !(seg[j] === '$' && seg[j + 1] === "'")) s += seg[j++];
    if (atWordStart && (s === '~' || s.startsWith('~/'))) s = home + s.slice(1);
    else if (atWordStart && /^~[A-Za-z_][A-Za-z0-9_.-]*(\/|$)/.test(s)) {
      // ~user: this user's home when it is the same name, else the sibling directory
      const name = /^~([^/]+)/.exec(s)![1]!;
      s = (name === path.basename(home) ? home : path.join(path.dirname(home), name)) + s.slice(name.length + 1);
    }
    if (/[*?[]/.test(s)) glob = true;
    cur += expandVars(s);
    i = j - 1;
    atWordStart = false;
  }
  push();
  return out;
}

/** `$(echo X)`, `$(printf %s X)`, `` `echo X` ``, `$(pwd)` with a simple literal X become X; other substitutions are analysed on their own. */
function substitute(cmd: string, inner: string[], home: string): string {
  let s = cmd;
  for (let k = 0; k < 4; k++) {
    const before = s;
    s = s.replace(/\$\(\s*(?:echo|printf(?:\s+%s)?)\s+([^()`;|&]*?)\s*\)|`\s*(?:echo|printf(?:\s+%s)?)\s+([^`;|&]*?)\s*`/g, (_m, a, b) => (a ?? b ?? '').replace(/^["']|["']$/g, ''));
    s = s.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_m, a, b) => {
      const body = a ?? b ?? '';
      inner.push(body);
      // a substitution that computes the home directory (`$(eval echo ~)`, `$(dirname ~/x)`, getent passwd …)
      return /(^|[\s"'=])~(?=[\s/"']|$)|\$\{?HOME\b|getent\s+passwd/.test(body) ? home : '__OH_SUBST__';
    });
    if (s === before) break;
  }
  return s;
}

function segmentsOf(glob: string): string[] {
  return glob.split('/').filter((x) => x !== '');
}

/** Could an (absolute) glob match the store `store` or something inside it, or a directory that contains it? */
function globReaches(pattern: string, store: string): boolean {
  const p = segmentsOf(pattern);
  const s = segmentsOf(store);
  if (p.includes('**')) {
    const prefix = p.slice(0, p.indexOf('**'));
    return prefix.every((seg, i) => i >= s.length || picomatch.isMatch(s[i]!, seg, { dot: true }));
  }
  const n = Math.min(p.length, s.length);
  for (let i = 0; i < n; i++) if (!picomatch.isMatch(s[i]!, p[i]!, { dot: true })) return false;
  return p.length >= s.length;
}

/**
 * Re-check RC-4: daemon-client commands that only read state through the daemon (`docker ps`) do not ask; anything
 * else does (run, exec, cp, inspect, logs …), as does a client pointed elsewhere (-H, --host, --context, --url).
 */
const DAEMON_READ_ONLY: Record<string, string[]> = {
  docker: ['ps', 'images', 'version', 'info', 'stats', 'top', 'port', 'events', 'history', 'search', 'image ls', 'image list', 'container ls', 'container list', 'network ls', 'volume ls', 'system df', 'compose ps', 'compose ls', 'context ls'],
  podman: ['ps', 'images', 'version', 'info', 'stats', 'top', 'port', 'events', 'history', 'search', 'image ls', 'image list', 'container ls', 'container list', 'network ls', 'volume ls', 'system df', 'pod ps', 'pod ls', 'machine list', 'machine ls'],
  nerdctl: ['ps', 'images', 'version', 'info', 'stats', 'top', 'port', 'events', 'history', 'image ls', 'container ls', 'network ls', 'volume ls'],
};
function readOnlyDaemonCommand(prog: string, args: string[]): boolean {
  const list = DAEMON_READ_ONLY[prog];
  if (!list) return false;
  if (args.some((a) => /^(?:-H|--host|--context|-c|--url|--connection|--remote|-r)(?:=|$)/.test(a))) return false;
  const words = args.filter((a) => !a.startsWith('-'));
  return list.some((cmd) => {
    const parts = cmd.split(' ');
    return parts.every((p, k) => words[k] === p);
  });
}

const PROC_ENVIRON = /^\/proc\/(?!self\/|thread-self\/)[^/]+\/(?:task\/[^/]+\/)?environ$/;
const PROC_SAMPLES = ['/proc/1/environ', '/proc/1/task/1/environ'];

export function credentialReference(o: CredentialQuery, home = os.homedir()): string | null {
  const abs = (p: string) => path.resolve(expandTilde(p, home));
  const allow = new Set((o.allowRead ?? []).map(abs));
  const list = [...new Set([...DEFAULT_DENY_READ, ...(o.credentialPaths ?? [])].map(abs))].filter((p) => !allow.has(p));
  const ws = realResolve(o.workspace);
  // H5: a remote clone lives under ~/.tugline: its own files are not a credential store
  const wsInsideStore = list.some((c) => isInside(ws, c) || isInside(path.resolve(o.workspace), c));
  const show = (c: string) => (c === home ? '~' : c.startsWith(home + path.sep) ? `~/${path.relative(home, c)}` : c);
  const hit = (p: string): string | undefined => {
    const r = realResolve(p);
    if (wsInsideStore && isInside(r, ws)) return undefined;
    return list.find((c) => isInside(r, c) || isInside(path.resolve(p), c));
  };
  /** a directory that contains a store (the home directory, `/`): a recursive reader aimed at it reads the store */
  const containsStore = (p: string): string | undefined => {
    const r = realResolve(p);
    return list.find((c) => isInside(c, r) && !(wsInsideStore && isInside(c, ws)));
  };
  const globHit = (p: string): string | undefined => list.find((c) => globReaches(p, c));

  for (const p of o.paths ?? []) {
    const c = hit(p);
    if (c) return `reads a credential store (${show(c)})`;
  }
  if (typeof o.command !== 'string' || !o.command) return null;
  return commandReference(o.command, o.cwd, home, { hit, containsStore, globHit, show }, 0);
}

interface Matchers {
  hit: (p: string) => string | undefined;
  containsStore: (p: string) => string | undefined;
  globHit: (p: string) => string | undefined;
  show: (c: string) => string;
}

function commandReference(command: string, startCwd: string, home: string, m: Matchers, depth: number): string | null {
  if (depth > 3) return null;
  // ---- host daemon sockets (WS17 review F2): a container runtime's socket is host root ----
  const xdg = process.env.XDG_RUNTIME_DIR;
  const sockText = xdg ? command.replace(/\$\{XDG_RUNTIME_DIR\}|\$XDG_RUNTIME_DIR\b/g, xdg) : command;
  for (const raw of sockText.match(/[^\s'";|&<>()`=]+/g) ?? []) {
    const tok = raw.replace(/^unix:\/\//, '');
    if (DAEMON_SOCKET.test(tok) || (/\.sock(et)?$/.test(tok) && path.isAbsolute(tok) && runtimeSocketDirs().some((d) => isInside(path.resolve(tok), d))))
      return `the command reaches a host daemon socket (${tok}), which controls the host (a container runtime is root)`;
  }
  if (/(^|[\s;&|(])(?:export\s+)?DOCKER_HOST=|--unix-socket\b/.test(command) && /docker|containerd|podman|\.sock/.test(command)) return 'the command points a client at a host daemon socket (DOCKER_HOST / --unix-socket)';
  if (/\bAF_UNIX\b|socket\.AF_UNIX|UNIX-CONNECT:|\b(?:nc|ncat|netcat)\s+(?:-\w+\s+)*-\w*U\b|net\.connect\(\s*\{\s*path|createConnection\(\s*\{\s*path|unix:\/\//.test(command)) return 'the command opens a unix-socket connection (host daemons listen on unix sockets)';

  const inner: string[] = [];
  const cmd = substitute(command, inner, home);
  for (const sub of inner) {
    const r = commandReference(sub, startCwd, home, m, depth + 1);
    if (r) return r;
  }
  const vars = new Map<string, string>();
  let cwd = startCwd;
  let listedStore: string | undefined; // a listing of a directory that contains a store, piped on (`du -a ~ | xargs cat`)
  for (const seg of splitCommandSegments(cmd)) {
    const w = words(seg, vars, home);
    // leading assignments: remembered for later segments (`H=$HOME; cat $H/.ssh/x`)
    let i = 0;
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!.text)) {
      const eq = w[i]!.text.indexOf('=');
      vars.set(w[i]!.text.slice(0, eq), w[i]!.text.slice(eq + 1));
      i++;
    }
    if (w[i]?.text === 'export' || w[i]?.text === 'local' || w[i]?.text === 'declare') {
      for (const x of w.slice(i + 1)) {
        const eq = x.text.indexOf('=');
        if (eq > 0) vars.set(x.text.slice(0, eq), x.text.slice(eq + 1));
      }
      continue;
    }
    while (i < w.length && (WRAPPERS.has(path.basename(w[i]!.text)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!.text) || (i > 0 && /^-/.test(w[i]!.text) && WRAPPERS.has(path.basename(w[i - 1]!.text))))) i++;
    const prog = path.basename(w[i]?.text ?? '');
    const args = w.slice(i + 1);
    if (prog === 'cd' || prog === 'pushd') {
      const to = args.find((x) => !x.text.startsWith('-'));
      cwd = !to ? home : path.resolve(cwd, to.text);
      continue;
    }
    if (DAEMON_CLIENT.test(prog) && !readOnlyDaemonCommand(prog, args.map((x) => x.text))) return `the command runs ${prog}, a client of a container or VM daemon, which controls the host`;
    if (MENTION_ONLY.has(prog)) continue;
    if (w.slice(0, i + 1).some((x) => x.text === 'xargs') && listedStore) return `the command reads files listed from a directory that contains a credential store (${m.show(listedStore)})`;
    // commit messages only mention paths (`git commit -m "fix ~/.ssh docs"`)
    const vcs = ['git', 'hg', 'svn', 'jj'].includes(prog);
    const skipIdx = new Set<number>();
    // only the VALUE of -m/--message is a message; -F/--file (and any other operand) is a path git reads, so it is checked
    if (vcs) args.forEach((x, k) => { if (/^(?:-[a-zA-EG-Z]*m|--message)$/.test(x.text)) skipIdx.add(k + 1); if (/^--message=|^-m./.test(x.text)) skipIdx.add(k); });
    // -F<path> / --file=<path>: the path part is a read operand
    const fileArgs = vcs ? args.filter((x) => /^-F.|^--file=/.test(x.text)).map((x) => x.text.replace(/^-F|^--file=/, '')) : [];
    for (const f of fileArgs) {
      const c = m.hit(path.isAbsolute(f) ? f : path.resolve(cwd, f));
      if (c) return `the command reads a credential store (${m.show(c)})`;
    }
    const resolve = (t: string) => (path.isAbsolute(t) ? t : path.resolve(cwd, t));
    // ---- /proc/<pid>/environ: another process's environment holds the secrets scrubbing removed from ours ----
    for (const x of [w[i], ...args]) {
      if (!x) continue;
      const t = resolve(x.text);
      if (PROC_ENVIRON.test(t) || (x.glob && t.startsWith('/proc/') && PROC_SAMPLES.some((s) => picomatch.isMatch(s, t, { dot: true })))) return "reads another process's environment (/proc/<pid>/environ)";
    }
    // ---- every word that is (or globs to) a path in a store ----
    for (const [k, x] of args.entries()) {
      if (skipIdx.has(k)) continue;
      const t = x.text;
      if (!t || t === '-' || /^-[^/]*$/.test(t) && !t.includes('=')) continue;
      const value = /^-[^=]+=/.test(t) || /^[A-Za-z_]+=/.test(t) ? t.slice(t.indexOf('=') + 1) : t;
      if (!value || value === '__OH_SUBST__') continue;
      if (!(value.includes('/') || value.startsWith('.') || value === home)) continue;
      const c = x.glob ? m.globHit(resolve(value)) : m.hit(resolve(value));
      if (c) return `the command reads a credential store (${m.show(c)})`;
    }
    // ---- recursive readers aimed at a directory that contains a store ----
    const flags = args.filter((x) => /^-/.test(x.text)).map((x) => x.text);
    const rflag = flags.some((f) => f === '--recursive' || f === '--dereference-recursive' || (/^-[A-Za-z]+$/.test(f) && /[rR]/.test(f)));
    const recursive =
      RECURSIVE_ALWAYS.has(prog) ||
      (['grep', 'egrep', 'fgrep', 'cp', 'scp'].includes(prog) && (rflag || (prog === 'cp' && flags.some((f) => f === '--archive' || /^-[A-Za-z]*a/.test(f))))) ||
      (prog === 'find' && args.some((x) => /^-(exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(x.text)));
    // git -C <dir> archive|grep|bundle|ls-files … reads the tree at <dir>
    if (prog === 'git') {
      const ci = args.findIndex((x) => x.text === '-C');
      const sub = args.find((x, k) => !x.text.startsWith('-') && k !== ci + 1)?.text;
      if (ci >= 0 && args[ci + 1] && ['archive', 'grep', 'bundle', 'ls-files', 'show', 'cat-file', 'add', 'stash', 'diff'].includes(sub ?? '')) {
        const c = m.containsStore(resolve(args[ci + 1]!.text));
        if (c) return `the command reads a directory that contains a credential store (${m.show(c)}) through git`;
      }
    }
    // a listing of a directory with a store, for a later xargs (`du -a ~ | xargs cat`, `find ~ -type f | xargs cat`)
    if (['du', 'find', 'ls', 'tree', 'locate', 'fd', 'rg'].includes(prog)) {
      for (const x of args) if (!x.text.startsWith('-') && (x.text.includes('/') || x.text.startsWith('.') || x.text === home)) listedStore ??= m.containsStore(resolve(x.text));
    }
    if (recursive) {
      const positional = args.filter((x) => !/^-/.test(x.text));
      const operands = PATTERN_FIRST.has(prog) && !flags.some((f) => f === '-e' || f === '-f' || f.startsWith('--regexp') || f.startsWith('--file')) ? positional.slice(1) : positional;
      const targets = operands.map((x) => x.text).filter((t) => t && t !== '__OH_SUBST__' && t !== '-');
      // a recursive search with no path searches the working directory
      const implicit = targets.length === 0 && (PATTERN_FIRST.has(prog) || prog === 'find') ? [cwd] : [];
      for (const t of [...targets.filter((t) => t.includes('/') || t.startsWith('.') || t === home || prog !== 'tar' && prog !== 'zip').map(resolve), ...implicit]) {
        const c = m.containsStore(t);
        if (c) return `the command reads a directory that contains a credential store (${m.show(c)}) recursively`;
      }
    }
    // ---- inline code and arguments that embed a path (python -c "open('/home/me/.ssh/id')") ----
    if (vcs) continue; // version-control arguments are messages, refs and paths (checked above), not code
    const raw = seg
      .replace(/\$\{HOME\}|\$HOME\b/g, home)
      .replace(/(^|[\s'"=:(,])~(?=\/|[\s'";)|&,]|$)/g, (_m2, pre) => `${pre}${home}`)
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (mm, a, b) => vars.get(a ?? b) ?? mm);
    for (const tok of raw.match(/[^\s'";|&<>()`,]+/g) ?? []) {
      if (!path.isAbsolute(tok)) continue;
      if (PROC_ENVIRON.test(tok) || (/[*?[]/.test(tok) && tok.startsWith('/proc/') && PROC_SAMPLES.some((s2) => picomatch.isMatch(s2, tok, { dot: true })))) return "reads another process's environment (/proc/<pid>/environ)";
      const c = /[*?[]/.test(tok) ? m.globHit(tok) : m.hit(tok);
      if (c) return `the command reads a credential store (${m.show(c)})`;
    }
  }
  return null;
}
