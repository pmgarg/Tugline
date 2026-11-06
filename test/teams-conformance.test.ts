/**
 * V0.1 through the WS17 surfaces: all hostile scenarios of the shared suite (test/conformance) run through a
 * teammate (N34) and a workflow item (N18), with the hostile actions taken by the child; both must pass every
 * scenario and reach the same decision and journal events (S1). Scenario 6 (a credential read) is refused or asked
 * at the policy level now, so it holds with or without an OS sandbox; the no-sandbox run is in
 * test/conformance/nosandbox.test.ts (TUG_CONFORMANCE_DRIVERS=teammate,workflow-item).
 */
import { after } from 'node:test';
import { closeSandboxProxies, selectRunner } from '../src/core/sandbox/index.js';
import { defaultConfig } from '../src/core/config.js';
import { loadDrivers } from './conformance/harness.js';
import { suite } from './conformance/suite.js';

after(() => closeSandboxProxies());

const drivers = (await loadDrivers()).filter((d) => d.id === 'teammate' || d.id === 'workflow-item');
suite(' (WS17 surfaces)', undefined, drivers, new Map(), selectRunner(defaultConfig()).kind);
