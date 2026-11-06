#!/usr/bin/env node
// N45 AC2 [DEVICE]: fixture, checks and timing table for a side-by-side VS Code comparison (Tugline vs Cline).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const RESULTS = path.resolve('docs/evidence/N45/ac2-results.jsonl');
const [cmd, ...args] = process.argv.slice(2);
const FILES = {
  'stats.py': 'def mean(values):\n    return sum(values) / len(values)\n\n\ndef median(values):\n    s = sorted(values)\n    n = len(s)\n    mid = n // 2\n    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2\n',
  'report.py': 'import os\nfrom stats import mean\n\n\ndef summary(values):\n    return f"mean={mean(values)}"\n',
  'tests/test_stats.py': 'from stats import mean, median\n\n\ndef test_mean_empty():\n    assert mean([]) == 0\n\n\ndef test_median():\n    assert median([3, 1, 2]) == 2\n',
  'AGENTS.md': '# Fixture\nRun tests with `python3 -m pytest -q`.\n',
};

if (cmd === 'init') {
  const dir = path.resolve(args[0] ?? path.join(os.homedir(), 'oh-parity', 'fixture'));
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  const g = (...a) => execFileSync('git', ['-c', 'user.name=parity', '-c', 'user.email=parity@local', ...a], { cwd: dir });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-qm', 'fixture');
  console.log(`fixture ready: ${dir}\nopen it in VS Code and do the tasks it lists`);
} else if (cmd === 'check') {
  const [dir, n] = args;
  const py = (a) => spawnSync('python3', a, { cwd: dir, encoding: 'utf8' });
  const checks = {
    1: () => py(['-m', 'pytest', '-q']).status === 0,
    3: () => /def mode\(/.test(fs.readFileSync(path.join(dir, 'stats.py'), 'utf8')) && py(['-m', 'pytest', '-q']).status === 0,
    4: () => !/\bmean\(/.test(['stats.py', 'report.py', 'tests/test_stats.py'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('')) && py(['-m', 'pytest', '-q']).status === 0,
    5: () => py(['-m', 'pytest', '-q']).status === 0,
    6: () => py(['-m', 'pyflakes', 'report.py']).status === 0,
  };
  const f = checks[Number(n)];
  console.log(f ? (f() ? 'pass' : 'fail') : 'manual check (see the table)');
} else if (cmd === 'record') {
  const [task, tool, seconds, clicks, result = 'pass'] = args;
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.appendFileSync(RESULTS, JSON.stringify({ task: Number(task), tool, seconds: Number(seconds), clicks: Number(clicks), result, at: new Date().toISOString() }) + '\n');
  console.log('recorded');
} else if (cmd === 'report') {
  const rows = fs.existsSync(RESULTS) ? fs.readFileSync(RESULTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const by = (t, tool) => rows.filter((r) => r.task === t && r.tool === tool).at(-1);
  const lines = ['| task | Tugline s | clicks | result | Cline s | clicks | result |', '|---|---|---|---|---|---|---|'];
  for (let t = 1; t <= 10; t++) {
    const o = by(t, 'tugline');
    const c = by(t, 'cline');
    lines.push(`| ${t} | ${o?.seconds ?? '-'} | ${o?.clicks ?? '-'} | ${o?.result ?? '-'} | ${c?.seconds ?? '-'} | ${c?.clicks ?? '-'} | ${c?.result ?? '-'} |`);
  }
  const out = path.resolve('docs/evidence/N45/ac2-results.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `# N45 AC2 results\n\n${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
} else {
  console.log('usage: vscode-parity-tasks.mjs init <dir> | check <dir> <task> | record <task> <tool> <s> <clicks> [pass|fail] | report');
}
