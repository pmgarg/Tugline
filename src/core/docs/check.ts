/**
 * WS12 N9: `tug docs check` — docs-as-code checks for CI (exit 1 on findings).
 *
 * Deterministic, no model, no network:
 *  - links: relative markdown links to files that don't exist, and #anchors
 *    that match no heading (GitHub slugs); external URLs are not fetched;
 *  - code references: inline-code paths (`src/x.ts`) that no longer exist, and
 *    `name()` / `Type.method()` references to identifiers no source file uses;
 *  - CLI flags: `tug <sub> --flag` in docs compared with `<cli> --help` and
 *    `<cli> <sub> --help` output (docs.check.cli);
 *  - snippets: fenced json/jsonc, js/ts, python, bash/sh blocks that don't parse.
 * A fence or link can be skipped with `<!-- docs-check: skip -->` on the line
 * before it; snippets with `…` placeholders are treated as partial and skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import picomatch from 'picomatch';
import type { HarnessConfig } from '../config.js';
import { docsConfig } from './config.js';
import { buildInventory, type Inventory } from './inventory.js';

export type FindingKind = 'link' | 'anchor' | 'code-ref' | 'symbol' | 'cli-flag' | 'cli-command' | 'snippet';

export interface DocFinding {
  file: string;
  line: number;
  kind: FindingKind;
  message: string;
}

export interface DocsCheckResult {
  files: string[];
  findings: DocFinding[];
  warnings: string[];
}

export interface DocsCheckOptions {
  config: HarnessConfig;
  workspace: string;
  /** restrict to these doc files (workspace-relative) */
  files?: string[];
  /** override docs.check.cli */
  cli?: string[];
}

/** GitHub-style heading slug. */
export function slug(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function headingSlugs(md: string): Set<string> {
  const out = new Set<string>();
  const counts = new Map<string, number>();
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (!h) continue;
    const s = slug(h[1]);
    const n = counts.get(s) ?? 0;
    counts.set(s, n + 1);
    out.add(n ? `${s}-${n}` : s);
  }
  for (const m of md.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) out.add(m[1]);
  return out;
}

interface Fence {
  lang: string;
  info: string;
  start: number;
  body: string[];
  skip: boolean;
}

function scanDoc(md: string): { fences: Fence[]; prose: { line: number; text: string; skip: boolean }[] } {
  const lines = md.split('\n');
  const fences: Fence[] = [];
  const prose: { line: number; text: string; skip: boolean }[] = [];
  let cur: Fence | undefined;
  let skipNext = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s*(```+|~~~+)\s*([\w+-]*)(.*)$/.exec(l);
    if (cur) {
      if (f && !f[2]) {
        fences.push(cur);
        cur = undefined;
      } else cur.body.push(l);
      continue;
    }
    if (f) {
      cur = { lang: f[2].toLowerCase(), info: f[3] ?? '', start: i + 1, body: [], skip: skipNext || /\b(skip|no-check|nocheck)\b/.test(f[3] ?? '') };
      skipNext = false;
      continue;
    }
    if (/<!--\s*docs-check:\s*skip\s*-->/.test(l)) {
      skipNext = true;
      continue;
    }
    prose.push({ line: i + 1, text: l, skip: skipNext });
    if (l.trim()) skipNext = false;
  }
  return { fences, prose };
}

/** Path-like code spans (with a directory part; bare file names are too ambiguous to call stale). */
const PATHLIKE = /^(?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z][\w]*$/;
const BUILD_DIRS = /(^|\/)(dist|build|out|node_modules|coverage|target|\.venv|venv)\//;
/** Per-user or per-workspace config locations (`.tugline/config.json`, `.vscode/settings.json`) and import specifiers (`../x.js`) are not repository paths. */
const NOT_REPO_PATH = /^(\.[\w-]+\/|\.\.\/|~)/;
const ALWAYS_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V']);
const GLOBAL_IDENTS = new Set('require import console process setTimeout setInterval clearTimeout fetch JSON Math Object Array Promise String Number Date Error RegExp Map Set Symbol Buffer URL print len range open str int dict list super self this main help exit'.split(' '));

/** Every identifier used in the code (definitions and uses), for stale-symbol checks. */
function identifierSet(inv: Inventory): Set<string> {
  const ids = new Set<string>();
  for (const f of inv.files) {
    if (f.kind !== 'code') continue;
    for (const m of inv.read(f.rel).matchAll(/[A-Za-z_$][\w$]*/g)) ids.add(m[0]);
  }
  return ids;
}

// ------------------------------------------------------------ CLI help

export interface CliHelp {
  flags: Set<string>;
  subcommands: Set<string>;
}

function runHelp(argv: string[], ws: string): string | undefined {
  const r = spawnSync(argv[0], argv.slice(1), { cwd: ws, encoding: 'utf8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  if (r.error) return undefined;
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
}

export function parseHelp(text: string, cliName: string): CliHelp {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const flags = new Set([...plain.matchAll(/(?:^|[\s[(,|])(--[a-z0-9][\w-]*)/gim)].map((m) => m[1]));
  for (const m of plain.matchAll(/(?:^|[\s[(,|])-([a-zA-Z])\b/g)) flags.add(`-${m[1]}`);
  const subcommands = new Set([...plain.matchAll(new RegExp(String.raw`(?:^|\s)${cliName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s+([a-z][\w-]*)`, 'gm'))].map((m) => m[1]));
  return { flags, subcommands };
}

/** `tug …` invocations in a line of docs: [subcommand?, flags[]] */
export function cliInvocations(line: string, cliName: string): { sub?: string; flags: string[]; col: number }[] {
  const out: { sub?: string; flags: string[]; col: number }[] = [];
  const re = new RegExp(String.raw`(?:^|[\s\`$(|&;])${cliName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:\s+(?:"[^"]*"|'[^']*'|[^\s\`|;&#]+))*)`, 'g');
  for (const m of line.matchAll(re)) {
    const toks = (m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((t) => !t.startsWith('"') && !t.startsWith("'"));
    const sub = toks[0] && /^[a-z][\w-]*$/.test(toks[0]) ? toks[0] : undefined;
    const flags = toks.filter((t) => /^--?[a-zA-Z][\w-]*(=.*)?$/.test(t)).map((t) => t.replace(/=.*$/, ''));
    out.push({ sub, flags, col: m.index ?? 0 });
  }
  return out;
}

// ------------------------------------------------------------ snippets

let tsMod: any | null | undefined;
async function typescript(): Promise<any | null> {
  if (tsMod !== undefined) return tsMod;
  try {
    tsMod = (await import('typescript')).default;
  } catch {
    tsMod = null;
  }
  return tsMod;
}

function stripJsonComments(s: string): string {
  let out = '';
  let str = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (str) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') str = false;
      continue;
    }
    if (c === '"') {
      str = true;
      out += c;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const has = (bin: string) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
};
let pyOk: boolean | undefined;

/** Parse one snippet; returns an error message (with the 1-based line inside the snippet) or undefined. */
export async function snippetError(lang: string, code: string): Promise<{ message: string; line?: number } | undefined | 'skipped'> {
  // partial snippets ("…", a lone "...") are illustrations, not code
  if (/…/.test(code) || /^\s*\.\.\.\s*$/m.test(code)) return 'skipped';
  if (lang === 'json' || lang === 'jsonc' || lang === 'json5') {
    try {
      JSON.parse(lang === 'json' ? code : stripJsonComments(code));
      return undefined;
    } catch (e) {
      // a JSONC fragment of an object (`"key": {…},`) is fine if it parses inside braces
      if (lang !== 'json') {
        try {
          JSON.parse(`{${stripJsonComments(code).trim().replace(/,\s*$/, '')}}`);
          return undefined;
        } catch {
          /* report the original error */
        }
      }
      const pos = /position (\d+)/.exec((e as Error).message);
      const line = pos ? code.slice(0, Number(pos[1])).split('\n').length : undefined;
      return { message: `invalid ${lang.toUpperCase()}: ${(e as Error).message.replace(/ in JSON at position \d+.*$/, '')}`, line };
    }
  }
  if (['js', 'javascript', 'mjs', 'cjs', 'jsx', 'ts', 'typescript', 'tsx'].includes(lang)) {
    const ts = await typescript();
    if (ts) {
      const jsx = lang.endsWith('x');
      const file = `snippet.${lang.startsWith('t') ? (jsx ? 'tsx' : 'ts') : jsx ? 'jsx' : 'js'}`;
      const out = ts.transpileModule(code, { fileName: file, reportDiagnostics: true, compilerOptions: jsx ? { target: 99, module: 99, jsx: 2 } : { target: 99, module: 99 } });
      const d = out.diagnostics?.find((x: any) => x.category === 1);
      if (!d) return undefined;
      const line = d.start !== undefined ? code.slice(0, d.start).split('\n').length : undefined;
      return { message: `does not parse: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`, line };
    }
    if (lang.startsWith('t')) return 'skipped';
    try {
      new vm.Script(code.replace(/^\s*(import|export)\b.*$/gm, ''));
      return undefined;
    } catch (e) {
      return { message: `does not parse: ${(e as Error).message}` };
    }
  }
  if (lang === 'python' || lang === 'py') {
    pyOk ??= has('python3');
    if (!pyOk) return 'skipped';
    const r = spawnSync('python3', ['-I', '-c', 'import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f"{e.lineno}\\t{e.msg}"); sys.exit(1)'], { input: code, encoding: 'utf8', timeout: 10_000 });
    if (r.status === 0) return undefined;
    const [ln, msg] = (r.stdout || '').trim().split('\t');
    return { message: `does not parse: ${msg ?? r.stderr?.trim().split('\n').pop()}`, line: Number(ln) || undefined };
  }
  if (['bash', 'sh', 'shell', 'zsh'].includes(lang)) {
    // `<placeholder>` arguments are documentation, not redirections
    const r = spawnSync('bash', ['-n'], { input: code.replace(/<([a-zA-Z][\w.|-]*)>/g, 'PLACEHOLDER'), encoding: 'utf8', timeout: 10_000 });
    if (r.error) return 'skipped';
    if (r.status === 0) return undefined;
    const m = /line (\d+): (.*)/.exec(r.stderr ?? '');
    return { message: `does not parse: ${m?.[2] ?? r.stderr?.trim()}`, line: m ? Number(m[1]) : undefined };
  }
  return 'skipped';
}

/** Every tracked or untracked (not ignored) path, for reference checks. */
function listAll(ws: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ws, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 10_000 }).toString().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ the check

export async function docsCheck(o: DocsCheckOptions): Promise<DocsCheckResult> {
  const ws = path.resolve(o.workspace);
  const dc = docsConfig(o.config).check;
  const inv = buildInventory(ws);
  const isDoc = picomatch(dc.docs, { dot: false });
  const wiki = docsConfig(o.config).wiki.outDir.replace(/\/+$/, '');
  const files = (o.files ?? inv.files.filter((f) => f.kind === 'doc' && /\.(md|mdx|markdown)$/.test(f.rel) && isDoc(f.rel) && !f.rel.startsWith(`${wiki}/`)).map((f) => f.rel)).sort();
  const findings: DocFinding[] = [];
  const warnings: string[] = [];
  const add = (file: string, line: number, kind: FindingKind, message: string) => findings.push({ file, line, kind, message });
  const idents = dc.codeRefs ? identifierSet(inv) : new Set<string>();
  let all: string[] | undefined;
  const allPaths = () => (all ??= listAll(ws));
  const slugCache = new Map<string, Set<string> | undefined>();
  const slugsOf = (rel: string) => {
    if (!slugCache.has(rel)) {
      try {
        slugCache.set(rel, headingSlugs(fs.readFileSync(path.join(ws, rel), 'utf8')));
      } catch {
        slugCache.set(rel, undefined);
      }
    }
    return slugCache.get(rel);
  };
  // CLI help, fetched once per subcommand
  const cliArgv = o.cli ?? dc.cli;
  let globalHelp: CliHelp | undefined | null;
  const subHelp = new Map<string, CliHelp | undefined>();
  const help = (sub?: string): CliHelp | undefined => {
    if (!cliArgv.length) return undefined;
    if (globalHelp === undefined) {
      const t = runHelp([...cliArgv, '--help'], ws);
      globalHelp = t ? parseHelp(t, dc.cliName) : null;
      if (!globalHelp) warnings.push(`could not run "${cliArgv.join(' ')} --help": CLI flag check skipped (set docs.check.cli)`);
    }
    if (!globalHelp) return undefined;
    if (!sub) return globalHelp;
    if (!subHelp.has(sub)) {
      const t = runHelp([...cliArgv, sub, '--help'], ws);
      const h = t ? parseHelp(t, dc.cliName) : undefined;
      subHelp.set(sub, h ? { flags: new Set([...globalHelp.flags, ...h.flags]), subcommands: globalHelp.subcommands } : globalHelp);
    }
    return subHelp.get(sub);
  };

  for (const rel of files) {
    const md = fs.readFileSync(path.join(ws, rel), 'utf8');
    const { fences, prose } = scanDoc(md);
    for (const p of prose) {
      if (p.skip) continue;
      const text = p.text;
      // ---- links
      if (dc.links) {
        // links inside inline code are examples, not links
        const linkText = text.replace(/`[^`\n]*`/g, '');
        const targets = [...linkText.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...linkText.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/g)].map((m) => m[1]);
        for (const t of targets) {
          if (/^[a-z][\w+.-]*:/i.test(t) || t.startsWith('//')) continue; // external: never fetched
          const [p0, anchor] = t.split('#');
          const target = p0 ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), decodeURI(p0))) : rel;
          if (p0) {
            if (target.startsWith('..') || !fs.existsSync(path.join(ws, target))) {
              add(rel, p.line, 'link', `broken link: ${t} (${target} does not exist)`);
              continue;
            }
          }
          if (anchor && /\.(md|mdx|markdown)$/.test(target) && !/^L\d+/.test(anchor)) {
            const s = slugsOf(target);
            if (s && !s.has(anchor.toLowerCase())) add(rel, p.line, 'anchor', `broken anchor: ${t} (no heading "#${anchor}" in ${target})`);
          }
        }
      }
      const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
      // ---- code references
      if (dc.codeRefs) {
        for (const s of spans) {
          if (PATHLIKE.test(s) && !/[*?{}<>$]/.test(s) && !s.startsWith('~') && !BUILD_DIRS.test(s) && !NOT_REPO_PATH.test(s) && !/^[a-z]+:\/\//.test(s)) {
            if (!pathExists(s, rel)) add(rel, p.line, 'code-ref', `stale path reference: \`${s}\` does not exist`);
            continue;
          }
          const call = /^(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\(\)$/.exec(s);
          if (call) {
            const name = call[2];
            if (!GLOBAL_IDENTS.has(name) && !(call[1] && GLOBAL_IDENTS.has(call[1])) && !idents.has(name)) add(rel, p.line, 'symbol', `stale symbol reference: \`${s}\` — no source file defines or uses ${name}`);
          }
        }
      }
      // ---- CLI flags in inline code
      if (dc.cliFlags) for (const s of spans) checkCli(rel, p.line, s);
    }
    for (const f of fences) {
      if (f.skip) continue;
      if (dc.cliFlags && (['', 'bash', 'sh', 'shell', 'console', 'zsh', 'text'].includes(f.lang))) f.body.forEach((l, i) => checkCli(rel, f.start + 1 + i, l.replace(/^\s*\$\s*/, '').replace(/\s#.*$/, '')));
      if (dc.snippets && f.lang && f.lang !== 'mermaid') {
        const r = await snippetError(f.lang, f.body.join('\n'));
        if (r && r !== 'skipped') add(rel, f.start + (r.line ?? 1), 'snippet', `${f.lang} snippet ${r.message}`);
      }
    }
  }

  /** A doc path exists: from the root, relative to the doc, as a suffix of a repo path, or as the .ts source of an ESM .js specifier. */
  function pathExists(span: string, docRel: string): boolean {
    const clean = span.replace(/^\.\//, '');
    // a path into a top-level directory this repository doesn't have describes another tree
    // (a test fixture, a packaged .vsix, a user's project), not this one
    const top = clean.split('/')[0];
    if (!clean.startsWith('../') && !fs.existsSync(path.join(ws, top)) && !fs.existsSync(path.join(ws, path.posix.dirname(docRel), top))) return true;
    const variants = [clean, ...(/\.(m|c)?js$/.test(clean) ? ['.ts', '.tsx', '.mts', '.cts'].map((e) => clean.replace(/\.(m|c)?js$/, e)) : [])];
    for (const v of variants) {
      if (fs.existsSync(path.join(ws, v)) || fs.existsSync(path.join(ws, path.posix.dirname(docRel), v))) return true;
      if (!v.startsWith('../') && allPaths().some((a) => a === v || a.endsWith(`/${v}`) || a.startsWith(`${v.replace(/\/$/, '')}/`))) return true;
    }
    return false;
  }

  function checkCli(rel: string, line: number, text: string): void {
    for (const inv_ of cliInvocations(text, dc.cliName)) {
      if (!inv_.flags.length && !inv_.sub) continue;
      const g = help();
      if (!g) return;
      const known = g.subcommands.size > 0 && inv_.sub && !g.subcommands.has(inv_.sub);
      const h = inv_.sub && !known ? help(inv_.sub) : g;
      for (const fl of inv_.flags) if (h && !ALWAYS_FLAGS.has(fl) && !h.flags.has(fl)) add(rel, line, 'cli-flag', `${dc.cliName}${inv_.sub ? ` ${inv_.sub}` : ''}: unknown flag ${fl} (not in \`${dc.cliName}${inv_.sub ? ` ${inv_.sub}` : ''} --help\`)`);
    }
  }

  // dedupe (a flag can appear in several invocations on one line)
  const seen = new Set<string>();
  const uniq = findings.filter((f) => {
    const k = `${f.file}:${f.line}:${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { files, findings: uniq, warnings };
}

export function formatFindings(r: DocsCheckResult, format: 'text' | 'github' | 'json'): string {
  if (format === 'json') return JSON.stringify(r, null, 2);
  if (format === 'github') {
    const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    const prop = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
    return [...r.findings.map((f) => `::error file=${prop(f.file)},line=${f.line},title=${prop(`docs ${f.kind}`)}::${data(f.message)}`), ...r.warnings.map((w) => `::warning::${data(w)}`), `docs check: ${r.findings.length} problem(s) in ${r.files.length} file(s)`].join('\n');
  }
  return [...r.findings.map((f) => `${f.file}:${f.line}: [${f.kind}] ${f.message}`), ...r.warnings.map((w) => `warning: ${w}`), `${r.findings.length ? '✗' : '✓'} docs check: ${r.findings.length} problem(s) in ${r.files.length} file(s)`].join('\n');
}
