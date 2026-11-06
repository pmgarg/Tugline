import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.ts';

assert.equal(parseConfig({ secure: 'true' }).secure, true);
assert.equal(parseConfig({}).secure, false);
assert.equal(parseConfig({}).port, 80);
console.log('ok');
