/**
 * Export a browser trajectory to a Playwright test (SPEC E7): role locators
 * from the semantic keys, plus `expect`s from the recorded post-conditions.
 * The spec runs with `npx playwright test`, and the same steps saved as a
 * recipe become the L2a deterministic layer next time.
 *
 * Secrets stay out of the file: a `secret://name` fill reads
 * `process.env.TUG_SECRET_<NAME>` at test time.
 */
import type { Expect } from '../types.js';
import { envNameFor, parseSecretRef } from '../../secrets/vault.js';
import { parseRegexLike } from '../expect/evaluate.js';
import type { TrajectoryStep } from './trajectory.js';

const js = (s: string) => JSON.stringify(s);

function textArg(s: string): string {
  const re = parseRegexLike(s);
  return re ? re.toString() : js(s);
}

function locator(step: TrajectoryStep): string | undefined {
  const t = step.target;
  if (!t) return undefined;
  const k = t.key;
  const role = k?.role ?? t.role;
  const name = k?.name ?? t.name;
  let loc = name ? `page.getByRole(${js(role)}, { name: ${js(name)}, exact: true })` : `page.getByRole(${js(role)})`;
  if (k && k.count > 1) loc += `.nth(${k.nth})`;
  return loc;
}

export function expectToPlaywright(e: Expect): string | undefined {
  if ('text_present' in e) return `await expect(page.getByText(${textArg(e.text_present)}).first()).toBeVisible();`;
  if ('text_absent' in e) return `await expect(page.getByText(${textArg(e.text_absent)})).toHaveCount(0);`;
  if ('url_matches' in e) return `await expect(page).toHaveURL(${parseRegexLike(e.url_matches)?.toString() ?? `new RegExp(${js(e.url_matches.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`});`;
  if ('title_matches' in e) return `await expect(page).toHaveTitle(${parseRegexLike(e.title_matches)?.toString() ?? `new RegExp(${js(e.title_matches.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`});`;
  if ('element_present' in e) {
    const q = e.element_present;
    const loc = q.role ? `page.getByRole(${js(q.role)}${q.name ? `, { name: ${textArg(String(q.name))} }` : ''})` : `page.getByText(${textArg(String(q.name ?? ''))})`;
    return `await expect(${loc}.first()).toBeVisible();`;
  }
  if ('element_absent' in e) {
    const q = e.element_absent;
    const loc = q.role ? `page.getByRole(${js(q.role)}${q.name ? `, { name: ${textArg(String(q.name))} }` : ''})` : `page.getByText(${textArg(String(q.name ?? ''))})`;
    return `await expect(${loc}).toHaveCount(0);`;
  }
  if ('value_equals' in e && e.value_equals.role) return `await expect(page.getByRole(${js(e.value_equals.role)}${e.value_equals.name ? `, { name: ${js(e.value_equals.name)} }` : ''})).toHaveValue(${textArg(e.value_equals.value)});`;
  return undefined;
}

export function exportPlaywrightSpec(steps: TrajectoryStep[], opts: { name?: string; goal?: string } = {}): string {
  const body: string[] = [];
  const live = steps.filter((s) => s.outcome !== 'refused' && s.outcome !== 'failed');
  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    const a = s.args as any;
    const next = live[i + 1];
    // Dialogs: register the answer before the action that opens them.
    if (next?.tool === 'browser_dialog') {
      const na = next.args as any;
      body.push(na.action === 'dismiss' ? `page.once('dialog', (d) => d.dismiss());` : `page.once('dialog', (d) => d.accept(${na.text !== undefined ? js(String(na.text)) : ''}));`);
    }
    const loc = locator(s);
    switch (s.tool) {
      case 'browser_open':
      case 'browser_navigate':
        if (['back', 'forward', 'reload'].includes(a.url)) body.push(`await page.${a.url === 'back' ? 'goBack' : a.url === 'forward' ? 'goForward' : 'reload'}();`);
        else body.push(`await page.goto(${js(String(a.url))});`);
        break;
      case 'browser_type': {
        const secret = a.secret ? parseSecretRef(String(a.secret)) : undefined;
        const value = secret ? `process.env.${envNameFor(secret)} ?? ''` : js(String(a.text ?? ''));
        if (loc) body.push(a.clear === false ? `await ${loc}.pressSequentially(${value});` : `await ${loc}.fill(${value});`);
        else body.push(`await page.keyboard.type(${value});`);
        if (a.submit) body.push(loc ? `await ${loc}.press('Enter');` : `await page.keyboard.press('Enter');`);
        break;
      }
      case 'browser_key':
        for (const k of String(a.keys).split(/\s+/).filter(Boolean)) body.push(`await page.keyboard.press(${js(k)});`);
        break;
      case 'browser_act': {
        if (!loc) break;
        const act = a.action ?? 'click';
        if (act === 'select') body.push(`await ${loc}.selectOption(${Array.isArray(a.value) ? `${JSON.stringify(a.value.map((v: string) => ({ label: v })))}` : `{ label: ${js(String(a.value))} }`});`);
        else if (act === 'upload') body.push(`await ${loc}.setInputFiles(${JSON.stringify(a.value)});`);
        else body.push(`await ${loc}.${act}();`);
        break;
      }
      case 'browser_download':
        if (loc) body.push(`{ const [download] = await Promise.all([page.waitForEvent('download'), ${loc}.click()]); expect(download.suggestedFilename()).toBeTruthy(); }`);
        break;
      case 'browser_point':
        body.push(`await page.mouse.click(${Number(a.x)}, ${Number(a.y)});`);
        break;
      case 'browser_verify':
        for (const c of (a.checks ?? []) as Expect[]) {
          const x = expectToPlaywright(c);
          if (x) body.push(x);
        }
        break;
      default:
        break;
    }
    if (s.expect) {
      const x = expectToPlaywright(s.expect);
      if (x) body.push(x);
    }
  }
  const title = opts.name ?? 'recorded flow';
  return `// Generated by Tugline from a recorded browser trajectory${opts.goal ? `\n// Goal: ${opts.goal.replace(/\n/g, ' ')}` : ''}
import { test, expect } from '@playwright/test';

test(${js(title)}, async ({ page }) => {
${body.map((l) => `  ${l}`).join('\n')}
});
`;
}
