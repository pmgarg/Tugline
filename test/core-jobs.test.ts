/** WS4 D5: background jobs, monitor, session cleanup, permissions, sandbox wrappers, session cwd. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { getJob, listJobs } from '../src/core/jobs/manager.js';
import { registerCommandWrapper, scrubbedEnv, unregisterCommandWrapper } from '../src/core/tools/shell.js';
import { execFileSync } from 'node:child_process';
import type { PermissionRequest } from '../src/core/types.js';
import { startMockServer, testConfig, tmpWorkspace, lastToolResult } from './helpers.js';

const JOBS = { agent: { backgroundJobs: true, repoMapTokens: 0 } };
const toolNames = (body: any): string[] => (body.tools ?? []).map((t: any) => t.function.name);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

test('D5 AC1: start python3 -m http.server 0 in the background, monitor for "Serving", curl it, kill it', async () => {
  const ws = tmpWorkspace({ 'hello.txt': 'hi' });
  let jobId = '';
  let port = '';
  const srv = await startMockServer((body, i) => {
    const last = lastToolResult(body);
    switch (i) {
      case 0:
        return { toolCalls: [{ name: 'bash', arguments: { command: 'python3 -m http.server 0', run_in_background: true } }] };
      case 1:
        jobId = last.match(/(job_\w+)/)![1];
        return { toolCalls: [{ name: 'monitor', arguments: { job_id: jobId, pattern: 'Serving', timeout_ms: 15000 } }] };
      case 2:
        port = last.match(/port (\d+)/)![1];
        return { toolCalls: [{ name: 'bash', arguments: { command: `curl -s http://127.0.0.1:${port}/` } }] };
      case 3:
        return { toolCalls: [{ name: 'job_kill', arguments: { job_id: jobId } }] };
      default:
        return { content: 'served and stopped' };
    }
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...JOBS }), mcp: false });
  const res = await agent.run('serve the folder');
  await agent.dispose();
  await srv.close();
  assert.equal(res.stopReason, 'end_turn');
  assert.ok(!toolNames(srv.requests[0]).includes('monitor'), 'job tools hidden until a job exists');
  assert.ok(toolNames(srv.requests[1]).includes('monitor'), 'activated by the background start');
  assert.match(lastToolResult(srv.requests[2]), /Matched \/Serving\/[\s\S]*Serving HTTP on/);
  assert.match(lastToolResult(srv.requests[3]), /hello\.txt/, 'the page was fetched while the job ran');
  assert.match(lastToolResult(srv.requests[4]), /Killed job_/);
  const j = getJob(jobId)!;
  assert.notEqual(j.status, 'running');
  assert.ok(!alive(j.pid!), 'process group is gone');
  assert.ok(j.logFile.startsWith(path.join(agent.config.homeDir, 'jobs')), 'log in ~/.tugline/jobs');
});

test('D5 AC2: jobs are killed when the session ends unless persist:true', async () => {
  const ws = tmpWorkspace({});
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 30', run_in_background: true } }, { name: 'bash', arguments: { command: 'sleep 31', run_in_background: true, persist: true } }] };
    return { content: 'started' };
  });
  // persist:true outlives the session only with shell.processLifetime "off" (R1 re-check: by default every job ends with the session)
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...JOBS, shell: { processLifetime: 'off' } }), mcp: false });
  await agent.run('start two');
  await srv.close();
  const jobs = listJobs(agent.sessionId);
  assert.equal(jobs.length, 2);
  const [normal, persistent] = [jobs.find((j) => j.command === 'sleep 30')!, jobs.find((j) => j.command === 'sleep 31')!];
  assert.ok(alive(normal.pid!) && alive(persistent.pid!));
  await agent.dispose();
  assert.ok(await waitFor(() => !alive(normal.pid!)), 'non-persistent job killed at session end');
  assert.ok(alive(persistent.pid!), 'persist:true survives the session');
  process.kill(-persistent.pid!, 'SIGKILL');
});

test('D5 AC3: background commands ask for permission like foreground ones (and a denial starts nothing)', async () => {
  const ws = tmpWorkspace({});
  const asked: PermissionRequest[] = [];
  const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 20', run_in_background: true } }] } : { content: 'ok' }));
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'ask', ...JOBS }), mcp: false, ui: { requestPermission: async (r) => (asked.push(r), { decision: 'deny' }) } });
  await agent.run('start');
  await agent.dispose();
  await srv.close();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, 'bash');
  assert.match(asked[0].title, /Start in background: sleep 20/);
  assert.equal(listJobs(agent.sessionId).length, 0);
  // and the dangerous-command floor applies in auto mode too
  const srv2 = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'sudo sleep 20', run_in_background: true } }] } : { content: 'ok' }));
  const asked2: PermissionRequest[] = [];
  const a2 = await Agent.create({ workspace: ws, config: testConfig(srv2.url, { permissionMode: 'yolo', ...JOBS }), mcp: false, ui: { requestPermission: async (r) => (asked2.push(r), { decision: 'deny' }) } });
  await a2.run('x');
  await a2.dispose();
  await srv2.close();
  assert.match(asked2[0]?.reason ?? '', /privilege escalation/);
});

test('D5: background jobs go through command wrappers (S0.7 sandbox seam), including a wrapper-chosen cwd', async () => {
  const ws = tmpWorkspace({ 'sub/marker.txt': 'm' });
  registerCommandWrapper('test-bg-wrap', (cfg) => ((cfg as any).testWrap ? (s) => ({ ...s, file: '/bin/bash', args: ['-c', 'echo WRAPPED-BG; ls'], cwd: path.join(ws, 'sub') }) : undefined));
  try {
    const srv = await startMockServer((_b, i) => (i === 0 ? { toolCalls: [{ name: 'bash', arguments: { command: 'echo plain', run_in_background: true } }] } : { content: 'ok' }));
    const cfg: any = testConfig(srv.url, { permissionMode: 'yolo', ...JOBS });
    cfg.testWrap = true;
    const agent = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    await agent.run('go');
    await srv.close();
    const j = listJobs(agent.sessionId)[0];
    assert.ok(await waitFor(() => j.status !== 'running'));
    const log = fs.readFileSync(j.logFile, 'utf8');
    assert.match(log, /WRAPPED-BG/);
    assert.match(log, /marker\.txt/);
    await agent.dispose();
  } finally {
    unregisterCommandWrapper('test-bg-wrap');
  }
});

test('D5: background jobs are off by default; bare cd sets the session cwd; cwd cannot leave the workspace', async () => {
  const ws = tmpWorkspace({ 'pkg/x.txt': 'x' });
  const srv = await startMockServer((_b, i) => {
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'sleep 5', run_in_background: true } }] };
    if (i === 1) return { toolCalls: [{ name: 'bash', arguments: { command: 'cd pkg' } }] };
    if (i === 2) return { toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }] };
    if (i === 3) return { toolCalls: [{ name: 'bash', arguments: { command: 'ls', cwd: '../..' } }] };
    return { content: 'ok' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', agent: { repoMapTokens: 0 } }), mcp: false });
  await agent.run('go');
  await agent.dispose();
  await srv.close();
  const bash = srv.requests[0].tools.find((t: any) => t.function.name === 'bash');
  assert.ok(!('run_in_background' in bash.function.parameters.properties), 'schema has no background option when disabled');
  assert.match(lastToolResult(srv.requests[1]), /background jobs are disabled/);
  assert.match(lastToolResult(srv.requests[2]), /working directory is now pkg/);
  assert.match(lastToolResult(srv.requests[3]), /\(in pkg\)\nx\.txt/);
  assert.match(lastToolResult(srv.requests[4]), /outside the workspace/);
});

test('D5: job_output through the agent loop (tail, then only new output via since)', async () => {
  const ws = tmpWorkspace({});
  let jobId = '';
  let next = '';
  const srv = await startMockServer((body, i) => {
    const last = lastToolResult(body);
    // "third" is gated on a file the test creates after the tail read: no timing assumptions
    if (i === 0) return { toolCalls: [{ name: 'bash', arguments: { command: 'echo first; echo second; while [ ! -f go ]; do sleep 0.05; done; echo third; sleep 20', run_in_background: true } }] };
    if (i === 1) {
      jobId = last.match(/(job_\w+)/)![1];
      return { toolCalls: [{ name: 'monitor', arguments: { job_id: jobId, pattern: 'second' } }] };
    }
    if (i === 2) return { toolCalls: [{ name: 'job_output', arguments: { job_id: jobId, tail: 1 } }] };
    if (i === 3) {
      next = last.match(/\[next: (\d+)\]/)![1];
      fs.writeFileSync(path.join(ws, 'go'), '');
      return { toolCalls: [{ name: 'monitor', arguments: { job_id: jobId, pattern: 'third', timeout_ms: 5000 } }] };
    }
    if (i === 4) return { toolCalls: [{ name: 'job_output', arguments: { job_id: jobId, since: Number(next) } }] };
    return { content: 'read' };
  });
  const agent = await Agent.create({ workspace: ws, config: testConfig(srv.url, { permissionMode: 'yolo', ...JOBS }), mcp: false });
  await agent.run('watch');
  await agent.dispose();
  await srv.close();
  const tail = lastToolResult(srv.requests[3]);
  assert.match(tail, /^job_\w+ {2}running[\s\S]*\nsecond\n\[next: \d+\]$/);
  assert.doesNotMatch(tail, /\nfirst\n/, 'tail: 1 returns only the last line');
  const fresh = lastToolResult(srv.requests[5]).split('\n').slice(1).join('\n'); // drop the job header (it echoes the command)
  assert.match(fresh, /^third\n/);
  assert.doesNotMatch(fresh, /first|second/, 'since returns only output after the offset');
  assert.ok(!alive(getJob(jobId)!.pid!) || (await waitFor(() => !alive(getJob(jobId)!.pid!))));
});


test('scrubbedEnv keeps git env config usable (GIT_CONFIG_KEY_n is a key name, not a secret) and still drops credentials', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'false', SOME_API_KEY: 'k-0123456789' });
  try {
    const env = scrubbedEnv([]);
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.autocrlf');
    assert.ok(!('SOME_API_KEY' in env));
    const out = execFileSync('git', ['config', 'core.autocrlf'], { env, cwd: tmpWorkspace({}) }).toString().trim();
    assert.equal(out, 'false');
  } finally {
    for (const k of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'SOME_API_KEY']) if (saved[k] === undefined) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
