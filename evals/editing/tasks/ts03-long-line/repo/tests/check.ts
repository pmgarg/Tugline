import assert from 'node:assert/strict';
import { longest } from '../src/words.ts';

assert.equal(longest(['a', 'abc', 'ab']), 'abc');
assert.equal(longest(), 'wxxxxxx1000');
console.log('ok');
