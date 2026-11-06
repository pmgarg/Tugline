import assert from 'node:assert/strict';
import { byAgeThenName } from '../src/sort.ts';

assert.deepEqual(byAgeThenName([{ name: 'b', age: 30 }, { name: 'a', age: 20 }, { name: 'c', age: 20 }]).map((u) => u.name), ['a', 'c', 'b']);
console.log('ok');
