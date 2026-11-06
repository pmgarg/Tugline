/**
 * The harness check, run by the harness (not the agent) in a given tree: used to
 * verify a card's merged result before it lands (N48 AC3) and to judge arena
 * contestants (N47, "harness check first").
 *
 * Same machinery as the agent's R2 check (harnessCheck.ts): the command comes
 * from the acceptance list, `agent.verifyCommands`, AGENTS.md or detection; it
 * runs in a clean environment (fresh HOME, no user site, no bytecode in the
 * tree) under the configured command wrappers (OS sandbox), and the permission
 * policy decides whether it may run at all.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessConfig } from '../config.js';
import picomatch from 'picomatch';
import { cleanCheckEnv, makeCheckHome, outputTail, planChecks, prepareCheckPlan, untrustedChanges } from './harnessCheck.js';
import { coreSettings } from './settings.js';
import { commandWrapperFor, execCommand, scrubbedEnv } from '../tools/shell.js';
import { policyForConfig } from '../permissions/fromConfig.js';

export interface TreeCheckResult {
  /** `altered`: the candidate changed the check's own inputs (review F5); its result does not count as a pass */
  state: 'verified' | 'failed' | 'unverified' | 'altered';
  /** the check inputs the candidate changed (state altered) */
  altered?: string[];
  command?: string;
  exitCode?: number | null;
  output?: string;
  /** why unverified */
  reason?: string;
  /** the check fails on the current HEAD too: the failure is not the card's (N48) */
  preexisting?: boolean;
}

export interface TreeCheckOptions {
  /** explicit check commands (e.g. `tug arena --check`); default: plan from the tree like R2 */
  commands?: string[];
  /** called when the policy says "ask"; return true to run */
  ask?: (command: string, reason: string) => Promise<boolean>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** the commands were typed by the human (e.g. `tug arena --check`): that is the approval an "ask" needs; deny rules still apply */
  userGiven?: boolean;
  /**
   * Review F5: the BASE tree (the user's tree the candidate started from). The check is planned there, never from the
   * candidate's own tree, and what it loads is fingerprinted there; a candidate that changed those inputs (package.json
   * scripts, runner config, existing tests, conftest.py, the scripts the check runs, CI files) is `altered`, not judged.
   */
  baseDir?: string;
  /** files the candidate changed, relative to the check directory (limits `altered` to the candidate's own changes) */
  changed?: string[];
}

/** CI definitions: not run by the local check, but part of how the project judges a change. */
export const CI_FILES = ['.github/workflows/**', '.gitlab-ci.yml', '.gitlab/**', '.circleci/**', 'azure-pipelines.yml', 'Jenkinsfile', '.travis.yml', 'bitbucket-pipelines.yml', '.buildkite/**'];
const isCi = picomatch(CI_FILES, { dot: true });

export async function runTreeCheck(dir: string, cfg: HarnessConfig, o: TreeCheckOptions = {}): Promise<TreeCheckResult> {
  const s = coreSettings(cfg);
  const planFrom = o.baseDir ?? dir;
  const planned = o.commands?.length ? o.commands.map((command) => ({ command, source: 'acceptance' as const })) : planChecks(planFrom, { verifyCommands: s.verifyCommands });
  if (!planned.length) return { state: 'unverified', reason: 'no check is configured or detectable (set agent.verifyCommands, or list the test command in AGENTS.md)' };
  if (o.baseDir) {
    // the R2 rules: what the check loads, fingerprinted in the base tree, compared with the candidate's
    const plan = prepareCheckPlan(o.baseDir, planned);
    const u = untrustedChanges(dir, plan);
    const changed = o.changed ? new Set(o.changed) : undefined;
    const files = [...new Set([...u.files.filter((f) => !changed || changed.has(f)), ...(o.changed ?? []).filter((f) => isCi(f))])];
    if (files.length) {
      const why = [...u.reasons, ...((o.changed ?? []).some((f) => isCi(f)) ? ['CI definitions changed'] : [])];
      return { state: 'altered', command: planned.map((c) => c.command).join(' && '), altered: files, reason: `the candidate changed the check's own inputs (${files.slice(0, 8).join(', ')}${files.length > 8 ? ', …' : ''}: ${why.join('; ')}), so the check cannot judge it; review those changes yourself` };
    }
  }
  const policy = policyForConfig(cfg, dir);
  const base = scrubbedEnv(cfg.shell.scrubEnv);
  const checkHome = makeCheckHome(base.HOME ?? base.USERPROFILE);
  const pycache = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-pycache-'));
  try {
    const env = cleanCheckEnv(base, dir, pycache, checkHome);
    let last: TreeCheckResult = { state: 'unverified', reason: 'no check ran' };
    for (const c of planned) {
      const d = policy.check({ tool: 'bash', kind: 'execute', command: c.command, cwd: dir });
      if (d.decision === 'deny') return { state: 'unverified', command: c.command, reason: `the permission policy refused the check (${d.reason})` };
      if (d.decision === 'ask' && !(o.userGiven && o.commands?.length) && !(o.ask && (await o.ask(c.command, d.reason)))) return { state: 'unverified', command: c.command, reason: `running the check needs approval (${d.reason})` };
      const res = await execCommand({ shellCommand: c.command, cwd: dir, timeoutMs: o.timeoutMs ?? s.checkTimeoutMs, env, signal: o.signal, wrap: commandWrapperFor(cfg) });
      const exitCode = res.timedOut ? null : res.exitCode;
      last = { state: exitCode === 0 ? 'verified' : 'failed', command: c.command, exitCode, output: outputTail(res.output, 3000) };
      if (last.state !== 'verified') return last;
    }
    return last;
  } finally {
    fs.rmSync(pycache, { recursive: true, force: true });
    fs.rmSync(checkHome, { recursive: true, force: true });
  }
}
