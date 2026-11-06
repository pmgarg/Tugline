/**
 * N43 SAC7 (WS23): WS18's V0.1 suite (copied from ws18-sandbox c2fb131; reconcile at merge) with every scenario in
 * the N43 `auto` mode, on every driver, twice: with the default sandbox and with no OS sandbox. The scripted model
 * answers every classifier call ALLOW (harness.ts `isClassifierCall`), the worst case, so what keeps each scenario
 * safe is the floor, Rule of Two, protected paths, budget admission, the prereq stop, secret scrubbing and the
 * sandbox, never the classifier. The same checks as WS18's suite.ts: identical decisions and identical normalised
 * journal events across surfaces, every hash chain intact (S8), the sandbox in force is the expected runner and no
 * command ran under another one.
 *
 *   node --import tsx --test test/conformance/automode.test.ts
 *   TUG_CONFORMANCE_DRIVERS=sdk-ts,acp node --import tsx --test test/conformance/automode.test.ts
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSandboxProxies, selectRunner } from '../../src/core/sandbox/index.js';
import { defaultConfig } from '../../src/core/config.js';
import { loadDrivers, runScenario, selectedDrivers, skipReason, SCENARIOS } from './harness.js';
import { SCENARIO_IDS } from './types.js';

after(() => closeSandboxProxies());

const drivers = selectedDrivers(await loadDrivers());
const VARIANTS: { label: string; overlay?: Record<string, unknown>; runner: string }[] = [
  { label: 'default sandbox', runner: selectRunner(defaultConfig()).kind },
  { label: 'no OS sandbox', overlay: { sandbox: { runner: 'none', require: false }, shell: { sandbox: 'none', requireSandbox: false, processLifetime: 'off' } }, runner: 'none' },
];

for (const v of VARIANTS) {
  const record = new Map<string, Map<string, string>>();
  const events = new Map<string, Map<string, string>>();
  for (const d of drivers) {
    test(`N43 SAC7: (conformance, ${v.label}) ${d.id} passes all ${SCENARIOS.length} V0.1 scenarios in auto mode with an always-ALLOW classifier`, { skip: skipReason(d), timeout: 25 * 60_000 }, async (t) => {
      await d.setup?.();
      try {
        for (const s of SCENARIOS) {
          await t.test(`${d.id} / ${s.id}`, async () => {
            const { verdict, obs } = await runScenario(d, s.id, { mode: 'auto', configOverlay: v.overlay, sandboxed: v.runner !== 'none' });
            // kernel-boundary builds its write target and the key path at run time, which the auto-mode floor treats
            // as reading/writing outside the workspace: the human is asked (and says no, or nobody can answer), so the
            // command never reaches the kernel. That is the stricter outcome in auto mode, on every surface; the OS
            // sandbox under auto mode is exercised by test/automode-conformance.test.ts ("… still runs inside the OS
            // sandbox"). Anything else the judge reports still fails.
            if (s.id === 'kernel-boundary' && verdict.failures.length === 1 && /^the command did not run/.test(verdict.failures[0]!)) {
              const stopped = obs.security.some((e) => e.tool === 'bash' && (e.type === 'refusal' || (e.type === 'approval' && e.decision === 'deny')));
              assert.ok(stopped, `${d.id} / ${s.id}: the command did not run, and no refusal or denied approval explains why`);
              verdict.failures = [];
              verdict.decision = 'kernel:stopped-by-auto-floor';
            }
            if (!record.has(s.id)) record.set(s.id, new Map());
            record.get(s.id)!.set(d.id, verdict.decision);
            if (!events.has(s.id)) events.set(s.id, new Map());
            events.get(s.id)!.set(d.id, (obs.journalEvents ?? []).join(' '));
            assert.deepEqual(verdict.failures, [], `${d.id} / ${s.id} (decision ${verdict.decision})`);
            // S8: a journal was written and every hash chain verifies
            assert.ok((obs.chains ?? []).some((c) => /^sessions[/\\]/.test(c.file)), `${d.id} / ${s.id}: no journal was written`);
            for (const c of obs.chains ?? []) assert.equal(c.broken, 0, `${d.id} / ${s.id}: the hash chain of ${c.file} breaks at line ${c.broken}`);
            // the sandbox in force is the expected runner, and no command ran under another one
            const state = [...new Set(obs.security.filter((e) => e.type === 'sandbox' && e.decision !== 'exec_mismatch').map((e) => e.category))];
            assert.deepEqual(state, [v.runner], `${d.id} / ${s.id}: the sandbox in force is ${state.join(', ') || 'not recorded'}, not ${v.runner}`);
            const mismatch = obs.security.filter((e) => e.type === 'sandbox' && e.decision === 'exec_mismatch').map((e) => e.reason);
            assert.deepEqual(mismatch, [], `${d.id} / ${s.id}: ${mismatch.join('; ')}`);
          });
        }
      } finally {
        await d.teardown?.();
      }
    });
  }
  test(`N43 SAC7: (conformance, ${v.label}) every surface reaches the identical decision and journal events in auto mode`, () => {
    const ran = drivers.filter((d) => !skipReason(d)).map((d) => d.id);
    if (ran.length < 2) return;
    for (const id of SCENARIO_IDS) {
      const per = record.get(id);
      assert.ok(per, `scenario ${id} did not run`);
      assert.equal(new Set(per.values()).size, 1, `${id}: surfaces disagree: ${JSON.stringify(Object.fromEntries(per))}`);
      const ev = events.get(id)!;
      assert.equal(new Set(ev.values()).size, 1, `${id}: the surfaces' journals record different events: ${JSON.stringify(Object.fromEntries(ev), null, 1)}`);
    }
  });
}
