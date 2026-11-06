// Records the sample browser run that this repository's replay CI checks
// (.github/workflows/tugline-replay.yml, SPEC I3; v1.1 R7). A scripted model
// (no LLM) fills and submits the order form of the bundled test site, served on
// a fixed port so the recorded URLs are the ones CI serves:
//
//   npx tsx scripts/record-replay-sample.mts        → ci/replays/order-form/
//   node evals/browser/serve.mjs 8765 & tug replay --check ci/replays/order-form
//
// Re-record after an intended change to evals/browser/site/form.html.
import fs from 'node:fs';
import path from 'node:path';
import { startSiteServer } from '../evals/browser/serve.mjs';
import { Agent } from '../src/core/agent/agent.js';
import { closeAllBrowserSessions } from '../src/core/automation/browser/session.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult, type Script } from '../test/helpers.js';

export const REPLAY_PORT = 8765;
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'ci', 'replays', 'order-form');

const refIn = (text: string, re: RegExp): string => {
  const line = text.split('\n').find((l) => re.test(l) && /\[ref=/.test(l));
  if (!line) throw new Error(`no ${re} in:\n${text}`);
  return line.match(/\[ref=(\w+)\]/)![1];
};
const allText = (body: any) => (body.messages as any[]).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

const site = await startSiteServer({ port: REPLAY_PORT });
const url = `http://127.0.0.1:${REPLAY_PORT}/`;
const script: Script = (body, i) => {
  const last = lastToolResult(body);
  if (i === 0) return { toolCalls: [{ name: 'browser_open', arguments: { url: `${url}form.html` } }] };
  if (i === 1) return { toolCalls: [{ name: 'browser_snapshot', arguments: {} }] };
  if (i === 2) return { toolCalls: [{ name: 'browser_type', arguments: { ref: refIn(last, /textbox "Full name"/), text: 'Grace Hopper' } }, { name: 'browser_act', arguments: { ref: refIn(last, /checkbox "I accept the terms"/), action: 'check' } }] };
  if (i === 3) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /combobox "Color"/), action: 'select', value: 'Blue' } }] };
  if (i === 4) return { toolCalls: [{ name: 'browser_act', arguments: { ref: refIn(allText(body), /button "Place order"/), expect: { text_present: 'Order confirmed' } } }] };
  return { content: `Order placed: ${last.match(/ORD-[A-Z0-9-]+/)?.[0]}` };
};
const mock = await startMockServer(script);
const ws = tmpWorkspace({});
try {
  const cfg = testConfig(mock.url, { permissionMode: 'yolo', web: { searchProvider: 'none', fetchMaxChars: 40000, allowHosts: ['127.0.0.1'] }, browser: { enabled: true } });
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
  const res = await agent.run('place the order');
  await agent.dispose();
  if (!/ORD-GRACE-BLUE/.test(res.finalText)) throw new Error(`recording run failed: ${res.finalText}`);
  const runsDir = path.join(ws, '.tugline', 'runs');
  const run = path.join(runsDir, fs.readdirSync(runsDir)[0]);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.cpSync(run, OUT, { recursive: true });
  console.log(`recorded ${OUT}: ${fs.readdirSync(OUT).join(', ')}`);
} finally {
  await closeAllBrowserSessions();
  await mock.close();
  await site.close();
  fs.rmSync(ws, { recursive: true, force: true });
}
