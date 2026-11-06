/** V0.1 AC2: a surface module without a conformance driver fails the suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT, loadDrivers } from './harness.js';
import { DEFERRED, registryProblems, SURFACES } from './surfaces.js';

function repoFiles(): string[] {
  // tracked and untracked (not ignored) files: a new adapter fails the check before it is committed
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

test('V0.1 AC2: every surface module in the repository has a conformance driver', async () => {
  const ids = (await loadDrivers()).map((d) => d.id);
  const problems = registryProblems(repoFiles(), ids);
  assert.deepEqual(problems, [], problems.join('\n'));
  for (const [m, why] of Object.entries(DEFERRED)) console.log(`# deferred surface ${m}: ${why}`);
});

test('V0.1 AC2: driver ids are unique and every driver is registered as a surface', async () => {
  const ids = (await loadDrivers()).map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate driver ids: ${ids.join(', ')}`);
  for (const id of ids) assert.ok(SURFACES.some((s) => s.driver === id), `driver ${id} is not listed in surfaces.ts`);
});

test('V0.1 AC2: a planned surface needs its driver as soon as its module lands (teammate, workflow item)', async () => {
  // (WS17's drivers exist now: take them out to check that a missing one would be caught)
  const ids = (await loadDrivers()).map((d) => d.id).filter((i) => i !== 'teammate' && i !== 'workflow-item');
  const problems = registryProblems([...repoFiles(), 'src/core/agent/team/board.ts', 'src/core/agent/workflow/run.ts'], ids);
  assert.ok(problems.some((p) => /no driver "teammate"/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /no driver "workflow-item"/.test(p)), problems.join('\n'));
  // and with the drivers present, nothing is reported for them
  const ok = registryProblems([...repoFiles(), 'src/core/agent/team/board.ts', 'src/core/agent/workflow/run.ts'], [...ids, 'teammate', 'workflow-item']);
  assert.ok(!ok.some((p) => /team\/|workflow\//.test(p)), ok.join('\n'));
  // the paused channels (N41/N31, Nov 2026) are not planned any more: a Feishu adapter landing would be an unlisted surface
  assert.ok(registryProblems([...repoFiles(), 'src/channels/feishu.ts'], ids).some((p) => p.includes('src/channels/feishu.ts')));
});

test('V0.1 AC2: a new surface module without a driver is caught (an unlisted channel, web UI, SSH executor)', async () => {
  const ids = (await loadDrivers()).map((d) => d.id);
  const files = [...repoFiles(), 'src/channels/line.ts', 'src/server/web.ts', 'src/core/host/ssh.ts', 'sdk/java/src/main/java/OhClient.java'];
  const problems = registryProblems(files, ids);
  for (const f of ['src/channels/line.ts', 'src/server/web.ts', 'src/core/host/ssh.ts', 'sdk/java/src/main/java/OhClient.java']) assert.ok(problems.some((p) => p.startsWith(f)), `${f} not caught: ${problems.join('\n')}`);
  // and a listed surface whose driver file is missing
  const missing = registryProblems(repoFiles(), ids.filter((i) => i !== 'channel-slack'));
  assert.ok(missing.some((p) => /no driver "channel-slack"/.test(p)), missing.join('\n'));
});
