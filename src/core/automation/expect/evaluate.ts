/**
 * Expect evaluator (research CU §5.2): the shared post-condition language for
 * browser and desktop. A mutating tool may carry an `expect`; after the action
 * the driver re-scans and evaluates it here, so "the click succeeded" means
 * "the intended state is visible", not "an event was dispatched" (S10 verify).
 *
 * Text matching: "/pattern/flags" is a regex; anything else is a
 * case-insensitive substring match (forgiving for small models).
 */
import type { Expect, UiNode } from '../types.js';
import { hasState, treeText, walk, findRef } from '../snapshot/tree.js';

export interface ExpectContext {
  root: UiNode;
  url?: string;
  title?: string;
  /** Full visible text when the driver has it (falls back to the tree's text). */
  text?: string;
  /** Window or tab titles (desktop windows; browser tabs). */
  windows?: { title: string }[];
}

export interface ExpectResult {
  ok: boolean;
  detail: string;
}

export function parseRegexLike(s: string): RegExp | undefined {
  const m = /^\/(.+)\/([dgimsuvy]*)$/s.exec(s.trim());
  if (!m) return undefined;
  try {
    return new RegExp(m[1], m[2].replace('g', ''));
  } catch {
    return undefined;
  }
}

export function textMatches(pattern: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const re = parseRegexLike(pattern);
  if (re) return re.test(actual);
  return actual.toLowerCase().includes(pattern.toLowerCase());
}

function nodeMatches(n: UiNode, q: { role?: string; name?: string; state?: string }): boolean {
  if (q.role && n.role !== q.role) return false;
  if (q.name !== undefined && !textMatches(q.name, n.name ?? '')) return false;
  if (q.state && !hasState(n, q.state)) return false;
  return true;
}

function findAll(root: UiNode, q: { role?: string; name?: string; state?: string }): UiNode[] {
  const out: UiNode[] = [];
  if (!q.role && q.name === undefined && !q.state) return out;
  walk(root, (n) => {
    if (nodeMatches(n, q)) out.push(n);
  });
  return out;
}

const KINDS = ['element_present', 'element_absent', 'text_present', 'text_absent', 'value_equals', 'url_matches', 'title_matches', 'window_present', 'focused'] as const;

/** Shape check for model-supplied expectations. Returns an error message or undefined. */
export function validateExpect(e: unknown): string | undefined {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'expect must be an object such as {"text_present":"Saved"}';
  const keys = Object.keys(e);
  if (keys.length !== 1 || !(KINDS as readonly string[]).includes(keys[0])) return `expect must have exactly one of: ${KINDS.join(', ')}`;
  const v = (e as any)[keys[0]];
  if (['text_present', 'text_absent', 'url_matches', 'title_matches'].includes(keys[0]) && typeof v !== 'string') return `${keys[0]} takes a string`;
  if (['element_present', 'element_absent', 'value_equals', 'focused', 'window_present'].includes(keys[0]) && (typeof v !== 'object' || !v)) return `${keys[0]} takes an object`;
  return undefined;
}

export function evalExpect(e: Expect, ctx: ExpectContext): ExpectResult {
  const err = validateExpect(e);
  if (err) return { ok: false, detail: err };
  const text = ctx.text ?? treeText(ctx.root);
  if ('element_present' in e) {
    const q = e.element_present;
    const hits = findAll(ctx.root, q);
    return hits.length ? { ok: true, detail: `found ${hits[0].role} "${hits[0].name ?? ''}"` } : { ok: false, detail: `no ${q.role ?? 'element'}${q.name ? ` named "${q.name}"` : ''}${q.state ? ` in state ${q.state}` : ''}` };
  }
  if ('element_absent' in e) {
    const hits = findAll(ctx.root, e.element_absent);
    return hits.length ? { ok: false, detail: `${hits[0].role} "${hits[0].name ?? ''}" is still present` } : { ok: true, detail: 'absent' };
  }
  if ('text_present' in e) return textMatches(e.text_present, text) ? { ok: true, detail: 'text present' } : { ok: false, detail: `text "${e.text_present}" not on the page` };
  if ('text_absent' in e) return textMatches(e.text_absent, text) ? { ok: false, detail: `text "${e.text_absent}" is still on the page` } : { ok: true, detail: 'text absent' };
  if ('value_equals' in e) {
    const q = e.value_equals;
    const node = q.ref ? findRef(ctx.root, q.ref)?.node : findAll(ctx.root, { role: q.role, name: q.name })[0];
    if (!node) return { ok: false, detail: 'target element not found' };
    const actual = node.value ?? '';
    const re = parseRegexLike(q.value);
    const ok = re ? re.test(actual) : actual.trim() === q.value.trim();
    return ok ? { ok, detail: 'value matches' } : { ok, detail: `value is "${actual}", expected "${q.value}"` };
  }
  if ('url_matches' in e) return textMatches(e.url_matches, ctx.url ?? '') ? { ok: true, detail: 'url matches' } : { ok: false, detail: `url is ${ctx.url}` };
  if ('title_matches' in e) return textMatches(e.title_matches, ctx.title ?? '') ? { ok: true, detail: 'title matches' } : { ok: false, detail: `title is "${ctx.title}"` };
  if ('window_present' in e) {
    const re = parseRegexLike(e.window_present.title_regex) ?? new RegExp(e.window_present.title_regex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const w = (ctx.windows ?? []).find((x) => re.test(x.title));
    return w ? { ok: true, detail: `window "${w.title}"` } : { ok: false, detail: 'no matching window' };
  }
  if ('focused' in e) {
    const hits = findAll(ctx.root, { ...e.focused }).filter((n) => hasState(n, 'focused') || hasState(n, 'active'));
    return hits.length ? { ok: true, detail: 'focused' } : { ok: false, detail: 'element is not focused' };
  }
  return { ok: false, detail: 'unknown expectation' };
}

export function evalAll(checks: Expect[], ctx: ExpectContext): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const c of checks) {
    const r = evalExpect(c, ctx);
    if (!r.ok) failures.push(`${Object.keys(c)[0]}: ${r.detail}`);
  }
  return { ok: failures.length === 0, failures };
}
