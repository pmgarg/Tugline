'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { wordCount, firstWords } = require('../text.js');

test('single spaces', () => assert.strictEqual(wordCount('the quick brown fox'), 4));
test('runs of whitespace', () => assert.strictEqual(wordCount('the  quick\tbrown\n\nfox '), 4));
test('empty and blank', () => {
  assert.strictEqual(wordCount(''), 0);
  assert.strictEqual(wordCount(' \n '), 0);
});
test('firstWords', () => assert.strictEqual(firstWords('  a b   c d ', 3), 'a b c'));
