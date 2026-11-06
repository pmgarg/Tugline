/**
 * Jupyter notebooks (SPEC D11).
 *
 * `notebook_edit` changes one cell of an .ipynb file while preserving
 * everything else byte-for-byte where possible: notebook/cell metadata, other
 * cells' outputs, key order, the file's JSON indentation and trailing newline.
 * A replaced code cell gets its outputs cleared (they no longer match the code).
 * `renderNotebook` is the read view (cells with indices); WS1 wires it into
 * read_file for .ipynb files.
 */
import path from 'node:path';
import { registerToolProvider } from './registry.js';
import { ToolError, type ToolDef } from './types.js';

interface Cell {
  cell_type: 'code' | 'markdown' | 'raw';
  id?: string;
  metadata?: Record<string, unknown>;
  source: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
  [k: string]: unknown;
}

interface Notebook {
  cells: Cell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
  [k: string]: unknown;
}

export function parseNotebook(text: string): Notebook {
  let nb: Notebook;
  try {
    nb = JSON.parse(text);
  } catch (e) {
    throw new ToolError(`not a valid notebook (JSON parse error: ${(e as Error).message})`);
  }
  if (!nb || !Array.isArray(nb.cells)) throw new ToolError('not a valid notebook: no "cells" array');
  return nb;
}

/** Jupyter stores source as lines that keep their "\n" (except the last). */
export function toSourceLines(src: string): string[] {
  if (!src) return [];
  const parts = src.split('\n');
  return parts.map((l, i) => (i < parts.length - 1 ? `${l}\n` : l)).filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

const sourceText = (c: Cell) => (Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''));

/** Detect the indentation the file uses (nbformat writes 1 space). */
function detectIndent(text: string): number | string {
  const m = text.match(/^\{\r?\n([ \t]+)"/);
  if (!m) return 1;
  return m[1].startsWith('\t') ? '\t' : m[1].length;
}

export function serializeNotebook(nb: Notebook, like: string): string {
  const out = JSON.stringify(nb, null, detectIndent(like));
  return like.endsWith('\n') ? `${out}\n` : out;
}

function outputText(o: any): string {
  if (o?.output_type === 'stream') return Array.isArray(o.text) ? o.text.join('') : String(o.text ?? '');
  if (o?.output_type === 'error') return `${o.ename}: ${o.evalue}`;
  const d = o?.data ?? {};
  if (d['text/plain']) return Array.isArray(d['text/plain']) ? d['text/plain'].join('') : String(d['text/plain']);
  const kinds = Object.keys(d);
  return kinds.length ? `[${kinds.join(', ')}]` : '';
}

/** Read view: one block per cell with its index (and id), source, and a short output preview. */
export function renderNotebook(text: string, opts: { maxOutputChars?: number } = {}): string {
  const nb = parseNotebook(text);
  const lang = (nb.metadata as any)?.language_info?.name ?? (nb.metadata as any)?.kernelspec?.language ?? '';
  const max = opts.maxOutputChars ?? 500;
  const blocks = nb.cells.map((c, i) => {
    const head = `### cell ${i}${c.id ? ` (id ${c.id})` : ''} · ${c.cell_type}${c.cell_type === 'code' && c.execution_count != null ? ` · [${c.execution_count}]` : ''}`;
    const body = c.cell_type === 'code' ? `\`\`\`${lang}\n${sourceText(c)}\n\`\`\`` : sourceText(c);
    let out = '';
    if (c.cell_type === 'code' && Array.isArray(c.outputs) && c.outputs.length) {
      let t = c.outputs.map(outputText).filter(Boolean).join('\n');
      if (t.length > max) t = `${t.slice(0, max)}… [${t.length - max} more chars]`;
      out = `\noutput:\n${t}`;
    }
    return `${head}\n${body}${out}`;
  });
  return `Notebook with ${nb.cells.length} cell(s)${lang ? ` (${lang})` : ''}. Edit cells with notebook_edit using the cell index.\n\n${blocks.join('\n\n')}`;
}

export interface NotebookEdit {
  op: 'replace' | 'insert' | 'delete';
  cell_index?: number;
  cell_id?: string;
  source?: string;
  cell_type?: 'code' | 'markdown' | 'raw';
}

function newCellId(nb: Notebook): string | undefined {
  // Cell ids exist from nbformat 4.5 on.
  if ((nb.nbformat ?? 4) < 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) < 5)) return undefined;
  const used = new Set(nb.cells.map((c) => c.id));
  for (;;) {
    const id = Math.random().toString(16).slice(2, 10);
    if (!used.has(id)) return id;
  }
}

function makeCell(nb: Notebook, type: Cell['cell_type'], source: string): Cell {
  const id = newCellId(nb);
  const c: Cell = { cell_type: type, ...(id ? { id } : {}), metadata: {}, source: toSourceLines(source) };
  if (type === 'code') {
    c.execution_count = null;
    c.outputs = [];
  }
  return c;
}

/** Apply one edit; returns the new file text. Throws ToolError with an actionable message. */
export function editNotebook(text: string, e: NotebookEdit): string {
  const nb = parseNotebook(text);
  const n = nb.cells.length;
  let idx: number;
  if (e.cell_id !== undefined && e.cell_id !== '') {
    idx = nb.cells.findIndex((c) => c.id === e.cell_id);
    if (idx < 0) throw new ToolError(`no cell with id "${e.cell_id}". Cell ids: ${nb.cells.map((c, i) => `${i}:${c.id ?? '-'}`).join(', ') || '(none)'}`);
    if (e.op === 'insert') idx += 1; // insert after the named cell
  } else if (e.cell_index !== undefined && e.cell_index !== null && Number.isInteger(Number(e.cell_index))) {
    idx = Number(e.cell_index);
    const max = e.op === 'insert' ? n : n - 1;
    if (idx < 0 || idx > max) throw new ToolError(`cell_index ${idx} is out of range: the notebook has ${n} cell(s) (valid ${e.op === 'insert' ? `0..${n} for insert` : n ? `0..${n - 1}` : 'none'})`);
  } else throw new ToolError('give cell_index (0-based) or cell_id');
  const type = e.cell_type;
  if (type && !['code', 'markdown', 'raw'].includes(type)) throw new ToolError('cell_type must be code, markdown or raw');
  switch (e.op) {
    case 'replace': {
      if (typeof e.source !== 'string') throw new ToolError('source is required for replace');
      const c = nb.cells[idx];
      if (type && type !== c.cell_type) {
        nb.cells[idx] = { ...makeCell(nb, type, e.source), ...(c.id ? { id: c.id } : {}), metadata: c.metadata ?? {} };
        break;
      }
      c.source = toSourceLines(e.source);
      if (c.cell_type === 'code') {
        c.outputs = [];
        c.execution_count = null;
      }
      break;
    }
    case 'insert':
      if (typeof e.source !== 'string') throw new ToolError('source is required for insert');
      nb.cells.splice(idx, 0, makeCell(nb, type ?? 'code', e.source));
      break;
    case 'delete':
      nb.cells.splice(idx, 1);
      break;
    default:
      throw new ToolError('op must be replace, insert or delete');
  }
  return serializeNotebook(nb, text);
}

type Args = NotebookEdit & { path: string };

export const notebookEditTool: ToolDef<Args> = {
  name: 'notebook_edit',
  kind: 'edit',
  description:
    'Edit a Jupyter notebook (.ipynb) cell by 0-based cell_index (or cell_id): op "replace" (outputs of a replaced code cell are cleared), "insert" (new cell at that index; cell_id inserts after it) or "delete". ' +
    'Metadata and other cells are preserved. Read the notebook first to see cell indices. Do not edit .ipynb JSON with edit_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      op: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      cell_index: { type: 'integer' },
      cell_id: { type: 'string' },
      source: { type: 'string', description: 'New cell source (replace/insert)' },
      cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] },
    },
    required: ['path', 'op'],
  },
  title: (a) => `Notebook ${a.op} cell ${a.cell_id ?? a.cell_index} in ${a.path}`,
  permissionInput: (a, ctx) => ({ paths: [{ path: path.resolve(ctx.workspace, String(a.path ?? '')), write: true }] }),
  validate(a) {
    if (!/\.ipynb$/i.test(String(a.path ?? ''))) throw new ToolError('notebook_edit only edits .ipynb files');
  },
  async preview(a, ctx) {
    const abs = path.resolve(ctx.workspace, String(a.path));
    const cur = await ctx.host.readText(abs);
    if (!cur) return undefined;
    return { path: abs, before: cur.text, after: editNotebook(cur.text, a) };
  },
  async run(a, ctx) {
    const abs = path.resolve(ctx.workspace, String(a.path ?? ''));
    const cur = await ctx.host.readText(abs);
    if (!cur) throw new ToolError(`${a.path} does not exist`);
    if (cur.utf8 === false) throw new ToolError(`${a.path} is not valid UTF-8; refusing to rewrite it`);
    const after = editNotebook(cur.text, a);
    await ctx.host.writeText(abs, after, { label: `notebook_edit ${a.op}` });
    ctx.ledger.forget(abs);
    const cells = parseNotebook(after).cells.length;
    return { output: `${a.op === 'delete' ? 'Deleted' : a.op === 'insert' ? 'Inserted' : 'Replaced'} cell ${a.cell_id ?? a.cell_index} in ${a.path} (now ${cells} cell(s)).`, meta: { changedFile: abs, before: cur.text, after } };
  },
};

registerToolProvider({ id: 'ws4-notebook', tools: () => [notebookEditTool] });
