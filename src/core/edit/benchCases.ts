/**
 * The edit-drift micro-benchmark (SPEC A1 AC1), shared by scripts/edit-bench.mts
 * and test/edit.test.ts. Ten ways a model misquotes the same anchor; eight are
 * near-lossless drift that must apply, two are genuine ambiguities (an elided
 * middle and a wrong identifier) that must be refused.
 *
 * Each case edits the anchor's `return` line. The smart-quotes case anchors on
 * the docstring, which has no `return`, so its edit appends to the docstring
 * instead (the v0.1 bench used the same replace for every case, which made that
 * case a no-op edit that could never apply).
 */
export const BENCH_FILE = `import os


class Service:
    def __init__(self, cfg):
        self.cfg = cfg
        self.retries = 3

    def fetch(self, url):
        """Fetch a URL with retries."""
        for i in range(self.retries):
            try:
                return self._get(url)
            except IOError as e:
                log("retry %d: %s" % (i, e))
        raise RuntimeError("failed")
`;

const exact = `        for i in range(self.retries):
            try:
                return self._get(url)`;

export interface BenchCase {
  name: string;
  anchor: string;
  replacement: string;
  /** must the matcher apply it? */
  shouldApply: boolean;
  /** expected file after the edit (when shouldApply) */
  expected?: string;
}

const edited = BENCH_FILE.replace('                return self._get(url)', '                return  # edited self._get(url)');
const withReturn = (a: string) => a.replace('return', 'return  # edited');

export const BENCH_CASES: BenchCase[] = [
  { name: 'exact anchor', anchor: exact, replacement: withReturn(exact), shouldApply: true, expected: edited },
  { name: 'trailing spaces on a line', anchor: exact.replace('try:', 'try:  '), replacement: withReturn(exact.replace('try:', 'try:  ')), shouldApply: true, expected: edited },
  {
    name: 'indent shifted (model dropped 4 spaces)',
    anchor: exact.split('\n').map((l) => l.slice(4)).join('\n'),
    replacement: withReturn(exact.split('\n').map((l) => l.slice(4)).join('\n')),
    shouldApply: true,
    expected: edited,
  },
  { name: 'tabs instead of spaces', anchor: exact.replace(/^ {4}/gm, '\t'), replacement: withReturn(exact.replace(/^ {4}/gm, '\t')), shouldApply: true, expected: edited },
  {
    name: 'smart quotes in docstring',
    anchor: '        “””Fetch a URL with retries."""',
    replacement: '        “””Fetch a URL with retries (edited)."""',
    shouldApply: true,
    // unchanged characters keep the file's ASCII quotes
    expected: BENCH_FILE.replace('"""Fetch a URL with retries."""', '"""Fetch a URL with retries (edited)."""'),
  },
  { name: 'extra blank line inside anchor', anchor: exact.replace('try:\n', 'try:\n\n'), replacement: withReturn(exact.replace('try:\n', 'try:\n\n')), shouldApply: true, expected: edited },
  { name: 'leading/trailing newline on anchor', anchor: '\n' + exact + '\n', replacement: withReturn('\n' + exact + '\n'), shouldApply: true, expected: edited },
  {
    name: 'line-number prefixes copied',
    anchor: exact.split('\n').map((l, i) => `${String(11 + i).padStart(6)}\t${l}`).join('\n'),
    replacement: withReturn(exact.split('\n').map((l, i) => `${String(11 + i).padStart(6)}\t${l}`).join('\n')),
    shouldApply: true,
    expected: edited,
  },
  { name: 'model elided middle with ...', anchor: `        for i in range(self.retries):\n            ...\n                return self._get(url)`, replacement: withReturn(`        for i in range(self.retries):\n            ...\n                return self._get(url)`), shouldApply: false },
  { name: 'one token wrong (retry vs retries)', anchor: exact.replace('self.retries', 'self.retry'), replacement: withReturn(exact.replace('self.retries', 'self.retry')), shouldApply: false },
];
