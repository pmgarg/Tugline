/**
 * V0.1 AC3: switching off the permission engine for ONE surface makes AC1 fail for that surface only.
 *
 * The mutation: every agent created with the TypeScript SDK's surface label gets a policy that allows everything
 * (`PermissionPolicy.check` → allow). The SDK driver must then fail at least the scenarios a policy decision guards,
 * while the other in-process surfaces (tug serve, scheduler), run in the same process with the same mutation
 * installed, still pass all 8. This is the reviewer's §0.3 mutation check, automated.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../../src/core/agent/agent.js';
import { closeSandboxProxies } from '../../src/core/sandbox/index.js';
import { loadDrivers, runScenario, SCENARIOS } from './harness.js';

after(() => closeSandboxProxies());

const SDK_SURFACE = 'application (Tugline SDK)';
const original = Agent.create;
function mutate(on: boolean): void {
  (Agent as any).create = on
    ? async (o: any) => {
        const a = await original.call(Agent, o);
        if (o.surface === SDK_SURFACE) (a.policy as any).check = () => ({ decision: 'allow', reason: 'MUTATION: permission engine off for this surface' });
        return a;
      }
    : original;
}

test('V0.1 AC3: the permission engine off for the TS SDK fails the SDK only; tug serve and the scheduler still pass', { timeout: 15 * 60_000 }, async () => {
  const all = await loadDrivers();
  const pick = (id: string) => all.find((d) => d.id === id)!;
  mutate(true);
  try {
    const failed: Record<string, string[]> = {};
    for (const d of [pick('sdk-ts'), pick('serve-jsonrpc'), pick('scheduler')]) {
      failed[d.id] = [];
      for (const s of SCENARIOS) {
        const { verdict } = await runScenario(d, s.id);
        if (verdict.failures.length) failed[d.id]!.push(s.id);
      }
    }
    assert.ok(failed['sdk-ts']!.length >= 3, `the mutated SDK surface should fail the policy-guarded scenarios; it failed ${JSON.stringify(failed['sdk-ts'])}`);
    for (const id of ['protected-path-shell', 'symlink-escape', 'injected-approval']) assert.ok(failed['sdk-ts']!.includes(id), `sdk-ts did not fail ${id} without its permission engine`);
    assert.deepEqual(failed['serve-jsonrpc'], [], 'tug serve is unaffected');
    assert.deepEqual(failed['scheduler'], [], 'the scheduler is unaffected');
  } finally {
    mutate(false);
  }
});

test('V0.1 AC3: control: with the mutation removed the SDK passes again', { timeout: 10 * 60_000 }, async () => {
  const d = (await loadDrivers()).find((x) => x.id === 'sdk-ts')!;
  for (const s of SCENARIOS) {
    const { verdict } = await runScenario(d, s.id);
    assert.deepEqual(verdict.failures, [], `${s.id}`);
  }
});
