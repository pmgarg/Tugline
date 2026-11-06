import assert from 'node:assert/strict';
import { isVersion, SEP } from '../src/version.ts';

assert.ok(isVersion('1.2'));
assert.ok(isVersion('10.20.30'));
assert.ok(!isVersion('1.2.'));
assert.ok(!isVersion('1'));
assert.equal(SEP, '\\');
console.log('ok');
