import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, deepMerge, type HarnessConfig } from '../src/core/config.js';

export interface MockReply {
  status?: number;
  errorBody?: string;
  content?: string;
  reasoning?: string;
  toolCalls?: { name: string; arguments: unknown }[];
  finishReason?: string;
  /** stream the reply as SSE (default true when request asks for stream) */
  noUsage?: boolean;
}

export type Script = (body: any, callIndex: number) => MockReply;

export interface MockServer {
  url: string;
  requests: any[];
  close: () => Promise<void>;
}

/** A tiny OpenAI-compatible server driven by a script function. */
export async function startMockServer(script: Script): Promise<MockServer> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const idx = requests.length;
      requests.push(body);
      const r = script(body, idx);
      if (r.status && r.status >= 400) {
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.errorBody ?? JSON.stringify({ error: { message: 'mock error' } }));
        return;
      }
      const toolCalls = (r.toolCalls ?? []).map((t, i) => ({ index: i, id: `call${idx}x${i}`, type: 'function', function: { name: t.name, arguments: typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments) } }));
      const usage = r.noUsage ? undefined : { prompt_tokens: 100 + idx, completion_tokens: 20 };
      const finish = r.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop');
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (r.reasoning) send({ choices: [{ index: 0, delta: { reasoning_content: r.reasoning } }] });
        if (r.content) {
          // split content to exercise streaming
          const parts = r.content.match(/[\s\S]{1,7}/g) ?? [];
          for (const p of parts) send({ choices: [{ index: 0, delta: { content: p } }] });
        }
        for (const tc of toolCalls) {
          const a = tc.function.arguments;
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: '' } }] } }] });
          const half = Math.floor(a.length / 2);
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: a.slice(0, half) } }] } }] });
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: tc.index, function: { arguments: a.slice(half) } }] } }] });
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
        if (usage && body.stream_options) send({ choices: [], usage });
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: r.content ?? '', reasoning_content: r.reasoning, tool_calls: toolCalls.length ? toolCalls.map(({ index, ...t }) => t) : undefined }, finish_reason: finish }], usage }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Temporary workspaces and homes made by these helpers are removed when the test process exits
 * (78k of them had filled the CI machine's disk). Set TUG_KEEP_TMP=1 to keep them for debugging.
 */
const madeTmp: string[] = [];
let cleanupHooked = false;
export function trackTmp(dir: string): string {
  madeTmp.push(dir);
  if (!cleanupHooked && process.env.TUG_KEEP_TMP !== '1') {
    cleanupHooked = true;
    process.on('exit', () => {
      for (const d of madeTmp) {
        try {
          fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 });
        } catch {
          // a file still held by a child process; the OS temp cleaner gets it later
        }
      }
    });
  }
  return dir;
}

export function tmpWorkspace(files: Record<string, string> = {}): string {
  const dir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-test-')));
  for (const [f, c] of Object.entries(files)) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  }
  return fs.realpathSync(dir);
}

export function testConfig(baseUrl: string, over: any = {}): HarnessConfig {
  const home = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-home-')));
  return deepMerge(defaultConfig(), deepMerge({
    homeDir: home,
    profiles: { default: { baseUrl, model: 'mock-model', apiKey: 'sk-test-1234567890abcdef', contextWindow: 32768, maxOutputTokens: 1024, toolMode: 'auto', timeoutMs: 20_000 } },
    web: { searchProvider: 'none' },
    // N30 made shell.sandbox default to "auto" and scheduled/daemon/remote runs require a sandbox; tests that are
    // not about the sandbox run on the host (they use localhost mock servers). The N30 tests undo both.
    shell: { sandbox: 'none', requireSandbox: false },
  }, over));
}

/** Last user/tool message text in a request body */
export function lastToolResult(body: any): string {
  const msgs = body.messages as any[];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'tool' || msgs[i].role === 'user') return String(msgs[i].content);
  return '';
}

let pytestSkip: string | false | undefined;
/**
 * `false` when `python3 -m pytest` works, otherwise a skip reason (R7: the
 * active Python on the user's Mac had no pytest, so pytest-scored benchmark
 * tests failed for an environment reason). With TUG_REQUIRE_PYTEST=1 (CI)
 * nothing is skipped, so a missing pytest fails loudly instead.
 */
export function needsPytest(): string | false {
  if (pytestSkip === undefined) {
    if (process.env.TUG_REQUIRE_PYTEST === '1') pytestSkip = false;
    else {
      const r = spawnSync('python3', ['-m', 'pytest', '--version'], { encoding: 'utf8', timeout: 60_000 });
      const why = r.error?.message ?? String(r.stderr ?? '').trim().split('\n').pop() ?? `exit ${r.status}`;
      pytestSkip = r.status === 0 ? false : `needs pytest: \`python3 -m pytest --version\` failed (${why}); install it with \`python3 -m pip install pytest\``;
    }
  }
  return pytestSkip;
}
