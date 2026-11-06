// Self-check of the editing eval suite (SPEC A9), no model involved:
//   1. on the untouched fixture, the task's tests FAIL (the task is real) and integrity passes;
//   2. with the reference solution applied, every acceptance command passes;
//   3. with the solution applied but line endings / BOM / unrelated lines damaged,
//      the integrity command fails (the corrupted-file metric can fire).
// Run: npx tsx evals/editing/check.mts [task-id ...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadSuite } from '../../src/core/eval/runner.ts';

const dir = import.meta.dirname;
const only = process.argv.slice(2);

function run(cmd: string, cwd: string): number {
  try {
    execSync(cmd, { cwd, stdio: 'pipe', shell: '/bin/bash', timeout: 180_000 });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

export function checkTask(taskDir: string, acceptance: string[]): string[] {
  const problems: string[] = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-editcheck-'));
  try {
    fs.cpSync(path.join(taskDir, 'repo'), work, { recursive: true });
    const [testCmd, ...rest] = acceptance;
    if (run(testCmd, work) === 0) problems.push('tests already pass on the unfixed fixture');
    for (const c of rest) if (run(c, work) !== 0) problems.push(`integrity fails on the untouched fixture: ${c}`);
    const solDir = path.join(taskDir, 'solution');
    const solFiles: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(path.join(d, e.name)) : solFiles.push(path.relative(solDir, path.join(d, e.name))));
    };
    walk(solDir);
    for (const f of solFiles) fs.copyFileSync(path.join(solDir, f), path.join(work, f));
    for (const c of acceptance) if (run(c, work) !== 0) problems.push(`reference solution fails: ${c}`);
    // corruption must be detected
    const integrity = acceptance.filter((c) => c.startsWith(': integrity;'));
    const f = path.join(work, solFiles[0]);
    const good = fs.readFileSync(f);
    const text = good.toString('utf8');
    const damaged = text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text.startsWith('﻿') ? text.slice(1) : text.replace(/\n/g, '\r\n');
    fs.writeFileSync(f, damaged);
    for (const c of integrity) if (run(c, work) === 0) problems.push('integrity check misses changed line endings/BOM');
    fs.writeFileSync(f, good);
    // three changed lines outside the edited windows must also be caught
    const spec = JSON.parse(fs.readFileSync(path.join(work, '.oh-eval', 'intact.json'), 'utf8'));
    const wins: [number, number][] = spec.files.find((x: { path: string }) => x.path === solFiles[0].split(path.sep).join('/')).windows;
    const orig = Buffer.from(spec.files[0].original, 'base64').toString('utf8').split('\n');
    const outside = orig.map((_, k) => k).filter((k) => orig[k].trim() && !wins.some(([a, b]) => a <= k && k <= b));
    if (outside.length >= 3) {
      const copy = text.split('\n');
      // lines outside every window are unchanged by the solution, so their indexes still line up
      for (const k of outside.slice(0, 3)) copy[k] = copy[k].replace(/(\r?)$/, ' x$1');
      fs.writeFileSync(f, copy.join('\n'));
      for (const c of integrity) if (run(c, work) === 0) problems.push('integrity check misses unrelated changed lines');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  return problems;
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  const { tasks } = loadSuite(dir);
  let bad = 0;
  for (const t of tasks.filter((t) => !only.length || only.includes(t.id))) {
    const p = checkTask(t.dir, t.acceptance);
    console.log(`${p.length ? 'FAIL' : 'ok  '} ${t.id}${p.length ? ': ' + p.join('; ') : ''}`);
    if (p.length) bad++;
  }
  console.log(bad ? `${bad} task(s) have problems` : 'all tasks ok');
  process.exitCode = bad ? 1 : 0;
}
