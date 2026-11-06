/**
 * N36 SAC3: the whole conformance suite (V0.1) again with `sandbox.runner: "landlock"` on every surface. Each run
 * must report Landlock as the runner in force (no silent fallback), pass all 8 scenarios, and every surface must
 * reach the same decision.
 */
import { after } from 'node:test';
import { closeSandboxProxies } from '../../src/core/sandbox/index.js';
import { landlockProbe } from '../../src/core/sandbox/landlock.js';
import { loadDrivers, selectedDrivers } from './harness.js';
import { suite } from './suite.js';

after(() => closeSandboxProxies());

const probe = landlockProbe();
const drivers = (await loadDrivers()).map((d) => ({ ...d, skip: () => (probe.ok ? (d.skip?.() ?? false) : `Landlock is not available here: ${probe.reason}`) }));
suite(' (N36 SAC3, landlock)', { sandbox: { runner: 'landlock' } }, selectedDrivers(drivers), new Map(), 'landlock');
