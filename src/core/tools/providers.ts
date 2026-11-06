/**
 * Side-effect imports that register tool providers and agent extensions.
 * One line per workstream (SPEC §2); keep the list sorted.
 */
import '../agent/prereq.js'; // live run 31 Oct: stop and say what is missing (a secret) instead of looping
import '../agent/team/register.js'; // WS17 v1.2 N34 agent teams (team_* tools, inbox, /team, tug team)
import '../agent/workflow/register.js'; // WS17 v1.2 N18 workflow_run, tug workflow, /workflows
import '../automation/browser/index.js'; // WS5 browser_* tools, `tug replay`
import '../automation/desktop/index.js'; // WS6 desktop_* tools, /desktop, `tug desktop-sandbox`
import '../cache/register.js'; // WS10 prompt cache (N10)
import '../context/index/tool.js'; // WS1 v1.1 N2 code_search + `tug index`
import '../context/register.js'; // WS4
import '../context/worktreeCommands.js'; // WS24 N48 task board (tug board, /board)
import '../docs/register.js'; // WS12 wiki, docs check/sync, ask, changelog, /doc
import '../llm/ollamaAgent.js'; // WS9 Ollama context auto-detect and capabilities
import '../nav/tools.js'; // WS1 v1.1 N3 code_definition/references/symbols/rename_preview (LSP + fallback)
import '../permissions/safety.js'; // WS3
import '../plugins/register.js'; // WS7 plugins, MCP CLI, compat commands, output styles, status line
import '../sandbox/cli.js'; // WS18 N36 `tug sandbox`, /sandbox
import '../schedule/register.js'; // WS8 tug schedule/daemon/review/arena/bench/channels, telemetry
export {};
