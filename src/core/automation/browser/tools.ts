/**
 * Model-facing browser tools (SPEC E1–E8; research CU §5.2). Registered via
 * the tool-provider seam, only when `browser.enabled` is true.
 *
 * Small on purpose (27B models degrade with big tool lists): refs come from
 * browser_snapshot; every mutating call returns outcome + path + a diff
 * instead of the whole page. Page text, accessibility names and OCR text are
 * untrusted and always wrapped as such.
 *
 * Permission kinds: navigation and reading are `network` (rule key: the page's
 * domain); anything that changes page state is `execute`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, type ToolContext, type ToolDef, type ToolOutput } from '../../tools/types.js';
import { registerToolProvider } from '../../tools/registry.js';
import { registerAgentExtension } from '../../agent/extensions.js';
import { commandWrapperFor } from '../../tools/shell.js';
import type { BrowserAction, Expect } from '../types.js';
import { validateExpect } from '../expect/evaluate.js';
import { browserConfig, perceptionConfig } from './config.js';
import { closeAllBrowserSessions, closeBrowserSession, getBrowserSession, noteTurn, peekBrowserSession, type BrowserSession } from './session.js';
import { registerSlashCommand } from '../../commands.js';
import { isKilled, killAutomation, resetKillSwitch } from '../policy/index.js';
import { wrapUntrusted } from '../policy/untrusted.js';
import { withUntrustedMeta } from '../../util/untrusted.js';
import { SecretVault, envNameFor } from '../../secrets/vault.js';
import type { DriverActResult } from './driver.js';
import { drawMarks } from '../perception/marks.js';
import { centre, ocrRegions, renderRegions, type Region } from '../perception/ocr.js';
import { ground } from '../perception/grounder.js';
import { runBrowserTask } from '../cascade/controller.js';

// ------------------------------------------------------------ helpers

function session(ctx: ToolContext): BrowserSession {
  if (isKilled()) throw new ToolError('error_code: killed · browser automation was stopped by the user (kill switch). Do not retry; tell the user what you were doing.');
  return getBrowserSession({ sessionId: ctx.sessionId, workspace: ctx.workspace, config: ctx.config, policy: ctx.policy, emit: ctx.emit, model: ctx.llm?.profile?.model });
}

function currentHost(ctx: ToolContext): string {
  try {
    const s = peekBrowserSession(ctx.sessionId);
    return s?.driver.isOpen ? new URL(s.driver.page.url()).hostname : '';
  } catch {
    return '';
  }
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname : '';
  } catch {
    return '';
  }
}

function untrusted(source: string, body: string): string {
  return wrapUntrusted(source, body);
}

function ensureOpen(s: BrowserSession): void {
  if (!s.driver.isOpen) throw new ToolError('no page is open: call browser_open first');
}

function checkExpect(e: unknown): Expect | undefined {
  if (e === undefined || e === null || e === '') return undefined;
  const err = validateExpect(e);
  if (err) throw new ToolError(`invalid expect: ${err}`);
  return e as Expect;
}

/** Shared rendering of a mutating call's result. */
function actOutput(s: BrowserSession, r: DriverActResult, tool: string): ToolOutput {
  const head = [`outcome: ${r.outcome}`, `path: ${r.path ?? 'L2b'}`];
  if (r.errorCode) head.push(`error_code: ${r.errorCode}`);
  if (r.rebound) head.push('rebound: true');
  if (r.newSnapshotId) head.push(`snapshot: ${r.newSnapshotId}`);
  const lines = [head.join(' · ')];
  if (r.target) lines.push(`target: ${r.target.role}${r.target.name ? ` "${s.mask(r.target.name)}"` : ''} [ref=${r.target.ref}]`);
  const page: string[] = [];
  if (r.message) page.push(s.mask(r.message));
  for (const n of r.notes ?? []) page.push(s.mask(n));
  if (r.snapshot) page.push(`page after the action:\n${r.snapshot}`);
  else if (r.diff !== undefined) page.push(r.diff ? `diff:\n${r.diff}` : 'diff: (no change in the accessibility tree)');
  if (r.outcome === 'suspected_noop') lines.push('Nothing visible changed. Check the ref with browser_snapshot before retrying; do not repeat the same action blindly.');
  const out = [...lines, page.length ? untrusted(r.url ?? s.driver.latest?.url ?? '', page.join('\n')) : ''].filter(Boolean).join('\n');
  return { output: out, isError: r.outcome === 'failed' || r.outcome === 'refused', meta: { outcome: r.outcome, errorCode: r.errorCode, path: r.path ?? 'L2b', tool } };
}

const EXPECT_SCHEMA = {
  type: 'object',
  description: 'Optional post-condition checked after the action, e.g. {"text_present":"Saved"}, {"element_present":{"role":"dialog","name":"Confirm"}}, {"url_matches":"/checkout/"}, {"value_equals":{"ref":"e5","value":"x"}}. Required for destructive actions (delete/remove…).',
};

// ------------------------------------------------------------ navigation and perception

const browserOpen: ToolDef<{ url: string; profile?: string; headed?: boolean }> = {
  name: 'browser_open',
  core: true,
  kind: 'network',
  description:
    'Open a URL in the automation browser (starts it if needed) and return a page summary. profile: "isolated" (default, fresh), "persistent:<name>" (keeps logins), "attached" (the user\'s own Chrome; needs config and consent), "extension" (tabs the user shared through the Tugline extension; needs config and consent). ' +
    'Then call browser_snapshot to see the page with refs. For a simple "find X on page Y" goal, prefer browser_task or web_fetch.',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s) URL' }, profile: { type: 'string' }, headed: { type: 'boolean', description: 'Show the window (for human handoff)' } }, required: ['url'] },
  title: (a) => `Open ${a.url}${a.profile ? ` (${a.profile})` : ''}`,
  permissionInput: (a) => ({ domain: hostOf(a.url) }),
  validate: (a, ctx) => {
    const cfg = browserConfig(ctx.config);
    const profile = a.profile ?? cfg.profile;
    if (profile === 'attached') {
      if (!cfg.cdpUrl) throw new ToolError('attached mode is off: set browser.cdpUrl (and start Chrome with --remote-debugging-port and a non-default --user-data-dir)');
      if (!cfg.attachedAllowDomains.length) throw new ToolError('attached mode needs browser.attachedAllowDomains (the sites the agent may visit in your real browser)');
    }
    if (profile === 'extension') {
      if (!cfg.extensionEnabled) throw new ToolError('the browser extension bridge is off: set browser.extensionEnabled (and install and pair the Tugline extension)');
      if (!cfg.attachedAllowDomains.length) throw new ToolError('extension mode needs browser.attachedAllowDomains (the sites the agent may visit in your real browser)');
    }
  },
  async run(a, ctx) {
    const s = session(ctx);
    const profile = a.profile ?? s.cfg.profile;
    if (profile === 'attached' || profile === 'extension') {
      const ext = profile === 'extension';
      if (s.attachConsent === undefined) {
        if (!ctx.askUser) return { output: 'error_code: needs_human · attaching to your browser needs your consent, and no user is available to give it', isError: true };
        s.consentAsks++;
        const what = ext ? 'the browser tabs you shared through the Tugline extension' : `your Chrome at ${s.cfg.cdpUrl}`;
        const ans = await ctx.askUser(`Allow Tugline to control ${what} for this session? It can act in any account you are logged in to there. Navigation is limited to: ${s.cfg.attachedAllowDomains.join(', ')}.`, ['Allow for this session', 'Deny']);
        s.attachConsent = /^(allow|yes|y)\b/i.test(ans.trim());
      }
      if (!s.attachConsent) return { output: 'error_code: policy_denied · the user did not allow attaching to their browser in this session', isError: true };
      ctx.emit({ type: 'notice', level: 'warn', message: ext ? `⚠ Tugline is controlling the tabs you shared (extension); allowed sites: ${s.cfg.attachedAllowDomains.join(', ')} · /browser stop detaches them` : `⚠ Tugline is controlling your Chrome (${s.cfg.cdpUrl}); allowed sites: ${s.cfg.attachedAllowDomains.join(', ')}` });
    }
    const nav = await s.driver.open(a.url, { profile, headed: a.headed });
    if (nav.blocked) {
      s.record('browser_open', a, { outcome: 'refused', errorCode: 'policy_denied', path: 'L0' }, { url: a.url });
      return { output: `outcome: refused · error_code: policy_denied\nnavigation blocked: ${nav.blocked}`, isError: true };
    }
    const pre = await s.precondition();
    s.record('browser_open', a, { outcome: pre?.blocking ? 'failed' : 'confirmed', errorCode: pre?.code, path: pre ? 'L0' : 'L2b' }, { url: nav.url });
    const lines = [`opened ${nav.url}${nav.status ? ` (HTTP ${nav.status})` : ''} · profile ${s.driver.profile} · snapshot engine ${s.driver.snapshotEngine}`];
    if (s.driver.engineNote) ctx.emit({ type: 'notice', level: 'warn', message: `browser: ${s.driver.engineNote}` });
    if (pre) lines.push(`error_code: ${pre.code}${pre.causeHint ? ` (${pre.causeHint})` : ''} · path: L0 · ${pre.message}`);
    else lines.push('Next: browser_snapshot (use query="…" to filter large pages).');
    return { output: `${lines.join('\n')}\n${untrusted(nav.url, `title: ${nav.title}`)}`, isError: !!pre?.blocking, meta: { errorCode: pre?.code, path: pre ? 'L0' : 'L2b' } };
  },
};

const browserNavigate: ToolDef<{ url: string }> = {
  name: 'browser_navigate',
  core: true,
  kind: 'network',
  description: 'Navigate the current tab: a URL, or "back", "forward", "reload".',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL or back|forward|reload' } }, required: ['url'] },
  title: (a) => `Navigate ${a.url}`,
  permissionInput: (a, ctx) => ({ domain: ['back', 'forward', 'reload'].includes(a.url) ? currentHost(ctx) : hostOf(a.url) }),
  async run(a, ctx) {
    const s = session(ctx);
    const v = s.fence.check({ kind: 'navigate' });
    if (!v.ok) return { output: `outcome: refused · error_code: ${v.code}\n${v.message}`, isError: true };
    s.fence.record({ kind: 'navigate' });
    const nav = await s.driver.navigate(a.url);
    if (nav.blocked) return { output: `outcome: refused · error_code: policy_denied\nnavigation blocked: ${nav.blocked}`, isError: true };
    const pre = await s.precondition();
    s.record('browser_navigate', a, { outcome: 'confirmed', errorCode: pre?.code, path: pre ? 'L0' : 'L2b' }, { url: nav.url });
    return { output: `now at ${nav.url}${nav.status ? ` (HTTP ${nav.status})` : ''}${pre ? `\nerror_code: ${pre.code} · ${pre.message}` : ''}\n${untrusted(nav.url, `title: ${nav.title}`)}`, isError: !!pre?.blocking };
  },
};

const browserSnapshot: ToolDef<{ scope?: string; query?: string; max_tokens?: number; include_boxes?: boolean }> = {
  name: 'browser_snapshot',
  core: true,
  kind: 'network',
  readOnly: true,
  description:
    'Read the current page as an accessibility tree: `- role "name" [ref=e12] [state]`. Act on elements by their ref (refs are valid for the latest snapshot only). ' +
    'Large pages are pruned and collapsed ("… N more rows"); pass query (words to match in roles/names) to find specific elements, or scope ("main", "dialog", or a ref).',
  parameters: {
    type: 'object',
    properties: {
      scope: { type: 'string', description: '"page" (default), "main", "dialog", "form" or a ref' },
      query: { type: 'string', description: 'Fuzzy filter: keep nodes whose role/name contain all words, plus their ancestors' },
      max_tokens: { type: 'integer', description: 'Budget for this snapshot (default browser.snapshotTokens)' },
      include_boxes: { type: 'boolean' },
    },
  },
  title: (a) => `Snapshot${a.query ? ` "${a.query}"` : ''}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const snap = await s.driver.snapshot({ scope: a.scope, query: a.query, maxTokens: a.max_tokens, includeBoxes: a.include_boxes });
    const facts = await s.driver.pageFacts();
    const pre = await s.precondition();
    const head = [`snapshot ${snap.id} · ${snap.elementCount} elements · path: L2b${snap.truncated ? ' · truncated: true' : ''}`];
    if (pre) head.push(`error_code: ${pre.code} · ${pre.message}`);
    if (facts.canvas) head.push(`note: the page has ${facts.canvas} <canvas> element(s); their contents are not in this tree (use browser_screenshot if what you need is drawn there).`);
    if (s.driver.openDialog) head.push(`note: a ${s.driver.openDialog.type} dialog is open; use browser_dialog.`);
    s.record('browser_snapshot', a, { path: 'L2b', outcome: 'confirmed', errorCode: pre?.code }, { url: snap.url });
    return { output: `${head.join('\n')}\n${untrusted(snap.url ?? '', `title: ${snap.title}\n${snap.tree}`)}`, meta: { snapshotId: snap.id, truncated: snap.truncated, path: 'L2b' } };
  },
};

const browserExtract: ToolDef<{ mode?: 'text' | 'markdown'; scope?: string; max_chars?: number }> = {
  name: 'browser_extract',
  kind: 'network',
  readOnly: true,
  description: 'Return the readable text (or markdown) of the page or of one element (scope = ref). Use it to read long content such as tables or articles instead of a large snapshot.',
  parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['text', 'markdown'] }, scope: { type: 'string', description: 'ref of a region' }, max_chars: { type: 'integer' } } },
  title: (a) => `Extract ${a.mode ?? 'text'}${a.scope ? ` of ${a.scope}` : ''}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const r = await s.driver.extract(a.mode ?? 'text', { scope: a.scope });
    const max = Math.min(a.max_chars ?? 20_000, 100_000);
    const body = r.content.length > max ? `${r.content.slice(0, max)}\n… [${r.content.length - max} more characters]` : r.content;
    s.record('browser_extract', a, { path: 'L2b', outcome: 'confirmed' }, { url: r.url });
    return { output: untrusted(r.url, `title: ${r.title}\n${body}`), meta: { path: 'L2b' } };
  },
};

const browserVerify: ToolDef<{ checks: Expect[] }> = {
  name: 'browser_verify',
  kind: 'network',
  readOnly: true,
  description: 'Check post-conditions on the current page without acting: a list of Expect objects such as {"text_present":"Order confirmed"}. Returns ok and the failures. Use it before reporting success.',
  parameters: { type: 'object', properties: { checks: { type: 'array', items: { type: 'object' } } }, required: ['checks'] },
  title: () => 'Verify page state',
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const checks = (Array.isArray(a.checks) ? a.checks : [a.checks]).map(checkExpect).filter((x): x is Expect => !!x);
    if (!checks.length) throw new ToolError('checks must be a non-empty list of expectations');
    const r = await s.driver.verify(checks);
    s.record('browser_verify', a, { path: 'L2b', outcome: r.ok ? 'confirmed' : 'failed', errorCode: r.ok ? undefined : 'verify_failed' }, {});
    return { output: r.ok ? 'ok: all checks passed' : `not ok:\n${untrusted(s.driver.latest?.url ?? '', r.failures.map((f) => `- ${s.mask(f)}`).join('\n'))}`, isError: !r.ok, meta: { ok: r.ok } };
  },
};

const browserWait: ToolDef<{ for: 'text' | 'ref_gone' | 'url' | 'load' | 'time'; value: string; timeout_ms?: number }> = {
  name: 'browser_wait',
  kind: 'network',
  description: 'Wait for something: for="text" (text appears), "ref_gone" (element disappears), "url" (URL contains value), "load", or "time" (milliseconds, max 10000).',
  parameters: { type: 'object', properties: { for: { type: 'string', enum: ['text', 'ref_gone', 'url', 'load', 'time'] }, value: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['for', 'value'] },
  title: (a) => `Wait for ${a.for} ${a.value}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const r = await s.driver.wait(a.for, String(a.value), a.timeout_ms);
    return { output: s.mask(r.message), isError: !r.ok };
  },
};

const browserTabs: ToolDef<{ op: 'list' | 'select' | 'new' | 'close'; index?: number; url?: string }> = {
  name: 'browser_tabs',
  kind: 'network',
  description: 'List, select, open (op="new", optional url) or close browser tabs. Index from the list.',
  parameters: { type: 'object', properties: { op: { type: 'string', enum: ['list', 'select', 'new', 'close'] }, index: { type: 'integer' }, url: { type: 'string' } }, required: ['op'] },
  title: (a) => `Tabs: ${a.op}${a.index !== undefined ? ` ${a.index}` : ''}`,
  permissionInput: (a, ctx) => ({ domain: a.url ? hostOf(a.url) : currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    const r = await s.driver.tabs(a.op, { index: a.index, url: a.url });
    if (r.nav?.blocked) return { output: `navigation blocked: ${r.nav.blocked}`, isError: true };
    s.record('browser_tabs', a, { path: 'L2b', outcome: 'confirmed' }, {});
    return { output: untrusted('tabs', r.tabs.map((t, i) => `[${i}]${t.active ? ' (active)' : ''} "${t.title}" ${t.url}`).join('\n')) };
  },
};

// ------------------------------------------------------------ actions

const browserAct: ToolDef<{ ref: string; action?: BrowserAction; value?: string | string[]; expect?: Expect }> = {
  name: 'browser_act',
  core: true,
  kind: 'execute',
  description:
    'Act on one element from the latest snapshot: action = click (default) | dblclick | hover | check | uncheck | focus | select (value = option label, native <select> only) | upload (value = file path(s)). ' +
    'Returns outcome (confirmed / suspected_noop / failed / refused) and a diff of what changed. At most 2 actions per turn; opening a dropdown/menu, submitting or following a link must be the only action in its turn.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'e.g. e12' },
      action: { type: 'string', enum: ['click', 'dblclick', 'hover', 'check', 'uncheck', 'focus', 'select', 'upload'] },
      value: { description: 'Option label for select; file path(s) for upload', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
      expect: EXPECT_SCHEMA,
    },
    required: ['ref'],
  },
  title: (a) => `${a.action ?? 'click'} ${a.ref}${a.value ? ` = ${Array.isArray(a.value) ? a.value.join(', ') : a.value}` : ''}`,
  permissionInput: (a, ctx) => {
    const files = a.action === 'upload' ? (Array.isArray(a.value) ? a.value : a.value ? [a.value] : []) : [];
    return { domain: currentHost(ctx), ...(files.length ? { paths: files.map((f) => ({ path: path.resolve(ctx.workspace, f), write: false })) } : {}) };
  },
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const expect = checkExpect(a.expect);
    const action = (a.action ?? 'click') as BrowserAction;
    const value = action === 'upload' ? (Array.isArray(a.value) ? a.value : a.value ? [a.value] : []).map((f) => path.resolve(ctx.workspace, f)) : a.value;
    const r = await s.withExpect(expect, () => s.driver.act(String(a.ref), action, { value, expect, guard: s.guard }));
    s.record('browser_act', a, r, { expect });
    return actOutput(s, r, 'browser_act');
  },
};

const browserType: ToolDef<{ ref?: string; text?: string; secret?: string; submit?: boolean; clear?: boolean; expect?: Expect }> = {
  name: 'browser_type',
  core: true,
  kind: 'execute',
  description:
    'Type into a field (ref from the snapshot; clears it first unless clear=false). For passwords and other credentials pass secret="secret://name" instead of text: the harness fills the value and you never see it. ' +
    'Never ask the user to paste a password into the chat. submit=true presses Enter afterwards.',
  parameters: {
    type: 'object',
    properties: { ref: { type: 'string' }, text: { type: 'string' }, secret: { type: 'string', description: 'secret://name' }, submit: { type: 'boolean' }, clear: { type: 'boolean' }, expect: EXPECT_SCHEMA },
  },
  title: (a) => `Type ${a.secret ? a.secret : JSON.stringify((a.text ?? '').slice(0, 40))}${a.ref ? ` into ${a.ref}` : ''}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  validate: (a) => {
    if (a.text === undefined && !a.secret) throw new ToolError('pass text or secret');
    if (a.secret && !/^secret:\/\//.test(a.secret)) throw new ToolError('secret must look like secret://name');
  },
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const expect = checkExpect(a.expect);
    const r = await s.driver.type(a.text ?? '', { ref: a.ref, secret: a.secret, submit: a.submit, clear: a.clear, expect, guard: s.guard });
    s.record('browser_type', a.secret ? { ...a, text: undefined } : { ...a, text: s.mask(a.text ?? '') }, r, { expect });
    return actOutput(s, r, 'browser_type');
  },
};

const browserKey: ToolDef<{ keys: string; expect?: Expect }> = {
  name: 'browser_key',
  core: true,
  kind: 'execute',
  description: 'Press keys in the page, e.g. "Enter", "Escape", "Tab", "Control+A", "ArrowDown ArrowDown Enter" (space-separated sequence).',
  parameters: { type: 'object', properties: { keys: { type: 'string' }, expect: EXPECT_SCHEMA }, required: ['keys'] },
  title: (a) => `Press ${a.keys}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const expect = checkExpect(a.expect);
    const r = await s.driver.key(String(a.keys), { expect, guard: s.guard });
    s.record('browser_key', a, r, { expect });
    return actOutput(s, r, 'browser_key');
  },
};

const browserScroll: ToolDef<{ direction?: 'up' | 'down' | 'left' | 'right'; ref?: string; amount?: number }> = {
  name: 'browser_scroll',
  kind: 'execute',
  description: 'Scroll the page (direction, amount in screens) or scroll an element (ref) into view.',
  parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, ref: { type: 'string' }, amount: { type: 'integer' } } },
  title: (a) => `Scroll ${a.ref ?? a.direction ?? 'down'}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const r = await s.driver.scroll(a.direction ?? 'down', { ref: a.ref, amount: a.amount });
    s.record('browser_scroll', a, r);
    return actOutput(s, r, 'browser_scroll');
  },
};

const browserDialog: ToolDef<{ action: 'accept' | 'dismiss'; text?: string }> = {
  name: 'browser_dialog',
  kind: 'execute',
  description: 'Answer an open alert/confirm/prompt dialog: action "accept" or "dismiss" (text = answer for a prompt). Dialogs are never auto-accepted.',
  parameters: { type: 'object', properties: { action: { type: 'string', enum: ['accept', 'dismiss'] }, text: { type: 'string' } }, required: ['action'] },
  title: (a) => `${a.action} dialog`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const r = await s.driver.dialog(a.action === 'accept' ? 'accept' : 'dismiss', a.text);
    s.record('browser_dialog', a, r);
    return actOutput(s, r, 'browser_dialog');
  },
};

const browserDownload: ToolDef<{ ref: string }> = {
  name: 'browser_download',
  kind: 'execute',
  description: 'Click an element that downloads a file and save it into the workspace downloads folder (browser.downloadsDir). Returns the saved path.',
  parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
  title: (a) => `Download via ${a.ref}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx), paths: [{ path: path.resolve(ctx.workspace, browserConfig(ctx.config).downloadsDir, '_'), write: true }] }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const r = await s.driver.download(String(a.ref), { guard: s.guard });
    s.record('browser_download', a, r);
    return actOutput(s, r, 'browser_download');
  },
};

// ------------------------------------------------------------ L3: screenshot / point

const browserScreenshot: ToolDef<{ scope?: string; marks?: boolean }> = {
  name: 'browser_screenshot',
  kind: 'network',
  description:
    'Look at the page pixels, for content the accessibility tree cannot see (canvas, images). Vision models get the image (marks=true numbers the clickable elements with their refs). ' +
    'Text-only models get numbered OCR text regions like [r2] "Submit" (x,y w×h) when perception is configured; click one with browser_point {region:"r2"}.',
  parameters: { type: 'object', properties: { scope: { type: 'string', description: 'ref of a region' }, marks: { type: 'boolean' } } },
  title: (a) => `Screenshot${a.marks ? ' with marks' : ''}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const shot = await s.driver.screenshot({ scope: a.scope, marks: !!a.marks && ctx.vision });
    fs.mkdirSync(ctx.artifactsDir, { recursive: true });
    const file = path.join(ctx.artifactsDir, `browser-${Date.now()}.png`);
    if (ctx.vision) {
      const png = shot.marks?.length ? drawMarks(shot.png, shot.marks, shot.dpr) : shot.png;
      fs.writeFileSync(file, png);
      s.record('browser_screenshot', a, { path: 'L3', outcome: 'confirmed' });
      const legend = shot.marks?.length ? `\nmarks:\n${untrusted(s.driver.latest?.url ?? '', shot.marks.map((m) => `${m.ref} ${m.role ?? ''} "${s.mask(m.name ?? '')}"`).join('\n'))}` : '';
      return { output: `screenshot attached (${shot.viewport.width}x${shot.viewport.height} CSS px) · saved ${path.relative(ctx.workspace, file)} · path: L3${legend}`, images: [{ mimeType: 'image/png', base64: png.toString('base64') }], meta: { path: 'L3', file } };
    }
    fs.writeFileSync(file, shot.png);
    const p = perceptionConfig(ctx.config);
    if (p.backend === 'ocr') {
      const regions = await ocrRegions(shot.png, { command: p.ocr?.command, lang: p.ocr?.lang, omniparserUrl: p.ocr?.omniparserUrl, wrap: commandWrapperFor(ctx.config), workDir: ctx.artifactsDir });
      for (const r of regions) r.text = s.mask(r.text);
      lastRegions.set(ctx.sessionId, { regions, scopeOffset: a.scope ? s.driver.nodeFor(a.scope)?.box : undefined });
      s.record('browser_screenshot', a, { path: 'L3', outcome: 'confirmed' });
      return { output: `OCR text regions (${regions.length}) · path: L3 · click one with browser_point {"region":"rN"}\n${untrusted(s.driver.latest?.url ?? '', renderRegions(regions))}`, meta: { path: 'L3', regions: regions.length } };
    }
    if (p.backend === 'grounder') return { output: 'This model has no vision. A grounding model is configured: call browser_point with "instruction" describing the target (e.g. "the green Submit button") and it will be located for you. path: L3', meta: { path: 'L3' } };
    return { output: `This model has no vision and no perception backend is configured (set perception.backend to "ocr" or "grounder"), so the screenshot cannot be described. It was saved to ${path.relative(ctx.workspace, file)}. Use browser_snapshot / browser_extract instead.`, isError: true };
  },
};

const lastRegions = new Map<string, { regions: Region[]; scopeOffset?: { x: number; y: number } }>();

const browserPoint: ToolDef<{ region?: string; instruction?: string; x?: number; y?: number; action?: 'click' | 'dblclick' | 'drag_to'; to?: [number, number]; expect?: Expect }> = {
  name: 'browser_point',
  kind: 'execute',
  description:
    'L3 pixel action for things the tree cannot target (canvas). Give region (an OCR region id from browser_screenshot), or instruction (with a grounding model), or x,y in CSS pixels (vision models). ' +
    'Prefer refs whenever the element is in the snapshot.',
  parameters: {
    type: 'object',
    properties: { region: { type: 'string' }, instruction: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, action: { type: 'string', enum: ['click', 'dblclick', 'drag_to'] }, to: { type: 'array', items: { type: 'number' } }, expect: EXPECT_SCHEMA },
  },
  title: (a) => `Point ${a.region ?? a.instruction ?? `${a.x},${a.y}`}`,
  permissionInput: (_a, ctx) => ({ domain: currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    ensureOpen(s);
    const expect = checkExpect(a.expect);
    let x: number;
    let y: number;
    let how: string;
    if (a.region) {
      const lr = lastRegions.get(ctx.sessionId);
      const r = lr?.regions.find((q) => q.id === a.region);
      if (!r) throw new ToolError(`unknown region ${a.region}: call browser_screenshot first and use an id from its list`);
      [x, y] = centre(r.box);
      x += lr?.scopeOffset?.x ?? 0;
      y += lr?.scopeOffset?.y ?? 0;
      how = `region ${r.id} "${r.text}"`;
    } else if (a.instruction) {
      const g = perceptionConfig(ctx.config).grounder;
      if (perceptionConfig(ctx.config).backend !== 'grounder' || !g) throw new ToolError('no grounding model is configured (perception.backend = "grounder")');
      const shot = await s.driver.screenshot({});
      try {
        const p = await ground(g, shot.png, a.instruction);
        [x, y] = [p.x, p.y];
        how = `grounded "${a.instruction}"${p.zoomed ? ' (zoomed)' : ''}`;
      } catch (e) {
        return { output: `outcome: failed · error_code: vlm_unavailable\n${(e as Error).message}`, isError: true };
      }
    } else if (typeof a.x === 'number' && typeof a.y === 'number') {
      if (!ctx.vision && !s.cfg.allowPoint) throw new ToolError('raw coordinates need a vision model (or browser.allowPoint); use an OCR region id instead');
      [x, y] = [a.x, a.y];
      how = `(${x},${y})`;
    } else throw new ToolError('give region, instruction, or x and y');
    const r = await s.driver.point(x, y, a.action ?? 'click', { to: a.to, expect, guard: s.guard });
    s.record('browser_point', { ...a, x, y }, r, { expect });
    const out = actOutput(s, r, 'browser_point');
    return { ...out, output: `${how} → (${x},${y})\n${out.output}` };
  },
};

const browserClose: ToolDef<Record<string, never>> = {
  name: 'browser_close',
  kind: 'network',
  description: 'Close the automation browser for this session.',
  parameters: { type: 'object', properties: {} },
  title: () => 'Close browser',
  async run(_a, ctx) {
    const s = peekBrowserSession(ctx.sessionId);
    const stats = s?.stats().text;
    await closeBrowserSession(ctx.sessionId);
    return { output: `browser closed${stats ? ` · path stats: ${stats}` : ''}` };
  },
};

const browserTask: ToolDef<{ goal: string; url?: string; max_turns?: number; params?: Record<string, string> }> = {
  name: 'browser_task',
  core: true,
  kind: 'execute',
  description:
    'Delegate a simple web goal ("find the opening hours on <url>", "fill the contact form with …") to the browser cascade: it tries a plain fetch first (no browser), then deterministic recipes, then an accessibility-tree sub-agent, then pixels. ' +
    'Returns the answer, the path used (L0/L1/L2a/L2b/L3) and an error_code when blocked (CAPTCHA, login, payment → needs a human).',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string' },
      url: { type: 'string' },
      max_turns: { type: 'integer' },
      params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for a learned skill\'s recipe placeholders, e.g. {"full_name":"Ada"} (see the skill\'s Inputs). Secrets are never params: they come from secret:// refs.' },
    },
    required: ['goal'],
  },
  title: (a) => `Browser task: ${a.goal.slice(0, 60)}`,
  permissionInput: (a, ctx) => ({ domain: hostOf(a.url) || currentHost(ctx) }),
  async run(a, ctx) {
    const s = session(ctx);
    const params = a.params && typeof a.params === 'object' ? Object.fromEntries(Object.entries(a.params).map(([k, v]) => [k, String(v)])) : undefined;
    const r = await runBrowserTask(ctx, s, { goal: String(a.goal), url: a.url, maxTurns: a.max_turns, params });
    const head = `path: ${r.path} · outcome: ${r.outcome}${r.errorCode ? ` · error_code: ${r.errorCode}` : ''} · turns: ${r.turns} · path stats: ${r.pathStats}`;
    return { output: `${head}\n${untrusted(r.url ?? a.url ?? '', s.mask(r.answer))}`, isError: r.outcome !== 'confirmed', meta: { path: r.path, errorCode: r.errorCode, outcome: r.outcome } };
  },
};

export const BROWSER_TOOLS: ToolDef[] = [browserOpen, browserNavigate, browserSnapshot, browserAct, browserType, browserKey, browserScroll, browserWait, browserVerify, browserExtract, browserTabs, browserDialog, browserDownload, browserScreenshot, browserPoint, browserClose, browserTask];

// G2: page text, OCR and screenshots taint the session (meta.untrusted)
const PROVIDED_TOOLS = BROWSER_TOOLS.map(withUntrustedMeta);

registerToolProvider({
  id: 'browser',
  tools: (cfg) => (browserConfig(cfg).enabled ? PROVIDED_TOOLS : []),
});

/** Turn tracking for the fence rule, path stats at run end, browser closed with the session. */
registerAgentExtension({
  id: 'browser',
  beforeTurn: (a, turn) => {
    noteTurn(a.sessionId, turn);
  },
  onRunEnd: (a) => {
    const s = peekBrowserSession(a.sessionId);
    if (!s?.recorder?.steps.length) return;
    s.recorder.flushMeta({ endedAt: new Date().toISOString() });
    a.notice('info', `browser path stats: ${s.stats().text} · trajectory ${s.recorder.file}`);
    a.journal({ type: 'automation_stats', surface: 'browser', pathStats: s.stats().stats, trajectory: s.recorder.file });
  },
  onSessionEnd: async (a) => {
    await closeBrowserSession(a.sessionId);
    await closeBrowserSession(`${a.sessionId}-sub`);
  },
});

/**
 * `/browser` — status, the kill switch and secrets management for the user (never the model):
 *   /browser            status (profile, tabs, path stats)
 *   /browser stop       kill switch: stop all automation now and close browsers
 *   /browser resume     clear the kill switch
 *   /browser secrets    list secret names (values are never shown)
 *   /browser secret <name>   store a secret (asks for the value; never goes through the model)
 */
registerSlashCommand({
  name: 'browser',
  description: 'browser automation status, kill switch (stop/resume) and secrets',
  usage: '[stop|resume|secrets|secret <name>]',
  async run(args, ctx) {
    const [sub, name] = args.trim().split(/\s+/);
    const sid: string | undefined = ctx.agent?.sessionId;
    if (sub === 'stop') {
      killAutomation('stopped by the user');
      await closeAllBrowserSessions();
      ctx.write('automation stopped: all browsers closed; /browser resume to allow it again\n');
      return;
    }
    if (sub === 'resume') {
      resetKillSwitch();
      ctx.write('automation allowed again\n');
      return;
    }
    const vault = new SecretVault(ctx.config.homeDir);
    if (sub === 'secrets') {
      ctx.write(`${vault.list().join('\n') || '(no secrets)'}\n`);
      return;
    }
    if (sub === 'secret' && name) {
      if (!ctx.ask) {
        ctx.write(`set ${envNameFor(name)} in the environment, or run this in an interactive surface\n`);
        return;
      }
      const v = await ctx.ask(`Value for secret://${name} (stored in ${vault.file}, mode 0600; never sent to the model):`);
      vault.set(name, v);
      ctx.write(`stored secret://${name}\n`);
      return;
    }
    const s = sid ? peekBrowserSession(sid) : undefined;
    if (!s?.driver.isOpen) {
      ctx.write(`no browser open${isKilled() ? ' · kill switch is ON' : ''}\n`);
      return;
    }
    const tabs = await s.driver.tabTitles();
    ctx.write(`profile ${s.driver.profile} · engine ${s.driver.snapshotEngine} · path stats ${s.stats().text}${isKilled() ? ' · kill switch is ON' : ''}\n${tabs.map((t, i) => `[${i}]${t.active ? '*' : ' '} ${t.title} ${t.url}`).join('\n')}\n`);
  },
});
