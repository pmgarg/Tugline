/**
 * R1 layer 1 (static): the files a shell command line will write, derived from
 * the command itself, so the permission engine can hold protected paths and
 * agent-control files for `bash` as it does for the file tools.
 *
 * Built on the G1 lexer (`approver/normalize.ts`): quotes, escapes, wrappers
 * (`sudo`, `env`, `nice`, `timeout`, `xargs` …), program-name spellings and
 * combined flags are already resolved, and `sh -c` / `$(…)` / `eval` code is
 * analysed recursively. A bare `cd DIR` moves later relative targets.
 *
 * It cannot be complete (`python -c`, scripts, `make`, `git stash pop` …): an
 * unknown program yields no targets, not "safe". Layer 2 (protectGuard.ts)
 * fingerprints the protected set around every command and restores it, and
 * layer 3 (the OS sandbox) mounts it read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCommand, type SimpleCommand } from '../approver/normalize.js';

export interface ShellWrite {
  /** Absolute path (lexically resolved against the command's cwd; symlinks are resolved by the caller). */
  path: string;
  /** write: content or metadata changes; remove: the path (and everything under it) goes away. */
  op: 'write' | 'remove';
  /** The program or redirection that writes it, for messages. */
  by: string;
}

const FILE_REDIR = /^(?:\d*(?:>|>>|>\||<>)|&>|&>>|>&)$/;

/** Positional words of argv[1..], skipping options and the values of `valueOpts`. */
function positionals(args: string[], valueOpts: string[] = []): string[] {
  const out: string[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (valueOpts.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function optValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) if (names.includes(args[i]!)) return args[i + 1];
  return undefined;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Destination files of cp/mv/install/ln: `dest/basename(src)` when dest is an existing directory. */
function intoDest(cwd: string, srcs: string[], dest: string, forceDir: boolean): string[] {
  const d = path.resolve(cwd, dest);
  if (forceDir || isDir(d) || dest.endsWith('/')) return srcs.length ? srcs.map((s) => path.join(d, path.basename(s.replace(/\/+$/, '')))) : [d];
  return [d];
}

function targetsOf(c: SimpleCommand, cwd: string): ShellWrite[] {
  const out: ShellWrite[] = [];
  const add = (p: string | undefined, op: ShellWrite['op'], by: string) => {
    if (p && !/^\$|^-$/.test(p) && !/^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/.test(p)) out.push({ path: path.resolve(cwd, p), op, by });
  };
  for (const r of c.redirs) if (FILE_REDIR.test(r.op) && !(r.op === '>&' && /^\d+$|^-$/.test(r.target))) add(r.target, 'write', r.op.replace(/^\d+/, ''));
  const [prog, ...args] = c.argv;
  if (!prog) return out;
  switch (prog) {
    case 'tee':
      for (const p of positionals(args)) add(p, 'write', 'tee');
      break;
    case 'cp':
    case 'install':
    case 'ln':
    case 'mv': {
      const t = optValue(args, ['-t', '--target-directory']);
      const pos = positionals(args, ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group']);
      if (prog === 'install' && args.includes('-d')) {
        for (const p of pos) add(p, 'write', prog);
        break;
      }
      const srcs = t ? pos : pos.slice(0, -1);
      const dests = t ? intoDest(cwd, srcs, t, true) : pos.length >= 2 ? intoDest(cwd, srcs, pos[pos.length - 1]!, false) : prog === 'ln' && pos.length === 1 ? [path.resolve(cwd, path.basename(pos[0]!))] : [];
      for (const d of dests) add(d, 'write', prog);
      // mv removes its sources (`mv tests tests.bak` replaces the protected directory)
      if (prog === 'mv') for (const s of srcs) add(s, 'remove', 'mv');
      break;
    }
    case 'rsync': {
      const pos = positionals(args, ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--files-from', '--chmod', '--chown', '-B', '--block-size', '-T', '--temp-dir', '--partial-dir', '--backup-dir', '--suffix']).filter((p) => !/^[^/]*:/.test(p));
      if (pos.length >= 2) {
        const dest = pos[pos.length - 1]!;
        const del = args.some((a) => /^--del(?:ete(?:-\w+)?)?$/.test(a));
        add(dest, del ? 'remove' : 'write', 'rsync');
        if (args.includes('--remove-source-files')) for (const s of pos.slice(0, -1)) add(s, 'remove', 'rsync');
      }
      break;
    }
    case 'sed':
    case 'perl':
    case 'ruby': {
      if (!args.some((a) => a === '-i' || a === '--in-place' || /^-i\S/.test(a) || a.startsWith('--in-place'))) break;
      const valueOpts = prog === 'sed' ? ['-e', '--expression', '-f', '--file', '-l', '--line-length'] : ['-e', '-E', '-I', '-M', '-m', '-x', '-l', '-C', '-r'];
      let pos = positionals(args, valueOpts);
      const scriptGiven = args.some((a) => (prog === 'sed' ? ['-e', '--expression', '-f', '--file'] : ['-e', '-E']).includes(a));
      if (!scriptGiven) pos = pos.slice(1);
      for (const p of pos) add(p, 'write', `${prog} -i`);
      break;
    }
    case 'truncate':
      for (const p of positionals(args, ['-s', '--size', '-r', '--reference'])) add(p, 'write', 'truncate');
      break;
    case 'touch':
      for (const p of positionals(args, ['-r', '--reference', '-d', '--date', '-t'])) add(p, 'write', 'touch');
      break;
    case 'mkdir':
      // `mkdir -p` of a directory that exists changes nothing
      for (const p of positionals(args, ['-m', '--mode'])) if (!isDir(path.resolve(cwd, p))) add(p, 'write', 'mkdir');
      break;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      for (const p of positionals(args, ['--reference']).slice(args.some((a) => a.startsWith('--reference')) ? 0 : 1)) add(p, 'write', prog);
      break;
    case 'shred':
      for (const p of positionals(args, ['-n', '--iterations', '-s', '--size'])) add(p, args.includes('-u') || args.includes('--remove') ? 'remove' : 'write', 'shred');
      break;
    case 'rm':
    case 'unlink':
    case 'rmdir':
      for (const p of positionals(args)) add(p, 'remove', prog);
      break;
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) add(a.slice(3), 'write', 'dd');
      break;
    case 'curl': {
      const o = optValue(args, ['-o', '--output']);
      add(o, 'write', 'curl -o');
      break;
    }
    case 'wget': {
      add(optValue(args, ['-O', '--output-document']), 'write', 'wget -O');
      break;
    }
    case 'git': {
      let i = 0;
      let gcwd = cwd;
      while (i < args.length && args[i]!.startsWith('-')) {
        if (args[i] === '-C' && args[i + 1]) gcwd = path.resolve(gcwd, args[i + 1]!);
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]!) ? 2 : 1;
      }
      const sub = args[i];
      const rest = args.slice(i + 1);
      const dd = rest.indexOf('--');
      if (sub === 'checkout' || sub === 'restore') {
        const pos = dd >= 0 ? rest.slice(dd + 1) : positionals(rest, ['-s', '--source', '-b', '-B', '--conflict']).filter((p) => fs.existsSync(path.resolve(gcwd, p)));
        for (const p of pos) out.push({ path: path.resolve(gcwd, p), op: 'write', by: `git ${sub}` });
      } else if (sub === 'rm' || sub === 'mv') {
        const pos = positionals(rest);
        for (const p of sub === 'rm' ? pos : pos.slice(0, -1)) out.push({ path: path.resolve(gcwd, p), op: 'remove', by: `git ${sub}` });
        if (sub === 'mv' && pos.length >= 2) for (const d of intoDest(gcwd, pos.slice(0, -1), pos[pos.length - 1]!, false)) out.push({ path: d, op: 'write', by: 'git mv' });
      }
      break;
    }
  }
  return out;
}

/** Every file a command line writes or removes that can be known without running it. */
export function shellWriteTargets(command: string, cwd: string, depth = 0): ShellWrite[] {
  const n = normalizeCommand(command);
  const out: ShellWrite[] = [];
  let dir = cwd;
  for (const c of n.commands) {
    if (c.argv[0] === 'cd' && c.argv.length <= 2) {
      if (c.argv[1] && !/^[$~-]/.test(c.argv[1])) dir = path.resolve(dir, c.argv[1]);
      continue;
    }
    out.push(...targetsOf(c, dir));
  }
  if (depth < 4) for (const inner of [...n.shell, ...n.subst]) out.push(...shellWriteTargets(inner, dir, depth + 1));
  return out;
}
