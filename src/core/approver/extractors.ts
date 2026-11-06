/**
 * N43 re-check finding B: archive extraction is never judged by its options in auto mode. Reading an archive's
 * member list and its destination from the command line kept missing spellings (`tar -C . -xf`, `tar -f x -x`,
 * `unzip -od dir`, `python3 -m zipfile -e`, `jar xf`, symlink members …), so any command that unpacks an archive
 * is on the floor: a human decides, whatever its options, destination or members, and the classifier never sees
 * it. Decompressing a single file to a computed name (`gunzip x.gz` → `x`) is checked against the
 * self-modification list instead; an explicit output (`-o`, `--output`) always asks.
 *
 * Every word of every simple command is scanned (wrappers such as `sudo`, `xargs`, `find -exec` put the program
 * later in the line), and `sh -c` / `$(…)` bodies are scanned too. Over-matching (`echo tar xf`) only costs a
 * prompt.
 */
import path from 'node:path';
import { normalizeCommand } from './normalize.js';
import { selfModificationPath } from './selfmod.js';

const base = (w: string) => path.basename(w).toLowerCase();
/** short option words (`-xf`, normalised to `-x -f` by normalizeCommand) and old-style key letters */
const shortHas = (args: string[], letters: RegExp) => args.some((a) => /^-[A-Za-z0-9]+$/.test(a) && letters.test(a.slice(1)));
const longHas = (args: string[], ...names: string[]) => args.some((a) => names.some((n) => a === n || a.startsWith(n + '=')));

/** Why this program invocation unpacks an archive (args: the words after the program), or null. */
function extractorCall(prog: string, args: string[], cwd: string, workspace: string): string | null {
  const first = args[0] ?? '';
  switch (prog) {
    case 'tar':
    case 'gtar':
    case 'bsdtar':
      // any x in a short cluster or in the old-style key (`tar xf`, `tar -C . -xf`, `tar -f a -x`), --extract/--get
      if (longHas(args, '--extract', '--get') || shortHas(args, /x/) || (/^[A-Za-z]+$/.test(first) && first.includes('x'))) return `${prog} extracts an archive`;
      return null;
    case 'unzip':
    case 'busybox-unzip': {
      // only listing, testing or printing to stdout reads without writing
      const opts = args.filter((a) => /^-[A-Za-z0-9]+$/.test(a));
      const listOnly = opts.length > 0 && opts.every((o) => /^-[lvtZ1zqpc]+$/.test(o)) && opts.some((o) => /[lvtZpc]/.test(o));
      return listOnly ? null : 'unzip extracts an archive';
    }
    case '7z':
    case '7za':
    case '7zr':
    case '7zz':
      return ['l', 't', 'i', 'h'].includes(args.find((a) => !a.startsWith('-')) ?? '') ? null : `${prog} extracts or writes an archive`;
    case 'unrar':
      return ['l', 'lt', 'lta', 'lb', 'v', 'vt', 'vta', 'vb', 't'].includes(args.find((a) => !a.startsWith('-')) ?? '') ? null : 'unrar extracts an archive';
    case 'unar':
    case 'dtrx':
    case 'atool':
    case 'aunpack':
      return `${prog} extracts an archive`;
    case 'jar':
      return /x/.test(first.replace(/^-/, '')) || longHas(args, '--extract') ? 'jar extracts an archive' : null;
    case 'cpio':
      return shortHas(args, /[ip]/) || longHas(args, '--extract', '--pass-through') ? 'cpio extracts or copies files' : null;
    case 'ar':
      return /[xrqmd]/.test(first.replace(/^-/, '')) ? 'ar extracts or modifies an archive' : null;
    case 'pax':
      return shortHas(args, /r/) ? 'pax extracts files' : null;
    case 'dpkg-deb':
      return shortHas(args, /[xXR]/) || longHas(args, '--extract', '--vextract', '--raw-extract', '--control') ? 'dpkg-deb extracts a package' : null;
    case 'rpm2archive':
      return null;
  }
  // python -m zipfile/tarfile -e, python -c "…unpack_archive / extractall…"
  if (/^(?:python[\d.]*|pypy[\d.]*)$/.test(prog)) {
    const m = args.indexOf('-m');
    if (m >= 0 && ['zipfile', 'tarfile', 'shutil'].includes(args[m + 1] ?? '') && (args.slice(m + 2).some((a) => /^(?:-e|--extract|-x)$/.test(a)) || args[m + 1] === 'shutil')) return `python -m ${args[m + 1]} extracts an archive`;
    if (args.some((a) => /\b(?:unpack_archive|extractall|extract_all)\b|\.extract\s*\(/.test(a))) return 'python code extracts an archive';
    return null;
  }
  if (/^(?:perl|ruby|node|deno|bun|php)$/.test(prog) && args.some((a) => /Archive::(?:Extract|Tar|Zip)|extract_archive|\bextractall\b|\bunpack_archive\b|adm-zip|extract-zip|\btar\.x\b|\.extractAllTo\b/.test(a))) return `${prog} code extracts an archive`;
  // single-file decompressors: an explicit output asks; the implicit output is checked like any write
  const decomp = /^(?:gunzip|unxz|unzstd|bunzip2|unlzma|uncompress|unlz4|zstdmt)$/.test(prog) || (/^(?:gzip|xz|zstd|bzip2|lzma|lz4|brotli|lzip|pigz|pbzip2)$/.test(prog) && (shortHas(args, /d/) || longHas(args, '--decompress', '--uncompress')));
  if (!decomp) return null;
  if (shortHas(args, /c/) || longHas(args, '--stdout', '--to-stdout')) return null; // to stdout: redirections are judged as writes
  if (args.some((a) => a === '-o' || /^-o./.test(a) || a.startsWith('--output'))) return `${prog} decompresses to a chosen file`;
  for (const a of args.filter((x) => !x.startsWith('-'))) {
    const out = path.resolve(cwd, a.replace(/\.(?:gz|tgz|z|Z|xz|txz|zst|bz2|tbz2?|lzma|lz4|br|lz)$/, ''));
    const hit = selfModificationPath(out, workspace);
    if (hit) return `${prog} writes ${hit}`;
  }
  return null;
}

const SHORT_NAMES = new Set(['ar', 'pax']);
const LAUNCHERS = new Set(['-exec', '-execdir', '-ok', '-okdir', 'busybox', 'exec', 'command', 'builtin', 'nice', 'nohup', 'timeout', 'time', 'stdbuf', 'ionice', 'chrt', 'taskset', 'setsid', 'flock', 'watch', 'parallel', 'firejail', 'strace', 'ltrace', 'unshare', 'nsenter', 'chroot', 'fakeroot', 'proot', 'env', 'sudo', 'doas', 'xargs']);

/** Why the command unpacks an archive (or decompresses onto a self-modification file), or null. */
export function archiveExtraction(command: string, cwd: string, workspace: string, depth = 0): string | null {
  if (depth > 3) return 'nested shell code too deep to check';
  let n;
  try {
    n = normalizeCommand(command);
  } catch {
    return /\b(?:tar|unzip|7z|jar|cpio|bsdtar|unrar|unar|zipfile|tarfile|unpack_archive|extractall)\b/.test(command) ? 'cannot parse a command that mentions an archive tool' : null;
  }
  for (const c of n.commands) {
    for (let i = 0; i < c.argv.length; i++) {
      const prog = base(c.argv[i]!);
      // short, common words are programs only where a program can stand
      if (SHORT_NAMES.has(prog) && i > 0 && !LAUNCHERS.has(base(c.argv[i - 1]!))) continue;
      const why = extractorCall(prog, c.argv.slice(i + 1), cwd, workspace);
      if (why) return why;
    }
  }
  for (const inner of [...n.shell, ...n.subst]) {
    const why = archiveExtraction(inner, cwd, workspace, depth + 1);
    if (why) return why;
  }
  return null;
}
