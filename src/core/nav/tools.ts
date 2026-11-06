/**
 * Code navigation tools (N3): code_definition, code_references, code_symbols,
 * code_rename_preview. Read-only (explore subagents get them).
 *
 * Backends, in order, per request:
 *   1. the host's language features (`WorkspaceHost.navigate`, VS Code);
 *   2. a configured language server (`lsp.servers`, started lazily, sandboxed);
 *   3. name matching over tree-sitter / regex definitions (fallback.ts).
 * A backend that is missing, fails or finds nothing hands over to the next, and
 * the output names the backend that answered (and why an earlier one did not).
 *
 * Every location passes the visibility rules of the repo map (secret files,
 * .tuglineignore, C5 hidden paths, read policy) before it is shown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolContext, ToolDef } from '../tools/types.js';
import { ToolError } from '../tools/types.js';
import type { NavAction, NavCall, NavEdit, NavLocation, NavRequest, NavResult } from '../host/workspace.js';
import { registerToolProvider } from '../tools/registry.js';
import { redactSecrets } from '../util/text.js';
import { listFiles, visibility } from '../context/index/files.js';
import { lspConfig, resolvedServers, serverFor } from './config.js';
import { clientFor, clientForFile } from './servers.js';
import { fromUri, toUri, type LspClient } from './lsp.js';
import './commands.js';
import { fileSymbols, findReferences, identifierAt, rankDefinitions, searchSymbols, symbolTable, usedQualified, type FileSyms, type ResolvedDef } from './fallback.js';

interface PosArgs {
  path?: string;
  line?: number;
  col?: number;
  symbol?: string;
}

const MAX_SNIPPET = 160;
const OUTPUT_CHARS = 6000; // ≈ 1.5k tokens

const SYMBOL_KIND = ['', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];

function absOf(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workspace, p);
}

function relOf(ctx: ToolContext, abs: string): string {
  const r = path.relative(ctx.workspace, abs).split(path.sep).join('/');
  return r.startsWith('..') ? abs : r;
}

function visibleFor(ctx: ToolContext, tool: string): (abs: string) => boolean {
  return visibility(ctx.workspace, { policy: ctx.policy as any, tool });
}

const lineCache = new Map<string, string[]>();
function lineOf(abs: string, line: number): string {
  let ls = lineCache.get(abs);
  if (!ls) {
    try {
      ls = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      ls = [];
    }
    if (lineCache.size > 200) lineCache.clear();
    lineCache.set(abs, ls);
  }
  const t = (ls[line - 1] ?? '').trim();
  return t.length > MAX_SNIPPET ? t.slice(0, MAX_SNIPPET - 1) + '…' : t;
}

/** `path:line: snippet` lines within the output budget. */
function renderLocations(ctx: ToolContext, locs: NavLocation[], max: number, label = (l: NavLocation) => ''): { text: string; shown: number } {
  lineCache.clear();
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  // several hits on one line print once, with a count
  const groups: { l: NavLocation; n: number }[] = [];
  for (const l of locs) {
    const g = groups[groups.length - 1];
    if (g && g.l.path === l.path && g.l.line === l.line && !l.name) g.n++;
    else groups.push({ l, n: 1 });
  }
  for (const { l, n } of groups) {
    if (shown >= max) break;
    const s = `${relOf(ctx, l.path)}:${l.line}:${label(l)} ${redactSecrets(lineOf(l.path, l.line))}${n > 1 ? `  (×${n})` : ''}`;
    if (used + s.length > OUTPUT_CHARS) break;
    out.push(s);
    used += s.length + 1;
    shown++;
  }
  if (shown < groups.length) out.push(`… ${groups.length - shown} more (narrow the request with \`path\`)`);
  return { text: out.join('\n'), shown };
}

function dedupe(locs: NavLocation[]): NavLocation[] {
  const seen = new Set<string>();
  return locs.filter((l) => {
    const k = `${path.resolve(l.path)}:${l.line}:${l.col}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ------------------------------------------------------------ LSP adapters

function lspLocations(res: any): NavLocation[] {
  const arr = Array.isArray(res) ? res : res ? [res] : [];
  return arr
    .map((l: any) => {
      const uri = l.targetUri ?? l.uri;
      const r = l.targetSelectionRange ?? l.targetRange ?? l.range;
      if (!uri || !r) return undefined;
      return { path: fromUri(uri), line: r.start.line + 1, col: r.start.character + 1, endLine: r.end.line + 1 } as NavLocation;
    })
    .filter((x: NavLocation | undefined): x is NavLocation => !!x);
}

function lspSymbols(res: any, file?: string): NavLocation[] {
  const out: NavLocation[] = [];
  const walk = (s: any, container?: string) => {
    if (s.location) {
      out.push({ path: fromUri(s.location.uri), line: s.location.range.start.line + 1, col: s.location.range.start.character + 1, name: s.name, kind: SYMBOL_KIND[s.kind] ?? String(s.kind), container: s.containerName ?? container });
    } else if (s.selectionRange || s.range) {
      const r = s.selectionRange ?? s.range;
      out.push({ path: file!, line: r.start.line + 1, col: r.start.character + 1, name: s.name, kind: SYMBOL_KIND[s.kind] ?? String(s.kind), container });
    }
    for (const c of s.children ?? []) walk(c, s.name);
  };
  for (const s of Array.isArray(res) ? res : []) walk(s);
  return out;
}

function lspEdits(res: any): NavEdit[] {
  const out: NavEdit[] = [];
  const add = (uri: string, edits: any[]) => {
    for (const e of edits ?? []) out.push({ path: fromUri(uri), line: e.range.start.line + 1, col: e.range.start.character + 1, endLine: e.range.end.line + 1, endCol: e.range.end.character + 1, newText: e.newText });
  };
  for (const [uri, edits] of Object.entries(res?.changes ?? {})) add(uri, edits as any[]);
  for (const dc of res?.documentChanges ?? []) if (dc.textDocument) add(dc.textDocument.uri, dc.edits);
  return out;
}

/**
 * Open (or re-sync) a document. The first time, wait for the server's first
 * diagnostics publish for it and for reported work ($/progress) to end
 * (bounded): servers load the project
 * asynchronously, and a query sent earlier is answered from a partial
 * (inferred) project — e.g. references missing files that are not open.
 */
async function openAndSettle(c: LspClient, abs: string): Promise<void> {
  const first = !c.isOpen(abs);
  const { seq, sent } = c.syncInfo(abs);
  if (first && sent) await c.waitDiagnostics(abs, seq, 20_000, 0);
  await c.waitIdle(20_000);
}

/** Make sure a server for a workspace-symbol query has a project loaded: open one file of its language. */
async function primeWorkspace(ctx: ToolContext, c: LspClient, exts: string[]): Promise<void> {
  const first = listFiles(ctx.workspace, { extensions: new Set(exts), max: 50 }).find((f) => !/\.d\.ts$/.test(f));
  if (first) await openAndSettle(c, path.join(ctx.workspace, first));
}

function lspCallItem(it: any): NavCall {
  const r = it.selectionRange ?? it.range;
  return { name: it.name, kind: SYMBOL_KIND[it.kind] ?? String(it.kind), path: fromUri(it.uri), line: r.start.line + 1, col: r.start.character + 1 };
}

export function lspActionEdits(edit: any): NavEdit[] {
  return lspEdits(edit);
}

export async function viaLsp(ctx: ToolContext, req: NavRequest): Promise<{ result?: NavResult; server?: string; error?: string }> {
  const target = { config: ctx.config, workspace: ctx.workspace, sessionId: ctx.sessionId };
  try {
    if (req.op === 'workspaceSymbols') {
      const servers = resolvedServers(ctx.config, ctx.workspace);
      const results: NavLocation[] = [];
      const errors: string[] = [];
      let used: string[] = [];
      for (const s of servers) {
        try {
          const c = await clientFor(target, s);
          await primeWorkspace(ctx, c, s.extensions);
          results.push(...lspSymbols(await c.request('workspace/symbol', { query: req.query ?? '' })));
          used.push(s.name);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      if (!used.length) return { error: errors.join(' ') || undefined };
      return { result: { locations: results }, server: used.join(', '), error: errors.join(' ') || undefined };
    }
    const abs = req.path!;
    const got = await clientForFile(target, abs);
    if (!got) return {};
    const { client: c, server } = got;
    await openAndSettle(c, abs);
    const td = { textDocument: { uri: toUri(abs) } };
    const pos = { ...td, position: { line: (req.line ?? 1) - 1, character: (req.col ?? 1) - 1 } };
    let result: NavResult;
    if (req.op === 'definition') result = { locations: lspLocations(await c.request('textDocument/definition', pos)) };
    else if (req.op === 'references') result = { locations: lspLocations(await c.request('textDocument/references', { ...pos, context: { includeDeclaration: true } })) };
    else if (req.op === 'documentSymbols') result = { locations: lspSymbols(await c.request('textDocument/documentSymbol', td), abs) };
    else if (req.op === 'hover') {
      const h = await c.request('textDocument/hover', pos);
      const v = h?.contents;
      result = { hover: typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x.value)).join('\n') : v?.value };
    } else if (req.op === 'implementation') result = { locations: lspLocations(await c.request('textDocument/implementation', pos)) };
    else if (req.op === 'typeDefinition') result = { locations: lspLocations(await c.request('textDocument/typeDefinition', pos)) };
    else if (req.op === 'incomingCalls' || req.op === 'outgoingCalls') {
      const items: any[] = (await c.request('textDocument/prepareCallHierarchy', pos)) ?? [];
      const calls: NavCall[] = [];
      for (const item of items.slice(0, 3)) {
        const res: any[] = (await c.request(req.op === 'incomingCalls' ? 'callHierarchy/incomingCalls' : 'callHierarchy/outgoingCalls', { item })) ?? [];
        for (const x of res) {
          const other = req.op === 'incomingCalls' ? x.from : x.to;
          calls.push({ ...lspCallItem(other), at: (x.fromRanges ?? []).map((r: any) => ({ line: r.start.line + 1, col: r.start.character + 1 })) });
        }
      }
      result = { calls };
    } else if (req.op === 'codeActions') {
      const start = { line: (req.line ?? 1) - 1, character: (req.col ?? 1) - 1 };
      const end = { line: (req.endLine ?? req.line ?? 1) - 1, character: req.endCol ? req.endCol - 1 : 10_000 };
      const diags = (c.diagnostics.get(toUri(abs))?.items ?? []).filter((d) => d.range.start.line <= end.line && d.range.end.line >= start.line);
      const raw: any[] = (await c.request('textDocument/codeAction', { ...td, range: { start, end }, context: { diagnostics: diags } })) ?? [];
      const actions: NavAction[] = [];
      for (let a of raw) {
        if (a.command && typeof a.command === 'string') {
          actions.push({ title: a.title, command: a.command });
          continue;
        }
        if (!a.edit && c.capabilities?.codeActionProvider?.resolveProvider) a = await c.request('codeAction/resolve', a).catch(() => a);
        actions.push({ title: a.title, kind: a.kind, edits: a.edit ? lspEdits(a.edit) : undefined, command: a.command?.command });
      }
      result = { actions };
    } else result = { edits: lspEdits(await c.request('textDocument/rename', { ...pos, newName: req.newName })) };
    return { result, server: server.name };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// ------------------------------------------------------------ position resolution

interface Resolved {
  abs?: string;
  line?: number;
  col?: number;
  name?: string;
  from?: FileSyms;
}

async function resolvePos(ctx: ToolContext, a: PosArgs, tool: string): Promise<Resolved> {
  const sym = a.symbol?.trim().replace(/^.*[.:#]/, '') || undefined;
  if (!a.path) {
    if (!sym) throw new ToolError(`${tool} needs \`symbol\`, or \`path\` + \`line\` (+ \`col\`) of an identifier.`);
    return { name: sym };
  }
  const abs = absOf(ctx, a.path);
  if (!fs.existsSync(abs)) throw new ToolError(`${a.path}: no such file`);
  if (!visibleFor(ctx, tool)(abs)) throw new ToolError(`${a.path} is not readable here (secret, ignored or outside the read policy).`);
  const from = await fileSymbols(ctx.workspace, abs);
  if (!a.line) return { abs, name: sym, from };
  const text = fs.readFileSync(abs, 'utf8').split('\n')[a.line - 1] ?? '';
  let col = a.col;
  if (col === undefined && sym) {
    const i = text.search(new RegExp(`(?<![\\w$])${sym.replace(/[$]/g, '\\$')}(?![\\w$])`));
    if (i >= 0) col = i + 1;
  }
  const name = sym ?? identifierAt(text, col);
  if (col === undefined && name) col = text.indexOf(name) + 1 || undefined;
  return { abs, line: a.line, col, name, from };
}

// ------------------------------------------------------------ backends chain

interface Answer {
  locations: NavLocation[];
  backend: string;
  notes: string[];
}

async function navigate(ctx: ToolContext, req: NavRequest, fallback: () => Promise<NavLocation[]>): Promise<Answer> {
  const notes: string[] = [];
  const positional = req.op === 'workspaceSymbols' || req.op === 'documentSymbols' || (req.path && req.line && req.col);
  if (positional && ctx.host?.navigate) {
    try {
      const r = await ctx.host.navigate(req);
      if (r?.locations?.length) return { locations: r.locations, backend: `${ctx.host.kind} language features`, notes };
    } catch (e) {
      notes.push(`editor navigation failed: ${(e as Error).message}`);
    }
  }
  if (positional && (req.op === 'workspaceSymbols' ? resolvedServers(ctx.config, ctx.workspace).length : req.path && serverFor(ctx.config, req.path, ctx.workspace))) {
    const r = await viaLsp(ctx, req);
    if (r.error) notes.push(r.error);
    if (r.result?.locations?.length) return { locations: r.result.locations, backend: `lsp: ${r.server}`, notes };
    if (r.server && !r.error) notes.push(`${r.server} returned no results`);
  }
  const locations = await fallback();
  return { locations, backend: 'name matching (tree-sitter/regex; same-named symbols may be included)', notes };
}

function header(what: string, a: Answer, n: number): string {
  return `${what}: ${n} result(s) via ${a.backend}${a.notes.length ? `\n(note: ${a.notes.join(' ')})` : ''}`;
}

function filterVisible(ctx: ToolContext, tool: string, locs: NavLocation[]): { locs: NavLocation[]; hidden: number } {
  const vis = visibleFor(ctx, tool);
  const kept = dedupe(locs).filter((l) => vis(l.path));
  return { locs: kept, hidden: dedupe(locs).length - kept.length };
}

const hiddenNote = (n: number) => (n ? `\n(${n} location(s) in secret, ignored or unreadable files omitted)` : '');

const posSchema = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'Identifier name, e.g. "buildRepoMap" or "Agent.run". Enough on its own; add path/line to disambiguate.' },
    path: { type: 'string', description: 'File containing the identifier (a use or the definition)' },
    line: { type: 'integer', description: '1-based line of the identifier in `path`' },
    col: { type: 'integer', description: '1-based column (optional when `symbol` is given)' },
  },
};

const readInput = (a: PosArgs, ctx: ToolContext) => ({ paths: a.path ? [{ path: absOf(ctx, a.path), write: false }] : [] });

async function fallbackDefs(ctx: ToolContext, r: Resolved, tool: string): Promise<ResolvedDef[]> {
  if (!r.name) return [];
  const table = await symbolTable(ctx.workspace, visibleFor(ctx, tool));
  const qualified = r.from && r.line ? usedQualified(r.from, r.line, r.name) : undefined;
  return rankDefinitions(table, r.name, r.from, qualified);
}

export const codeDefinitionTool: ToolDef<PosArgs> = {
  name: 'code_definition',
  kind: 'read',
  readOnly: true,
  core: true,
  description:
    'Go to the definition of an identifier: returns file:line and the definition line, without reading whole files. Give `symbol`, or `path`+`line` (+`col`) of a use. ' +
    'Uses the editor or a language server when available, else name matching.',
  parameters: posSchema,
  permissionInput: readInput,
  title: (a) => `Definition of ${a.symbol ?? `${a.path}:${a.line}`}`,
  async run(a, ctx) {
    const r = await resolvePos(ctx, a, 'code_definition');
    let ranked: ResolvedDef[] = [];
    const ans = await navigate(ctx, { op: 'definition', path: r.abs, line: r.line, col: r.col }, async () => {
      ranked = await fallbackDefs(ctx, r, 'code_definition');
      return ranked.map((x) => ({ path: x.file.abs, line: x.def.line, col: 1, name: x.def.name, container: x.def.parent }));
    });
    const { locs, hidden } = filterVisible(ctx, 'code_definition', ans.locations);
    if (!locs.length) return { output: `No definition found for ${r.name ? `\`${r.name}\`` : 'that position'}.${hidden ? hiddenNote(hidden) : ''}${ans.notes.length ? `\n(note: ${ans.notes.join(' ')})` : ''}` };
    const max = Math.min(lspConfig(ctx.config).maxResults, ranked.length ? 8 : 20);
    const body = renderLocations(ctx, locs, max, (l) => (l.container ? ` [${l.container}]` : ''));
    const ambiguous = ranked.length > 1 ? `\n(${ranked.length} definitions share this name; the first is the most likely from ${r.from ? relOf(ctx, r.from.abs) : 'the workspace'})` : '';
    return { output: `${header(`Definition of ${r.name ? `\`${r.name}\`` : 'symbol'}`, ans, locs.length)}\n${body.text}${ambiguous}${hiddenNote(hidden)}`, meta: { backend: ans.backend, count: locs.length } };
  },
};

export const codeReferencesTool: ToolDef<PosArgs> = {
  name: 'code_references',
  kind: 'read',
  readOnly: true,
  core: true,
  description:
    'List every reference (call site, import, use) of an identifier as file:line + the line, the declaration included. Use it before changing a signature, to update every call site. ' +
    'Give `symbol`, or `path`+`line` (+`col`).',
  parameters: posSchema,
  permissionInput: readInput,
  title: (a) => `References to ${a.symbol ?? `${a.path}:${a.line}`}`,
  async run(a, ctx) {
    const r = await resolvePos(ctx, a, 'code_references');
    // LSP needs a position: without one, resolve the definition by name first
    let pos = { abs: r.abs, line: r.line, col: r.col };
    let target: ResolvedDef | undefined;
    if (!r.line || !r.col) {
      target = (await fallbackDefs(ctx, r, 'code_references'))[0];
      if (target) {
        const t = target.file.lines[target.def.line - 1] ?? '';
        const c = t.search(new RegExp(`(?<![\\w$])${target.def.name.replace(/[$]/g, '\\$')}(?![\\w$])`));
        pos = { abs: target.file.abs, line: target.def.line, col: c >= 0 ? c + 1 : 1 };
      }
    }
    const ans = await navigate(ctx, { op: 'references', path: pos.abs, line: pos.line, col: pos.col }, async () => {
      target ??= (await fallbackDefs(ctx, r, 'code_references'))[0];
      if (!target) return [];
      const table = await symbolTable(ctx.workspace, visibleFor(ctx, 'code_references'));
      return findReferences(table, target);
    });
    const { locs, hidden } = filterVisible(ctx, 'code_references', ans.locations);
    if (!locs.length) return { output: `No references found for ${r.name ? `\`${r.name}\`` : 'that position'}.${hiddenNote(hidden)}${ans.notes.length ? `\n(note: ${ans.notes.join(' ')})` : ''}` };
    const files = new Set(locs.map((l) => l.path)).size;
    const body = renderLocations(ctx, locs, lspConfig(ctx.config).maxResults);
    return { output: `${header(`References to ${r.name ? `\`${r.name}\`` : 'symbol'} (${files} file(s))`, ans, locs.length)}\n${body.text}${hiddenNote(hidden)}`, meta: { backend: ans.backend, count: locs.length } };
  },
};

export const codeSymbolsTool: ToolDef<{ path?: string; query?: string }> = {
  name: 'code_symbols',
  kind: 'read',
  readOnly: true,
  description: 'Outline of a file (`path`: classes, functions, methods with line numbers), or a workspace-wide symbol search (`query`: name or prefix).',
  parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string', description: 'Symbol name, prefix or camel humps (e.g. "bRM")' } } },
  permissionInput: (a, ctx) => ({ paths: a.path ? [{ path: absOf(ctx, a.path), write: false }] : [] }),
  title: (a) => (a.path ? `Symbols of ${a.path}` : `Symbols matching ${a.query}`),
  async run(a, ctx) {
    if (!a.path && !a.query) throw new ToolError('code_symbols needs `path` (file outline) or `query` (workspace symbols).');
    const vis = visibleFor(ctx, 'code_symbols');
    if (a.path) {
      const abs = absOf(ctx, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`${a.path}: no such file`);
      if (!vis(abs)) throw new ToolError(`${a.path} is not readable here (secret, ignored or outside the read policy).`);
      const ans = await navigate(ctx, { op: 'documentSymbols', path: abs }, async () => {
        const f = await fileSymbols(ctx.workspace, abs);
        return (f?.defs ?? []).map((d) => ({ path: abs, line: d.line, col: 1, name: d.name, kind: d.kind, container: d.parent }));
      });
      const lines = ans.locations.filter((l) => !['variable', 'property', 'field', 'constant', 'string', 'number', 'key', 'enum member', 'type parameter'].includes(l.kind ?? '') || !l.container).map((l) => `${String(l.line).padStart(5)}  ${l.container ? '  ' : ''}${l.kind ? `${l.kind} ` : ''}${l.container ? `${l.container}.` : ''}${l.name}`);
      let text = lines.join('\n');
      if (text.length > OUTPUT_CHARS) text = text.slice(0, OUTPUT_CHARS) + '\n… (truncated)';
      return { output: `${header(`Symbols of ${a.path}`, ans, lines.length)}\n${text}` };
    }
    const ans = await navigate(ctx, { op: 'workspaceSymbols', query: a.query }, async () => {
      const table = await symbolTable(ctx.workspace, vis);
      return searchSymbols(table, a.query!).map((x) => ({ path: x.file.abs, line: x.def.line, col: 1, name: x.def.name, kind: x.def.kind, container: x.def.parent }));
    });
    const { locs, hidden } = filterVisible(ctx, 'code_symbols', ans.locations);
    const body = renderLocations(ctx, locs, lspConfig(ctx.config).maxResults, (l) => ` ${l.kind ?? ''} ${l.container ? `${l.container}.` : ''}${l.name ?? ''} —`);
    return { output: `${header(`Symbols matching "${a.query}"`, ans, locs.length)}\n${body.text || '(none)'}${hiddenNote(hidden)}` };
  },
};

export const codeRenamePreviewTool: ToolDef<PosArgs & { new_name: string }> = {
  name: 'code_rename_preview',
  kind: 'read',
  readOnly: true,
  description: 'Preview renaming an identifier everywhere (nothing is written): lists each edit as file:line with the old and new line. With a language server or the editor, it also returns an id: apply the whole rename with code_apply.',
  parameters: { ...posSchema, properties: { ...posSchema.properties, new_name: { type: 'string' } }, required: ['new_name'] },
  permissionInput: readInput,
  title: (a) => `Rename preview ${a.symbol ?? `${a.path}:${a.line}`} → ${a.new_name}`,
  async run(a, ctx) {
    if (!/^[A-Za-z_$][\w$]*$/.test(a.new_name ?? '')) throw new ToolError('new_name must be an identifier.');
    const r = await resolvePos(ctx, a, 'code_rename_preview');
    const notes: string[] = [];
    let edits: NavEdit[] | undefined;
    let backend = '';
    if (r.abs && r.line && r.col) {
      const req: NavRequest = { op: 'rename', path: r.abs, line: r.line, col: r.col, newName: a.new_name };
      if (ctx.host?.navigate) {
        const h = await ctx.host.navigate(req).catch((e) => (notes.push((e as Error).message), undefined));
        if (h?.edits?.length) (edits = h.edits), (backend = `${ctx.host.kind} language features`);
      }
      if (!edits && serverFor(ctx.config, r.abs, ctx.workspace)) {
        // rename at the definition: from a use that is an import alias some servers rename only the local alias
        const d = await viaLsp(ctx, { op: 'definition', path: r.abs, line: r.line, col: r.col });
        const at = d.result?.locations?.find((x) => visibleFor(ctx, 'code_rename_preview')(x.path) && serverFor(ctx.config, x.path, ctx.workspace));
        if (at) Object.assign(req, { path: at.path, line: at.line, col: at.col });
        const l = await viaLsp(ctx, req);
        if (l.error) notes.push(l.error);
        if (l.result?.edits?.length) (edits = l.result.edits), (backend = `lsp: ${l.server}`);
      }
    }
    const exact = !!edits?.length; // from the editor or a language server, not name matching
    if (!edits) {
      // name matching: the references, each occurrence replaced
      const refs = await codeReferencesLocations(ctx, r);
      edits = refs.map((l) => ({ path: l.path, line: l.line, col: l.col, endLine: l.line, endCol: l.col + (r.name?.length ?? 0), newText: a.new_name }));
      backend = 'name matching (review every line: same-named symbols may be included)';
    }
    const vis = visibleFor(ctx, 'code_rename_preview');
    const shown = edits.filter((e) => vis(e.path));
    const hidden = edits.length - shown.length;
    const out: string[] = [];
    let used = 0;
    for (const e of shown) {
      const old = lineOf(e.path, e.line);
      const full = fs.existsSync(e.path) ? (fs.readFileSync(e.path, 'utf8').split('\n')[e.line - 1] ?? '') : '';
      const next = e.line === e.endLine ? full.slice(0, e.col - 1) + e.newText + full.slice(e.endCol - 1) : `${full.slice(0, e.col - 1)}${e.newText}…`;
      const s = `${relOf(ctx, e.path)}:${e.line}:\n  - ${redactSecrets(old)}\n  + ${redactSecrets(next.trim())}`;
      if (used + s.length > OUTPUT_CHARS) {
        out.push(`… ${shown.length - out.length} more edit(s)`);
        break;
      }
      out.push(s);
      used += s.length;
    }
    const applyId = exact && !hidden ? rememberEdits(ctx, edits, `rename \`${r.name}\` → \`${a.new_name}\``) : undefined;
    const how = hidden ? '' : applyId ? `\nApply it with code_apply {"id": "${applyId}"} (all files at once, with a checkpoint), or edit by hand.` : '\n(name matching cannot be applied automatically: apply the edits with the edit tools)';
    return { output: `Rename \`${r.name}\` → \`${a.new_name}\`: ${shown.length} edit(s) in ${new Set(shown.map((e) => e.path)).size} file(s) via ${backend} (preview only, nothing written)${notes.length ? `\n(note: ${notes.join(' ')})` : ''}\n${out.join('\n')}${hiddenNote(hidden)}${how}` };
  },
};

async function codeReferencesLocations(ctx: ToolContext, r: Resolved): Promise<NavLocation[]> {
  const target = (await fallbackDefs(ctx, r, 'code_rename_preview'))[0];
  if (!target) return [];
  return findReferences(await symbolTable(ctx.workspace, visibleFor(ctx, 'code_rename_preview')), target);
}


// ------------------------------------------------------------ v1.2 N46: more LSP operations and applying edits

/** Edits computed by a preview (rename, code action), applied later by code_apply. Keyed per session. */
interface PendingEdits {
  session: string;
  label: string;
  edits: NavEdit[];
  /** sha256 of each file when the edits were computed: refused if the file changed since */
  hashes: Record<string, string>;
  at: number;
}
const pending = new Map<string, PendingEdits>();

function sha(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function rootSessionOf(id: string): string {
  return id.replace(/(-sub-\d+)+$/, '');
}

function rememberEdits(ctx: ToolContext, edits: NavEdit[], label: string): string {
  const hashes: Record<string, string> = {};
  for (const f of new Set(edits.map((e) => e.path))) hashes[f] = sha(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  const id = `ed_${crypto.randomBytes(4).toString('hex')}`;
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k);
  pending.set(id, { session: rootSessionOf(ctx.sessionId), label, edits, hashes, at: Date.now() });
  return id;
}

/** Apply edits (1-based, end-exclusive columns) to a text, last first so earlier positions stay valid. */
export function applyNavEdits(text: string, edits: NavEdit[]): string {
  const lines = text.split('\n');
  const offset = (line: number, col: number) => {
    let o = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) o += lines[i].length + 1;
    return o + col - 1;
  };
  const sorted = [...edits].sort((a, b) => offset(b.line, b.col) - offset(a.line, a.col));
  let out = text;
  for (const e of sorted) out = out.slice(0, offset(e.line, e.col)) + e.newText + out.slice(offset(e.endLine, e.endCol));
  return out;
}

async function posRequest(ctx: ToolContext, a: PosArgs, tool: string, op: NavRequest['op']): Promise<{ req: NavRequest; r: Resolved }> {
  let r = await resolvePos(ctx, a, tool);
  if (!r.abs || !r.line || !r.col) {
    // a bare symbol: locate its definition first, then ask from there
    const d = (await fallbackDefs(ctx, r, tool))[0];
    if (!d) throw new ToolError(`${tool}: could not find \`${a.symbol ?? a.path}\`. Give path + line (+ col) of the identifier.`);
    r = await resolvePos(ctx, { path: d.file.abs, line: d.def.line, symbol: d.def.name }, tool);
  }
  return { req: { op, path: r.abs!, line: r.line!, col: r.col! }, r };
}

async function hostOrLsp(ctx: ToolContext, req: NavRequest): Promise<{ result?: NavResult; backend?: string; notes: string[] }> {
  const notes: string[] = [];
  if (ctx.host?.navigate) {
    try {
      const h = await ctx.host.navigate(req);
      if (h && (h.locations?.length || h.calls?.length || h.actions?.length || h.hover)) return { result: h, backend: `${ctx.host.kind} language features`, notes };
    } catch (e) {
      notes.push(`editor: ${(e as Error).message}`);
    }
  }
  if (req.path && serverFor(ctx.config, req.path, ctx.workspace)) {
    const l = await viaLsp(ctx, req);
    if (l.error) notes.push(l.error);
    if (l.result) return { result: l.result, backend: `lsp: ${l.server}`, notes };
  } else notes.push(`no language server is configured for ${req.path ? path.extname(req.path) : 'this'} files (lsp.servers, or "lsp": {"autoDetect": true}); this operation needs one`);
  return { notes };
}

export const codeHoverTool: ToolDef<PosArgs & { kind?: 'hover' | 'type_definition' | 'implementation' }> = {
  name: 'code_hover',
  kind: 'read',
  readOnly: true,
  description: 'Language-server facts about an identifier: `kind: "hover"` (default) gives its type and docs; "type_definition" where its type is declared; "implementation" the implementations of an interface or abstract method. Give `symbol`, or `path`+`line` (+`col`).',
  parameters: { ...posSchema, properties: { ...posSchema.properties, kind: { type: 'string', enum: ['hover', 'type_definition', 'implementation'] } } },
  permissionInput: readInput,
  title: (a) => `${a.kind ?? 'hover'} ${a.symbol ?? `${a.path}:${a.line}`}`,
  async run(a, ctx) {
    const op = a.kind === 'type_definition' ? 'typeDefinition' : a.kind === 'implementation' ? 'implementation' : 'hover';
    const { req, r } = await posRequest(ctx, a, 'code_hover', op);
    const got = await hostOrLsp(ctx, req);
    const note = got.notes.length ? `\n(note: ${got.notes.join(' ')})` : '';
    if (op === 'hover') {
      const h = got.result?.hover?.trim();
      return { output: h ? `${relOf(ctx, r.abs!)}:${r.line}:${r.col} \`${r.name}\` via ${got.backend}:\n${redactSecrets(h).slice(0, OUTPUT_CHARS)}${note}` : `no hover information for \`${r.name}\`${note}`, isError: !h && !got.backend };
    }
    const { locs, hidden } = filterVisible(ctx, 'code_hover', got.result?.locations ?? []);
    const shown = renderLocations(ctx, locs, lspConfig(ctx.config).maxResults);
    return { output: `${op === 'implementation' ? 'Implementations' : 'Type definition'} of \`${r.name}\`: ${locs.length} result(s)${got.backend ? ` via ${got.backend}` : ''}${note}\n${shown.text}${hiddenNote(hidden)}`, isError: !got.backend };
  },
};

export const codeCallsTool: ToolDef<PosArgs & { direction?: 'incoming' | 'outgoing' }> = {
  name: 'code_calls',
  kind: 'read',
  readOnly: true,
  description: 'Call hierarchy from a language server: `direction: "incoming"` (default) lists the functions that call this one, with the call sites; "outgoing" lists what it calls. Give `symbol`, or `path`+`line` (+`col`) of the function.',
  parameters: { ...posSchema, properties: { ...posSchema.properties, direction: { type: 'string', enum: ['incoming', 'outgoing'] } } },
  permissionInput: readInput,
  title: (a) => `${a.direction ?? 'incoming'} calls of ${a.symbol ?? `${a.path}:${a.line}`}`,
  async run(a, ctx) {
    const { req, r } = await posRequest(ctx, a, 'code_calls', a.direction === 'outgoing' ? 'outgoingCalls' : 'incomingCalls');
    const got = await hostOrLsp(ctx, req);
    const vis = visibleFor(ctx, 'code_calls');
    const calls = (got.result?.calls ?? []).filter((c) => vis(c.path));
    const hidden = (got.result?.calls ?? []).length - calls.length;
    const lines = calls.slice(0, lspConfig(ctx.config).maxResults).map((c) => `${relOf(ctx, c.path)}:${c.line}  ${c.kind ? `${c.kind} ` : ''}${c.name}${c.at?.length ? `  (calls at line${c.at.length > 1 ? 's' : ''} ${c.at.map((x) => x.line).join(', ')})` : ''}`);
    return { output: `${a.direction === 'outgoing' ? 'Calls made by' : 'Callers of'} \`${r.name}\`: ${calls.length}${got.backend ? ` via ${got.backend}` : ''}${got.notes.length ? `\n(note: ${got.notes.join(' ')})` : ''}\n${lines.join('\n')}${hiddenNote(hidden)}`, isError: !got.backend };
  },
};

export const codeDiagnosticsTool: ToolDef<{ path?: string; fixes?: boolean }> = {
  name: 'code_diagnostics',
  kind: 'read',
  readOnly: true,
  description: 'Errors and warnings from the language server for a file (`path`, re-synced first), or for every file the server has open (no path). With `fixes: true` and a path, also lists the quick fixes the server offers, each with an id for code_apply.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, fixes: { type: 'boolean' } } },
  permissionInput: (a, ctx) => ({ paths: a.path ? [{ path: absOf(ctx, a.path), write: false }] : [] }),
  title: (a) => `Diagnostics ${a.path ?? '(open files)'}`,
  async run(a, ctx) {
    const vis = visibleFor(ctx, 'code_diagnostics');
    const target = { config: ctx.config, workspace: ctx.workspace, sessionId: ctx.sessionId };
    const fmt = (abs: string, d: any) => `${relOf(ctx, abs)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${['', 'error', 'warning', 'info', 'hint'][d.severity ?? 1]}: ${redactSecrets(String(d.message)).split('\n')[0]}${d.source ? ` [${d.source}]` : ''}`;
    if (a.path) {
      const abs = absOf(ctx, a.path);
      if (!fs.existsSync(abs)) throw new ToolError(`${a.path}: no such file`);
      if (!vis(abs)) throw new ToolError(`${a.path} is not readable here.`);
      const got = await clientForFile(target, abs).catch((e) => {
        throw new ToolError((e as Error).message);
      });
      if (!got) throw new ToolError(`no language server is configured for ${path.extname(abs)} files (lsp.servers, or "lsp": {"autoDetect": true})`);
      const { seq, sent } = got.client.syncInfo(abs);
      // pull diagnostics when the server offers them (LSP 3.17; review F11), else wait for a publish
      const pulled = await got.client.pullDocumentDiagnostics(abs).catch(() => undefined);
      const items = pulled ?? (sent || !got.client.diagnostics.get(toUri(abs)) ? await got.client.waitDiagnostics(abs, seq, lspConfig(ctx.config).requestTimeoutMs, 500) : undefined) ?? got.client.diagnostics.get(toUri(abs))?.items ?? [];
      const out = [`${relOf(ctx, abs)}: ${items.length} diagnostic(s) via lsp: ${got.server.name}${pulled ? ' (pulled)' : ''}`, ...items.slice(0, lspConfig(ctx.config).maxResults).map((d) => fmt(abs, d))];
      if (a.fixes && items.length) {
        const errLines = items.map((d) => d.range.start.line + 1);
        const res = await viaLsp(ctx, { op: 'codeActions', path: abs, line: Math.min(...errLines), col: 1, endLine: Math.max(...errLines) });
        const acts = (res.result?.actions ?? []).filter((x) => x.edits?.length);
        if (acts.length) out.push('Fixes (apply with code_apply {"id": …}):');
        for (const x of acts.slice(0, 12)) out.push(`  ${rememberEdits(ctx, x.edits!, `code action "${x.title}"`)}  ${x.title}${x.kind ? ` (${x.kind})` : ''} — ${new Set(x.edits!.map((e) => e.path)).size} file(s)`);
        const cmds = (res.result?.actions ?? []).filter((x) => !x.edits?.length && x.command).length;
        if (cmds) out.push(`(${cmds} action(s) that only run a server command are not offered: Tugline applies edits, never server commands)`);
      }
      return { output: out.join('\n') };
    }
    const { sessionClients } = await import('./servers.js');
    const out: string[] = [];
    let pulledAll = false;
    for (const c of sessionClients(ctx.sessionId)) if ((await c.pullWorkspaceDiagnostics().catch(() => undefined)) !== undefined) pulledAll = true;
    for (const c of sessionClients(ctx.sessionId))
      for (const [uri, d] of c.diagnostics) {
        const abs = fromUri(uri);
        if (!vis(abs) || !d.items.length) continue;
        out.push(...d.items.slice(0, 20).map((x) => fmt(abs, x)));
      }
    const where = pulledAll ? 'in the workspace (pulled from the servers that support workspace diagnostics) and open files' : 'in open files';
    return { output: out.length ? `${out.length} diagnostic(s) ${where}:\n${out.slice(0, lspConfig(ctx.config).maxResults).join('\n')}` : `no diagnostics ${pulledAll ? 'in the workspace' : 'in the files the language servers have open (give a path to check a file)'}` };
  },
};

function pendingFor(ctx: ToolContext, id: string): PendingEdits | undefined {
  const p = pending.get(String(id ?? ''));
  return p && p.session === rootSessionOf(ctx.sessionId) ? p : undefined;
}

export const codeApplyTool: ToolDef<{ id: string }> = {
  name: 'code_apply',
  kind: 'edit',
  description: 'Apply a rename (id from code_rename_preview) or a quick fix (id from code_diagnostics with fixes) to every file it touches at once. Asks like any edit, refuses protected files, takes a checkpoint first (undo with /rewind), and reports new diagnostics.',
  parameters: { type: 'object', properties: { id: { type: 'string', description: 'ed_… id from code_rename_preview or code_diagnostics' } }, required: ['id'] },
  // SAC2: every file the edit touches goes to the permission engine (protected paths, writeOnly, modes)
  permissionInput: (a, ctx) => ({ paths: [...new Set((pendingFor(ctx, a.id)?.edits ?? []).map((e) => e.path))].map((p) => ({ path: p, write: true })) }),
  title: (a) => `Apply ${a.id}`,
  async preview(a, ctx) {
    const p = pendingFor(ctx, a.id);
    const first = p?.edits[0]?.path;
    if (!p || !first) return undefined;
    const before = fs.readFileSync(first, 'utf8');
    return { path: first, before, after: applyNavEdits(before, p.edits.filter((e) => e.path === first)) };
  },
  async run(a, ctx) {
    const p = pendingFor(ctx, a.id);
    if (!p) throw new ToolError(`unknown or expired id "${a.id}": run code_rename_preview (or code_diagnostics with fixes) again`);
    const files = [...new Set(p.edits.map((e) => e.path))];
    const host = ctx.host;
    const texts = new Map<string, string>();
    for (const f of files) {
      const cur = host ? (await host.readText(f))?.text : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;
      if (cur === undefined || sha(cur) !== p.hashes[f]) throw new ToolError(`${relOf(ctx, f)} changed since the preview; run the preview again so the edits match the file`);
      texts.set(f, cur);
    }
    // a checkpoint first: the whole multi-file edit is undone with /rewind <id> (C1)
    let cpId = '';
    try {
      const { checkpointsFor, checkpointConfig } = await import('../checkpoint/index.js');
      if (checkpointConfig(ctx.config).enabled) cpId = (await checkpointsFor(ctx.config, ctx.workspace).snapshot({ label: `before code_apply: ${p.label}`.slice(0, 120), kind: 'manual', sessionId: ctx.sessionId }))?.id ?? '';
    } catch (e) {
      throw new ToolError(`could not take a checkpoint before the multi-file edit (${(e as Error).message}); nothing was changed`);
    }
    const written: string[] = [];
    for (const f of files) {
      const next = applyNavEdits(texts.get(f)!, p.edits.filter((e) => e.path === f));
      if (host) await host.writeText(f, next, { label: p.label });
      else fs.writeFileSync(f, next);
      written.push(f);
    }
    pending.delete(a.id);
    // keep the language server in step, then report what is broken now
    const diag: string[] = [];
    const target = { config: ctx.config, workspace: ctx.workspace, sessionId: ctx.sessionId };
    for (const f of written) {
      const got = await clientForFile(target, f).catch(() => undefined);
      if (!got) continue;
      const { seq } = got.client.syncInfo(f);
      const items = (await got.client.waitDiagnostics(f, seq, 5000, 300)) ?? [];
      for (const d of items.filter((x) => (x.severity ?? 1) === 1).slice(0, 5)) diag.push(`${relOf(ctx, f)}:${d.range.start.line + 1}: ${d.message.split('\n')[0]}`);
    }
    return {
      output: `Applied ${p.label}: ${p.edits.length} edit(s) in ${written.length} file(s): ${written.map((f) => relOf(ctx, f)).join(', ')}.${cpId ? ` Checkpoint ${cpId} was taken first: undo with /rewind ${cpId}.` : ''}${diag.length ? `\nErrors now reported:\n${diag.join('\n')}` : ''}`,
      meta: written.length === 1 ? { changedFile: written[0], before: texts.get(written[0]), after: applyNavEdits(texts.get(written[0])!, p.edits.filter((e) => e.path === written[0])) } : undefined,
    };
  },
};

/** N46: operations that need a language server or the editor (with name matching only they say so and how to add one). */
export const LSP_TOOLS = [codeHoverTool, codeCallsTool, codeDiagnosticsTool, codeApplyTool];
export const NAV_TOOLS = [codeDefinitionTool, codeReferencesTool, codeSymbolsTool, codeRenamePreviewTool, ...LSP_TOOLS];

/** Extensions any backend can navigate: the name-matching fallback's languages plus configured servers'. */
const FALLBACK_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.scala', '.swift', '.dart', '.rb', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx', '.php'];

registerToolProvider({
  id: 'nav',
  tools(cfg, env) {
    const enabled = lspConfig(cfg).enabled;
    if (enabled === false) return [];
    // review F11: in an editor that navigates (VS Code), the editor's language features back the tools
    if (env.hostNavigates) return NAV_TOOLS;
    // AC4: hidden when no server matches a workspace language ("auto"), or, when
    // enabled explicitly, when no backend (servers + name matching) covers one.
    const serverExt = resolvedServers(cfg, env.workspace).flatMap((s) => s.extensions);
    const exts = new Set(enabled === true ? [...FALLBACK_EXT, ...serverExt] : serverExt);
    if (!exts.size) return [];
    return listFiles(env.workspace, { extensions: exts, max: 1 }).length > 0 ? NAV_TOOLS : [];
  },
});

