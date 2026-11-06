/**
 * SPEC I3: replay CI (WS8). `tug replay --check <run>` exits 0 for a recorded passing
 * trajectory and 1 once the site changed under it; the sample workflow runs it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { startSiteServer, SITE_DIR } from '../evals/browser/serve.mjs';
import { Agent } from '../src/core/agent/agent.js';
import { closeAllBrowserSessions } from '../src/core/automation/browser/session.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult, type Script } from './helpers.js';

const ROOT = process.cwd();
const closers: (() => Promise<void>)[] = [];
after(async () => {
  await closeAllBrowserSessions();
  for (const c of closers) await c();
});

function refIn(text: string, re: RegExp): string {
  const line = text.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  if (!line) throw new Error(`no ${re} in:\n${text}`);
  return line.match(/\[ref=(\w+)\]/)![1];
}
const allText = (body: any) => (body.messages as any[]).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // tsx resolves from the process cwd, so run from the repo and point the CLI at the workspace with --cwd.
    const p = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'cli', 'main.ts'), '--cwd', cwd, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('I3 AC1: a recorded passing trajectory exits 0 under `tug replay --check`; after the test site changes, it exits 1', async () => {
  // A private copy of the test site, so it can be changed under the recording.
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-site-'));
  fs.cpSync(SITE_DIR, siteDir, { recursive: true });
  const site = await startSiteServer({ root: siteDir });
  closers.push(site.close);

  // 1. Record: an agent run fills and submits the order form (scripted text-only model).
  const script: Script = (body, i) => {
    const last = lastToolResult(body);
    switch (i) {
      case 0:
        return { toolCalls: [{ name: 'browser_open', arguments: { url: `${site.url}form.html` } }] };
      case 1:
        return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
      case 2:
        return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Full name"/), text: 'Grace Hopper' } }, { name: 'browser_act', arguments: { ref: refIn(last, /checkbox "I accept the terms"/), action: 'check' } }] };
      case 3:
        return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /combobox "Color"/), action: 'select', value: 'Blue' } }] };
      case 4:
        return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Place order"/), expect: { text_present: 'Order confirmed' } } }] };
      default:
        return { content: `Order placed: ${last.match(/ORD-[A-Z0-9-]+/)?.[0]}` };
    }
  };
  const mock = await startMockServer(script);
  closers.push(mock.close);
  const ws = tmpWorkspace({ 'note.txt': 'hello\n' });
  const cfg = testConfig(mock.url, { permissionMode: 'yolo', web: { searchProvider: 'none', fetchMaxChars: 40000, allowHosts: ['127.0.0.1'] }, browser: { enabled: true } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const res = await agent.run('place the order');
  await agent.dispose();
  assert.match(res.finalText, /ORD-GRACE-BLUE/);
  const runsDir = path.join(ws, '.tugline', 'runs');
  const runDir = path.join(runsDir, fs.readdirSync(runsDir)[0]);

  // 2. CI: the real CLI, with the user config a CI job would have (localhost allowed for the browser).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ci-home-'));
  fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tugline', 'config.json'), JSON.stringify({ web: { allowHosts: ['127.0.0.1'] }, browser: { enabled: true } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k]; // a proxy cannot reach 127.0.0.1
  const relRun = path.relative(ws, runDir);
  const ok = await cli(['replay', '--check', relRun], ws, env);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /PASS: 5 steps replayed/);

  // 3. The site changes under the recording (the submit button is relabelled): the check fails.
  const form = path.join(siteDir, 'form.html');
  fs.writeFileSync(form, fs.readFileSync(form, 'utf8').replace('>Place order</button>', '>Confirm purchase</button>'));
  const broken = await cli(['replay', '--check', relRun], ws, env);
  assert.equal(broken.code, 1, broken.out);
  assert.match(broken.out, /FAIL: /);
  assert.match(broken.out, /Place order/);
});

test('I3: the sample GitHub workflow parses and runs `tug replay --check` on every recorded run', () => {
  const wf = parseYaml(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'tugline-replay.yml'), 'utf8'));
  assert.ok(wf.on, 'has triggers');
  const job = Object.values<any>(wf.jobs)[0];
  assert.ok(job['runs-on']);
  const script = job.steps.map((s: any) => s.run ?? '').join('\n');
  assert.match(script, /replay --check "\$run"/);
  assert.match(script, /exit "\$FAILED"|exit \$FAILED/);
  assert.ok(job.steps.some((s: any) => /checkout/.test(s.uses ?? '')));
});
