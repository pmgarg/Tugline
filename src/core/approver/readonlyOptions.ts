/**
 * N43 re-check finding A: option ALLOWLISTS for the read-only fast path (our own design, stricter than Qwen Code's
 * shellAstParser, whose rules still run as a second check in readonly.ts).
 *
 * A denylist of dangerous options cannot work for programs whose option parser accepts abbreviations (git's
 * parse-options and GNU getopt_long take any unique prefix: `git grep --open-files-in=…`) or clusters (`-nO<cmd>`).
 * So for every program the fast path accepts, this file lists the options that are known to be harmless, and:
 *  - a long option must be on the list EXACTLY (no prefixes, so no abbreviation of anything ever passes);
 *  - a short-option cluster is split and every letter must be on the list; a letter that takes a value may only end
 *    the cluster (value in the next word), or carry an attached value when the letter is listed in `attached` and
 *    the value matches its pattern (numbers, single characters);
 *  - `--name=value` only for options listed with a value, and the value must match;
 *  - a program or git subcommand with no spec is not read-only.
 * Values given as separate words, and `--name=value` values, are still checked for containment (every path inside
 * the workspace) by readonly.ts.
 */

type V = RegExp | 'any';

export interface OptSpec {
  /** short options without a value; may be clustered (`-rn`) */
  flags?: string;
  /** short options that take a value (in the next word, or attached when listed in `attached`) */
  values?: Record<string, V>;
  /** value letters whose value may be attached (`-n5`, `-A3`, `-t,`) */
  attached?: string;
  /** long options without a value, exact */
  long?: readonly string[];
  /** long options with a required value (`--x=v` or `--x v`), exact name */
  longValues?: Record<string, V>;
  /** long options with an optional value (`--x` or `--x=v`), exact name */
  longOptional?: Record<string, V>;
  /** `-20` (head, tail, git log) */
  numeric?: boolean;
  /** extra check on the positional words and the options seen */
  check?: (pos: string[], seen: Set<string>, args: string[]) => boolean;
}

const NUM = /^\d+$/;
const SIGNED = /^[+-]?\d+[a-zA-Z]{0,3}$/;
const CHAR = /^.{1,2}$/s;
const COLOR = /^(?:never|auto|always)$/;
const ANY: V = 'any';

function valueOk(v: V, s: string | undefined): boolean {
  if (s === undefined) return false;
  return v === 'any' ? true : v.test(s);
}

export interface Parsed {
  pos: string[];
  seen: Set<string>;
  /** option → its values (short as `-x`, long as `--name`) */
  values: Map<string, string[]>;
}

/** Parse `args` against the spec; null when any option is not on the allowlist (see the module comment). */
export function parseOptions(spec: OptSpec, args: string[]): Parsed | null {
  const pos: string[] = [];
  const seen = new Set<string>();
  const values = new Map<string, string[]>();
  const note = (k: string, v?: string) => {
    seen.add(k);
    if (v !== undefined) values.set(k, [...(values.get(k) ?? []), v]);
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a === '-' || !a.startsWith('-')) {
      pos.push(a);
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      const val = eq < 0 ? undefined : a.slice(eq + 1);
      if (spec.long?.includes(name) && val === undefined) {
        note(name);
        continue;
      }
      if (spec.longValues && Object.hasOwn(spec.longValues, name)) {
        const v = val ?? args[++i];
        if (!valueOk(spec.longValues[name]!, v)) return null;
        note(name, v);
        continue;
      }
      if (spec.longOptional && Object.hasOwn(spec.longOptional, name)) {
        if (val !== undefined && !valueOk(spec.longOptional[name]!, val)) return null;
        note(name, val);
        continue;
      }
      return null; // not listed, or an abbreviation of something
    }
    if (spec.numeric && /^-\d+$/.test(a)) {
      note('-#', a.slice(1));
      continue;
    }
    // a short-option cluster: every letter must be allowed
    for (let j = 1; j < a.length; j++) {
      const c = a[j]!;
      if (spec.flags?.includes(c)) {
        note(`-${c}`);
        continue;
      }
      if (spec.values && Object.hasOwn(spec.values, c)) {
        const rest = a.slice(j + 1);
        let v: string | undefined;
        if (rest) {
          if (!spec.attached?.includes(c) || !valueOk(spec.values[c]!, rest)) return null;
          v = rest;
        } else if (!valueOk(spec.values[c]!, (v = args[++i]))) return null;
        note(`-${c}`, v);
        break;
      }
      return null;
    }
  }
  if (spec.check && !spec.check(pos, seen, args)) return null;
  return { pos, seen, values };
}

/** True when every option in `args` is on the spec's allowlist. */
export function optionsAllowed(spec: OptSpec, args: string[]): boolean {
  return parseOptions(spec, args) !== null;
}

// ------------------------------------------------------------ programs

const GREP: OptSpec = {
  flags: 'EFGiIvwxclLoqsbHhnrRaz',
  values: { e: ANY, f: ANY, A: NUM, B: NUM, C: NUM, m: NUM },
  attached: 'ABCm',
  long: ['--extended-regexp', '--fixed-strings', '--basic-regexp', '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count', '--files-with-matches', '--files-without-match', '--only-matching', '--quiet', '--silent', '--no-messages', '--byte-offset', '--with-filename', '--no-filename', '--line-number', '--recursive', '--dereference-recursive', '--text', '--null', '--null-data'],
  longValues: { '--regexp': ANY, '--file': ANY, '--include': ANY, '--exclude': ANY, '--exclude-dir': ANY, '--max-count': NUM, '--after-context': NUM, '--before-context': NUM, '--context': NUM },
  longOptional: { '--color': COLOR, '--colour': COLOR },
};

const RG: OptSpec = {
  flags: 'iSsFwxvclnNHoqaLuU',
  values: { e: ANY, g: ANY, t: /^[\w+-]+$/, T: /^[\w+-]+$/, A: NUM, B: NUM, C: NUM, m: NUM, M: NUM, j: NUM },
  attached: 'ABCmMj',
  long: ['--ignore-case', '--smart-case', '--case-sensitive', '--fixed-strings', '--word-regexp', '--line-regexp', '--invert-match', '--count', '--count-matches', '--files-with-matches', '--files-without-match', '--line-number', '--no-line-number', '--with-filename', '--no-filename', '--only-matching', '--quiet', '--hidden', '--no-ignore', '--no-ignore-vcs', '--follow', '--files', '--json', '--vimgrep', '--no-heading', '--heading', '--stats', '--multiline', '--column', '--no-messages', '--text', '--trim', '--null'],
  longValues: { '--regexp': ANY, '--glob': ANY, '--iglob': ANY, '--type': /^[\w+-]+$/, '--type-not': /^[\w+-]+$/, '--max-count': NUM, '--after-context': NUM, '--before-context': NUM, '--context': NUM, '--max-depth': NUM, '--sort': /^(?:path|modified|accessed|created|none)$/, '--sortr': /^(?:path|modified|accessed|created|none)$/, '--max-columns': NUM, '--color': COLOR },
};

const CAT: OptSpec = { flags: 'AbeEnstTuv', long: ['--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs', '--squeeze-blank', '--show-nonprinting'] };
const HEAD: OptSpec = { flags: 'qvz', values: { n: SIGNED, c: SIGNED }, attached: 'nc', numeric: true, long: ['--quiet', '--silent', '--verbose', '--zero-terminated'], longValues: { '--lines': SIGNED, '--bytes': SIGNED } };
const WC: OptSpec = { flags: 'clmwL', long: ['--bytes', '--chars', '--lines', '--words', '--max-line-length'] };
const LS: OptSpec = {
  flags: 'aAbBcCdFgGhHiklLmnNopqQrRsStuUvxX1',
  long: ['--all', '--almost-all', '--human-readable', '--si', '--recursive', '--reverse', '--size', '--classify', '--directory', '--inode', '--full-time', '--group-directories-first', '--dereference', '--numeric-uid-gid', '--no-group', '--escape', '--literal'],
  longValues: { '--sort': /^(?:none|size|time|version|extension|width)$/ },
  longOptional: { '--color': COLOR, '--colour': COLOR },
};
const SORT: OptSpec = {
  flags: 'bdfgiMhnRrVcCmsuz',
  values: { k: /^[\d.,a-zA-Z]+$/, t: CHAR },
  attached: 'kt',
  long: ['--reverse', '--numeric-sort', '--human-numeric-sort', '--unique', '--ignore-case', '--general-numeric-sort', '--version-sort', '--month-sort', '--stable', '--check', '--zero-terminated', '--ignore-leading-blanks', '--dictionary-order', '--merge'],
  longValues: { '--key': /^[\d.,a-zA-Z]+$/, '--field-separator': CHAR },
};
const UNIQ: OptSpec = { flags: 'cdDiuz', values: { f: NUM, s: NUM, w: NUM }, attached: 'fsw', long: ['--count', '--repeated', '--unique', '--ignore-case', '--zero-terminated'], longValues: { '--skip-fields': NUM, '--skip-chars': NUM, '--check-chars': NUM }, check: (pos) => pos.length <= 1 };
const CUT: OptSpec = { flags: 'sz', values: { d: CHAR, f: /^[\d,-]+$/, b: /^[\d,-]+$/, c: /^[\d,-]+$/ }, attached: 'dfbc', long: ['--complement', '--only-delimited', '--zero-terminated'], longValues: { '--delimiter': CHAR, '--fields': /^[\d,-]+$/, '--bytes': /^[\d,-]+$/, '--characters': /^[\d,-]+$/ } };
// tree: no -o (output file), -R/-H (write 00Tree.html files), -T, --fromfile
const TREE: OptSpec = { flags: 'adfFilpsugDqNrtCAhx', values: { L: NUM, I: ANY, P: ANY }, attached: 'L', long: ['--noreport', '--dirsfirst', '--gitignore', '--prune'] };
const STAT: OptSpec = { flags: 'Lft', values: { c: ANY }, long: ['--dereference', '--terse', '--file-system'], longValues: { '--format': ANY, '--printf': ANY } };
const FILE: OptSpec = { flags: 'bLhi', long: ['--brief', '--mime', '--mime-type', '--mime-encoding', '--dereference', '--no-dereference'] }; // no -z (decompressors)
const SUM: OptSpec = { flags: 'btz', long: ['--binary', '--text', '--tag', '--zero'] }; // no -c (reads a list of paths)
const DIFF: OptSpec = {
  flags: 'uqrNaiwBbEstpy',
  values: { U: NUM },
  attached: 'U',
  long: ['--brief', '--recursive', '--new-file', '--text', '--ignore-case', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--side-by-side', '--report-identical-files', '--expand-tabs', '--minimal', '--suppress-common-lines', '--show-c-function'],
  longValues: { '--unified': NUM },
  longOptional: { '--color': COLOR },
};
const CMP: OptSpec = { flags: 'bls', long: ['--print-bytes', '--verbose', '--quiet', '--silent'] };
const DU: OptSpec = { flags: 'ahsckmbxLlS0', values: { d: NUM }, attached: 'd', long: ['--all', '--summarize', '--human-readable', '--apparent-size', '--total', '--si', '--count-links', '--dereference', '--one-file-system', '--null', '--bytes'], longValues: { '--max-depth': NUM } };
const COLUMN: OptSpec = { flags: 'txne', values: { s: ANY, c: NUM, o: ANY }, attached: 'c' };
const REALPATH: OptSpec = { flags: 'emLPqsz', long: ['--canonicalize-existing', '--canonicalize-missing', '--logical', '--physical', '--quiet', '--strip', '--no-symlinks', '--zero'], longValues: { '--relative-to': ANY, '--relative-base': ANY } };
const READLINK: OptSpec = { flags: 'femnqsvz', long: ['--canonicalize', '--canonicalize-existing', '--canonicalize-missing', '--no-newline', '--quiet', '--silent', '--verbose', '--zero'] };
const NONE: OptSpec = {};

// jq: no --arg/--argjson/--slurpfile/--rawfile/-f/-L/--args; the filter may not read the environment or load modules
const JQ_FORBIDDEN = /\benv\b|\$ENV\b|\$__loc__|\$__prog_args|\binput_filename\b|\bimport\b|\binclude\b|\bmodulemeta\b|\bget_search_list\b|\binput_line_number\b|\$__/;
const JQ: OptSpec = {
  flags: 'rjcnesSCMaR',
  long: ['--raw-output', '--join-output', '--compact-output', '--null-input', '--exit-status', '--slurp', '--sort-keys', '--tab', '--ascii-output', '--raw-input', '--color-output', '--monochrome-output', '--seq', '--raw-output0'],
  longValues: { '--indent': NUM },
  check: (pos) => pos.length >= 1 && !JQ_FORBIDDEN.test(pos[0]!),
};

// awk: only -F and -v; never -f/-E/-i/-l/--load/--include/--exec; the program may not read the environment
const AWK_FORBIDDEN = /\bENVIRON\b|\bPROCINFO\b|@load|@include|@namespace/;
const AWK: OptSpec = { values: { F: ANY, v: /^[A-Za-z_]\w*=.*$/s }, attached: 'F', check: (pos) => pos.length >= 1 && !AWK_FORBIDDEN.test(pos[0]!) };

// sed: never -i/--in-place, -f/--file, -l; scripts are further checked by the ported shellSafetyRules
const SED: OptSpec = {
  flags: 'nErsuz',
  values: { e: ANY },
  long: ['--quiet', '--silent', '--regexp-extended', '--null-data', '--separate', '--unbuffered', '--posix', '--sandbox'],
  longValues: { '--expression': ANY },
};

const FIND_TESTS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-xtype', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-newer', '-size', '-perm', '-user', '-group', '-links', '-samefile', '-printf', '-regextype', '-uid', '-gid', '-inum', '-lname', '-ilname']);
const FIND_FLAGS = new Set(['-empty', '-print', '-print0', '-prune', '-not', '!', '-a', '-and', '-o', '-or', '-readable', '-writable', '-executable', '-depth', '-true', '-false', '-ls', '-nouser', '-nogroup', '-follow', '-mount', '-xdev', '-quit', '(', ')', ',']);
/** find: leading -H/-L/-P, start paths, then only listed tests and actions (no -exec/-ok/-delete/-fprint/-fls …). */
function findAllowed(args: string[]): boolean {
  let i = 0;
  while (['-H', '-L', '-P'].includes(args[i] ?? '')) i++;
  while (i < args.length && !args[i]!.startsWith('-') && !['(', ')', '!', ','].includes(args[i]!)) i++;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (FIND_FLAGS.has(a)) continue;
    if (FIND_TESTS.has(a)) {
      if (args[++i] === undefined) return false;
      continue;
    }
    return false;
  }
  return true;
}

// ------------------------------------------------------------ git

const GIT_FORMAT_OK = (v: string) => !/%G/.test(v);
const FORMAT: V = /^(?![\s\S]*%G)[\s\S]*$/;
const DIFF_COMMON_LONG = ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--raw', '--patch', '--no-patch', '--no-color', '--minimal', '--patience', '--histogram', '--ignore-all-space', '--ignore-space-change', '--ignore-blank-lines', '--no-renames', '--find-renames', '--no-ext-diff', '--no-textconv', '--full-index', '--binary', '--abbrev', '--compact-summary', '--dirstat'];
const DIFF_COMMON_VALUES: Record<string, V> = { '--unified': NUM, '--diff-filter': /^[ACDMRTUXBacdmrtuxb*]+$/, '--stat-width': NUM };
const DIFF_COMMON_OPTIONAL: Record<string, V> = { '--color': COLOR, '--word-diff': /^(?:color|plain|porcelain|none)$/, '--stat': /^[\d,]+$/, '--find-renames': /^\d+%?$/, '--abbrev': NUM, '--relative': ANY };
const LOG_LONG = [...DIFF_COMMON_LONG, '--oneline', '--graph', '--all', '--branches', '--tags', '--remotes', '--reverse', '--first-parent', '--no-merges', '--merges', '--abbrev-commit', '--no-abbrev-commit', '--follow', '--left-right', '--topo-order', '--date-order', '--source', '--no-walk', '--boundary', '--cherry-pick', '--cherry-mark', '--full-history', '--simplify-merges', '--ancestry-path', '--no-decorate', '--regexp-ignore-case', '--extended-regexp', '--fixed-strings', '--all-match', '--invert-grep', '--parents', '--children', '--count', '--mailmap', '--no-mailmap', '--walk-reflogs'];
const LOG_VALUES: Record<string, V> = { ...DIFF_COMMON_VALUES, '--max-count': NUM, '--skip': NUM, '--since': ANY, '--until': ANY, '--after': ANY, '--before': ANY, '--author': ANY, '--committer': ANY, '--grep': ANY, '--date': /^[\w:%-]+$/, '--min-parents': NUM, '--max-parents': NUM };
const LOG_OPTIONAL: Record<string, V> = { ...DIFF_COMMON_OPTIONAL, '--decorate': /^(?:short|full|auto|no)$/, '--format': FORMAT, '--pretty': FORMAT };

const GIT: Record<string, OptSpec> = {
  status: { flags: 'sbvz', values: { u: /^(?:no|normal|all)$/ }, attached: 'u', long: ['--short', '--branch', '--long', '--verbose', '--ignored', '--no-renames', '--ahead-behind', '--no-ahead-behind', '--show-stash', '--renames'], longOptional: { '--porcelain': /^v[12]$/, '--untracked-files': /^(?:no|normal|all)$/ } },
  diff: { flags: 'pusRawb', values: { U: NUM }, attached: 'U', long: [...DIFF_COMMON_LONG, '--cached', '--staged', '--merge-base', '--exit-code', '--quiet', '--check'], longValues: DIFF_COMMON_VALUES, longOptional: DIFF_COMMON_OPTIONAL },
  log: { flags: 'psp', values: { n: NUM }, attached: 'n', numeric: true, long: LOG_LONG, longValues: LOG_VALUES, longOptional: LOG_OPTIONAL },
  show: { flags: 'ps', long: [...DIFF_COMMON_LONG, '--oneline', '--abbrev-commit', '--no-abbrev-commit', '--quiet'], longValues: { ...DIFF_COMMON_VALUES, '--date': /^[\w:%-]+$/ }, longOptional: { ...DIFF_COMMON_OPTIONAL, '--format': FORMAT, '--pretty': FORMAT, '--decorate': /^(?:short|full|auto|no)$/ } },
  blame: { flags: 'lstwfnepc', values: { L: /^[\w,+\-:^/.]+$/ }, attached: 'L', long: ['--porcelain', '--line-porcelain', '--incremental', '--show-name', '--show-number', '--show-email', '--root', '--show-stats'], longValues: { '--date': /^[\w:%-]+$/ } },
  branch: {
    flags: 'avrl',
    long: ['--all', '--remotes', '--list', '--verbose', '--show-current', '--no-color', '--ignore-case', '--omit-empty'],
    longValues: { '--contains': ANY, '--no-contains': ANY, '--merged': ANY, '--no-merged': ANY, '--points-at': ANY, '--sort': /^-?[\w:()-]+$/, '--format': FORMAT },
    longOptional: { '--color': COLOR, '--abbrev': NUM },
    // a positional names a branch to create unless the command lists (`-l`/`--list` patterns)
    check: (pos, seen) => pos.length === 0 || seen.has('-l') || seen.has('--list'),
  },
  'ls-files': { flags: 'cdmotsuvz', long: ['--cached', '--deleted', '--modified', '--others', '--stage', '--unmerged', '--exclude-standard', '--full-name', '--error-unmatch', '--directory', '--no-empty-directory', '--killed', '--eol', '--recurse-submodules'], longOptional: { '--abbrev': NUM } },
  'rev-parse': { flags: 'q', long: ['--show-toplevel', '--abbrev-ref', '--verify', '--git-dir', '--is-inside-work-tree', '--is-inside-git-dir', '--show-prefix', '--show-cdup', '--symbolic-full-name', '--absolute-git-dir', '--quiet', '--is-bare-repository', '--git-common-dir', '--symbolic', '--show-superproject-working-tree'], longOptional: { '--short': NUM } },
  describe: { long: ['--tags', '--always', '--long', '--contains', '--all', '--exact-match', '--first-parent'], longOptional: { '--abbrev': NUM, '--dirty': /^[\w-]*$/, '--broken': /^[\w-]*$/ }, longValues: { '--match': ANY, '--exclude': ANY, '--candidates': NUM } },
  grep: {
    flags: 'iIwvEFPlLchHnozWq',
    values: { e: ANY, f: ANY, A: NUM, B: NUM, C: NUM, m: NUM },
    attached: 'ABCm',
    long: ['--ignore-case', '--no-ignore-case', '--word-regexp', '--invert-match', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp', '--files-with-matches', '--files-without-match', '--name-only', '--count', '--line-number', '--column', '--only-matching', '--null', '--heading', '--break', '--full-name', '--show-function', '--function-context', '--no-color', '--cached', '--untracked', '--text', '--and', '--or', '--not', '--all-match', '--quiet', '--recursive', '--no-recursive'],
    longValues: { '--max-depth': /^-?\d+$/, '--max-count': NUM, '--after-context': NUM, '--before-context': NUM, '--context': NUM, '--regexp': ANY },
    longOptional: { '--color': COLOR },
  },
  'cat-file': { flags: 'ptse' },
  remote: { flags: 'v', long: ['--verbose'], check: (pos) => pos.length === 0 || (pos[0] === 'get-url' && pos.length === 2) },
};

/** git: no global options (`-c`, `-C`, `-p`, `--exec-path` …), a listed subcommand, and its option allowlist. */
function gitAllowed(args: string[]): boolean {
  const [sub, ...rest] = args;
  if (!sub || !Object.hasOwn(GIT, sub)) return false;
  if (!optionsAllowed(GIT[sub]!, rest)) return false;
  // `git log --format=…` checked above; `git log -1 --format …` (value in the next word) too
  return rest.every(GIT_FORMAT_OK);
}

const PROGRAMS: Record<string, OptSpec | ((args: string[]) => boolean)> = {
  cat: CAT,
  head: HEAD,
  tail: { ...HEAD, flags: 'qvz' }, // no -f/-F (follow never ends)
  wc: WC,
  ls: LS,
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: RG,
  sort: SORT,
  uniq: UNIQ,
  cut: CUT,
  tree: TREE,
  stat: STAT,
  file: FILE,
  md5sum: SUM,
  sha1sum: SUM,
  sha256sum: SUM,
  diff: DIFF,
  cmp: CMP,
  du: DU,
  column: COLUMN,
  realpath: REALPATH,
  readlink: READLINK,
  nl: NONE,
  tac: NONE,
  jq: JQ,
  awk: AWK,
  sed: SED,
  find: findAllowed,
  git: gitAllowed,
  // pure programs
  basename: { flags: 'az', values: { s: ANY } },
  dirname: { flags: 'z' },
  echo: { flags: 'neE' },
  printf: { check: (pos) => pos.length >= 1 }, // no -v (assigns a variable)
  pwd: { flags: 'LP' },
  which: { flags: 'a' },
  whoami: { check: (pos) => pos.length === 0 },
  true: NONE,
  false: NONE,
  test: NONE,
  '[': NONE,
  date: { flags: 'uIR', values: { d: ANY }, longValues: { '--date': ANY }, long: ['--utc', '--rfc-email'], longOptional: { '--iso-8601': /^\w*$/, '--rfc-3339': /^\w+$/ }, check: (pos) => pos.every((p) => p.startsWith('+')) }, // no -s/--set, -f/--file
  uname: { flags: 'asnrvmpio', long: ['--all', '--kernel-name', '--nodename', '--kernel-release', '--kernel-version', '--machine', '--processor', '--hardware-platform', '--operating-system'] },
  id: { flags: 'ugGnrz', check: (pos) => pos.length <= 1 },
  hostname: { check: (pos) => pos.length === 0 }, // `hostname NAME` sets it
  seq: { flags: 'w', values: { s: ANY }, check: (pos) => pos.length >= 1 && pos.every((p) => /^-?\d+(?:\.\d+)?$/.test(p)) },
  expr: NONE,
  sleep: { check: (pos) => pos.length === 1 && /^\d+(?:\.\d+)?[smh]?$/.test(pos[0]!) },
  df: { flags: 'hHkiTPal', long: ['--human-readable', '--si', '--inodes', '--print-type', '--portability', '--all', '--local', '--total'] },
  cd: NONE,
};

/**
 * True when the program is on the fast-path list and every option is on its allowlist. `test`/`[`/`expr` take no
 * options; their operands (`-f`, `-eq` …) are not options, so they are passed through as positionals there.
 */
export function readOnlyOptions(prog: string, args: string[]): boolean {
  const p = Object.hasOwn(PROGRAMS, prog) ? PROGRAMS[prog] : undefined;
  if (!p) return false;
  if (typeof p === 'function') return p(args);
  if (prog === 'test' || prog === '[' || prog === 'expr') return true; // operands only; containment still applies
  return optionsAllowed(p, args);
}

/** The programs with an allowlist (the fast path accepts nothing else). */
export const OPTION_ALLOWLISTED: ReadonlySet<string> = new Set(Object.keys(PROGRAMS));
