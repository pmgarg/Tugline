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
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERIAL = /^(browser-driver|browser-agent|desktop-driver|desktop-agent)\.test\.ts$/;
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
const run = (list, extra) => (list.length ? spawnSync(process.execPath, ['--import', 'tsx', '--test', ...guard, ...extra, ...list], { stdio: 'inherit', env }).status ?? 1 : 0);
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
if (!want.includes('--serial')) code ||= run(parallel, []);
if (!want.includes('--parallel')) code = run(serial, ['--test-concurrency=1']) || code;
cleanup();
process.exit(code);
