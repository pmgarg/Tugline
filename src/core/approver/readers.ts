/**
 * N43 (review finding 1): ONE list of the programs the auto-mode read-only fast path accepts, shared with the
 * prefilter's outside-read check, so a program can never be "read-only enough to skip the model" without the floor
 * also knowing that it reads files (`sort ~/.config/gh/hosts.yml` used to be fast-pathed while `cat` of it was a
 * floor hit). Base list: Qwen Code utils/shellAstParser.ts READ_ONLY_ROOT_COMMANDS (c726d2c), without `printenv`
 * (environment dump), `ps` (`ps e` shows process environments), `less`/`more` (they run commands); plus a few
 * file readers and pure utilities.
 */

/** Programs that read the files named in their arguments. */
export const FILE_READERS: readonly string[] = ['awk', 'cat', 'column', 'cut', 'du', 'find', 'grep', 'egrep', 'fgrep', 'head', 'ls', 'rg', 'ripgrep', 'sed', 'sort', 'stat', 'tail', 'tree', 'uniq', 'wc', 'nl', 'tac', 'file', 'md5sum', 'sha1sum', 'sha256sum', 'diff', 'cmp', 'jq', 'realpath', 'readlink', 'git'];

/** Programs that read nothing from the file system (or only what any process can see). */
export const PURE_PROGRAMS: readonly string[] = ['basename', 'cd', 'df', 'dirname', 'echo', 'printf', 'pwd', 'which', 'whoami', 'true', 'false', 'test', '[', 'date', 'uname', 'id', 'hostname', 'seq', 'expr', 'sleep'];

/** Every program the read-only fast path may accept (each still has to pass its per-program rules). */
export const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([...FILE_READERS, ...PURE_PROGRAMS]);

/** Readers whose first positional argument is a pattern or a script, not a file. */
export const PATTERN_FIRST: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ripgrep', 'ag', 'ack', 'sed', 'awk', 'jq']);
