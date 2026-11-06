/**
 * WS2 review fix 3 (C4 in VS Code): VS Code settings are layered over config
 * files, and the managed policy must still win — the MCP allowlist,
 * disableAutoMode (approver off) and a locked endpoint hold against conflicting
 * settings, and every client the extension builds uses the governed profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clientProfile, governedConfig, lockedFields } from '../vscode/src/settingsConfig.js';
import { applySelection } from '../vscode/src/modelPick.js';
import { tmpWorkspace } from './helpers.js';

function managed(policy: Record<string, unknown>): NodeJS.ProcessEnv {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oh-managed-')), 'managed.json');
  fs.writeFileSync(f, JSON.stringify(policy));
  return { ...process.env, TUG_MANAGED_POLICY: f, TUG_BASE_URL: '', TUG_MODEL: '', TUG_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '' };
}

/** VS Code settings that conflict with the policy (as a user could set them). */
const SETTINGS: Record<string, unknown> = {
  baseUrl: 'https://attacker.example/v1',
  model: 'other-model',
  extraHeaders: { 'X-Exfil': '1' },
  permissionMode: 'yolo',
  mcpServers: { rogue: { command: 'node', args: ['rogue.mjs'] }, allowed: { command: 'node', args: ['ok.mjs'] } },
  'approver.enabled': true,
  'browser.enabled': true,
};
const get = (s: Record<string, unknown>) => (k: string) => s[k];
const NOSYS = '/nonexistent/tugline/managed.json';

test('C4 (VS Code): a server from the mcpServers setting outside the managed allowlist never starts', () => {
  const ws = tmpWorkspace({});
  const cfg = governedConfig({ workspace: ws, get: get(SETTINGS), env: managed({ allowMcpServers: ['allowed'] }), noUserConfig: true, systemPath: NOSYS });
  assert.deepEqual(Object.keys(cfg.mcpServers), ['allowed']);
  assert.ok(cfg.managed!.violations.some((v) => /MCP server "rogue"/.test(v)));
  assert.deepEqual(Object.keys((cfg as any).__mcpSources), ['allowed']);
  // without a policy the setting's servers are used
  const free = governedConfig({ workspace: ws, get: get(SETTINGS), env: { ...process.env, TUG_MANAGED_POLICY: '' }, noUserConfig: true, systemPath: NOSYS });
  assert.deepEqual(Object.keys(free.mcpServers).sort(), ['allowed', 'rogue']);
});

test('C4 (VS Code): disableAutoMode beats the permissionMode and approver.enabled settings', () => {
  const ws = tmpWorkspace({});
  const cfg = governedConfig({ workspace: ws, get: get(SETTINGS), env: managed({ disableAutoMode: true }), noUserConfig: true, systemPath: NOSYS });
  assert.equal(cfg.permissionMode, 'ask');
  assert.equal(cfg.approver?.enabled, false, 'the approver setting cannot re-enable auto approval');
  assert.equal(cfg.browser?.enabled, true, 'unrelated settings still apply');
});

test('C4 (VS Code): a locked endpoint wins over conflicting settings for the agent AND for every extension client (model list, test, inline edit, autocomplete, picker)', () => {
  const ws = tmpWorkspace({});
  const lock = { baseUrl: 'https://llm.corp.example/v1', model: 'corp-model', headers: { 'X-Corp': 'yes' } };
  const cfg = governedConfig({ workspace: ws, get: get(SETTINGS), apiKey: 'sk-user-key-123456', env: managed({ lockedProfile: lock }), noUserConfig: true, systemPath: NOSYS });
  const p = cfg.profiles[cfg.profile];
  assert.equal(p.baseUrl, lock.baseUrl);
  assert.equal(p.model, lock.model);
  assert.deepEqual(p.headers, lock.headers);
  assert.equal(p.apiKey, 'sk-user-key-123456', 'the key goes to the locked endpoint');
  assert.ok(cfg.managed!.violations.some((v) => /baseUrl is locked/.test(v)));
  // clients built outside the agent loop
  const c = clientProfile(cfg);
  assert.equal(c.baseUrl, lock.baseUrl);
  assert.equal(clientProfile(cfg, 'nonexistent-profile').baseUrl, lock.baseUrl);
  assert.deepEqual(lockedFields(cfg), lock);
  // the model picker cannot switch away from the lock
  const originals = JSON.parse(JSON.stringify(cfg.profiles));
  applySelection(cfg, originals, cfg.profile, { choice: 'model:gpt-oss-120b', effort: 'low' });
  assert.equal(cfg.profiles[cfg.profile].model, 'corp-model');
  assert.equal(clientProfile(cfg).baseUrl, lock.baseUrl);
  // without a policy the settings win (unchanged behaviour)
  const free = governedConfig({ workspace: ws, get: get(SETTINGS), env: { ...process.env, TUG_MANAGED_POLICY: '' }, noUserConfig: true, systemPath: NOSYS });
  assert.equal(clientProfile(free).baseUrl, 'https://attacker.example/v1');
  assert.equal(free.permissionMode, 'yolo');
  assert.equal(lockedFields(free), undefined);
});
