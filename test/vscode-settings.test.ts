/**
 * WS9 fix: VS Code settings layer over config files ONLY where the user set
 * them. `WorkspaceConfiguration.get` returns the contributed default for unset
 * keys (model "qwen3-coder:30b", contextWindow 32768, …), which used to override
 * ~/.tugline/config.json and project config. `explicitSettings` reads
 * `inspect()` instead, with application-scoped keys from the user (global) value only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPLICATION_SCOPED, clientProfile, explicitSettings, governedConfig, ideFromSettings, type SettingInspect } from '../vscode/src/settingsConfig.js';
import { ideConfig } from '../src/core/host/vscode-contract.js';
import { tmpWorkspace } from './helpers.js';

// This file's process gets its own HOME, so ~/.tugline/config.json is a temp file.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-ws9-home-'));
process.env.HOME = HOME;
const OH = path.join(HOME, '.tugline');
fs.mkdirSync(OH, { recursive: true });
const ENV: NodeJS.ProcessEnv = { ...process.env, HOME, TUG_MANAGED_POLICY: '', TUG_BASE_URL: '', TUG_MODEL: '', TUG_API_KEY: '', OPENAI_BASE_URL: '', OPENAI_API_KEY: '', TUG_CONTEXT_WINDOW: '', TUG_PROFILE: '' };
const NOSYS = '/nonexistent/tugline/managed.json';

const PKG = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vscode', 'package.json'), 'utf8'));
const props: Record<string, any> = Object.assign({}, ...[PKG.contributes.configuration].flat().map((c: any) => c.properties));
const DEFAULTS = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.replace(/^tugline\./, ''), v.default]));

/** A fake `WorkspaceConfiguration.inspect` with the contributed defaults and the given user values. */
function inspector(values: { global?: Record<string, unknown>; workspace?: Record<string, unknown>; folder?: Record<string, unknown> } = {}) {
  return (k: string): SettingInspect | undefined => (k in DEFAULTS || k in (values.global ?? {}) ? { defaultValue: DEFAULTS[k], globalValue: values.global?.[k], workspaceValue: values.workspace?.[k], workspaceFolderValue: values.folder?.[k] } : undefined);
}
/** What the old code did: `get` = default when unset. */
const plainGet = (k: string) => DEFAULTS[k];

function withUserConfig(cfg: unknown): void {
  fs.writeFileSync(path.join(OH, 'config.json'), JSON.stringify(cfg));
}

test('WS9 settings: a config-file model X with no VS Code value is used; an explicit VS Code value Y wins', () => {
  const ws = tmpWorkspace({});
  withUserConfig({ profiles: { default: { model: 'model-x', baseUrl: 'http://gpu-box:8000/v1', contextWindow: 65536 } } });
  const unset = governedConfig({ workspace: ws, get: explicitSettings(inspector()), env: ENV, systemPath: NOSYS });
  const p = clientProfile(unset);
  assert.equal(p.model, 'model-x', 'the contributed default "qwen3-coder:30b" must not shadow the config file');
  assert.equal(p.baseUrl, 'http://gpu-box:8000/v1');
  assert.equal(p.contextWindow, 65536);
  // regression guard: the old `get` (defaults included) is what broke it
  assert.equal(clientProfile(governedConfig({ workspace: ws, get: plainGet, env: ENV, systemPath: NOSYS })).model, DEFAULTS.model);

  const set = governedConfig({ workspace: ws, get: explicitSettings(inspector({ global: { model: 'model-y', contextWindow: 16384 } })), env: ENV, systemPath: NOSYS });
  assert.equal(clientProfile(set).model, 'model-y');
  assert.equal(clientProfile(set).contextWindow, 16384);
  assert.equal(clientProfile(set).baseUrl, 'http://gpu-box:8000/v1', 'keys the user did not set still come from the file');
});

test('WS9 settings: with neither a config file nor a setting, the core defaults apply', () => {
  const ws = tmpWorkspace({});
  withUserConfig({});
  const p = clientProfile(governedConfig({ workspace: ws, get: explicitSettings(inspector()), env: ENV, systemPath: NOSYS }));
  assert.equal(p.baseUrl, 'http://localhost:11434/v1');
  assert.ok(p.model);
});

test('WS9 settings: application-scoped keys read only the user (global) value; others follow folder > workspace > user', () => {
  const get = explicitSettings(inspector({ global: { model: 'user-m' }, workspace: { baseUrl: 'https://evil.example/v1', model: 'ws-m', permissionMode: 'yolo' }, folder: { contextWindow: 8192 } }));
  assert.equal(get('baseUrl'), undefined, 'a workspace value of an application-scoped key is ignored, as VS Code does');
  assert.equal(get('permissionMode'), undefined);
  assert.equal(get('model'), 'ws-m');
  assert.equal(get('contextWindow'), 8192);
  assert.equal(get('maxOutputTokens'), undefined, 'unset → undefined, never the default');
});

test('WS9 settings: APPLICATION_SCOPED matches vscode/package.json', () => {
  const fromPkg = Object.entries(props).filter(([, v]) => v.scope === 'application').map(([k]) => k.replace(/^tugline\./, '')).sort();
  assert.deepEqual([...APPLICATION_SCOPED].sort(), fromPkg);
});

test('WS9 settings: ide keys from config files are no longer shadowed by setting defaults; set keys still win', () => {
  const ws = tmpWorkspace({});
  withUserConfig({ ide: { autoSave: false, notifyAfterMs: 5000, autocomplete: { enabled: true, template: 'codestral' } } });
  const ide = ideConfig(governedConfig({ workspace: ws, get: explicitSettings(inspector()), env: ENV, systemPath: NOSYS, ide: ideFromSettings(explicitSettings(inspector())) }));
  assert.equal(ide.autoSave, false);
  assert.equal(ide.notifyAfterMs, 5000);
  assert.equal(ide.autocomplete.enabled, true);
  assert.equal(ide.autocomplete.template, 'codestral');
  const g = explicitSettings(inspector({ global: { autoSave: true, 'autocomplete.debounceMs': 400 } }));
  const ide2 = ideConfig(governedConfig({ workspace: ws, get: g, env: ENV, systemPath: NOSYS, ide: ideFromSettings(g) }));
  assert.equal(ide2.autoSave, true);
  assert.equal(ide2.autocomplete.debounceMs, 400);
  assert.equal(ide2.autocomplete.template, 'codestral', 'autocomplete keys merge per key');
});
