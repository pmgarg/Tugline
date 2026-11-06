/**
 * Evaluation runner (EAG S18). A benchmark is a procedure, not a percentage:
 * task + harness + policy + scorer + manifest.
 *
 * Suite layout:
 *   <suite>/suite.json            { "arms": { "<name>": { config overrides } }, "repeats": 3 }
 *   <suite>/tasks/<id>/task.json  { id, version, type, behaviour, prompt, acceptance[], verification[], protected[], timeout_s }
 *   <suite>/tasks/<id>/repo/      the fixture the agent works in (copied fresh per run)
 *
 * For each task × arm × repeat: copy the fixture, git-init it, hash protected
 * files, run the agent headless in auto mode, then (scorer side, outside the
 * agent) run the acceptance commands, hash again, take the diff, and save the
 * RAW record before scoring.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import picomatch from 'picomatch';
import { Agent } from '../agent/agent.js';
import { deepMerge, loadConfig, resolveProfile, type HarnessConfig } from '../config.js';
import type { AgentEvent } from '../types.js';
import { execCommand, scrubbedEnv } from '../tools/shell.js';
import { walkFiles } from '../tools/fs.js';
import { scoreRun, summarizeScores, type RawRunRecord, type ScoredRun } from './scorer.js';
import { appendEditMetrics } from '../edit/metrics.js';
import { builtinTools } from '../tools/index.js';
import { providerTools } from '../tools/registry.js';
import { resolveExternal, runExternal, type ExternalRunResult } from './external.js';
import { copyHiddenIn, ensureImage, execArgv, HIDDEN_IN_CONTAINER, releaseWorkspace, startContainer, stopContainer, type EvalContainer, type Isolation, type TaskDocker } from './isolation.js';
import { restorePristine } from '../permissions/protectFs.js';

export interface TaskSpec {
  id: string;
  version: number;
  type: string;
  behaviour: string;
  prompt: string;
  acceptance: string[];
  verification: string[];
  protected: string[];
  timeout_s?: number;
  /** v1.2 N35: run the task as a goal (the label, "verified" or "judged met (independent verifier)", goes in the report) */
  goal?: { condition?: string; check?: string; verify?: boolean; max_turns?: number };
  dir: string;
  /** Host directory of material the agent must not see (hidden tests); `{{HIDDEN}}` in commands points at it. */
  hidden?: string;
  /** Commands run on the host workspace after the agent and before acceptance (e.g. applying a hidden test patch). */
  prepare?: string[];
  /** How to containerise the task when the run is docker-isolated (G5). */
  docker?: TaskDocker;
}

export interface SuiteSpec {
  arms: Record<string, any>;
  repeats: number;
  /**
   * Optional module (relative to the suite) whose `start()` brings up services
   * the tasks need, e.g. the browser suite's local test site, and returns
   * `{ vars, stop(), report?(outDir, scored) }`. `{{NAME}}` in prompts and
   * acceptance commands is replaced with `vars.NAME`; `report` may append a
   * section to report.md (e.g. automation path statistics).
   */
  setup?: string;
}

interface SuiteServices {
  vars?: Record<string, string>;
  stop?: () => Promise<void> | void;
  report?: (outDir: string, scored: ScoredRun[]) => string | undefined | Promise<string | undefined>;
}

export function loadSuite(dir: string, vars: Record<string, string> = {}): { suite: SuiteSpec; tasks: TaskSpec[] } {
  const sub = (x: string) => x.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  const suiteFile = path.join(dir, 'suite.json');
  const suite: SuiteSpec = fs.existsSync(suiteFile) ? { repeats: 1, arms: { default: {} }, ...JSON.parse(fs.readFileSync(suiteFile, 'utf8')) } : { repeats: 1, arms: { default: {} } };
  const tdir = path.join(dir, 'tasks');
  const tasks: TaskSpec[] = fs
    .readdirSync(tdir)
    .filter((d) => fs.existsSync(path.join(tdir, d, 'task.json')))
    .sort()
    .map((d) => ({ protected: [], verification: [], version: 1, type: 'source_repair', behaviour: '', ...JSON.parse(fs.readFileSync(path.join(tdir, d, 'task.json'), 'utf8')), dir: path.join(tdir, d) }))
    .map((t: TaskSpec) => ({ ...t, prompt: sub(t.prompt), acceptance: t.acceptance.map(sub) }));
  return { suite, tasks };
}

function hashProtected(root: string, patterns: string[]): Record<string, string> {
  if (!patterns.length) return {};
  const isMatch = picomatch(patterns, { dot: true });
  const out: Record<string, string> = {};
  for (const f of walkFiles(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (rel.startsWith('.git/') || rel.startsWith('.tugline/')) continue;
    if (isMatch(rel)) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  }
  return out;
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@local', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@local' } }).toString();
  } catch (e) {
    return String((e as any).stdout ?? '');
  }
}

export interface EvalOptions {
  suiteDir: string;
  outDir: string;
  baseConfig: HarnessConfig;
  arms?: string[];
  repeats?: number;
  tasks?: string[];
  onEvent?: (task: string, arm: string, e: AgentEvent) => void;
  log?: (s: string) => void;
  /** 'docker': tasks with a `docker` spec run in their own container (G5). Default 'host'. */
  isolation?: Isolation;
  /** Network of docker-isolated task containers (default bridge). */
  dockerNetwork?: 'bridge' | 'none';
  /** v1.1 R10: GPU share recorded per run for GPU-seconds per resolved task (an arm's `gpuShare` wins). */
  gpuShare?: number;
  /** v1.1 R18: the contention condition of this run (quiet / shared + load), read when each run's record is written. */
  condition?: () => RunCondition;
  /**
   * Arm definitions for arms the suite's own suite.json does not define (e.g. `tug bench suite --arm default,cline`
   * on evals/coding-basics). Live run 31 Oct: without this, `cline` silently ran Tugline.
   */
  armDefs?: Record<string, Record<string, unknown>>;
}

export interface RunCondition {
  name: string;
  /** Concurrent synthetic clients loading the endpoint during the run (0 = quiet). */
  loadClients: number;
  loadRequests?: number;
  loadErrors?: number;
}

export async function runEval(o: EvalOptions): Promise<ScoredRun[]> {
  const { suite } = loadSuite(o.suiteDir);
  const svc: SuiteServices | undefined = suite.setup ? await (await import(pathToFileURL(path.resolve(o.suiteDir, suite.setup)).href)).start() : undefined;
  try {
    const scored = await runEvalTasks(o, svc?.vars ?? {});
    const extra = await svc?.report?.(o.outDir, scored);
    if (extra) fs.appendFileSync(path.join(o.outDir, 'report.md'), `\n${extra}\n`);
    return scored;
  } finally {
    await svc?.stop?.();
  }
}

async function runEvalTasks(o: EvalOptions, vars: Record<string, string>): Promise<ScoredRun[]> {
  const { suite, tasks } = loadSuite(o.suiteDir, vars);
  const arms = o.arms?.length ? o.arms : Object.keys(suite.arms);
  // An arm nobody defines must not silently run as plain Tugline under another agent's name.
  const unknown = arms.filter((a) => !(a in suite.arms) && !(o.armDefs && a in o.armDefs));
  if (unknown.length) throw new Error(`unknown arm${unknown.length > 1 ? 's' : ''} ${unknown.map((a) => `"${a}"`).join(', ')}: not in ${path.join(o.suiteDir, 'suite.json')} (arms there: ${Object.keys(suite.arms).join(', ') || 'none'})`);
  const repeats = o.repeats ?? suite.repeats ?? 1;
  const runsDir = path.join(o.outDir, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const scored: ScoredRun[] = [];
  const log = o.log ?? (() => {});
  // Hidden test material of every task in the suite: the agent's file tools may not read it (shell
  // reads are stopped by the container in docker mode; in host mode an unrestricted shell still can).
  const hiddenDeny = tasks.flatMap((t) => (t.hidden ? [`read(${t.hidden})`, `read(${t.hidden}/**)`] : []));
  for (const task of tasks.filter((t) => !o.tasks?.length || o.tasks.includes(t.id))) {
    for (const arm of arms) {
      for (let rep = 1; rep <= repeats; rep++) {
        const runId = `${task.id}__${arm}__r${rep}`;
        const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `oh-eval-${task.id}-`)));
        fs.cpSync(path.join(task.dir, 'repo'), work, { recursive: true });
        // G5: a docker-isolated run gets its own container, with this workspace bind-mounted.
        let container: EvalContainer | undefined;
        let image: string | undefined;
        let setupError: string | undefined;
        if (o.isolation === 'docker' && task.docker) {
          try {
            image = await ensureImage(task.docker, log);
            container = await startContainer({ image, hostWork: work, workdir: task.docker.workdir, network: o.dockerNetwork, setup: task.docker.setup, log });
          } catch (e) {
            setupError = `docker isolation failed: ${(e as Error).message}`;
            log(`  ${setupError}`);
          }
        }
        const hiddenFor = (cmd: string) => cmd.split('{{HIDDEN}}').join(container ? HIDDEN_IN_CONTAINER : task.hidden ?? '{{HIDDEN}}');
        git(work, ['init', '-q']);
        git(work, ['add', '-A']);
        git(work, ['commit', '-qm', 'fixture']);
        const armOverrides = suite.arms[arm] ?? o.armDefs?.[arm] ?? {};
        const guardOn = armOverrides.__guard !== false;
        let cfg: HarnessConfig = deepMerge(o.baseConfig, {
          // N43: benchmarks run in a throwaway checkout with no human, so the classifier-less mode (renamed yolo)
          permissionMode: 'yolo',
          permissions: { protectedPaths: guardOn ? [...o.baseConfig.permissions.protectedPaths, ...task.protected] : [], deny: [...o.baseConfig.permissions.deny, ...hiddenDeny] },
          homeDir: path.join(o.outDir, 'home'),
        });
        // `__tools`: restrict the agent to these tool names (I2 `--arm bash-only`: the mini-swe-agent baseline).
        // `external`: run another agent's CLI instead of Tugline (v1.1 R10); `gpuShare`: GPU-seconds accounting.
        // `__withoutTools`: drop these tools from the full set; `__ablation`: the feature switches the arm stands for (R18).
        const { __guard, __tools, __withoutTools, __ablation, external, gpuShare: armGpuShare, ...rest } = armOverrides;
        cfg = deepMerge(cfg, rest);
        const ext = external ? resolveExternal(external) : undefined;
        const gpuShare = typeof armGpuShare === 'number' ? armGpuShare : o.gpuShare;
        // The command wrapper keys on evalContainer; the OS sandbox stays off (commands already run in the container).
        if (container) cfg = deepMerge(cfg, { evalContainer: container, shell: { sandbox: 'none' } });
        const profile = resolveProfile(cfg);
        const events: RawRunRecord['events'] = [];
        const protectedBefore = hashProtected(work, task.protected);
        const started = new Date().toISOString();
        log(`▶ ${runId}`);
        let result: Awaited<ReturnType<Agent['run']>> | undefined;
        let goal: { status: string; label: string; reason?: string; iterations: number } | undefined;
        let error: string | undefined;
        const onlyTools: string[] | undefined = Array.isArray(__tools) ? __tools.map(String) : undefined;
        const without: string[] = Array.isArray(__withoutTools) ? __withoutTools.map(String) : [];
        let extRun: ExternalRunResult | undefined;
        const agentStarted = new Date().toISOString();
        if (ext) {
          try {
            if (setupError) throw new Error(setupError);
            extRun = await runExternal({ arm: ext, workspace: work, prompt: task.prompt, profile: { baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey }, stateDir: path.join(o.outDir, 'external-state', runId), timeoutS: (task.timeout_s ?? 1800) * timeoutScale(), logFile: path.join(runsDir, `${runId}.external.log`) });
            if (extRun.exitCode === 127 && /failed to start|command not found/.test(extRun.output)) error = `external agent not runnable: ${extRun.output.trim().slice(-300)}`;
            // It never reached the model through the metering proxy: misconfigured (e.g. its own default provider), not a
            // result. Scoring it as 0% would misstate the comparison (live run 31 Oct: Cline called api.openai.com).
            else if (extRun.meter.requests === 0) error = `external agent never called the model endpoint (0 metered requests; check its provider configuration): ${extRun.output.trim().slice(-300)}`;
          } catch (e) {
            error = (e as Error).message;
          }
          result = extRun ? externalResult(extRun, work) : undefined;
        }
        const agent = ext ? undefined : await Agent.create({
          workspace: work,
          config: cfg,
          tools: onlyTools
            ? builtinTools(cfg).filter((t) => onlyTools.includes(t.name))
            : without.length
              ? [...builtinTools(cfg), ...(await providerTools(cfg, { workspace: work, homeDir: cfg.homeDir, depth: 0 }))].filter((t, i, all) => !without.includes(t.name) && all.findIndex((x) => x.name === t.name) === i)
              : undefined,
          surface: 'automated evaluation harness (no human is available; never ask questions)',
          // v1.1 R2: the task's verification and acceptance commands are trusted checks
          // (live run, 5 Nov: browser/desktop tasks list the *tools* that verify, e.g. browser_verify; those are not shell
          // commands and used to run as checks that "could not run" (exit 127), so correct runs scored unverified)
          // (live run, 5 Nov) `verification` lists *markers* the scorer looks for in what the agent ran ("javac", "Check",
          // "tests/check.ts", "browser_verify"), not runnable commands; run as checks they always failed (bare `javac`
          // exits 2), so correct runs scored unverified and agents were told to fix work that was right. The task's
          // acceptance commands are the check; markers are used only when a task has no acceptance at all.
          acceptanceChecks: harnessChecksFor(task),
          journal: false,
          mcp: false,
          ui: {
            onEvent: (e) => {
              if (e.type !== 'text_delta' && e.type !== 'reasoning_delta') events.push(JSON.parse(JSON.stringify(e)));
              o.onEvent?.(task.id, arm, e);
            },
          },
        });
        // R18: the harness prompt is part of the arm. Record its hash on every run, and its text once per arm.
        let systemPromptSha: string | undefined = ext ? extRun?.meter.systemPromptSha : undefined;
        const promptFile = path.join(o.outDir, 'prompts', `${arm.replace(/[^\w.-]/g, '_')}.txt`);
        if (ext && extRun?.meter.systemPrompt && !fs.existsSync(promptFile)) {
          fs.mkdirSync(path.dirname(promptFile), { recursive: true });
          fs.writeFileSync(promptFile, extRun.meter.systemPrompt);
        }
        if (agent) {
          const timer = setTimeout(() => agent.abort(), (task.timeout_s ?? 1800) * timeoutScale() * 1000);
          try {
            if (setupError) throw new Error(setupError);
            if (task.goal) {
              // N35: a goal task: the check decides ("verified"), or the independent verifier ("judged met")
              const { runGoal } = await import('../context/goal.js');
              const g = await runGoal(agent, task.goal.condition ?? task.prompt, { check: task.goal.check, verify: task.goal.verify, maxTurns: task.goal.max_turns });
              goal = { status: g.status, label: g.label, reason: g.reason, iterations: g.iterations };
              result = { runId: agent.runId ?? '', stopReason: g.stopReason, finalText: g.finalText, stats: { ...agent.runStats, promptTokens: agent.totals.promptTokens, completionTokens: agent.totals.completionTokens, costUsd: agent.totals.costUsd, llmCalls: agent.totals.llmCalls }, completion: { state: 'not_applicable', summary: `goal ${g.status}: ${g.label}`, claimedSuccess: false } as any };
            } else result = await agent.run(task.prompt);
          } catch (e) {
            error = (e as Error).message;
          } finally {
            clearTimeout(timer);
            const sys = agent.messages.find((m) => m.role === 'system');
            const text = typeof sys?.content === 'string' ? sys.content : sys ? JSON.stringify(sys.content) : '';
            if (text) {
              systemPromptSha = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
              if (!fs.existsSync(promptFile)) {
                fs.mkdirSync(path.dirname(promptFile), { recursive: true });
                fs.writeFileSync(promptFile, text);
              }
            }
            await agent.dispose();
          }
        }
        const agentEnded = new Date().toISOString();
        // Scorer side: acceptance runs outside the agent, on the final workspace — but against pristine copies of
        // the protected files from the task source (R1), so a modified judge cannot pass itself. A difference is
        // still reported: protectedAfter is hashed before the restore (scorer: integrity protected_write).
        // Hidden material reaches it only now: patches are applied on the host, files are copied into the container.
        // A run whose container never started measured nothing: no acceptance (it would run on the host).
        const protectedAfter = hashProtected(work, task.protected);
        if (task.protected.length) restorePristine(path.join(task.dir, 'repo'), work, task.protected);
        const acceptance: RawRunRecord['acceptance'] = [];
        let prepared = !setupError;
        // Files the container wrote as root must be writable by the host-side prepare step.
        if (container) await releaseWorkspace(container);
        for (const cmd of prepared ? task.prepare ?? [] : []) {
          const r = await execCommand({ shellCommand: cmd.split('{{HIDDEN}}').join(task.hidden ?? '{{HIDDEN}}'), cwd: work, timeoutMs: 300_000, env: scrubbedEnv([]) });
          if (r.exitCode !== 0) {
            prepared = false;
            acceptance.push({ command: `[prepare] ${cmd}`, exitCode: r.exitCode, output: r.output.slice(-4000) });
          }
        }
        if (prepared && container && task.hidden && fs.existsSync(task.hidden)) {
          try {
            await copyHiddenIn(container, task.hidden);
          } catch (e) {
            prepared = false;
            acceptance.push({ command: '[copy hidden tests into the container]', exitCode: 1, output: (e as Error).message });
          }
        }
        for (const cmd of prepared ? task.acceptance : []) {
          const c = hiddenFor(cmd);
          const r = container ? await execCommand({ argv: execArgv(container, c), cwd: work, timeoutMs: 300_000, env: scrubbedEnv([]) }) : await execCommand({ shellCommand: c, cwd: work, timeoutMs: 300_000, env: scrubbedEnv([]) });
          acceptance.push({ command: cmd, exitCode: r.exitCode, output: r.output.slice(-4000) });
        }
        if (container) await stopContainer(container);
        const record: RawRunRecord = {
          runId,
          manifest: {
            task: task.id,
            taskVersion: task.version,
            taskType: task.type,
            arm,
            repeat: rep,
            model: profile.model,
            baseUrl: profile.baseUrl,
            toolMode: profile.toolMode,
            ...(onlyTools ? { tools: onlyTools } : {}),
            harnessVersion: 'tugline@0.1.0',
            protectedPaths: cfg.permissions.protectedPaths,
            maxRepeatFailures: cfg.agent.maxRepeatFailures,
            maxTurns: cfg.agent.maxTurns,
            timeoutS: (task.timeout_s ?? 1800) * timeoutScale(),
            startedAt: started,
            isolation: container || setupError ? 'docker' : 'host',
            ...(container ? { image } : {}),
            agentStartedAt: agentStarted,
            agentEndedAt: agentEnded,
            ...(gpuShare !== undefined ? { gpuShare } : {}),
            // R18: the fixed conditions a paired comparison checks, the condition label, and the ablation switches.
            contextWindow: profile.contextWindow,
            maxOutputTokens: profile.maxOutputTokens,
            temperature: profile.temperature,
            ...(systemPromptSha ? { systemPromptSha } : {}),
            ...(o.condition ? { condition: o.condition() } : {}),
            ...(__ablation && typeof __ablation === 'object' ? { ablation: __ablation as Record<string, boolean> } : {}),
            ...(ext ? { external: { name: ext.preset ?? 'custom', command: extRun?.recordedCommand ?? ext.command ?? '', version: extRun?.version }, agentIsolation: 'host' as const, tokensEstimated: extRun?.meter.estimated ?? false } : {}),
          },
          prompt: task.prompt,
          stopReason: result?.stopReason ?? 'error',
          finalText: result?.finalText ?? '',
          completion: result?.completion,
          ...(goal ? { goal } : {}),
          stats: result?.stats ?? { turns: 0, llmCalls: 0, successfulLlmCalls: 0, unparseableReplies: 0, toolCalls: 0, toolErrors: 0, refusals: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, durationMs: 0, filesChanged: [], commandsRun: [] },
          events,
          finalDiff: git(work, ['diff', 'HEAD']).slice(0, 200_000),
          protectedBefore,
          protectedAfter,
          acceptance,
          verificationCommands: task.verification,
          error,
        };
        fs.writeFileSync(path.join(runsDir, `${runId}.json`), JSON.stringify(record, null, 2));
        const s = scoreRun(record);
        scored.push(s);
        log(`  ${s.outcome} | ${s.integrity} | ${s.verification} | stop=${s.stopReason} | ${s.cost.llmCalls} calls, ${s.cost.seconds}s`);
        fs.rmSync(work, { recursive: true, force: true });
      }
    }
  }
  writeReport(o.outDir, scored);
  return scored;
}

/** An external agent's run in the shape of an Tugline result (stats metered at the endpoint, v1.1 R10). */
function externalResult(r: ExternalRunResult, work: string): Awaited<ReturnType<Agent['run']>> {
  const changed = git(work, ['status', '--porcelain']).split('\n').filter(Boolean).map((l) => l.slice(3));
  return {
    stopReason: r.timedOut ? 'aborted' : r.exitCode === 0 ? 'end_turn' : 'error',
    finalText: r.output.slice(-4000),
    stats: {
      turns: r.meter.requests,
      llmCalls: r.meter.requests,
      successfulLlmCalls: r.meter.ok,
      unparseableReplies: 0,
      toolCalls: 0,
      toolErrors: 0,
      refusals: 0,
      promptTokens: r.meter.promptTokens,
      completionTokens: r.meter.completionTokens,
      costUsd: 0,
      durationMs: r.durationMs,
      filesChanged: changed,
      commandsRun: [],
    },
  } as unknown as Awaited<ReturnType<Agent['run']>>;
}

export function rescore(outDir: string): ScoredRun[] {
  const runsDir = path.join(outDir, 'runs');
  const rows = fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => scoreRun(JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')) as RawRunRecord));
  writeReport(outDir, rows);
  return rows;
}

function writeReport(outDir: string, rows: ScoredRun[]): void {
  fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(rows, null, 2));
  // N35: goal tasks show their label; "verified" (harness check) and "judged met (independent verifier)" never merge
  const goals = rows.filter((r) => r.goal).map((r) => `| ${r.task} | ${r.arm} | ${r.repeat} | ${r.goal!.status} | ${r.goal!.label} |`);
  const goalTable = goals.length ? `\n\n## Goals\n| task | arm | repeat | status | label |\n|---|---|---|---|---|\n${goals.join('\n')}` : '';
  fs.writeFileSync(path.join(outDir, 'report.md'), `# Evaluation report\n\nUnder this manifest (see runs/*.json → manifest), we observed:\n\n${summarizeScores(rows)}${goalTable}\n\nRaw records are in runs/. Re-score without calling a model: \`tug rescore ${outDir}\`.\n`);
  appendEditMetrics(outDir); // SPEC A9 (WS1): edit metrics when the runs contain edits
}

export { loadConfig };

/** Slow local hardware (CPU-only llama.cpp, big models on laptops): TUG_EVAL_TIMEOUT_SCALE=4 gives every task 4× its timeout. Recorded in each run's manifest via timeoutS. */
export function timeoutScale(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.TUG_EVAL_TIMEOUT_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** A verification entry that names a tool (browser_verify, desktop_snapshot), not a shell command. Exported for tests. */
export function isToolName(v: string): boolean {
  return /^(?:browser|desktop|code|web|team|workflow|task|job)_[a-z_]+$/.test(v.trim());
}

/** The commands the harness itself runs as the task's check: its acceptance commands (see the note at the call site). */
export function harnessChecksFor(task: { acceptance?: string[]; verification?: string[] }): string[] {
  if (task.acceptance?.length) return [...task.acceptance];
  return (task.verification ?? []).filter((v) => !isToolName(v) && /\s/.test(v.trim()));
}
