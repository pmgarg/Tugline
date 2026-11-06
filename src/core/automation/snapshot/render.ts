/**
 * Snapshot renderer (SPEC E2, research CU §5.3): the unified text format
 *
 *   - role "name" [ref=e5] [checked] [value="x"]
 *
 * with children indented. Pruning is the biggest cost knob for 27B models:
 * unnamed wrappers are hoisted, static text is clipped, repeated siblings
 * collapse into "… N more rows", a `query` keeps only matching nodes plus their
 * ancestor chain, and a token budget hard-caps the result (`truncated: true`).
 * Password values always render as •••; a caller-supplied mask redacts
 * secrets that a page echoes back.
 */
import type { UiNode } from '../types.js';
import { estimateTokens } from '../../util/text.js';
import { INTERACTIVE_ROLES, SCOPE_ROLES, TRANSPARENT_ROLES, findRef, isInteractive } from './tree.js';

export interface RenderOptions {
  /** Token budget (default 5000). 0 = unlimited (used for hashing and diffs). */
  maxTokens?: number;
  /** Fuzzy filter on role/name/value; ancestors of matches are kept. */
  query?: string;
  /** Scope to the subtree of this ref. */
  scopeRef?: string;
  maxRepeated?: number;
  maxTextChars?: number;
  includeBoxes?: boolean;
  /** Redaction applied to every rendered line (secrets a page echoes back). */
  mask?: (s: string) => string;
}

export interface Rendered {
  text: string;
  truncated: boolean;
  /** Lines dropped by the budget. */
  omittedLines: number;
  /** Nodes matching `query` (when given). */
  matches?: number;
}

const MASK = '•••';

function plural(role: string, n: number): string {
  const names: Record<string, string> = { listitem: 'list items', menuitem: 'menu items', columnheader: 'column headers', rowheader: 'row headers', treeitem: 'tree items', gridcell: 'cells' };
  if (names[role]) return names[role];
  return n === 1 ? role : role.endsWith('x') ? `${role}es` : `${role}s`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Hoist unnamed wrappers, drop empty/unnamed images, clip text. Returns a new tree. */
export function prune(n: UiNode, maxText = 160): UiNode[] {
  if (n.role === 'text') {
    const t = clip(n.name ?? '', maxText);
    return t ? [{ role: 'text', name: t }] : [];
  }
  const kids = (n.children ?? []).flatMap((c) => prune(c, maxText));
  if ((n.role === 'img' || n.role === 'image') && !n.name && !isInteractive(n)) return kids;
  if (TRANSPARENT_ROLES.has(n.role) && !n.name && !isInteractive(n) && n.value === undefined) return kids;
  // Merge adjacent text fragments so "Hello" "world" do not cost two lines.
  const merged: UiNode[] = [];
  for (const k of kids) {
    const prev = merged[merged.length - 1];
    if (k.role === 'text' && prev?.role === 'text' && !k.children && !prev.children) prev.name = clip(`${prev.name} ${k.name}`, maxText);
    else merged.push(k);
  }
  // A <label> text next to the control it names repeats the control's name: drop it.
  const named = new Set(merged.filter((k) => k.role !== 'text' && isInteractive(k) && k.name).map((k) => k.name!.toLowerCase()));
  if (n.name) named.add(n.name.toLowerCase()); // a <legend>/<caption> repeating its group's name
  if (named.size) for (let i = merged.length - 1; i >= 0; i--) if (merged[i].role === 'text' && !merged[i].children && named.has((merged[i].name ?? '').toLowerCase())) merged.splice(i, 1);
  const out: UiNode = { ...n, children: merged.length ? merged : undefined };
  if (!merged.length) delete out.children;
  return [out];
}

function showRef(n: UiNode): boolean {
  return !!n.ref && (INTERACTIVE_ROLES.has(n.role) || SCOPE_ROLES.has(n.role) || !!n.states?.includes('clickable'));
}

function nodeLine(n: UiNode, o: Required<Pick<RenderOptions, 'maxTextChars' | 'includeBoxes'>>, inlineText?: string): string {
  if (n.role === 'text') return `- text: ${clip(n.name ?? '', o.maxTextChars)}`;
  let s = `- ${n.role}`;
  if (n.name) s += ` ${quote(clip(n.name, 120))}`;
  if (showRef(n)) s += ` [ref=${n.ref}]`;
  const password = n.states?.includes('password');
  // 'active' (focus) is kept in the tree for expectations but not rendered: it only adds diff noise.
  for (const st of n.states ?? []) if (st !== 'password' && st !== 'active' && st !== 'focused') s += ` [${st}]`;
  if (password) s += n.value ? ` [password] [value=${MASK}]` : ' [password]';
  else if (n.value !== undefined && n.value !== '') s += ` [value=${quote(clip(n.value, o.maxTextChars))}]`;
  else if (n.placeholder) s += ` [placeholder=${quote(clip(n.placeholder, 60))}]`;
  if (n.url && n.url.length <= 100 && !/^javascript:/i.test(n.url)) s += ` [url=${n.url}]`;
  if (o.includeBoxes && n.box) s += ` [box=${Math.round(n.box.x)},${Math.round(n.box.y)},${Math.round(n.box.width)},${Math.round(n.box.height)}]`;
  if (inlineText !== undefined) s += `: ${clip(inlineText, o.maxTextChars)}`;
  else if (n.children?.length) s += ':';
  return s;
}

function matchesQuery(n: UiNode, tokens: string[]): boolean {
  if (!tokens.length) return false;
  const hay = `${n.role} ${n.name ?? ''} ${n.value ?? ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/** Keep matching nodes (with their subtree) and the ancestor chains leading to them. */
export function filterByQuery(root: UiNode, query: string): { tree?: UiNode; matches: number } {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let matches = 0;
  const rec = (n: UiNode, inRow: boolean): UiNode | undefined => {
    // A hit inside a table row keeps the whole row: a cell alone is rarely useful.
    if (n.role === 'row' && rowMatches(n, tokens)) {
      matches++;
      return n;
    }
    if (matchesQuery(n, tokens) && !inRow) {
      matches++;
      return n;
    }
    const kids = (n.children ?? []).map((c) => rec(c, inRow || n.role === 'row')).filter((x): x is UiNode => !!x);
    if (!kids.length) return undefined;
    return { ...n, children: kids };
  };
  return { tree: rec(root, false), matches };
}

function rowMatches(row: UiNode, tokens: string[]): boolean {
  const parts: string[] = [];
  const rec = (n: UiNode) => {
    parts.push(`${n.role} ${n.name ?? ''} ${n.value ?? ''}`);
    for (const c of n.children ?? []) rec(c);
  };
  rec(row);
  const hay = parts.join(' ').toLowerCase();
  return tokens.length > 0 && tokens.every((t) => hay.includes(t));
}

export function renderTree(root: UiNode, opts: RenderOptions = {}): Rendered {
  const o = { maxTextChars: opts.maxTextChars ?? 160, includeBoxes: !!opts.includeBoxes };
  const maxRepeated = opts.maxRepeated ?? 20;
  const maxTokens = opts.maxTokens ?? 5000;
  const mask = opts.mask ?? ((s: string) => s);
  let start: UiNode = root;
  if (opts.scopeRef) {
    const hit = findRef(root, opts.scopeRef);
    if (!hit) return { text: `(no element with ref ${opts.scopeRef} in this snapshot)`, truncated: false, omittedLines: 0 };
    start = hit.node;
  }
  let pruned = prune(start, o.maxTextChars);
  let matches: number | undefined;
  if (opts.query?.trim()) {
    const doc: UiNode = { role: 'document', children: pruned };
    const f = filterByQuery(doc, opts.query);
    matches = f.matches;
    pruned = f.tree?.children ?? [];
  }
  // The synthetic document root is not printed.
  if (pruned.length === 1 && pruned[0].role === 'document' && !pruned[0].ref) pruned = pruned[0].children ?? [];

  const lines: string[] = [];
  const emit = (nodes: UiNode[], depth: number) => {
    const pad = '  '.repeat(depth);
    let i = 0;
    while (i < nodes.length) {
      // Collapse long runs of same-role siblings (table rows, list items, options).
      let j = i;
      while (j < nodes.length && nodes[j].role === nodes[i].role && nodes[i].role !== 'text') j++;
      const run = j - i;
      const shown = run > maxRepeated ? maxRepeated : run;
      for (let k = i; k < i + Math.max(shown, 1); k++) {
        const n = nodes[k];
        const only = n.children?.length === 1 && n.children[0].role === 'text' && !n.children[0].children ? n.children[0].name : undefined;
        lines.push(pad + mask(nodeLine(n, o, only)));
        if (n.children?.length && only === undefined) emit(n.children, depth + 1);
      }
      if (run > maxRepeated) lines.push(`${pad}- … ${run - maxRepeated} more ${plural(nodes[i].role, run - maxRepeated)} (use query or browser_extract)`);
      i = j > i ? j : i + 1;
    }
  };
  emit(pruned, 0);
  if (matches === 0) return { text: `(nothing matches query "${opts.query}")`, truncated: false, omittedLines: 0, matches };

  if (!maxTokens) return { text: lines.join('\n'), truncated: false, omittedLines: 0, matches };
  const out: string[] = [];
  let used = 0;
  const reserve = 30;
  for (let k = 0; k < lines.length; k++) {
    const t = estimateTokens(lines[k] + '\n');
    if (used + t > maxTokens - reserve) {
      const omitted = lines.length - k;
      out.push(`… [truncated: ${omitted} more lines; narrow with query or scope]`);
      return { text: out.join('\n'), truncated: true, omittedLines: omitted, matches };
    }
    used += t;
    out.push(lines[k]);
  }
  return { text: out.join('\n'), truncated: false, omittedLines: 0, matches };
}
