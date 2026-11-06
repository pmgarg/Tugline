/** WS7 G5: compatibility imports (.cursor/rules, .clinerules, GEMINI.md, .codex skills, .claude agents/commands). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { getSlashCommand } from '../src/core/commands.js';
import { expandCommand, loadProjectRules, mentionedPaths, ruleMatches } from '../src/core/skills/compat.js';
import { defaultSkillDirs, SkillManager } from '../src/core/skills/manager.js';
import '../src/core/tools/providers.js';
import { startMockServer, testConfig, lastToolResult } from './helpers.js';

const FIX = path.resolve('test/fixtures/compat');

function compatWorkspace(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-compat-')));
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}

test('G5 AC1: fixtures for each format load (cursor rules, clinerules, GEMINI.md, codex skills, claude agents and commands)', async () => {
  const ws = compatWorkspace();
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fakehome-'));
  fs.mkdirSync(path.join(fakeHome, '.codex', 'skills', 'user-codex'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.codex', 'skills', 'user-codex', 'SKILL.md'), '---\nname: user-codex\ndescription: from ~/.codex/skills\n---\nbody');
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const srv = await startMockServer(() => ({ content: 'ok' }));
    const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { checkpoints: { enabled: false } }), mcp: false });
    await agent.run('hello');
    await agent.dispose();
    await srv.close();
    const sys: string = srv.requests[0].messages[0].content;
    for (const marker of ['CURSOR-ALWAYS', 'CLINE-ALWAYS', 'GEMINI-MD']) assert.ok(sys.includes(marker), `${marker} in the system prompt`);
    for (const marker of ['CURSOR-PYTHON', 'CLINE-SQL', 'CURSOR-RELEASE']) assert.ok(!sys.includes(marker), `${marker} is not always-on`);
    assert.match(sys, /\.cursor\/rules\/backend\/python\.mdc \(files: \*\.py, scripts\/\*\*\/\*\.sh\): Python conventions/);
    assert.match(sys, /\.cursor\/rules\/release\.mdc: How to cut a release/);
    // skills: project .codex/skills and user ~/.codex/skills
    const skills = new SkillManager(defaultSkillDirs(ws)).list();
    assert.ok(skills.some((s) => s.name === 'codex-skill' && s.source === 'project(.codex)'));
    assert.ok(skills.some((s) => s.name === 'user-codex' && s.source === 'user(.codex)'));
    assert.ok(agent.agentDefinitions.some((d) => d.name === 'claude-agent' && d.tools?.[0] === 'read_file'), '.claude/agents loads');
    // .claude/commands/*.md as slash commands (subfolder → namespace)
    const fix = getSlashCommand('fix');
    assert.ok(fix && getSlashCommand('git:summary'));
    const r: any = await fix!.run('42', { agent, config: agent.config, workspace: ws, write: () => {}, surface: 'cli' });
    assert.equal(r.prompt, 'Fix issue #42. Run !`git log -1` first.', 'template filled; shell interpolation is not executed');
  } finally {
    process.env.HOME = oldHome;
  }
});

test('G5 AC2: a glob-scoped rule activates only after a matching file is read (once per agent)', async () => {
  const ws = compatWorkspace();
  const srv = await startMockServer((_b, i) => {
    const reads = ['src/a.ts', 'src/app.py', 'src/other.py'];
    if (i < reads.length) return { toolCalls: [{ name: 'read_file', arguments: { path: reads[i] } }] };
    return { content: 'done' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { checkpoints: { enabled: false } }), mcp: false });
  await agent.run('look around');
  await agent.dispose();
  await srv.close();
  assert.ok(!JSON.stringify(srv.requests[0]).includes('CURSOR-PYTHON'), 'not active before any read');
  assert.ok(!lastToolResult(srv.requests[1]).includes('CURSOR-PYTHON'), 'reading a .ts file does not activate it');
  const afterPy = lastToolResult(srv.requests[2]);
  assert.match(afterPy, /\[project rule \.cursor\/rules\/backend\/python\.mdc applies to \*\.py, scripts\/\*\*\/\*\.sh\]\nCURSOR-PYTHON/);
  assert.ok(!lastToolResult(srv.requests[3]).includes('CURSOR-PYTHON'), 'injected once per agent');
  assert.ok(!JSON.stringify(srv.requests).includes('CLINE-SQL'), 'unrelated scoped rule never activates');
});

test('G5: a file mentioned in the prompt brings its scoped rule along', async () => {
  const ws = compatWorkspace();
  const srv = await startMockServer(() => ({ content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { checkpoints: { enabled: false } }), mcp: false });
  await agent.run('please fix @db/migrations/001.sql');
  await agent.dispose();
  await srv.close();
  const user = srv.requests[0].messages.find((m: any) => m.role === 'user').content;
  assert.match(user, /CLINE-SQL: never use SELECT \*/);
  assert.ok(!user.includes('CURSOR-PYTHON'));
});

test('G5: rule parsing details (single-file .clinerules, legacy .cursorrules, glob semantics, command templates)', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-compat2-'));
  fs.writeFileSync(path.join(ws, '.clinerules'), 'ONE-FILE cline rules');
  fs.writeFileSync(path.join(ws, '.cursorrules'), 'LEGACY cursor rules');
  const rules = loadProjectRules(ws);
  assert.deepEqual(rules.map((r) => [r.source, r.alwaysApply]), [['.cursorrules', true], ['.clinerules', true]]);
  const r = { source: 'x', globs: ['*.py', 'scripts/**/*.sh'], alwaysApply: false, body: 'b' };
  assert.ok(ruleMatches(r, 'deep/dir/a.py'));
  assert.ok(ruleMatches(r, 'scripts/a/b.sh'));
  assert.ok(!ruleMatches(r, 'other/b.sh'));
  assert.ok(!ruleMatches(r, '../outside.py'));
  assert.deepEqual(mentionedPaths('see @src/app.py:10-20 and README.md, not an email a@b.com', ws).sort(), ['README.md', 'src/app.py']);
  assert.equal(expandCommand('Do $1 then $2 ($ARGUMENTS)', 'a "b c"'), 'Do a then b c (a "b c")');
  assert.equal(expandCommand('No placeholder.', 'extra words'), 'No placeholder.\n\nextra words');
});

test('G5: the skills folder still has no path to the permission engine', () => {
  for (const f of fs.readdirSync('src/core/skills')) {
    const src = fs.readFileSync(path.join('src/core/skills', f), 'utf8');
    assert.doesNotMatch(src, /^import .*permissions\//m, `${f} must not import the permission engine`);
  }
});
