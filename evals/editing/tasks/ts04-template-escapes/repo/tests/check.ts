import assert from 'node:assert/strict';
import { greet, shout } from '../src/greet.ts';

assert.equal(greet('Ann', 2), 'Hello, "Ann"! You have 2 new messages.');
assert.equal(greet('Bo', 1), 'Hello, "Bo"! You have 1 new message.');
assert.equal(shout('hi'), 'HI!');
console.log('ok');
