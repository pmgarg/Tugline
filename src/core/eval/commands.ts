/**
 * `tug review` (H2), `tug arena` (H6) and `tug bench` (I2), registered through
 * the CLI command registry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCliCommand } from '../commands.js';
import type { PermissionMode } from '../types.js';
import { parseFlags } from '../schedule/cli.js';
import { failsOn, formatGithub, formatMarkdown, runReview, writeReport } from './review.js';
import { arenaCliCommand, ARENA_USAGE } from './arenaCommands.js';
import { defaultBenchData, expandArms, FETCH_HELP, runBench, type BenchFormat } from './bench.js';
import { compareReport, loadPilot, loadRecords } from './compare.js';
import { HARBOR_HELP, runHarbor } from './harbor.js';
import { PRO_HELP } from './swepro.js';
import { resolveProfile } from '../config.js';
import { runEval } from './runner.js';
import { summarizeScores } from './scorer.js';

const repoRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

registerCliCommand({
  name: 'review',
  description: 'review git diff <base>...HEAD with the read-only reviewer; structured findings (markdown, GitHub annotations, JSON)',
  usage: '[--base main] [--format markdown|github|json] [--out report.md] [--json-out f.json] [--fail-on high|medium|low|none] | --checks [dir] [--base main] [--format text|github]',
  needsModel: true,
  async run(argv, ctx) {
    const f = parseFlags(argv);
    const base = typeof f.base === 'string' ? f.base : 'main';
    // WS12 N9: Markdown check files (.tugline/checks/*.md) as status checks
    if (f.checks !== undefined) {
      const { runChecks, formatChecks, checksExitCode } = await import('../docs/checks.js');
      const rs = await runChecks({ config: ctx.config, workspace: ctx.workspace, base, dir: typeof f.checks === 'string' ? f.checks : undefined });
      ctx.write(rs.length ? formatChecks(rs, f.format === 'github' ? 'github' : 'text') : 'no check files in .tugline/checks/');
      return checksExitCode(rs);
    }
    const format = typeof f.format === 'string' ? f.format : 'markdown';
    if (!['markdown', 'github', 'json'].includes(format)) {
      ctx.write('--format must be markdown, github or json');
      return 2;
    }
    let r;
    try {
      r = await runReview({ config: ctx.config, workspace: ctx.workspace, base, onEvent: (e) => e.type === 'tool_start' && process.stderr.write(`  · ${e.title}\n`) });
    } catch (e) {
      ctx.write(`review failed: ${(e as Error).message}`);
      return 2;
    }
    if (typeof f.out === 'string') writeReport(f.out, r);
    if (typeof f['json-out'] === 'string') fs.writeFileSync(f['json-out'], JSON.stringify({ base: r.base, files: r.files, findings: r.findings, dropped: r.dropped, stopReason: r.stopReason, unparseable: !!r.unparseable }, null, 2));
    if (format === 'json') ctx.write(JSON.stringify({ base: r.base, findings: r.findings, dropped: r.dropped }, null, 2));
    else if (format === 'github') {
      const ann = formatGithub(r);
      if (ann) ctx.write(ann);
      ctx.write(`${r.findings.length} finding(s)`);
    } else ctx.write(formatMarkdown(r));
    return failsOn(r, typeof f['fail-on'] === 'string' ? f['fail-on'] : undefined) ? 1 : 0;
  },
});

registerCliCommand({
  name: 'arena',
  description: 'one task, several models or agents in parallel worktrees, live side by side; check, judge, pick and apply the winner',
  usage: '--models a,b[,c] [--agents cline] "<prompt>" [--check "<cmd>"] [--judge profile] [--parallel N] [--pick A|auto|none] | list | show|pick|discard <run> | --models a,b --suite <evalSuiteDir>',
  help: () => ARENA_USAGE,
  needsModel: true,
  // WS24 N47: the arena CLI lives in arenaCommands.ts (live streams, external agents, pick and apply)
  run: (argv, ctx) => arenaCliCommand(argv, ctx),
});

const BENCH_USAGE =
  'terminal-bench|swe-bench|swe-bench-pro [--subset N] [--repeats N] [--arm default|bash-only|all|cline|aider|openhands|codex|mini-swe-agent,…] [--isolation docker|host] [--image name] [--network bridge|none] [--gpu-share x] [--data path] [--fetch] [--out dir]\n' +
  '  terminal-bench --harbor [--dataset terminal-bench/terminal-bench@4.0.0 | --data <Harbor tasks>] [--agent-version <tgz>]   (the official harness)\n' +
  '  swe-bench-pro [--scripts-dir <SWE-bench_Pro-os>/run_scripts] [--pro-harness <SWE-bench_Pro-os>]\n' +
  '  suite --data <eval suite dir> [--arm …] [--repeats N]   (any eval suite, e.g. evals/editing, with the paired report)\n' +
  '  [--condition quiet|shared] [--load N] [--load-prompt-tokens N] [--pilot pilot.json]   (R18 contention runs and the predeclared pilot)\n' +
  '  --compare <outDir>[,<outDir>…] [--baseline arm] [--gpu-share x|arm=x,…] [--pilot pilot.json] [--out compare.md]\n' +
  '  arm groups: all (default,bash-only), ablations (oh-full, oh-no-planner, oh-no-reviewer, oh-no-subagents, oh-no-code-mode, oh-simple), pilot (default, cline, cline-pinned, mini-swe-agent)';

registerCliCommand({
  name: 'bench',
  description: 'run a public benchmark subset (terminal-bench incl. Harbor format, swe-bench, swe-bench-pro) through the eval harness, each task in its own container when Docker is reachable; other agents as arms; --compare for the paired report',
  usage: BENCH_USAGE,
  needsModel: true,
  async run(argv, ctx) {
    const f = parseFlags(argv, ['fetch', 'help-fetch', 'harbor']);
    // v1.1 R10: the paired report over existing output directories (no model calls).
    if (f.compare !== undefined) {
      const dirs = (typeof f.compare === 'string' ? f.compare : f._.join(',')).split(',').map((d) => path.resolve(ctx.workspace, d.trim())).filter(Boolean);
      if (!dirs.length) {
        ctx.write('usage: tug bench --compare <outDir>[,<outDir>…] [--baseline arm] [--gpu-share x|arm=x,…] [--out file]');
        return 2;
      }
      const gs = typeof f['gpu-share'] === 'string' ? f['gpu-share'] : undefined;
      const gpuShare = gs === undefined ? undefined : gs.includes('=') ? Object.fromEntries(gs.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k.trim(), Number(v)])) : Number(gs);
      try {
        const pilot = typeof f.pilot === 'string' ? loadPilot(path.resolve(ctx.workspace, f.pilot)) : undefined;
        const report = compareReport({ records: loadRecords(dirs), gpuShare, baseline: typeof f.baseline === 'string' ? f.baseline : pilot?.spec.target.baseline, pilot: pilot?.spec, pilotSha: pilot?.sha });
        const out = typeof f.out === 'string' ? path.resolve(ctx.workspace, f.out) : path.join(dirs[0], 'compare.md');
        fs.writeFileSync(out, `${report}\n`);
        ctx.write(`${report}\n\nPaired report: ${out}`);
        return 0;
      } catch (e) {
        ctx.write(`compare failed: ${(e as Error).message}`);
        return 1;
      }
    }
    const format = f._[0] as BenchFormat;
    if (f['help-fetch'] || (format !== 'terminal-bench' && format !== 'swe-bench' && format !== 'swe-bench-pro' && format !== 'suite')) {
      ctx.write(`usage: tug bench ${BENCH_USAGE}\n\n${FETCH_HELP}\n\n${HARBOR_HELP}\n\n${PRO_HELP}`);
      return format ? 2 : 0;
    }
    const outDir = path.resolve(typeof f.out === 'string' ? f.out : path.join('eval-results', `bench-${format}-${stamp()}`));
    // v1.1 N1: Terminal-Bench through Harbor, the official harness (the agent runs inside each task container).
    if (f.harbor) {
      if (format !== 'terminal-bench') {
        ctx.write('--harbor runs Terminal-Bench (Harbor datasets or Harbor-format task directories)');
        return 2;
      }
      const profile = resolveProfile(ctx.config);
      try {
        const r = await runHarbor({
          dataset: typeof f.dataset === 'string' ? f.dataset : undefined,
          path: typeof f.data === 'string' ? path.resolve(ctx.workspace, f.data) : undefined,
          model: profile.model,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          attempts: f.repeats ? Number(f.repeats) : undefined,
          concurrent: f.concurrent ? Number(f.concurrent) : undefined,
          limit: f.subset ? Number(f.subset) : undefined,
          tasks: typeof f.task === 'string' ? f.task.split(',') : undefined,
          jobsDir: path.join(outDir, 'harbor-jobs'),
          adapterDir: path.join(outDir, 'harbor-agent'),
          agentVersion: typeof f['agent-version'] === 'string' ? f['agent-version'] : undefined,
          agentArgs: typeof f['agent-args'] === 'string' ? f['agent-args'] : undefined,
          harborBin: typeof f['harbor-bin'] === 'string' ? f['harbor-bin'] : undefined,
          log: (s) => ctx.write(s),
        });
        fs.writeFileSync(path.join(outDir, 'report.md'), `${r.report}\n`);
        fs.writeFileSync(path.join(outDir, 'command.txt'), `tug bench ${argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}\n`);
        ctx.write(`\n${r.report}\n\nReport: ${path.join(outDir, 'report.md')}`);
        return r.exitCode === 0 ? 0 : 1;
      } catch (e) {
        ctx.write(`bench failed: ${(e as Error).message}`);
        return 1;
      }
    }
    // G5: no flag = docker when a daemon is reachable, else host (with the "Isolation limitations" warning).
    // TUG_BENCH_ISOLATION sets the default for scripts (test-ollama.sh) that call tug bench.
    const isolation = f.isolation === undefined ? process.env.TUG_BENCH_ISOLATION || 'auto' : String(f.isolation);
    if (isolation !== 'auto' && isolation !== 'docker' && isolation !== 'host') {
      ctx.write('--isolation must be docker or host');
      return 2;
    }
    const network = f.network === undefined ? undefined : String(f.network);
    if (network !== undefined && network !== 'bridge' && network !== 'none') {
      ctx.write('--network must be bridge or none');
      return 2;
    }
    const armArg = typeof f.arm === 'string' ? f.arm : 'default';
    // R18 groups: all, ablations, pilot. A suite keeps its own arms unless --arm is given.
    const arms = format === 'suite' && typeof f.arm !== 'string' ? undefined : expandArms(armArg);
    try {
      const rows = await runBench({
        config: ctx.config,
        format,
        data: typeof f.data === 'string' ? path.resolve(ctx.workspace, f.data) : f.fetch ? undefined : defaultBenchData(format, repoRoot()),
        subset: f.subset ? Number(f.subset) : undefined,
        repeats: f.repeats ? Number(f.repeats) : undefined,
        arms,
        outDir,
        fetch: !!f.fetch,
        isolation,
        image: typeof f.image === 'string' ? f.image : undefined,
        network,
        gpuShare: f['gpu-share'] ? Number(f['gpu-share']) : undefined,
        scriptsDir: typeof f['scripts-dir'] === 'string' ? path.resolve(ctx.workspace, f['scripts-dir']) : undefined,
        proHarness: typeof f['pro-harness'] === 'string' ? path.resolve(ctx.workspace, f['pro-harness']) : undefined,
        dockerhubUser: typeof f['dockerhub-user'] === 'string' ? f['dockerhub-user'] : undefined,
        condition: typeof f.condition === 'string' ? f.condition : undefined,
        tasks: typeof f.tasks === 'string' ? f.tasks.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        load: f.load ? Number(f.load) : undefined,
        loadPromptTokens: f['load-prompt-tokens'] ? Number(f['load-prompt-tokens']) : undefined,
        pilot: typeof f.pilot === 'string' ? path.resolve(ctx.workspace, f.pilot) : undefined,
        log: (s) => ctx.write(s),
      });
      // N1 AC4: the exact command, so scripts/bench-publish.sh --rerun can reproduce this row.
      fs.writeFileSync(path.join(outDir, 'command.txt'), `tug bench ${argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')}\n`);
      ctx.write(`\n${summarizeScores(rows)}\n\nRaw runs and report: ${outDir} (paired report: compare.md)`);
      return 0;
    } catch (e) {
      ctx.write(`bench failed: ${(e as Error).message}`);
      return 1;
    }
  },
});
