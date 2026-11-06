#!/usr/bin/env node
/**
 * Test runner: most files run in parallel; files that drive real browsers,
 * desktops or timing-sensitive kill switches run one at a time afterwards, so
 * they don't compete for CPU on small machines (FINAL_REVIEW §4 Quality 1).
 *   npm test                 both groups
 *   npm test -- --parallel   parallel group only
 *   npm test -- --serial     serial group only
 *
 * Each run gets its own temp root (TMPDIR), removed when the run ends, so the
 * suite's scratch folders never pile up (78k of them once filled a CI disk).
 * TUG_KEEP_TMP=1 keeps it for debugging; its path is printed.
 *
 * Stall watchdog: if a group prints nothing for TUG_TEST_STALL_MS (default 15 min), the
 * runner prints every process still running under it (the test files and what they
 * started; on macOS a short `sample` of each test file too), stops them and fails.
 * --test-timeout and --test-force-exit cannot do this when a file blocks its own event
 * loop (a spawnSync that never returns): CI once sat silent for 85 minutes that way.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// browser-extension drives a real Chromium too: in the parallel group its pairing timed out on a loaded runner
const SERIAL = /^(browser-driver|browser-agent|browser-extension|desktop-driver|desktop-agent)\.test\.ts$/;
const dir = path.resolve('test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
// v1.2 (WS18): the surface conformance suite (V0.1) and the parity audit (V0.2) live in their own directories
const sub = ['conformance', 'parity'].flatMap((d) => (fs.existsSync(path.join(dir, d)) ? fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.test.ts')).sort().map((f) => path.join('test', d, f)) : []));
const serial = files.filter((f) => SERIAL.test(f)).map((f) => path.join('test', f));
const parallel = [...files.filter((f) => !SERIAL.test(f)).map((f) => path.join('test', f)), ...sub];
const want = process.argv.slice(2);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-run-'));
const env = { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot };
// A test that leaves a child process or socket open must not hold its file (and so the whole run) open until the CI
// job limit: each file exits once its tests are done, and a test with no limit of its own fails by name after 10 min.
// On CI the TAP reporter streams each result as it finishes (Node 24's default reporter printed nothing for 88 min).
const guard = ['--test-force-exit', '--test-timeout=600000', ...(process.env.CI ? ['--test-reporter=tap'] : [])];
const STALL_MS = Number(process.env.TUG_TEST_STALL_MS) || 15 * 60_000;

/** Every process below `root`, from `ps` (POSIX). */
function descendants(root) {
  const r = spawnSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  const rows = r.stdout
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], command: m[4] }));
  const out = [];
  const walk = (pid, depth) => {
    for (const p of rows.filter((x) => x.ppid === pid)) {
      out.push({ ...p, depth });
      walk(p.pid, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** The group printed nothing for STALL_MS: show what is still running, stop it, fail. */
function stalled(child) {
  const quiet = STALL_MS >= 120_000 ? `${Math.round(STALL_MS / 60_000)} min` : `${Math.round(STALL_MS / 1000)} s`;
  const say = (s) => process.stdout.write(`${s}\n`);
  say(`\n# test run stalled: no output for ${quiet}. Still running:`);
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
    say(`::error title=Test run stalled::no output for ${quiet} (process list not available on Windows)`);
    return;
  }
  const procs = descendants(child.pid);
  for (const p of procs) say(`#   ${'  '.repeat(p.depth)}${p.pid} (${p.etime}) ${p.command.slice(0, 400)}`);
  const testFiles = procs.filter((p) => /\.test\.ts\b/.test(p.command));
  if (process.platform === 'darwin') {
    for (const p of testFiles) {
      const s = spawnSync('sample', [String(p.pid), '2', '-mayDie'], { encoding: 'utf8', timeout: 30_000 });
      const graph = (s.stdout || '').split('\n');
      const at = graph.findIndex((l) => /^Call graph:/.test(l));
      say(`# sample of ${p.pid}:`);
      for (const l of graph.slice(at < 0 ? 0 : at, (at < 0 ? 0 : at) + 60)) say(`#   ${l}`);
    }
  }
  const names = [...new Set(testFiles.map((p) => (p.command.match(/(\S+\.test\.ts)\b/) || [])[1]).filter(Boolean))];
  say(`::error title=Test run stalled::no output for ${quiet}; still running: ${names.join(', ') || '(no test file process found)'}`);
  for (const p of [...procs].reverse()) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/** One group: its output is passed through as it comes, with the stall watchdog on top. */
function run(list, extra) {
  if (!list.length) return Promise.resolve(0);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...guard, ...extra, ...list], { stdio: ['inherit', 'pipe', 'pipe'], env });
    let last = Date.now();
    let stall = false;
    child.stdout.on('data', (d) => ((last = Date.now()), process.stdout.write(d)));
    child.stderr.on('data', (d) => ((last = Date.now()), process.stderr.write(d)));
    const dog = setInterval(() => {
      if (stall || Date.now() - last < STALL_MS) return;
      stall = true;
      stalled(child);
    }, Math.min(30_000, STALL_MS / 4));
    child.on('close', (code) => {
      clearInterval(dog);
      resolve(stall ? 1 : (code ?? 1));
    });
  });
}

const cleanup = () => {
  if (process.env.TUG_KEEP_TMP === '1') return void console.log(`test temp root kept: ${tmpRoot}`);
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.log(`could not remove ${tmpRoot}: ${e.message}`);
  }
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (cleanup(), process.exit(130)));
let code = 0;
if (!want.includes('--serial')) code ||= await run(parallel, []);
if (!want.includes('--parallel')) code = (await run(serial, ['--test-concurrency=1'])) || code;
cleanup();
process.exit(code);
