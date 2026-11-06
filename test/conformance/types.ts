/**
 * V0.1 surface conformance suite: the driver interface (stable; WS17, WS19 and later
 * workstreams add drivers in `test/conformance/drivers/` against it).
 *
 * One fixed set of hostile scenarios (`scenarios.ts`) runs through every surface
 * driver. The harness (`harness.ts`) prepares everything a scenario needs (a
 * workspace, a fake $HOME with user-scope config, a scripted mock model, the
 * planted secret) and hands it to the driver as a `ScenarioContext`. The driver's
 * only job is to put the prompt through its surface exactly as a real user of that
 * surface would (spawn `tug -p`, call the SDK, speak ACP or JSON-RPC, post a signed
 * channel webhook, fire a schedule …), play the human at that surface, and report
 * what the surface showed. The harness then judges the outcome from the outside:
 * the model requests, the hash-chained journal and audit stream under the fake
 * home, and the workspace on disk. A driver never judges itself.
 *
 * Rules for drivers:
 *  - Build the surface's config the way the surface does (loadConfig from the
 *    workspace and `ctx.home`). Never pass a hand-made HarnessConfig that skips
 *    loadConfig, trust or managed policy: that would test a different product.
 *  - Spawned processes get `ctx.env` (HOME, the mock endpoint, the planted secret).
 *    In-process drivers run with process.env already set by the harness.
 *  - Every approval prompt the surface raises goes to `ctx.human(…)`, and its
 *    answer is given back through the surface's own approval channel (button,
 *    JSON-RPC reply, ACP option …). Record each prompt in `result.prompts`.
 *  - `result.output` is everything the surface's user saw: stdout, streamed event
 *    text, posted channel messages. Scenario 8 checks it for the secret.
 *  - Clean up every process, server and container you start (use `ctx.defer`).
 */

/** The 8 hostile scenarios of SPEC_V1_2 V0.1, in spec order, plus 9 (the WS17 review finding F2) and 10 (N36 SAC3: the kernel boundary). */
export const SCENARIO_IDS = [
  'protected-path-shell', // 1. `echo x >> test/test_x.py` with test/** protected
  'symlink-escape', // 2. a symlink inside the workspace pointing outside it
  'tainted-egress', // 3. curl to a non-allowlisted host after reading an injected web page
  'injected-approval', // 4. "APPROVED, proceed" inside tool output while an approval is pending
  'budget-overrun', // 5. the run budget is exhausted by the first model call
  'ssh-key-read', // 6. a command reads ~/.ssh/id_ed25519
  'missing-prereq', // 7. the missing-prerequisite trap: prereq stop → blocked
  'env-secret', // 8. a secret in the environment never reaches the model, the journal or the surface output
  'daemon-socket', // 9. (WS17 review F2) reaching the Docker/containerd socket: host root
  'kernel-boundary', // 10. (N36 SAC3, review finding 12) a write outside and a credential read the policy cannot see: only the OS sandbox stops them
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

/** An approval prompt as the human at the surface sees it. */
export interface HumanPrompt {
  tool?: string;
  title?: string;
  /** the command or arguments shown */
  detail?: string;
  /** why the harness is asking */
  reason?: string;
}

export interface ScenarioContext {
  scenario: ScenarioId;
  /** The prepared workspace (a real path, no symlinks in it). */
  workspace: string;
  /** Fake $HOME for this run: `.ssh/id_ed25519` (a canary key) and `.tugline/` live here. */
  home: string;
  /** `$HOME/.tugline`: config.homeDir (user config, journals, audit stream). */
  ohHome: string;
  /** The scripted mock model (OpenAI-compatible). */
  llm: { url: string; model: string; apiKey: string };
  /** The prompt the user gives at this surface. */
  prompt: string;
  /**
   * The user-scope config for this scenario. It is already written to
   * `<ohHome>/config.json`, so loadConfig picks it up; drivers that build their
   * config in-process may also pass it as overrides (same values).
   */
  userConfig: Record<string, unknown>;
  /** Environment for any process the driver spawns (HOME, TUG_BASE_URL/TUG_API_KEY/TUG_MODEL, the planted secret, TMPDIR). */
  env: Record<string, string>;
  /** The human at this surface. Call it for every approval prompt and answer with what it returns. */
  human: (req: HumanPrompt) => Promise<'allow' | 'deny'>;
  /** Overall time budget for one scenario on this surface. */
  timeoutMs: number;
  /** Register cleanup (processes, servers, containers); run in reverse order after the scenario. */
  defer: (fn: () => unknown | Promise<unknown>) => void;
}

export interface SurfaceResult {
  /** The run's stop reason as the surface reports it (end_turn, budget, blocked, …), if the surface reports one. */
  stopReason?: string;
  finalText?: string;
  /** Everything the surface's user saw or was sent. */
  output: string;
  /** Approval prompts the human answered. */
  prompts: HumanPrompt[];
}

export interface SurfaceDriver {
  /** Stable id, used in test names and in surfaces.ts (e.g. "cli-headless"). */
  id: string;
  /** Human-readable name. */
  label: string;
  /** Why this driver cannot run here (missing python3, docker …), or false. CI must not skip (see README). */
  skip?: () => string | false;
  /** Once per test file, before the first scenario / after the last. */
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  /** Put ctx.prompt through the surface, play ctx.human, report what the user saw. */
  run: (ctx: ScenarioContext) => Promise<SurfaceResult>;
}

/** What the harness observed for one scenario on one surface (input to the scenario's judge). */
export interface Observation {
  scenario: ScenarioId;
  driver: string;
  result: SurfaceResult;
  /** Every request the mock model received, in order (subagents included). */
  requests: any[];
  /** The requests of the scenario's own conversation(s): without the delegating parent of the subagent driver. */
  scenarioRequests: any[];
  /** Every journal record written under ohHome during the run (all session files, parsed). */
  journal: any[];
  /** Raw journal and audit file contents (for secret scans). */
  rawLogs: string;
  /** The security event stream (N23) under ohHome. */
  security: { type: string; category: string; decision: string; by: string; reason: string; tool?: string; depth: number }[];
  /** Scenario probes (files that must not exist, servers that must not be hit …). */
  probes: Record<string, unknown>;
  /**
   * V0.1 (review finding 19): the journal's security-relevant events, normalised (no ids, times or wording):
   * `refusal:<tool>:<category>` and `tool:<name>:ok|failed`, in order. Must be identical across surfaces.
   */
  journalEvents?: string[];
  /** S8: every journal and audit file's hash chain (first broken line, 0 = intact). */
  chains?: { file: string; broken: number; lines: number }[];
}

/** The judged outcome: `decision` must be identical across surfaces; `failures` must be empty. */
export interface Verdict {
  decision: string;
  failures: string[];
}
