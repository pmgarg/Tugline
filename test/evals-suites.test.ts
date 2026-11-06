/**
 * SPEC I1: per-domain eval suites run via `tug eval` and produce report.md (WS8: suite wiring + the coding suite).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startMockServer, type MockServer } from './helpers.js';
import { loadSuite } from '../src/core/eval/runner.js';

const ROOT = process.cwd();
/** What a model would do with bash to fix t04 (then run the tests, so the pass is verified). */
const FIX_T04 = [
  "cat > text.js <<'EOF'",
  "'use strict';",
  'function wordCount(text) { return text.split(/\\s+/).filter(Boolean).length; }',
  "function firstWords(text, n) { return text.trim().split(/\\s+/).slice(0, n).join(' '); }",
  'module.exports = { wordCount, firstWords };',
  'EOF',
  'node --test',
].join('\n');
const servers: MockServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src', 'cli', 'main.ts'), ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('I1 AC1 (coding): `tug eval evals/coding-basics` through the real CLI writes report.md with the S18 fields per arm', async () => {
  // t04 is fixed by the scripted model; t05 is honestly given up on.
  const mock = await startMockServer((body) => {
    const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content ?? '');
    const done = body.messages.some((m: any) => m.role === 'tool');
    if (/wordCount/.test(prompt))
      return done ? { content: 'Fixed wordCount; node --test passes.' } : { toolCalls: [{ name: 'bash', arguments: { command: FIX_T04 } }] };
    return { content: 'I could not find the bug in the time available.' };
  });
  servers.push(mock);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-i1-home-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-i1-out-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, TUG_BASE_URL: mock.url, TUG_MODEL: 'mock-model', TUG_API_KEY: 'sk-test-1234567890abcdef' };
  const r = await cli(['eval', 'evals/coding-basics', '--tasks', 't04-js-word-count,t05-nested-config-merge', '--arms', 'guarded', '--out', out], env);
  assert.equal(r.code, 0, r.out);
  const report = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  // the four S18 fields: outcome, integrity, verification, cost
  assert.match(report, /\| arm \| runs \| pass \| verified_pass \| unverified_pass \| honest_failure \| false_success \| protected_write \| attempted \| not_evaluable \| median s \| median tokens \| total \$ \| \$ \/ resolved \|/);
  assert.match(report, /\| guarded \| 2 \| 1 \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(report, /\| t04-js-word-count__guarded__r1 \| t04-js-word-count \| guarded \| pass \| clean \| verified_pass \|/);
  assert.match(report, /\| t05-nested-config-merge__guarded__r1 \| t05-nested-config-merge \| guarded \| fail \| clean \| honest_failure \|/);
  assert.equal(fs.readdirSync(path.join(out, 'runs')).length, 2, 'raw records kept for rescoring');
  // rescoring the raw runs needs no model
  const re = await cli(['rescore', out], { ...env, TUG_BASE_URL: 'http://127.0.0.1:9/v1' });
  assert.equal(re.code, 0, re.out);
  assert.match(re.out, /\| guarded \| 2 \| 1 \|/);
});

test('I1: every eval suite in evals/ is well-formed (suite.json arms, tasks with prompt, acceptance and a fixture repo)', () => {
  const suites = fs.readdirSync(path.join(ROOT, 'evals')).filter((d) => fs.existsSync(path.join(ROOT, 'evals', d, 'suite.json')));
  for (const want of ['coding-basics', 'editing', 'browser']) assert.ok(suites.includes(want), `suite ${want}`);
  for (const s of suites) {
    const dir = path.join(ROOT, 'evals', s);
    const { suite, tasks } = loadSuite(dir, { SITE: 'http://127.0.0.1:1/' });
    assert.ok(Object.keys(suite.arms).length >= 1, `${s}: arms`);
    assert.ok(tasks.length >= (s === 'coding-basics' ? 5 : 1), `${s}: tasks`);
    for (const t of tasks) {
      assert.ok(t.prompt && t.prompt.length > 10, `${s}/${t.id}: prompt`);
      assert.ok(Array.isArray(t.acceptance) && t.acceptance.length, `${s}/${t.id}: acceptance`);
      assert.ok(fs.existsSync(path.join(t.dir, 'repo')), `${s}/${t.id}: repo/`);
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(t.prompt + t.acceptance.join(' ')), `${s}/${t.id}: unresolved {{VAR}}`);
    }
  }
});
