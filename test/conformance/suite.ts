/** V0.1: the suite body, shared by conformance.test.ts (default sandbox) and landlock.test.ts (N36 SAC3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, skipReason, SCENARIOS } from './harness.js';
import { SCENARIO_IDS, type SurfaceDriver } from './types.js';

/**
 * Run every scenario on every driver. `expectRunner`: the sandbox runner every command must actually run under, as
 * recorded from the spawn path (N36 SAC3: the Landlock run must really use Landlock on every surface, not fall back;
 * "none" for the no-sandbox run, where the kernel-boundary scenario becomes a control).
 */
export function suite(label: string, overlay: Record<string, unknown> | undefined, list: SurfaceDriver[], record: Map<string, Map<string, string>>, expectRunner: string, mode?: string): void {
  const events = new Map<string, Map<string, string>>();
  for (const d of list) {
    const skip = skipReason(d);
    test(`V0.1 AC1${label}: ${d.id} passes all ${SCENARIOS.length} hostile scenarios`, { skip, timeout: 15 * 60_000 }, async (t) => {
      await d.setup?.();
      try {
        for (const s of SCENARIOS) {
          await t.test(`${d.id} / ${s.id}: ${s.title}`, async () => {
            const { verdict, obs } = await runScenario(d, s.id, { configOverlay: overlay, mode, sandboxed: expectRunner !== 'none' });
            if (!record.has(s.id)) record.set(s.id, new Map());
            record.get(s.id)!.set(d.id, verdict.decision);
            if (!events.has(s.id)) events.set(s.id, new Map());
            events.get(s.id)!.set(d.id, (obs.journalEvents ?? []).join(' '));
            assert.deepEqual(verdict.failures, [], `${d.id} / ${s.id} (decision ${verdict.decision})`);
            // S8 (review finding 19): a journal was written and every hash chain verifies
            assert.ok((obs.chains ?? []).some((c) => /^sessions[/\\]/.test(c.file)), `${d.id} / ${s.id}: no journal was written`);
            for (const c of obs.chains ?? []) assert.equal(c.broken, 0, `${d.id} / ${s.id}: the hash chain of ${c.file} breaks at line ${c.broken}`);
            // N36 SAC3 (review finding 12): the run-start state names the expected runner, and no command ran under
            // another one (recorded from the spawn path, not the config); the kernel-boundary scenario's disk check
            // shows what the kernel actually did
            const state = [...new Set(obs.security.filter((e) => e.type === 'sandbox' && e.decision !== 'exec_mismatch').map((e) => e.category))];
            assert.deepEqual(state, [expectRunner], `${d.id} / ${s.id}: the sandbox in force is ${state.join(', ') || 'not recorded'}, not ${expectRunner}`);
            const mismatch = obs.security.filter((e) => e.type === 'sandbox' && e.decision === 'exec_mismatch').map((e) => e.reason);
            assert.deepEqual(mismatch, [], `${d.id} / ${s.id}: ${mismatch.join('; ')}`);
          });
        }
      } finally {
        await d.teardown?.();
      }
    });
  }
  test(`V0.1 AC1${label}: every surface reaches the identical decision and journal events in each scenario`, () => {
    const ran = list.filter((d) => !skipReason(d)).map((d) => d.id);
    if (ran.length < 2) return;
    for (const id of SCENARIO_IDS) {
      const per = record.get(id);
      assert.ok(per, `scenario ${id} did not run`);
      const distinct = [...new Set([...per.values()])];
      assert.equal(distinct.length, 1, `${id}: surfaces disagree: ${JSON.stringify(Object.fromEntries(per))}`);
      const ev = events.get(id)!;
      assert.equal(new Set(ev.values()).size, 1, `${id}: the surfaces' journals record different events: ${JSON.stringify(Object.fromEntries(ev), null, 1)}`);
    }
  });
}

