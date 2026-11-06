// End-to-end test: launches a real VS Code (under Xvfb) with the extension, points it at an
// LLM endpoint (mock by default, or a real one via TUG_E2E_BASE_URL), runs a prompt through the
// chat panel and checks the result on disk. Also captures a screenshot of the window.
import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-vscode-ws-'));
fs.writeFileSync(path.join(ws, 'calc.py'), 'def average(numbers):\n    """Mean of a list. Returns 0 for an empty list."""\n    return sum(numbers) / len(numbers)\n');
fs.mkdirSync(path.join(ws, 'tests'));
fs.writeFileSync(path.join(ws, 'tests', 'test_calc.py'), 'from calc import average\n\ndef test_empty():\n    assert average([]) == 0\n');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-vscode-user-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'window.zoomLevel': 0, 'workbench.colorTheme': 'Default Dark Modern' }));
process.env.TUG_E2E_WORKSPACE = ws;
// The harness keeps sessions, checkpoints and config under ~/.tugline: isolate it.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-vscode-home-'));
process.env.TUG_E2E_HOME = home;
// The scenarios script every model turn. The automatic harness check (agent.harnessCheck "auto") runs the
// workspace's tests at run end whenever pytest is installed on the machine, which adds an unscripted command (and,
// with unsaved buffers, an unscripted "save first?" question); it is tested in test/*.test.ts, so it is off here.
fs.mkdirSync(path.join(home, '.tugline'), { recursive: true });
fs.writeFileSync(path.join(home, '.tugline', 'config.json'), JSON.stringify({ agent: { harnessCheck: 'off' } }, null, 2));
await runTests({
  version: process.env.VSCODE_VERSION || 'stable',
  extensionDevelopmentPath: path.resolve(here, '..'),
  extensionTestsPath: path.resolve(here, 'suite.cjs'),
  extensionTestsEnv: { HOME: home, TUG_E2E_HOME: home, TUG_E2E_WORKSPACE: ws, ...(process.env.TUG_E2E_ONLY ? { TUG_E2E_ONLY: process.env.TUG_E2E_ONLY } : {}), ...(process.env.TUG_E2E_SCENARIO_MS ? { TUG_E2E_SCENARIO_MS: process.env.TUG_E2E_SCENARIO_MS } : {}) },
  launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu'],
});
console.log('E2E OK');
