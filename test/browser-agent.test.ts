/**
 * WS5 end-to-end tests through the agent loop with the mock OpenAI server
 * (text-only unless stated). Real headless Chromium against the local test
 * site; every agent is disposed (which closes its browser).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { childProcesses } from '../src/core/util/procs.js';
import { startSiteServer, SITE_DIR } from '../evals/browser/serve.mjs';
import { Agent } from '../src/core/agent/agent.js';
import type { AgentEvent } from '../src/core/types.js';
import { closeAllBrowserSessions, peekBrowserSession } from '../src/core/automation/browser/session.js';
import { startDebugChrome, installedChromiums } from '../src/core/automation/browser/launch.js';
import { pageFn as pageFnSrc } from '../src/core/automation/browser/pageScripts.js';
import { readTrajectory } from '../src/core/automation/recorder/trajectory.js';
import { replayRun } from '../src/core/automation/recorder/cli.js';
import { replayTrajectory, llmHealer } from '../src/core/automation/recorder/replay.js';
import { exportPlaywrightSpec } from '../src/core/automation/recorder/export.js';
import { BrowserSession } from '../src/core/automation/browser/session.js';
import { LLMClient } from '../src/core/llm/client.js';
import { SecretVault } from '../src/core/secrets/vault.js';
import { getCliCommand } from '../src/core/commands.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult, type Script } from './helpers.js';

let site: { url: string; close: () => Promise<void> };
before(async () => {
  site = await startSiteServer();
});
after(async () => {
  await closeAllBrowserSessions();
  await site.close();
});

const BROWSER = (over: any = {}) => ({ permissionMode: 'yolo', web: { searchProvider: 'none', fetchMaxChars: 40000, allowHosts: ['127.0.0.1'] }, browser: { enabled: true, ...over } });

function refIn(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  if (!line) throw new Error(`no ${re} in:\n${text}`);
  return line.match(/\[ref=(\w+)\]/)![1];
}

function allText(body: any): string {
  return (body.messages as any[]).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
}

const isMain = (body: any) => Array.isArray(body.tools) && body.tools.length > 0;

async function runAgent(script: Script, over: any = {}, opts: { ui?: any; vision?: boolean; ws?: string; sessionId?: string } = {}) {
  const srv = await startMockServer(script);
  const ws = opts.ws ?? tmpWorkspace({ 'note.txt': 'hello\n' });
  const cfg = testConfig(srv.url, { ...BROWSER(), ...over, ...(opts.vision ? { profiles: { default: { baseUrl: srv.url, model: 'mock-vl', apiKey: 'sk-test-1234567890abcdef', contextWindow: 32768, maxOutputTokens: 1024, toolMode: 'native', vision: true } } } : {}) });
  const events: AgentEvent[] = [];
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, sessionId: opts.sessionId, ui: { onEvent: (e: AgentEvent) => events.push(e), ...(opts.ui ?? {}) } });
  try {
    const res = await agent.run('do the browser task');
    return { res, srv, events, agent, ws, cfg, journal: agent.journalFile };
  } finally {
    await agent.dispose();
    await srv.close();
  }
}

// ------------------------------------------------------------ E1 AC3 + E3 AC4 + E7 AC1

let recorded: { ws: string; runDir: string; cfg: any } | undefined;

test('E1 AC3: a text-only model completes a form end to end through the agent loop (and E3 AC4: path per turn + stats printed)', async () => {
  const script: Script = (body, i) => {
    const last = lastToolResult(body);
    switch (i) {
      case 0:
        return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html` } }] };
      case 1:
        return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      case 2:
        return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Full name"/), text: 'Grace Hopper' } }, { name: 'browser_act', arguments: { ref: refIn(last, /checkbox "I accept the terms"/), action: 'check' } }] };
      case 3: {
        const snap = allText(body);
        return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(snap, /combobox "Color"/), action: 'select', value: 'Blue' } }] };
      }
      case 4:
        return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Place order"/), expect: { text_present: 'Order confirmed' } } }] };
      default: {
        const code = last.match(/ORD-[A-Z0-9-]+/)?.[0];
        return { content: `The order went through: ${code}` };
      }
    }
  };
  const { res, srv, events, ws } = await runAgent(script);
  assert.equal(res.stopReason, 'end_turn');
  assert.match(res.finalText, /ORD-GRACE-BLUE-1-STANDARD/);
  assert.ok(srv.requests[0].tools.some((t: any) => t.function.name === 'browser_snapshot'));
  // Text-only: no image ever sent; page content is wrapped as untrusted.
  assert.ok(srv.requests.every((b: any) => !JSON.stringify(b).includes('image_url')));
  const snapResult = lastToolResult(srv.requests[2]);
  assert.match(snapResult, /<untrusted_web_content source="http:\/\/127\.0\.0\.1:\d+\/form\.html">/);
  assert.match(lastToolResult(srv.requests[5]), /outcome: confirmed · path: L2b/);
  // E3 AC4: every recorded step carries its turn and path; the stats summary is printed at run end.
  const runDir = path.join(ws, '.tugline', 'runs');
  const dir = path.join(runDir, fs.readdirSync(runDir)[0]);
  const { steps, meta } = readTrajectory(dir);
  assert.ok(steps.length >= 6);
  assert.ok(steps.every((s) => s.path && s.turn !== undefined), JSON.stringify(steps.map((s) => [s.turn, s.path])));
  assert.deepEqual([...new Set(steps.map((s) => s.turn))].sort(), [1, 2, 3, 4, 5], 'turns recorded from the agent loop');
  assert.ok(meta?.pathStats?.L2b && meta.pathStats.L2b >= 6);
  const notice = events.find((e) => e.type === 'notice' && /browser path stats: L2b×\d+/.test(e.message));
  assert.ok(notice, 'stats summary printed');
  assert.ok(events.some((e) => e.type === 'automation' && e.surface === 'browser' && e.path === 'L2b' && e.outcome === 'confirmed'));
  recorded = { ws, runDir: dir, cfg: testConfig('http://127.0.0.1:9/v1', BROWSER()) };
});

test('E3 AC3 (agent): a 2nd action after a dropdown opener in the same turn is refused by the fence rule', async () => {
  const script: Script = (body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}combobox.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2) {
      const t = lastToolResult(body);
      // Open the dropdown and blindly click an option in the same turn.
      return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(t, /button "Fruit: none ▾"/) } }, { name: 'browser_act', arguments: { ref: refIn(t, /button "Sort: Most likes"/) } }] };
    }
    if (i === 3) return { toolCalls: [{ name: 'browser_snapshot', arguments: { query: 'option' } }] };
    if (i === 4) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(lastToolResult(body), /option "Banana"/) } }] };
    return { content: 'done' };
  };
  const { srv } = await runAgent(script);
  const turn2 = srv.requests[3].messages.filter((m: any) => m.role === 'tool').slice(-2).map((m: any) => String(m.content));
  assert.match(turn2[0], /outcome: confirmed/);
  assert.match(turn2[0], /listbox "Fruits"/);
  assert.match(turn2[1], /outcome: refused · path: L2b · error_code: policy_denied/);
  assert.match(turn2[1], /fence rule/);
  assert.match(lastToolResult(srv.requests[5]), /You chose Banana/);
});

// ------------------------------------------------------------ E3 cascade

test('E3 AC1: L1 answers an extraction goal on a static page with no browser launched', async () => {
  const before = childProcesses(process.pid).map((p) => `${p.pid} ${p.args}`).join('\n');
  const script: Script = (body, i) => {
    if (!isMain(body)) {
      assert.match(allText(body), /first lit in 1871/);
      return { content: 'It was first lit in 1871.' };
    }
    if (i === 0) return { toolCalls: [{ name: 'browser_task', arguments: { goal: 'When was the North Point lighthouse first lit?', url: `${site.url}article.html` } }] };
    return { content: lastToolResult(body) };
  };
  const sid = `l1-${Date.now()}`;
  let atToolEnd: { sessionOpen: boolean; chromeChildren: boolean } | undefined;
  const { res, srv } = await runAgent(script, {}, {
    sessionId: sid,
    ui: {
      onEvent: (e: AgentEvent) => {
        if (e.type === 'tool_end' && e.name === 'browser_task') {
          const ps = childProcesses(process.pid).map((p) => `${p.pid} ${p.args}`).join('\n');
          atToolEnd = { sessionOpen: !!peekBrowserSession(sid)?.driver.isOpen, chromeChildren: /chrom|headless/i.test(ps) };
        }
      },
    },
  });
  assert.match(res.finalText, /path: L1 · outcome: confirmed/);
  assert.match(res.finalText, /1871/);
  assert.equal(srv.requests.filter((b: any) => !isMain(b)).length, 1, 'one extraction call, no browser sub-loop');
  assert.deepEqual(atToolEnd, { sessionOpen: false, chromeChildren: /chrom|headless/i.test(before) }, 'no browser was launched for L1');
});

test('E3 AC2: a CAPTCHA fixture returns blocked_captcha without attempting a solve', async () => {
  const script: Script = (body, i) => {
    if (!isMain(body)) throw new Error('no model call may happen for a CAPTCHA');
    if (i === 0) return { toolCalls: [{ name: 'browser_task', arguments: { goal: 'continue past the check and read the page', url: `${site.url}captcha.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}captcha.html` } }] };
    if (i === 2) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 3) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(lastToolResult(body), /button "Continue"/) } }] };
    return { content: 'blocked' };
  };
  const { srv, agent } = await runAgent(script);
  assert.match(lastToolResult(srv.requests[1]), /path: L0 · outcome: failed · error_code: blocked_captcha/);
  assert.match(lastToolResult(srv.requests[2]), /error_code: blocked_captcha/);
  const act = lastToolResult(srv.requests[4]);
  assert.match(act, /outcome: refused · path: L2b · error_code: blocked_captcha/);
  assert.match(act, /Do not try to solve it/);
  assert.equal(srv.requests.filter((b: any) => !isMain(b)).length, 0);
  assert.ok(agent);
});

test('E3: L2b sub-loop (browser_task) fills a form with a small model, one fence action per turn', async () => {
  let sub = 0;
  const script: Script = (body, i) => {
    if (!isMain(body)) {
      sub++;
      const t = allText(body);
      assert.match(t, /You operate a web browser/);
      if (sub === 1) return { content: JSON.stringify({ actions: [{ type: refIn(t, /textbox "Full name"/), text: 'Alan Turing' }, { check: refIn(t, /checkbox "I accept the terms"/) }, { select: refIn(t, /combobox "Color"/), value: 'Red' }] }) };
      if (sub === 2) {
        assert.match(t, /\[checked\]/);
        return { content: JSON.stringify({ actions: [{ select: refIn(t, /combobox "Color"/), value: 'Red' }] }) };
      }
      if (sub === 3) return { content: JSON.stringify({ actions: [{ click: refIn(t, /button "Place order"/) }] }) };
      const code = t.match(/ORD-[A-Z0-9-]+/)?.[0];
      return { content: JSON.stringify({ done: `confirmation ${code}` }) };
    }
    if (i === 0) return { toolCalls: [{ name: 'browser_task', arguments: { goal: 'Fill the order form for Alan Turing, colour Red, accept the terms and place the order. Report the confirmation code.', url: `${site.url}form.html` } }] };
    return { content: lastToolResult(body) };
  };
  const { res } = await runAgent(script);
  assert.match(res.finalText, /path: L2b · outcome: confirmed/);
  assert.match(res.finalText, /ORD-ALAN-RED-1-STANDARD/);
  assert.equal(sub, 4);
});

// ------------------------------------------------------------ E4 AC3 / E5

test('E4 AC3: the screenshot image is attached only for vision profiles', async () => {
  const script: Script = (_b, i) => (i === 0 ? { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}marks.html` } }] } : i === 1 ? { toolCalls: [{ name: 'browser_screenshot', arguments: { marks: true } }] } : { content: 'ok' });
  const vision = await runAgent(script, {}, { vision: true });
  const imgs = (vision.srv.requests[2].messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url');
  assert.equal(imgs.length, 1);
  assert.match(imgs[0].image_url.url, /^data:image\/png;base64,/);
  const toolMsgs = (vision.srv.requests[2].messages as any[]).filter((m) => m.role === 'tool');
  assert.match(String(toolMsgs[toolMsgs.length - 1].content), /screenshot attached[\s\S]*marks:[\s\S]*generic "Draw"/);
  const text = await runAgent(script);
  assert.ok(!JSON.stringify(text.srv.requests).includes('image_url'));
  assert.match(lastToolResult(text.srv.requests[2]), /no vision and no perception backend is configured/);
});

test('E5 AC1: a canvas button with drawn text "Submit" is solved via OCR regions by a scripted text-only model', async () => {
  const script: Script = (body, i) => {
    const last = lastToolResult(body);
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}canvas.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2) {
      assert.match(last, /<canvas> element/);
      assert.ok(!/Submit/.test(last), 'the tree cannot see the canvas text');
      return { toolCalls: [{ name: 'browser_screenshot', arguments: {} }] };
    }
    if (i === 3) {
      const region = last.match(/\[(r\d+)\] "Submit"/)?.[1];
      assert.ok(region, last);
      return { toolCalls: [{ name: 'browser_point', arguments: { region, expect: { text_present: 'Canvas submitted' } } }] };
    }
    return { content: last };
  };
  const { res } = await runAgent(script, { perception: { backend: 'ocr' } });
  assert.match(res.finalText, /outcome: confirmed · path: L3/);
  assert.match(res.finalText, /Canvas submitted!/);
});

test('E5 AC3: OCR and grounder are off unless configured', async () => {
  const script: Script = (_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}canvas.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_screenshot', arguments: {} }] };
    if (i === 2) return { toolCalls: [{ name: 'browser_point', arguments: { instruction: 'the Submit button' } }] };
    if (i === 3) return { toolCalls: [{ name: 'browser_point', arguments: { x: 300, y: 150 } }] };
    return { content: 'ok' };
  };
  const { srv } = await runAgent(script);
  assert.match(lastToolResult(srv.requests[2]), /no perception backend is configured/);
  assert.match(lastToolResult(srv.requests[3]), /no grounding model is configured/);
  assert.match(lastToolResult(srv.requests[4]), /raw coordinates need a vision model/);
});

// ------------------------------------------------------------ E8

test('E8 AC1: a secret value never appears in LLM requests or the journal', async () => {
  const SECRET = 'correct-horse-battery-9';
  const script: Script = (body, i) => {
    const last = lastToolResult(body);
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}login.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2)
      return {
        toolCalls: [
          { name: 'browser_type', arguments: { ref: refIn(last, /textbox "Username"/), text: 'alice' } },
          { name: 'browser_type', arguments: { ref: refIn(last, /textbox "Password"/), secret: 'secret://site/pw' } },
        ],
      };
    if (i === 3) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(allText(body), /textbox "API key"/), secret: 'secret://site/pw' } }] };
    if (i === 4) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Sign in"/), expect: { text_present: 'Welcome' } } }] };
    if (i === 5) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }, { name: 'browser_extract', arguments: {} }] };
    return { content: 'signed in' };
  };
  const ws = tmpWorkspace({});
  const srv0 = await startMockServer(() => ({ content: '' }));
  const home = testConfig(srv0.url).homeDir;
  await srv0.close();
  new SecretVault(home, {}).set('site/pw', SECRET);
  const { srv, journal } = await runAgent(script, { homeDir: home }, { ws });
  assert.match(lastToolResult(srv.requests[5]), /outcome: confirmed[\s\S]*Welcome, alice/);
  // The API key field is a visible textbox: the page echoes the value back, and it is masked.
  assert.match(lastToolResult(srv.requests[4]), /textbox "API key" \[ref=\w+\] \[value="•••"\]/);
  const transcript = JSON.stringify(srv.requests);
  assert.ok(transcript.includes('secret://site/pw'), 'the model works with the ref');
  assert.ok(!transcript.includes(SECRET), 'the value never reaches the model');
  assert.ok(journal && fs.existsSync(journal));
  assert.ok(!fs.readFileSync(journal!, 'utf8').includes(SECRET), 'nor the journal');
  const runs = path.join(ws, '.tugline', 'runs');
  const traj = fs.readFileSync(path.join(runs, fs.readdirSync(runs)[0], 'trajectory.jsonl'), 'utf8');
  assert.ok(traj.includes('secret://site/pw') && !traj.includes(SECRET), 'nor the trajectory');
});

test('E8 AC2: a submit on a page with card fields returns needs_human unless payments are allowed', async () => {
  const script: Script = (body, i) => {
    const last = lastToolResult(body);
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}checkout.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Coupon code"/), text: 'SAVE10' } }, { name: 'browser_act', arguments: { ref: refIn(last, /button "Apply coupon"/) } }] };
    if (i === 3) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(allText(body), /textbox "Card number"/), text: '4242424242424242' } }] };
    if (i === 4) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Pay now"/) } }] };
    if (i === 5) return { toolCalls: [{ name: 'browser_key', arguments: { keys: 'Enter' } }] };
    return { content: 'handed over' };
  };
  const { srv } = await runAgent(script);
  assert.match(lastToolResult(srv.requests[3]), /Coupon SAVE10 applied/);
  assert.match(lastToolResult(srv.requests[4]), /outcome: refused · path: L2b · error_code: needs_human[\s\S]*payment-card field/);
  assert.match(lastToolResult(srv.requests[5]), /outcome: refused · path: L2b · error_code: needs_human[\s\S]*submits a payment/);
  assert.match(lastToolResult(srv.requests[6]), /error_code: needs_human/);
  assert.ok(!JSON.stringify(srv.requests).includes('PAYMENT SUBMITTED'));
  const allowed = await runAgent((body, i) => (i < 4 ? script(body, i) : i === 4 ? { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Pay now"/) } }] } : { content: 'paid' }), BROWSER({ allowPayments: true }));
  assert.match(lastToolResult(allowed.srv.requests[5]), /PAYMENT SUBMITTED/);
});

// ------------------------------------------------------------ E6

test('E6 AC1-3: attach to a Chromium started with a debug port, allowlist enforced, consent asked once', async () => {
  const chrome = await startDebugChrome();
  try {
    let asks = 0;
    const script: Script = (body, i) => {
      const last = lastToolResult(body);
      if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html`, profile: 'attached' } }] };
      if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      if (i === 2) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(last, /checkbox "I accept the terms"/), action: 'check' } }] };
      if (i === 3) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}tabs.html`, profile: 'attached' } }] };
      if (i === 4) return { toolCalls: [{ name: 'browser_navigate', arguments: { url: 'http://example.com/' } }] };
      if (i === 5) return { toolCalls: [{ name: 'browser_navigate', arguments: { url: `${site.url}__redirect?to=${encodeURIComponent(site.url.replace('127.0.0.1', 'localhost') + 'form.html')}` } }] };
      return { content: 'ok' };
    };
    const over = BROWSER({ cdpUrl: chrome.cdpUrl, attachedAllowDomains: ['127.0.0.1'] });
    const { srv, events } = await runAgent(script, over, { ui: { askUser: async (q: string) => { asks++; assert.match(q, /control your Chrome/); return 'Allow for this session'; } } });
    assert.match(lastToolResult(srv.requests[1]), /profile attached/);
    assert.match(lastToolResult(srv.requests[3]), /outcome: confirmed[\s\S]*\[checked\]/);
    assert.match(lastToolResult(srv.requests[4]), /opened .*tabs\.html/);
    assert.match(lastToolResult(srv.requests[5]), /blocked: example\.com is not in browser\.attachedAllowDomains/);
    // An allowlisted page that redirects elsewhere: the landed host is checked too.
    // (Since G4 the hop is refused at the CDP request stage, before it is sent.)
    assert.match(lastToolResult(srv.requests[6]), /blocked: http:\/\/localhost:\d+\/form\.html: localhost is not in browser\.attachedAllowDomains/);
    assert.equal(asks, 1, 'consent asked once per session');
    assert.ok(events.some((e) => e.type === 'notice' && /controlling your Chrome/.test(e.message)), 'visible notice');
    assert.equal(chrome.proc.exitCode, null, "closing the session does not kill the user's browser");
    // Denied consent stays denied for the session and is asked once.
    let asks2 = 0;
    const denied = await runAgent((_b, i) => (i < 2 ? { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html`, profile: 'attached' } }] } : { content: 'no' }), over, { ui: { askUser: async () => { asks2++; return 'Deny'; } } });
    assert.match(lastToolResult(denied.srv.requests[1]), /did not allow/);
    assert.match(lastToolResult(denied.srv.requests[2]), /did not allow/);
    assert.equal(asks2, 1);
    // Off by default: no cdpUrl → refused before any prompt.
    const off = await runAgent((_b, i) => (i === 0 ? { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html`, profile: 'attached' } }] } : { content: 'x' }));
    assert.match(lastToolResult(off.srv.requests[1]), /attached mode is off/);
  } finally {
    await chrome.stop();
  }
});

// ------------------------------------------------------------ E7

test('E7 AC1: the recorded 5-step flow replays strictly with no model', async () => {
  assert.ok(recorded, 'depends on the E1 AC3 recording');
  const { steps } = readTrajectory(recorded!.runDir);
  const actions = steps.filter((s) => ['browser_type', 'browser_act'].includes(s.tool));
  assert.ok(actions.length >= 4 && steps.some((s) => s.tool === 'browser_open'), 'open + 4 actions = 5 steps');
  const r = await replayRun(recorded!.runDir, recorded!.cfg, recorded!.ws, 'strict');
  assert.equal(r.ok, true, r.failure);
  assert.equal(r.steps, 5);
  // `tug replay --check` is the CI form of the same thing.
  const out: string[] = [];
  const code = await getCliCommand('replay')!.run([recorded!.runDir, '--check'], { config: recorded!.cfg, workspace: recorded!.ws, write: (t) => out.push(t) });
  assert.equal(code, 0, out.join(''));
  assert.match(out.join(''), /PASS: 5 steps replayed/);
  const html: string[] = [];
  await getCliCommand('replay')!.run([recorded!.runDir, '--html'], { config: recorded!.cfg, workspace: recorded!.ws, write: (t) => html.push(t) });
  assert.match(fs.readFileSync(path.join(recorded!.runDir, 'report.html'), 'utf8'), /path:<\/b> L2b×/);
});

test('E7 AC2: the exported spec runs with `npx playwright test` against the test site', async () => {
  assert.ok(recorded);
  const { steps, meta } = readTrajectory(recorded!.runDir);
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.pw-export-'));
  try {
    fs.writeFileSync(path.join(dir, 'recorded.spec.ts'), exportPlaywrightSpec(steps, { name: 'order flow', goal: meta?.goal }));
    const exe = installedChromiums(true)[0];
    fs.writeFileSync(path.join(dir, 'playwright.config.mjs'), `export default { testDir: '.', outputDir: './test-results', timeout: 30000, workers: 1, reporter: 'line', use: { headless: true, launchOptions: { executablePath: ${JSON.stringify(exe)} } } };\n`);
    // The site is local: run without outbound proxy variables (a sandbox proxy cannot reach 127.0.0.1).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
    // Async spawn: the site server lives in this process, so the event loop must keep running.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('npx', ['playwright', 'test', '--config', path.join(dir, 'playwright.config.mjs')], { cwd: dir, env: { ...env, CI: '1' } });
      let stdout = '';
      let stderr = '';
      const t = setTimeout(() => c.kill('SIGKILL'), 120_000);
      c.stdout.on('data', (d) => (stdout += d));
      c.stderr.on('data', (d) => (stderr += d));
      c.on('close', (status) => {
        clearTimeout(t);
        resolve({ status, stdout, stderr });
      });
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /1 passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('E7 AC3: self-healing replay recovers from a renamed button id (key still unique) and from a renamed label (one L2b step)', async () => {
  assert.ok(recorded);
  const { steps } = readTrajectory(recorded!.runDir);
  const placed = steps.find((s) => s.target?.name === 'Place order')!;
  assert.equal(placed.target?.selector, '#place-order', 'the recipe form targets the id');
  // A copy of the site where the button id changed.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-site-'));
  fs.cpSync(SITE_DIR, root, { recursive: true });
  const form = path.join(root, 'form.html');
  fs.writeFileSync(form, fs.readFileSync(form, 'utf8').replace('id="place-order"', 'id="submit-order"'));
  const site2 = await startSiteServer({ root });
  const moved = JSON.parse(JSON.stringify(steps).split(site.url).join(site2.url));
  const s = new BrowserSession({ sessionId: `heal-${Date.now()}`, workspace: recorded!.ws, config: { ...recorded!.cfg, browser: { enabled: true, record: false } } });
  try {
    await s.driver.open(`${site2.url}form.html`);
    assert.equal((await s.driver.refForSelector('#place-order')).count, 0, 'the recorded selector no longer matches');
    const healed = await replayTrajectory(s.driver, moved, { mode: 'heal', guard: s.replayGuard });
    assert.equal(healed.ok, true, healed.failure);
    assert.deepEqual(healed.healed.map((h) => [h.how, h.from, h.to]), [['semantic_key', '#place-order', '#submit-order']]);
    assert.equal(healed.patched.find((p) => p.seq === placed.seq)!.target!.selector, '#submit-order', 'the recipe is patched');
    assert.match((await s.driver.extract('text')).content, /Order confirmed: ORD-GRACE-BLUE/);

    // Renamed label: the key is gone, so strict replay fails and healing asks the model once.
    fs.writeFileSync(form, fs.readFileSync(form, 'utf8').replace('>Place order<', '>Submit order<'));
    const strict = await replayTrajectory(s.driver, moved, { mode: 'strict', guard: s.replayGuard });
    assert.equal(strict.ok, false);
    assert.match(strict.failure!, /Place order.*missing/);
    let calls = 0;
    const mock = await startMockServer((body) => {
      calls++;
      const tree = allText(body);
      assert.match(tree, /Recorded step: click button "Place order"/);
      return { content: JSON.stringify({ ref: refIn(tree, /button "Submit order"/) }) };
    });
    try {
      const llm = new LLMClient({ name: 'm', baseUrl: mock.url, model: 'mock-model', contextWindow: 8000, maxOutputTokens: 200, toolMode: 'native', vision: false, timeoutMs: 10_000 });
      const viaLlm = await replayTrajectory(s.driver, moved, { mode: 'heal', guard: s.replayGuard, heal: llmHealer(llm) });
      assert.equal(viaLlm.ok, true, viaLlm.failure);
      assert.equal(calls, 1);
      assert.deepEqual(viaLlm.healed.map((h) => h.how), ['llm']);
      assert.equal(viaLlm.patched.find((p) => p.seq === placed.seq)!.target!.key!.name, 'Submit order');
    } finally {
      await mock.close();
    }
  } finally {
    await s.dispose();
    await site2.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no browser processes leak from this test file', async () => {
  await closeAllBrowserSessions();
  const out = childProcesses(process.pid).map((p) => `${p.pid} ${p.args}`).join('\n');
  assert.ok(!/chrom|headless/i.test(out), out);
});

// ------------------------------------------------------------ I1 (browser part)

test('I1 AC1 (browser): evals/browser runs through the eval runner (as `tug eval` does) and writes report.md with path statistics', async () => {
  const { runEval, loadSuite } = await import('../src/core/eval/runner.js');
  const suiteDir = path.resolve('evals/browser');
  assert.ok(loadSuite(suiteDir).tasks.length >= 8, 'at least 8 browser tasks');
  const script: Script = (body, i) => {
    const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
    if (!isMain(body)) return { content: 'It was first lit in 1871; the climb is 214 steps.' };
    const url = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/[\w-]+\.html/)?.[0];
    const turn = body.messages.filter((m: any) => m.role === 'assistant').length;
    if (turn === 0) return { toolCalls: [{ name: 'browser_task', arguments: { goal: prompt, url } }] };
    if (turn === 1) {
      const r = lastToolResult(body);
      return { toolCalls: [{ name: 'write_file', arguments: { path: 'answer.txt', content: /blocked_captcha/.test(r) ? 'blocked: CAPTCHA (blocked_captcha), needs a human\n' : `${r}\n` } }] };
    }
    return { content: 'Done: the answer is in answer.txt.' };
  };
  const srv = await startMockServer(script);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-eval-browser-'));
  try {
    const scored = await runEval({ suiteDir, outDir: out, baseConfig: testConfig(srv.url), tasks: ['b01-extract', 'b08-captcha'] });
    assert.deepEqual(scored.map((s) => [s.task, s.outcome]), [['b01-extract', 'pass'], ['b08-captcha', 'pass']]);
    const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.match(report, /Evaluation report/);
    assert.match(report, /## Automation path statistics/);
    assert.match(report, /b01-extract__text_only__r1 \| L1×1 \|/);
    assert.match(report, /b08-captcha__text_only__r1 \| L0×1 \| blocked_captcha \|/);
  } finally {
    await srv.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('kill switch: /browser stop closes browsers and refuses further browser calls until resumed', async () => {
  const { getSlashCommand } = await import('../src/core/commands.js');
  const { resetKillSwitch } = await import('../src/core/automation/policy/index.js');
  const cmd = getSlashCommand('browser')!;
  const sid = `kill-${Date.now()}`;
  let wasOpen = false;
  const script: Script = (_b, i) => (i === 0 ? { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html` } }] } : i === 1 ? { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] } : { content: 'stopped' });
  try {
    const { srv } = await runAgent(script, {}, {
      sessionId: sid,
      ui: {
        onEvent: (e: AgentEvent) => {
          if (e.type === 'tool_end' && e.name === 'browser_open') {
            wasOpen = !!peekBrowserSession(sid)?.driver.isOpen;
            void cmd.run('stop', { agent: { sessionId: sid }, config: testConfig('http://x'), workspace: '.', write: () => undefined, surface: 'cli' });
          }
        },
      },
    });
    assert.equal(wasOpen, true);
    assert.match(lastToolResult(srv.requests[2]), /error_code: killed/);
    assert.equal(peekBrowserSession(sid), undefined, 'browser closed by the kill switch');
  } finally {
    resetKillSwitch();
  }
});

test('E3: the browser_task sub-loop escalates to L3 (OCR regions) when the target is drawn on a canvas', async () => {
  let sub = 0;
  const script: Script = (body, i) => {
    if (!isMain(body)) {
      sub++;
      const t = allText(body);
      if (sub === 1) {
        assert.match(t, /<canvas> element/);
        return { content: '{"escalate":"the Submit button is drawn on a canvas"}' };
      }
      if (sub === 2) {
        const region = t.match(/\[(r\d+)\] "Submit"/)?.[1];
        assert.ok(region, t);
        return { content: JSON.stringify({ actions: [{ click_region: region }] }) };
      }
      assert.match(t, /Canvas submitted!/);
      return { content: '{"done":"Canvas submitted!"}' };
    }
    if (i === 0) return { toolCalls: [{ name: 'browser_task', arguments: { goal: 'Press the Submit button on the canvas and report the status text', url: `${site.url}canvas.html` } }] };
    return { content: lastToolResult(body) };
  };
  const { res } = await runAgent(script, { perception: { backend: 'ocr' } });
  assert.match(res.finalText, /path: L3 · outcome: confirmed/);
  assert.match(res.finalText, /Canvas submitted!/);
  assert.match(res.finalText, /path stats: .*L3×/);
});

// ------------------------------------------------------------ review fixes (E8 pixels, envelope)

/** OCR at 3x through the harness pipeline (plain 1x tesseract misreads small form text). */
async function ocrText(file: string): Promise<string> {
  const { ocrRegions } = await import('../src/core/automation/perception/ocr.js');
  return (await ocrRegions(fs.readFileSync(file), { upscale: 3 })).map((r) => r.text).join(' | ');
}

/** OCR just one box (crop, 2x, single text line): the strongest read of a form field. */
async function ocrBox(file: string, b: { x: number; y: number; width: number; height: number }): Promise<string> {
  const { decodePng, encodePng, crop } = await import('../src/core/automation/perception/png.js');
  const c = crop(decodePng(fs.readFileSync(file)), b.x, b.y, b.width, b.height);
  const up = { width: c.width * 2, height: c.height * 2, data: new Uint8Array(c.width * c.height * 16) };
  for (let y = 0; y < up.height; y++) for (let x = 0; x < up.width; x++) up.data.set(c.data.subarray(((y >> 1) * c.width + (x >> 1)) * 4, ((y >> 1) * c.width + (x >> 1)) * 4 + 4), (y * up.width + x) * 4);
  const out = `${file}.box.png`;
  fs.writeFileSync(out, encodePng(up));
  return execFileSync('tesseract', [out, 'stdout', '--psm', '7'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

/** Fraction of near-black pixels inside a box of a PNG. */
async function blackFraction(file: string, b: { x: number; y: number; width: number; height: number }): Promise<number> {
  const { decodePng } = await import('../src/core/automation/perception/png.js');
  const img = decodePng(fs.readFileSync(file));
  let dark = 0;
  let n = 0;
  for (let y = Math.ceil(b.y + 2); y < b.y + b.height - 2; y++)
    for (let x = Math.ceil(b.x + 2); x < b.x + b.width - 2; x++) {
      const o = (y * img.width + x) * 4;
      n++;
      if (img.data[o] < 30 && img.data[o + 1] < 30 && img.data[o + 2] < 30) dark++;
    }
  return dark / Math.max(1, n);
}

test('E8 AC1 (pixels): a secret typed into a visible text field is masked in vision screenshots and OCR captures', async () => {
  const SECRET = 'correct-horse-battery-9';
  const ws = tmpWorkspace({});
  const srv0 = await startMockServer(() => ({ content: '' }));
  const home = testConfig(srv0.url).homeDir;
  await srv0.close();
  new SecretVault(home, {}).set('site/pw', SECRET);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-mask-'));
  let control = '';
  let fieldBox: { x: number; y: number; width: number; height: number } | undefined;
  const script = (backend: 'vision' | 'ocr'): Script => (body, i) => {
    const last = lastToolResult(body);
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}login.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "API key"/), secret: 'secret://site/pw' } }, { name: 'browser_type', arguments: { ref: refIn(last, /textbox "Password"/), secret: 'secret://site/pw' } }] };
    if (i === 3) return { toolCalls: [{ name: 'browser_screenshot', arguments: backend === 'vision' ? { marks: true } : {} }] };
    return { content: 'ok' };
  };
  let controlShot: Promise<void> | undefined;
  const capture = (e: AgentEvent, sid: string) => {
    // Control: the same page captured WITHOUT masking (taken while the run continues, OCR'd after it).
    if (e.type === 'tool_end' && e.name === 'browser_type' && !controlShot) {
      const page = peekBrowserSession(sid)!.driver.page;
      controlShot = (async () => {
        fs.writeFileSync(path.join(scratch, 'control.png'), await page.screenshot());
        fieldBox = (await page.locator('#apikey').boundingBox()) ?? undefined;
      })();
    }
  };
  try {
    // Vision: the PNG that reaches the model.
    const sid = `mask-v-${Date.now()}`;
    const v = await runAgent(script('vision'), { homeDir: home }, { ws, vision: true, sessionId: sid, ui: { onEvent: (e: AgentEvent) => capture(e, sid) } });
    await controlShot;
    control = await ocrBox(path.join(scratch, 'control.png'), fieldBox!);
    assert.match(control, /horse|battery/i, `control capture must reveal the secret to OCR, got: ${control}`);
    const img = (v.srv.requests[4].messages as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((p: any) => p.type === 'image_url');
    assert.ok(img, 'a screenshot was sent');
    const sent = path.join(scratch, 'sent.png');
    fs.writeFileSync(sent, Buffer.from(img.image_url.url.split(',')[1], 'base64'));
    const seen = await ocrText(sent);
    assert.match(seen, /API key|Username|Sign in/i, `OCR works on the sent image: ${seen}`);
    assert.doesNotMatch(seen, /horse|battery/i, seen);
    assert.ok(fieldBox);
    assert.doesNotMatch(await ocrBox(sent, fieldBox!), /horse|battery/i);
    assert.ok((await blackFraction(sent, fieldBox!)) > 0.95, 'the API key field is a solid black box in the sent image');
    assert.ok(!JSON.stringify(v.srv.requests).includes(SECRET));
    // Text-only + OCR backend: the captured image and the regions text.
    const o = await runAgent(script('ocr'), { homeDir: home, perception: { backend: 'ocr' } }, { ws });
    const regions = lastToolResult(o.srv.requests[4]);
    assert.match(regions, /OCR text regions/);
    assert.doesNotMatch(regions, /horse|battery/i, regions);
    const art = path.join(ws, '.tugline', 'artifacts');
    const pngs = fs.readdirSync(art).filter((f) => f.startsWith('browser-') && f.endsWith('.png'));
    assert.ok(pngs.length >= 2);
    for (const f of pngs) {
      assert.doesNotMatch(await ocrText(path.join(art, f)), /horse|battery/i, f);
      assert.doesNotMatch(await ocrBox(path.join(art, f), fieldBox!), /horse|battery/i, f);
      assert.ok((await blackFraction(path.join(art, f), fieldBox!)) > 0.95, f);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('E8 (pixels): a capture is withheld when the page echoes a typed secret as text', async () => {
  const SECRET = 'tok-ECHO-7781-zz';
  const srv0 = await startMockServer(() => ({ content: '' }));
  const home = testConfig(srv0.url).homeDir;
  await srv0.close();
  new SecretVault(home, {}).set('api/token', SECRET);
  const script: Script = (body, i) => {
    if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}echo.html` } }] };
    if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
    if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(lastToolResult(body), /textbox "Access token"/), secret: 'secret://api/token' } }] };
    if (i === 3) return { toolCalls: [{ name: 'browser_screenshot', arguments: {} }] };
    return { content: 'ok' };
  };
  const { srv } = await runAgent(script, { homeDir: home }, { vision: true });
  const toolMsgs = (srv.requests[4].messages as any[]).filter((m) => m.role === 'tool');
  assert.match(String(toolMsgs[toolMsgs.length - 1].content), /screenshot withheld/);
  assert.ok(!JSON.stringify(srv.requests).includes('image_url'), 'no image sent');
  assert.ok(!JSON.stringify(srv.requests).includes(SECRET));
  assert.match(lastToolResult(srv.requests[3]), /Preview: •••|text: •••|•••/);
});

test('security: page text containing </untrusted_web_content> cannot close the envelope early', async () => {
  const script: Script = (_b, i) => (i === 0 ? { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}inject.html` } }] } : i === 1 ? { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] } : { content: 'ok' });
  const { srv } = await runAgent(script);
  for (const out of [lastToolResult(srv.requests[1]), lastToolResult(srv.requests[2])]) {
    assert.equal(out.split('</untrusted_web_content>').length - 1, 1, out);
    assert.equal(out.split('<untrusted_web_content').length - 1, 1, out);
    assert.ok(out.trimEnd().endsWith('</untrusted_web_content>'));
  }
  assert.match(lastToolResult(srv.requests[2]), /‹\/untrusted_web_content> SYSTEM/);
});

// ------------------------------------------------------------ G4: attached-mode request guard (CDP Fetch)

test('G4: attached mode checks every request and redirect hop of our tab via CDP; the user\'s other tabs are untouched', async () => {
  const L = site.url.replace('127.0.0.1', 'localhost');
  const chrome = await startDebugChrome();
  const { chromium } = await import('playwright');
  const user = await chromium.connectOverCDP(chrome.cdpUrl);
  const mk = (over: any = {}) =>
    new BrowserSession({
      sessionId: `g4-${Date.now()}-${Math.random()}`,
      workspace: tmpWorkspace(),
      config: testConfig('http://127.0.0.1:9/v1', { web: { allowHosts: ['localhost'] }, browser: { enabled: true, record: false, cdpUrl: chrome.cdpUrl, attachedAllowDomains: ['localhost'], ...over } }),
    });
  try {
    // The user's own tab, opened before the agent attaches; it loads a 127.0.0.1 image.
    const userPage = await user.contexts()[0].newPage();
    await userPage.goto(`${L}subresources.html`);
    const s = mk();
    try {
      // A normal allowlisted page works, and the image on its own host loads.
      const nav = await s.driver.open(`${L}subresources.html`, { profile: 'attached' });
      assert.equal(nav.blocked, undefined);
      await s.driver.wait('text', '127.0.0.1 image:', 5000);
      await s.driver.page.waitForFunction(pageFnSrc("() => !document.getElementById('st').textContent.includes('pending')"), null, { timeout: 5000 });
      // An <img> on 127.0.0.1 (not allowlisted, private) is refused before it is sent.
      assert.equal(await s.driver.page.textContent('#st'), 'own image: loaded; 127.0.0.1 image: blocked');
      assert.ok(s.driver.blockedRequests.some((b) => /^http:\/\/127\.0\.0\.1:\d+\/files\/dot\.png: .*SSRF guard/.test(b)), JSON.stringify(s.driver.blockedRequests));
      // An allowlisted page that 302-redirects to the metadata address: the hop is refused at the request stage.
      const r = await s.driver.navigate(`${L}__redirect?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
      assert.match(r.blocked ?? '', /^http:\/\/169\.254\.169\.254\/latest\/meta-data\/: /);
      assert.doesNotMatch(s.driver.page.url(), /169\.254/, 'the metadata address was never loaded');
      // A normal page still works afterwards.
      assert.equal((await s.driver.navigate(`${L}form.html`)).blocked, undefined);
      // Only our tab is driven.
      assert.deepEqual((await s.driver.tabTitles()).map((t) => t.title), ['Order form']);
      await userPage.reload();
      await userPage.waitForFunction("!document.getElementById('st').textContent.includes('pending')", null, { timeout: 5000 });
      assert.equal(await userPage.textContent('#st'), 'own image: loaded; 127.0.0.1 image: loaded', "the user's tab is not intercepted");
      // A tab the user opens while the session runs is not adopted or intercepted either.
      const later = await user.contexts()[0].newPage();
      await later.goto(`${L}subresources.html`);
      await later.waitForFunction("!document.getElementById('st').textContent.includes('pending')", null, { timeout: 5000 });
      assert.equal(await later.textContent('#st'), 'own image: loaded; 127.0.0.1 image: loaded', 'a tab the harness did not open is not intercepted');
      assert.equal((await s.driver.tabTitles()).length, 1);
      await later.close();
      // Popups our tab opens are ours: adopted and guarded. One to a non-allowlisted host is refused and blanked.
      for (const [target, ok] of [[`${L}form.html`, true], [`${site.url}form.html`, false]] as const) {
        const popup = s.driver.page.waitForEvent('popup');
        await s.driver.page.evaluate(`window.open(${JSON.stringify(target)})`);
        const pp = await popup;
        await pp.waitForLoadState('domcontentloaded');
        await new Promise((r) => setTimeout(r, 300));
        if (ok) assert.equal(pp.url(), target);
        else {
          await pp.waitForURL((u: URL) => !/^http:\/\/127\.0\.0\.1/.test(u.href), { timeout: 5000 });
          assert.ok(s.driver.blockedRequests.some((b) => b.startsWith(`${site.url}form.html: 127.0.0.1 is not in browser.attachedAllowDomains`)), JSON.stringify(s.driver.blockedRequests));
        }
        assert.equal((await s.driver.tabTitles()).length, 2, 'the popup is one of our tabs');
        await pp.close();
      }
    } finally {
      await s.dispose();
    }
    assert.equal(userPage.isClosed(), false, "the user's tab stays open; only our tab is closed");
    assert.ok(!user.contexts()[0].pages().some((p) => /form\.html/.test(p.url())), 'our tab was closed on dispose');

    // Third-party subresources (CDNs) are allowed by default and refused in strict mode.
    for (const strict of [false, true]) {
      const t = new BrowserSession({
        sessionId: `g4s-${strict}-${Date.now()}`,
        workspace: tmpWorkspace(),
        config: testConfig('http://127.0.0.1:9/v1', { web: { allowHosts: ['localhost', '127.0.0.1'] }, browser: { enabled: true, record: false, cdpUrl: chrome.cdpUrl, attachedAllowDomains: ['localhost'], attachedStrictSubresources: strict } }),
      });
      try {
        await t.driver.open(`${L}subresources.html`, { profile: 'attached' });
        await t.driver.page.waitForFunction(pageFnSrc("() => !document.getElementById('st').textContent.includes('pending')"), null, { timeout: 5000 });
        assert.equal(await t.driver.page.textContent('#st'), `own image: loaded; 127.0.0.1 image: ${strict ? 'blocked' : 'loaded'}`);
        if (strict) assert.ok(t.driver.blockedRequests.some((b) => /attachedStrictSubresources/.test(b)));
      } finally {
        await t.dispose();
      }
    }

    // A cross-site iframe runs in its own process (another CDP target). Its requests, and their redirect
    // hops, are still refused before they are sent: a probe server on 127.0.0.2 must see no request at all.
    const hits: string[] = [];
    const probe = http.createServer((req, res) => {
      hits.push(req.url!);
      res.writeHead(200, { 'content-type': 'image/png' }).end(fs.readFileSync(path.join(SITE_DIR, 'files/dot.png')));
    });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.2', () => r()));
    try {
      const port = (probe.address() as { port: number }).port;
      const o = new BrowserSession({
        sessionId: `g4f-${Date.now()}`,
        workspace: tmpWorkspace(),
        config: testConfig('http://127.0.0.1:9/v1', { web: { allowHosts: ['localhost', '127.0.0.1'] }, browser: { enabled: true, record: false, cdpUrl: chrome.cdpUrl, attachedAllowDomains: ['localhost'] } }),
      });
      try {
        assert.equal((await o.driver.open(`${L}oopif.html?probe=${port}`, { profile: 'attached' })).blocked, undefined);
        const inner = async () => o.driver.page.frames().find((f: any) => /\?inner/.test(f.url()));
        await o.driver.page.waitForFunction(pageFnSrc("() => document.getElementById('st').textContent === 'frame: loaded'"), null, { timeout: 5000 });
        const f = await inner();
        assert.ok(f, 'the cross-site frame loaded');
        await f.waitForFunction("!document.getElementById('st').textContent.includes('pending')", null, { timeout: 5000 });
        assert.equal(await f.textContent('#st'), 'direct: blocked; redirected: blocked');
        assert.deepEqual(hits, [], 'no request from the cross-site frame reached 127.0.0.2');
        for (const file of ['direct', 'redirected']) assert.ok(o.driver.blockedRequests.some((b) => b.startsWith(`http://127.0.0.2:${port}/${file}.png: `) && /SSRF guard/.test(b)), JSON.stringify(o.driver.blockedRequests));
      } finally {
        await o.dispose();
      }
    } finally {
      await new Promise((r) => probe.close(r));
    }
  } finally {
    await user.close();
    await chrome.stop();
  }
});
