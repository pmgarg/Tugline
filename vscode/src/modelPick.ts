/**
 * Model picker, per-mode model and effort (SPEC B8). Pure: works on the
 * HarnessConfig object the chat's Agent was created with, then the caller
 * runs `agent.setProfile(name)` so the next request uses it (overlays and the
 * cached probe are re-applied by the agent).
 *
 * - choice `profile:<name>` switches to a configured profile;
 * - choice `model:<id>` keeps the endpoint and changes the model id;
 * - effort maps through the core overlay table (`reasoningBody`):
 *   reasoning_effort / chat_template_kwargs.enable_thinking / thinking;
 * - plan profile: routed as `routing.planner`, which the core uses for the main
 *   loop while the permission mode is `plan` (D10).
 */
import type { HarnessConfig } from '../../src/core/config.js';
import { reasoningBody, selectOverlay, type ReasoningEffort } from '../../src/core/llm/overlays.js';

export type Effort = 'default' | ReasoningEffort;

export interface ModelSelection {
  /** 'profile:<name>' | 'model:<id>' | undefined (settings default) */
  choice?: string;
  effort?: Effort;
}

/** Keys that effort may add to extraBody (removed again when effort goes back to default). */
const EFFORT_KEYS = ['reasoning_effort', 'chat_template_kwargs', 'thinking'];

/**
 * Apply a selection to `cfg` (mutates `cfg.profiles[name]` and `cfg.profile`).
 * `originals` are the profiles as configured (never mutated), so switching back
 * to "default" effort restores the profile's own request body. Returns the
 * profile name the agent must switch to.
 */
export function applySelection(cfg: HarnessConfig, originals: HarnessConfig['profiles'], baseName: string, sel: ModelSelection): string {
  let name = baseName;
  if (sel.choice?.startsWith('profile:')) {
    name = sel.choice.slice(8);
    if (!originals[name]) throw new Error(`unknown profile "${name}"`);
  }
  const p = { ...originals[name] };
  if (sel.choice?.startsWith('model:')) p.model = sel.choice.slice(6);
  if (sel.effort && sel.effort !== 'default') {
    const extra: Record<string, unknown> = { ...(p.extraBody ?? {}) };
    for (const k of EFFORT_KEYS) delete extra[k];
    p.extraBody = { ...extra, ...reasoningBody(selectOverlay(p.model ?? ''), sel.effort) };
  }
  // C4: a managed lockedProfile cannot be escaped through the picker.
  const lp = (cfg as any).managed?.policy?.lockedProfile;
  if (lp) {
    const { name: _n, ...locked } = lp;
    Object.assign(p, locked);
  }
  cfg.profiles[name] = p;
  cfg.profile = name;
  return name;
}

/** Route plan mode to the plan profile when it exists (core D10 routing.planner). */
export function applyPlanProfile(cfg: HarnessConfig, planProfile: string | undefined): void {
  const routing = { ...((cfg as any).routing ?? {}) };
  if (planProfile && cfg.profiles[planProfile]) routing.planner = planProfile;
  else if (planProfile) delete routing.planner;
  (cfg as any).routing = routing;
}

export interface PickerItem {
  value: string;
  label: string;
  group: 'profiles' | 'models';
}

/** Dropdown entries: configured profiles, then the endpoint's /models list. */
export function pickerItems(cfg: HarnessConfig, endpointModels: string[], current?: string, favorites: string[] = []): PickerItem[] {
  const items: PickerItem[] = [];
  for (const [n, p] of Object.entries(cfg.profiles)) items.push({ value: `profile:${n}`, label: `${n}${p?.model ? ` (${p.model})` : ''}`, group: 'profiles' });
  for (const m of endpointModels) items.push({ value: `model:${m}`, label: m, group: 'models' });
  if (current && !items.some((i) => i.value === current)) items.push({ value: current, label: current.replace(/^\w+:/, ''), group: current.startsWith('profile:') ? 'profiles' : 'models' });
  // v1.2 N45 (Cline favourite models): starred entries first, in the order the user starred them
  if (favorites.length) {
    const rank = (i: PickerItem) => {
      const k = favorites.indexOf(i.value);
      return k < 0 ? favorites.length : k;
    };
    return items.map((i) => (favorites.includes(i.value) ? { ...i, label: `★ ${i.label}` } : i)).sort((a, b) => rank(a) - rank(b));
  }
  return items;
}
