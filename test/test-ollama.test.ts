/**
 * SPEC Z6: scripts/test-ollama.sh runs the suites against every model in `ollama list`
 * and writes a comparison report (WS8 extension: benchmark samples, vision check,
 * cost per resolved and tool-mode stats). Driven against a fake Ollama.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startMockServer, needsPytest, type MockServer } from './helpers.js';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts', 'test-ollama.sh');
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c();
});

test('Z6: test-ollama.sh is valid bash and avoids bash 4+ constructs (macOS ships bash 3.2)', () => {
  execFileSync('bash', ['-n', SCRIPT]);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  for (const [re, what] of [
    [/declare -A|local -A/, 'associative arrays'],
    [/\bmapfile\b|\breadarray\b/, 'mapfile/readarray'],
    [/\$\{[A-Za-z_]+(,,|\^\^)\}/, 'case-modifying expansions'],
    [/\|&/, '|&'],
    [/&>>/, '&>>'],
    [/;;&|;&/, 'case fall-through'],
    [/\bcoproc\b/, 'coproc'],
  ] as [RegExp, string][])
    assert.ok(!re.test(src), `uses ${what}`);
});

/** A fake Ollama: /api/tags, /api/show, /api/create, and /v1/* proxied to a scripted OpenAI mock. */
async function fakeOllama(): Promise<{ url: string; creates: string[]; visionAsked: string[] }> {
  const creates: string[] = [];
  const visionAsked: string[] = [];
  const llm: MockServer = await startMockServer((body) => {
    const text = JSON.stringify(body.messages);
    if (text.includes('image_url')) {
      visionAsked.push(body.model);
      return { content: body.model.includes('vision') ? '42 red' : 'I cannot see images' };
    }
    const done = body.messages.some((m: any) => m.role === 'tool');
    // The "coder" model fixes the count-errors benchmark task with bash; everything else just answers.
    if (body.model.includes('coder') && /error_count\.txt/.test(text) && Array.isArray(body.tools) && !done)
      return { toolCalls: [{ name: 'bash', arguments: { command: "awk '$3 == \"ERROR\"' app.log | wc -l | tr -d ' ' > error_count.txt" } }] };
    return { content: 'Done.' };
  });
  closers.push(llm.close);
  const caps: Record<string, string[]> = { 'coder:7b': ['completion', 'tools'], 'vision-vl:3b': ['completion', 'vision'], 'nomic-embed-text:latest': ['embedding'] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const json = (o: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.url === '/api/tags') return json({ models: Object.keys(caps).map((name) => ({ name })) });
      if (req.url === '/api/show') return json({ capabilities: caps[JSON.parse(raw).model] ?? caps[String(JSON.parse(raw).model).replace(/^oh-/, '').replace(/_/g, ':')] ?? ['completion'] });
      if (req.url === '/api/create') {
        creates.push(JSON.parse(raw).model);
        return json({ status: 'success' });
      }
      if (req.url?.startsWith('/v1/')) {
        const r = await fetch(llm.url.replace(/\/v1$/, '') + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'POST' ? raw : undefined });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, creates, visionAsked };
}

test('Z6: against every model in the (fake) Ollama — suites, benchmark samples with both arms, vision check, per-model comparison report', { timeout: 600_000, skip: needsPytest() }, async () => {
  const o = await fakeOllama();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ollama-out-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ollama-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TUG_BIN: `node --import tsx ${path.join(ROOT, 'src', 'cli', 'main.ts')}`, TUG_BENCH_ISOLATION: 'host' }; // v1.1 G5: the samples run on the host here (no container can reach PyPI)
  for (const k of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  const r = await new Promise<{ code: number | null; log: string }>((resolve) => {
    const p = spawn('bash', [SCRIPT, '--url', o.url, '--suites', 'coding-basics', '--quick', '--out', out, '--price', '0.15,0.60'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => resolve({ code, log }));
  });
  assert.equal(r.code, 0, r.log.slice(-3000));
  const report = fs.readFileSync(path.join(out, 'REPORT.md'), 'utf8');
  // derived context tags for the two chat models only
  assert.deepEqual(o.creates.sort(), ['oh-coder_7b', 'oh-vision-vl_3b']);
  // vision check only for the vision model
  assert.deepEqual(o.visionAsked, ['oh-vision-vl_3b']);
  assert.match(fs.readFileSync(path.join(out, 'vision-vl_3b', 'vision.txt'), 'utf8'), /^pass\t42 red/);
  const row = (m: string) => report.split('\n').find((l) => l.startsWith(`| ${m} |`)) ?? '';
  const coder = row('coder:7b');
  const vis = row('vision-vl:3b');
  assert.ok(coder && vis, report);
  assert.match(row('nomic-embed-text:latest'), /\| skipped \|/);
  // tool mode stats: native for the tools-capable model, text otherwise
  assert.match(coder, /\| native×\d+ \|/);
  assert.match(vis, /\| text×\d+ \|/);
  assert.match(vis, /\| pass \|/, 'vision column');
  assert.match(coder, /\| - \| native/, 'no vision check for a non-vision model');
  // the coder resolved the count-errors benchmark task in both arms: cost/tokens per resolved are numbers
  assert.match(coder, /\| 2\/5 \| 40% \| 0\.0000 \| 0\.\d{4} \| \d+ \|/); // 1 coding task + 2 bench formats × 2 arms; TB solved in both arms
  assert.match(coder, /\| 1\/2 vs 1\/2 \|$/, 'bash-only vs full tools on the benchmark samples');
  assert.match(vis, /\| n\/a \|/, 'nothing resolved → $/resolved n/a');
  // ranking: the model that resolved more comes first
  assert.ok(report.indexOf('| coder:7b |') < report.indexOf('| vision-vl:3b |'));
  // per-suite detail with both bench arms
  assert.match(report, /\| coder:7b \| bench:terminal-bench \| bash-only \| 1 \| 1\/1 \|/);
  assert.match(report, /\| coder:7b \| bench:terminal-bench \| default \| 1 \| 1\/1 \|/);
  assert.match(report, /\| coder:7b \| coding-basics \| guarded \| 1 \|/);
  assert.ok(fs.existsSync(path.join(out, 'coder_7b', 'coding-basics', 'report.md')));
  assert.ok(fs.existsSync(path.join(out, 'coder_7b', 'bench-swe-bench', 'report.md')));
});
