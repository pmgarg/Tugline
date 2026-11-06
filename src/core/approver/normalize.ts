/**
 * Command-line normalisation for the C3 prefilter (WS3 v1.1 G1).
 *
 * The prefilter's rules are regexes over the command text, so every spelling
 * the shell treats as the same command is a way around them: `r\m`, `'rm'`,
 * `RM`, `/bin/rm`, `nice -n 19 rm`, `rm -fvr`, `curl -sF`, `--data=@x` … This
 * module lexes the line roughly the way a POSIX shell does and re-prints it in
 * canonical forms, so the rules can be matched against the raw command *and*
 * these forms. It is only ever used to escalate more (a form can add hits,
 * never remove one), so a lexing mistake costs at most an extra prompt.
 *
 * The forms are for matching, not for running: words are re-quoted with
 * double quotes only so that later quote-aware passes (`splitCommandSegments`,
 * `argv`) still see one argument as one argument.
 */
import path from 'node:path';

type Tok = { k: 'word'; v: string } | { k: 'op'; v: string } | { k: 'redir'; v: string };

/** One simple command: the real program and its canonical arguments, and its redirections (targets unquoted). */
export interface SimpleCommand {
  argv: string[];
  redirs: { op: string; target: string }[];
}

export interface Normalized {
  /** The simple commands of the line in order (R1 uses them for write targets). */
  commands: SimpleCommand[];
  /** `kept`: wrappers (sudo, nice …) still present; `resolved`: the real program first. Both canonical. */
  kept: string;
  resolved: string;
  /** Code the line hands to a shell as a string: `sh -c` / `bash -lc` args, `eval`, `env -S`. */
  shell: string[];
  /** Bodies of `$(…)` and backtick command substitutions (they run too). */
  subst: string[];
  /** Program words whose name is only known at run time (`$(echo rm) -rf x`). */
  dynamic: string[];
}

const CONTROL = ['&&', '||', '|&', ';;', '|', ';', '&', '(', ')', '\n'];
const REDIR = /^(?:\d*(?:>>|>\||>&|<<<|<<-|<<|<&|<>|>|<)|&>>|&>)/;

/** Read a balanced `$(…)` starting at `i` (pointing at `$`); returns [text, body, end index]. */
function readSubst(s: string, i: number): [string, string, number] {
  let depth = 0;
  let j = i + 1;
  let q: string | null = null;
  for (; j < s.length; j++) {
    const c = s[j]!;
    if (q) {
      if (c === '\\' && q === '"') j++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') j++;
    else if (c === "'" || c === '"') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) break;
  }
  const text = s.slice(i, j + 1);
  const body = text.startsWith('$((') ? text.slice(3, -2) : text.slice(2, text.endsWith(')') ? -1 : undefined);
  return [text, body, j];
}

function readBacktick(s: string, i: number): [string, string, number] {
  let j = i + 1;
  let body = '';
  for (; j < s.length && s[j] !== '`'; j++) body += s[j] === '\\' && j + 1 < s.length ? s[++j] : s[j];
  return [s.slice(i, j + 1), body, j];
}

/** ANSI-C `$'…'` decoding of the simple escapes (enough to see `$'\x72\x6d'` as `rm`). */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|.)/g, (_, e: string) => {
    if (/^x/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^u/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' } as Record<string, string>)[e] ?? e;
  });
}

/** Lex a command line into words (quotes and escapes removed), control operators and redirections. */
export function lex(s: string, nested: string[] = []): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    const r = REDIR.exec(s.slice(i));
    if (r) {
      out.push({ k: 'redir', v: r[0] });
      i += r[0].length;
      continue;
    }
    const op = CONTROL.find((o) => s.startsWith(o, i));
    if (op) {
      out.push({ k: 'op', v: op === '\n' ? ';' : op });
      i += op.length;
      continue;
    }
    // A word: everything up to unquoted blank / operator / redirection.
    let w = '';
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === ' ' || ch === '\t' || CONTROL.some((o) => s.startsWith(o, i))) break;
      if ((ch === '>' || ch === '<') || (ch === '&' && s[i + 1] === '>')) break;
      if (ch === '\\') {
        if (s[i + 1] !== '\n' && i + 1 < s.length) w += s[i + 1];
        i += 2;
      } else if (ch === "'") {
        const end = s.indexOf("'", i + 1);
        w += s.slice(i + 1, end < 0 ? undefined : end);
        i = end < 0 ? s.length : end + 1;
      } else if (ch === '$' && s[i + 1] === "'") {
        let j = i + 2;
        let body = '';
        for (; j < s.length && s[j] !== "'"; j++) body += s[j] === '\\' && j + 1 < s.length ? s[j] + s[++j] : s[j];
        w += ansiC(body);
        i = j + 1;
      } else if (ch === '"') {
        let j = i + 1;
        for (; j < s.length && s[j] !== '"'; j++) {
          const d = s[j]!;
          if (d === '\\' && j + 1 < s.length && '$`"\\\n'.includes(s[j + 1]!)) {
            if (s[j + 1] !== '\n') w += s[j + 1];
            j++;
          } else if (d === '$' && s[j + 1] === '(') {
            const [text, body, end] = readSubst(s, j);
            w += text;
            nested.push(body);
            j = end;
          } else if (d === '`') {
            const [text, body, end] = readBacktick(s, j);
            w += text;
            nested.push(body);
            j = end;
          } else w += d;
        }
        i = j + 1;
      } else if (ch === '$' && s[i + 1] === '(') {
        const [text, body, end] = readSubst(s, i);
        w += text;
        nested.push(body);
        i = end + 1;
      } else if (ch === '`') {
        const [text, body, end] = readBacktick(s, i);
        w += text;
        nested.push(body);
        i = end + 1;
      } else if (ch === '$' && s[i + 1] === '{') {
        const end = s.indexOf('}', i);
        w += s.slice(i, end < 0 ? undefined : end + 1);
        i = end < 0 ? s.length : end + 1;
      } else {
        w += ch;
        i++;
      }
    }
    out.push({ k: 'word', v: w });
  }
  return out;
}

/** Lower-cased basename of a command word (`/usr/bin/GIT` → `git`); words built at run time are left alone. */
export function progName(w: string): string {
  if (/[$`]/.test(w)) return w;
  return path.posix.basename(w.replace(/\/+$/, '')).toLowerCase() || w;
}

/** Short options that take a value, per program (the value is the rest of the group or the next word). */
const VALUE_SHORT: Record<string, string> = {
  curl: 'AbcCdDeEFHKmoPQrTuUwxXyYz',
  xh: 'ahfo',
  wget: 'aAbBdDeiIlnoOPQrRtTUwxX',
  ssh: 'bBcDEeFIiJlLmOopQRSwW',
  scp: 'cDFiJloPS',
  sftp: 'BbcDFiJloPRsS',
  rsync: 'eBfMT',
  grep: 'efmABCdD',
  egrep: 'efmABCdD',
  fgrep: 'efmABCdD',
  rg: 'efgmtTABCjMrE',
  git: 'cC',
  tar: 'fCbHIKLNTVX',
  head: 'nc',
  tail: 'ncs',
  sort: 'ktoST',
  cut: 'bcdf',
  sed: 'efl',
  awk: 'fvF',
  xargs: 'IinPLldsEea',
  sudo: 'ugCDhprtTUR',
  doas: 'uC',
  nice: 'n',
  timeout: 'sk',
  env: 'uCS',
  docker: 'eHlpvwuc',
  kubectl: 'nolfcs',
  npm: 'w',
  ln: 't',
  cp: 'tS',
  mv: 'tS',
  install: 'gmoStT',
  chmod: '',
  rm: '',
  zip: 'bntP',
  unzip: 'dPx',
  openssl: '',
  base64: 'w',
  mysql: 'uphPDeS',
  psql: 'cdfhpUvoT',
  'redis-cli': 'hpanu',
  python: 'cmWXQ',
  python3: 'cmWXQ',
  node: 'erp',
  perl: 'eEIlmMx',
  ruby: 'eIrCEx',
  php: 'rBRFEcdz',
};
/** Programs whose options are single-dash words (`-name`, `-jar`, `-Command`): never split. */
const NO_SPLIT = new Set(['find', 'java', 'javac', 'go', 'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'ld', 'tsc', 'ffmpeg', 'ffprobe', 'convert', 'magick', 'xcodebuild', 'openssl', 'sqlite3', 'terraform', 'pwsh', 'powershell', 'osascript', 'qemu-system-x86_64', 'dotnet', 'mongosh', 'mongo', 'security', 'iptables', 'ip6tables', 'nft', 'xdotool', 'wmctrl', 'tesseract', 'cmake']);

/** Split one short-option group: `-sSF` → `-s -S -F`, `-d@x` → `-d @x`, `-n19` → `-n 19`. */
function splitShort(group: string, values: string | undefined): string[] {
  const body = group.slice(1);
  if (values === undefined) return /^[A-Za-z]{2,}$/.test(body) ? [...body].map((c) => '-' + c) : [group];
  if (!/^[A-Za-z]/.test(body)) return [group];
  const out: string[] = [];
  for (let k = 0; k < body.length; k++) {
    const c = body[k]!;
    if (!/[A-Za-z0-9]/.test(c)) return [group];
    out.push('-' + c);
    if (values.includes(c) && k + 1 < body.length) {
      out.push(body.slice(k + 1));
      break;
    }
  }
  return out;
}

/** Canonical option spelling for a program's arguments: split short groups, `--flag=value` → `--flag value`. */
export function expandFlags(prog: string, args: string[]): string[] {
  const out: string[] = [];
  const values = VALUE_SHORT[prog];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (ended || !a.startsWith('-') || a === '-') {
      out.push(a);
      continue;
    }
    if (a === '--') {
      ended = true;
      out.push(a);
      continue;
    }
    const eq = /^(--[A-Za-z0-9][\w.-]*)=([\s\S]*)$/.exec(a);
    if (eq) {
      out.push(eq[1]!, eq[2]!);
      continue;
    }
    if (a.startsWith('--') || NO_SPLIT.has(prog) || a.length <= 2) {
      out.push(a);
      // A value-taking short flag keeps its value as the next word, unsplit.
      if (a.length === 2 && values?.includes(a[1]!) && i + 1 < args.length) out.push(args[++i]!);
      continue;
    }
    const parts = splitShort(a, values);
    out.push(...parts);
    const last = parts[parts.length - 1]!;
    // `-sSo file`: the group ends in a value flag, so the next word is its value.
    if (parts.length > 1 && last.length === 2 && last.startsWith('-') && values?.includes(last[1]!) && i + 1 < args.length) out.push(args[++i]!);
  }
  return out;
}

/** Skip one wrapper's own options. `values` are short options with a value; `longValues` long ones. */
function skipOpts(t: string[], i: number, values: string, longValues: string[] = [], stopAtFirstPositional = true): number {
  while (i < t.length) {
    const a = t[i]!;
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return stopAtFirstPositional ? i : i + 1;
    if (a.startsWith('--')) {
      const name = a.split('=')[0]!;
      i += longValues.includes(name) && !a.includes('=') ? 2 : 1;
      continue;
    }
    // short group: a value letter consumes the rest of the group or the next word
    let took = 1;
    for (let k = 1; k < a.length; k++) {
      if (values.includes(a[k]!)) {
        if (k === a.length - 1) took = 2;
        break;
      }
    }
    i += took;
  }
  return i;
}

const SHELL_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'fi', 'done']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const SHELLS = /^(?:ba|z|da|k|fi|c|tc|mk|a|y|)sh$/;

/**
 * Index of the real program in a simple command's words, following transparent
 * wrappers (`command`, `env`, `nice`, `nohup`, `timeout N`, `sudo`, `doas`,
 * `xargs`, `time` …). Also collects code that a wrapper runs as a shell line.
 */
export function resolveProgram(t: string[], nested: string[] = [], positions: number[] = []): number {
  let i = 0;
  for (let guard = 0; guard < 32 && i < t.length; guard++) {
    const w = t[i]!;
    if (ASSIGN.test(w)) {
      i++;
      continue;
    }
    positions.push(i);
    const p = progName(w);
    if (SHELL_WORDS.has(p)) i++;
    else if (p === 'command') {
      // `command -v x` / `-V` only looks x up; it does not run it.
      let j = i + 1;
      while (t[j] && /^-[pvV]+$/.test(t[j]!)) {
        if (/[vV]/.test(t[j]!)) return i;
        j++;
      }
      if (t[j] === '--') j++;
      i = j;
    } else if (p === 'builtin' || p === 'nohup' || p === 'unbuffer' || p === 'busybox') i = skipOpts(t, i + 1, '');
    else if (p === 'exec') i = skipOpts(t, i + 1, 'a');
    else if (p === 'time') i = skipOpts(t, i + 1, 'fo', ['--format', '--output']);
    else if (p === 'nice') i = skipOpts(t, i + 1, 'n', ['--adjustment']);
    else if (p === 'ionice') i = skipOpts(t, i + 1, 'cnp', ['--class', '--classdata', '--pid']);
    else if (p === 'stdbuf') i = skipOpts(t, i + 1, 'ioe', ['--input', '--output', '--error']);
    else if (p === 'setsid' || p === 'chronic' || p === 'caffeinate') i = skipOpts(t, i + 1, 'tw');
    else if (p === 'doas') i = skipOpts(t, i + 1, 'uC');
    else if (p === 'sudo') i = skipOpts(t, i + 1, 'ugCDhprtTUR', ['--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--command-timeout', '--other-user', '--chroot']);
    else if (p === 'timeout') {
      let j = skipOpts(t, i + 1, 'sk', ['--signal', '--kill-after']);
      if (t[j] && /^\d+(?:\.\d+)?[smhd]?$/.test(t[j]!)) j++;
      i = j;
    } else if (p === 'env') {
      let j = i + 1;
      for (;;) {
        const a = t[j];
        if (a === undefined) break;
        if (a === '--') {
          j++;
          break;
        }
        if (a === '-S' || a === '--split-string') {
          if (t[j + 1]) nested.push(t[j + 1]!);
          j += 2;
        } else if (/^-S./.test(a) || a.startsWith('--split-string=')) {
          nested.push(a.replace(/^-S|^--split-string=/, ''));
          j++;
        } else if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') j += 2;
        else if (a.startsWith('-')) j++;
        else if (ASSIGN.test(a)) j++;
        else break;
      }
      if (j >= t.length) return i; // bare `env` prints the environment
      i = j;
    } else if (p === 'xargs') {
      i = skipOpts(t, i + 1, 'IinPLldsEea', ['--max-args', '--max-procs', '--max-lines', '--delimiter', '--max-chars', '--eof', '--arg-file', '--replace', '--process-slot-var']);
    } else return i;
  }
  return Math.min(i, t.length);
}

/** `sh -c CODE` / `bash -lc CODE` / `eval CODE…` in one simple command's words (program at index 0). */
function shellCode(argv: string[]): string | undefined {
  const p = argv[0];
  if (!p) return undefined;
  if (p === 'eval') return argv.slice(1).join(' ');
  if (!SHELLS.test(p) && p !== 'su' && p !== 'runuser') return undefined;
  let hasC = false;
  for (let k = 1; k < argv.length; k++) {
    const a = argv[k]!;
    if (a === '--') break;
    if (/^[-+]o$/.test(a)) {
      k++;
      continue;
    }
    if (a === '--command') hasC = true;
    else if (/^-[A-Za-z]+$/.test(a)) hasC ||= a.includes('c');
    else if (a.startsWith('-')) continue;
    else if (hasC) return a;
  }
  return undefined;
}

/** Re-quote a word for the canonical form (only so later quote-aware passes keep it one word). */
function quoteWord(w: string): string {
  if (w === '') return '""';
  return /[\s;&|<>()"'\\]/.test(w) ? `"${w.replace(/[\\"]/g, '\\$&')}"` : w;
}

/** Canonical forms of a command line; see the module comment. */
export function normalizeCommand(command: string): Normalized {
  const nested: string[] = [];
  const subst: string[] = [];
  const toks = lex(command, subst);
  const kept: string[] = [];
  const resolved: string[] = [];
  const dynamic: string[] = [];
  const commands: SimpleCommand[] = [];
  // Variables assigned earlier on the same line (`R=rm; $R -rf x`), and IFS used as a blank.
  const vars = new Map<string, string>([['IFS', ' ']]);
  const expand = (w: string) => w.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (m, a?: string, b?: string) => vars.get((a ?? b)!) ?? m);
  let cmd: Tok[] = [];
  const flush = (sep?: string) => {
    // words of this simple command, without redirections and their targets
    const words: string[] = [];
    const redirs: string[] = [];
    const rawRedirs: { op: string; target: string }[] = [];
    for (let k = 0; k < cmd.length; k++) {
      const tk = cmd[k]!;
      if (tk.k === 'redir') {
        const next = cmd[k + 1];
        const tgt = next && next.k === 'word' ? next.v : '';
        if (next && next.k === 'word') k++;
        rawRedirs.push({ op: tk.v, target: tgt });
        redirs.push(/&$/.test(tk.v) && /^(?:\d+|-)$/.test(tgt) ? tk.v + tgt : `${tk.v} ${quoteWord(tgt)}`);
      } else if (tk.k === 'word') {
        // expansion of a known variable is split into words, as the shell does for unquoted ones
        const e = expand(tk.v);
        words.push(...(e !== tk.v && /\s/.test(e) ? e.split(/\s+/).filter(Boolean) : [e]));
      }
    }
    if (words.length && words.every((w) => ASSIGN.test(w))) {
      for (const w of words) {
        const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w);
        if (m) vars.set(m[1]!, m[2]!);
      }
    }
    if (words.length || redirs.length) {
      // every command-position word (wrappers and the real program) gets the canonical program name
      const positions: number[] = [];
      const at = resolveProgram(words, nested, positions);
      const progAt = new Set(positions);
      const prog = words[at] !== undefined ? progName(words[at]!) : '';
      if (/\$\(|`/.test(prog)) dynamic.push(prog);
      const head = words.slice(0, at).map((w, k) => (progAt.has(k) ? progName(w) : w));
      const real = words[at] !== undefined ? [prog, ...expandFlags(prog, words.slice(at + 1))] : [];
      const code = shellCode(real);
      if (code !== undefined) nested.push(code);
      commands.push({ argv: real, redirs: rawRedirs });
      kept.push([...head, ...real].map(quoteWord).concat(redirs).join(' '));
      resolved.push(real.map(quoteWord).concat(redirs).join(' '));
    }
    if (sep) {
      kept.push(sep);
      resolved.push(sep);
    }
    cmd = [];
  };
  for (const tk of toks) {
    if (tk.k === 'op') flush(tk.v);
    else cmd.push(tk);
  }
  flush();
  const join = (parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim();
  return { commands, kept: join(kept), resolved: join(resolved), shell: nested.filter((n) => n.trim()), subst: subst.filter((n) => n.trim()), dynamic };
}
