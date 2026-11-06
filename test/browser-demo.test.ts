/**
 * N32 (v1.1): learn a skill from a human demonstration. A "human" (Playwright
 * driving the recorder's own page with real mouse and keyboard input) signs in
 * on the test site; the recorder turns it into a masked, parameterised
 * trajectory, a SKILL.md and an L2a recipe, verifies the recipe by strict
 * replay, and saves only after review. Every browser is closed.
 */
import { childProcesses, isZombie } from '../src/core/util/procs.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startSiteServer } from '../evals/browser/serve.mjs';
import { Agent } from '../src/core/agent/agent.js';
import { BrowserSession, closeAllBrowserSessions } from '../src/core/automation/browser/session.js';
import { generalise, recordSkill, safePhrase, type DemoStep } from '../src/core/automation/recorder/demo.js';
import { readTrajectory } from '../src/core/automation/recorder/trajectory.js';
import { replayTrajectory } from '../src/core/automation/recorder/replay.js';
import { SecretVault } from '../src/core/secrets/vault.js';
import { getCliCommand } from '../src/core/commands.js';
import '../src/core/automation/browser/index.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const SECRET = 'correct-horse-battery-9';
const USER = 'quentin-demo-user';
let site: { url: string; close: () => Promise<void> };

before(async () => {
  site = await startSiteServer();
});
after(async () => {
  await closeAllBrowserSessions();
  await site.close();
});

const cfgFor = (over: any = {}) => testConfig('http://127.0.0.1:9/v1', { permissionMode: 'yolo', web: { searchProvider: 'none', allowHosts: ['127.0.0.1'] }, browser: { enabled: true }, ...over });

/** The human: real clicks and keystrokes in the recorder's page, plus a synthetic click a page script makes. */
async function signInByHand(page: any, rec: any): Promise<void> {
  await page.click('#user');
  await page.keyboard.type(USER);
  await page.click('#pass');
  await page.keyboard.type(SECRET);
  await rec.idle();
  // A page script clicking for itself (isTrusted=false) is not a human step.
  await page.evaluate(() => (document.getElementById('apikey') as HTMLInputElement).focus());
  await page.evaluate(() => document.querySelector('h1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.click('#signin');
  await page.waitForFunction(() => /Welcome/.test(document.getElementById('msg')!.textContent ?? ''));
  await rec.idle();
}

function filesUnder(dir: string, skip: RegExp = /$^/): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    let es: fs.Dirent[] = [];
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (skip.test(p)) continue;
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  rec(dir);
  return out;
}

test('N32 AC1+AC2+AC3: a demonstrated sign-in becomes a masked trajectory, a SKILL.md and a recipe that replays strictly; typed secrets are never stored', async () => {
  const cfg = cfgFor();
  const ws = tmpWorkspace();
  new SecretVault(cfg.homeDir, {}).set('sign-in/password', SECRET);
  let reviewed = '';
  const r = await recordSkill({
    name: 'sign-in',
    url: `${site.url}login.html`,
    config: cfg,
    workspace: ws,
    headed: false,
    demonstrate: signInByHand,
    review: async (text) => ((reviewed = text), true),
  });
  // Review before saving: the steps and the verification result, never the values.
  assert.match(reviewed, /Type the secret `secret:\/\/sign-in\/password` into textbox "Password"/);
  assert.match(reviewed, /Verification \(strict replay, no model\): PASS, 5 steps/);
  assert.ok(!reviewed.includes(SECRET) && !reviewed.includes(USER), reviewed);

  // AC1: a 5-step trajectory with semantic keys and a masked password.
  const { steps, meta } = readTrajectory(r.saved!.trajectoryDir);
  assert.equal(meta?.surface, 'browser');
  assert.deepEqual(steps.map((s) => s.tool), ['browser_open', 'browser_type', 'browser_type', 'browser_act', 'browser_verify'], JSON.stringify(steps.map((s) => [s.tool, s.target?.name, s.args])));
  for (const s of steps.slice(1, 4)) assert.ok(s.target?.key && s.target.key.role && s.target.key.name, `semantic key on step ${s.seq}`);
  assert.deepEqual(steps.slice(1, 4).map((s) => `${s.target!.key!.role}|${s.target!.key!.name}|${s.target!.key!.landmark}`), ['textbox|Username|form:Sign in', 'textbox|Password|form:Sign in', 'button|Sign in|form:Sign in']);
  assert.deepEqual(steps[1].args, { text: '{{username}}', clear: true });
  assert.deepEqual(steps[2].args, { secret: 'secret://sign-in/password', clear: true }, 'the password is a secret ref, masked at capture');
  assert.deepEqual(steps[4].args, { checks: [{ text_present: 'Welcome' }] }, 'postcondition, without the typed name');

  // The SKILL.md: inputs, the fast path, steps and verification; editable markdown with frontmatter.
  const md = fs.readFileSync(r.saved!.skillFile, 'utf8');
  assert.match(md, /^---\nname: sign-in\ndescription: Use when the user asks to sign in on 127\.0\.0\.1:\d+\./);
  assert.match(md, /\| `username` \| textbox "Username" \| text \| \(ask the user\) \|/);
  assert.match(md, /- `secret:\/\/sign-in\/password`/);
  assert.match(md, /Call `browser_task` with `goal: "sign-in"`/);
  assert.match(md, /## Verification\n\n- the page shows "Welcome"/);
  assert.equal(r.saved!.skillFile, path.join(ws, '.tugline', 'skills', 'sign-in', 'SKILL.md'));

  // AC2: the recipe replays strictly (no model) on the site, with a new value for the parameter.
  const recipe = JSON.parse(fs.readFileSync(r.saved!.recipeFile!, 'utf8'));
  assert.deepEqual(recipe.params, [{ name: 'username', label: 'textbox "Username"', kind: 'text' }]);
  assert.deepEqual(recipe.secrets, ['secret://sign-in/password']);
  const s = new BrowserSession({ sessionId: `n32-replay-${Date.now()}`, workspace: ws, config: { ...cfg, browser: { ...cfg.browser, record: false } } as any });
  try {
    const rr = await replayTrajectory(s.driver, recipe.steps, { mode: 'strict', guard: s.replayGuard, params: { username: 'grace' } });
    assert.equal(rr.ok, true, rr.failure);
    assert.match((await s.driver.extract('text')).content, /Welcome, grace/);
    const missing = await replayTrajectory(s.driver, recipe.steps, { mode: 'strict', guard: s.replayGuard });
    assert.match(missing.failure ?? '', /missing parameter username/);
  } finally {
    await s.dispose();
  }
  // AC2 through the agent: browser_task finds the learned recipe (L2a) and fills the parameter; no model step.
  let modelCalls = 0;
  const srv = await startMockServer((_b, i) => {
    modelCalls++;
    return i === 0 ? { toolCalls: [{ name: 'browser_task', arguments: { goal: 'sign-in', url: `${site.url}login.html`, params: { username: 'ada' } } }] } : { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: { ...testConfig(srv.url, {}), homeDir: cfg.homeDir, permissionMode: 'yolo', web: cfg.web, browser: cfg.browser } as any, mcp: false });
  try {
    await agent.run('sign in as ada');
    const out = lastToolResult(srv.requests[1]);
    assert.match(out, /path: L2a · outcome: confirmed/);
    assert.match(out, /Ran recipe "sign-in"/);
    assert.match(out, /Welcome, ada/);
    assert.equal(modelCalls, 2, 'the main loop only: the recipe itself used no model');
  } finally {
    await agent.dispose();
    await srv.close();
  }

  // AC3: the typed secret is in no file the harness wrote (workspace, home: skills, recipes, runs, journals),
  // and the typed username is not stored either (it is a parameter). The browser's own profile is excluded.
  const files = [...filesUnder(ws), ...filesUnder(cfg.homeDir, /browser-profiles|secrets\.json$/)];
  assert.ok(files.length >= 4, files.join('\n'));
  for (const f of files) {
    const body = fs.readFileSync(f);
    assert.ok(!body.includes(SECRET), `the secret leaked into ${f}`);
    if (!/sessions|journal/.test(f)) assert.ok(!body.includes(USER), `the typed username leaked into ${f}`);
  }
  // The demonstration's browser profile (persistent:demo) does not hold the password either.
  for (const f of filesUnder(path.join(cfg.homeDir, 'browser-profiles'))) assert.ok(!fs.readFileSync(f).includes(SECRET), `the browser profile stored the password in ${f}`);
});

test('N32 (unit): fields are masked by type, autocomplete and name words, including tokens, API keys, PINs and secrets', async () => {
  const { SECRET_KIND_SRC } = await import('../src/core/automation/recorder/demo.js');
  const kind = new Function(`return ${SECRET_KIND_SRC}`)() as (el: any) => string | undefined;
  const el = (o: { type?: string; name?: string; id?: string; attrs?: Record<string, string> }) => ({ type: o.type ?? 'text', name: o.name ?? '', id: o.id ?? '', getAttribute: (k: string) => o.attrs?.[k] ?? null });
  const masked: Array<[any, string]> = [
    [el({ type: 'password' }), 'password'],
    [el({ attrs: { autocomplete: 'one-time-code' } }), 'otp'],
    [el({ name: 'cardNumber' }), 'card'],
    [el({ name: 'api_token' }), 'secret'],
    [el({ name: 'apiKey' }), 'secret'],
    [el({ id: 'pin' }), 'secret'],
    [el({ name: 'client-secret' }), 'secret'],
    [el({ attrs: { 'aria-label': 'Access key' } }), 'secret'],
    [el({ attrs: { placeholder: 'Personal access token' } }), 'secret'],
    [el({ name: 'ssn' }), 'secret'],
    [el({ name: 'verification_code' }), 'otp'],
    [el({ name: 'tokens' }), 'secret'],
    [el({ name: 'bearer' }), 'secret'],
    [el({ id: 'credential' }), 'secret'],
    [{ ...el({ id: 'f1' }), labels: [{ textContent: 'Personal access token' }] }, 'secret'],
  ];
  for (const [e, k] of masked) assert.equal(kind(e), k, JSON.stringify(e));
  for (const n of ['username', 'email', 'spinner', 'shipping_address', 'search', 'opinion', 'tokenise_choice']) assert.equal(kind(el({ name: n })), undefined, n);
});

test('N32: declining the review saves nothing', async () => {
  const cfg = cfgFor();
  const ws = tmpWorkspace();
  const r = await recordSkill({ name: 'sign-in-2', url: `${site.url}login.html`, config: cfg, workspace: ws, headed: false, profile: 'isolated', verify: false, demonstrate: signInByHand, review: async () => false });
  assert.equal(r.saved, undefined);
  assert.equal(fs.existsSync(path.join(ws, '.tugline', 'skills')), false);
  assert.equal(fs.existsSync(path.join(cfg.homeDir, 'recipes', 'sign-in-2.recipe.json')), false);
});

test('N32 (unit): generalising a recorded agent or desktop trajectory parameterises typed text and keeps secrets as refs', async () => {
  const k = (role: string, name: string) => ({ role, name, key: { role, name, nth: 0, count: 1, landmark: '' } });
  const desktop: DemoStep[] = [
    { seq: 1, ts: '', tool: 'desktop_act', args: { action: 'press' }, target: k('button', 'New invoice') },
    { seq: 2, ts: '', tool: 'desktop_type', args: { text: 'ACME Ltd' }, target: k('textbox', 'Customer'), diff: '+ textbox "Customer" ACME Ltd' },
    { seq: 3, ts: '', tool: 'desktop_type', args: { secret: 'secret://erp/pin' }, target: k('textbox', 'PIN') },
    { seq: 4, ts: '', tool: 'desktop_act', args: { action: 'press' }, target: k('button', 'Save'), expect: { text_present: 'Saved' } },
  ];
  const d = generalise('new-invoice', desktop);
  assert.equal(d.surface, 'desktop');
  assert.deepEqual(d.params.map((p) => p.name), ['customer']);
  assert.deepEqual(d.secrets, ['secret://erp/pin']);
  assert.equal(d.demoValues.customer, 'ACME Ltd');
  assert.ok(!d.skillMd.includes('ACME') && !JSON.stringify(d.recipe).includes('ACME'), 'the typed value is not in the draft');
  assert.match(d.skillMd, /`desktop_type` on textbox "Customer" with `\{\{customer\}\}`/);
  assert.doesNotMatch(d.skillMd, /Fast path/, 'no browser recipe for a desktop skill');
  // Final checks never keep words derived from what was typed.
  assert.equal(safePhrase('Order confirmed: ORD-GRACE-BLUE-1', ['Grace Hopper']), 'Order confirmed');
  assert.equal(safePhrase('Welcome, quentin', ['quentin']), 'Welcome');
  assert.equal(safePhrase('Thanks Grace, see you', ['Grace']), 'Thanks');
});

test('N32: `tug record-skill --from` generalises a recorded browser run and saves after --yes', async () => {
  const cfg = cfgFor();
  const ws = tmpWorkspace();
  // A recorded agent run (literal text) on the order form.
  const s = new BrowserSession({ sessionId: 'n32-src', workspace: ws, config: cfg });
  try {
    await s.driver.open(`${site.url}form.html`);
    const snap = await s.driver.snapshot();
    const ref = (re: RegExp) => snap.tree.split('\n').find((l) => re.test(l))!.match(/\[ref=(\w+)\]/)![1];
    const t = await s.driver.type('Grace Hopper', { ref: ref(/textbox "Full name"/) });
    s.record('browser_open', { url: `${site.url}form.html` }, { outcome: 'confirmed', path: 'L2b' }, { url: `${site.url}form.html` });
    s.record('browser_type', { ref: 'x', text: 'Grace Hopper' }, { ...t, path: 'L2b' }, { url: `${site.url}form.html` });
    const c = await s.driver.act(ref(/checkbox "I accept the terms"/), 'check');
    s.record('browser_act', { ref: 'y', action: 'check' }, { ...c, path: 'L2b' }, { url: `${site.url}form.html` });
    s.recorder!.flushMeta();
  } finally {
    await s.dispose();
  }
  const runDir = path.join(ws, '.tugline', 'runs', 'n32-src');
  const out: string[] = [];
  const code = await getCliCommand('record-skill')!.run(['order-form', '--from', runDir, '--yes'], { config: cfg, workspace: ws, write: (x) => void out.push(x) });
  const text = out.join('');
  assert.equal(code, 0, text);
  assert.match(text, /Verification \(strict replay, no model\): PASS/);
  const md = fs.readFileSync(path.join(ws, '.tugline', 'skills', 'order-form', 'SKILL.md'), 'utf8');
  assert.match(md, /Type `\{\{full_name\}\}` into textbox "Full name"/);
  assert.ok(!md.includes('Grace') && !fs.readFileSync(path.join(cfg.homeDir, 'recipes', 'order-form.recipe.json'), 'utf8').includes('Grace'));
});

test('no browser processes leak from this test file (demo)', async () => {
  await closeAllBrowserSessions();
  const out = childProcesses(process.pid).filter((p) => !isZombie(p)).map((p) => `${p.pid} ${p.args}`).join('\n');
  assert.doesNotMatch(out, /chrom(e|ium)/i, out);
});
