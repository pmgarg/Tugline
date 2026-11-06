/** v1.1 R13: a child worker never gets broader authority than its parent; policy applies the same way whatever the adapter. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { builtinTools } from '../src/core/tools/index.js';
import { taskTool } from '../src/core/tools/meta.js';
import { authorityOf, broaderThan, modeRank, narrowTools, type Authority } from '../src/core/permissions/authority.js';
import { PermissionPolicy } from '../src/core/permissions/policy.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const base: Authority = { mode: 'ask', tools: ['bash', 'read_file', 'task'], allow: ['bash(npm test*)'], deny: ['bash(curl*)'], protectedPaths: ['tests/**'], additionalDirectories: [] };

test('R13 invariant: broaderThan finds every dimension in which a child exceeds its parent, and nothing when it is equal or narrower', () => {
  assert.deepEqual(broaderThan(base, base), []);
  // narrower in every dimension is fine
  assert.deepEqual(broaderThan({ mode: 'plan', tools: ['read_file'], allow: [], deny: ['bash(curl*)', 'bash(wget*)'], protectedPaths: ['tests/**', 'ci/**'], additionalDirectories: [], writeOnly: ['docs/**'] }, base), []);
  // the parent-only tools (task, ask_user, …) are never counted against a child
  assert.deepEqual(broaderThan({ ...base, tools: ['bash', 'read_file'] }, base), []);
  const cases: [Partial<Authority>, RegExp][] = [
    [{ mode: 'auto' }, /permission mode auto is broader than the parent's ask/],
    [{ mode: 'bogus' }, /permission mode bogus/],
    [{ tools: ['bash', 'read_file', 'write_file'] }, /tools the parent does not have: write_file/],
    [{ allow: ['bash(npm test*)', 'bash(*)'] }, /allow rules the parent does not have: bash\(\*\)/],
    [{ deny: [] }, /deny rules dropped: bash\(curl\*\)/],
    [{ protectedPaths: [] }, /protected paths dropped: tests\/\*\*/],
    [{ additionalDirectories: ['/etc'] }, /additional directories the parent does not have: \/etc/],
  ];
  for (const [over, re] of cases) {
    const why = broaderThan({ ...base, ...over }, base);
    assert.equal(why.length, 1, JSON.stringify(over));
    assert.match(why[0], re);
  }
  assert.match(broaderThan(base, { ...base, writeOnly: ['docs/**'] }).join(), /may only write docs\/\*\*; the child is unrestricted/);
  assert.match(broaderThan({ ...base, writeOnly: ['docs/**', 'src/**'] }, { ...base, writeOnly: ['docs/**'] }).join(), /write globs the parent does not have: src\/\*\*/);
  assert.ok(modeRank('plan') < modeRank('ask') && modeRank('ask') === modeRank('default') && modeRank('ask') < modeRank('acceptEdits') && modeRank('acceptEdits') < modeRank('auto'));
  assert.deepEqual(narrowTools([{ name: 'bash' }, { name: 'write_file' }, { name: 'read_file' }], ['read_file', 'bash']).map((t) => t.name), ['bash', 'read_file']);
});

test('R13: a subagent of an agent given only read tools gets only read tools (not every tool the harness has), and cannot write', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'hello\n' });
  const seen: { parent?: string[]; child?: string[] } = {};
  let childStep = 0;
  const srv = await startMockServer((b: any) => {
    const names: string[] = (b.tools ?? []).map((t: any) => t.function.name);
    const last = b.messages.at(-1);
    if (names.includes('task')) {
      seen.parent = names;
      if (last.role === 'user') return { toolCalls: [{ name: 'task', arguments: { agent_type: 'general', description: 'write a file', prompt: 'child: create pwned.txt' } }] };
      return { content: 'parent done' };
    }
    seen.child = names;
    if (childStep++ === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo pwned > pwned.txt' } }, { name: 'write_file', arguments: { path: 'pwned2.txt', content: 'x' } }] };
    return { content: 'child done' };
  });
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0, backgroundCompaction: false, requireVerification: false }, checkpoints: { enabled: false } });
    const readOnly = [...builtinTools(cfg).filter((t) => ['read_file', 'grep', 'glob', 'list_dir'].includes(t.name)), taskTool];
    const a = await Agent.create({ workspace: ws, config: cfg, mcp: false, tools: readOnly, ui: { requestPermission: async () => ({ decision: 'allow' }) as any } });
    try {
      await a.run('go');
    } finally {
      await a.dispose();
    }
    assert.ok(seen.parent && seen.child, 'both the parent and the child called the model');
    const parentTools = new Set(seen.parent);
    const extra = seen.child!.filter((t) => !parentTools.has(t) && !['task_brief', 'tool_search'].includes(t));
    assert.deepEqual(extra, [], `the child was offered tools its parent does not have: ${extra.join(', ')}`);
    assert.ok(!seen.child!.includes('bash') && !seen.child!.includes('write_file'));
    assert.ok(!fs.existsSync(path.join(ws, 'pwned.txt')) && !fs.existsSync(path.join(ws, 'pwned2.txt')), 'the child could not write');
  } finally {
    await srv.close();
  }
});

test('R13: a worktree child follows its parent\'s permission mode (narrowing it mid-run narrows the child) and can narrow, never widen, itself', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x' });
  const srv = await startMockServer(() => ({ content: 'ok' }));
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', permissions: { protectedPaths: ['tests/**'], deny: ['bash(curl*)'] } });
    const a = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    try {
      const child: PermissionPolicy = (a as any).policyFor(tmpWorkspace({}));
      assert.equal(child.mode, 'yolo');
      a.policy.mode = 'plan';
      assert.equal(child.mode, 'plan', 'the parent switched to plan: the running child is in plan too');
      child.mode = 'bypassPermissions' as any;
      assert.equal(child.mode, 'plan', 'a child cannot widen itself past its parent');
      a.policy.mode = 'yolo';
      child.mode = 'ask';
      assert.equal(child.mode, 'ask', 'a child may narrow itself');
      assert.equal(a.policy.mode, 'yolo', "the child's own setting does not change the parent");
      assert.deepEqual(broaderThan(authorityOf(child, ['bash']), authorityOf(a.policy, ['bash'])), []);
      assert.equal(child.check({ tool: 'bash', command: 'curl https://x' } as any).decision, 'deny', 'deny rules are inherited');
    } finally {
      await a.dispose();
    }
  } finally {
    await srv.close();
  }
});

test('R13: policy applies uniformly across adapters: none of them builds its own permission policy or passes subagent wiring, and the core refuses a hard deny even when the UI approves everything', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const adapters = ['src/cli', 'src/acp', 'src/server', 'src/channels', 'src/sdk', 'vscode/src'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  assert.ok(adapters.length >= 5, 'the adapter directories exist');
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'out' && e.name !== 'dist') walk(p);
      } else if (/\.(m?ts|tsx|js)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8');
        if (/new PermissionPolicy\s*\(/.test(src) || /\bshared\s*:\s*\{/.test(src) || /\binitialTaint\s*:/.test(src)) offenders.push(path.relative(root, p));
      }
    }
  };
  adapters.forEach(walk);
  assert.deepEqual(offenders, [], 'adapters go through Agent.create, which builds the one policy');

  // The approving UI is the most permissive any adapter can be: hard denies still hold, in auto mode too.
  const ws = tmpWorkspace({ 'tests/judge.txt': 'original\n' });
  let step = 0;
  const srv = await startMockServer(() => (step++ === 0 ? { toolCalls: [{ name: 'write_file', arguments: { path: 'tests/judge.txt', content: 'pwned' } }, { name: 'bash', arguments: { command: 'echo pwned > tests/judge.txt' } }] } : { content: 'done' }));
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', permissions: { protectedPaths: ['tests/**'] }, agent: { repoMapTokens: 0, backgroundCompaction: false, requireVerification: false }, checkpoints: { enabled: false } });
    const a = await Agent.create({ workspace: ws, config: cfg, mcp: false, ui: { requestPermission: async () => ({ decision: 'allow' }) as any } });
    let r;
    try {
      r = await a.run('go');
    } finally {
      await a.dispose();
    }
    assert.equal(fs.readFileSync(path.join(ws, 'tests/judge.txt'), 'utf8'), 'original\n');
    assert.ok(r.stats.refusals >= 2, `both writes refused (refusals ${r.stats.refusals})`);
  } finally {
    await srv.close();
  }
});
