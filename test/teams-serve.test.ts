/**
 * v1.2 WS17 over `tug serve` (G2 JSON-RPC): team events stream to the client (N34), `/team` and `/goal`
 * (without a check, judged by the independent verifier, N35) work through `session/command`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server/server.js';
import { OhClient } from '../src/server/client.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';
import type { AgentEvent } from '../src/core/types.js';

const sys = (b: any) => String(b.messages[0]?.content ?? '');
const toolN = (b: any) => b.messages.filter((m: any) => m.role === 'tool').length;

test('N34/N35 tug serve: team events stream to the client; /team status and /goal (verifier) run through session/command', async () => {
  const ws = tmpWorkspace({ 'calc.py': 'def add(a, b):\n    return a + b\n' });
  const llm = await startMockServer((b) => {
    if (sys(b).includes('independent goal verifier')) return { content: JSON.stringify({ met: true, reasons: ['ok'], evidence: [{ file: 'calc.py', line: 2, quote: 'return a + b' }] }) };
    if (/a member of the agent team/.test(sys(b))) return toolN(b) ? { content: 'ok' } : { toolCalls: [{ name: 'team_send', arguments: { to: 'lead', text: 'hi lead' } }] };
    if (String(b.messages.find((m: any) => m.role === 'user')?.content ?? '').startsWith('[goal]')) return { content: 'done' };
    const steps = [
      { name: 'team_create', arguments: { name: 'srv', members: [{ name: 'w', isolation: 'shared' }] } },
      { name: 'team_task_add', arguments: { id: 'a', title: 'task a' } },
      { name: 'team_wait', arguments: { timeout_s: 20 } },
    ];
    return toolN(b) < steps.length ? { toolCalls: [steps[toolN(b)]!] } : { content: 'lead done' };
  });
  const base = { checkpoints: { enabled: false }, agent: { requireVerification: false, repoMapTokens: 0, harnessCheck: 'off' }, team: { idleTimeoutMs: 3000 } };
  const config = testConfig(llm.url, base);
  const srv = await startServer({ workspace: ws, config, port: 0, configFor: (_w, o) => ({ ...testConfig(llm.url, { ...base, ...o }), homeDir: config.homeDir }) });
  const events: AgentEvent[] = [];
  const client = await OhClient.connect(srv.url, srv.token, { onEvent: (_s, e) => events.push(e), onPermission: () => ({ decision: 'deny' }) });
  try {
    await client.initialize();
    const s = await client.createSession({ mode: 'yolo' });
    await client.prompt(s.sessionId, 'use a team');
    const team = events.filter((e) => e.type === 'team') as Extract<AgentEvent, { type: 'team' }>[];
    for (const ph of ['created', 'member', 'task', 'message']) assert.ok(team.some((e) => e.phase === ph), `team ${ph} event streamed`);
    const status = await client.request('session/command', { sessionId: s.sessionId, name: 'team', args: 'status' });
    assert.match(status.output, /Team "srv"[\s\S]*w \[/);
    const dis = await client.request('session/command', { sessionId: s.sessionId, name: 'team', args: 'disband' });
    assert.match(dis.output, /Team "srv" disbanded/);
    const goal = await client.request('session/command', { sessionId: s.sessionId, name: 'goal', args: 'calc.py adds two numbers --max-turns 2' });
    assert.match(goal.output, /\[goal\] met after 1 iteration\(s\) — judged met \(independent verifier\)/);
    const g = events.filter((e) => e.type === 'goal') as any[];
    assert.ok(g.some((e) => e.phase === 'end' && e.label === 'judged met (independent verifier)'), 'the goal event with its label reached the client');
  } finally {
    client.close();
    await srv.close();
    await llm.close();
  }
});

test('N34 RF12: A2A inbound with per-caller grants: the owner issues a grant; the caller reaches only a2a/delegate; its work is narrowed to the grant, starts tainted, and can approve nothing', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const { WebSocket } = await import('ws');
  let hits = 0;
  const target = http.createServer((_q, r) => (hits++, r.end('secret page')));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(target.address() as any).port}/x`;
  const ws = tmpWorkspace({ 'notes.md': 'release on friday\n' });
  const llm = await startMockServer((b) => {
    const n = toolN(b);
    if (n === 0) return { toolCalls: [{ name: 'read_file', arguments: { path: 'notes.md' } }] };
    if (n === 1) return { toolCalls: [{ name: 'bash', arguments: { command: `curl -s --max-time 3 ${url}` } }] };
    return { content: `A2A done: ${String(b.messages.filter((m: any) => m.role === 'tool').at(-1).content).slice(0, 200)}` };
  });
  const base = { checkpoints: { enabled: false }, agent: { requireVerification: false, repoMapTokens: 0, harnessCheck: 'off' }, permissionMode: 'yolo' };
  const config = testConfig(llm.url, base);
  const srv = await startServer({ workspace: ws, config, port: 0 });
  const owner = await OhClient.connect(srv.url, srv.token, { onPermission: () => ({ decision: 'deny' }) });
  // a raw caller: it never sends `auth` (it has no server token), only its grant secret. A connection that tries
  // anything else is closed (unauthorized), so each call uses its own connection.
  const call = async (method: string, params: unknown) => {
    const raw = new WebSocket(srv.url);
    await new Promise((r) => raw.once('open', r));
    try {
      return await new Promise<any>((resolve) => {
        raw.on('message', (d: any) => resolve(JSON.parse(String(d))));
        raw.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      });
    } finally {
      raw.close();
    }
  };
  try {
    await owner.initialize();
    const { grant, secret } = await owner.request('a2a/grants/issue', { caller: 'acme-bot', workspace: ws, tools: ['read_file', 'bash', 'not_a_tool'], maxTokens: 50_000 });
    assert.match(secret, /^oha2a_/);
    const stored = fs.readFileSync(`${config.homeDir}/a2a-grants.json`, 'utf8');
    assert.ok(!stored.includes(secret), 'only a digest is stored');
    assert.equal(fs.statSync(`${config.homeDir}/a2a-grants.json`).mode & 0o777, 0o600);
    // the grant reaches nothing else; a wrong secret is refused
    assert.equal((await call('session/list', { secret })).error.code, -32001);
    assert.equal((await call('a2a/grants/list', { secret })).error.code, -32001);
    assert.equal((await call('a2a/delegate', { secret: 'oha2a_wrong', task: 'x' })).error.code, -32001);
    const res = await call('a2a/delegate', { secret, task: 'Summarise notes.md, then fetch the page' });
    assert.ok(res.result, JSON.stringify(res.error));
    assert.equal(res.result.caller, 'acme-bot');
    // narrowed to the grant (and the owner's config): the model saw only the granted tools
    const req = llm.requests[0];
    const names = (req.tools ?? []).map((t: any) => t.function.name).sort();
    assert.ok(names.every((n: string) => ['read_file', 'bash', 'tool_search'].includes(n)), names.join(','));
    assert.match(String(req.messages.find((m: any) => m.role === 'user').content), /<untrusted_a2a_request caller="acme-bot">\nSummarise notes\.md/);
    // tainted from the start: its egress needed approval, nobody can approve an A2A request: denied, never fetched
    assert.equal(hits, 0, 'the page was never fetched');
    assert.ok(!/secret page/.test(res.result.text), res.result.text);
    // G1: bash runs in the A2A sandbox with no network: curl cannot connect (exit 7), or the ask was denied
    assert.match(res.result.text, /A2A done: exit [1-9]|A2A requests run without a human/);
    // the owner can revoke it; the secret stops working
    assert.deepEqual(await owner.request('a2a/grants/revoke', { id: grant.id }), { revoked: true });
    assert.equal((await call('a2a/delegate', { secret, task: 'again' })).error.code, -32001);
    // a client token (not the owner) cannot issue grants
    const tok = await owner.request('tokens/issue', { label: 'c' });
    const other = await OhClient.connect(srv.url, tok.token, { onPermission: () => ({ decision: 'deny' }) });
    await assert.rejects(other.request('a2a/grants/issue', { caller: 'x', workspace: ws }), /only the server owner/);
    other.close();
  } finally {
    owner.close();
    await srv.close();
    await llm.close();
    target.close();
  }
});

// ------------------------------------------------------------ recheck G1–G3 (A2A)

/** H1: secret files the A2A tests track in git (so they are in the request's worktree) */
const TRACKED_SECRETS: Record<string, string> = {
  '.env': 'DB_PASSWORD=ENV-CANARY-999\n',
  'config/secrets.yaml': 'db_password: YAML-CANARY-31337\n',
  'certs/server.pem': '-----BEGIN PRIVATE KEY----- PEM-CANARY-4242\n',
  'keys/id_ed25519': 'SSH-CANARY-1717 private key\n',
  'credentials.json': '{"token": "CRED-CANARY-5151"}\n',
};
const CANARY = /ENV-CANARY|YAML-CANARY|PEM-CANARY|SSH-CANARY|CRED-CANARY/;

async function a2aServer(script: (b: any) => any, o: { git?: boolean; files?: Record<string, string>; trackSecrets?: boolean } = {}) {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { WebSocket } = await import('ws');
  const { resetA2AFailures } = await import('../src/core/agent/team/a2a.js');
  resetA2AFailures();
  const ws = tmpWorkspace({ '.env': 'DB_PASSWORD=ENV-CANARY-999\n', 'notes.md': 'release on friday\n', ...(o.trackSecrets ? TRACKED_SECRETS : {}), ...(o.files ?? {}) });
  if (o.git) {
    if (!o.trackSecrets) fs.writeFileSync(`${ws}/.gitignore`, '.env\n');
    for (const c of [['init', '-q', '-b', 'main'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i']]) execFileSync('git', c, { cwd: ws });
  }
  const llm = await startMockServer(script);
  // the owner's server runs in auto: the grant must not inherit it
  const config = testConfig(llm.url, { checkpoints: { enabled: false }, agent: { requireVerification: false, repoMapTokens: 0, harnessCheck: 'off' }, permissionMode: 'yolo' });
  const srv = await startServer({ workspace: ws, config, port: 0 });
  const owner = await OhClient.connect(srv.url, srv.token, { onPermission: () => ({ decision: 'deny' }) });
  await owner.initialize();
  const open = async () => {
    const sock = new WebSocket(srv.url);
    await new Promise((r) => sock.once('open', r));
    let id = 0;
    const closed = new Promise<number>((r) => sock.once('close', (c: number) => r(c)));
    const call = (method: string, params: unknown, timeoutMs = 60_000) =>
      new Promise<any>((resolve) => {
        const my = ++id;
        const t = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        const on = (d: any) => {
          const m = JSON.parse(String(d));
          if (m.id === my) (clearTimeout(t), sock.off('message', on), resolve(m));
        };
        sock.on('message', on);
        closed.then((c) => (clearTimeout(t), resolve({ closed: c })));
        sock.send(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }));
      });
    return { sock, call, closed };
  };
  const done = async () => (owner.close(), await srv.close(), await llm.close());
  return { ws, llm, srv, owner, open, config, done };
}
const firstUser = (b: any) => String(b.messages.find((m: any) => m.role === 'user')?.content ?? '');

test('N34 RH1: an A2A grant runs confined: its own worktree (or an empty scratch dir), ask/plan only (never the owner\'s auto), read-only tools by default; TRACKED secret files never reach the caller (read, grep, glob, list, bash); nothing outside; bash only in a read-only network-off sandbox', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-a2a-out-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-CANARY-777\n');
  const t = await a2aServer((b) => {
    const u = firstUser(b);
    const n = toolN(b);
    const outs = () => b.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).join(' | ');
    if (/READ/.test(u)) {
      const steps = [
        { name: 'read_file', arguments: { path: '.env' } },
        { name: 'read_file', arguments: { path: 'config/secrets.yaml' } },
        { name: 'read_file', arguments: { path: 'certs/server.pem' } },
        { name: 'read_file', arguments: { path: 'keys/id_ed25519' } },
        { name: 'read_file', arguments: { path: 'credentials.json' } },
        { name: 'grep', arguments: { pattern: 'CANARY', path: '.', output_mode: 'content' } },
        { name: 'grep', arguments: { pattern: 'CANARY', path: '.' } },
        { name: 'glob', arguments: { pattern: '**/*' } },
        { name: 'list_dir', arguments: { path: '.' } },
        { name: 'read_file', arguments: { path: path.join(outside, 'secret.txt') } },
        { name: 'read_file', arguments: { path: '../' + path.basename(outside) + '/secret.txt' } },
        { name: 'read_file', arguments: { path: 'notes.md' } },
      ];
      return n < steps.length ? { toolCalls: [steps[n]!] } : { content: `READ: ${outs()}` };
    }
    if (/CMD/.test(u)) {
      const steps = [{ name: 'bash', arguments: { command: 'touch made-by-a2a; echo touched=$?' } }, { name: 'bash', arguments: { command: 'cat .env config/secrets.yaml certs/server.pem keys/id_ed25519 credentials.json; grep -r CANARY . ; echo envexit=$?' } }, { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }];
      return n < steps.length ? { toolCalls: [steps[n]!] } : { content: `CMD: ${outs()}` };
    }
    return { content: `tools: ${(b.tools ?? []).map((x: any) => x.function.name).sort().join(',')}` };
  }, { git: true, trackSecrets: true });
  try {
    await assert.rejects(t.owner.request('a2a/grants/issue', { caller: 'c', workspace: t.ws, mode: 'auto' }), /runs in "ask" \(default\) or "plan", never "auto"/);
    await assert.rejects(t.owner.request('a2a/grants/issue', { caller: 'c', workspace: t.ws, mode: 'acceptEdits' }), /never "acceptEdits"/);
    const plain = await t.owner.request('a2a/grants/issue', { caller: 'plain', workspace: t.ws });
    const c1 = await t.open();
    const tools = (await c1.call('a2a/delegate', { secret: plain.secret, task: 'which tools?' })).result;
    assert.equal(tools.workdir, 'worktree');
    assert.match(tools.text, /^tools: (glob,)?(grep,)?(list_dir,)?read_file(,tool_search)?$/, `read-only tools by default: ${tools.text}`);
    const c2 = await t.open();
    const read = (await c2.call('a2a/delegate', { secret: plain.secret, task: 'READ everything' })).result.text;
    assert.ok(!CANARY.test(read), `no tracked secret file reaches the caller through read_file, grep, glob or list_dir: ${read.slice(0, 600)}`);
    assert.match(read, /skipped secret file/, 'the search results say a secret file was skipped');
    assert.match(read, /looks like a secret/, 'read_file refuses it');
    assert.ok(!read.includes('OUTSIDE-CANARY-777'), 'nothing outside its directory');
    assert.match(read, /release on friday/, 'the project files are there');
    const wide = await t.owner.request('a2a/grants/issue', { caller: 'wide', workspace: t.ws, tools: ['read_file', 'bash', 'write_file', 'web_fetch'] });
    const c3 = await t.open();
    const cmd = (await c3.call('a2a/delegate', { secret: wide.secret, task: 'CMD run things' })).result.text;
    assert.match(cmd, /touched=1/, 'its directory is read-only inside the sandbox');
    assert.ok(!CANARY.test(cmd), `tracked secret files are hidden from commands too: ${cmd}`);
    assert.match(cmd, /A2A requests run without a human|denied|Refused/i, 'a write needs approval in ask mode, and nobody approves');
    assert.ok(!fs.existsSync(path.join(t.ws, 'made-by-a2a')) && !fs.existsSync(path.join(t.ws, 'x.txt')), 'the owner\'s workspace is untouched');
    const req = t.llm.requests.find((b) => /CMD/.test(firstUser(b)))!;
    assert.ok(!(req.tools ?? []).some((x: any) => x.function.name === 'web_fetch'), 'no network tools, even when the grant names one');
    // the worktree and its branch are gone afterwards
    const { execFileSync } = await import('node:child_process');
    assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: t.ws }).toString().trim().split('\n').length, 1);
    assert.equal(execFileSync('git', ['branch', '--list', 'oh/a2a-*'], { cwd: t.ws }).toString().trim(), '');
  } finally {
    await t.done();
  }
});

test('N34 RG1: in a workspace that is not a git repository, the A2A work runs in an empty scratch directory (no project files, no .env)', async () => {
  const t = await a2aServer((b) => (toolN(b) ? { content: `ls: ${String(b.messages.filter((m: any) => m.role === 'tool').at(-1).content).slice(0, 200)}` } : { toolCalls: [{ name: 'read_file', arguments: { path: 'notes.md' } }] }));
  try {
    const g = await t.owner.request('a2a/grants/issue', { caller: 'c', workspace: t.ws });
    const c = await t.open();
    const r = (await c.call('a2a/delegate', { secret: g.secret, task: 'read notes' })).result;
    assert.equal(r.workdir, 'scratch');
    assert.ok(!/release on friday/.test(r.text), r.text);
  } finally {
    await t.done();
  }
});

test('N34 RG2: a wrong A2A secret closes the connection at once (nothing more is read from it); from the 4th failure the source waits; failures are audited; grants are looked up by the secret\'s hash', async () => {
  const fs = await import('node:fs');
  const t = await a2aServer(() => ({ content: 'ok' }));
  try {
    const g = await t.owner.request('a2a/grants/issue', { caller: 'c', workspace: t.ws });
    const stored = JSON.parse(fs.readFileSync(`${t.config.homeDir}/a2a-grants.json`, 'utf8'));
    assert.ok(stored.byHash && !Array.isArray(stored.grants), 'stored keyed by hash');
    const c = await t.open();
    const first = await c.call('a2a/delegate', { secret: 'oha2a_' + 'x'.repeat(43), task: 't' });
    assert.equal(first.error?.code, -32001);
    const second = await c.call('a2a/delegate', { secret: g.secret, task: 't' }, 3000);
    assert.ok(second.closed || second.timeout, 'nothing more is answered on that connection');
    assert.equal(await c.closed, 4401);
    for (let i = 0; i < 4; i++) await (await t.open()).call('a2a/delegate', { id: g.grant.id, secret: `oha2a_${'y'.repeat(40)}${i}`, task: 't' });
    const blocked = await (await t.open()).call('a2a/delegate', { id: g.grant.id, secret: g.secret, task: 't' });
    assert.equal(blocked.error?.code, -32002, 'during the backoff even a valid secret is not checked');
    assert.match(blocked.error.message, /too many failed A2A secrets/);
    const audit = fs.readFileSync(`${t.config.homeDir}/a2a-audit.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(audit.filter((a) => a.event === 'bad_secret').length, 5);
    assert.ok(!JSON.stringify(audit).includes(g.secret));
  } finally {
    await t.done();
  }
});

test('N34 RG3: a verified A2A call outlives the 10 s pre-auth timeout and gets its result; when the caller disconnects, or the grant is revoked, the run stops (no more model calls)', { timeout: 120_000 }, async () => {
  const t = await a2aServer((b) => {
    const u = firstUser(b);
    if (/LONG/.test(u)) return toolN(b) ? { content: 'long done' } : { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 12; echo slept' } }] };
    if (/DROP|REVOKE/.test(u)) return toolN(b) ? { content: 'should not get here' } : { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 4; echo slept' } }] };
    return { content: 'ok' };
  });
  try {
    const g = await t.owner.request('a2a/grants/issue', { caller: 'c', workspace: t.ws, tools: ['bash'] });
    const c = await t.open();
    const r = await c.call('a2a/delegate', { secret: g.secret, task: 'LONG job' }, 60_000);
    assert.equal(r.result?.text, 'long done', JSON.stringify(r).slice(0, 200));
    // disconnect mid-run
    const d = await t.open();
    void d.call('a2a/delegate', { secret: g.secret, task: 'DROP me' }, 60_000);
    await new Promise((res) => setTimeout(res, 1500));
    // one request in flight per grant
    const busy = await (await t.open()).call('a2a/delegate', { secret: g.secret, task: 'second' }, 10_000);
    assert.equal(busy.error?.code, -32002);
    assert.match(busy.error.message, /already has a request running/);
    d.sock.close();
    await new Promise((res) => setTimeout(res, 6000));
    assert.equal(t.llm.requests.filter((b) => /DROP/.test(firstUser(b))).length, 1, 'no model call after the caller left');
    // revoke mid-run
    const e = await t.open();
    const pending = e.call('a2a/delegate', { secret: g.secret, task: 'REVOKE me' }, 60_000);
    await new Promise((res) => setTimeout(res, 1500));
    await t.owner.request('a2a/grants/revoke', { id: g.grant.id });
    const rv = await pending;
    assert.equal(rv.result?.stopReason, 'aborted', JSON.stringify(rv).slice(0, 200));
    assert.equal(t.llm.requests.filter((b) => /REVOKE/.test(firstUser(b))).length, 1, 'no model call after the revoke');
  } finally {
    await t.done();
  }
});

test('N34 RH1: each A2A result filter holds on its own: the hidden-file hook keeps a search tool from reading secret files, and an output line that names one is replaced', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { confine } = await import('../src/core/agent/team/a2a.js');
  const ws = tmpWorkspace({ ...TRACKED_SECRETS, 'app.py': 'x = "APP"\n' });
  const files = Object.keys(TRACKED_SECRETS).concat('app.py');
  // a tool that walks the tree and honours the policy's hidden hook, printing in a form the line filter cannot parse
  const walker = { name: 'code_search', kind: 'read', readOnly: true, description: '', parameters: { type: 'object', properties: {} }, title: () => '', run: async (_a: any, ctx: any) => ({ output: files.filter((f) => !ctx.policy?.isHidden?.(path.join(ws, f))).map((f) => `match in ${f}: ${fs.readFileSync(path.join(ws, f), 'utf8').trim()}`).join('\n') }) } as any;
  const a = await confine(walker, ws).run({}, { workspace: ws, policy: undefined } as any);
  assert.ok(!CANARY.test(a.output) && /APP/.test(a.output) && /skipped secret file/.test(a.output), a.output);
  // a tool that ignores the hook and prints grep-style lines
  const blind = { ...walker, name: 'grep', run: async () => ({ output: files.map((f) => `${f}:1:${fs.readFileSync(path.join(ws, f), 'utf8').trim()}`).join('\n') }) };
  const b = await confine(blind, ws).run({}, { workspace: ws } as any);
  assert.ok(!CANARY.test(b.output) && /APP/.test(b.output), b.output);
  assert.equal(b.output.split('\n').filter((l) => l === 'skipped secret file').length, 5);
});

test('N34 RH2: A2A failures are counted per grant id: one caller\'s bad secrets never lock out another grant, a success resets only its own counter, and id-less guessing hits a global cap', async () => {
  const t = await a2aServer(() => ({ content: 'ok' }));
  try {
    const A = await t.owner.request('a2a/grants/issue', { caller: 'a', workspace: t.ws });
    const B = await t.owner.request('a2a/grants/issue', { caller: 'b', workspace: t.ws });
    const call = async (p: unknown) => (await t.open()).call('a2a/delegate', p);
    for (let i = 0; i < 4; i++) assert.equal((await call({ id: A.grant.id, secret: `oha2a_${'z'.repeat(40)}${i}`, task: 't' })).error?.code, -32001);
    assert.equal((await call({ id: A.grant.id, secret: A.secret, task: 't' })).error?.code, -32002, 'grant A is in backoff');
    const b = await call({ id: B.grant.id, secret: B.secret, task: 't' });
    assert.equal(b.result?.caller, 'b', 'grant B is not affected');
    assert.equal((await call({ id: A.grant.id, secret: A.secret, task: 't' })).error?.code, -32002, 'B\'s success did not reset A');
    // a valid secret under another grant's id is a failure for that id
    assert.equal((await call({ id: B.grant.id, secret: A.secret, task: 't' })).error?.code, -32001);
    // id-less guessing: a global bucket (10 free), then even id-less valid secrets wait; named grants still work
    for (let i = 0; i < 10; i++) await call({ secret: `oha2a_${'q'.repeat(40)}${i}`, task: 't' });
    assert.equal((await call({ secret: B.secret, task: 't' })).error?.code, -32002);
    assert.equal((await call({ id: B.grant.id, secret: B.secret, task: 't' })).result?.caller, 'b');
  } finally {
    await t.done();
  }
});
