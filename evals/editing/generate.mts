// Generates evals/editing/tasks/* (SPEC A9). Run: npx tsx evals/editing/generate.mts
//
// Every task is a small repo with a bug or change request placed in a file that
// stresses the edit engine: CRLF, BOM, tabs, trailing whitespace, typographic
// quotes, long lines, backslash/quote-heavy strings, no final newline, deep
// indentation, YAML/JSON structure, or several far-apart edits.
//
// Acceptance = the language's own tests + an integrity check
// (": integrity; python3 .oh-eval/intact.py") that fails when bytes outside the
// edited region change (EOL style, BOM, final newline, unrelated lines). That
// check is what the "corrupted-file" metric counts. `solution/` holds a reference
// fix (never copied into the agent's workspace) used by evals/editing/check.mts.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, 'tasks');
const INTEGRITY = ': integrity; python3 .oh-eval/intact.py';

interface TaskDef {
  id: string;
  lang: 'python' | 'typescript' | 'go' | 'java' | 'config';
  stress: string;
  prompt: string;
  /** files of the fixture repo */
  files: Record<string, string>;
  /** reference solution: full contents of the changed files */
  solution: Record<string, string>;
  test: string;
  verification: string[];
  protected: string[];
}

const L = (...lines: string[]) => lines.join('\n') + '\n';
const crlf = (s: string) => s.replace(/\n/g, '\r\n');
const BOM = '\uFEFF';
const sub = (s: string, a: string, b: string) => {
  if (!s.includes(a)) throw new Error(`generator: "${a}" not found`);
  return s.replace(a, b);
};

// pytests.py runs `python3 -m pytest -q tests` when pytest is installed and a minimal
// built-in runner otherwise (R7: the active Python on a fresh Mac has no pytest).
const PY_TEST = 'python3 .oh-eval/pytests.py -q tests';
const PY = { verification: ['pytest'], protected: ['tests/**'] };
const TS_TEST = 'node tests/check.ts';
const TS = { verification: ['tests/check.ts'], protected: ['tests/**'] };
const GO_TEST = 'go test ./...';
const GO = { verification: ['go test'], protected: ['**/*_test.go', 'go.mod'] };
const JAVA_TEST = 'rm -rf .oh-build && javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check';
const JAVA = { verification: ['javac', 'Check'], protected: ['tests/**'] };
const CFG_TEST = 'python3 tests/check.py';
const CFG = { verification: ['tests/check.py'], protected: ['tests/**'] };
const GOMOD = 'module example.com/calc\n\ngo 1.22\n';

const tasks: TaskDef[] = [];

// ------------------------------------------------------------ Python

{
  const src = L(
    'class Inventory:',
    '    def __init__(self):',
    '        self.items = {}',
    '',
    '    def add(self, name, qty):',
    '        if qty <= 0:',
    '            raise ValueError("qty must be positive")',
    '        self.items[name] = self.items.get(name, 0) + qty',
    '',
    '    def remove(self, name, qty):',
    '        have = self.items.get(name, 0)',
    '        if qty > have:',
    '            raise ValueError("not enough %s" % name)',
    '        self.items[name] = have - qty',
    '        if self.items[name] < 0:',
    '            del self.items[name]',
    '',
    '    def total(self):',
    '        return sum(self.items.values())',
  );
  tasks.push({
    id: 'py01-nested-method', lang: 'python', stress: 'nested method body, 8-space indentation', ...PY, test: PY_TEST,
    prompt: 'In inventory.py, Inventory.remove should drop an item from `items` once its quantity reaches zero, but it keeps entries with quantity 0. Fix it so `python3 -m pytest -q tests` passes. Do not modify the tests.',
    files: { 'inventory.py': src, 'tests/test_inventory.py': L('from inventory import Inventory', '', 'def test_remove_all_drops_item():', '    inv = Inventory()', '    inv.add("apple", 2)', '    inv.remove("apple", 2)', '    assert "apple" not in inv.items', '', 'def test_partial_remove():', '    inv = Inventory()', '    inv.add("pear", 3)', '    inv.remove("pear", 1)', '    assert inv.items == {"pear": 2}') },
    solution: { 'inventory.py': sub(src, 'if self.items[name] < 0:', 'if self.items[name] <= 0:') },
  });
}
{
  const src = crlf(L('def apply_discount(price, percent):', '    """Return price reduced by percent (0-100)."""', '    if percent < 0 or percent > 100:', '        raise ValueError("percent out of range")', '    return price * percent / 100', '', '', 'def with_tax(price, rate=0.2):', '    return round(price * (1 + rate), 2)'));
  tasks.push({
    id: 'py02-crlf', lang: 'python', stress: 'CRLF line endings must survive', ...PY, test: PY_TEST,
    prompt: 'pricing.py: apply_discount(100, 20) should return 80 (the price reduced by 20 percent) but returns 20. Fix the function so the tests pass. Do not modify the tests.',
    files: { 'pricing.py': src, 'tests/test_pricing.py': L('from pricing import apply_discount, with_tax', '', 'def test_discount():', '    assert apply_discount(100, 20) == 80', '    assert apply_discount(50, 0) == 50', '', 'def test_tax():', '    assert with_tax(10) == 12.0') },
    solution: { 'pricing.py': sub(src, 'return price * percent / 100', 'return price * (100 - percent) / 100') },
  });
}
{
  const src = L('def flatten(rows):', '\t"""Flatten rows into one list, skipping None values."""', '\tout = []', '\tfor row in rows:', '\t\tfor x in row:', '\t\t\tif x is None:', '\t\t\t\tbreak', '\t\t\tout.append(x)', '\treturn out', '', '', 'def count(rows):', '\treturn len(flatten(rows))');
  tasks.push({
    id: 'py03-tabs', lang: 'python', stress: 'tab-indented Python (models answer with spaces)', ...PY, test: PY_TEST,
    prompt: 'grid.py: flatten() is supposed to skip None values, but it stops reading a row at the first None. Fix it. Run `python3 -m pytest -q tests`; do not modify the tests.',
    files: { 'grid.py': src, 'tests/test_grid.py': L('from grid import flatten, count', '', 'def test_skips_none():', '    assert flatten([[1, None, 2], [3]]) == [1, 2, 3]', '    assert count([[None], [4, 5]]) == 2') },
    solution: { 'grid.py': sub(src, '\t\t\t\tbreak', '\t\t\t\tcontinue') },
  });
}
{
  const src = L(
    'def slugify(title):',
    '    """Turn a title like \u201CHello \u2014 World\u201D into \u201Chello-world\u201D."""',
    '    # keep letters and digits \u2014 everything else becomes a dash',
    '    out = []',
    '    for ch in title.lower():',
    '        if ch.isalnum():',
    '            out.append(ch)',
    '        else:',
    '            out.append("-")',
    '    slug = "".join(out)',
    '    return slug',
  );
  tasks.push({
    id: 'py04-smart-quotes', lang: 'python', stress: 'typographic quotes and em dashes near the edit', ...PY, test: PY_TEST,
    prompt: 'text.py: slugify("Hello \u2014 World") returns "hello---world"; it should collapse runs of dashes and strip leading/trailing dashes, giving "hello-world". Fix it so the tests pass (do not modify tests).',
    files: { 'text.py': src, 'tests/test_text.py': L('from text import slugify', '', 'def test_slug():', '    assert slugify("Hello \u2014 World") == "hello-world"', '    assert slugify("  A  b ") == "a-b"', '    assert slugify("x") == "x"') },
    solution: { 'text.py': sub(src, '    slug = "".join(out)\n', '    slug = "".join(out)\n    while "--" in slug:\n        slug = slug.replace("--", "-")\n    slug = slug.strip("-")\n') },
  });
}
{
  const filler = (i: number) => L(`def helper_${i}(x):`, `    """Helper ${i}: scale x by ${i}."""`, `    return x * ${i}`, '', '');
  let src = L('import math', '', '', 'def mean(xs):', '    if not xs:', '        return 0.0', '    return sum(xs) / (len(xs) - 1)', '', '');
  for (let i = 1; i <= 30; i++) src += filler(i);
  src += L('def clamp(x, lo, hi):', '    if x < lo:', '        return lo', '    if x > hi:', '        return lo', '    return x', '', '', 'def norm(xs):', '    return math.sqrt(sum(x * x for x in xs))');
  tasks.push({
    id: 'py05-two-far-edits', lang: 'python', stress: '160-line file, two bugs ~150 lines apart (multi_edit)', ...PY, test: PY_TEST,
    prompt: 'stats.py has two bugs: mean() divides by the wrong count, and clamp() returns the wrong bound when x is above hi. Fix both so `python3 -m pytest -q tests` passes. Do not modify the tests.',
    files: { 'stats.py': src, 'tests/test_stats.py': L('from stats import mean, clamp, helper_7', '', 'def test_mean():', '    assert mean([1, 2, 3]) == 2', '', 'def test_clamp():', '    assert clamp(15, 0, 10) == 10', '    assert clamp(-1, 0, 10) == 0', '', 'def test_helpers_untouched():', '    assert helper_7(2) == 14') },
    solution: { 'stats.py': sub(sub(src, 'return sum(xs) / (len(xs) - 1)', 'return sum(xs) / len(xs)'), '    if x > hi:\n        return lo', '    if x > hi:\n        return hi') },
  });
}
{
  const src = BOM + L('def fmt_row(name, value):', '    return f"{name}: {value}"', '', '', 'def render(rows):', '    return "\\n".join(fmt_row(n, v) for n, v in rows)', '', '', 'def render_one(name, value):', '    return fmt_row(name, value)');
  tasks.push({
    id: 'py06-bom-rename', lang: 'python', stress: 'UTF-8 BOM must survive; rename every occurrence', ...PY, test: PY_TEST,
    prompt: 'report.py: rename the function fmt_row to format_row, including every call site (the tests import format_row). Keep behaviour the same. Do not modify the tests.',
    files: { 'report.py': src, 'tests/test_report.py': L('from report import format_row, render, render_one', '', 'def test_render():', '    assert render([("a", 1), ("b", 2)]) == "a: 1\\nb: 2"', '    assert render_one("x", 3) == format_row("x", 3) == "x: 3"') },
    solution: { 'report.py': src.split('fmt_row').join('format_row') },
  });
}
{
  const src = L('def is_leap(year):   ', '    if year % 4 != 0:   ', '        return False', '    if year % 100 != 0:  ', '        return True', '    return False', '', '', 'def days_in_year(year):  ', '    return 366 if is_leap(year) else 365  ');
  tasks.push({
    id: 'py07-trailing-ws', lang: 'python', stress: 'trailing whitespace on most lines', ...PY, test: PY_TEST,
    prompt: 'calendar_utils.py: is_leap(2000) returns False, but years divisible by 400 are leap years. Fix is_leap so the tests pass. Do not modify the tests.',
    files: { 'calendar_utils.py': src, 'tests/test_cal.py': L('from calendar_utils import is_leap, days_in_year', '', 'def test_leap():', '    assert is_leap(2000)', '    assert not is_leap(1900)', '    assert is_leap(2024)', '    assert days_in_year(2000) == 366') },
    solution: { 'calendar_utils.py': sub(src, '        return True\n    return False\n', '        return True\n    return year % 400 == 0\n') },
  });
}

// ------------------------------------------------------------ TypeScript

const tsCheck = (imports: string, ...asserts: string[]) => L(`import assert from 'node:assert/strict';`, imports, '', ...asserts, "console.log('ok');");
{
  const src = L('export interface User {', '  name: string;', '  age: number;', '}', '', '/** Youngest first; equal ages sorted by name. */', 'export function byAgeThenName(users: User[]): User[] {', '  return [...users].sort((a, b) => {', '    if (a.age !== b.age) return b.age - a.age;', '    return a.name.localeCompare(b.name);', '  });', '}');
  tasks.push({
    id: 'ts01-comparator', lang: 'typescript', stress: 'arrow function inside sort', ...TS, test: TS_TEST,
    prompt: 'src/sort.ts: byAgeThenName should sort the youngest first, but it sorts the oldest first. Fix it; `node tests/check.ts` must pass. Do not modify the tests.',
    files: { 'src/sort.ts': src, 'tests/check.ts': tsCheck("import { byAgeThenName } from '../src/sort.ts';", "assert.deepEqual(byAgeThenName([{ name: 'b', age: 30 }, { name: 'a', age: 20 }, { name: 'c', age: 20 }]).map((u) => u.name), ['a', 'c', 'b']);") },
    solution: { 'src/sort.ts': sub(src, 'return b.age - a.age;', 'return a.age - b.age;') },
  });
}
{
  const src = crlf(L('export interface Config {', '  host: string;', '  port: number;', '}', '', 'export function parseConfig(raw: Record<string, string>): Config {', '  return {', "    host: raw.host ?? 'localhost',", '    port: Number(raw.port ?? 80),', '  };', '}'));
  tasks.push({
    id: 'ts02-crlf-field', lang: 'typescript', stress: 'CRLF TypeScript, edit spans interface and function', ...TS, test: TS_TEST,
    prompt: "src/config.ts: add a `secure: boolean` field to Config. parseConfig should set it to true only when raw.secure is the string 'true' (default false). `node tests/check.ts` must pass; do not modify the tests.",
    files: { 'src/config.ts': src, 'tests/check.ts': tsCheck("import { parseConfig } from '../src/config.ts';", "assert.equal(parseConfig({ secure: 'true' }).secure, true);", 'assert.equal(parseConfig({}).secure, false);', 'assert.equal(parseConfig({}).port, 80);') },
    solution: { 'src/config.ts': sub(sub(src, '  port: number;\r\n}', '  port: number;\r\n  secure: boolean;\r\n}'), '    port: Number(raw.port ?? 80),\r\n', "    port: Number(raw.port ?? 80),\r\n    secure: raw.secure === 'true',\r\n") },
  });
}
{
  const words = Array.from({ length: 1200 }, (_, i) => `"w${'x'.repeat(i % 7)}${i}"`).join(', ');
  const src = L(`export const WORDS = [${words}];`, '', '/** The longest word (first one wins on ties). */', "export function longest(words: string[] = WORDS): string {", "  let best = '';", '  for (const w of words) if (w.length < best.length) best = w;', '  return best;', '}');
  tasks.push({
    id: 'ts03-long-line', lang: 'typescript', stress: 'a 10k-character line next to the edit', ...TS, test: TS_TEST,
    prompt: "src/words.ts: longest() always returns '' instead of the longest word. Fix it so `node tests/check.ts` passes. Do not modify the tests or the WORDS data.",
    files: { 'src/words.ts': src, 'tests/check.ts': tsCheck("import { longest } from '../src/words.ts';", "assert.equal(longest(['a', 'abc', 'ab']), 'abc');", "assert.equal(longest(), 'wxxxxxx1000');") },
    solution: { 'src/words.ts': sub(src, 'if (w.length < best.length)', 'if (w.length > best.length)') },
  });
}
{
  const src = L('export function greet(name: string, count: number): string {', "  const noun = count === 1 ? 'message' : 'messages';", '  return `Hello, ${name}! You have ${count} new ${noun}.\\n`;', '}', '', 'export function shout(s: string): string {', '  return `${s.toUpperCase()}!`;', '}');
  tasks.push({
    id: 'ts04-template-escapes', lang: 'typescript', stress: 'template literal with ${} and a \\n escape', ...TS, test: TS_TEST,
    prompt: 'src/greet.ts: greet("Ann", 2) must return exactly `Hello, "Ann"! You have 2 new messages.` — the name in double quotes and no trailing newline. Fix greet; `node tests/check.ts` must pass. Do not modify the tests.',
    files: { 'src/greet.ts': src, 'tests/check.ts': tsCheck("import { greet, shout } from '../src/greet.ts';", "assert.equal(greet('Ann', 2), 'Hello, \"Ann\"! You have 2 new messages.');", "assert.equal(greet('Bo', 1), 'Hello, \"Bo\"! You have 1 new message.');", "assert.equal(shout('hi'), 'HI!');") },
    solution: { 'src/greet.ts': sub(src, '  return `Hello, ${name}! You have ${count} new ${noun}.\\n`;', '  return `Hello, "${name}"! You have ${count} new ${noun}.`;') },
  });
}
{
  const src = L('/** "1.2" or "1.2.3" (major.minor[.patch]). */', 'export function isVersion(s: string): boolean {', '  return /^\\d+\\.\\d+$/.test(s);', '}', '', "export const SEP = '\\\\';");
  tasks.push({
    id: 'ts05-regex', lang: 'typescript', stress: 'regex literal full of backslashes', ...TS, test: TS_TEST,
    prompt: 'src/version.ts: isVersion should also accept an optional patch number ("1.2.3"), but it rejects it. Fix the regex. `node tests/check.ts` must pass; do not modify the tests.',
    files: { 'src/version.ts': src, 'tests/check.ts': tsCheck("import { isVersion, SEP } from '../src/version.ts';", "assert.ok(isVersion('1.2'));", "assert.ok(isVersion('10.20.30'));", "assert.ok(!isVersion('1.2.'));", "assert.ok(!isVersion('1'));", "assert.equal(SEP, '\\\\');") },
    solution: { 'src/version.ts': sub(src, '/^\\d+\\.\\d+$/', '/^\\d+\\.\\d+(\\.\\d+)?$/') },
  });
}
{
  const src = 'export function clamp(x: number, lo: number, hi: number): number {\n  if (x < lo) return lo;\n  if (x > hi) return lo;\n  return x;\n}';
  tasks.push({
    id: 'ts06-no-final-newline', lang: 'typescript', stress: 'file without a final newline', ...TS, test: TS_TEST,
    prompt: 'src/clamp.ts: clamp(15, 0, 10) returns 0 instead of 10. Fix it so `node tests/check.ts` passes. Do not modify the tests.',
    files: { 'src/clamp.ts': src, 'tests/check.ts': tsCheck("import { clamp } from '../src/clamp.ts';", 'assert.equal(clamp(15, 0, 10), 10);', 'assert.equal(clamp(-5, 0, 10), 0);', 'assert.equal(clamp(5, 0, 10), 5);') },
    solution: { 'src/clamp.ts': sub(src, 'if (x > hi) return lo;', 'if (x > hi) return hi;') },
  });
}

// ------------------------------------------------------------ Go (gofmt: tabs)

const goTest = (body: string) => L('package calc', '', 'import "testing"', '', body);
{
  const src = L('package calc', '', '// SumTo returns 1 + 2 + ... + n.', 'func SumTo(n int) int {', '\ttotal := 0', '\tfor i := 1; i < n; i++ {', '\t\ttotal += i', '\t}', '\treturn total', '}');
  tasks.push({
    id: 'go01-loop-bound', lang: 'go', stress: 'tab-indented Go', ...GO, test: GO_TEST,
    prompt: 'sum.go: SumTo(3) should be 6 but returns 3. Fix it so `go test ./...` passes. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'sum.go': src, 'sum_test.go': goTest('func TestSumTo(t *testing.T) {\n\tif SumTo(3) != 6 || SumTo(1) != 1 {\n\t\tt.Fatal(SumTo(3))\n\t}\n}') },
    solution: { 'sum.go': sub(src, 'i < n;', 'i <= n;') },
  });
}
{
  const src = L('package calc', '', 'import "strconv"', '', '// ParseAll converts every string to an int and stops at the first error.', 'func ParseAll(xs []string) ([]int, error) {', '\tout := make([]int, 0, len(xs))', '\tfor _, x := range xs {', '\t\tn, _ := strconv.Atoi(x)', '\t\tout = append(out, n)', '\t}', '\treturn out, nil', '}');
  tasks.push({
    id: 'go02-error-check', lang: 'go', stress: 'adding an error branch inside a loop', ...GO, test: GO_TEST,
    prompt: 'parse.go: ParseAll ignores conversion errors. It must return a nil slice and the error as soon as a string is not an integer. Fix it so `go test ./...` passes. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'parse.go': src, 'parse_test.go': goTest('func TestParseAll(t *testing.T) {\n\tif _, err := ParseAll([]string{"1", "x"}); err == nil {\n\t\tt.Fatal("want error")\n\t}\n\tif v, err := ParseAll([]string{"4", "5"}); err != nil || v[1] != 5 {\n\t\tt.Fatal(v, err)\n\t}\n}') },
    solution: { 'parse.go': sub(src, '\t\tn, _ := strconv.Atoi(x)\n', '\t\tn, err := strconv.Atoi(x)\n\t\tif err != nil {\n\t\t\treturn nil, err\n\t\t}\n') },
  });
}
{
  const src = L('package calc', '', 'import "strings"', '', 'const header = `C:\\Users\\{{user}}\\notes.txt`', '', '// Path fills in the user name.', 'func Path(user string) string {', '\treturn strings.Replace(header, "{{user}}", user, 1)', '}');
  tasks.push({
    id: 'go03-raw-string', lang: 'go', stress: 'raw string full of backslashes', ...GO, test: GO_TEST,
    prompt: 'paths.go: the notes path template must change to D:\\Data\\{{user}}\\notes.txt so that Path("bob") returns D:\\Data\\bob\\notes.txt. Make the change; `go test ./...` must pass. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'paths.go': src, 'paths_test.go': goTest('func TestPath(t *testing.T) {\n\tif got := Path("bob"); got != `D:\\Data\\bob\\notes.txt` {\n\t\tt.Fatal(got)\n\t}\n}') },
    solution: { 'paths.go': sub(src, '`C:\\Users\\{{user}}\\notes.txt`', '`D:\\Data\\{{user}}\\notes.txt`') },
  });
}
{
  const src = L('package calc', '', '// Grade maps a score to a letter: 90+ A, 80+ B, 70+ C, else F.', 'func Grade(score int) string {', '\tswitch {', '\tcase score >= 90:', '\t\treturn "A"', '\tcase score >= 80:', '\t\treturn "B"', '\tcase score > 70:', '\t\treturn "C"', '\tdefault:', '\t\treturn "F"', '\t}', '}');
  tasks.push({
    id: 'go04-switch', lang: 'go', stress: 'switch/case with repeated lines', ...GO, test: GO_TEST,
    prompt: 'grade.go: Grade(70) returns "F" but 70 is a C according to the doc comment. Fix it; `go test ./...` must pass. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'grade.go': src, 'grade_test.go': goTest('func TestGrade(t *testing.T) {\n\tfor s, w := range map[int]string{95: "A", 80: "B", 70: "C", 69: "F"} {\n\t\tif Grade(s) != w {\n\t\t\tt.Fatal(s, Grade(s))\n\t\t}\n\t}\n}') },
    solution: { 'grade.go': sub(src, 'case score > 70:', 'case score >= 70:') },
  });
}
{
  const src = crlf(L('package calc', '', 'type Stack struct{ items []int }', '', 'func (s *Stack) Push(x int) { s.items = append(s.items, x) }', '', '// Pop removes and returns the top (most recently pushed) item; ok is false when empty.', 'func (s *Stack) Pop() (int, bool) {', '\tif len(s.items) == 0 {', '\t\treturn 0, false', '\t}', '\tx := s.items[0]', '\ts.items = s.items[1:]', '\treturn x, true', '}'));
  tasks.push({
    id: 'go05-crlf-stack', lang: 'go', stress: 'CRLF Go file', ...GO, test: GO_TEST,
    prompt: 'stack.go: Pop returns the oldest item instead of the most recently pushed one (it behaves like a queue). Fix it so `go test ./...` passes. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'stack.go': src, 'stack_test.go': goTest('func TestStack(t *testing.T) {\n\tvar s Stack\n\ts.Push(1)\n\ts.Push(2)\n\tif x, _ := s.Pop(); x != 2 {\n\t\tt.Fatal(x)\n\t}\n\tif x, _ := s.Pop(); x != 1 {\n\t\tt.Fatal(x)\n\t}\n\tif _, ok := s.Pop(); ok {\n\t\tt.Fatal("empty")\n\t}\n}') },
    solution: { 'stack.go': sub(src, '\tx := s.items[0]\r\n\ts.items = s.items[1:]', '\tx := s.items[len(s.items)-1]\r\n\ts.items = s.items[:len(s.items)-1]') },
  });
}
{
  const src = L('package calc', '', 'import "sync"', '', '// Counter is safe for concurrent use.', 'type Counter struct {', '\tmu sync.Mutex', '\tn  map[string]int', '}', '', 'func NewCounter() *Counter { return &Counter{n: map[string]int{}} }', '', 'func (c *Counter) Inc(key string) {', '\tc.n[key]++', '}', '', 'func (c *Counter) Get(key string) int {', '\tc.mu.Lock()', '\tdefer c.mu.Unlock()', '\treturn c.n[key]', '}');
  tasks.push({
    id: 'go06-mutex', lang: 'go', stress: 'two methods with near-identical bodies', ...GO, test: GO_TEST,
    prompt: 'counter.go: Counter is documented as safe for concurrent use, but Inc does not lock the mutex, so concurrent increments crash or are lost. Fix Inc; `go test ./...` must pass. Do not modify the tests.',
    files: { 'go.mod': GOMOD, 'counter.go': src, 'counter_test.go': L('package calc', '', 'import (', '\t"testing"', '\t"time"', ')', '', '// Deterministic: Inc must wait while someone else holds the mutex.', 'func TestIncLocks(t *testing.T) {', '\tc := NewCounter()', '\tc.mu.Lock()', '\tdone := make(chan bool)', '\tgo func() { c.Inc("k"); done <- true }()', '\tselect {', '\tcase <-done:', '\t\tc.mu.Unlock()', '\t\tt.Fatal("Inc did not wait for the mutex")', '\tcase <-time.After(200 * time.Millisecond):', '\t}', '\tc.mu.Unlock()', '\t<-done', '\tif c.Get("k") != 1 {', '\t\tt.Fatal(c.Get("k"))', '\t}', '}', '', 'func TestCounter(t *testing.T) {\n\tc := NewCounter()\n\tdone := make(chan bool)\n\tfor g := 0; g < 8; g++ {\n\t\tgo func() {\n\t\t\tfor i := 0; i < 5000; i++ {\n\t\t\t\tc.Inc("k")\n\t\t\t}\n\t\t\tdone <- true\n\t\t}()\n\t}\n\tfor g := 0; g < 8; g++ {\n\t\t<-done\n\t}\n\tif c.Get("k") != 40000 {', '\t\tt.Fatal(c.Get("k"))', '\t}', '}') },
    solution: { 'counter.go': sub(src, 'func (c *Counter) Inc(key string) {\n\tc.n[key]++', 'func (c *Counter) Inc(key string) {\n\tc.mu.Lock()\n\tdefer c.mu.Unlock()\n\tc.n[key]++') },
  });
}

// ------------------------------------------------------------ Java

const javaCheck = (...lines: string[]) => L('public class Check {', '    public static void main(String[] args) {', ...lines.map((l) => '        ' + l), '        System.out.println("ok");', '    }', '}');
const jassert = (cond: string, msg: string) => `if (!(${cond})) throw new AssertionError(${JSON.stringify(msg)});`;
{
  const src = L('public final class Point {', '    private final int x;', '    private final int y;', '', '    public Point(int x, int y) {', '        this.x = x;', '        this.y = y;', '    }', '', '    @Override', '    public boolean equals(Object o) {', '        if (!(o instanceof Point)) return false;', '        Point p = (Point) o;', '        return x == p.x && y == p.x;', '    }', '', '    @Override', '    public int hashCode() {', '        return 31 * x + y;', '    }', '}');
  tasks.push({
    id: 'java01-equals', lang: 'java', stress: 'one-token bug in a common pattern', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Point.java: new Point(1, 2).equals(new Point(1, 2)) is false. Fix equals. The check is `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`; do not modify the tests.',
    files: { 'src/Point.java': src, 'tests/Check.java': javaCheck(jassert('new Point(1, 2).equals(new Point(1, 2))', 'equal points'), jassert('!new Point(1, 2).equals(new Point(1, 3))', 'different y')) },
    solution: { 'src/Point.java': sub(src, 'y == p.x', 'y == p.y') },
  });
}
{
  const src = crlf(L('import java.util.ArrayList;', 'import java.util.List;', '', 'public class Range {', '    /** Returns the integers from..to, both inclusive. */', '    public static List<Integer> inclusive(int from, int to) {', '        List<Integer> out = new ArrayList<>();', '        for (int i = from; i < to; i++) {', '            out.add(i);', '        }', '        return out;', '    }', '}'));
  tasks.push({
    id: 'java02-crlf', lang: 'java', stress: 'CRLF Java file', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Range.java: Range.inclusive(1, 3) returns [1, 2] but should return [1, 2, 3]. Fix it (check: `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`). Do not modify the tests.',
    files: { 'src/Range.java': src, 'tests/Check.java': javaCheck(jassert('Range.inclusive(1, 3).equals(java.util.List.of(1, 2, 3))', 'inclusive')) },
    solution: { 'src/Range.java': sub(src, 'i < to;', 'i <= to;') },
  });
}
{
  const src = L('public class Tsv {', '    /** Joins fields with tabs; backslashes become \\\\ and tabs become \\t inside fields. */', '    public static String join(String... fields) {', '        StringBuilder sb = new StringBuilder();', '        for (int i = 0; i < fields.length; i++) {', '            if (i > 0) sb.append("\\t");', '            sb.append(fields[i].replace("\\t", "\\\\t"));', '        }', '        return sb.toString();', '    }', '}');
  tasks.push({
    id: 'java03-escapes', lang: 'java', stress: 'string literals made of escapes', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Tsv.java: join must escape backslashes inside fields (a single \\ becomes \\\\) before escaping tabs, as its comment says; currently backslashes are not escaped. Fix it (check: `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`). Do not modify the tests.',
    files: { 'src/Tsv.java': src, 'tests/Check.java': javaCheck(jassert('Tsv.join("a\\\\b", "c\\td").equals("a\\\\\\\\b\\tc\\\\td")', 'escaping'), jassert('Tsv.join("x", "y").equals("x\\ty")', 'plain')) },
    solution: { 'src/Tsv.java': sub(src, 'fields[i].replace("\\t", "\\\\t")', 'fields[i].replace("\\\\", "\\\\\\\\").replace("\\t", "\\\\t")') },
  });
}
{
  const src = L('import java.util.List;', '', 'public class Names {', '    /** Upper-case initials of the names; null or empty names are skipped. */', '    public static String initials(List<String> names) {', '        StringBuilder sb = new StringBuilder();', '        for (String n : names) {', '            sb.append(Character.toUpperCase(n.charAt(0)));', '        }', '        return sb.toString();', '    }', '}');
  tasks.push({
    id: 'java04-null-check', lang: 'java', stress: 'inserting a guard inside a loop', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Names.java: initials crashes on null or empty names; they must be skipped, as documented. Fix it (check: `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`). Do not modify the tests.',
    files: { 'src/Names.java': src, 'tests/Check.java': javaCheck('java.util.List<String> xs = new java.util.ArrayList<>(java.util.Arrays.asList("ann", null, "", "bo"));', jassert('Names.initials(xs).equals("AB")', 'skip null/empty')) },
    solution: { 'src/Names.java': sub(src, '            sb.append(Character', '            if (n == null || n.isEmpty()) continue;\n            sb.append(Character') },
  });
}
{
  const src = L('public class Temperature {', '\t/** Celsius to Fahrenheit. */', '\tpublic static double toFahrenheit(double c) {', '\t\treturn c * 5 / 9 + 32;', '\t}', '', '\tpublic static double toCelsius(double f) {', '\t\treturn (f - 32) * 5 / 9;', '\t}', '}');
  tasks.push({
    id: 'java05-tabs', lang: 'java', stress: 'tab-indented Java with a near-duplicate line', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Temperature.java: toFahrenheit(100) should be 212. Fix the formula (check: `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`). Do not modify the tests.',
    files: { 'src/Temperature.java': src, 'tests/Check.java': javaCheck(jassert('Temperature.toFahrenheit(100) == 212', 'f'), jassert('Temperature.toCelsius(212) == 100', 'c')) },
    solution: { 'src/Temperature.java': sub(src, 'return c * 5 / 9 + 32;', 'return c * 9 / 5 + 32;') },
  });
}
{
  const src = L('import java.util.ArrayList;', 'import java.util.List;', 'import java.util.function.Predicate;', '', 'public class Lists {', '    /** Elements for which keep returns true, in order. */', '    public static <T> List<T> filter(List<T> in, Predicate<T> keep) {', '        List<T> out = new ArrayList<>();', '        for (T x : in) {', '            if (!keep.test(x)) {', '                out.add(x);', '            }', '        }', '        return out;', '    }', '}');
  tasks.push({
    id: 'java06-generics', lang: 'java', stress: 'generic method', ...JAVA, test: JAVA_TEST,
    prompt: 'src/Lists.java: filter returns the elements that should be dropped instead of the ones to keep. Fix it (check: `javac -d .oh-build src/*.java tests/*.java && java -ea -cp .oh-build Check`). Do not modify the tests.',
    files: { 'src/Lists.java': src, 'tests/Check.java': javaCheck(jassert('Lists.filter(java.util.List.of(1, 2, 3, 4), x -> x % 2 == 0).equals(java.util.List.of(2, 4))', 'filter')) },
    solution: { 'src/Lists.java': sub(src, 'if (!keep.test(x))', 'if (keep.test(x))') },
  });
}

// ------------------------------------------------------------ JSON / YAML

const pyCheck = (...lines: string[]) => L('import json, sys', 'import yaml', '', ...lines, 'print("ok")');
{
  const src = L('{', '  "name": "shop",', '  "server": {', '    "host": "0.0.0.0",', '    "port": 8080,', '    "tls": {', '      "enabled": false,', '      "cert": ""', '    }', '  },', '  "features": ["cart", "search"]', '}');
  tasks.push({
    id: 'cfg01-json-nested', lang: 'config', stress: 'nested JSON object', ...CFG, test: CFG_TEST,
    prompt: 'config/app.json: enable TLS for the server and set its cert to "/etc/ssl/shop.pem". Leave everything else unchanged. `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'config/app.json': src, 'tests/check.py': pyCheck('c = json.load(open("config/app.json"))', 'assert c["server"]["tls"] == {"enabled": True, "cert": "/etc/ssl/shop.pem"}', 'assert c["server"]["port"] == 8080 and c["features"] == ["cart", "search"]') },
    solution: { 'config/app.json': sub(src, '"enabled": false,\n      "cert": ""', '"enabled": true,\n      "cert": "/etc/ssl/shop.pem"') },
  });
}
{
  const users = [1, 2, 3, 4, 5].map((id) => `  {\n    "id": ${id},\n    "name": "user${id}",\n    "active": true\n  }`).join(',\n');
  const src = `[\n${users}\n]\n`;
  tasks.push({
    id: 'cfg02-json-array', lang: 'config', stress: 'five near-identical JSON objects (uniqueness)', ...CFG, test: CFG_TEST,
    prompt: 'data/users.json: deactivate the user with id 3 (set "active" to false). Do not change anything else. `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'data/users.json': src, 'tests/check.py': pyCheck('u = json.load(open("data/users.json"))', 'assert [x["active"] for x in u] == [True, True, False, True, True], u') },
    solution: { 'data/users.json': sub(src, '"id": 3,\n    "name": "user3",\n    "active": true', '"id": 3,\n    "name": "user3",\n    "active": false') },
  });
}
{
  const src = L('services:', '  web:', '    image: shop/web:1.4', '    ports:', '      - "80:8080"', '    environment:', '      - LOG_LEVEL=info', '  worker:', '    image: shop/worker:1.4', '    environment:', '      - LOG_LEVEL=info');
  tasks.push({
    id: 'cfg03-yaml-list', lang: 'config', stress: 'indentation-sensitive YAML, two edits', ...CFG, test: CFG_TEST,
    prompt: 'deploy.yaml: bump both images from 1.4 to 1.5, and add QUEUE=orders to the worker environment (after LOG_LEVEL). `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'deploy.yaml': src, 'tests/check.py': pyCheck('d = yaml.safe_load(open("deploy.yaml"))["services"]', 'assert d["web"]["image"] == "shop/web:1.5" and d["worker"]["image"] == "shop/worker:1.5"', 'assert d["worker"]["environment"] == ["LOG_LEVEL=info", "QUEUE=orders"]', 'assert d["web"]["environment"] == ["LOG_LEVEL=info"] and d["web"]["ports"] == ["80:8080"]') },
    solution: { 'deploy.yaml': sub(sub(src, 'shop/web:1.4', 'shop/web:1.5'), '    image: shop/worker:1.4\n    environment:\n      - LOG_LEVEL=info\n', '    image: shop/worker:1.5\n    environment:\n      - LOG_LEVEL=info\n      - QUEUE=orders\n') },
  });
}
{
  const src = crlf(L('# HTTP client settings', 'http:', '  timeout: 30', '  retries: 2', 'db:', '  timeout: 30', '  pool: 10'));
  tasks.push({
    id: 'cfg04-yaml-crlf', lang: 'config', stress: 'CRLF YAML with a duplicated key/value pair', ...CFG, test: CFG_TEST,
    prompt: 'settings.yaml: raise the http timeout to 60. The db timeout must stay 30. `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'settings.yaml': src, 'tests/check.py': pyCheck('s = yaml.safe_load(open("settings.yaml"))', 'assert s["http"]["timeout"] == 60 and s["db"]["timeout"] == 30, s') },
    solution: { 'settings.yaml': sub(src, 'http:\r\n  timeout: 30', 'http:\r\n  timeout: 60') },
  });
}
{
  const src = L('{', '  "name": "widget",', '  "version": "1.2.3",', '  "private": true,', '  "scripts": {', '    "build": "tsc -p .",', '    "test": "node --test"', '  },', '  "devDependencies": {', '    "typescript": "^5.9.3"', '  }', '}');
  tasks.push({
    id: 'cfg05-package-json', lang: 'config', stress: 'two JSON edits in one file', ...CFG, test: CFG_TEST,
    prompt: 'package.json: bump the version to 1.3.0 and add a "lint" script that runs "eslint .". `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'package.json': src, 'tests/check.py': pyCheck('p = json.load(open("package.json"))', 'assert p["version"] == "1.3.0"', 'assert p["scripts"] == {"build": "tsc -p .", "test": "node --test", "lint": "eslint ."}, p["scripts"]', 'assert p["devDependencies"] == {"typescript": "^5.9.3"}') },
    solution: { 'package.json': sub(sub(src, '"version": "1.2.3"', '"version": "1.3.0"'), '    "test": "node --test"\n', '    "test": "node --test",\n    "lint": "eslint ."\n') },
  });
}
{
  const src = L('defaults: &defaults', '  retries: 3', '  timeout: 10', '', 'production:', '  <<: *defaults', '  timeout: 30', '', 'staging:', '  <<: *defaults');
  tasks.push({
    id: 'cfg06-yaml-anchors', lang: 'config', stress: 'YAML anchors and merge keys', ...CFG, test: CFG_TEST,
    prompt: 'environments.yaml: raise the default retries to 5 (for every environment) and give staging its own timeout of 20. `python3 tests/check.py` must pass; do not modify the tests.',
    files: { 'environments.yaml': src, 'tests/check.py': pyCheck('e = yaml.safe_load(open("environments.yaml"))', 'assert e["production"] == {"retries": 5, "timeout": 30}, e', 'assert e["staging"] == {"retries": 5, "timeout": 20}, e') },
    solution: { 'environments.yaml': sub(sub(src, '  retries: 3', '  retries: 5'), 'staging:\n  <<: *defaults\n', 'staging:\n  <<: *defaults\n  timeout: 20\n') },
  });
}

// ------------------------------------------------------------ writing

/** 0-based original line windows touched by the reference solution (±3 lines). */
function windows(orig: string, sol: string): [number, number][] {
  const a = orig.split('\n');
  const b = sol.split('\n');
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    // find the next resync point
    let found = false;
    for (let d = 1; d < 40 && !found; d++)
      for (let k = 0; k <= d && !found; k++) {
        const ii = i + k;
        const jj = j + (d - k);
        if (ii < a.length && jj < b.length && a[ii] === b[jj] && a[ii] !== undefined && a.slice(ii, ii + 2).join() === b.slice(jj, jj + 2).join()) {
          out.push([Math.max(0, i - 3), ii + 3]);
          i = ii;
          j = jj;
          found = true;
        }
      }
    if (!found) {
      out.push([Math.max(0, i - 3), a.length]);
      break;
    }
  }
  return out;
}

fs.rmSync(ROOT, { recursive: true, force: true });
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};
const intactPy = fs.readFileSync(path.join(import.meta.dirname, 'intact.py'), 'utf8');
const pytestsPy = fs.readFileSync(path.join(import.meta.dirname, 'pytests.py'), 'utf8');
for (const t of tasks) {
  const dir = path.join(ROOT, t.id);
  for (const [f, s] of Object.entries(t.files)) write(path.join(dir, 'repo', f), s);
  for (const [f, s] of Object.entries(t.solution)) {
    if (s === t.files[f]) throw new Error(`${t.id}: solution for ${f} is unchanged`);
    write(path.join(dir, 'solution', f), s);
  }
  const intact = { files: Object.keys(t.solution).map((f) => ({ path: f, original: Buffer.from(t.files[f]).toString('base64'), windows: windows(t.files[f], t.solution[f]), slack: 2 })) };
  write(path.join(dir, 'repo', '.oh-eval', 'intact.json'), JSON.stringify(intact, null, 1) + '\n');
  write(path.join(dir, 'repo', '.oh-eval', 'intact.py'), intactPy);
  if (t.test === PY_TEST) write(path.join(dir, 'repo', '.oh-eval', 'pytests.py'), pytestsPy);
  const task = {
    id: t.id,
    version: 1,
    type: 'edit',
    language: t.lang,
    stress: t.stress,
    behaviour: t.prompt,
    prompt: t.prompt,
    acceptance: [t.test, INTEGRITY],
    verification: t.verification,
    protected: [...t.protected, '.oh-eval/**'],
    timeout_s: 900,
  };
  write(path.join(dir, 'task.json'), JSON.stringify(task, null, 2) + '\n');
}
console.log(`wrote ${tasks.length} tasks to ${ROOT}`);
