/**
 * N36 (coordinator, 31 Oct): scenario 6 must hold where no OS sandbox exists. The whole suite again with the sandbox
 * off on every surface (runner "none", no lifetime wrapper, unattended runs allowed to run unsandboxed): the
 * permission engine alone must keep every decision safe and identical.
 */
import { after } from 'node:test';
import { closeSandboxProxies } from '../../src/core/sandbox/index.js';
import { loadDrivers, selectedDrivers } from './harness.js';
import { suite } from './suite.js';

after(() => closeSandboxProxies());

const overlay = { sandbox: { runner: 'none', require: false }, shell: { requireSandbox: false, processLifetime: 'off' } };
suite(' (no OS sandbox)', overlay, selectedDrivers(await loadDrivers()), new Map(), 'none');
