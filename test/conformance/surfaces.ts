/**
 * V0.1 AC2: the registry of surfaces. Every entry point that can run the agent is a surface, and every surface has
 * a conformance driver (drivers/<id>.ts). `DISCOVERY` finds surface modules on disk: a module that matches a pattern
 * and is not listed here (as a surface or as infrastructure, with the reason) fails registry.test.ts, so a new
 * channel adapter, SDK, server front-end or executor cannot land without its driver.
 *
 * Adding a surface: add its module(s) to SURFACES with the driver id, and add test/conformance/drivers/<id>.ts.
 */
export interface SurfaceEntry {
  /** the driver id (a file in drivers/ exports a SurfaceDriver with this id) */
  driver: string;
  /** repository-relative module paths that implement the entry point; a path ending in "/" is a directory (any file in it) */
  modules: string[];
  /**
   * A surface another workstream is adding: no problem while none of its modules exist; the moment one lands, the
   * driver is required like any other.
   */
  planned?: string;
  note?: string;
}

export const SURFACES: SurfaceEntry[] = [
  { driver: 'cli-headless', modules: ['src/cli/main.ts'] },
  { driver: 'sdk-ts', modules: ['src/sdk/index.ts'] },
  { driver: 'sdk-python', modules: ['sdk/python/tugline_client.py'] },
  { driver: 'acp', modules: ['src/acp/agent.ts', 'src/acp/cli.ts'] },
  { driver: 'serve-jsonrpc', modules: ['src/server/server.ts', 'src/server/sessions.ts', 'src/server/rpc.ts'] },
  { driver: 'remote-job', modules: ['src/server/remote.ts'] },
  { driver: 'channel-telegram', modules: ['src/channels/telegram.ts'] },
  { driver: 'channel-slack', modules: ['src/channels/slack.ts'] },
  { driver: 'channel-webhook', modules: ['src/channels/webhook.ts'] },
  { driver: 'scheduler', modules: ['src/core/schedule/run.ts', 'src/core/schedule/daemon.ts', 'src/core/schedule/webhook.ts', 'src/core/schedule/intake.ts', 'src/core/schedule/cli.ts'], note: 'cron, file watches, webhooks and GitHub events all start runs through runScheduled' },
  { driver: 'subagent', modules: ['src/core/agent/agent.ts'], note: 'runSubagent (task tool)' },
  // v1.2 wave 1 surfaces added by other workstreams (their drivers live in drivers/ on their branches)
  { driver: 'teammate', modules: ['src/core/agent/team/'], planned: 'N34 (WS17): drivers/teams.ts' },
  { driver: 'workflow-item', modules: ['src/core/agent/workflow/'], planned: 'N18 (WS17): drivers/teams.ts' },
  // v1.2 WS24 (N45/N47/N48/N49): drivers/vscode-host.ts, arena-contestant.ts, board-card.ts, cli-batch.ts
  { driver: 'vscode-host', modules: ['vscode/src/chat.ts'], note: 'N45: the real extension host under @vscode/test-electron (Xvfb); the chat view sends the prompt and answers approvals through the VS Code UI path' },
  { driver: 'arena-contestant', modules: ['src/core/eval/arena.ts'], note: 'N47: the scenario runs as an arena contestant in its own worktree (a bystander contestant alongside); the winner is applied through the board merge' },
  { driver: 'board-card', modules: ['src/core/context/worktreeBoard.ts'], note: 'N48: the scenario runs as a board card agent in its worktree, then the card is merged through Board.merge' },
  { driver: 'cli-batch', modules: ['src/cli/batch.ts'], note: 'N49 (review F13): `tug batch run` starts one headless session per plan item' },
];

/**
 * Modules under the discovery patterns that are not entry points, with the reason. Anything else that matches a
 * pattern must be a surface with a driver.
 */
export const INFRASTRUCTURE: Record<string, string> = {
  'src/channels/gateway.ts': 'shared by every channel adapter (each adapter has its own driver)',
  'src/channels/pairing.ts': 'pairing store used by the gateway',
  'src/channels/types.ts': 'types',
  'src/channels/cli.ts': '`tug channels` command: starts the adapters, which have drivers',
  'src/channels/crypto.ts': 'signature helpers for adapters (WS19)',
  'src/server/client.ts': 'the TS client used by the SDK and remote drivers',
  'src/server/protocol.ts': 'types',
  'src/server/tokens.ts': 'server token store',
  'src/server/register.ts': 'command registration',
  'src/server/cli.ts': '`tug serve` command: starts server.ts (driver serve-jsonrpc)',
  'src/acp/host.ts': 'ACP file-system host used by acp/agent.ts',
  'sdk/python/test_tugline_client.py': 'tests of the Python SDK',
  'sdk/python/test_automode.py': 'tests of the Python SDK (N43 auto mode)',
  'src/core/schedule/cron.ts': 'cron expression parser',
  'src/core/schedule/heartbeat.ts': 'daemon liveness file',
  'src/core/schedule/parked.ts': 'parked-wait store; resumed runs go through intake.ts / run.ts (driver scheduler)',
  'src/core/schedule/register.ts': 'command registration',
  'src/core/schedule/report.ts': 'the morning report (reads journals, starts no run)',
  'src/core/schedule/service.ts': 'writes the launchd / systemd unit that starts `tug daemon` (driver scheduler)',
  'src/core/schedule/store.ts': 'schedule and trigger store',
  'src/core/schedule/types.ts': 'types',
  // WS24 (N49): parts of the `tug` CLI (driver cli-headless) that start no agent run of their own
  'src/cli/completion.ts': 'shell completion scripts (tug completion)',
  'src/cli/flags.ts': 'loosening-flag warnings, journaling and managed refusals for main.ts (driver cli-headless)',
  'src/cli/output.ts': 'headless output schema and redaction for main.ts (driver cli-headless)',
  'src/cli/sessions.ts': 'saved-session store (list, rename, export); starts no run',
  'src/cli/slash.ts': 'slash commands run inside a cli-headless / REPL session (no new entry point)',
  'src/cli/theme.ts': 'terminal colours',
  'src/cli/vim.ts': 'vim keys for the REPL prompt',
  'src/cli/certs.ts': 'OS certificate store trust at CLI start',
  'src/cli/runtimeLog.ts': 'the CLI runtime log and `tug doctor fix|log` (starts no run)',
  'src/cli/attach.ts': '`tug attach`: a client of `tug serve` (the session runs there: driver serve-jsonrpc)',
  'src/cli/memoryCli.ts': '`tug memory`: lists and imports memory records (starts no run)',
};

/**
 * Surfaces that exist in the repository but whose driver belongs to another v1.2 item (they need a harness that item
 * builds). Each is named in docs/ws/WS18-NOTES.md and reported to the orchestrator; registry.test.ts prints them.
 */
export const DEFERRED: Record<string, string> = {
  // vscode/src/chat.ts was deferred to N45 (WS24); its driver is drivers/vscode-host.ts (registered in SURFACES)
};

/**
 * Where surfaces live, today and for the v1.2 items still to land (web UI N37, desktop N38, Java SDK
 * N39, JetBrains N40, teams N34, workflows N18, identity N42, SSH R11, managed pool N7).
 */
export const DISCOVERY: RegExp[] = [
  /^src\/channels\/[^/]+\.ts$/,
  /^src\/acp\/[^/]+\.ts$/,
  /^src\/server\/[^/]+\.ts$/,
  /^src\/server\/(?:identity|pool)\/[^/]+\.ts$/,
  /^src\/sdk\/[^/]+\.ts$/,
  /^sdk\/[^/]+\/[^/]+\.(?:py|java|kt|ts)$/,
  /^sdk\/java\/.*\.java$/,
  /^src\/core\/host\/ssh[^/]*\.ts$/,
  /^src\/core\/agent\/(?:team|workflow)\/[^/]+\.ts$/,
  // review finding 18: every module under schedule/ and cli/ (a new trigger source or a second CLI entry point)
  /^src\/core\/schedule\/[^/]+\.ts$/,
  /^src\/cli\/[^/]+\.ts$/,
  /^vscode\/src\/chat\.ts$/,
  /^desktop\/.*\.(?:ts|rs)$/,
  /^jetbrains\/.*\.(?:kt|java)$/,
  /^web\/.*\.(?:ts|tsx)$/,
];

/** What is wrong with the registry for these repository files and driver ids (empty = fine). */
export function registryProblems(files: string[], driverIds: string[], surfaces = SURFACES, infra = INFRASTRUCTURE, deferred = DEFERRED): string[] {
  const out: string[] = [];
  const present = (m: string) => (m.endsWith('/') ? files.some((f) => f.startsWith(m)) : files.includes(m));
  const covers = (m: string, f: string) => (m.endsWith('/') ? f.startsWith(m) : f === m);
  for (const s of surfaces) {
    const exists = s.modules.filter(present);
    if (s.planned && !exists.length) continue; // not landed yet
    if (!driverIds.includes(s.driver)) out.push(`surface ${s.modules.join(', ')} has no driver "${s.driver}" in test/conformance/drivers/`);
    for (const m of s.modules) if (!present(m)) out.push(`surface module ${m} (driver ${s.driver}) does not exist: update surfaces.ts`);
  }
  for (const f of files) {
    if (!DISCOVERY.some((re) => re.test(f))) continue;
    if (surfaces.some((s) => s.modules.some((m) => covers(m, f))) || f in infra || f in deferred) continue;
    out.push(`${f} looks like a surface (it matches the discovery patterns) but has no conformance driver: add it to SURFACES with a driver, or to INFRASTRUCTURE with the reason`);
  }
  return out;
}
