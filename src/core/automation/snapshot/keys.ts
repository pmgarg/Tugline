/**
 * Semantic keys (SPEC E2, research CU §5.3.4): `role | name | nth | landmark`.
 *
 * Refs are snapshot-scoped tokens. A key survives re-renders, so a stale ref
 * can be rebound to the same element in a new snapshot — but only when that
 * is unambiguous (exactly one candidate). Recordings store keys, not refs, so
 * strict replay needs no model.
 */
import type { UiNode } from '../types.js';
import { LANDMARK_ROLES, walk } from './tree.js';

export interface SemanticKey {
  role: string;
  name: string;
  /** Index among nodes with the same role+name+landmark, in document order. */
  nth: number;
  /** How many such nodes existed when the key was taken. */
  count: number;
  /** Nearest landmark/dialog ancestor: "dialog:Confirm" or "" */
  landmark: string;
}

export function keyToString(k: SemanticKey): string {
  return `${k.role}|${k.name}|${k.nth}|${k.landmark}`;
}

function landmarkOf(ancestors: UiNode[]): string {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (LANDMARK_ROLES.has(a.role)) return `${a.role}:${a.name ?? ''}`;
  }
  return '';
}

interface Entry {
  node: UiNode;
  role: string;
  name: string;
  landmark: string;
}

function entries(root: UiNode): Entry[] {
  const out: Entry[] = [];
  walk(root, (n, anc) => {
    if (n.ref) out.push({ node: n, role: n.role, name: n.name ?? '', landmark: landmarkOf(anc) });
  });
  return out;
}

export function semanticKey(root: UiNode, ref: string): SemanticKey | undefined {
  const all = entries(root);
  const me = all.find((e) => e.node.ref === ref);
  if (!me) return undefined;
  const same = all.filter((e) => e.role === me.role && e.name === me.name && e.landmark === me.landmark);
  return { role: me.role, name: me.name, landmark: me.landmark, nth: same.indexOf(me), count: same.length };
}

export function candidatesForKey(root: UiNode, key: Pick<SemanticKey, 'role' | 'name' | 'landmark'>): UiNode[] {
  return entries(root)
    .filter((e) => e.role === key.role && e.name === key.name && e.landmark === key.landmark)
    .map((e) => e.node);
}

export type Rebind = { ok: true; node: UiNode; via: 'unique' | 'nth' } | { ok: false; reason: 'missing' | 'ambiguous'; candidates: number };

/**
 * Find the node a key refers to in a fresh tree.
 * - live rebinding (`allowNth: false`): exactly one candidate, else refuse;
 * - replay (`allowNth: true`): also accept the recorded position when the
 *   number of identical candidates is unchanged since recording.
 */
export function resolveKey(root: UiNode, key: SemanticKey, opts: { allowNth?: boolean } = {}): Rebind {
  const c = candidatesForKey(root, key);
  if (c.length === 1) return { ok: true, node: c[0], via: 'unique' };
  if (!c.length) return { ok: false, reason: 'missing', candidates: 0 };
  if (opts.allowNth && c.length === key.count && key.nth < c.length) return { ok: true, node: c[key.nth], via: 'nth' };
  return { ok: false, reason: 'ambiguous', candidates: c.length };
}
