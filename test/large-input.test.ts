/** A pasted error or log larger than the model's context: shortened to head + tail, full text saved for the tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fitLargeInput } from '../src/core/agent/largeInput.js';
import { estimateTokens } from '../src/core/util/text.js';
import { tmpWorkspace } from './helpers.js';

function stackTrace(frames: number): string {
  const l = ['My app crashes with this error, fix it:', 'Traceback (most recent call last):'];
  for (let i = 0; i < frames; i++) l.push(`  File "/srv/app/m${i % 40}/service_${i}.py", line ${100 + i}, in handler_${i}`, `    result = self.backend.call(payload, timeout=T${i % 9})`);
  l.push('ConnectionError: upstream returned 502 Bad Gateway after 3 retries');
  return l.join('\n');
}

test('large input: a message that fits is sent unchanged and nothing is written', () => {
  const ws = tmpWorkspace({});
  const r = fitLargeInput('fix the failing test in calc.py', 1000, ws);
  assert.equal(r.text, 'fix the failing test in calc.py');
  assert.equal(r.saved, undefined);
  assert.equal(fs.existsSync(path.join(ws, '.tugline')), false);
});

test('large input: a stack trace over the budget keeps its first and last lines, fits, and the full text is saved out of git', () => {
  const ws = tmpWorkspace({});
  const text = stackTrace(1500);
  assert.ok(estimateTokens(text) > 30_000);
  const r = fitLargeInput(text, 6000, ws, new Date('2026-11-12T23:15:12Z'), 'abc123');
  assert.ok(estimateTokens(r.text) <= 6000, `${estimateTokens(r.text)} tokens`);
  assert.ok(r.text.startsWith('My app crashes with this error, fix it:\nTraceback (most recent call last):'), 'the request and the first frames');
  assert.ok(r.text.endsWith('ConnectionError: upstream returned 502 Bad Gateway after 3 retries'), 'the exception at the end');
  assert.equal(r.saved?.rel, '.tugline/pastes/paste-20261112-231512-abc123.txt');
  assert.match(r.text, /lines left out: this message was about [\d,]+ tokens, too large for the model's context\. The full text \(3,003 lines\) is saved at \.tugline\/pastes\/paste-20261112-231512-abc123\.txt; search it with grep or read a line range with read_file/);
  assert.equal(fs.readFileSync(path.join(ws, r.saved!.rel), 'utf8'), text, 'the full text, unchanged');
  assert.equal(fs.readFileSync(path.join(ws, '.tugline', 'pastes', '.gitignore'), 'utf8'), '*\n', 'never committed');
  assert.equal(r.saved?.lines, 3003);
  assert.ok(r.saved!.keptLines > 20 && r.saved!.keptLines < 3003);
});

test('large input: one enormous line (minified output) keeps both ends', () => {
  const ws = tmpWorkspace({});
  const text = `START${'x'.repeat(200_000)}END`;
  const r = fitLargeInput(text, 2000, ws);
  assert.ok(r.text.startsWith('STARTxxx'));
  assert.ok(r.text.endsWith('xxxEND'));
  assert.match(r.text, /part of a line left out/);
  assert.ok(estimateTokens(r.text) <= 2000, `${estimateTokens(r.text)} tokens`);
});

test('large input (agent): an oversized message is shortened before it is sent, with a notice, and the agent can read the rest', async () => {
  const { Agent } = await import('../src/core/agent/agent.js');
  const { startMockServer, testConfig } = await import('./helpers.js');
  const ws = tmpWorkspace({});
  const srv = await startMockServer(() => ({ content: 'The cause is the 502 from upstream.' }));
  const notices: string[] = [];
  const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0 } });
  cfg.profiles[cfg.profile].contextWindow = 8192;
  cfg.profiles[cfg.profile].maxOutputTokens = 1024;
  const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { onEvent: (e: any) => e.type === 'notice' && notices.push(e.message) } });
  const text = stackTrace(2000);
  const r = await agent.run(text);
  await srv.close();
  await agent.dispose();
  assert.equal(r.stopReason, 'end_turn');
  const sent = String(srv.requests[0].messages.filter((m: any) => m.role === 'user').at(-1).content);
  assert.ok(estimateTokens(sent) < 8192 - 1024, `the message fits (${estimateTokens(sent)} tokens)`);
  assert.ok(sent.startsWith('My app crashes with this error, fix it:'));
  assert.match(sent, /ConnectionError: upstream returned 502 Bad Gateway after 3 retries/);
  const rel = /saved at (\.tugline\/pastes\/[^;]+\.txt);/.exec(sent)?.[1];
  assert.ok(rel, 'names the saved file');
  assert.equal(fs.readFileSync(path.join(ws, rel!), 'utf8'), text);
  assert.ok(notices.some((n) => /too large for the model's 8,192-token context[\s\S]*\.tugline\/pastes\//.test(n)), notices.join('\n'));
});

test('large input: a huge first line followed by short lines keeps its start (and the end of the text)', () => {
  const ws = tmpWorkspace({});
  const text = `HEAD${'x'.repeat(100_000)}\n${Array.from({ length: 50 }, (_, i) => `short ${i}`).join('\n')}\nTHE END`;
  const r = fitLargeInput(text, 3000, ws);
  assert.ok(r.text.startsWith('HEADxxx'), r.text.slice(0, 40));
  assert.ok(r.text.endsWith('THE END'));
  assert.ok(estimateTokens(r.text) <= 3000, `${estimateTokens(r.text)} tokens`);
});
