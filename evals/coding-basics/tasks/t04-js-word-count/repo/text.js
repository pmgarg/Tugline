'use strict';

/** Number of words in `text`. */
function wordCount(text) {
  return text.split(' ').length;
}

/** First `n` words of `text`, joined by single spaces. */
function firstWords(text, n) {
  return text.trim().split(/\s+/).slice(0, n).join(' ');
}

module.exports = { wordCount, firstWords };
