/**
 * Repo map (SPEC D7, after Aider): a ranked, token-budgeted outline of the
 * definitions in a repository, so the model knows where things live before it
 * spends turns on grep.
 *
 *   1. extract definitions per file: tree-sitter when `web-tree-sitter` and a
 *      grammar are installed (optional, lazy; ts/js, Python, Go, Rust, Java),
 *      otherwise per-language regexes (the mandatory fallback);
 *   2. build a file graph: G → F when G uses an identifier that F defines;
 *   3. PageRank over that graph, personalised towards files mentioned in the
 *      prompt or recently edited, and identifiers mentioned in the prompt;
 *   4. rank definitions by the rank that flows into them, and render as many
 *      as fit the token budget:  path:\n  ⋮ class Bar\n  ⋮   method(a, b)
 * Per-file extraction is cached by mtime + size.
 */
import { NO_ATTR_FILES, repoDriverOverrides } from './worktreeGit.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import picomatch from 'picomatch';
import { estimateTokens, redactSecrets } from '../util/text.js';
import { registerToolProvider } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { coreSettings } from './settings.js';
import { indexDir } from './index/key.js';
import type { HarnessConfig } from '../config.js';
import { grammarFor, parseText, treeSitterAvailable, type TsNode } from '../edit/treesitter.js';

export interface Def {
  name: string;
  kind: string;
  line: number;
  text: string;
  /** enclosing class/impl for methods */
  parent?: string;
}

type Lang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'rb' | 'c' | 'php';

const LANG_BY_EXT: Record<string, Lang> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.kts': 'java', '.cs': 'java', '.scala': 'java', '.swift': 'java', '.dart': 'java',
  '.rb': 'rb',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c', '.cxx': 'c',
  '.php': 'php',
};

const SKIP_DIRS = new Set(['fixtures', '__fixtures__', 'testdata', '__snapshots__', 'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'target', '__pycache__', '.venv', 'venv', '.next', 'coverage', '.tugline', '.tox', '.mypy_cache']);
/** Walk fallback bound when the caller sets no limit (git ls-files lists everything). */
const WALK_LIMIT = 200_000;
const CACHE_VERSION = 1;

/**
 * Never mapped, in any permission mode: files that conventionally hold
 * credentials (same families as the policy's secret-file rule).
 */
const SECRET_PATH = picomatch(['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/id_ecdsa*', '**/.npmrc', '**/.pypirc', '**/.netrc', '**/credentials*', '**/.aws/**', '**/.ssh/**', '**/.gnupg/**', '**/.docker/config.json', '**/.kube/config'], { dot: true, nocase: true });

/** Default exclusions: eval task trees are copies of small fixture projects (repo/ + solution/), not the project. */
export const DEFAULT_REPOMAP_EXCLUDE = ['**/evals/**/tasks/**'];

/** gitignore-style lines → a matcher over workspace-relative paths (negation, anchoring, dir-only). */
export function ignoreMatcher(lines: string[]): (rel: string) => boolean {
  const rules: { neg: boolean; m: (p: string) => boolean }[] = [];
  for (let raw of lines) {
    raw = raw.replace(/\s+$/, '');
    if (!raw || raw.startsWith('#')) continue;
    const neg = raw.startsWith('!');
    let pat = neg ? raw.slice(1) : raw;
    const dirOnly = pat.endsWith('/');
    pat = pat.replace(/\/+$/, '');
    const anchored = pat.startsWith('/') || pat.slice(0, -1).includes('/');
    pat = pat.replace(/^\//, '');
    const base = anchored ? pat : `**/${pat}`;
    const globs = dirOnly ? [`${base}/**`] : [base, `${base}/**`];
    rules.push({ neg, m: picomatch(globs, { dot: true }) });
  }
  return (rel) => {
    let ignored = false;
    for (const r of rules) if (r.m(rel)) ignored = !r.neg;
    return ignored;
  };
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}
const MAX_BYTES = 256 * 1024;

const KEYWORDS = new Set('if else for while do switch case break continue return function class const let var new this super import export from default async await try catch finally throw typeof instanceof void delete in of yield static public private protected readonly extends implements interface type enum namespace module declare abstract constructor true false null undefined self def elif lambda pass raise with as global nonlocal not and or is None True False func package struct impl trait pub fn mut use crate where match loop end begin then unless until include require public void int string bool float double char long short byte final override virtual'.split(' '));

// ------------------------------------------------------------ regex extraction

/** Words a definition regex may catch that are never definition names (calls like `if (`). */
const NOT_A_NAME = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'return', 'function', 'constructor', 'super', 'this', 'await', 'yield', 'throw', 'typeof', 'delete', 'void', 'elif', 'with', 'match', 'loop', 'unless', 'until']);

function signature(lines: string[], i: number): string {
  let s = lines[i].trim();
  // multi-line parameter lists: join until the closing paren (max 4 lines)
  for (let k = 1; k <= 4 && /\($|,$/.test(s) && i + k < lines.length; k++) s += ' ' + lines[i + k].trim();
  s = s.replace(/\s*\{\s*$/, '').replace(/\s*:\s*$/, ':').replace(/\s+/g, ' ');
  return s.length > 110 ? s.slice(0, 109) + '…' : s;
}

const indentOf = (l: string) => l.length - l.trimStart().length;

interface Rule {
  re: RegExp;
  kind: string;
  /** capture group with the name */
  g: number;
  /** opens a scope whose members are methods */
  scope?: boolean;
}

const RULES: Record<Lang, { top: Rule[]; member?: Rule[] }> = {
  ts: {
    top: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class', g: 1, scope: true },
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/, kind: 'function', g: 1 },
      { re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface', g: 1 },
      { re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, kind: 'type', g: 1 },
      { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum', g: 1 },
      { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=>/, kind: 'function', g: 1 },
      { re: /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const', g: 1 },
    ],
    member: [
      { re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\((?!.*;\s*$)/, kind: 'method', g: 1 },
      { re: /^\s+(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]*)?=>/, kind: 'method', g: 1 },
    ],
  },
  py: {
    top: [
      { re: /^\s*class\s+([A-Za-z_]\w*)/, kind: 'class', g: 1, scope: true },
      { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: 'function', g: 1 },
    ],
  },
  go: {
    top: [
      { re: /^func\s+\(\s*\w*\s*\*?\s*(\w+)[^)]*\)\s*(\w+)\s*[(\[]/, kind: 'method', g: 2 },
      { re: /^func\s+(\w+)\s*[(\[]/, kind: 'function', g: 1 },
      { re: /^type\s+(\w+)\s+(?:struct|interface)/, kind: 'type', g: 1 },
      { re: /^type\s+(\w+)\s+/, kind: 'type', g: 1 },
    ],
  },
  rs: {
    top: [
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)/, kind: 'function', g: 1 },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/, kind: 'struct', g: 1 },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/, kind: 'enum', g: 1 },
      { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/, kind: 'trait', g: 1 },
      { re: /^\s*impl(?:<[^>]*>)?\s+(?:\w+(?:<[^>]*>)?\s+for\s+)?(\w+)/, kind: 'impl', g: 1 },
    ],
  },
  java: {
    top: [
      { re: /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object|struct|protocol|extension|mixin)\s+([A-Za-z_]\w*)/, kind: 'class', g: 1, scope: true },
      { re: /^\s*(?:(?:public|private|protected|internal|static|suspend|inline|override)\s+)*fun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)\s*\(/, kind: 'function', g: 1 },
    ],
    member: [
      { re: /^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|virtual|async|suspend|open|native)\s+)+(?:fun\s+)?(?:<[^>]*>\s*)?(?:[\w<>[\],.?]+\s+)?(\w+)\s*\([^;]*$/, kind: 'method', g: 1 },
      { re: /^\s+fun\s+(?:<[^>]*>\s*)?(\w+)\s*\(/, kind: 'method', g: 1 },
      { re: /^\s+func\s+(\w+)\s*[(<]/, kind: 'method', g: 1 },
    ],
  },
  rb: {
    top: [
      { re: /^\s*(?:class|module)\s+([A-Z]\w*(?:::\w+)*)/, kind: 'class', g: 1, scope: true },
      { re: /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, kind: 'function', g: 1 },
    ],
  },
  c: {
    top: [
      { re: /^\s*(?:class|struct)\s+([A-Za-z_]\w*)\s*(?::[^{;]*)?\{?\s*$/, kind: 'class', g: 1, scope: true },
      { re: /^(?:[A-Za-z_][\w:<>,\s*&]*?\s+\**)([A-Za-z_]\w*(?:::\w+)?)\s*\([^;]*\)?\s*(?:const\s*)?\{?\s*$/, kind: 'function', g: 1 },
    ],
  },
  php: {
    top: [
      { re: /^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/, kind: 'class', g: 1, scope: true },
      { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_]\w*)\s*\(/, kind: 'function', g: 1 },
    ],
  },
};

export function extractDefsRegex(lang: Lang, text: string): Def[] {
  const lines = text.split('\n');
  const defs: Def[] = [];
  const rules = RULES[lang];
  // scope stack for classes: members are lines indented deeper than the class line
  let scope: { name: string; indent: number; memberIndent?: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*(\/\/|#(?!\[)|\*|\/\*)/.test(line)) continue;
    const ind = indentOf(line);
    if (scope && ind <= scope.indent) scope = undefined;
    if (scope) {
      if (scope.memberIndent === undefined) scope.memberIndent = ind;
      if (ind === scope.memberIndent) {
        // Python methods are plain `def` inside the class body
        const memberRules = lang === 'py' || lang === 'rb' || lang === 'php' || lang === 'rs' ? rules.top.filter((r) => !r.scope && r.kind !== 'impl') : (rules.member ?? []);
        let hit = false;
        for (const r of memberRules) {
          const m = line.match(r.re);
          const name = m?.[r.g];
          if (!name || NOT_A_NAME.has(name)) continue;
          defs.push({ name: name.replace(/^#/, ''), kind: 'method', line: i + 1, text: signature(lines, i), parent: scope.name });
          hit = true;
          break;
        }
        if (hit) continue;
      }
      // nested classes are listed too (but do not replace the outer scope)
      const nested = rules.top.find((r) => r.scope && r.re.test(line));
      if (nested) {
        const name = line.match(nested.re)![nested.g];
        defs.push({ name, kind: nested.kind, line: i + 1, text: signature(lines, i), parent: scope.name });
      }
      continue;
    }
    for (const r of rules.top) {
      const m = line.match(r.re);
      const name = m?.[r.g];
      if (!name || NOT_A_NAME.has(name)) continue;
      // Outside a class scope only top-level definitions count: functions and
      // arrow consts nested in bodies are locals, not part of the outline.
      // (TS/Java allow a little indent for namespaces / `declare module` blocks.)
      const maxIndent = r.scope && (lang === 'ts' || lang === 'java') ? 4 : lang === 'ts' && /^\s*export\b/.test(line) ? 4 : 0;
      if (ind > maxIndent) continue;
      defs.push({ name, kind: r.kind, line: i + 1, text: signature(lines, i), parent: lang === 'go' && r.kind === 'method' ? m![1] : undefined });
      if (r.scope || (lang === 'rs' && (r.kind === 'impl' || r.kind === 'trait'))) scope = { name, indent: ind };
      break;
    }
  }
  return defs;
}

const IDENT = /[A-Za-z_$][\w$]{2,}/g;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/;

export function identifierCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(IDENT)) {
    const w = m[0];
    if (KEYWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/**
 * The text with comments and string literals blanked: words in prose are not
 * references. Approximate (no full lexer), which is fine for counting.
 */
export function codeOnly(text: string, lang: Lang): string {
  let t = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (lang === 'py') t = t.replace(/("""|''')[\s\S]*?\1/g, ' ');
  // strings first (they may contain // or #), then line comments
  t = t.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  t = t.replace(lang === 'py' || lang === 'rb' ? /#.*$/gm : /\/\/.*$/gm, ' ');
  return t;
}

/** Counts of `.name` and `::name`: how methods are actually used from other files. */
export function qualifiedCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/(?:\.|::)([A-Za-z_$][\w$]*)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts;
}

// ------------------------------------------------------------ optional tree-sitter

export interface DefExtractor {
  readonly engine: string;
  /** Return undefined to fall back to regexes for this file. */
  extract(lang: Lang, file: string, text: string): Promise<Def[] | undefined>;
}

/**
 * Definition node types per tree-sitter grammar family, and the containers the
 * walk descends into. Only declaration containers are entered (program, class
 * bodies, namespaces, impl blocks, decorators): never function bodies, calls or
 * object literals, whose contents are locals rather than the outline. This
 * mirrors what the regex extractor treats as top level / members.
 */
const TS_KINDS: Record<string, string> = {
  // TypeScript / JavaScript
  class_declaration: 'class', abstract_class_declaration: 'class', interface_declaration: 'interface', type_alias_declaration: 'type', enum_declaration: 'enum',
  function_declaration: 'function', generator_function_declaration: 'function', function_signature: 'function', method_definition: 'method',
  // Python
  class_definition: 'class', function_definition: 'function',
  // Go
  method_declaration: 'method', type_spec: 'type',
  // Rust
  function_item: 'function', struct_item: 'struct', enum_item: 'enum', trait_item: 'trait', impl_item: 'impl',
  // Java
  record_declaration: 'class', constructor_declaration: 'method',
};
const TS_CONTAINERS = new Set(['program', 'source_file', 'module', 'export_statement', 'expression_statement', 'internal_module', 'ambient_declaration', 'statement_block', 'class_body', 'interface_body', 'enum_body', 'decorated_definition', 'block', 'type_declaration', 'declaration_list', 'mod_item']);
const SCOPE_KINDS = new Set(['class', 'struct', 'interface', 'impl', 'trait']);

/**
 * Grammar for a file, for the languages whose tree-sitter extraction is tested
 * against the regex one (ts/js, Python, Go, Rust, Java). Kotlin, C#, Ruby, C,
 * PHP … share a regex family but not a grammar here, so they stay on regexes.
 */
function tsGrammarFor(file: string): string | undefined {
  const g = grammarFor(file);
  return g && ['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java'].includes(g) ? g : undefined;
}

/** Definitions from a tree-sitter tree (exported for tests). */
export function defsFromTree(root: TsNode, text: string): Def[] {
  const lines = text.split('\n');
  const defs: Def[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: string, row: number, parent: string | undefined) => {
    name = name.replace(/^#/, '');
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || NOT_A_NAME.has(name)) return;
    const key = `${parent ?? ''}.${name}.${kind}`;
    if (seen.has(key)) return; // overload signatures: keep the first
    seen.add(key);
    defs.push({ name, kind, line: row + 1, text: signature(lines, row), parent });
  };
  const fn = (v: TsNode | null) => !!v && /^(arrow_function|function_expression|function|generator_function)$/.test(v.type);
  const walk = (node: TsNode, parent: string | undefined, depth: number) => {
    if (depth > 12) return;
    let kind = TS_KINDS[node.type];
    if (kind) {
      const nameNode = node.childForFieldName('name') ?? (node.type === 'impl_item' ? node.childForFieldName('type') : null);
      let name = nameNode?.text ?? '';
      if (node.type === 'impl_item') name = /^[A-Za-z_]\w*/.exec(name)?.[0] ?? '';
      let owner = parent;
      if (node.type === 'method_declaration' && !parent) {
        // Go: func (s *Srv) Run() — the receiver type is the owner
        owner = /(\w+)(?:\[[^\]]*\])?\s*\)\s*$/.exec(node.childForFieldName('receiver')?.text ?? '')?.[1];
      }
      if (owner && kind === 'function') kind = 'method';
      if (name) add(name, kind, nameNode!.startPosition.row, owner);
      // bodies of functions are not part of the outline
      if (kind === 'function' || kind === 'method') return;
      if (SCOPE_KINDS.has(kind) && name) parent = name;
      for (const c of node.namedChildren) walk(c, parent, depth + 1);
      return;
    }
    // const f = () => …, export const X = …, class fields holding functions
    if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
      if (parent) return;
      const exported = node.parent?.type === 'export_statement';
      for (const d of node.namedChildren) {
        if (d.type !== 'variable_declarator') continue;
        const n = d.childForFieldName('name');
        if (n?.type !== 'identifier') continue;
        if (fn(d.childForFieldName('value'))) add(n.text, 'function', n.startPosition.row, undefined);
        else if (exported) add(n.text, 'const', n.startPosition.row, undefined);
      }
      return;
    }
    if ((node.type === 'public_field_definition' || node.type === 'field_definition') && parent) {
      const n = node.childForFieldName('name') ?? node.childForFieldName('property');
      if (n && fn(node.childForFieldName('value'))) add(n.text, 'method', n.startPosition.row, parent);
      return;
    }
    if (!TS_CONTAINERS.has(node.type) && !node.type.endsWith('_body')) return;
    for (const c of node.namedChildren) walk(c, parent, depth + 1);
  };
  walk(root, undefined, 0);
  return defs;
}

/**
 * Default tree-sitter extractor, on the shared optional runtime
 * (src/core/edit/treesitter.ts: `web-tree-sitter` + grammar wasm from
 * TUG_TREE_SITTER_DIR / TUG_TREE_SITTER_WASM_DIR or the npm packages). Undefined
 * when it is unavailable; any per-file failure falls back to regexes.
 */
async function defaultTreeSitter(): Promise<DefExtractor | undefined> {
  if (!(await treeSitterAvailable())) return undefined;
  return {
    engine: 'tree-sitter',
    async extract(_lang, file, text) {
      const g = tsGrammarFor(file);
      if (!g) return undefined;
      const tree = await parseText(g, text);
      if (!tree) return undefined;
      try {
        return defsFromTree(tree.rootNode, text);
      } finally {
        tree.delete?.();
      }
    },
  };
}

let extractorLoader: () => Promise<DefExtractor | undefined> = defaultTreeSitter;
let extractorPromise: Promise<DefExtractor | undefined> | undefined;

/** Testing / embedding: replace the tree-sitter loader (return undefined to force regexes; pass undefined to restore the default). */
export function setDefExtractorLoader(loader: (() => Promise<DefExtractor | undefined>) | undefined): void {
  extractorLoader = loader ?? defaultTreeSitter;
  extractorPromise = undefined;
  cache.clear();
}

// ------------------------------------------------------------ files + cache

interface FileInfo {
  rel: string;
  mtimeMs: number;
  size: number;
  defs: Def[];
  idents: Map<string, number>;
  engine: string;
  /** Names other files can use (module exports); null = everything is visible. */
  visible: Set<string> | null;
  lang: Lang;
  /** Qualified uses: `.name` / `::name` counts (method calls, property access) */
  qualified: Map<string, number>;
  hash: string;
}

/**
 * Which definitions another file can actually reference. In ES modules only
 * exported names are importable; Go exports Capitalised names; Rust `pub`;
 * Python treats _names as private. Members follow their class, minus private ones.
 */
export function visibleNames(lang: Lang, text: string, defs: Def[]): Set<string> | null {
  const top = defs.filter((d) => !d.parent);
  let vis: Set<string>;
  if (lang === 'ts') {
    // CommonJS / plain scripts: no module boundary to respect
    if (!/^\s*export\b/m.test(text)) return /\bmodule\.exports\b|\bexports\.\w/.test(text) ? null : new Set(); // CommonJS vs. a plain script
    vis = new Set(top.filter((d) => /^\s*export\b/.test(d.text)).map((d) => d.name));
    for (const m of text.matchAll(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/gm)) for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) vis.add(name);
    }
    for (const m of text.matchAll(/^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) vis.add(m[1]);
  } else if (lang === 'go') vis = new Set(top.filter((d) => /^[A-Z]/.test(d.name)).map((d) => d.name));
  else if (lang === 'rs') vis = new Set(top.filter((d) => /^\s*pub\b/.test(d.text) || d.kind === 'impl').map((d) => d.name));
  else if (lang === 'py') vis = new Set(top.filter((d) => !d.name.startsWith('_')).map((d) => d.name));
  else return null;
  for (const d of defs) {
    if (!d.parent || !vis.has(d.parent)) continue;
    if (/^\s*(?:(?:static|async|readonly|override)\s+)*(?:private|protected)\b|^\s*#/.test(d.text) || (lang === 'py' && d.name.startsWith('_') && !d.name.startsWith('__'))) continue;
    if (lang === 'go' && !/^[A-Z]/.test(d.name)) continue;
    vis.add(d.name);
  }
  return vis;
}

const cache = new Map<string, Map<string, FileInfo>>();

/** Source files of the workspace (git ls-files, else a walk), sorted; `max` 0 = all (R15: no fixed cap). */
export function listSourceFiles(workspace: string, max = 0): string[] {
  let files: string[] = [];
  try {
    const out = execFileSync('git', ['-c', 'core.fsmonitor=', ...NO_ATTR_FILES, ...repoDriverOverrides(workspace), 'ls-files', '-co', '--exclude-standard'], { cwd: workspace, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
    files = out.split('\n').filter(Boolean);
  } catch {
    const walk = (dir: string, depth: number) => {
      if (depth > 12 || files.length > (max ? max * 2 : WALK_LIMIT)) return;
      let ents: fs.Dirent[];
      try {
        ents = fs.readdirSync(path.join(workspace, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(rel, depth + 1);
        } else if (e.isFile()) files.push(rel);
      }
    };
    walk('', 0);
  }
  return files
    .filter((f) => LANG_BY_EXT[path.extname(f).toLowerCase()] && !f.split('/').some((p) => SKIP_DIRS.has(p)) && !/\.min\.js$/.test(f))
    .sort()
    .slice(0, max > 0 ? max : undefined);
}

// ------------------------------------------------------------ persistent cache (R15)

interface StoredInfo extends Omit<FileInfo, 'idents' | 'qualified' | 'visible'> {
  idents: [string, number][];
  qualified: [string, number][];
  visible: string[] | null;
}

const cacheFile = (dir: string) => path.join(dir, 'repomap.json');

function loadDiskCache(dir: string, engine: string): Map<string, FileInfo> | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(dir), 'utf8')) as { version: number; engine: string; files: StoredInfo[] };
    // a cache built with another extractor (tree-sitter installed or removed since) is rebuilt
    if (j.version !== CACHE_VERSION || j.engine !== engine) return undefined;
    return new Map(j.files.map((f) => [f.rel, { ...f, idents: new Map(f.idents), qualified: new Map(f.qualified), visible: f.visible ? new Set(f.visible) : null }]));
  } catch {
    return undefined;
  }
}

function saveDiskCache(dir: string, engine: string, byRel: Map<string, FileInfo>): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files: StoredInfo[] = [...byRel.values()].map((f) => ({ ...f, idents: [...f.idents], qualified: [...f.qualified], visible: f.visible ? [...f.visible] : null }));
    const tmp = `${cacheFile(dir)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, engine, files }));
    fs.renameSync(tmp, cacheFile(dir));
  } catch {
    /* the cache is an optimisation */
  }
}

export interface ScanStats {
  files: number;
  /** files read and parsed in this scan (the rest came from the cache) */
  reparsed: number;
  ms: number;
}

async function scan(workspace: string, include: (rel: string, abs: string) => boolean, o: { cacheDir?: string; maxFiles?: number } = {}): Promise<{ files: FileInfo[]; engine: string; stats: ScanStats }> {
  const t0 = Date.now();
  extractorPromise ??= extractorLoader().catch(() => undefined);
  const ts = await extractorPromise;
  const extractor = ts?.engine ?? 'regex';
  let byRel = cache.get(workspace);
  if (!byRel) cache.set(workspace, (byRel = (o.cacheDir && loadDiskCache(o.cacheDir, extractor)) || new Map()));
  let reparsed = 0;
  let dropped = 0;
  const out: FileInfo[] = [];
  const seen = new Set<string>();
  let usedTs = false;
  for (const rel of listSourceFiles(workspace, o.maxFiles ?? 0)) {
    const abs = path.join(workspace, rel);
    if (!include(rel, abs)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    seen.add(rel);
    const hit = byRel.get(rel);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      out.push(hit);
      if (hit.engine === 'tree-sitter') usedTs = true;
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    // mtime moved but the content did not (checkout, touch): keep the parse
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    if (hit && hit.hash === hash) {
      const kept = { ...hit, mtimeMs: st.mtimeMs, size: st.size };
      byRel.set(rel, kept);
      out.push(kept);
      if (kept.engine === 'tree-sitter') usedTs = true;
      dropped++; // metadata changed: persist
      continue;
    }
    reparsed++;
    const lang = LANG_BY_EXT[path.extname(rel).toLowerCase()];
    let defs: Def[] | undefined;
    let engine = 'regex';
    if (ts) {
      try {
        defs = await ts.extract(lang, rel, text);
        if (defs) engine = ts.engine;
      } catch {
        defs = undefined;
      }
    }
    defs ??= extractDefsRegex(lang, text);
    if (engine === 'tree-sitter') usedTs = true;
    const info: FileInfo = { rel, mtimeMs: st.mtimeMs, size: st.size, defs, engine, visible: visibleNames(lang, text, defs), lang, hash, ...((code) => ({ idents: identifierCounts(code), qualified: qualifiedCounts(code) }))(codeOnly(text, lang)) };
    byRel.set(rel, info);
    out.push(info);
  }
  for (const k of [...byRel.keys()])
    if (!seen.has(k)) {
      byRel.delete(k);
      dropped++;
    }
  if (o.cacheDir && (reparsed || dropped || !fs.existsSync(cacheFile(o.cacheDir)))) saveDiskCache(o.cacheDir, extractor, byRel);
  return { files: out, engine: usedTs ? 'tree-sitter' : 'regex', stats: { files: out.length, reparsed, ms: Date.now() - t0 } };
}

// ------------------------------------------------------------ ranking

export interface RepoMapOptions {
  /** token budget (default 1500) */
  tokens?: number;
  /** files to personalise towards (workspace-relative or absolute) */
  focusFiles?: string[];
  /** free text (the user's prompt): mentioned files and identifiers are boosted */
  focusText?: string;
  /**
   * The read policy: only files it allows without asking are mapped (protected,
   * ignored or outside-workspace reads stay out of the prompt). Secret-looking
   * files are skipped regardless.
   */
  canRead?: (abs: string) => boolean;
  /** extra glob exclusions (default: eval task trees); .tuglineignore is always honoured */
  exclude?: string[];
  /** R15: persist per-file extraction here (see repoMapCacheDir) so later runs reparse only changed files */
  cacheDir?: string;
  /** R15: max files scanned; 0 / unset = no limit */
  maxFiles?: number;
}

export interface RepoMap {
  text: string;
  /** files in rendered order */
  files: string[];
  defs: number;
  engine: string;
  totalFiles: number;
  /** R15: scan statistics (files seen, files reparsed, ms) */
  scan?: ScanStats;
  /** R15: every file with definitions, best first (the map's file ranking beyond the token budget; localisation evals use it) */
  ranked?: string[];
}

function mentionedFiles(text: string, rels: string[]): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const low = text.toLowerCase();
  for (const r of rels) {
    const base = path.posix.basename(r).toLowerCase();
    if (low.includes(r.toLowerCase())) out.add(r);
    else if (base.length >= 5 && new RegExp(`(^|[^\\w./-])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`).test(low)) out.add(r);
  }
  return out;
}

export async function buildRepoMap(workspace: string, opts: RepoMapOptions = {}): Promise<RepoMap> {
  const budget = opts.tokens ?? 1500;
  const ignored = ignoreMatcher([...readLines(path.join(workspace, '.tuglineignore'))]);
  const excluded = picomatch(opts.exclude ?? DEFAULT_REPOMAP_EXCLUDE, { dot: true });
  const include = (rel: string, abs: string) => !SECRET_PATH(rel) && !ignored(rel) && !excluded(rel) && (!opts.canRead || opts.canRead(abs));
  const scanned = await scan(workspace, include, { cacheDir: opts.cacheDir, maxFiles: opts.maxFiles });
  const engine = scanned.engine;
  // Copies of a file (vendored code, fixtures: repo/ + solution/) are mapped once.
  const seenShape = new Set<string>();
  const files = scanned.files.filter((f) => {
    const key = f.defs.length ? `${path.posix.basename(f.rel)}\u0000${f.defs.map((d) => `${d.parent ?? ''}.${d.name}`).join(',')}` : `hash:${f.hash}`;
    if (seenShape.has(key)) return false;
    seenShape.add(key);
    return true;
  });
  if (!files.length || budget <= 0) return { text: '', files: [], defs: 0, engine, totalFiles: files.length, scan: scanned.stats };
  const rels = files.map((f) => f.rel);
  const idx = new Map(rels.map((r, i) => [r, i]));
  const N = files.length;

  // who defines what
  const definers = new Map<string, Set<number>>();
  files.forEach((f, i) => {
    for (const d of f.defs) {
      if (d.name.length < 3) continue;
      let s = definers.get(d.name);
      if (!s) definers.set(d.name, (s = new Set()));
      s.add(i);
    }
  });

  // personalisation
  const focus = new Set<number>();
  for (const f of opts.focusFiles ?? []) {
    const rel = path.isAbsolute(f) ? path.relative(workspace, f).split(path.sep).join('/') : f.replace(/^\.\//, '');
    const i = idx.get(rel);
    if (i !== undefined) focus.add(i);
  }
  for (const r of mentionedFiles(opts.focusText ?? '', rels)) focus.add(idx.get(r)!);
  const focusIdents = new Set<string>();
  for (const m of (opts.focusText ?? '').matchAll(IDENT)) if (m[0].length >= 4 && definers.has(m[0])) focusIdents.add(m[0]);
  const pers = new Array(N).fill(1);
  for (const i of focus) pers[i] = 100;
  for (const id of focusIdents) for (const i of definers.get(id)!) pers[i] += 10;
  const psum = pers.reduce((a, b) => a + b, 0);
  const p = pers.map((x) => x / psum);

  // For names a file defines only as class members: the classes they belong to.
  const memberParents = files.map((f) => {
    const m = new Map<string, Set<string> | null>();
    for (const d of f.defs) {
      if (!d.parent) m.set(d.name, null);
      else if (m.get(d.name) !== null) m.set(d.name, new Set([...(m.get(d.name) ?? []), d.parent]));
    }
    return m;
  });

  // graph: edges[g] = Map<f, weight>, plus per-identifier contributions
  const edges: Map<number, number>[] = files.map(() => new Map());
  const contrib: { g: number; f: number; name: string; w: number }[] = [];
  files.forEach((g, gi) => {
    for (const [name, count] of g.idents) {
      const ds = definers.get(name);
      if (!ds) continue;
      // A file that defines the name at top level uses its own definition (local shadowing).
      // This also stops copies of a file (fixtures, vendored code) feeding each other.
      // Method names are qualified (obj.run), so a local method does not shadow.
      if (ds.has(gi) && memberParents[gi].get(name) === null) continue;
      // Candidate definitions this use can resolve to: visible to other files, same
      // language, and for methods, only when the file mentions the class (agent.run ← Agent)
      // and does not define that class itself (a copy of the file resolves locally).
      const targets = [...ds].filter((f) => {
        if (f === gi || files[f].lang !== g.lang || (files[f].visible && !files[f].visible!.has(name))) return false;
        const parents = memberParents[f].get(name);
        if (!parents) return true;
        return [...parents].some((p) => g.idents.has(p)) && ![...parents].every((p) => definers.get(p)?.has(gi));
      });
      // Ambiguity is judged over what the use can actually resolve to.
      if (!targets.length || targets.length > 12) continue;
      // Aider's weighting: long, specific identifiers (camelCase / snake_case) carry
      // the signal; ambiguous names (defined in many places) are mostly noise.
      let w = Math.sqrt(count);
      if (name.length >= 8 && (/[a-z][A-Z]/.test(name) || /[a-z]_[a-z]/i.test(name))) w *= 10;
      if (targets.length > 5) w *= 0.1;
      if (focusIdents.has(name)) w *= 10;
      if (name.startsWith('_')) w *= 0.1;
      for (const f of targets) {
        let wf = w;
        if (memberParents[f].get(name)) {
          // methods are used qualified (agent.run(…), x.Run, T::new): count only those uses;
          // qualified + class mentioned is as specific as a long identifier
          const q = g.qualified.get(name) ?? 0;
          if (!q) continue;
          wf = Math.sqrt(q) * 10 * (targets.length > 5 ? 0.1 : 1) * (focusIdents.has(name) ? 10 : 1);
        } else if (name.length <= 4) wf *= 0.3; // short unqualified top-level names (rel, git) collide with locals everywhere
        edges[gi].set(f, (edges[gi].get(f) ?? 0) + wf);
        contrib.push({ g: gi, f, name, w: wf });
      }
    }
  });
  const outW = edges.map((e) => [...e.values()].reduce((a, b) => a + b, 0));

  // personalised PageRank
  const d = 0.85;
  let rank = p.slice();
  for (let it = 0; it < 30; it++) {
    const next = p.map((x) => (1 - d) * x);
    let dangling = 0;
    for (let g = 0; g < N; g++) {
      if (!outW[g]) {
        dangling += rank[g];
        continue;
      }
      for (const [f, w] of edges[g]) next[f] += (d * rank[g] * w) / outW[g];
    }
    for (let i = 0; i < N; i++) next[i] += d * dangling * p[i];
    rank = next;
  }

  // rank definitions by the rank flowing into them
  const defScore = new Map<string, number>();
  const key = (fi: number, name: string) => `${fi}\u0000${name}`;
  for (const c of contrib) defScore.set(key(c.f, c.name), (defScore.get(key(c.f, c.name)) ?? 0) + (rank[c.g] * c.w) / (outW[c.g] || 1));
  // Fan-in breadth: how many distinct non-test files use a definition. PageRank alone lets a definition used by one
  // highly ranked file (a constant table, an alias map) outrank an API the whole product calls (`Agent.run` from
  // every surface); a central API is one that many files use, so breadth lifts it (logarithmically, so a handful of
  // extra callers does not swamp the rank signal).
  const fanIn = new Map<string, Set<number>>();
  for (const c of contrib) {
    if (TEST_FILE.test(files[c.g].rel)) continue;
    const k = key(c.f, c.name);
    let st = fanIn.get(k);
    if (!st) fanIn.set(k, (st = new Set()));
    st.add(c.g);
  }
  type Item = { fi: number; def: Def; score: number };
  const items: Item[] = [];
  files.forEach((f, fi) => {
    for (const def of f.defs) {
      let s = ((defScore.get(key(fi, def.name)) ?? 0) + rank[fi] * 0.02) * (1 + Math.log1p(fanIn.get(key(fi, def.name))?.size ?? 0) / 4);
      if (focus.has(fi)) s += 10;
      if (focusIdents.has(def.name)) s += 1;
      items.push({ fi, def, score: s });
    }
  });
  for (const it of items) {
    // Private members cannot be used from other files: their "references" are name collisions.
    if (/^\s*(?:(?:static|async|readonly|override)\s+)*(?:private|protected)\b|^#/.test(it.def.text)) it.score *= 0.2;
    // Public API first; tests are context for the code, not the code.
    if (!it.def.parent && /^\s*(export|pub)\b/.test(it.def.text)) it.score *= 1.5;
    if (TEST_FILE.test(files[it.fi].rel)) it.score *= 0.3;
  }
  // Diminishing returns per file, so the map covers more of the repo instead of
  // every getter of the single most central class.
  items.sort((a, b) => b.score - a.score || a.fi - b.fi || a.def.line - b.def.line);
  const seenPerFile = new Map<number, number>();
  for (const it of items) {
    const k = seenPerFile.get(it.fi) ?? 0;
    seenPerFile.set(it.fi, k + 1);
    it.score *= Math.pow(0.85, k);
  }
  items.sort((a, b) => b.score - a.score || a.fi - b.fi || a.def.line - b.def.line);

  const render = (n: number): { text: string; order: number[] } => {
    const chosen = items.slice(0, n);
    const byFile = new Map<number, { best: number; defs: Def[] }>();
    for (const it of chosen) {
      const e = byFile.get(it.fi) ?? { best: 0, defs: [] };
      e.best = Math.max(e.best, it.score);
      e.defs.push(it.def);
      byFile.set(it.fi, e);
    }
    const order = [...byFile.entries()].sort((a, b) => b[1].best - a[1].best || a[0] - b[0]).map(([fi]) => fi);
    const out: string[] = [];
    for (const fi of order) {
      const f = files[fi];
      const picked = new Set(byFile.get(fi)!.defs);
      // a method needs its class line for context
      for (const dd of [...picked]) if (dd.parent) {
        const parent = f.defs.find((x) => x.name === dd.parent && !x.parent && x.line < dd.line);
        if (parent) picked.add(parent);
      }
      out.push(`${f.rel}:`);
      for (const dd of [...picked].sort((a, b) => a.line - b.line)) out.push(`  ⋮ ${dd.parent ? '  ' : ''}${renderSignature(dd)}`);
    }
    return { text: out.join('\n'), order };
  };

  // largest n that fits the budget (binary search; rendering is monotone enough)
  let lo = 0;
  let hi = items.length;
  let best = { text: '', order: [] as number[] };
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = render(mid);
    if (estimateTokens(r.text) <= budget) {
      best = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const ranked: string[] = [];
  const seenRank = new Set<number>();
  for (const it of items) if (!seenRank.has(it.fi)) (seenRank.add(it.fi), ranked.push(files[it.fi].rel));
  return { text: best.text, files: best.order.map((i) => files[i].rel), defs: lo - 1, engine, totalFiles: N, scan: scanned.stats, ranked };
}

/**
 * What a definition line may show: its signature, never its value. Initialisers
 * of constants are dropped, arrow bodies cut, long string literals elided and
 * anything secret-shaped redacted (the map goes into the prompt unasked).
 */
export function renderSignature(d: Pick<Def, 'kind' | 'text'>): string {
  let t = d.text;
  if (/=>/.test(t)) t = t.slice(0, t.indexOf('=>') + 2);
  else if (d.kind === 'const') t = t.replace(/\s*=(?!=|>)[\s\S]*$/, '');
  t = t.replace(/(["'`])(?:(?!\1)[^\\]|\\.){16,}\1/g, '$1…$1');
  return redactSecrets(t);
}

/** Clear the per-file cache (tests). */
/** Secret-file families that are never mapped or indexed (shared with N2 / N3). */
export function isSecretPath(rel: string): boolean {
  return SECRET_PATH(rel);
}

/** The workspace's root `.tuglineignore` as a matcher over relative paths. */
export function harnessIgnore(workspace: string): (rel: string) => boolean {
  return ignoreMatcher(readLines(path.join(workspace, '.tuglineignore')));
}

/** Regex-family language of a file, or undefined (shared with N2 / N3). */
export function langOf(rel: string): Lang | undefined {
  return LANG_BY_EXT[path.extname(rel).toLowerCase()];
}
export type { Lang };

/** Definitions of one file: tree-sitter when available, else regexes (N2 chunking, N3 fallback). */
export async function defsForFile(rel: string, text: string): Promise<{ defs: Def[]; engine: string }> {
  const lang = langOf(rel);
  if (!lang) return { defs: [], engine: 'none' };
  extractorPromise ??= extractorLoader().catch(() => undefined);
  const ts = await extractorPromise;
  if (ts) {
    try {
      const defs = await ts.extract(lang, rel, text);
      if (defs) return { defs, engine: ts.engine };
    } catch {
      /* regex below */
    }
  }
  return { defs: extractDefsRegex(lang, text), engine: 'regex' };
}

export function clearRepoMapCache(): void {
  cache.clear();
}

// ------------------------------------------------------------ tool


/** The policy as a repo-map file filter: only reads it allows without asking. */
/** Where the repo-map cache of a workspace lives (R15), or undefined when `agent.repoMapCache` is off. */
export function repoMapCacheDir(cfg: HarnessConfig): ((workspace: string) => string | undefined) {
  return (workspace) => (coreSettings(cfg).repoMapCache && cfg.homeDir ? indexDir(cfg.homeDir, workspace) : undefined);
}

export function readableBy(policy: { check(i: { tool: string; kind: 'read'; paths: { path: string; write: boolean }[] }): { decision: string } }): (abs: string) => boolean {
  return (abs) => policy.check({ tool: 'repo_map', kind: 'read', paths: [{ path: abs, write: false }] }).decision === 'allow';
}

export const repoMapTool: ToolDef<{ focus?: string; tokens?: number }> = {
  name: 'repo_map',
  kind: 'read',
  readOnly: true,
  description:
    'Show a ranked outline of the repository: the most important classes, functions and methods per file (signatures only). ' +
    'Pass `focus` (file paths and/or identifiers, comma separated) to rank the map around what you are working on. Use it to orient yourself before grepping.',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: 'e.g. "src/agent.ts, compactNow"' },
      tokens: { type: 'integer', description: 'Token budget (default: agent.repoMapTokens or 1500, max 8000)' },
    },
  },
  title: (a) => `Repo map${a.focus ? ` (focus: ${a.focus})` : ''}`,
  async run(a, ctx) {
    const focus = String(a.focus ?? '').split(/[,\s]+/).filter(Boolean);
    const tokens = Math.max(200, Math.min(Number(a.tokens) || coreSettings(ctx.config).repoMapTokens || 1500, 8000));
    const m = await buildRepoMap(ctx.workspace, { tokens, focusFiles: focus.filter((f) => /[./]/.test(f)), focusText: focus.join(' '), canRead: readableBy(ctx.policy), exclude: coreSettings(ctx.config).repoMapExclude, cacheDir: repoMapCacheDir(ctx.config)(ctx.workspace), maxFiles: coreSettings(ctx.config).repoMapMaxFiles });
    if (!m.text) return { output: 'No source definitions found in this workspace.' };
    return { output: `Repo map (${m.files.length} of ${m.totalFiles} source files, ${m.engine}; ⋮ = elided code):\n${m.text}` };
  },
};

registerToolProvider({ id: 'ws4-repomap', tools: () => [repoMapTool] });
