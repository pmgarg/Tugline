/**
 * v1.1 R7 (WS16): the suite and the product on macOS / Windows / newer Node.
 * The external review ran the suite on macOS (arm64, Node 26.12.1): 16 failures,
 * from Linux-only `ps --ppid`, GNU `sed -i`, a Python without pytest, Node 24+
 * readline, and Electron helpers left running. These tests pin the fixes on any OS.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  PS_ARGS,
  childProcesses,
  descendantProcesses,
  isAlive,
  isZombie,
  killProcessTree,
  listProcesses,
  parentPid,
  parsePsOutput,
  parseWindowsJson,
  parseWmicCsv,
  platformSpawnArgs,
  waitForExit,
} from '../src/core/util/procs.js';
import { execCommand } from '../src/core/tools/shell.js';
import { macExecutable, relaunchWithDebugPort } from '../src/core/automation/desktop/electron.js';
import { loadSuite } from '../src/core/eval/runner.js';
import { checkTask } from '../evals/editing/check.mts';
import { listZip, checkVsix } from '../scripts/smoke-artefacts.mjs';
import { startMockOpenAI } from '../scripts/mock-openai.mjs';
import { needsPytest, startMockServer, tmpWorkspace } from './helpers.js';

const ROOT = process.cwd();
const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
});

// ------------------------------------------------------------ process listing (R7.1)

/** `ps -A -ww -o pid=,ppid=,stat=,args=` as procps (Linux) prints it. */
const LINUX_PS = `      1       0 Ss   /sbin/init splash
      2       0 S    [kthreadd]
   1000       1 Sl   node --import tsx --test test/browser-driver.test.ts
   1001    1000 Sl   /root/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell --headless --remote-debugging-pipe --force-webrtc-ip-handling-policy=disable_non_proxied_udp
   1002    1001 S    /root/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell --type=zygote
   1003    1002 S    /root/.cache/ms-playwright/chromium_headless_shell-1200/chrome-linux/headless_shell --type=renderer
   1004    1000 Z    [headless_shell] <defunct>
   1005    1000 R+   ps -A -ww -o pid=,ppid=,stat=,args=
`;

/** The same on macOS (BSD ps): app paths with spaces, launchd as pid 1, a crashpad handler reparented to it. */
const MAC_PS = `    1     0 Ss   /sbin/launchd
  321     1 Ss   /usr/libexec/logd
 4200   600 S+   node --import tsx --test test/desktop-agent.test.ts
 4242  4200 S    /Users/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --remote-debugging-port=50123 --user-data-dir=/var/folders/xy/T/oh-electron-test-abc/profile
 4243  4242 S    /Users/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/131.0.6778.33/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=/var/folders/xy/T/oh-electron-test-abc/profile
 4244     1 Ss   /Users/me/Library/Caches/ms-playwright/chromium-1200/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/131.0.6778.33/Helpers/chrome_crashpad_handler --database=/private/var/folders/xy/T/oh-electron-test-abc/profile/Crashpad --monitor-self-annotation=ptype=crashpad-handler
 4245  4242 Z    (Google Chrome He)
`;

test('R7 procs: parses procps (Linux) and BSD (macOS) `ps` output into pid / ppid / state / args', () => {
  const linux = parsePsOutput(LINUX_PS);
  assert.equal(linux.length, 8);
  assert.deepEqual(linux[0], { pid: 1, ppid: 0, stat: 'Ss', args: '/sbin/init splash' });
  assert.deepEqual(linux[1], { pid: 2, ppid: 0, stat: 'S', args: '[kthreadd]' });
  assert.match(linux[3].args, /--force-webrtc-ip-handling-policy=disable_non_proxied_udp$/);
  assert.ok(isZombie(linux[6]));
  const mac = parsePsOutput(MAC_PS);
  assert.equal(mac.length, 7);
  assert.equal(mac[3].pid, 4242);
  assert.match(mac[3].args, /^\/Users\/me\/.*Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing --remote-debugging-port=50123/, 'spaces in the command are kept');
  assert.equal(mac[5].ppid, 1, 'the crashpad handler was reparented to launchd');
  assert.ok(isZombie(mac[6]));
  assert.deepEqual(parsePsOutput('\n  garbage line\n'), []);
});

test('R7 procs: children and descendants come from the snapshot (no --ppid), zombies and the ps itself excluded', () => {
  const linux = parsePsOutput(LINUX_PS);
  assert.deepEqual(childProcesses(1000, linux).map((p) => p.pid), [1001, 1005]);
  assert.deepEqual(descendantProcesses(1000, linux).map((p) => p.pid), [1001, 1005, 1002, 1003]);
  assert.equal(parentPid(1003, linux), 1002);
  const mac = parsePsOutput(MAC_PS);
  assert.deepEqual(childProcesses(4242, mac).map((p) => p.pid), [4243], 'zombie helper left out');
  assert.deepEqual(descendantProcesses(4200, mac).map((p) => p.pid), [4242, 4243], 'the reparented crashpad handler is not a descendant: killProcessTree finds it by `match`');
  // A Windows-style self-parented entry (System Idle Process) does not loop.
  assert.deepEqual(descendantProcesses(0, [{ pid: 0, ppid: 0, args: 'Idle', stat: '' }, { pid: 4, ppid: 0, args: 'System', stat: '' }]).map((p) => p.pid), [4]);
});

test('R7 procs: listProcesses runs the portable ps invocation on Linux and macOS, PowerShell (then wmic) on Windows', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const calls: string[][] = [];
    const rows = listProcesses({ platform, exec: (f, a) => (calls.push([f, ...a]), platform === 'linux' ? LINUX_PS : MAC_PS) });
    assert.deepEqual(calls, [['ps', ...PS_ARGS]]);
    assert.ok(!calls[0].includes(`--${'ppid'}`) && calls[0].includes('-A'), 'BSD ps rejects --ppid; -A works on both');
    assert.ok(rows.length >= 7);
  }
  const winJson = JSON.stringify([
    { ProcessId: 0, ParentProcessId: 0, Name: 'System Idle Process', CommandLine: null },
    { ProcessId: 5000, ParentProcessId: 4000, Name: 'chrome.exe', CommandLine: '"C:\\Program Files\\Chrome\\chrome.exe" --remote-debugging-port=9222' },
  ]);
  const ps: string[][] = [];
  const win = listProcesses({ platform: 'win32', exec: (f, a) => (ps.push([f, ...a]), winJson) });
  assert.equal(ps[0][0], 'powershell.exe');
  assert.match(ps[0].join(' '), /Get-CimInstance Win32_Process/);
  assert.deepEqual(win.map((p) => [p.pid, p.ppid, p.args]), [[0, 0, 'System Idle Process'], [5000, 4000, '"C:\\Program Files\\Chrome\\chrome.exe" --remote-debugging-port=9222']]);
  assert.deepEqual(parseWindowsJson('{"ProcessId":7,"ParentProcessId":3,"Name":"x.exe","CommandLine":"x.exe -a"}').map((p) => p.pid), [7], 'a single process is an object, not an array');
  const csv = 'Node,CommandLine,ParentProcessId,ProcessId\r\nHOST,"C:\\a b\\app.exe" --x=1,2,3,4000,5000\r\nHOST,,0,4\r\n';
  const viaWmic = listProcesses({ platform: 'win32', exec: (f) => (f === 'wmic' ? csv : (() => { throw new Error('no powershell'); })()) });
  assert.deepEqual(viaWmic.map((p) => [p.pid, p.ppid, p.args]), [[5000, 4000, '"C:\\a b\\app.exe" --x=1,2,3'], [4, 0, '']]);
  assert.deepEqual(parseWmicCsv(''), []);
});

test('R7 procs: the real snapshot on this machine sees this process and a child, but not its own ps', async () => {
  const marker = `oh-procs-self-${process.pid}`;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', marker], { stdio: 'ignore' });
  cleanups.push(() => void child.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 300));
  const list = listProcesses();
  assert.ok(list.some((p) => p.pid === process.pid), 'this test process is listed');
  const kids = childProcesses(process.pid, list);
  assert.ok(kids.some((p) => p.pid === child.pid && p.args.includes(marker)), JSON.stringify(kids));
  assert.ok(!kids.some((p) => /^(\S*\/)?ps\s/.test(p.args)), 'the ps that made the snapshot is not reported as a child');
  child.kill('SIGKILL');
  assert.deepEqual(await waitForExit([child.pid!], 3000), []);
});

/** test/fixtures/proc-family.cjs: a detached parent, a same-group child and a reparented setsid helper (like Chrome on macOS). */
function processFamily(marker: string): Promise<{ parent: ChildProcess; pids: number[] }> {
  const parent = spawn(process.execPath, [path.resolve('test/fixtures/proc-family.cjs'), marker], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  return new Promise((resolve) => parent.stdout!.once('data', (d) => resolve({ parent, pids: [parent.pid!, ...JSON.parse(String(d))] })));
}

test('R7 procs: killProcessTree kills the group, the descendants and matched reparented helpers, and waits until they are gone', { skip: process.platform === 'win32' ? 'POSIX process groups' : false }, async () => {
  const marker = `oh-procs-family-${process.pid}-${Date.now()}`;
  // Without the matcher, the helper that left the group survives a group + tree kill (the F5 leak on macOS) …
  const one = await processFamily(marker);
  await new Promise((r) => setTimeout(r, 200));
  const survivors = await killProcessTree(one.parent.pid, { graceMs: 300 });
  assert.deepEqual(survivors, []);
  assert.equal(isAlive(one.pids[0]), false);
  assert.equal(isAlive(one.pids[1]), false, 'the same-group child died with the group');
  assert.equal(isAlive(one.pids[2]), true, 'the setsid helper is still running');
  process.kill(one.pids[2], 'SIGKILL');
  // … with it, nothing is left.
  const two = await processFamily(marker);
  await new Promise((r) => setTimeout(r, 200));
  const left = await killProcessTree(two.parent.pid, { match: (p) => p.args.includes(marker), graceMs: 300 });
  assert.deepEqual(left, []);
  assert.deepEqual(two.pids.filter((p) => isAlive(p)), []);
  assert.deepEqual(listProcesses().filter((p) => p.args.includes(marker) && !isZombie(p)), []);
});

// ------------------------------------------------------------ Electron relaunch cleanup (R7.5)

test('R7 F5: macExecutable runs a bundle\'s CFBundleExecutable (or a plain executable) directly instead of `open -na`', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-macapp-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const foo = path.join(dir, 'Foo.app');
  fs.mkdirSync(path.join(foo, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(foo, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Foo</string><key>CFBundleExecutable</key>\n\t<string>FooBin</string></dict></plist>');
  fs.writeFileSync(path.join(foo, 'Contents', 'MacOS', 'FooBin'), '');
  assert.equal(macExecutable(foo), path.join(foo, 'Contents', 'MacOS', 'FooBin'));
  assert.equal(macExecutable(foo + '/'), path.join(foo, 'Contents', 'MacOS', 'FooBin'));
  const bar = path.join(dir, 'Bar.app');
  fs.mkdirSync(path.join(bar, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bar, 'Contents', 'MacOS', 'Bar'), '');
  assert.equal(macExecutable(bar), path.join(bar, 'Contents', 'MacOS', 'Bar'), 'no Info.plist: the bundle name');
  const inner = path.join(foo, 'Contents', 'MacOS', 'FooBin');
  assert.equal(macExecutable(inner), inner, 'an executable inside a bundle is used as is (Playwright\'s Chrome for Testing)');
  assert.equal(macExecutable(path.join(dir, 'Missing.app')), undefined);
  assert.equal(macExecutable(dir), undefined, 'a folder that is not a bundle');
});

test('R7 F5: a relaunched app (macOS code path) is our child, and stop() kills it and its reparented helpers and waits', { skip: process.platform === 'win32' ? 'POSIX process groups' : false, timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-electron-unit-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'FakeElectron');
  fs.copyFileSync(path.resolve('test/fixtures/fake-electron.mjs'), exe);
  fs.chmodSync(exe, 0o755);
  const profile = path.join(dir, 'profile');
  const ours = () => listProcesses().filter((p) => p.args.includes(profile) && !isZombie(p));
  const launched = await relaunchWithDebugPort({ app: 'Fake', exe, args: [`--user-data-dir=${profile}`], platform: 'darwin', timeoutMs: 15_000 });
  let stopped = false;
  cleanups.push(async () => {
    if (!stopped) await launched.stop();
  });
  assert.ok(launched.proc?.pid, 'spawned directly (not handed to launchd by `open`), so we own its pid');
  assert.match(launched.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(launched.userDataDir, profile);
  const json = await (await fetch(`${launched.cdpUrl}/json/version`)).json();
  assert.equal(json.Browser, 'FakeElectron/1.0');
  // main + renderer + the crash handler that left the process group
  const deadline = Date.now() + 5000;
  while (ours().length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(ours().length, 3, JSON.stringify(ours()));
  await launched.stop();
  stopped = true;
  assert.deepEqual(ours(), [], 'stop() returns only once the app and every helper are gone');
});

// ------------------------------------------------------------ Windows spawn (R7.7)

test('R7 Windows: cmd.exe gets `/d /s /c "<command>"` verbatim, so commands with quotes are not re-quoted (mocked spawn)', async () => {
  const cmd = 'echo "a b" && findstr /c:"x y" "my file.txt"';
  assert.deepEqual(platformSpawnArgs('C:\\Windows\\system32\\cmd.exe', ['/d', '/s', '/c', cmd], 'win32'), { args: ['/d', '/s', '/c', `"${cmd}"`], windowsVerbatimArguments: true });
  assert.deepEqual(platformSpawnArgs('cmd.exe', ['/D', '/S', '/C', 'dir'], 'win32').windowsVerbatimArguments, true);
  assert.deepEqual(platformSpawnArgs('C:\\Program Files\\Git\\bin\\bash.exe', ['-c', cmd], 'win32'), { args: ['-c', cmd] }, 'other programs keep Node\'s MSVC quoting');
  assert.deepEqual(platformSpawnArgs('/bin/bash', ['-c', cmd], 'linux'), { args: ['-c', cmd] });
  const calls: { file: string; args: string[]; opts: any }[] = [];
  const fakeSpawn = ((file: string, args: string[], opts: any) => {
    calls.push({ file, args, opts });
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('a b\r\n'));
      child.emit('close', 0, null);
    });
    return child;
  }) as any;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const comspec = process.env.ComSpec;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.ComSpec = 'C:\\Windows\\system32\\cmd.exe';
  try {
    const r = await execCommand({ shellCommand: cmd, cwd: os.tmpdir(), timeoutMs: 5000, env: {}, spawnImpl: fakeSpawn });
    assert.equal(r.exitCode, 0);
    assert.equal(r.output, 'a b\r\n');
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (comspec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = comspec;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `"${cmd}"`]);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.equal(calls[0].opts.detached, false, 'no process groups on Windows');
  // and on POSIX the spec is untouched
  await execCommand({ shellCommand: 'true', cwd: os.tmpdir(), timeoutMs: 5000, env: {}, spawnImpl: fakeSpawn });
  if (process.platform !== 'win32') {
    assert.deepEqual(calls[1].args, ['-c', 'true']);
    assert.equal(calls[1].opts.windowsVerbatimArguments, undefined);
  }
});

// ------------------------------------------------------------ piped interactive CLI on Node 24+ (R7.4)

test('R7 D13/G7: a piped interactive session still runs every queued line when stdin hit EOF before the first prompt (Node 24+ readline)', async () => {
  // Node 24+ throws ERR_USE_AFTER_CLOSE from prompt() on a closed interface; the preload gives Node 20/22 the same behaviour.
  const preload = pathToFileURL(path.resolve('test/fixtures/readline-node24.mjs')).href;
  const llm = await startMockServer(() => ({ content: 'hello from the model' }));
  cleanups.push(llm.close);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-r7-home-'));
  const ws = tmpWorkspace({});
  const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--import', preload, 'src/cli/main.ts', '--cwd', ws, '--base-url', llm.url, '--model', 'mock-model', '--native-tools'], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, TUG_API_KEY: 'sk-test-1234567890abcdef' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end('say hi\r\n/help\n/exit\n'); // EOF at once; CRLF from a Windows-made script too
  });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /ERR_USE_AFTER_CLOSE|input error/);
  assert.match(r.out, /› say hi/, 'the queued line is echoed after its prompt');
  assert.match(r.out, /hello from the model/);
  assert.match(r.out, /\/goal <condition>/, '/help ran');
  assert.equal(llm.requests.length, 1);
});

// ------------------------------------------------------------ pytest-free editing eval (R7.3)

test('R7 A9: the Python editing tasks are real, solvable and corruption-detecting without pytest (built-in runner)', () => {
  const { tasks } = loadSuite(path.join(ROOT, 'evals', 'editing'));
  const py = tasks.filter((t) => (t as any).language === 'python');
  assert.equal(py.length, 7);
  const prev = process.env.TUG_MINI_PYTEST;
  process.env.TUG_MINI_PYTEST = '1';
  try {
    for (const t of py) {
      assert.equal(t.acceptance[0], 'python3 .oh-eval/pytests.py -q tests', t.id);
      assert.ok(fs.existsSync(path.join(t.dir, 'repo', '.oh-eval', 'pytests.py')), t.id);
      assert.deepEqual(checkTask(t.dir, t.acceptance), [], t.id);
    }
  } finally {
    if (prev === undefined) delete process.env.TUG_MINI_PYTEST;
    else process.env.TUG_MINI_PYTEST = prev;
  }
});

function runner(dir: string, env: NodeJS.ProcessEnv = {}): { code: number | null; out: string } {
  const r = spawnSync('python3', [path.join(ROOT, 'evals', 'editing', 'pytests.py'), '-q', 'tests'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('R7 A9: the built-in runner fails on failures and on tests that need pytest fixtures, and finds nothing → 5', () => {
  const ws = tmpWorkspace({
    'lib.py': 'def two():\n    return 2\n',
    'tests/test_a.py': 'from lib import two\n\ndef test_ok():\n    assert two() == 2\n\nclass TestB:\n    def test_bad(self):\n        assert two() == 3\n',
  });
  const r = runner(ws, { TUG_MINI_PYTEST: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAILED tests\/test_a\.py::TestB::test_bad/);
  assert.match(r.out, /1 failed, 1 passed \(built-in runner: pytest is not installed\)/);
  fs.writeFileSync(path.join(ws, 'tests', 'test_a.py'), 'def test_tmp(tmp_path):\n    assert tmp_path\n');
  const f = runner(ws, { TUG_MINI_PYTEST: '1' });
  assert.equal(f.code, 1);
  assert.match(f.out, /needs pytest fixture\(s\) tmp_path: install pytest/);
  fs.writeFileSync(path.join(ws, 'tests', 'test_a.py'), 'x = 1\n');
  assert.equal(runner(ws, { TUG_MINI_PYTEST: '1' }).code, 5);
});

test('R7 A9: with pytest installed the runner is plain `python3 -m pytest` (nothing weakened)', { skip: needsPytest() }, () => {
  const ws = tmpWorkspace({ 'lib.py': 'def two():\n    return 2\n', 'tests/test_a.py': 'from lib import two\n\ndef test_ok():\n    assert two() == 2\n\ndef test_bad():\n    assert two() == 3\n' });
  const r = runner(ws);
  assert.equal(r.code, 1);
  assert.match(r.out.replace(/\x1b\[[0-9;]*m/g, ''), /1 failed, 1 passed in [\d.]+s/, 'pytest\'s own summary'); // CI may force colour
  assert.doesNotMatch(r.out, /built-in runner/);
});

// ------------------------------------------------------------ CI workflows (R7 pipeline)

const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const workflow = (f: string) => parseYaml(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'), { strict: true, uniqueKeys: true });
const runs = (job: any) => job.steps.map((s: any) => s.run ?? '').join('\n');

test('R7 CI: every workflow file is valid YAML with triggers, jobs, runners and steps', () => {
  const files = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
  assert.deepEqual(files.sort(), ['ci.yml', 'release.yml', 'tugline-replay.yml']);
  for (const f of files) {
    const wf = workflow(f);
    assert.ok(wf.name && wf.on && wf.jobs, f);
    for (const [id, job] of Object.entries<any>(wf.jobs)) {
      assert.ok(job['runs-on'], `${f}:${id} runs-on`);
      assert.ok(Array.isArray(job.steps) && job.steps.length, `${f}:${id} steps`);
      for (const s of job.steps) assert.ok(s.uses || s.run, `${f}:${id}: a step without uses/run`);
      for (const s of job.steps) if (s.uses) assert.match(s.uses, /^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@v\d+$/, `${f}:${id}: pinned major version (${s.uses})`);
    }
  }
});

test('R7 CI: every composite action under .github/actions parses (inputs, composite steps with a shell)', () => {
  const dir = path.join(ROOT, '.github', 'actions');
  const actions = fs.readdirSync(dir).map((d) => path.join(dir, d, 'action.yml')).filter((f) => fs.existsSync(f));
  assert.ok(actions.length >= 1);
  for (const f of actions) {
    const a = parseYaml(fs.readFileSync(f, 'utf8'), { strict: true, uniqueKeys: true });
    assert.ok(a.name && a.runs, f);
    if (a.runs.using === 'composite') for (const s of a.runs.steps) assert.ok(s.uses || (s.run && s.shell), `${f}: run steps need a shell`);
  }
});

test('R7 CI: ci.yml runs clean install, both typechecks and npm test on ubuntu/macos/windows × Node 20/22/24', () => {
  const wf = workflow('ci.yml');
  const t = wf.jobs.test;
  assert.deepEqual(t.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.deepEqual(t.strategy.matrix.node, ['20', '22', '24']);
  assert.equal(t.strategy['fail-fast'], false);
  const s = runs(t);
  assert.match(s, /npm ci\n/);
  assert.match(s, /npm ci --prefix vscode/);
  assert.match(s, /npm run typecheck/);
  assert.match(s, /tsc -p vscode\/tsconfig\.json/);
  assert.match(s, /npx playwright install --with-deps chromium/, 'browsers are installed in CI (never on the dev machine)');
  assert.match(s, /npm test/);
  assert.match(s, /pip install pytest/);
  assert.equal(wf.env.TUG_REQUIRE_PYTEST, '1', 'CI does not skip pytest tests');
  assert.equal(t.steps.find((x: any) => /setup-node/.test(x.uses ?? '')).with['node-version'], '${{ matrix.node }}');
  // the serial group, the VS Code E2E and the artefact smoke
  assert.match(runs(wf.jobs['browser-desktop']), /npm run test:serial/);
  const e2e = wf.jobs['vscode-e2e'];
  assert.equal(e2e['runs-on'], 'ubuntu-latest');
  assert.match(runs(e2e), /xvfb-run -a node test\/runTest\.mjs/);
  const pkg = runs(wf.jobs.package);
  assert.match(pkg, /npm run build/);
  assert.match(pkg, /npm pack/);
  assert.match(pkg, /npm run vscode:package/);
  assert.match(pkg, /unzip -l/);
  assert.match(pkg, /smoke-artefacts\.mjs --tgz .* --vsix .* --require-vsix/);
  assert.ok(wf.jobs.package.steps.some((x: any) => /upload-artifact/.test(x.uses ?? '')), 'artefacts uploaded');
  const smoke = wf.jobs.smoke;
  assert.deepEqual(smoke.needs, 'package');
  assert.deepEqual(smoke.strategy.matrix.os, ['ubuntu-latest', 'macos-latest', 'windows-latest']);
  assert.ok(smoke.steps.some((x: any) => /download-artifact/.test(x.uses ?? '')), 'the smoke installs the uploaded artefact');
  assert.doesNotMatch(runs(smoke), /npm (ci|run build)/, 'the smoke does not rebuild');
});

test('R7 CI: the replay workflow builds the PR\'s source, has no placeholder, and fails with no recordings unless allowed', () => {
  const wf = workflow('tugline-replay.yml');
  const job = wf.jobs.replay;
  const s = runs(job);
  assert.doesNotMatch(s, /npm install -g tugline\s*$|npm install -g tugline\n/m, 'not the published package');
  assert.match(s, /npm ci\n\s*npm run build\n\s*npm pack/);
  assert.match(s, /npm install -g "\$RUNNER_TEMP"\/tugline-\*\.tgz/);
  assert.doesNotMatch(s, /start your site here/, 'placeholder step removed');
  assert.match(s, /node evals\/browser\/serve\.mjs "\$SITE_PORT"/);
  assert.match(s, /if \[ "\$COUNT" -eq 0 \]; then\n\s*if \[ "\$ALLOW_EMPTY" = "true" \]/);
  assert.match(job.env.ALLOW_EMPTY, /inputs\.allow_empty == true \|\| vars\.TUGLINE_REPLAY_ALLOW_EMPTY == 'true'/);
  assert.ok(fs.existsSync(path.join(ROOT, 'ci', 'replays', 'order-form', 'trajectory.jsonl')), 'this repository has a recorded run to replay');
  // Run the replay step's script for real with an empty directory: it must fail, and pass only when allowed.
  if (process.platform === 'win32') return;
  const step = job.steps.find((x: any) => /Replay every recorded run/.test(x.name)).run;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-replays-'));
  const bash = (allow: string) => spawnSync('bash', ['-e', '-c', step], { encoding: 'utf8', env: { ...process.env, REPLAY_DIR: empty, ALLOW_EMPTY: allow, RUNNER_TEMP: empty } });
  const strict = bash('false');
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /::error title=No recorded runs::/);
  const allowed = bash('true');
  assert.equal(allowed.status, 0, allowed.stdout);
  assert.match(allowed.stdout, /::warning title=No recorded runs::/);
  fs.rmSync(empty, { recursive: true, force: true });
});

// ------------------------------------------------------------ artefact smoke helpers (R7 pipeline)

test('R7 smoke: the .vsix check reads the zip directory and flags missing or dev files', () => {
  const vsix = path.join(ROOT, 'test', 'fixtures', 'tiny-1.0.0.vsix');
  const entries = listZip(vsix);
  assert.ok(entries.some((e: any) => e.name === 'extension/dist/extension.js'));
  assert.deepEqual(checkVsix(vsix, '1.0.0'), []);
  assert.deepEqual(checkVsix(vsix, '9.9.9'), ['vsix version 1.0.0 != 9.9.9']);
  const notZip = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-vsix-')), 'x.vsix');
  fs.writeFileSync(notZip, 'not a zip');
  assert.throws(() => listZip(notZip), /not a zip file/);
});

test('R7 smoke: scripts/mock-openai.mjs answers /models, plain chat and the doctor tool probe (streamed and not)', async () => {
  const m = await startMockOpenAI();
  cleanups.push(m.close);
  const models = await (await fetch(`${m.url}/models`)).json();
  assert.deepEqual(models.data.map((x: any) => x.id), ['mock-model']);
  const post = (body: any) => fetch(`${m.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'mock-model', ...body }) });
  const plain = await (await post({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }] })).json();
  assert.equal(plain.choices[0].message.content, 'OK');
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const call = await (await post({ messages: [{ role: 'user', content: 'What is the weather in Dubai? Use the get_weather tool.' }], tools })).json();
  assert.equal(call.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(JSON.parse(call.choices[0].message.tool_calls[0].function.arguments), { city: 'Dubai' });
  const sse = await (await post({ stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'Reply with exactly: SMOKE-OK' }] })).text();
  assert.match(sse, /"content":"SMOKE-OK"/);
  assert.match(sse, /"usage":/);
  assert.match(sse, /data: \[DONE\]/);
});

// ------------------------------------------------------------ guard: no Linux-only invocations come back

test('R7 guard: tests and product code use the portable process helper, not `ps --ppid`, and no GNU-only `sed -i` commands', () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'fixtures', 'dist'].includes(e.name)) walk(p);
      } else if (/\.(m?ts|mjs|js|sh)$/.test(e.name) && p !== import.meta.filename) files.push(p); // not this file: its patterns would match themselves
    }
  };
  for (const d of ['src', 'test', 'scripts', 'vscode/src', 'evals']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  const bad: string[] = [];
  // GNU-only in-place sed: `sed -i 's…'`, `sed -E -i -e …`, `sed -i s/…/`, and the argv form spawn('sed', ['-i', …]).
  // (`sed -i.bak` works on both BSD and GNU and is not flagged.)
  const GNU_SED = [
    /\bsed\s+(?:-[A-Za-hj-z]\w*\s+)*-i\s+(?:-e\s+|--\s+)*(?:'|"|s[/#|]|\$)/,
    /\bsed\b[^\n]*\s--in-place\b/, // GNU-only long option (BSD sed has no --in-place)
    /['"]sed['"]\s*,\s*\[\s*(?:['"]-[A-Za-hj-z]\w*['"]\s*,\s*)*['"](?:-i|--in-place[^'"]*)['"]/,
  ];
  // Files that only ever run on macOS, where BSD `sed -i ''` is the correct form.
  const MACOS_ONLY = new Set(['scripts/device-checks/sandbox-macos.sh']);
  // The reviewer's attack scripts hold GNU-only commands as data to test this guard; they are not shipped or run by the product.
  const ATTACK_DATA = (rel: string) => rel.startsWith('scripts/review/');
  // A test-file line may carry `portability-ok: parser fixture` when the command is a string handed to the
  // static parser, never executed. The marker is void on a line that also runs something.
  const RUNS = /\b(?:exec(?:Sync|File|FileSync)?|spawn(?:Sync)?|runShell|execa|child_process)\b|\b(?:bash|run|sh|shell|cmd)\s*\(|(?:\b(?:sh|bash)|\$)\s*`|\bsh\s+-c\b/;
  // A comment line: `//`, `#`, or inside a block comment. A line that closes a block comment and goes on with code is code.
  const isComment = (l: string) => {
    const t = l.replace(/^\s*\/\*.*?\*\//, '').trimStart();
    if (t !== l.trimStart()) return t === '' || /^(?:\/\/|#(?!!))/.test(t);
    return /^(?:\/\/|\/\*(?!.*\*\/)|\*(?!\/)|#(?!!))/.test(t);
  };
  // A marker on an argument line is void when the statement it continues runs something (a multi-line call).
  const continuesRun = (lines: string[], i: number) => {
    for (let j = i - 1; j >= 0 && j >= i - 8; j--) {
      const p = lines[j].trimEnd();
      if (!/[(,[{`+]$/.test(p)) return false;
      if (RUNS.test(p)) return true;
    }
    return false;
  };
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (isComment(l)) return;
      const fixture = rel.startsWith('test/') && l.includes('portability-ok: parser fixture') && !RUNS.test(l) && !continuesRun(lines, i);
      if (/['"]--ppid['"]|ps -o [^\n]*--ppid/.test(l)) bad.push(`${rel}:${i + 1}: --ppid`);
      if (!fixture && !MACOS_ONLY.has(rel) && !ATTACK_DATA(rel) && GNU_SED.some((re) => re.test(l))) bad.push(`${rel}:${i + 1}: GNU sed -i`);
    });
  }
  assert.deepEqual(bad, []);
  // The patterns themselves (so a loosened regex is caught too).
  for (const c of [`sed -i 's/a/b/' f`, `sed -E -i -e 's/a/b/' f`, `sed -i s/a/b/ f`, `spawn('sed', ['-i', 's/a/b/', 'f'])`, `spawnSync("sed", ["-E", "-i", "x"])`]) assert.ok(GNU_SED.some((re) => re.test(c)), c);
  for (const c of [`sed -i.bak 's/a/b/' f`, `sed 's/a/b/' f > g`, `perl -pi -e 's/a/b/' f`]) assert.ok(!GNU_SED.some((re) => re.test(c)), c);
  assert.ok(RUNS.test(`execSync("sed -i 's/a/b/' f") // portability-ok: parser fixture`), 'the marker is void on an executed line');
  // Reviewer bypasses (scripts/review/v1.1/r7-guard-bypass.mjs).
  assert.ok(!isComment(`/* note */ execSync("sed -i 's/a/b/' f")`), 'code after a closed block comment is code');
  assert.ok(isComment(' * sed -i is GNU-only') && isComment('// x') && isComment('/* open') && isComment('# x'));
  assert.ok(continuesRun(['execSync(', `  "sed -i 's/a/b/' f", // portability-ok: parser fixture`], 1), 'multi-line call');
  assert.ok(!continuesRun(['const cases = [', `  "sed -i 's/a/b/' f", // portability-ok: parser fixture`], 1), 'a plain data array');
  for (const c of [`sed --in-place 's/a/b/' f`, `sed -i -- 's/a/b/' f`, `spawn('sed', ['--in-place', 'x'])`]) assert.ok(GNU_SED.some((re) => re.test(c)), c);
  for (const c of [`run("sed -i 's/a/b/' f")`, "await sh`sed -i 's/a/b/' f`", "await $`sed -i x`"]) assert.ok(RUNS.test(c), c);
});
