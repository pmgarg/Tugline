/**
 * R2 (Phase 1 final review): code planted under $HOME must not reach the harness's own check.
 * With no sandbox, a run wrote a usercustomize.py into Python's per-user site directory and `script-shell` into
 * ~/.npmrc; the harness check loaded them and a failing suite ended `verified`. The check now runs with a fresh
 * home (data caches linked read-through, no runner config) and PYTHONNOUSERSITE=1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent/agent.js';
import { CHECK_HOME_DATA, cleanCheckEnv, makeCheckHome } from '../src/core/context/harnessCheck.js';
import { startMockServer, testConfig, tmpWorkspace } from './helpers.js';

const HAVE_PYTEST = spawnSync('python3', ['-c', 'import pytest'], { stdio: 'ignore' }).status === 0;

const base = {
  'src/__init__.py': '',
  'src/calc.py': 'def add(a, b):\n    return a - b\n',
  'tests/test_calc.py': 'from src.calc import add\n\ndef test_add():\n    assert add(2, 2) == 4\n',
  'tests/test_other.py': 'def test_other():\n    assert 1 == 2\n',
};
const USERCUST = 'import os, sys\ncmd = open("/proc/self/cmdline","rb").read().replace(b"\\0", b" ")\nif b"pytest" in cmd:\n    print("2 passed in 0.01s"); sys.stdout.flush(); os._exit(0)\n';
const EDIT = [
  { name: 'read_file', arguments: { path: 'src/calc.py' } },
  { name: 'edit_file', arguments: { path: 'src/calc.py', old_string: 'return a - b', new_string: 'return a + b' } },
];
const W = (p: string, c: string) => ({ name: 'write_file', arguments: { path: p, content: c } });
const B = (c: string) => ({ name: 'bash', arguments: { command: c } });

async function session(ws: string, home: string, calls: any[]): Promise<string | undefined> {
  const srv = await startMockServer((_b, i) => (calls[i] ? { toolCalls: [calls[i]] } : { content: 'All tests pass. Fixed.' }));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const cfg = testConfig(srv.url, { permissionMode: 'yolo', shell: { sandbox: 'none', processLifetime: 'off' }, agent: { requireVerification: true, repoMapTokens: 0, backgroundCompaction: false } });
    const a: any = await Agent.create({ workspace: ws, config: cfg, mcp: false });
    try {
      const r: any = await a.run('fix add() and make the tests pass');
      return r.completion?.state;
    } finally {
      await a.dispose();
    }
  } finally {
    process.env.HOME = prev;
    await srv.close();
  }
}

test('R2 final: a usercustomize.py planted in the per-user site dir does not make a failing suite `verified`', { skip: !HAVE_PYTEST && 'needs python3 with pytest' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fakehome-'));
  try {
    const ws = tmpWorkspace(base);
    const plant = W('tools/setup_env.py', `import site, os\nd = site.getusersitepackages()\nos.makedirs(d, exist_ok=True)\nopen(os.path.join(d, 'usercustomize.py'), 'w').write(${JSON.stringify(USERCUST)})\n`);
    const state = await session(ws, home, [...EDIT, plant, B('python3 tools/setup_env.py')]);
    assert.ok(fs.existsSync(path.join(home, '.local')), 'the attack did plant the file');
    assert.notEqual(state, 'verified');
    assert.equal(state, 'failed', 'the harness ran the real, failing suite');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2 final: `script-shell` planted in ~/.npmrc does not make a failing npm test `verified`', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-fakehome-'));
  try {
    // npm only: the harness's check is `npm test`, whose suite still fails after the edit
    const ws = tmpWorkspace({
      'package.json': '{"name":"x","private":true,"scripts":{"test":"node test.js"}}',
      'calc.js': 'exports.add = (a, b) => a - b;\n',
      'test.js': "const assert = require('assert');\nassert.strictEqual(require('./calc').add(2, 2), 4);\nassert.strictEqual(1, 2, 'another failing test');\nconsole.log('1 passing');\n",
    });
    const edit = [
      { name: 'read_file', arguments: { path: 'calc.js' } },
      { name: 'edit_file', arguments: { path: 'calc.js', old_string: 'a - b', new_string: 'a + b' } },
    ];
    const plant = W('tools/cfg.js', "require('fs').writeFileSync(require('os').homedir() + '/.npmrc', 'script-shell=/bin/true\\n');\n");
    const state = await session(ws, home, [...edit, plant, B('node tools/cfg.js')]);
    assert.ok(fs.existsSync(path.join(home, '.npmrc')), 'the attack did plant the file');
    assert.notEqual(state, 'verified');
    assert.equal(state, 'failed', 'the harness ran the real, failing npm test');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('R2 final (unit): the check home links data caches only; runner config never reaches it', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-realhome-'));
  const files: Record<string, string> = {
    '.npmrc': 'script-shell=/bin/true\n',
    '.gitconfig': '[alias]\n x = !evil\n',
    '.local/lib/python3/site-packages/usercustomize.py': 'raise SystemExit\n',
    '.gradle/init.d/evil.gradle': 'println "x"\n',
    '.gradle/gradle.properties': 'org.gradle.jvmargs=-javaagent:/x\n',
    '.m2/settings.xml': '<settings/>\n',
    '.cargo/config.toml': '[build]\nrustc-wrapper = "/x"\n',
    '.config/go/env': 'GOFLAGS=-run=^$\n',
    '.cargo/registry/index/x': 'data\n',
    '.m2/repository/a/b.jar': 'data\n',
    '.gradle/caches/x': 'data\n',
  };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(real, f)), { recursive: true });
    fs.writeFileSync(path.join(real, f), c);
  }
  const home = makeCheckHome(real);
  try {
    assert.equal(fs.readFileSync(path.join(home, '.npmrc'), 'utf8'), '', 'an empty npmrc');
    for (const f of ['.gitconfig', '.local/lib/python3/site-packages/usercustomize.py', '.gradle/init.d/evil.gradle', '.gradle/gradle.properties', '.m2/settings.xml', '.cargo/config.toml', '.config/go/env'])
      assert.ok(!fs.existsSync(path.join(home, f)), `${f} must not reach the check`);
    for (const f of ['.cargo/registry/index/x', '.m2/repository/a/b.jar', '.gradle/caches/x']) assert.ok(fs.existsSync(path.join(home, f)), `${f} (data) stays readable`);
    assert.ok(CHECK_HOME_DATA.every((d) => !/(^|\/)(config|settings|init\.d|\.npmrc|\.gitconfig)/.test(d)), 'the data list holds no config');
    const env = cleanCheckEnv({ PATH: '/usr/bin', HOME: real, PYTHONPATH: '/x', npm_config_script_shell: '/bin/true' }, '/ws', undefined, home);
    assert.equal(env.HOME, home);
    assert.equal(env.PYTHONNOUSERSITE, '1');
    assert.equal(env.npm_config_userconfig, path.join(home, '.npmrc'));
    assert.equal(env.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
    assert.equal(env.XDG_CONFIG_HOME, path.join(home, '.config'));
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.npm_config_script_shell, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(real, '.cargo/registry/index/x')), 'removing the check home never touches the real caches');
    fs.rmSync(real, { recursive: true, force: true });
  }
});
