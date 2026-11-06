/**
 * Optional tree-sitter runtime shared by A6 (post-edit syntax check, verify.ts)
 * and D7 (repo-map definitions, context/repomap.ts).
 *
 * Nothing here is a hard dependency. The runtime is `web-tree-sitter` (MIT) and
 * the grammars are prebuilt .wasm files, found in this order:
 *   1. `TUG_TREE_SITTER_WASM_DIR` / `TUG_TREE_SITTER_DIR` (path lists),
 *   2. directories passed to `configureTreeSitter` (the VS Code extension points
 *      at its bundled `resources/tree-sitter/`),
 *   3. the optional npm packages: `@vscode/tree-sitter-wasm` (MIT; ts, tsx, js,
 *      py, go, rust, java, css, bash, ruby, php, cpp, c#), `tree-sitter-html`
 *      and `@tree-sitter-grammars/tree-sitter-yaml` (MIT, they ship their .wasm),
 *      and a user-installed `tree-sitter-wasms` (the hook D7 always had).
 * A directory that holds `web-tree-sitter.cjs` (plus its `web-tree-sitter.wasm`)
 * also supplies the runtime, so a bundle without node_modules works. Every
 * failure — module missing, wasm missing, ABI mismatch, parse timeout — means
 * "no tree-sitter for this file" and the caller uses its fallback.
 *
 * Everything is lazy: the runtime is initialised on the first parse, and each
 * grammar is loaded the first time a file of that language is seen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Grammar (wasm basename `tree-sitter-<name>.wasm`) per file extension. */
export const GRAMMAR_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.css': 'css', '.html': 'html', '.htm': 'html', '.yaml': 'yaml', '.yml': 'yaml',
  '.sh': 'bash', '.bash': 'bash',
};

/**
 * Grammars the VS Code extension bundles (vscode/scripts/build.mjs). ruby, php,
 * cpp and c# are left out of the bundle to keep it small; with the npm package
 * they are used for repo-map definitions too.
 */
export const BUNDLED_GRAMMARS = ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java', 'css', 'html', 'yaml', 'bash'];

/** Optional npm packages that hold grammar wasm, and the sub-directory it lives in. */
const GRAMMAR_PACKAGES: [pkg: string, sub: string][] = [
  ['@vscode/tree-sitter-wasm', 'wasm'],
  ['tree-sitter-html', ''],
  ['@tree-sitter-grammars/tree-sitter-yaml', ''],
  ['tree-sitter-wasms', 'out'],
];

const MAX_PARSE_BYTES = 2 * 1024 * 1024;
const PARSE_BUDGET_MS = 2000;

/** The subset of the web-tree-sitter API used here (kept loose: 0.22–0.27 differ in details). */
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  isMissing: boolean | (() => boolean);
  hasError: boolean | (() => boolean);
  parent: TsNode | null;
  childCount: number;
  child(i: number): TsNode | null;
  namedChildren: TsNode[];
  childForFieldName(name: string): TsNode | null;
}
export interface TsTree {
  rootNode: TsNode;
  delete?(): void;
}

interface Runtime {
  Parser: any;
  Language: any;
}

let configuredDirs: string[] = [];
let importer: () => Promise<any> = () => import(['web', 'tree', 'sitter'].join('-'));
let runtime: Promise<Runtime | undefined> | undefined;
const grammars = new Map<string, Promise<any | undefined>>();
const parsers = new Map<string, any>();

/** Point at extra directories holding grammar wasm (and optionally the runtime). Resets the cache. */
export function configureTreeSitter(opts: { dirs?: string[] } = {}): void {
  configuredDirs = (opts.dirs ?? []).filter(Boolean);
  resetTreeSitter();
}

/**
 * Testing: replace `import('web-tree-sitter')` (e.g. with one that throws
 * ERR_MODULE_NOT_FOUND) to exercise the "package absent" path. undefined restores it.
 */
export function setTreeSitterImport(fn: (() => Promise<any>) | undefined): void {
  importer = fn ?? (() => import(['web', 'tree', 'sitter'].join('-')));
  resetTreeSitter();
}

/** Forget the loaded runtime, grammars and parsers (env or configuration changed). */
export function resetTreeSitter(): void {
  for (const p of parsers.values()) {
    try {
      p.delete?.();
    } catch {
      /* already gone */
    }
  }
  parsers.clear();
  grammars.clear();
  runtime = undefined;
}

const req = createRequire(import.meta.url);

function packageDir(pkg: string): string | undefined {
  try {
    return path.dirname(req.resolve(`${pkg}/package.json`));
  } catch {
    /* not installed, or package.json not exported */
  }
  try {
    let d = path.dirname(req.resolve(pkg));
    for (let i = 0; i < 4; i++, d = path.dirname(d)) if (fs.existsSync(path.join(d, 'package.json'))) return d;
  } catch {
    /* not installed */
  }
  return undefined;
}

/** Candidate grammar directories, in priority order, existing ones only. */
export function grammarDirs(): string[] {
  const env = [process.env.TUG_TREE_SITTER_WASM_DIR, process.env.TUG_TREE_SITTER_DIR].flatMap((v) => (v ? v.split(path.delimiter) : []));
  const pkgs = GRAMMAR_PACKAGES.map(([pkg, sub]) => {
    const d = packageDir(pkg);
    return d ? path.join(d, sub) : undefined;
  });
  const out: string[] = [];
  for (const d of [...env, ...configuredDirs, ...pkgs, path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out')]) {
    if (!d) continue;
    const abs = path.resolve(d);
    if (!out.includes(abs) && fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

async function loadRuntime(): Promise<Runtime | undefined> {
  // 1. a directory that carries the runtime itself (the VS Code bundle)
  for (const d of grammarDirs()) {
    const cjs = path.join(d, 'web-tree-sitter.cjs');
    const esm = path.join(d, 'web-tree-sitter.js');
    if (!fs.existsSync(path.join(d, 'web-tree-sitter.wasm')) || !(fs.existsSync(cjs) || fs.existsSync(esm))) continue;
    try {
      const mod = fs.existsSync(cjs) ? req(cjs) : await import(pathToFileURL(esm).href);
      const rt = await init(mod, (f: string) => path.join(d, f));
      if (rt) return rt;
    } catch {
      /* try the next one */
    }
  }
  // 2. the npm package
  try {
    return await init(await importer());
  } catch {
    return undefined;
  }
}

async function init(mod: any, locateFile?: (f: string) => string): Promise<Runtime | undefined> {
  const Parser = mod?.Parser ?? mod?.default?.Parser ?? mod?.default ?? mod;
  const Language = mod?.Language ?? mod?.default?.Language ?? Parser?.Language;
  if (typeof Parser?.init !== 'function' || typeof Language?.load !== 'function') return undefined;
  await Parser.init(locateFile ? { locateFile } : undefined);
  return { Parser, Language };
}

/** The runtime, or undefined when web-tree-sitter is unavailable. Never throws. */
export function treeSitterRuntime(): Promise<Runtime | undefined> {
  runtime ??= loadRuntime().catch(() => undefined);
  return runtime;
}

/** True when the runtime loads and at least one grammar directory exists. */
export async function treeSitterAvailable(): Promise<boolean> {
  return !!(await treeSitterRuntime()) && grammarDirs().length > 0;
}

/** Path of `tree-sitter-<name>.wasm` in the first directory that has it. */
export function grammarFile(name: string): string | undefined {
  for (const d of grammarDirs()) {
    const f = path.join(d, `tree-sitter-${name}.wasm`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

function loadGrammar(name: string): Promise<any | undefined> {
  let g = grammars.get(name);
  if (!g) {
    g = (async () => {
      const rt = await treeSitterRuntime();
      const file = rt && grammarFile(name);
      if (!rt || !file) return undefined;
      return rt.Language.load(file);
    })().catch(() => undefined);
    grammars.set(name, g);
  }
  return g;
}

/**
 * Parse `text` with grammar `name`. Resolves undefined when tree-sitter or the
 * grammar is unavailable, the text is too large, or parsing exceeds its budget.
 * The caller must call `tree.delete?.()` when done (wasm memory).
 */
export async function parseText(name: string, text: string): Promise<TsTree | undefined> {
  if (text.length > MAX_PARSE_BYTES) return undefined;
  const language = await loadGrammar(name);
  const rt = await treeSitterRuntime();
  if (!language || !rt) return undefined;
  let parser = parsers.get(name);
  if (!parser) {
    parser = new rt.Parser();
    parser.setLanguage(language);
    parsers.set(name, parser);
  }
  const deadline = Date.now() + PARSE_BUDGET_MS;
  try {
    // progressCallback returning true cancels the parse (pathological input)
    return (parser.parse(text, null, { progressCallback: () => Date.now() > deadline }) as TsTree | null) ?? undefined;
  } catch {
    parser.delete?.();
    parsers.delete(name);
    return undefined;
  }
}

/** The grammar for a file path, by extension (undefined = none). */
export function grammarFor(file: string): string | undefined {
  return GRAMMAR_BY_EXT[path.extname(file).toLowerCase()];
}

export const flag = (v: boolean | (() => boolean) | undefined): boolean => (typeof v === 'function' ? v() : !!v);
