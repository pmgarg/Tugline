/**
 * Unified accessibility tree helpers (SPEC E2). Surface-agnostic: the browser
 * converts Playwright's ariaSnapshotJSON (or the DOM-walk fallback) into
 * UiNode; WS6 desktop converts AX/UIA/AT-SPI trees into the same shape, so the
 * renderer, diff, semantic keys and Expect evaluator work on both.
 */
import type { UiNode } from '../types.js';

/** Roles a model acts on. Refs are always shown for these. */
export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'menu', 'menubar',
]);

/** Roles that anchor semantic keys and that a snapshot can be scoped to. */
export const LANDMARK_ROLES = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'search', 'form', 'dialog', 'alertdialog']);

/** Containers worth a ref so the model can scope a snapshot to them. */
export const SCOPE_ROLES = new Set([...LANDMARK_ROLES, 'table', 'grid', 'list', 'tabpanel', 'tree']);

/** Input-like roles whose text is a value, not content. */
export const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);

/** Structural wrappers that carry no meaning when unnamed: their children are hoisted. */
export const TRANSPARENT_ROLES = new Set(['generic', 'none', 'presentation', 'rowgroup', 'group', 'Section', 'LineBreak']);

const SKIP_KEYS = new Set(['role', 'name', 'text', 'children', 'ref', 'cursor', 'box', 'url', 'placeholder', 'props']);

/** Convert Playwright's ariaSnapshotJSON output (a node, or a list of nodes and text strings). */
export function fromAriaJson(json: unknown): UiNode {
  const conv = (n: unknown): UiNode | undefined => {
    if (typeof n === 'string') return n.trim() ? { role: 'text', name: n.trim() } : undefined;
    if (!n || typeof n !== 'object') return undefined;
    const o = n as Record<string, any>;
    const role = String(o.role ?? 'generic');
    const node: UiNode = { role };
    if (o.ref) node.ref = String(o.ref);
    if (typeof o.name === 'string' && o.name) node.name = o.name;
    const states: string[] = [];
    for (const [k, v] of Object.entries(o)) {
      if (SKIP_KEYS.has(k)) continue;
      if (v === true) states.push(k);
      else if (v === false) {
        if (k === 'expanded') states.push('expanded=false');
      } else if (typeof v === 'string' || typeof v === 'number') states.push(`${k}=${v}`);
    }
    if (o.cursor === 'pointer') states.push('clickable');
    if (states.length) node.states = states;
    if (o.box && typeof o.box === 'object') node.box = { x: Number(o.box.x), y: Number(o.box.y), width: Number(o.box.width), height: Number(o.box.height) };
    if (typeof o.url === 'string') node.url = o.url;
    if (typeof o.placeholder === 'string') node.placeholder = o.placeholder;
    const kids: UiNode[] = [];
    if (typeof o.text === 'string' && o.text.trim()) {
      if (VALUE_ROLES.has(role)) node.value = o.text;
      else if (!node.name || node.name !== o.text.trim()) kids.push({ role: 'text', name: o.text.trim() });
    }
    for (const c of Array.isArray(o.children) ? o.children : []) {
      const k = conv(c);
      if (k) kids.push(k);
    }
    // A native <select> reports its options; surface the selected one as the value.
    if (role === 'combobox' && node.value === undefined) {
      const sel = kids.find((k) => k.role === 'option' && k.states?.includes('selected'));
      if (sel?.name) node.value = sel.name;
    }
    if (kids.length) node.children = kids;
    return node;
  };
  if (Array.isArray(json)) {
    const children = json.map(conv).filter((x): x is UiNode => !!x);
    return children.length === 1 && children[0].role === 'document' ? children[0] : { role: 'document', children };
  }
  return conv(json) ?? { role: 'document' };
}

export function walk(root: UiNode, fn: (n: UiNode, ancestors: UiNode[]) => void | false): void {
  const rec = (n: UiNode, anc: UiNode[]) => {
    if (fn(n, anc) === false) return;
    const next = [...anc, n];
    for (const c of n.children ?? []) rec(c, next);
  };
  rec(root, []);
}

export function findRef(root: UiNode, ref: string): { node: UiNode; ancestors: UiNode[] } | undefined {
  let hit: { node: UiNode; ancestors: UiNode[] } | undefined;
  walk(root, (n, anc) => {
    if (hit) return false;
    if (n.ref === ref) {
      hit = { node: n, ancestors: anc };
      return false;
    }
  });
  return hit;
}

export function refMap(root: UiNode): Map<string, UiNode> {
  const m = new Map<string, UiNode>();
  walk(root, (n) => void (n.ref && m.set(n.ref, n)));
  return m;
}

export function countRefs(root: UiNode): number {
  let n = 0;
  walk(root, (x) => void (x.ref && n++));
  return n;
}

/** All visible text in the tree (names, values, text nodes), for text_present checks and L0 detectors. */
export function treeText(root: UiNode): string {
  const parts: string[] = [];
  walk(root, (n) => {
    if (n.name) parts.push(n.name);
    if (n.value) parts.push(n.value);
  });
  return parts.join('\n');
}

export function isInteractive(n: UiNode): boolean {
  return INTERACTIVE_ROLES.has(n.role) || !!n.states?.includes('clickable');
}

export function hasState(n: UiNode, s: string): boolean {
  return !!n.states?.some((x) => x === s || x.startsWith(`${s}=`) && x !== `${s}=false`);
}

/** Deep-ish clone that drops handles (safe to serialise into recordings). */
export function cloneTree(n: UiNode): UiNode {
  const { handle: _h, children, ...rest } = n;
  return { ...rest, ...(children ? { children: children.map(cloneTree) } : {}) };
}
