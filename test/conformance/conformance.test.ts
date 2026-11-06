/**
 * V0.1 AC1: every surface driver passes all 8 hostile scenarios, and every surface
 * reaches the identical decision in each scenario.
 *
 * Runs with the default sandbox selection (shell.sandbox "auto": bwrap here). The
 * Landlock run of the same suite is landlock.test.ts (N36 SAC3).
 */
import { after } from 'node:test';
import { closeSandboxProxies, selectRunner } from '../../src/core/sandbox/index.js';
import { defaultConfig } from '../../src/core/config.js';
import { loadDrivers, selectedDrivers } from './harness.js';
import { suite } from './suite.js';

after(() => closeSandboxProxies());

const drivers = selectedDrivers(await loadDrivers());
// the runner the default config selects on this machine (auto: bwrap, else Landlock, else none)
const runner = selectRunner(defaultConfig()).kind;
suite('', undefined, drivers, new Map(), runner);
