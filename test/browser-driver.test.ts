/** WS5 driver tests against the local test site (real headless Chromium). Every browser is closed in `finally`. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { childProcesses } from '../src/core/util/procs.js';
import { startSiteServer } from '../evals/browser/serve.mjs';
import { PlaywrightBrowserDriver } from '../src/core/automation/browser/driver.js';
import { BrowserSession } from '../src/core/automation/browser/session.js';
import { estimateTokens } from '../src/core/util/text.js';
import { walk, isInteractive } from '../src/core/automation/snapshot/tree.js';
import { decodePng } from '../src/core/automation/perception/png.js';
import { testConfig, tmpWorkspace } from './helpers.js';

let site: { url: string; close: () => Promise<void> };
before(async () => {
  site = await startSiteServer();
});
after(async () => {
  await site.close();
});

const refOf = (tree: string, re: RegExp): string => {
  const line = tree.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  assert.ok(line, `no line matching ${re} in:\n${tree}`);
  return line!.match(/\[ref=([\w]+)\]/)![1];
};

function session(over: any = {}) {
  const ws = tmpWorkspace({ 'note.txt': 'hello upload\nsecond line\n' });
  const config = testConfig('http://127.0.0.1:9/v1', { web: { allowHosts: ['127.0.0.1'] }, browser: { enabled: true, record: false }, ...over });
  return { ws, s: new BrowserSession({ sessionId: `t-${Date.now()}-${Math.random()}`, workspace: ws, config }) };
}

for (const engine of ['aria', 'dom'] as const) {
  test(`E1 AC1 [${engine}]: open, snapshot with refs, click, type, select, read the result`, async () => {
    const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace(), engine });
    try {
      await d.open(`${site.url}form.html`);
      assert.equal(d.snapshotEngine, engine);
      const s = await d.snapshot();
      assert.match(s.tree!, /\[ref=e\d+\]/);
      assert.equal((await d.type('Ada Lovelace', { ref: refOf(s.tree!, /textbox "Full name"/) })).outcome, 'confirmed');
      assert.equal((await d.type('2', { ref: refOf(s.tree!, /spinbutton "Quantity"/) })).outcome, 'confirmed');
      const sel = await d.act(refOf(s.tree!, /combobox "Color"/), 'select', { value: 'Green' });
      assert.equal(sel.outcome, 'confirmed');
      assert.match(sel.diff!, /\+ combobox "Color" .*\[value="Green"\]/);
      await d.act(refOf(s.tree!, /radio "Express"/), 'check');
      await d.act(refOf(s.tree!, /checkbox "I accept the terms"/), 'check');
      const r = await d.act(refOf(s.tree!, /button "Place order"/), 'click', { expect: { text_present: 'Order confirmed' } });
      assert.equal(r.outcome, 'confirmed');
      assert.match(r.diff!, /Order confirmed: ORD-ADA-GREEN-2-EXPRESS/);
      const v = await d.verify([{ text_present: 'ORD-ADA-GREEN-2-EXPRESS' }]);
      assert.ok(v.ok);
      // A failed expectation is reported as verify_failed, not as success.
      const bad = await d.act(refOf(s.tree!, /button "Place order"/), 'click', { expect: { text_present: 'Payment accepted' } });
      assert.equal(bad.outcome, 'failed');
      assert.equal(bad.errorCode, 'verify_failed');
    } finally {
      await d.close();
    }
  });
}

test('E1 AC2: tabs, dialogs (accept and dismiss), download and upload', async () => {
  const { ws, s } = session();
  const d = s.driver;
  try {
    // ---- tabs
    await d.open(`${site.url}tabs.html`);
    let snap = await d.snapshot();
    const r = await d.act(refOf(snap.tree!, /link "Open details in a new tab"/), 'click');
    assert.ok(r.notes?.some((n) => /new tab opened and is now active: \[1\] "Details"/.test(n)), JSON.stringify(r.notes));
    assert.match((await d.snapshot()).tree!, /TAB-4471/);
    let tabs = await d.tabs('list');
    assert.equal(tabs.tabs.length, 2);
    tabs = await d.tabs('select', { index: 0 });
    assert.equal(tabs.tabs[0].active, true);
    await d.tabs('close', { index: 1 });
    assert.equal((await d.tabs('list')).tabs.length, 1);

    // ---- dialogs: never auto-accepted
    await d.navigate(`${site.url}dialogs.html`);
    snap = await d.snapshot();
    const conf = await d.act(refOf(snap.tree!, /button "Delete item B"/), 'click', { expect: { text_present: 'Item B' } });
    assert.equal(conf.outcome, 'partial');
    assert.match(conf.message!, /confirm dialog is open: "Delete item B\?"/);
    assert.equal((await d.act(refOf(snap.tree!, /button "Say hello"/), 'click')).outcome, 'refused', 'no other action while a dialog is open');
    const dismissed = await d.dialog('dismiss');
    assert.match(dismissed.diff!, /Delete cancelled/);
    snap = await d.snapshot();
    await d.act(refOf(snap.tree!, /button "Delete item B"/), 'click', { expect: { text_present: 'x' } });
    const accepted = await d.dialog('accept');
    assert.match(accepted.diff!, /Item B deleted/);
    assert.match(accepted.diff!, /- listitem: Item B|- text: Item B|Item B/);
    await d.act(refOf(snap.tree!, /button "Rename list"/), 'click');
    assert.match((await d.dialog('accept', 'Groceries')).diff!, /Renamed to Groceries/);
    await d.act(refOf(snap.tree!, /button "Say hello"/), 'click');
    assert.match((await d.dialog('accept')).diff!, /Alert closed/);

    // ---- downloads land in the workspace downloads dir
    await d.navigate(`${site.url}download.html`);
    snap = await d.snapshot();
    const dl = await d.download(refOf(snap.tree!, /link "Download report \(CSV\)"/));
    assert.equal(dl.outcome, 'confirmed', JSON.stringify(dl));
    const csv = path.join(ws, 'downloads', 'report.csv');
    assert.match(fs.readFileSync(csv, 'utf8'), /sprocket,12/);
    const blob = await d.download(refOf(snap.tree!, /button "Generate summary file"/));
    assert.equal(blob.outcome, 'confirmed');
    assert.equal(fs.readFileSync(path.join(ws, 'downloads', 'summary.txt'), 'utf8'), 'total items: 23\n');

    // ---- upload
    await d.navigate(`${site.url}upload.html`);
    snap = await d.snapshot();
    const up = await d.act(refOf(snap.tree!, /button "Attachment"|textbox "Attachment"|"Attachment"/), 'upload', { value: [path.join(ws, 'note.txt')] });
    assert.equal(up.outcome, 'confirmed', JSON.stringify(up));
    assert.match(up.diff!, /Uploaded: note\.txt \(25 bytes, first line: hello upload\)/);
  } finally {
    await s.dispose();
  }
});

test('E2 AC1: fixture pages (8, incl. the 300-row table) stay within the snapshot budget', async () => {
  const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace(), snapshotTokens: 5000 });
  try {
    for (const p of ['index.html', 'form.html', 'combobox.html', 'table.html', 'dialogs.html', 'checkout.html', 'article.html', 'login.html']) {
      await d.open(`${site.url}${p}`);
      const s = await d.snapshot();
      assert.ok(estimateTokens(s.tree!) <= 5000, `${p}: ${estimateTokens(s.tree!)} tokens`);
      if (p === 'table.html') {
        assert.match(s.tree!, /… 281 more rows \(use query or browser_extract\)/);
        const raw = await d.page.ariaSnapshot();
        assert.ok(estimateTokens(raw) > 5000, `the raw Playwright snapshot is ${estimateTokens(raw)} tokens; the budget matters`);
        const q = await d.snapshot({ query: 'Gizmo 153' });
        assert.match(q.tree!, /row[\s\S]*cell "Gizmo 153"[\s\S]*cell "Pune"/);
        const tight = await d.snapshot({ maxTokens: 300 });
        assert.equal(tight.truncated, true);
      }
    }
  } finally {
    await d.close();
  }
});

test('E2 AC3: the diff after a click shows only the changed lines', async () => {
  const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace() });
  try {
    await d.open(`${site.url}form.html`);
    const s = await d.snapshot();
    const ref = refOf(s.tree!, /checkbox "I accept the terms"/);
    const r = await d.act(ref, 'click');
    assert.deepEqual(r.diff!.split('\n'), [`- checkbox "I accept the terms" [ref=${ref}]`, `+ checkbox "I accept the terms" [ref=${ref}] [checked]`]);
  } finally {
    await d.close();
  }
});

for (const engine of ['aria', 'dom'] as const) {
  test(`E2 AC4 [${engine}]: a stale ref with a unique key is rebound; an ambiguous one is refused`, async () => {
    const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace(), engine });
    try {
      await d.open(`${site.url}rerender.html`);
      let s = await d.snapshot();
      const edit = refOf(s.tree!, /button "Edit"/);
      await d.act(refOf(s.tree!, /button "Refresh list"/), 'click');
      assert.ok(!d.latest!.tree!.includes(`[ref=${edit}]`), 'the old Edit element was replaced');
      const r = await d.act(edit, 'click');
      assert.equal(r.rebound, true);
      assert.equal(r.outcome, 'confirmed');
      assert.match(r.diff!, /1 edits/);
      s = await d.snapshot();
      const edit2 = refOf(s.tree!, /button "Edit"/);
      await d.act(refOf(s.tree!, /button "Duplicate rows"/), 'click');
      const amb = await d.act(edit2, 'click');
      assert.equal(amb.outcome, 'refused');
      assert.equal(amb.errorCode, 'stale_ref');
      assert.match(amb.message!, /2 elements now match button "Edit"/);
      assert.equal((await d.act('e999', 'click')).errorCode, 'ref_not_found');
    } finally {
      await d.close();
    }
  });
}

test('E2 AC5: password fields render ••• (the raw aria snapshot would leak them)', async () => {
  const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace() });
  try {
    await d.open(`${site.url}login.html`);
    const s = await d.snapshot();
    const r = await d.type('hunter2-very-secret', { ref: refOf(s.tree!, /textbox "Password"/) });
    assert.ok(!JSON.stringify(r).includes('hunter2'));
    const after = await d.snapshot();
    assert.match(after.tree!, /textbox "Password" \[ref=\w+\] \[password\] \[value=•••\]/);
    assert.ok(!after.tree!.includes('hunter2') && !JSON.stringify(after.root).includes('hunter2'));
    assert.ok((await d.page.ariaSnapshot({ mode: 'ai' })).includes('hunter2'), 'Playwright itself exposes the value');
  } finally {
    await d.close();
  }
});

test('E4 AC1: a clickable wrapper containing an SVG button gets one mark, not two', async () => {
  const d = new PlaywrightBrowserDriver({ homeDir: tmpWorkspace() });
  try {
    await d.open(`${site.url}marks.html`);
    const shot = await d.screenshot({ marks: true });
    const raw: string[] = [];
    walk(d.latest!.root, (n) => void (n.ref && n.box && isInteractive(n) && n.name === 'Draw' && raw.push(n.ref)));
    assert.equal(raw.length, 2, 'two clickable nodes for the Draw control');
    const draw = shot.marks!.filter((m) => m.name === 'Draw');
    assert.equal(draw.length, 1);
    assert.equal(draw[0].role, 'generic', 'the outermost actionable element is kept');
    assert.deepEqual(shot.marks!.map((m) => m.name ?? m.role), ['Draw', 'link', 'Save']);
    const img = decodePng(shot.png);
    assert.equal(img.width, 1280);
  } finally {
    await d.close();
  }
});

test('security: every browser request passes the SSRF guard; localhost only via web.allowHosts', async () => {
  const blocked = session({ web: { allowHosts: [] } });
  try {
    const nav = await blocked.s.driver.open(`${site.url}form.html`);
    assert.match(nav.blocked ?? '', /SSRF guard/);
  } finally {
    await blocked.s.dispose();
  }
  const { s } = session();
  try {
    await s.driver.open(`${site.url}form.html`);
    // A redirect from an allowed host to the cloud metadata address is stopped in the browser.
    const nav = await s.driver.navigate(`${site.url}__redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
    assert.match(nav.blocked ?? '', /169\.254\.169\.254.*(private|SSRF)/);
    assert.equal(await s.driver.page.title(), 'Blocked by Tugline', 'the tab shows the egress guard page, not the metadata service');
    // Subresources are guarded too: an <img> pointing at a private address never leaves the browser.
    await s.driver.navigate(`${site.url}form.html`);
    await s.driver.page.evaluate("document.body.insertAdjacentHTML('beforeend', '<img src=\"http://10.255.255.1:8080/x.png\">')");
    await s.driver.page.waitForTimeout(500);
    const snap = await s.driver.snapshot();
    const r = await s.driver.act(refOf(snap.tree!, /checkbox/), 'check');
    assert.ok(r.notes?.some((n) => /egress guard: .*10\.255\.255\.1:8080/.test(n)), JSON.stringify(r.notes));
    const file = await s.driver.navigate('file:///etc/passwd').catch((e: Error) => ({ blocked: e.message }));
    assert.match((file as any).blocked, /only http\(s\)/);
  } finally {
    await s.dispose();
  }
});

test('no browser processes leak from this test file (driver)', () => {
  const out = childProcesses(process.pid).map((p) => `${p.pid} ${p.args}`).join('\n');
  assert.ok(!/chrom|headless/i.test(out), out);
});

test('security: launched Chromium gets the WebRTC flags that stop UDP bypassing the egress proxy', async () => {
  const { LAUNCH_ARGS } = await import('../src/core/automation/browser/launch.js');
  assert.ok(LAUNCH_ARGS.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(LAUNCH_ARGS.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));
  const { s } = session();
  try {
    await s.driver.open(`${site.url}index.html`);
    const ps = childProcesses(process.pid).map((p) => p.args).join('\n');
    const chrome = ps.split('\n').find((l) => /chrom|headless/i.test(l)) ?? '';
    assert.match(chrome, /--force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
    assert.match(chrome, /--webrtc-ip-handling-policy=disable_non_proxied_udp/);
    assert.match(chrome, /--proxy-server=/, 'and it runs behind the egress proxy');
  } finally {
    await s.dispose();
  }
});
