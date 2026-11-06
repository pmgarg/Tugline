# Tugline user guide

This guide is task-oriented. Each section says how to do something, which command or setting does it, and what the default is. The [configuration reference](#configuration-reference) at the end lists every key.

Contents
1. [Install and connect a model](#1-install-and-connect-a-model)
2. [Use the CLI](#2-use-the-cli)
3. [`tug` subcommands](#3-oh-subcommands)
4. [Slash commands](#4-slash-commands)
5. [Permissions, trust and safety](#5-permissions-trust-and-safety)
6. [Editing](#6-editing)
7. [Agent features](#7-agent-features)
8. [VS Code](#8-vs-code)
9. [Browser automation](#9-browser-automation)
10. [Desktop automation](#10-desktop-automation)
11. [Editors, server, SDK, MCP and plugins](#11-editors-server-sdk-mcp-and-plugins)
12. [Schedules, webhooks, channels, review and telemetry](#12-schedules-webhooks-channels-review-and-telemetry)
13. [Evaluation](#13-evaluation)
14. [Documentation: wiki, docs checks, Q&A, changelog](#14-documentation-wiki-docs-checks-qa-changelog)
15. [What is off by default, and why](#what-is-off-by-default-and-why)
16. [Configuration reference](#configuration-reference)
17. [Files and environment variables](#files-and-environment-variables)

---

## 1. Install and connect a model

```bash
npm install && npm run build && npm link   # Node >= 20. Installs `tug` and `tugline`.
tug setup                                   # base URL, API key, model; probes tool calling
tug doctor                                  # endpoint, tool mode, ripgrep, Playwright, search, MCP, skills
tug models                                  # models the endpoint serves
```

**Before the first run: check whether your commands are sandboxed.** The default is `shell.sandbox: "auto"`, which picks an OS sandbox when one works on your machine: bubblewrap on Linux, Docker if you choose it. On macOS it stays off (`none`) until the Seatbelt device check (`bash scripts/device-checks/sandbox-macos.sh`) has passed on that Mac. The check records `~/.tugline/device-checks/sandbox-macos.pass`; `sandbox.macosSeatbelt: true` opts in without it. With no sandbox, every shell command the agent runs (after your approval, after the classifier's in `auto` mode, or without either in `yolo` mode) runs as you, with your files and your network. The permission engine and protected paths decide *whether* a command runs; only the sandbox confines what it does. `tug doctor`, the CLI banner and the run-start notice show which sandbox is active. For unattended or company runs set `"shell": { "requireSandbox": true }`: commands then fail closed when no sandbox is available ([§5](#os-sandbox)). This is already the default for scheduled, daemon and remote runs.

`tug setup` writes a profile to `~/.tugline/config.json` (mode 0600). `tug setup` and `tug doctor` cache the probe result in `~/.tugline/capabilities.json`, so later runs start in the right tool mode.

**Profiles.** A profile is one model endpoint. You can keep several and switch with `--profile <name>`, `TUG_PROFILE`, or `/model <name>`.

```jsonc
{
  "profile": "company",
  "smallProfile": "company-small",           // cheaper model for summaries, web extraction, explore subagents
  "profiles": {
    "company": {
      "baseUrl": "https://llm.corp.example/v1",
      "apiKey": "env:CORP_LLM_KEY",          // "env:NAME" reads the key from that variable
      "model": "qwen3-coder-30b",
      "contextWindow": 65536,
      "maxOutputTokens": 8192,
      "toolMode": "auto",                    // auto | native | text
      "headers": { "X-Team": "platform" },
      "pricing": { "inputPerM": 0.15, "outputPerM": 0.6 }
    },
    "company-small": { "baseUrl": "https://llm.corp.example/v1", "apiKey": "env:CORP_LLM_KEY", "model": "qwen3-8b" }
  }
}
```

**Ollama.** Ollama runs a model with the context set in the app (**Settings → Context length**; 4K by default on machines with less than 24 GB of VRAM), `OLLAMA_CONTEXT_LENGTH`, or a Modelfile `num_ctx`. When a prompt is longer, Ollama silently drops its start, the system prompt and tool schemas first. Tugline detects this itself:

- For an Ollama endpoint it asks `POST /api/show` (the model's maximum context, any `num_ctx`, and its capabilities) and, after the first request, `GET /api/ps` (the context the loaded model really has, which reflects the app setting).
- The budget becomes **min(`contextWindow`, Ollama's context)**, with one notice such as *"Ollama is running qwen3:8b with a 16384-token context; using that (raise it in Ollama → Settings → Context length)"*. A `contextWindow` smaller than Ollama's is kept.
- `toolMode: "auto"` becomes `native` when the model has the `tools` capability and `text` when it doesn't; `vision` is switched on for models with `vision`. An explicit `toolMode` (`native`/`text`) is never changed.
- Results are cached per base URL and model in `~/.tugline/capabilities.json`. `/api/ps` is re-read once per session, because you can change the app setting at any time.
- An endpoint counts as Ollama when it is on port 11434, when its replies carry Ollama's `fp_ollama` fingerprint, or when the cache says so. Other servers never get an `/api/*` request. For Ollama behind a proxy on another port, set `"ollama": { "detect": "always" }`; `"detect": "off"` disables all of this.

Use at least 16K, and 32K or more if you have the memory: the app setting, `launchctl setenv OLLAMA_CONTEXT_LENGTH 32768` on macOS (then restart the app), or a Modelfile with `PARAMETER num_ctx 32768`. Check with `ollama ps`. `scripts/test-ollama.sh` handles this for you (see [§13](#13-evaluation)).

**Ollama in VS Code: mouse-only setup.** If the endpoint does not answer, or the configured model is not installed (the default `qwen3-coder:30b` often isn't), the chat panel shows a setup card, on first start and on **Test connection**:
- *Can't reach …*: a button for each local server that answers (Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`). A click sets `tugline.baseUrl` and lists that server's models.
- *Model … isn't installed*: a button per installed chat model, tool-capable coder models first (from Ollama's capabilities; by name for other servers), with tools/vision/thinking badges. Embedding-only models such as `nomic-embed-text` and `bge-m3` are left out. A click sets `tugline.model` (user settings) and re-tests the connection, which also reports the context Ollama gives the model.
- **Retry**, **Other endpoint…** (the keyboard wizard, for company or custom URLs) and **Dismiss**.

VS Code settings only override `~/.tugline/config.json` and project config for keys you actually set; unset settings no longer apply their defaults over your config files.

**llama.cpp.** Start `llama-server` with `--jinja` so native tool calls work, and pass `-c` and `--port`.

**Models without tool calling** work: `toolMode: "auto"` switches to the text protocol when the server rejects tools. Force it with `--text-tools` or `toolMode: "text"`.

---

## 2. Use the CLI

```bash
tug                                 # interactive session in the current directory
tug -p "fix the failing test"       # headless: progress on stderr, answer on stdout
echo "$LOG" | tug -p "explain this" # piped stdin is appended to the prompt
tug --auto -p "…"                   # auto mode: a safety classifier approves routine commands
tug -y -p "…"                       # yolo mode: no prompts, no classifier (was "auto" before v1.2)
tug --continue                      # resume the latest session; --resume <id> picks one
```

Headless runs exit 0 when the run ends normally (`end_turn`) and 1 otherwise. In headless runs there is no one to answer, so every "ask" becomes a recorded denial.

**Flags** (`tug --help`):

| Flag | Meaning |
|---|---|
| `-p, --print "<prompt>"` | run once headless and print the result |
| `--base-url <url>` / `--api-key <key>` / `--model <name>` | override the active profile |
| `--profile <name>` | use a profile from config |
| `--ctx <tokens>` | context window of the model (default 32768) |
| `--max-output <tokens>` | max tokens per reply (not listed in `--help`) |
| `--mode <ask\|acceptEdits\|plan\|auto\|yolo>` | permission mode (default `ask`) |
| `--auto` | same as `--mode auto` (safety classifier) |
| `--yolo`, `-y, --yes`, `--mode yolo` | no prompts, no classifier: warned, journaled, refused (exit 2) under a managed `disableAutoMode` or `disableYoloMode` (for `tug board` / `tug arena`, `--yes` only confirms their merge step) |
| `--cwd <dir>` | workspace directory |
| `--text-tools` / `--native-tools` | force the text protocol / native tool calls |
| `--compact-prompt` | shorter system prompt for small models |
| `--allowlist` | run commands without a shell, allowlisted programs only |
| `--validate` | run an independent validator subagent before finishing |
| `--max-turns <n>` | maximum agent turns per prompt |
| `--resume <id>` / `--continue` | resume a saved session / the latest one |
| `--json` | print events as JSON lines (headless) |
| `--verbose` | show tool progress in `tug eval` (not listed in `--help`) |
| `--no-mcp` | do not start MCP servers |
| `--trust` | trust this workspace's project config (see [§5](#workspace-trust)) |
| `--acp` | speak the Agent Client Protocol on stdio (same as `tug acp`) |
| `-h, --help` / `-v, --version` | help / version |

**Mentions.** In the CLI and in `-p`, `@path` attaches a file, `@file:10-40` a line range, and `@dir/` a folder listing. Mentions are read through the permission engine: secret files and paths outside the workspace are not attached, and you get a note.

**Cancelling.** Ctrl+C during a run cancels it. Ctrl+C twice within 2 seconds also pulls the automation kill switch (browser and desktop tools stop until `/desktop resume`). Ctrl+C twice when idle quits.

**Status line.** If `statusLine.command` is set, its output is shown above each prompt (see [§11](#output-styles-and-status-line)).

---

### Headless output, sessions and the REPL (v1.2)
- `--output-format json` prints one result document (`type: "result"`, `session_id`, `ok`, `stop_reason`, `result`, `completion`, `stats`, `files_changed`, `permission_denials`); `stream-json` (or `--json`) prints JSON lines: an `init` line, every agent event, then the result. Schema: `docs/schemas/headless-output.schema.json` (version 1).
- `--input-format stream-json` reads `{"type":"user","text":"…"}` lines from stdin, one turn each, in one session. `--input-file task.md` reads the prompt from a file; piped stdin is attached to `-p` as `<stdin>`.
- `--session-id <id>`, `--continue`, `--resume <id>`, `--fork-session` (resume into a new id). `tug sessions list|show <id>|export <id> --format md|html|json [--out f]|rename <id> <title>|delete <id>`.
- Limits for unattended runs: `--max-wall-time <s>` (`-t`), `--max-tool-calls <n>`. Narrowing: `--allowed-tools a,b`, `--exclude-tools a,b`, `--allowed-mcp-server-names a,b`. Widening (your decision): `--include-directories a,b`.
- `--system-prompt <text|@file>` replaces the role line of the system prompt and `--append-system-prompt` adds instructions; the harness's safety rules always stay. `--output-style`, `--effort off|low|medium|high`, `--plan`.
- `--yolo` (= `--mode yolo`, also spelled `-y`, `--yes`), `--no-sandbox`, `--include-directories`, `--mcp-config` and `--hooks-dir` print a warning, are written to the journal and the security events, and the first two are refused (exit 2, a typed error, never silently clamped) when your organisation's managed policy has `disableAutoMode` or `disableYoloMode` / `forceSandbox`.
- MCP and hooks: `--mcp-config <file>` adds the servers in a `{"mcpServers": …}` file to yours (a server you already have keeps your definition; a `"trusted"` field in the file is ignored, so their tools ask until you trust the server yourself; managed `allowMcpServers` still filters), `--disable-mcp-server a,b` leaves some out, `--hooks-dir <dir>` adds the hooks in `<dir>/hooks.json` to yours (per event, never replacing them; a directory inside the workspace needs the same approval as project hooks, `/hooks approve`), `--disabled-slash-commands a,b` switches REPL commands off.
- Headless output (text, json, stream-json, streamed chunks included) goes through the journal's secret redaction. Wrong flag values print the message (exit 2), not a stack trace.
- Certificates: the OS certificate store is trusted together with Node's roots and `NODE_EXTRA_CA_CERTS` (corporate TLS proxies, internal endpoints); `--no-system-ca` or `"cli": {"systemCa": false}` turns it off; `tug doctor` shows whether it is trusted. Runtime log: `~/.tugline/logs/oh.log` (`TUG_LOG_ENABLED=0`, `TUG_LOG_LEVEL=error|warn|info|debug|silent`, `TUG_LOG_PATH`), secrets redacted.
- `--theme dark|light|high-contrast|none` (`/theme`, `"cli": {"theme": …}`; NO_COLOR and `--screen-reader` give plain text), `--vim` (`/vim`, `"cli": {"vim": true}`), a trailing `\` continues a prompt on the next line, `/fork`. `tug completion bash|zsh|fish`, `tug config [show|get <key>|path]` (secrets redacted), `--home <dir>` (instead of `~/.tugline`), `tug version`.

## 3. `tug` subcommands

| Command | What it does |
|---|---|
| `tug setup` | configure the endpoint (base URL, API key, model) and probe it |
| `tug doctor` | diagnose the endpoint, tool calling and optional tools |
| `tug doctor fix` \| `tug doctor log` | remove stale leases, board locks, a dead server's `server.json` and leftover worktrees (never kills a process) · the runtime log's path and last lines |
| `tug attach [<session>] [--server ws://… --token T]` | join a session running in `tug serve`: stream it, send prompts, answer its approvals; Ctrl+D detaches |
| `tug batch run <plan.json> [--dry-run] [--expect <digest>] [--parallel N]` \| `status\|retry\|cancel\|clean <task>` \| `check` | one task over many items (`{"prompt": "… {{source}} → {{target}}", "items": [{"id","source","target"}]}`); a ledger in `~/.tugline/batch/` is written before anything runs; `retry` reruns failed items only |
| `tug memory list [--scope user\|project]` \| `tug memory import codex [--source dir] [--select 1,3\|all]` | durable memory records; import Codex memories (preview unless you select items) |
| `tug models` | list models at the endpoint |
| `tug sessions` | list saved sessions for this workspace |
| `tug goal "<condition>" [--check CMD] [--verify] [--max-turns N] [--max-tokens N] [--json]` | work toward a goal headless (exit 0 when met) |
| `tug team run <team.json> [--resume <.tugline/teams/dir>]`, `tug team watch <teamId> [--tmux]` | run an agent team from a file, headless; watch its members (display only) |
| `tug team host <.tugline/teams/dir> --name <host> [--lease-ms N] [--max-tasks N]` | pick up ready tasks from a team board under a renewed lease (a second process or machine sharing the directory) |
| `tug team a2a grant <caller> [--workspace d] [--agent t] [--tools a,b] [--mode m] [--max-tokens N]`, `tug team a2a list`, `tug team a2a revoke <id>` | per-caller grants for A2A inbound (`a2a/delegate` on `tug serve`); the secret is shown once |
| `tug workflow run <file.json\|name> [--resume <runId>] [--json]`, `tug workflow list`, `tug workflow show <runId>` | run a declarative workflow, list saved workflows and runs |
| `tug eval <suiteDir> [--arms a,b] [--repeats N] [--tasks t1,t2] [--out dir] [--verbose]` | run an eval suite ([§13](#13-evaluation)) |
| `tug rescore <outDir>` | re-score saved eval runs without calling a model |
| `tug acp` | Agent Client Protocol on stdio (Zed, JetBrains, Neovim) |
| `tug sandbox status [--json] \| verify \| run -- <cmd> \| trust-project [dir] [--revoke]` | what the sandbox enforces and why; probe it; run one command confined; let a workspace's config loosen it ([§5](#os-sandbox)) |
| `tug --container [docker\|podman] …` | run the whole session in a container ([§5](#whole-session-container-mode)) |
| `tug serve [--port N] [--stdio] [--remote] [--allow-local-repos] [--with-daemon]` | local JSON-RPC server ([§11](#server-mode)) |
| `tug remote run --server <ws-url> [--token T] [--repo URL] [--branch B] [--mode M] [--yes\|--no-apply] [--patch-file f] "<prompt>"` | run on a remote `tug serve`, apply the patch locally |
| `tug mcp search <query> \| login <server> \| logout <server> \| list` | MCP registry, OAuth login, list servers |
| `tug plugin install <src> [--trust] [--ref <branch>]` | install a plugin from a path, git URL or `name@marketplace` |
| `tug plugin list \| info <name> \| remove <name> \| enable <name> \| disable <name>` | manage installed plugins |
| `tug plugin trust <name> [--yes] \| untrust <name>` | allow or stop a plugin's hooks and MCP servers |
| `tug plugin marketplace add <src> \| list \| remove <name>` | manage marketplaces |
| `tug usage [--since YYYY-MM-DD\|Nd\|today] [--json]` | spend and tokens per day and per model |
| `tug replay <runDir> [--check] [--heal] [--export f.spec.ts] [--recipe name [--match urlPrefix]] [--html [out.html]]` | replay, check, heal, export or report a browser run |
| `tug desktop-replay <runDir> [--check]` | strictly replay a recorded desktop run |
| `tug desktop-sandbox up [--build] \| down \| status` | the Docker Linux desktop |
| `tug emergency-stop [--clear]` | stop all automation in every process (writes `~/.tugline/STOP`) |
| `tug schedule add … \| list [--json] \| remove <id> \| run-now <id> [--force] \| enable <id> \| disable <id> \| waits [<id>] \| cancel <handle> \| secret <id> \| report [--since 24h\|7d\|ISO] \| status \| install-service [--print] [--port N]` | scheduled tasks and triggers ([§12](#schedules-and-triggers)) |
| `tug lease status [--all] [--json] \| break [--workspace dir]` | who is writing in a workspace (sessions, schedules, jobs) |
| `tug daemon [--port N] [--no-listen]` | run the scheduler; webhooks on 127.0.0.1:7880 only (see [§12](#schedules-and-triggers)) |
| `tug channels pair <telegram\|slack\|webhook> [--owner] \| list \| unpair <channel> <userId> \| token <secret-name> \| start [--port N]` | chat channels ([§12](#channels)) |
| `tug review [--base main] [--format markdown\|github\|json] [--out report.md] [--json-out f.json] [--fail-on high\|medium\|low\|none]` | read-only review of `git diff <base>...HEAD` |
| `tug arena --models a,b[,c] "<prompt>" [--check "<cmd>"] [--judge profile] [--mode acceptEdits\|auto\|yolo] [--out report.md] [--discard]` | compare models on one task |
| `tug arena --models a,b --suite <evalSuiteDir> [--repeats N] [--out dir]` | compare models on an eval suite |
| `tug index status \| update \| rebuild \| eval [queries.json] [--out dir]` | the local code-search index ([§7](#7-agent-features)); `eval` measures file localisation, BM25 vs hybrid |
| `tug index eval-repos [--dataset multilingual\|lite\|<hf id>] [--repos owner/a,owner/b] [--per-repo N] [--rows f.jsonl] [--cache dir] [--out dir]` | file localisation on real repositories (SWE-bench issues → gold-patch files): repo map vs navigation vs BM25 vs hybrid (with an embedder) vs fused; clones into `~/.tugline/eval-repos` |
| `tug bench terminal-bench\|swe-bench\|swe-bench-pro [--subset N] [--repeats N] [--arm default\|bash-only\|all\|cline\|aider\|openhands\|codex\|mini-swe-agent,…] [--isolation docker\|host] [--image name] [--network bridge\|none] [--gpu-share x] [--data path] [--fetch] [--out dir]`; `tug bench terminal-bench --harbor …`; `tug bench --compare <dirs>` | public benchmark subsets, each task in its own container when Docker is reachable; other agents as arms; the paired report |
| `tug wiki build [--force] [--out dir] \| update \| serve [--port 8765] [--mermaid <script-url>] \| check \| judge [--judge profile] [--min 4]` | a cited codebase wiki written by your model ([§14](#14-documentation-wiki-docs-checks-qa-changelog)) |
| `tug docs check [--format text\|github\|json] [--cli "<help argv>"] [files…]` | docs-as-code checks, no model; exit 1 on problems |
| `tug docs sync [--base main] [--patch out.patch \| --pr] [--dry-run]` | the doc-sync agent: update docs a code change made stale |
| `tug review --checks [dir] [--base main] [--format text\|github]` | run `.tugline/checks/*.md` rules as status checks |
| `tug ask "<question>" [--json] [--k 8]` | answer from code, docs and wiki with validated citations, or "not found" (exit 3) |
| `tug changelog --since <tag> [--until HEAD] [--format keepachangelog\|github] [--version X] [--summarize] [--repo-url URL] [--out CHANGELOG.md]` | release notes from git history |
| `tug doc <file>[:<line>\|#<symbol>] [--all] [--dry-run] [-y]` | add or refresh docstrings (only comment/docstring bytes change) |

Run a subcommand with no arguments (for example `tug schedule` or `tug channels`) to see its full usage.

---

## 4. Slash commands

Type these in the interactive CLI. `/help` lists them all, including commands added by plugins, markdown command files and MCP prompts.

**Built in**

| Command | What it does |
|---|---|
| `/help` | list commands |
| `/mode <ask\|acceptEdits\|plan\|auto\|yolo>` | change the permission mode (resets auto mode's denial counters) |
| `/auto [status\|resume]` | auto mode: show the denial counters and ignored allow rules; resume after a suspension |
| `/permissions [add\|remove <allow\|ask\|deny> <rule> [--project]]` | list every permission rule with its source (managed, user, project, session) and what auto mode ignores; add or remove a rule in your user config, or with `--project` in `.tugline/config.local.json` (also in the VS Code chat) |
| `/model [profile]` | show or switch the model profile |
| `/models` | list models at the endpoint |
| `/cost` | tokens and cost for this session |
| `/todos` | the task list |
| `/tools`, `/skills`, `/mcp` | what the agent can use |
| `/compact [focus]` | compact now, optionally with a focus for the summary |
| `/clear` | start a fresh conversation |
| `/sessions`, `/resume <id>` | list or load saved sessions |
| `/init` | ask the agent to write `AGENTS.md` for this project |
| `/<skill-name> [args]` | run a skill explicitly |
| `/exit`, `/quit` | quit |

**Added by modules**

| Command | What it does |
|---|---|
| `/checkpoints [count]` | list checkpoints (taken before each turn and shell command) |
| `/rewind [n\|id] [files\|chat\|both]` | restore files and/or the conversation; `n` turns back (0 = latest) or a checkpoint id; default `both` |
| `/undo [n\|all]` | revert the file changes of the last n prompts, shell edits included (uses checkpoints; falls back to the v0.1 edit history when checkpoints are off) |
| `/context` | what fills the context window (system prompt, tools, history, attachments) |
| `/cache` | prompt-cache hit rate, server/slot settings, the last prefix break and its cause |
| `/goal <condition> [--check "<command>"] [--verify] [--max-turns N] [--max-tokens N]` | keep working until the check passes ("verified") or, without `--check`, an independent verifier judges it met ("judged met"); `/goal status | pause | resume | clear` |
| `/team <goal>` | run the goal with an agent team; `/team status`, `/team msg <member> <text>`, `/team stop <member>`, `/team disband` |
| `/workflows [show <runId>]` | list workflow runs of this project |
| `/tasks [resume <handle>]` | background subagents: running ones, and interrupted ones you can resume |
| `/jobs [log <id> \| kill <id>]` | background jobs of this session |
| `/memory [add [--user] <text>]` | show memory, or add a memory yourself |
| `/hooks [approve [all\|n]]` | list hooks, approve project hooks |
| `/usage [--since YYYY-MM-DD\|Nd]` | spend and tokens per day and model, and the active limits |
| `/output-style [style]` | show or set the output style |
| `/statusline [approve]` | show the status-line command; approve a project-defined one |
| `/plugins` | installed plugins and their trust state |
| `/browser [stop\|resume\|secrets\|secret <name>]` | browser status, kill switch, stored secrets |
| `/desktop [stop\|resume]` | desktop status and kill switch |
| `/mcp:<server>:<prompt> [k=v …]` | run an MCP server's prompt (one command per prompt) |
| `/ask <question>` | answer from the code, docs and wiki with validated citations ([§14](#ask-the-codebase)) |
| `/doc <file>[:<line>\|#<symbol>] [--all] [--dry-run]` | add or refresh docstrings in the native style, as a reviewed edit ([§14](#docstrings-and-release-notes)) |
| `/<name> [args]` | markdown commands from `.tugline/commands`, `.claude/commands`, `~/.tugline/commands`, `~/.claude/commands` (subfolders become `ns:name`; `$ARGUMENTS` and `$1…$9` are substituted; Claude Code's "!`cmd`" shell interpolation is not executed) |

The same registry serves `tug serve` clients through `session/command`, and the VS Code chat box dispatches these commands too.

---

## 5. Permissions, trust and safety

### Permission modes

| Mode | read | edit | execute | network | MCP |
|---|---|---|---|---|---|
| `ask` (default) | allow | ask | ask | ask | ask |
| `acceptEdits` | allow | allow | ask | allow | ask |
| `plan` | allow | deny | deny | allow | ask |
| `auto` | allow | fast path¹ | classifier² | classifier² | classifier² |
| `yolo` | allow | allow | allow | allow | allow |

¹ in-workspace edits that are not self-modification files; ² see [Auto mode](#auto-mode) below. Read-only shell commands (`ls`, `git status`, `grep -rn x src`) take the fast path too.

`acceptEdits` allows edits, except edits to self-modification files (`package.json`, `Makefile`, CI files, `.envrc`, git hooks, the agent's own config and instructions; the list is in [Auto mode](#auto-mode)): those ask, because they change the agent or run code later. An explicit allow rule without wildcards for that file (`edit_file(package.json)`) lifts it. Subagents and teammates can never get a broader mode than their parent; `auto` and `acceptEdits` count as not comparable (each allows something the other asks for), so neither can be chosen under the other.

Set it with `--mode`, `--auto`, `--yolo` (or `-y`), `/mode`, `permissionMode` in your user config, `TUG_PERMISSION_MODE`, the VS Code toolbar, `tug serve` (`session/create {mode}`, `config/set permissionMode`), ACP's mode picker, or the SDKs (`createAgent({ permissionMode })`, Python `create_session(mode=…)` / `set_mode`). A project's `.tugline/config.json` can only choose a stricter mode (`ask`, `plan`), never `acceptEdits`, `auto` or `yolo`, even in a trusted workspace.

**Migrating from v1.1.** `auto` used to mean "run without asking, except dangerous commands". That mode is now called **`yolo`**, and `auto` is the classifier mode below. A config that says `"permissionMode": "auto"` now gets the safer classifier mode (a notice says so once); write `"yolo"` to keep the old behaviour. `-y`/`--yes` keeps its old meaning and now selects `yolo`. Benchmarks (`tug eval`, Harbor) run in `yolo` in their throwaway checkouts. `yolo` prints a warning on every start and on every switch; managed policy can forbid it.

Some things ask in every mode, including `auto` and `yolo`:
- dangerous commands: `git push`, recursive deletes of root/home/parent/system dirs, `sudo`, downloads piped into interpreters, `git reset --hard`, `git clean -f`, package publishing, disk tools;
- writes to agent-control files: `.mcp.json`, `.vscode/**`, `.tugline/**`, `.claude/**`, `AGENTS.md`/`CLAUDE.md`, `.github/**`, git hooks, `.envrc`;
- reads of secret files (`.env`, `*.pem`, `id_rsa*`, `.ssh/**`, `.aws/**`) and of `.tuglineignore`-d paths;
- `remember` into user memory;
- desktop actions on apps that are not auto-approved.

Some things are always refused: writes to protected paths (always `.git/**`, `.tugline/config*.json`, `.mcp.json`, plus your `permissions.protectedPaths`), writes outside the workspace (after symlink resolution), and edits in plan mode.

Protected paths hold for shell commands too, in up to four layers:
1. **Before a command runs**, its write targets are read from the command itself: redirections (`>`, `>>`, `&>`), `tee`, `cp`/`mv`/`install`/`ln`/`rsync` destinations, `sed -i`/`perl -i`, `truncate`, `touch`, `rm`/`unlink`, `git checkout|restore -- <path>`, `dd of=` and `curl -o`. Quoting tricks and `sudo`/`env`/`nice`/`timeout` prefixes don't hide them.
   - A target that is protected, or an agent-control file (`.github/**`, `.vscode/**`, `AGENTS.md`, …), is refused in every mode. So is removing a directory that contains one (`rm -rf tests`, `mv tests tests.bak`).
   - A write outside the workspace asks, even in `auto` and `yolo` modes. `/tmp` and the system temp dir are fine.
2. **Around every command** (and while background jobs run), the protected set is fingerprinted. If anything in it changed, the harness restores it from a pre-command copy, records a refusal and tells the model its command failed. A background job that does this is killed. This catches what the first layer can't see (`python -c`, scripts).
   - Git's own state under `.git/` (objects, refs, index) is exempt, so `git commit` works; `.git/hooks` and `.git/config` are watched.
   - While a session is open, a protected change is **never accepted on its own**, whoever made it: it is restored at every check, also between runs (the protected directories are watched), and the changed version is kept in `~/.tugline/protect-backups/…`. To keep a change you made yourself, run `/protect accept [path]` in the session or `tug protect accept [path]` in a terminal (`tug protect backups` lists the backups).
   - **Editing protected files outside a session means you will be asked once, at the next session.** The guard cannot tell your edit (or a `git checkout` of another branch) from a process an earlier session left running, so it never decides for you. When a session starts and protected files differ from the last trusted state (kept with copies in `~/.tugline/protect-state/`):
     - with a person at the CLI or in VS Code: they are restored, your version is backed up, and you are asked once, naming the files: **keep my version** or **restore**. Until you answer, the last trusted version stays in place;
     - in headless runs (`tug -p`, `tug eval`, scheduled and daemon runs, channels, remote runs): they stay restored, the change is recorded as a refusal and a security event, and a notice names `tug protect accept <path>` to keep your version. Run that once and later sessions keep it.
   - **Commands cannot outlive the session** (`shell.processLifetime: "session"`, the default). Where bubblewrap works, every unsandboxed command runs in its own PID namespace (`bwrap --dev-bind / / --unshare-pid --die-with-parent`, no filesystem or network restriction), so anything it starts with `&`, `nohup` or `setsid` ends when the command ends, and everything ends with the harness. Background jobs end with their session, `persist: true` included. Set `"shell": { "processLifetime": "off" }` to let `persist: true` jobs outlive the session.
   - Without bubblewrap (macOS, or Linux without user namespaces), a process that hides from the guard can still outlive its command and change a file briefly before the next check restores it; a change made after the session ends is held at the next start, as above. The OS sandbox (or bubblewrap) prevents that.
   - Set `"shellGuard": "off"` to disable this layer.
3. **Inside the OS sandbox** the same paths are mounted read-only.
4. **Evaluation judges** (`tug eval`) run against pristine copies of the task's protected files, and a changed judge is reported as `protected_write`.

### Rules

```jsonc
"permissions": {
  "allow": ["bash(npm test*)", "bash(git status:*)", "edit_file(src/**)", "web_fetch(domain:*.github.com)", "mcp__github__*"],
  "deny":  ["bash(curl*)"],
  "protectedPaths": ["tests/**", ".github/**"],
  "additionalDirectories": []
}
```
A command rule matches a compound command only if every segment matches, so `bash(npm test*)` does not allow `npm test; curl …`. Substitution and redirection are never auto-allowed by a prefix rule. "Always allow" in an approval prompt adds a narrow session rule.

### Workspace trust

A repository's `.tugline/config*.json` and `.mcp.json` come from whoever wrote the repo. Until you trust the workspace, project config may only **add restrictions**: `permissions.deny`, `permissions.protectedPaths` and `skills.disabled`. Every other key is ignored and listed. It may not change the endpoint, start MCP servers, run hooks, add allow rules, change modes, or enable browser or desktop automation. The CLI asks once; `--trust` trusts without asking. Trust is stored in `~/.tugline/trusted-workspaces.json`. VS Code also requires VS Code's own Workspace Trust, and endpoint, MCP, mode, shell, terminal, browser and approver settings are application-scoped so a repo's `.vscode/settings.json` cannot set them.

### Checkpoints

On by default (`checkpoints.enabled`). Before every turn and every shell command, the workspace is snapshotted into a shadow git repo at `~/.tugline/checkpoints/<project>/` (or content-addressed copies when git is missing). Your own `.git` is never touched. `.gitignore`d files, `.tuglineignore`d files, `node_modules/`, `.venv/`, `__pycache__/` and files over `checkpoints.maxFileMB` (5) are excluded.

- `/checkpoints` lists them.
- `/rewind 2` goes back two turns (files and chat); `/rewind <id> files` restores files only. A rewind takes a `pre-restore` checkpoint first, so it can be undone.
- `/undo` reverts the last prompt's changes.
- Restoring the chat is refused when the history was compacted since the checkpoint, or the checkpoint is from another session.

### OS sandbox

```jsonc
"sandbox": {
  "runner": "auto",            // auto (default) | bwrap | landlock | seatbelt | docker | podman | none   (legacy: shell.sandbox; "mode" is a synonym)
  "require": false,            // true = refuse commands when no sandbox can run (fail closed)
  "filesystem": "workspace-write",   // or "read-only"
  "allowDomainsPreset": ["npm", "pypi", "cargo", "go", "maven", "github-releases"],   // the default
  "allowDomains": ["internal-registry.example.com"],
  "denyRead": ["~/work/.secrets"],   // MORE credential stores to hide (always added to the default list below)
  "allowRead": ["~/.npmrc"],         // user scope only: default stores commands may read after all
  "seatbelt": "permissive"     // macOS: or "restrictive" (deny by default)
}
```
- `auto` (the default) uses Seatbelt on macOS and, on Linux, bubblewrap (`apt-get install -y bubblewrap`), else **Landlock** (kernel ≥ 5.13, needs `python3`), else no OS sandbox with a warning. On macOS it uses Seatbelt only after the device check `scripts/device-checks/sandbox-macos.sh` has passed on that Mac (it records `~/.tugline/device-checks/sandbox-macos.pass`), or with `"sandbox": { "macosSeatbelt": true }`. An explicitly named runner that is unavailable is never replaced by another: commands are refused with the reason.
- **`tug sandbox status`** says what is in force for this workspace and why: the requested and effective runner, each step of the fallback chain, the Landlock ABI and what it covers, the network and allowlist, the credential stores hidden, how protected paths are enforced, whether commands can outlive the session, and any project settings that were ignored. `--json` for scripts; `/sandbox` shows the same in a session.
- **`tug sandbox verify`** probes the boundary with real commands through the same wrapper the agent uses: a workspace write works, a write outside fails, a credential-store read fails, a direct connection that bypasses the proxy fails. It exits 1 if any probe does not hold. **`tug sandbox run -- <cmd>`** runs one command confined.
- **Credential stores are unreadable** inside every runner, not just read-only: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.config/hub`, `~/.config/op`, `~/.config/git/credentials`, `~/.git-credentials`, `~/.docker`, `~/.kube`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.gem/credentials`, `~/.cargo/credentials(.toml)`, `~/.terraform.d/credentials.tfrc.json`, `~/.vault-token`, `~/.password-store`, `~/.local/share/keyrings`, `~/Library/Keychains` and the harness home (`~/.tugline`). bwrap mounts an empty directory (or `/dev/null`) over them, Landlock does not grant them, Seatbelt denies `file-read*`. `sandbox.denyRead` only ever **adds** stores, at every scope (a repository cannot shrink the list); to let commands read one of the defaults (for example a `~/.npmrc` that only holds a registry URL), list it in `sandbox.allowRead` in your user config (a project config cannot set it; the harness home always stays hidden). With the home directory itself as the workspace, the stores inside it stay hidden too (Landlock then cannot let a command create new entries directly in the home directory, only in its subdirectories). The permission engine adds a first layer that works with no sandbox at all: reading one of these stores with `read_file`, or a shell command that reaches one, or another process's `/proc/<pid>/environ`, asks you in every mode, auto included (headless runs deny it). It resolves commands the way the shell would: quotes (`~/".ssh"`, `$'…'`), variables (`H=$HOME; cat $H/.ssh/…`, `${HOME%/}`), `~user`, `$(echo ~)` and other substitutions that compute the home directory, redirections (`cat<~/.ssh/…`), `git -C ~ archive`, listings piped into `xargs`, `cd` (`cd ~ && cat .ssh/…`, `cd ..`), globs (`~/.ss?/*`, `/proc/1/env*on`), and recursive readers aimed at a directory that contains a store (`grep -r … ~`, `tar cf - ~`, `find ~ … -exec`); `echo`/`printf` and commit messages only mention a path; read-only daemon commands (`docker ps`, `podman images`) do not ask, others (`run`, `exec`, `cp`, `inspect`, `logs`, `-H`) do. It is still best effort (a command can build a path at run time): the OS sandbox is the control that holds. Only an allow rule naming that exact call, without wildcards, skips the question.
- **Landlock** (the fallback without user namespaces): reads everywhere except the credential stores; writes only to the workspace, the cache dirs and a private `TMPDIR`; with a proxy, TCP connections only to the proxy's port (ABI ≥ 4) and only TCP itself: no UDP, raw, MPTCP or SCTP sockets and no other address families (seccomp; Landlock's TCP rules would not cover MPTCP); with network off, no IP sockets at all on any ABI; no unix-socket connections (below); commands cannot write your terminals (`/dev/pts`) or shared memory (`/dev/shm`). Landlock has no namespaces, so it cannot give a command a private `/dev/shm`, and unix-socket creation stays refused (that is what keeps the Docker socket shut): **Python `multiprocessing` does not work under Landlock** (`Lock`, `Pool`, `ProcessPoolExecutor`, `Manager`, and so pytest-xdist, joblib and many build scripts), nor does anything else that needs POSIX shared memory or semaphores. Run those under bwrap (install bubblewrap) or a docker/podman runner; `tug sandbox status` says so, and a command that fails that way gets the same explanation appended; on ABI ≥ 6 a command cannot signal processes outside its sandbox. Landlock needs **ABI 3 or newer** (Linux 6.2+, Qwen's floor): below it `truncate(2)` is not controlled, so the runner is reported unavailable (`auto` falls through, a forced `landlock` refuses commands). Below ABI 4 a proxied run says "network not restricted by Landlock", and with `sandbox.require` such commands are refused. `sandbox.landlock.maxAbi` caps the ABI (to see how an older kernel behaves). One limit, shown by `tug sandbox status`: Landlock cannot make a path read-only inside a writable directory, so protected paths in the workspace are kept by the static check and the restore guard rather than the kernel. Other processes' `/proc/<pid>/environ` is not readable (Landlock's ptrace restriction), and the permission engine asks before any command names one.
- **Host daemon sockets are unreachable** (`sandbox.unixSockets: "deny"`, the default): a connection to the Docker, containerd or Podman socket would let a command start a privileged container with your network and `/`, so bwrap hides the runtime socket directories (`/run`, `/var/run`, `$XDG_RUNTIME_DIR`, LXD) behind an empty directory (the resolver configuration is kept for host networking), Landlock refuses unix-socket creation (it cannot hide a socket path; `socketpair` and pipes still work), and Seatbelt denies daemon sockets, in every network mode. Per-command and session containers never mount the socket. The permission engine also asks, in every mode, before a command names a daemon socket, runs `docker`/`podman`/`nerdctl`/`ctr`/`lxc`/`virsh`, sets `DOCKER_HOST`, or opens a unix-socket connection in inline code. `"unixSockets": "allow"` (user scope only) restores the old behaviour.
- Whatever a sandboxed command starts dies with it: bwrap uses a PID namespace; the Landlock helper is a subreaper that kills every leftover process when the command ends, when the run stops and when the harness exits; a per-command container is killed on timeout and by a watchdog when the harness dies, and leftovers are removed at the next start.
- **Programs that need a terminal**: the model can run a command with `"tty": true`; it gets a pseudo-terminal inside the sandbox (bwrap's own, or one the Landlock helper allocates before it confines; containers get `-t`), with end-of-file as input.
- The run-start notice, `tug doctor` and the CLI banner show the state, for example `sandbox: bwrap (workspace writable, protected paths read-only; network via proxy to 16 allowed hosts)`.
- Inside the sandbox:
  - the workspace and cache dirs (`sandbox.allowWrite`) are writable and the rest of the filesystem is read-only;
  - these stay read-only even inside the workspace: `sandbox.readOnlyPaths` (`.git/hooks`, `.git/config`, `.tugline`, `.mcp.json`, `.vscode`, `.claude`, `.envrc`), your `permissions.protectedPaths` (globs are expanded when each command starts) and the agent-control files.
- Network: traffic goes through a filtering proxy that resolves each host once and connects to the checked IP. Only hosts in `allowDomains` and the presets are reachable.
  - The default presets cover package registries: npm, PyPI, crates.io, the Go module proxy, Maven Central and Gradle, and GitHub release downloads.
  - `apt` is an extra preset you can add. `"allowDomainsPreset": []` with no `allowDomains` means no network.
  - Blocked hosts are reported to the model. `sandbox.network: "host"` opts out.
- An explicitly requested sandbox that is unavailable fails closed: the command exits 126 with an explanation.
- `shell.requireSandbox: true` also fails closed under `auto`: use it for unattended or company runs.
  - It is the default for scheduled runs, `tug daemon` and remote runs.
  - Set it to `false` explicitly to run those unsandboxed.
- `docker` and `podman` run each command in a throwaway container (`shell.dockerImage`, `shell.dockerNetwork: "none"`): the workspace is mounted, protected paths and agent-control files are mounted read-only over it, the host home is not mounted, and the container runs with `--init`, `no-new-privileges` and without raw sockets. It is named and labelled (`tugline.cmd`, `.pid`, `.host`) so it is killed on timeout, removed if the harness dies, and swept at the next start.
- **Project config can only tighten the sandbox.** A repository's `.tugline/config*.json` can ask for a stricter runner, `sandbox.require: true`, network `none`, a read-only workspace or a stricter permission mode, but settings that would loosen sandbox, network or approval settings (`sandbox.mode: "none"`, a weaker runner such as `auto` or `landlock` over your `bwrap` — or over the bwrap that your `auto` selects on this machine — new `allowDomains`, `network: "host"`, `permissionMode: "auto"`, `web.allowHosts`, `approver.enabled`, `permissions.allow` and `additionalDirectories`, `shell.mode`/`allowlist`, an emptier `shell.scrubEnv`, a section that is not an object such as `"sandbox": "off"`, or any key a project may not set …) are ignored, even in a trusted workspace, with a warning on every surface and a `policy_violation` audit event. Protective lists (`denyRead`, `readOnlyPaths`, `permissions.deny`, `protectedPaths`, `scrubEnv`) are added to yours, never replace them. To let one workspace's config loosen them, run `tug sandbox trust-project` there at an interactive terminal and answer yes (it adds the path to `sandbox.trustProjectConfig` in your user config; `--revoke` removes it). A script or an agent cannot grant it: without a terminal the command refuses, and the permission engine always asks before a model runs it.

#### Whole-session container mode

`tug --container [docker|podman]` (or `"sandbox": { "session": "container" }`) runs the whole agent, not only its commands, inside a container:
- the workspace is mounted read-write at the same path; your home directory, the harness home, credentials and `/tmp` are not mounted (the container's home is `/oh-home`, kept under `~/.tugline/containers/<project>/home`; its config is generated fresh for each session and mounted read-only, so nothing the container writes is ever written back by the harness);
- the agent container has **no network** (`--network none`); its only way out is the allowlist proxy in a sidecar container, reached through a unix socket in a shared volume, for your `sandbox.allowDomains` only (entries may name a port: `"10.0.0.5:8080"`). The model is reached through a relay in the same sidecar that forwards only to the configured endpoint (its address and base path, not every port of that host), only model API paths (`/chat/completions`, `/models`, `/embeddings`, Ollama's `/api/chat` …), refuses encoded or literal dot segments, protocol-relative paths and backslashes, never follows a redirect, and adds the API key only after those checks: **the key never enters the agent container**, so a command cannot read it from a process environment. A model on your machine's localhost is reached through the host gateway (on Linux the model server must listen on that interface, e.g. `OLLAMA_HOST=0.0.0.0`);
- the image is `.tugline/environment.Dockerfile` (built and tagged by its hash), else `.devcontainer/devcontainer.json` (`image` or `build.dockerfile`), else `container.image`, else `node:22-bookworm-slim`. Images the repository provides are used only in a trusted workspace. The image needs Node.js ≥ 20;
- it runs as your uid/gid (rootless Podman: `--userns=keep-id`), with all capabilities dropped, `no-new-privileges` and limits (`container.memory` `4g`, `container.cpus` `2`, `container.pidsLimit` `1024`);
- `container.mounts` (`[{ "from": "/data/fixtures", "mode": "ro" }]`, read-only by default) and `container.env` add host directories and variables; credential stores, the harness home and credential-looking variable names are refused. Both are user-scope settings;
- every session container and the socket volume are removed when the session ends; containers left by a crashed session are removed by the next one.
Works with `tug -p`, the REPL, `tug --acp` and `tug serve --stdio`. `tug serve` over WebSocket is refused in container mode (the agent container has no network and no published ports): run the server on the host with a sandbox runner instead.

The sandbox applies to foreground commands, background jobs, the VS Code visible terminal and the harness's helper processes alike.

### Auto mode

`auto` lets routine work run without prompts and keeps a human in the loop for everything risky. Each call the policy does not settle goes through, in order:

1. **Policy.** Hard denies (protected paths, the workspace jail, plan mode), deny rules and `permissions.ask` rules, exactly as in other modes. An ask rule always reaches you.
2. **The deterministic floor.** The prefilter below (destructive, credential access, exfiltration, writes outside the workspace, publishing, persistence, security weakening) plus self-modification files: `.git/**`, `.tugline/**`, `.github/**` and other CI files, `AGENTS.md`/`CLAUDE.md`, `.mcp.json`, `package.json` (lifecycle scripts), `Makefile`/`justfile`, `setup.py`/`conftest.py`, `.envrc`, `.husky/`, shell rc files, also when a shell command writes them (`tee`, `sed -i`, `tar -C`, `curl -o`, `cd .tugline && echo > …`). Amending a commit this session did not create is on the floor too. A floor hit always asks you: no classifier verdict, allow rule or extension can lift it. In auto mode, allow rules that would let any code run without a check (`bash`, `bash(python*)`, `bash(npm run:*)`, `bash(*)`) are ignored (`/auto` lists them); they apply again in other modes.
3. **Rule of Two.** After untrusted content was read, an outbound call asks you without consulting the classifier (see the next section).
4. **Fast paths.** Edits inside the workspace and read-only shell commands run at once, with no model call. A command is read-only only if every program in it is a known reader and every option is on that program's list of harmless options (exact names: abbreviations such as `--open-files-in` are refused) (`ls`, `cat`, `grep`, `rg`, `git status|log|diff|show|grep`, `find` without `-exec`/`-delete`, `sort` without `-o`/`--compress-program`, `sed -n` …), it has no leading `VAR=…` assignment, no unquoted glob or `$…`/backtick expansion, no write redirect, every path it names resolves inside the workspace, and, for git, the repository's own config sets no external diff, pager, textconv or fsmonitor program. Anything else goes to the classifier (and outside reads of credential stores hit the floor). Unpacking an archive (`tar x`, `unzip`, `7z x`, `jar x`, `cpio -i`, `python -m zipfile -e` …) always asks you in auto mode, whatever its options: an archive can replace any file. Patches, recursive copies and branch switches are checked against the self-modification files and ask when their effect cannot be listed.
5. **The classifier**, in two stages on your small model. Stage 1 answers one word (ALLOW/BLOCK) with thinking switched off; a stage-1 block, or an unclear answer, is reviewed by stage 2, which answers with a category and a reason. The classifier sees your requests (the durable task brief, your last messages and your answers to the agent's questions) and the agent's recent actions, all as quoted data inside an envelope. It never sees tool output or file contents (files you attach with `@file` are listed by name only), so a README or a web page cannot talk to it. Stage 1 counts as ALLOW only if the whole answer is the word ALLOW (or a one-key JSON verdict); anything else goes to stage 2. An error, a timeout or an unparseable answer asks you; auto mode never allows what it could not check.
6. **Denial tracking.** A blocked call goes back to the agent with the reason and "do not work around this". Repeating the exact call once asks you. The third block in a row asks you instead of blocking. After 20 blocks in a session auto mode is **suspended**: every call asks you until you run `/auto resume` or select `auto` again. "Classifier unavailable" is counted separately: three in a row skip the classifier for two minutes (you are asked meanwhile). Switching modes resets all counters.

Auto-allowed commands still run in the OS sandbox, still go through budget admission (a classifier call is a metered model call) and are still journaled: every decision is an `approval_auto` event and journal record with the step that decided, the stage verdicts and their latencies.

```jsonc
"autoMode": {
  "profile": "small",              // classifier profile (default: approver.profile, routing.approver, smallProfile, main)
  "stage1TimeoutMs": 20000, "stage2TimeoutMs": 60000,
  "stage1MaxTokens": 24, "stage2MaxTokens": 400,
  "thinking": "off",               // off: ask the server to switch thinking off (Ollama: reasoning_effort "none")
  "maxConsecutiveBlocks": 3, "maxTotalBlocks": 20,
  "maxConsecutiveUnavailable": 3, "unavailableCooldownMs": 120000,
  "transcript": { "userMessages": 6, "actions": 12 },
  "hints": { "allow": ["running ./scripts/dev.sh is routine"], "block": [], "environment": ["our remote is github.com/acme/app"] }
}
```
`autoMode` and `permissionMode: "auto"` are read from your user config, flags and managed policy only; a project's config cannot set them. Managed policy: `"disableAutoMode": true` forbids both `auto` and `yolo`; `"disableYoloMode": true` forbids only `yolo`. A forbidden mode is replaced by `ask` at load and refused the moment someone selects it; `tug serve` (`config/set`) and ACP report the mode actually in effect.

**Rules and scopes.** `/permissions` shows every rule and where it comes from. Rules in your user config and in managed policy can say anything. A project's config (even in a trusted workspace) can add `ask` and `deny` rules, and `allow` rules except ones that would allow every command or tool, a floor-category command (`bash(git push*)`, `bash(rm -rf /*)`, `bash(cat ~/.ssh/*)`) or edits to self-modification files (`edit_file(.github/**)`, `write_file(Makefile)`); those are dropped at load with a notice. A project can never allow network tools (`web_fetch`, `web_search`, browser navigation). `/permissions` changes your user config; with `--project` it can only tighten the project's rules (add ask/deny, remove allow). Managed rules cannot be changed from any surface, `tug serve` clients cannot change rules at all, and every change is journaled and recorded as a security event (`tug audit export`).

### Classifier approver in other modes

```jsonc
"approver": { "enabled": true, "profile": "company-small" }
```
Off by default. In `ask` and `acceptEdits` modes, when the policy would ask, a small model judges the call against a fixed rubric. A deterministic prefilter runs first and always escalates destructive, credential, exfiltration, publishing, persistence and security-weakening actions to you; the model can never approve those. A classifier `deny` blocks the call (`approver.honorDeny: false` makes it ask instead). Hard denies never reach the classifier. Every decision is an event and is journaled. It uses `approver.profile`, else `routing.approver`, else `smallProfile`, else the main model.

### Untrusted content and outbound actions (`agent.taint`)

Once a run has read untrusted content, actions that could send your data out or make an injected instruction stick need you, in every mode (Meta's "Rule of Two": untrusted input + private data + outbound action never all happen without a human). Untrusted content is anything the agent did not get from you or your files: `web_search`, `web_fetch`, `screenshot`, `browser_*` and `desktop_*` results (page text, accessibility text, OCR, screenshots), MCP tool output, channel messages from anyone but the paired owner, and webhook/trigger events. The first time it happens you see a notice: *untrusted content read (…); outbound actions now need approval*. From then on these ask, even in `auto` and `yolo` modes, even with a session or config allow rule, and the auto-mode approver is not consulted (it reads the same injected context):

- exfiltration: network commands (`curl`, `wget`, `nc`, `ssh`, `scp`, …), network tools with a body, inline code that opens connections;
- publishing: `git push`, package publishes, `gh pr create`, MCP tools that send, post or publish;
- persistence: writes to files that control the agent or CI, user memory, cron, shell startup files, git hooks;
- writes outside the workspace.

Shell commands are not trusted to stay offline just because they look local (a script the agent wrote, `npm test`, `make` can all open connections), so while a run is tainted every shell command runs in the OS sandbox with network access off (`agent.taintShellNetwork: "registries"` allows only the package registries, through the sandbox proxy). If no sandbox runner is available, every shell command needs approval instead; the notice says which applies. Background jobs that were already running are stopped, since they started with network access (`agent.taintJobs: "keep"` keeps them, with a warning). URLs that carry data (a query string, a fragment, credentials or a long token-like path segment) also ask in `web_fetch` and other fetch tools (browser navigation is governed by the browser's own site allowlist). The approval request names what was read and why the call is gated, and offers no "always allow". With no user available (headless, schedules), the call is denied. Hard denies and deny rules still refuse outright. Ordinary work is unchanged: reads, edits in the workspace, builds and tests without network egress (`npm test`, `tsc`, `pytest`) run as your mode allows. A subagent that reads untrusted content taints its parent's run, and a tainted run starts its subagents tainted. Clearing the conversation resets it. `"agent": { "taint": "off" }` turns the gate off (not recommended). Package installs (`npm install`) and `git pull` are not treated as egress.

### Ignore files

`.tuglineignore` (gitignore syntax, nested files work) hides paths from `glob`, `grep`, `list_dir` and the repo map, and reads of them ask in every mode. Set `permissions.ignoreMode: "deny"` to block them. `.gitignore`d paths are hidden from search too (`permissions.hideGitignored`, default true), but reading them is allowed by default (`permissions.gitignoreReads: "allow"`), because agents read `node_modules/` and `dist/` routinely. Secret files still ask.

### Hooks

```jsonc
"hooks": {
  "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "npx prettier --write $(jq -r .args.path)" }],
  "Stop": [{ "command": "npm test --silent" }]
}
```
Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `SubagentStart`, `SubagentStop`, `PermissionRequest`, `Notification`. The contract is Claude Code's: JSON on stdin, exit 2 blocks (stderr goes to the model), `{"decision":"block"}` blocks, `hookSpecificOutput.permissionDecision: "deny"` from PreToolUse blocks. A PermissionRequest hook may deny any ask, but may only allow calls the approver prefilter does not flag.

Hooks in your user config run as written. **Project hooks** run only when the workspace is trusted **and** you approved the exact hook: `/hooks` lists them, `/hooks approve` (or `approve all`, `approve <n>`) records sha256(event, matcher, command) in `~/.tugline/trusted-hooks.json`. A changed hook needs approval again.

### Managed policy (administrators)

Place a JSON file at `/etc/tugline/managed.json` (Linux), `/Library/Application Support/Tugline/managed.json` (macOS) or `%ProgramData%\Tugline\managed.json` (Windows), or point `TUG_MANAGED_POLICY` at one.

```json
{
  "lockedProfile": { "baseUrl": "https://llm.corp.example/v1", "model": "qwen3-coder-30b" },
  "deny": ["bash(curl*)", "web_fetch(domain:*.pastebin.com)"],
  "protectedPaths": ["infra/**"],
  "allowMcpServers": ["github", "https://mcp.corp.example/"],
  "allowSkills": ["code-review", "python-bugfix"],
  "disableAutoMode": true,          // forbids auto and yolo; "disableYoloMode": true forbids only yolo
  "maxCostUsdPerDay": 20,
  "forceSandbox": "auto"
}
```
The policy is applied after every other layer (files, env, flags, VS Code settings) and re-checked before each model call, so `/mode yolo` or a profile switch cannot escape it. Two files combine restrictively. An invalid file, an unknown field, or a missing `TUG_MANAGED_POLICY` target stops the harness. Attempts to loosen it are reported at session start.

**Central policy, version pinning, org usage and audit (N22/N23).** The local file (installed by MDM) can also say:
```json
{
  "remote": { "url": "https://policy.corp.example/tugline", "publicKey": "<Ed25519 key, base64 raw 32 bytes or PEM>",
              "refreshSeconds": 3600, "failClosed": true },
  "minVersion": "1.1.0", "maxVersion": "1.9.99",
  "usage": { "url": "https://policy.corp.example/usage", "intervalSeconds": 60, "failClosed": false },
  "audit": { "sink": "https://audit.corp.example/tugline" }
}
```
- **`remote`** fetches a **signed** policy: Ed25519 over the canonical JSON of `{policy, issuedAt, expiresAt?}`, checked against the key pinned here.
  - **Set `remote.highWaterFile`** to a path your MDM manages and users cannot write (for example `/Library/Application Support/Tugline/policy.hwm` or `/etc/tugline/policy.hwm`). Without it, the rollback mark is only in the user-writable `~/.tugline/managed-state/`: a user who deletes it can make an older signed policy count again while offline (until its signed `issuedAt + maxStaleSeconds`). `tug doctor` warns when a remote policy is used without it.
  - The remote policy can only add restrictions; it is combined with the local file like two local files.
  - A forged, unsigned or expired document is refused and reported.
  - The last verified document is cached in `~/.tugline/managed-cache/` and re-verified on every start. It is used offline until its signed `expiresAt`, or until `maxStaleSeconds` (default 7 days) after its signed `issuedAt`, whichever comes first. The newest document ever verified is remembered (`~/.tugline/managed-state/`, and `remote.highWaterFile` if you point it at a path users cannot write), so an older, looser signed document put back into the cache, or served again, is refused.
  - With `failClosed: true`, Tugline will not start without a valid company policy.
  - `TUG_MANAGED_POLICY_URL` plus `TUG_MANAGED_POLICY_PUBLIC_KEY` do the same from the environment.
- **`minVersion` / `maxVersion` / `allowedVersions`**: Tugline refuses to start outside the range, with a message.
- **`usage`**: before each model call the client reports its day's totals to the company endpoint. It stops with the `budget` reason when the user's org-wide usage (all their machines), plus the next call's worst case, would exceed the quota the server returns.
- **`audit.sink`** is forced as the external anchor for journals and security events.
- A minimal reference server is in `examples/policy-server/server.mjs` (`node examples/policy-server/server.mjs --policy policy.json`).
- **Honest boundary:** all of this runs on a machine the user controls, so it is defence in depth. The company's model gateway is the authority for model access and shared budgets, because it sees every request; enforce hard limits there.

### Security events and audit export

- Every refusal, approval (by the user or by an approver, with who decided), taint (untrusted content entering the context), protected-path restore, sandbox state, secret redaction and managed-policy violation is recorded as a structured security event.
- Events go to `~/.tugline/audit/security-*.jsonl`. These files are hash-chained like the run journal: each line's `_h` is sha256(previous hash + line).
- When telemetry is on, each event is also an OpenTelemetry `oh.safety_event` span event. With `audit.sink` set, each line's hash also goes to the company store.
- Content (arguments, matched text) is left out unless `securityEvents.includeContent` is true.

```bash
tug audit export --since 7d --format jsonl     # or --format sarif (SARIF 2.1.0), --out FILE
tug audit verify                               # checks every audit file's hash chain
```

### Spend limits

```jsonc
"limits": { "maxCostUsdPerDay": 5, "maxTokensPerDay": 2000000, "maxCostUsdPerSession": 1 }
```
Every model request is admitted at one point before it is sent: main-loop turns, subagents, compaction (also in the background), `summarize up to here`, auto-memory, the approver classifier, the apply model, browser-task helpers, the arena judge, and in VS Code the image description, inline edit, autocomplete and next-edit suggestions (an exhausted budget silently stops suggestions). The worst case (estimated prompt plus the output limit) is checked against the limits plus what calls in flight have already reserved, reserved while the call runs, and reconciled with the real usage afterwards; a refused call sends nothing, and a run stops with reason `budget`. Each request is one line in `~/.tugline/usage/<date>.jsonl`. An autocomplete or next-edit request is counted in full, including repo-context blocks, at the pricing of the profile it posts to. If it is cancelled or times out after it was sent (common while typing), its prompt is recorded as an estimate, because the server already processed it. Cost limits need `pricing` on the profile; for local models use `maxTokensPerDay`. `tug usage` and `/usage` report spend. `agent.maxCostUsd` and `agent.maxTokens` are per-run budgets.

**Unlimited vs exhausted:** leave a limit out for no limit. `0` means exhausted: no model call is admitted (v1.0 treated `0` as unlimited; remove such keys from old configs).

### Secrets

The API key lives in VS Code SecretStorage or in config/env (files are written 0600). Child processes (shell, MCP servers, hooks, helpers) never get variables that look like credentials or whose values equal a configured key. Git config injected through the environment (`GIT_CONFIG_COUNT` with `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, as CI runners do) is filtered too: credential-like pairs (`http.*.extraheader`, `credential.*`, keys containing `token` or `password`, `url.*.insteadOf` carrying `user:pass@`) are dropped, `user:token@` is removed from any other URL value (`remote.*.url`, `http.proxy`), and the rest renumbered, so git keeps working without the token. Journals redact the same values. Browser and channel secrets live in a vault: `TUG_SECRET_<NAME>` env vars, the OS keychain when `keytar` is installed, else `~/.tugline/secrets.json` (0600; a looser file is refused).

---

## 6. Editing

The agent gets one edit family per model, chosen when the session starts:

| `edit.editFormat` | Tools | Default for |
|---|---|---|
| `replace` | `edit_file`, `multi_edit`, `write_file` | most models |
| `apply_patch` | `apply_patch` (Codex V4A), `write_file` | model ids matching `gpt-oss`, `codex` or `gpt-` |
| `whole` | `write_file` | — |
| `auto` (default) | picks one of the above | — |

Set it per model with `editFormat` on the profile. Behaviour you can rely on:
- An edit needs a prior read, and is refused if the file changed since (also in VS Code buffers).
- Anchors match through tiers (exact, line endings, copied line numbers, unicode quotes, trailing whitespace, indentation, escapes, blank lines). Each tier must find exactly one match; two matches are refused, never guessed. The result names the tier when it is not exact.
- `write_file` may overwrite an existing, read file of up to `edit.wholeFileMaxLines` (400) lines, and refuses placeholder lines such as `// ... existing code ...`.
- After an edit, the result lists only *new* problems plus the edited region. Sources: IDE diagnostics in VS Code; in the CLI a configured language server (`lsp.servers`, [§7](#7-agent-features)); else `JSON.parse`, `python3 -m py_compile`, `node --check`, and tree-sitter syntax errors for TypeScript/TSX, Go, Rust, Java, CSS, HTML, YAML and shell (optional `web-tree-sitter` package, installed with Tugline and bundled in the VS Code extension). `edit.verify: false` turns it off.
- `edit.format` runs a formatter after edits: `{ "**/*.py": "ruff format {file}" }`. Off by default.
- `edit.applyModel: "<profile>"` lets a small model merge lazy snippets after two failed anchors, under checks (no placeholders, no new syntax errors, deletes at most 50 % of the file). Off by default.
- Per-model edit success is recorded in `~/.tugline/model-stats.json` (`edit.recordStats`). Under 60 % over 20+ attempts, you get one notice suggesting `apply_patch`.
- In text tool mode, models can write `<edit path="…">` blocks with SEARCH/REPLACE pairs and raw code; they become `multi_edit` calls.
- `notebook_edit` edits `.ipynb` cells (insert, replace, delete) and keeps metadata and other outputs byte-exact.

---

## 7. Agent features

**Subagents.** The `task` tool starts a fresh-context subagent (`explore`, `general`, `validator`, or a custom agent from `.tugline/agents/*.md` / `.claude/agents/*.md`). Consecutive `task` calls run in parallel, up to `agent.maxParallelSubagents` (3). `run_in_background: true` returns a handle that `task_result` collects. `isolation: "worktree"` runs the child in a git worktree on branch `oh/<id>`; `worktree_merge` merges it (asks like any command). Depth is at most 1. `--validate` or `agent.autoValidate` requires a validator pass before finishing; a validator that ran no command is `UNVERIFIED`.

**Tool search.** When there are more than `agent.toolSearchThreshold` (20) tools, or their schemas exceed 15 % of the window, only core tools plus `tool_search` are sent. The rest are listed by name in the system prompt and load by search or exact name. `agent.toolSearch: "on"|"off"` forces it; `agent.coreTools` adds names to the core set.

**Background jobs.** Set `agent.backgroundJobs: true`. Then `bash` accepts `run_in_background`, and `monitor`, `job_output` and `job_kill` appear. Logs go to `~/.tugline/jobs/<id>.log`. Jobs are killed when the session ends unless started with `persist: true`. `/jobs` lists them.

**Memory.** The `remember` tool writes typed, keyed lines to `<ws>/.tugline/MEMORY.md` (project) or `~/.tugline/MEMORY.md` (user); a new memory with the same key supersedes the old one. Writing memory always asks. `/memory` shows it; `/memory add [--user] <text>` writes directly. `agent.autoMemory: true` proposes memories at session end and asks before writing.

**Project instructions.** `~/.tugline/AGENTS.md`, `AGENTS.md`, `CLAUDE.md`, `.tugline/MEMORY.md`, `.github/copilot-instructions.md`, plus `.cursor/rules/**/*.mdc`, `.cursorrules`, `.clinerules` and `GEMINI.md`. Glob-scoped rules are appended to the tool result the first time a matching file is read.

**Skills.** `SKILL.md` folders in `.tugline/skills`, `.claude/skills`, `.agents/skills`, `.codex/skills`, `skills.dirs`, `~/.tugline/skills`, `~/.claude/skills`, `~/.codex/skills`, then the bundled ones. `skills.disabled` turns some off.

**Repo map.** The first prompt of a session includes a ranked map of definitions (`agent.repoMapTokens`, 1500; 0 = off). Only files the read policy allows without asking are mapped; secret files never are. The `repo_map` tool builds one focused on given files. There is no file cap (`agent.repoMapMaxFiles`, 0 = all); per-file parses are cached in `~/.tugline/index/<project>/repomap.json`, so a new session reparses only files whose content changed (`agent.repoMapCache: false` keeps the cache in memory only).

**Code search (`code_search`).** Finds code by meaning or keywords and returns the best functions, classes or doc sections as `file:lines` with a snippet. Chunks follow definition boundaries (tree-sitter, else the repo-map regexes); ranking fuses BM25 keyword scores with embedding similarity (reciprocal rank fusion). Embeddings come from any OpenAI-compatible `/v1/embeddings` endpoint, so nothing leaves your network:
```json
{ "profiles": { "embed": { "baseUrl": "http://localhost:11434/v1", "model": "nomic-embed-text" } },
  "search": { "embeddings": { "profile": "embed" } } }
```
(Ollama: `ollama pull nomic-embed-text` or `bge-m3`.) The tool exists only when an embedder is configured, or with `search.mode: "bm25"` for keyword-only search; if the endpoint is down it answers by keywords and says so. The index lives in `~/.tugline/index/<project>/`, updates incrementally on each search (unchanged files are only stat-ed, unchanged chunks keep their vectors), and follows the repo-map rules: secret files, `.tuglineignore`, ignored paths and reads the policy would ask about are never indexed, and secret-looking strings are redacted before anything is embedded. `tug index status|update|rebuild`; `tug index eval` runs the file-localisation eval (`evals/localisation/queries.json`) and prints recall@5 for BM25 and hybrid, so you can check that your embedder actually helps on your code before relying on it.

**Code navigation (`code_definition`, `code_references`, `code_symbols`, `code_rename_preview`).** Go to a definition, list every reference (before changing a signature), outline a file or search symbols, and preview a rename (nothing is written), as `file:line` plus the line, without reading whole files. Backends, in order: the editor's language features (VS Code), a language server you configured, then name matching over tree-sitter/regex definitions with scope rules (imports, shadowing, private helpers, qualified method calls). The output names the backend. Language servers are off by default because they load project code and plugins; enable them per language:
```json
{ "lsp": { "servers": { "typescript": true, "python": true, "go": true } } }
```
Presets: `typescript` (`typescript-language-server --stdio`; `npm i -g typescript-language-server typescript`), `python` (`pyright-langserver --stdio`), `go` (`gopls`), `rust` (`rust-analyzer`), `java` (`jdtls`). A command line or `{ "command": [...], "extensions": [...], "initializationOptions": {...} }` sets your own. Servers start on first use, run through the command wrappers (so the OS sandbox applies) with a scrubbed environment, and stop when the session ends. A missing server gives an install hint and the fallback answers. With a server configured, CLI post-edit verification uses its diagnostics (`lsp.diagnostics`, default on). Results in secret or ignored files are never shown. The tools are offered when a configured server handles a language in the workspace; `lsp.enabled: true` offers them with name matching alone (no server needed), `false` never. They are not on by default because four more tools push a default session past the tool-search threshold (20), which would defer your other tools.

**Compaction.** At `agent.compactAt` (0.75 of the window) old tool output is cleared, then older turns are summarised; your requests are kept verbatim. A summary is pre-built in the background at 60 % (`agent.backgroundCompaction`). `/compact [focus]` compacts now.

**Prompt cache (v1.1 N10).** Local servers reuse only an exact prompt prefix, so Tugline keeps the prefix stable and shows how well it is reused:
- `/cost` adds the prompt-cache hit rate of the session and of the last call; `/cache` adds the server kind, llama.cpp slot settings and the last *prefix break* with its cause. The VS Code meter shows `cache 82% · last 91%`, the status-line JSON has a `cache` object, `tug eval` reports a hit rate per arm, and `--verbose` prints each call's cached share. Servers that do not report cached tokens (Ollama's `/v1`) show "not reported", never 0 %.
- **llama.cpp:** `tug doctor`/`tug setup` detect llama-server from `GET /props` and cache its slot count; every request then carries `cache_prompt: true` and an `id_slot` per agent (main agent from slot 0, subagents and helper calls from the last slot down), so parallel subagents don't evict the main conversation. Set it by hand with `"server": "llamacpp", "llamacpp": { "slots": 4 }` in the profile; `"cachePrompt": false` / `"pinSlots": false` turn the parts off.
- **Prefix guard:** a `cache_break` event (shown as `[cache] prompt prefix changed (…)`) names what changed: `mode`, `memory`, `overlay`, `skills`, `tools added`, `tool order`, `tool schema`, `compaction`, `history rewrite`, `model`. A normal loop produces none. Between prompts the system prompt stays byte-identical when only the date or git status changed; the new status is sent as an `<environment_update>` with your message (`promptCache.stableEnvironment`). Tools loaded through tool search stay listed in the system prompt so the next prompt does not rewrite it.
- **Idle compaction:** in interactive sessions (CLI chat, VS Code, `tug serve`), 30 s after a run, with nothing queued and the history past 60 % of the compaction budget, the conversation is compacted while you read (`promptCache.idleCompaction`, `idleCompactMs`, `idleCompactAt`). The system prompt and tools are kept byte-identical, and a prompt sent meanwhile waits for it.

**/goal.** `/goal "all tests pass" --check "npm test" --max-turns 30` runs the agent repeatedly until the check exits 0: the result is labelled **verified**. It stops on `GOAL_IMPOSSIBLE`, max turns, budget, abort or thrashing, each with a typed reason.

**Goals without a check (v1.2 N35).** `/goal "greet() returns a greeting and its test passes"` lets an **independent verifier** decide. After each iteration a fresh verifier session (its own system prompt; `goal.verifierModel` or the main model at temperature 0) receives the goal, the full diff since the goal started (deletions included) and the commands that ran, all inside an untrusted envelope, and may read the workspace with read-only tools and run read-only commands (`bash` in a sandbox with a read-only filesystem, no network, the home directory and host sockets absent: bubblewrap on Linux, Seatbelt on macOS; with neither, the verifier has no command tool). It answers `{met, reasons, evidence: [{file, line, quote}]}`. The harness checks every citation (inside the workspace, the line exists and contains the quote, not text addressed to a verifier or reviewer, and not a note, log or doc the agent itself created during the goal: at least one citation must be into code); a "met" needs at least one valid citation into code that existed before the goal and that the diff changes, or into a file the goal names; files the agent created during the goal (unless the goal names them by path or by a file name with an extension) and comments do not count, otherwise "met" becomes "not met". The verdict goes back to the agent as a short harness message (met or not, and the citations as `file:line`); the verifier's findings follow as data inside `<untrusted_verifier_findings>`. The agent counts as having read untrusted content only if the verifier itself did (a web, MCP or other untrusted tool result), not because it read workspace files, so a goal whose work needs the network keeps working across iterations. A met goal is labelled **judged met (independent verifier)**, never "verified". `--verify` adds the verifier on top of a check (both must pass). `--max-tokens N` gives the goal its own budget; the verifier's calls count in it, in the session totals and in the usage ledger. `/goal status`, `/goal pause` (after the current iteration), `/goal resume` (also after a restart: the goal is read from the session journal) and `/goal clear`. Headless: `tug goal "<condition>" --json`; over `tug serve`: `session/command {name: "goal", args}`; events: `goal` (start, iteration, verdict, end with its label).

**Nested subagents (v1.2 N18).** Subagents can start subagents up to `agent.maxDepth` (default 2, at most 4); deeper calls are refused with `Refused (depth_limit)`. A child never has more than its parent: its tools, permission mode, extra directories, network domains, model profile and budget are clamped to the parent's, and every clamp is journaled and shown. Budgets flow down: every model call of a child is admitted against the parent run's remaining budget (`agent.maxTokens` / `agent.maxCostUsd`) and its own cap (`agent.subagentMaxTokens` / `subagentMaxCostUsd`), with in-flight calls reserved. Taint flows both ways: a child of a tainted agent starts tainted, and a child that reads untrusted content taints its parent. `task {fork: true}` starts the child from a copy of the conversation; `task_stop {handle}` stops a background subagent. Agent definitions may set `disallowedTools`, `permissionMode` and `maxTurns` (narrow only), `mcpServers: ["docs"]` (a subset of your configured MCP servers), `hooks: ["PreToolUse:bash"]` (a subset of your hooks; inline hooks as JSON only in your own `~/.tugline/agents/` definitions, or approved project hooks in a trusted workspace), and `executionBackend: container` (its commands run in the docker runner with no network, in `shell.dockerImage` or an image from `agent.containerImages`). Background subagents interrupted by a restart can be resumed: `/tasks` lists them, `/tasks resume <handle>` (or the `task_resume` tool) continues one with its earlier conversation, after checking the session journal and the saved state, and never with more authority than the agent has now.

**Workflows (v1.2 N18).** A workflow is JSON data, never code:
```json
{ "name": "migrate", "items": ["src/a.ts", "src/b.ts"],
  "task": { "prompt": "Migrate {{item}} to the new API and run its tests.", "isolation": "worktree", "output": { "required": ["status"] } },
  "concurrency": 4, "budget": { "total": { "maxTokens": 400000 }, "perItem": { "maxTokens": 60000 } },
  "retry": 1, "stallMs": 180000, "reduce": { "prompt": "Summarise what changed and what failed." } }
```
Run it with `tug workflow run migrate.json`, the `workflow_run` tool, or by name from `.tugline/workflows/<name>.json`. Each item is a subagent (narrowed as above); at most `concurrency` run at once (capped by `workflow.maxConcurrency`); the total and per-item budgets are admitted before every model call, so the run stops at its budget and the rest is reported as skipped. A failing item is retried once; a stalled one (no progress for `stallMs` while no tool runs) is stopped and retried; the reduce step receives every result, failed ones included, as data. `task.command`/`task.script` (a per-item check, `{{item}}` inserted shell-quoted) and `reduce.command`/`reduce.script` are the only fields that run code: the workflow runs only after you approve it once, with every expanded command shown; without approval nothing runs. Runs are recorded in `.tugline/workflows/runs/`; `tug workflow run … --resume <runId>` re-runs only what did not succeed; `tug workflow list`, `/workflows`.

**Agent teams (v1.2 N34).** `/team <goal>` asks the agent to lead a team; `tug team run team.json` runs one from a file:
```json
{ "name": "bugfix", "goal": "make the tests pass",
  "members": [ { "name": "parser", "role": "fixes parse.py", "instructions": "…", "model": "small", "tools": ["read_file","edit_file","bash"], "isolation": "worktree" } ],
  "tasks": [ { "id": "parse", "title": "fix parse.py" }, { "id": "verify", "title": "run all tests", "deps": ["parse"] } ] }
```
- Members are long-lived subagents, each with its own context and (by default) its own git worktree; on disband their branches are listed and merge only through `worktree_merge`, which asks you. A member's model must be a configured profile.
- The shared board (`team_task_add`, `team_task_list`, `team_task_claim`, `team_task_update`) lives in `.tugline/teams/<id>/` (JSONL); claims are atomic across processes, and a task waiting on dependencies cannot be claimed.
- `team_send {to, text}` (a member, `lead` or `all`) is delivered at the recipient's next turn as `<untrusted_team_message>` data: it is never your words and never an approval; "APPROVED" in a message approves nothing. A message or board entry from a member that read untrusted content carries that taint to its reader, so the reader's outbound actions need your approval or run network-off.
- The lead waits (`team_wait`), steers (`team_steer`), stops (`team_stop`; its claimed tasks go back on the board) and disbands (`team_disband`: summary, branches, usage). You can talk to a member directly with `/team msg <member> <text>`.
- A claim is a lease (`team.claimLeaseMs`, 30 min) renewed while its holder works; a member that stops (budget, idle, error) gives its tasks back, and a claim whose holder vanished expires and the task is ready again.
- **Personas:** `{"name": "r", "agent": "reviewer"}` makes a member a saved agent definition (`.tugline/agents/reviewer.md` or `~/.tugline/agents/`): its prompt after the team prompt, its tools and mode, still narrowed to the lead, plus the team tools.
- **Outcome documents (advisory):** `team_outcome_create {title, sections}`, then members `team_outcome_attach {outcome, section, content}`; the lead `team_outcome_finalize` writes `.tugline/teams/<id>/outcomes/<id>.md` (per section the chosen or latest fragment). It says it is advisory: no agent reviews or approves another agent's text; fragments from members that read untrusted content are enveloped and taint their reader.
- **Board hosts:** `tug team host <team dir> --name <host>` works ready tasks from the board in another process (or on another machine sharing the directory): its claims are leases it renews while working; if it dies, its task returns to the board. It uses that machine's own configuration; a task written by a tainted member starts it tainted, and its results are untrusted data for the lead.
- **A2A inbound:** the `tug serve` owner issues a grant per outside caller (`tug team a2a grant acme --tools read_file,grep --max-tokens 50000`, or `a2a/grants/issue` with the server token). The caller calls `a2a/delegate {id, secret, task}` (the grant's public id and its secret) without the server token; that is the only method a grant reaches. The work runs in its own copy of the grant's workspace (a git worktree of HEAD, removed afterwards; or an empty scratch directory when the workspace is not a git repository), in `ask` mode (or `plan`; a grant can never use `auto` or `acceptEdits`), with read-only tools unless the grant names others (`--tools`), never network or MCP tools; reads and searches stay inside that copy and skip secret-looking files (`.env`, `secrets.*`, `credentials*`, keys and certificates), even tracked ones: a search reports only "skipped secret file"; `bash`, if granted, runs in a read-only, network-off sandbox. It starts tainted ("A2A request from acme"), and nothing it asks for can be approved (no human answers). One request at a time per grant; a call keeps its connection open until the result arrives and stops if the caller disconnects; revoking a grant (`tug team a2a revoke <id>`) stops its running request. A wrong secret closes the connection; repeated failures on one grant id make that grant wait (up to 60 s) without affecting other grants; failures are logged in `~/.tugline/a2a-audit.jsonl`. The server still binds loopback (use a tunnel or TLS proxy from elsewhere).
- External members get the team messages sent to them since their last run, newest first within `team.externalMessageChars` (6000).
- Limits: `team.maxMembers` (default 4, `team.maxMembersHard` at most 8), `team.maxTokens`/`maxCostUsd` (whole team) and `memberMaxTokens`/`memberMaxCostUsd` (each), `team.messagesPerMinute` (20), `team.idleTimeoutMs` (120 s), `team.maxMemberRuns` (12). Each refusal is typed (`member_limit`, `depth_limit`, `rate_limited`, `claim_conflict`, …).
- Members are narrowed to the lead (tools, mode, model; clamps journaled), their approval requests reach you labelled `[team/member]`, and a plan-mode member hands its plan to you, not to another agent. Every message and board change is in the hash-chained journal. The bundled `team-coordinate` skill describes how to lead.
- **External agent CLIs as members:** `{"name": "cl", "external": "cline"}` runs an R10 preset (cline, qwen-code, aider, …) or an agent you define in `team.externalAgents` (user config) as a member. You approve it once (the command is shown). It works in its own worktree inside the OS sandbox (bwrap on Linux, deny-by-default Seatbelt on macOS; refused without one): it sees the system directories read-only, an empty home, and only its worktree is writable (its `.git` is read-only); host sockets (Docker, ssh-agent) do not exist inside. It gets a dummy API key: its only network is the metering proxy, which adds the real credentials and admits each model call against the team budget and your C7 limits. If its CLI needs files from your home (an install directory), list them in `team.externalReadOnly` (user config). The harness claims a ready task for it, runs it, and records its output on the board as untrusted data (anyone reading it is tainted).
- `tug team watch <teamId> [--tmux]` shows each member's log; with `--tmux`, one display-only pane per member (`tail -F` of its log; approvals stay in your session).
- Visible in the CLI (`/team status`, `tug team run` progress), the VS Code Agents view (members, tasks and the latest messages under the lead's chat, live) and `tug serve` (`team` events).

**Routing.** `routing.planner` (the main loop in plan mode), `routing.summarizer` (compaction, auto-memory) and `routing.explore` (explore subagents) take profile names. Summarizer and explore fall back to `smallProfile`, then the main profile; planner falls back to the main profile. Every call's usage is tagged with its role. `routing.editor` names the apply model when `edit.applyModel` is not set, and `routing.approver` names the classifier profile when `approver.profile` is not set.

**Overlays.** Per-family prompt notes and request defaults for Qwen, gpt-oss, GLM, Kimi, DeepSeek, Llama, Mistral and Gemma. They only fill fields your profile does not set. `agent.modelOverlays: false` turns them off.

**Budgets and ceilings.** `agent.maxTurns` (60), `agent.maxCostUsd`, `agent.maxTokens` (absent = unlimited, `0` = exhausted), and the thrash ceiling `agent.maxRepeatFailures` (4 identical failing commands stop the run).

**Completion status.** Why a run stopped (`end_turn`, `budget`, …) is separate from whether the work is known to be correct. Only a check that **Tugline runs itself** can verify the work:

- **The check is fixed at the start of the run**, before the first edit. The first of these that exists is used:
  - the task's acceptance commands (eval tasks, `/goal --check`);
  - `agent.verifyCommands`;
  - the test / verify / check / typecheck commands in `AGENTS.md` (lines like ``- Tests: `npm test` ``; build and lint lines are not run);
  - otherwise, one detected from the project as it was before the run: the `test` script in `package.json` (`npm test`), pytest configuration or test files (`python3 -m pytest -q`), `go.mod` (`go test ./...`), `Cargo.toml` (`cargo test`).

  `agent.verifyCommands` is the reliable way to say what verifies your project.
- **Tugline runs it** when the agent's answer claims success, and at the end of every run that changed files, unless a check already ran after the last edit. It runs in the workspace root in a clean environment:
  - `PATH` without workspace or relative entries;
  - `PYTHON*`, `NODE_OPTIONS`, `NODE_PATH`, `npm_config_*`, `PYTEST_*`, `JEST_*`, `GOFLAGS`, `LD_PRELOAD` and similar variables removed;
  - a private Python bytecode cache, and no per-user site directory (`PYTHONNOUSERSITE=1`);
  - a fresh, empty home folder: your dependency caches and toolchains (`~/.cargo/registry`, `~/.rustup`, `~/go/pkg/mod`, `~/.m2/repository`, `~/.gradle/caches`, `~/.npm/_cacache`, `~/.pyenv`, `~/.nvm` …) are linked in, but no runner configuration from your home (`~/.npmrc`, `~/.gitconfig`, `~/.config`, `~/.gradle/init.d`, `~/.m2/settings.xml`, `~/.cargo/config.toml`, user-site Python modules) is, so nothing a run planted there can change the result;
  - nothing added to the command line.

  It follows the same permission rules and sandbox as the agent's own commands; in `ask` modes you are asked. `agent.harnessCheck: "off"` turns it off, and runs that change files then end `unverified`. `agent.checkTimeoutMs` (default 10 minutes) limits each command.
- **It is not run, and the run ends `unverified` with the files named, when the run created or changed anything the check would load as code:**
  - test scripts in `package.json`, `.npmrc`, `.yarnrc*`;
  - `conftest.py`, `pytest.ini` / `.pytest.ini`, the pytest sections of `pyproject.toml` / `setup.cfg` / `tox.ini`;
  - jest/vitest/babel configuration and test setup files, Makefiles, `tsconfig*.json`, and other runner configuration;
  - existing test files (new test files are fine);
  - the scripts the check command executes;
  - the `node_modules/.bin` entries it resolves, their packages and the lockfile;
  - a Python module at the top of an import path that shadows an installed or start-up module (`pytest.py`, `json.py`, `sitecustomize.py`, a sourceless `.pyc`), or a pytest plugin the configuration names.

  The same holds for a file an earlier run of the same session changed and left that way. A runner that resolves into the workspace must be a `node_modules` package pinned by a lockfile and unchanged in the run.
- **The commands the agent runs itself are evidence, not the verdict.** Each one is recorded with its exit code, time, and the files changed in the run with their versions (content hash) at that moment. The record also notes whether the editor held unsaved changes the command did not see, and whether it looked like a check (masked exit codes such as `|| true` and runs that execute no tests are noted). This evidence is shown, journaled and used in the nudge, but never decides `verified` or `failed`.

The check also does not verify when it reports no test passed (0 tests run, every test skipped), or when its runner is not installed (exit 127, `No module named pytest`). Each run ends with one of:

| State | Meaning |
|---|---|
| `verified` | the harness ran the project's check after the last edit, nothing it loads had changed, and it passed |
| `failed` | the harness's check after the last edit failed (or timed out) |
| `unverified` | files changed, but the harness could not verify: no check is configured or detectable, the run changed what the check loads, the runner is missing, or the check was refused or off |
| `not_applicable` | no files changed (explanations, reviews) |

If the final answer claims success ("all tests pass", "fixed", "verified", "works now") while the state would be `unverified` or `failed`, the agent is asked once to fix it or to say it could not be verified. A failed check comes with the tail of its output; an untrusted one comes with the files that made it untrusted. An answer that says it could not verify is accepted as an honest `unverified` exit. The CLI prints the state after each run and the VS Code chat shows it as a badge. It is also in `run_end` events and `RunResult.completion`, in journals (`evidence` records; the harness's have `byHarness: true` and their `source`), and the eval scorer uses it for `verified_pass`.

**Task brief.** Your original request and every later request, steer or correction are kept as a separate, journaled task brief. After every compaction it is re-inserted verbatim (up to 4,000 chars; longer briefs as an excerpt that keeps every constraint-like sentence, plus the `task_brief` tool to read it in full), so a constraint is never lost to a summary, also after resuming a session. A long request is re-inserted in a bounded structured form (its goal, every constraint-like sentence verbatim, the paths and names it mentions, and its opening); `task_brief {"entry": 1}` returns the original text in full.

**Session state.** The task brief, the task list, the verification evidence and each run's completion status are kept in a state file next to the session's journal (`~/.tugline/sessions/<project>/<session>.state.json`, written atomically, 0600), outside the conversation history. Restarting with the same session, or resuming it from the CLI (`--resume`, `/resume`), VS Code, ACP or the server, restores them; a resumed session records which sessions it continues. If the file is missing or damaged it is rebuilt from the journal.

**Unsaved editor changes.** In VS Code the agent saves the documents it edited before running a command, but not documents in which you have unsaved changes of your own. For those, `agent.unsavedBuffers` decides: `"ask"` (default: you are asked once per file, "save" or "disk"), `"save"`, or `"disk"` (run against the file on disk). The command's result and the verification evidence say which version was tested.

---

### Task board and arena (parallel work in worktrees)

**Task board** (`tug board`, `/board` in any chat, *Tugline: Open Task Board* in VS Code). Each card is an agent session in its own git worktree under `~/.tugline/worktrees/<repo>/`, so cards run in parallel without touching your working tree.

```sh
tug board add "Add a --dry-run flag to the CLI"           # from a prompt
tug board add --issue 42                                   # from a GitHub issue (gh); the issue text is treated as untrusted data
tug board add --pr 17                                      # continue a pull request (fetched as the card's base)
tug board add "Write the docs" --after add-a-dry-run-flag  # starts only after that card is merged
tug board add "Polish my WIP" --carry-dirty                # start from your uncommitted changes
tug board add "Refactor the parser" --agent cline          # run the card with an external agent (arena presets)
tug board start <id>…                                      # run cards (up to worktree.maxParallel)
tug board                                                  # columns: Backlog, Running, Review, Merged
tug board show <id>                                        # base commit, how far behind HEAD, check, conflicts, diff stat
tug board diff <id> [--since-last]  ·  tug board say <id> "also handle Windows paths"
tug board check <id>                                       # conflicts with HEAD and with your uncommitted files
tug board merge <id>                                       # conflict check → permission → verify → land
tug board discard <id>  ·  tug board pr <id>  ·  tug board gc
tug board log <id>                                         # the card's transcript
tug board exec <id> -- npm run dev                         # a command in the card's worktree (permissions, sandbox)
```

Cards from an issue or a pull request start tainted (untrusted content: network and other outbound actions ask), and a pull request's own `AGENTS.md`, `CLAUDE.md` and rules are never used as instructions; a card added by a session that had read untrusted content asks you first and starts tainted too. External agents never run tainted cards. `--yes` on `tug board` confirms only the merge step (warned and journaled; refused under a managed `disableAutoMode`); the card agents still ask you.

How a merge works: conflicts are found with `git merge-tree` before anything changes; every file the merge brings in is checked by the permission engine (a protected file is refused even if the card changed it only in git's index; CI and agent-control files always need you, not `--yes`), and the decision is journaled (`~/.tugline/sessions/<project>/board-*.jsonl` and the security events); a card that would touch a file you have uncommitted changes in is refused; the merge is asked like any `git merge` the agent would run (modes, deny rules, managed policy); the project check (`agent.verifyCommands`, AGENTS.md or detection, planned in your tree, never the card's) runs on the exact merged commit in a scratch worktree; a card that changed the check's own inputs (package.json scripts, runner config, existing tests, conftest.py, the scripts the check runs, CI files) is "altered", not verified, and needs `--force`; only then does the merge land, with your staged and unstaged work carried over. A check that already fails on HEAD is reported as pre-existing and does not block. Repository hooks and repo-named programs (`core.fsmonitor`, external diff drivers, the repository's own filter/merge/diff drivers from `.git/config` and `.git/info/attributes`) never run in harness git calls unless you set `"worktree": {"trustHooks": true}` in `~/.tugline/config.json`.

Settings (`worktree`): `maxParallel` (3), `verifyBeforeMerge` (true), `include` (copy files listed in `.worktreeinclude`), and, at user scope only, `root`, `symlinkDirs` (e.g. `["node_modules"]`), `trustHooks`, `autoStart` (start linked cards when their dependency merges). `boardTools: true` lets the agent add cards (`board_add_card`) when you ask it to break work down.

**Arena** (`tug arena`, `/arena`, *Tugline: Open Arena*). One task, several contestants in parallel worktrees, live side by side:

```sh
tug arena --models qwen3-coder-30b,qwen3.5-9b --agents cline "Fix the failing date test" --check "npm test"
tug arena … --parallel 1 --budget-tokens 200000 --max-turns 30 --pick auto
tug arena list · tug arena show <run> · tug arena pick <run> B · tug arena discard <run>
/arena start --models a,b "<task>" · /arena status · /arena steer A "use the helper in utils.ts" · /arena stop B · /arena pick A
```

Each contestant has its own session, budget, sandbox and protected paths, and is journaled. External agents (Cline, Aider, …, see `tug bench` presets), here, on board cards (`--agent`) and as team members, approve their own actions, so they always run in the OS sandbox: their version and setup commands too, package downloads only through the egress allowlist proxy, and the model reached through a local metering proxy. Where no OS sandbox is available (or `shell.sandbox` is `"none"`) they are refused unless you set `"external": {"allowUnsandboxed": true}` in `~/.tugline/config.json`; under a managed `disableAutoMode` or `disableYoloMode` they are refused. The harness check decides pass/fail; it is planned in your tree, and a contestant that changed the check's inputs is "altered" and ranks last. `--verify-goal` runs the goal verifier (N35) on each contestant after the check, and an unmet goal ranks lower; `--judge <profile>` adds an anonymised rubric judge. `--mode auto` is refused under a managed `disableAutoMode`. The pick is applied through the board's merge (above). Every run writes bench records: `tug bench --compare ~/.tugline/arena/<run>`.

### Code intelligence (language servers)

Turn on a language server per language (`"lsp": {"servers": {"typescript": true, "python": true, "go": true}}`), or `"lsp": {"autoDetect": true}` to enable every preset whose language is in the workspace and whose binary is installed (`tug lsp detect` shows what that would be). Presets: typescript, python (pyright), go (gopls), rust (rust-analyzer), java (jdtls), cpp (clangd). Custom servers take `command`, `args`, `extensions`, `extensionToLanguage`, `env`, `settings` (answers `workspace/configuration`), `initializationOptions`, `startTimeoutMs`, `restartOnCrash`, `maxRestarts`. Trusted plugins can declare servers in `.lsp.json`.

Tools: `code_definition`, `code_references`, `code_symbols`, `code_hover` (`kind`: hover, type_definition, implementation), `code_calls` (incoming / outgoing), `code_diagnostics` (`fixes: true` lists quick fixes with ids), `code_rename_preview` (returns an id), `code_apply` (applies a rename or a fix to every file at once: asked like any edit, protected files refused, a checkpoint first, undo with `/rewind <id>`).

Safety: servers always start through the OS sandbox (even with `shell.sandbox: "none"`; where none is available they need `"lsp": {"allowUnsandboxed": true}` in `~/.tugline/config.json`) with a scrubbed environment; code inside the workspace (where the agent can write) is never loaded unless you set `"lsp": {"allowWorkspaceBinaries": true}` there: not a server binary, not a script or `--option=path` argument naming a workspace file, not interpreter code paths (`PYTHONPATH`, `NODE_OPTIONS` …) in the server's env, and not the project's own TypeScript (the TypeScript server is pointed at a tsserver outside the workspace: the one next to the server, Tugline's own, or the global one); in VS Code the `code_*` tools use the editor's language features; `code_diagnostics` pulls diagnostics (LSP 3.17) from servers that offer them, including files no one opened; servers named in an untrusted project config are ignored; a server can never write files (`workspace/applyEdit` is refused) or run its own commands; only stdio servers are supported. A crashed server restarts on the next request with its open files (up to `maxRestarts`). `/lsp` (or `tug lsp`) shows each server's source, state, pid, restarts and errors; `/lsp restart [name]` restarts one.

## 8. VS Code

### Getting started
Install the `.vsix` (see the README), click the Tugline icon, then **Tugline: Configure LLM Endpoint**. The API key goes to SecretStorage (**Tugline: Set API Key** changes it). **Tugline: Test LLM Connection** re-runs the probe.

The panel has chat tabs and four views: **Chat**, **Checkpoints**, **MCP & Skills** and **Settings**. The **Agents** and **History** tree views sit next to it. The toolbar has the model picker, reasoning effort, permission mode and the context meter. The status bar shows the model and the sandbox state (the same line as the CLI banner): a warning background means commands run unsandboxed in `auto` or `yolo` mode, an error background means a required sandbox is missing and commands are refused.

### Everyday tasks
- **Review agent edits.** In `acceptEdits`, `auto` and `yolo` modes, edits land at once and appear in the Changes list above the composer. Use Diff / Keep / Undo per file, or the CodeLens Keep | Undo per hunk in the editor, or Keep all / Undo all. What you type yourself outside the agent's changes is never undone; if you type *inside* a changed hunk, that typing becomes part of the hunk and Undo of the hunk reverts it too. In `ask` mode you approve each edit in a diff first.
- **Inline edit.** Select code, Ctrl/Cmd+Alt+K, type the instruction. Accept or reject per hunk, or all with Ctrl/Cmd+Shift+Enter / Ctrl/Cmd+Shift+Backspace.
- **Add context.** Type `@` for files, folders, `@problems[:path]`, `@terminal`, `@git[:commit]`, `@url:<…>` and `@skill:<name>`. Ctrl/Cmd+Alt+L adds the selection.
- **Images.** Paste or drop PNG, JPG or WebP (up to 5 MB).
- **Steer.** While a run is going, Enter queues a message and Steer injects it at the next tool boundary. ✎ on an earlier message edits and resubmits it, optionally restoring files from that run's checkpoint.
- **Restore.** The Checkpoints view offers "Changes since", "Restore files" and "Restore files + chat".
- **Run sessions in parallel (Agents view).** The Agents view lists every chat and the background jobs it started: status (idle, queued, running, blocked, done, failed, stopped), the verified / failed / unverified result of the last run when the core reports one, queued prompts, and for worktree sessions the branch and diff stats. Click a row to open its chat. A session waiting for an approval shows **blocked**; answer it from the view (❓). **New Session in a Worktree** (branch icon) starts a chat whose agent works in its own `git worktree` on a new `oh/<id>` branch off HEAD, so several sessions can edit the same files without colliding. End a worktree session with **Merge** (its work is committed on the branch and merged into your current branch; a conflict aborts the merge and keeps the branch) or **Discard** (the worktree and branch are deleted). Either way `git worktree list` is back to your own worktrees.
- **Comment on agent changes.** On files with pending agent changes, the comment "+" appears in the gutter of each changed hunk. Write what should change and press **Add Comment for the Agent**. Comments stay as drafts until **Send N comments to the agent** (status bar, or the comment thread's title bar). They go to the chat whose agent made the change as one message, each with its path, line and the commented code: a steer if that agent is running (it sees it at the next tool boundary), else a new prompt. Sent comments are cleared.
- **Preview your app and point at elements.** **Tugline: Open Preview** shows a page (your dev server; loopback hosts by default, more with `tugline.preview.allowHosts`) in a side panel, rendered by the headless browser driver. Clicks and scrolling go to the page. Press **Pick element** and click: the element's accessibility ref, role and name, a CSS selector, computed styles and its likely source location are attached to your next message (`<attached_context source="element">`), and an `@file:lines` mention of the source is put in the composer. Navigation to a host that is not allowed is refused, and every request the page makes passes the SSRF guard.
- **Next-edit suggestions** (opt in, `tugline.nes.enabled`). After you edit, a Zeta-format model predicts the next change from your recent edits and the code around the cursor. The text it would replace is struck through and the new text appears as ghost text. When the suggestion is elsewhere, a hint says where: Tab jumps there, Tab again applies it, Esc dismisses. Requests that take longer than `tugline.nes.latencyMs` (400 ms) are cancelled. The suggested model is `zed-industries/zeta` (Apache-2.0, a Qwen2.5-Coder-7B fine-tune) served by vLLM (`vllm serve zed-industries/zeta`) or llama.cpp with a `/v1/completions` endpoint; set `tugline.nes.profile` to that profile.
- **Voice input** (opt in, `tugline.voice.enabled`). Press Ctrl/Cmd+Alt+V or 🎤 to start recording and again to stop. The audio is recorded locally (sox, ffmpeg or arecord), sent to your transcriber and dropped; it is never written to disk. The text lands in the composer for you to edit and send. Set `tugline.voice.transcriber` to a profile whose server has `/v1/audio/transcriptions` (whisper.cpp `whisper-server`, faster-whisper, vLLM), or `tugline.voice.url` to the full URL (no API key is sent to it). A transcriber that is not on this machine or your LAN asks before the first recording.
- **Stop everything.** Ctrl+Alt+Shift+Esc (Emergency Stop) aborts every chat, trips the automation kill switch in every Tugline process (STOP file) and interrupts visible terminals. **Tugline: Resume Automation** clears it.

### Commands

| Command | Title | Key |
|---|---|---|
| `tugline.newChat` | New Chat | |
| `tugline.stop` | Stop | |
| `tugline.clearChat` | Clear Chat | |
| `tugline.undo` | Undo Last Agent Edit | |
| `tugline.configure` | Configure LLM Endpoint | |
| `tugline.setApiKey` | Set API Key | |
| `tugline.testConnection` | Test LLM Connection | |
| `tugline.addSelection` | Add Selection to Chat | Ctrl/Cmd+Alt+L (with a selection) |
| `tugline.openConfig` | Open Project Config (.tugline/config.json) | |
| `tugline.showLog` | Show Log | |
| `tugline.showView` | Show View | |
| `tugline.inlineEdit` | Edit Selection with AI… | Ctrl/Cmd+Alt+K |
| `tugline.inlineAccept` | Accept Inline Edit | Ctrl/Cmd+Shift+Enter (inline diff visible) |
| `tugline.inlineReject` | Reject Inline Edit | Ctrl/Cmd+Shift+Backspace (inline diff visible) |
| `tugline.review.keepHunk` / `undoHunk` | Keep Change / Undo Change | |
| `tugline.review.keepFile` / `undoFile` | Keep / Undo Agent Changes in This File | |
| `tugline.review.keepAll` / `undoAll` | Keep / Undo All Agent Changes | |
| `tugline.review.openAll` | Review All Agent Changes | |
| `tugline.emergencyStop` | Emergency Stop (all agents and automation) | Ctrl+Alt+Shift+Escape (all platforms) |
| `tugline.resumeAutomation` | Resume Automation (after an emergency stop) | |
| `tugline.openReplay` | Open Browser Run Replay… | |
| `tugline.history.resume` / `rename` / `delete` / `search` / `clearSearch` / `refresh` | History view actions | |
| `tugline.agents.newWorktreeSession` | New Session in a Worktree | |
| `tugline.agents.open` / `answer` / `stop` / `merge` / `discard` / `refresh` | Agents view actions | |
| `tugline.reviewComments.send` | Send Review Comments to the Agent | |
| `tugline.reviewComments.clear` | Discard Review Comments | |
| `tugline.preview.open` | Open Preview (pick elements for the chat) | |
| `tugline.preview.pick` | Pick Element in Preview | |
| `tugline.nes.trigger` | Suggest Next Edit | |
| `tugline.nes.accept` / `dismiss` | Accept (jump, then apply) / Dismiss Next Edit | Tab / Esc (suggestion visible) |
| `tugline.voice.toggle` | Voice Input (push to talk) | Ctrl/Cmd+Alt+V (voice enabled) |
| `tugline.openWiki` | Open Wiki (builds it first if there is none) | |
| `tugline.generateDocs` | Generate Docs for Selection (`/doc` at the cursor; editor context menu) | |

### Parity features (v1.2)
- **Auto-approve…** (chat view title, or the command): tick what may run without asking: read-only commands, edits in the workspace, web fetch/search, the browser, the tools of MCP servers you pick, auto mode with the safety classifier, or everything (yolo). They are written as permission configuration in `~/.tugline/config.json` (`ide.autoApprove` lists them); deny rules, protected paths, secret files, the sandbox and managed policy still apply. "Read-only commands" is not a list of wildcard rules: it sets `permissions.readOnlyCommands`, and a command runs unasked only when the read-only checker accepts it (`ls`, `cat a.txt`, `git status`, `grep -rn TODO src`, pipes of such commands) on files inside the workspace; `find -exec/-delete/-fprint`, `git --output`, redirections, `$VAR`/glob expansion, `.env` and other secret files, and any path outside the workspace still ask. "MCP servers" writes one rule per server you name (`mcp__<server>__*`), never all servers. Reading outside the workspace is not offered: it would cover credential stores.
- **Task board** and **Arena** views (Agents view title buttons): see "Task board and arena" above.
- **History**: star sessions (listed first), export (Markdown, HTML, JSON), delete all (favourites kept; to the trash), size.
- **Editor**: *Explain Code*, *Improve Code* (editor context menu), the *Fix with Tugline* quick fix on any diagnostic, *Add Terminal Output to Tugline Chat* (terminal context menu), *Focus Chat Input* (Ctrl/Cmd+'), *Generate Commit Message* (Source Control title; fills the message box, never commits), notebook *Explain / Improve Cell* and *Generate Cell*, *Compare Checkpoint with Current Files*, *Copy Conversation*, *Star / Unstar a Model* (`tugline.favoriteModels`).
- **Editor context** (`tugline.ideContext`, off by default): each prompt carries the open editors, the active file and cursor, and the selected text.
- Every `/command` of the CLI's shared set (`/export`, `/copy`, `/diff`, `/btw`, `/commit`, `/recap`, `/effort`, …) also works in the chat.

### Settings

Settings marked *app* are application-scoped: a workspace's `.vscode/settings.json` cannot set them.

| Setting | Default | Scope | Meaning |
|---|---|---|---|
| `tugline.baseUrl` | `http://localhost:11434/v1` | app | OpenAI-compatible base URL |
| `tugline.model` | `qwen3-coder:30b` | | model name |
| `tugline.contextWindow` | `32768` | | context window in tokens |
| `tugline.maxOutputTokens` | `8192` | | max tokens per reply |
| `tugline.temperature` | `0.2` | | sampling temperature |
| `tugline.toolMode` | `auto` | | `auto` / `native` / `text` |
| `tugline.vision` | `false` | | the model accepts images |
| `tugline.extraHeaders` | `{}` | app | extra HTTP headers |
| `tugline.permissionMode` | `ask` | app | `ask` / `acceptEdits` / `plan` / `auto` / `yolo` |
| `tugline.promptStyle` | `full` | | `full` / `compact` |
| `tugline.shellMode` | `shell` | app | `shell` / `allowlist` |
| `tugline.protectedPaths` | `[".git/**"]` | | globs the agent may never modify |
| `tugline.autoValidate` | `false` | app | validator subagent before finishing |
| `tugline.webSearchProvider` | `duckduckgo` | app | `duckduckgo` / `searxng` / `brave` / `tavily` / `none` |
| `tugline.searxngUrl` | `""` | app | SearXNG URL |
| `tugline.mcpServers` | `{}` | app | MCP servers, `.mcp.json` shape |
| `tugline.maxTurns` | `60` | app | turns per prompt |
| `tugline.autoSave` | `true` | | save after an agent edit unless you had unsaved changes |
| `tugline.visibleTerminal` | `false` | app | run commands in a visible terminal |
| `tugline.planProfile` | `""` | | profile for Plan mode (`routing.planner`) |
| `tugline.inlineEditProfile` | `""` | | profile for inline edits (empty = chat's) |
| `tugline.visionProfile` | `""` | | vision profile that describes pasted images |
| `tugline.ocr` | `false` | | OCR pasted images with tesseract |
| `tugline.notifications` | `true` | | notify on long runs and waiting approvals |
| `tugline.notifyAfterSeconds` | `30` | | threshold for "run finished" notifications |
| `tugline.autocomplete.enabled` | `false` | | tab autocomplete (FIM) |
| `tugline.autocomplete.profile` | `""` | | profile with the FIM endpoint |
| `tugline.autocomplete.endpoint` | `completions` | | `completions` / `llama-infill` |
| `tugline.autocomplete.template` | `qwen` | | `qwen` / `codestral` / `deepseek` / `suffix` |
| `tugline.autocomplete.debounceMs` | `250` | | debounce |
| `tugline.autocomplete.maxTokens` | `128` | | max tokens per completion |
| `tugline.browser.enabled` | `false` | app | give the agent the `browser_*` tools |
| `tugline.approver.enabled` | `false` | app | auto-mode approver |
| `tugline.approver.profile` | `""` | app | approver profile |
| `tugline.preview.allowHosts` | `[]` | app | preview hosts besides loopback (`*.test` style patterns) |
| `tugline.nes.enabled` | `false` | app | next-edit suggestions |
| `tugline.nes.profile` | `""` | app | profile with the next-edit model's `/v1/completions` |
| `tugline.nes.latencyMs` | `400` | | cancel a next-edit request after this long |
| `tugline.nes.maxTokens` / `nes.debounceMs` | `512` / `150` | | |
| `tugline.voice.enabled` | `false` | app | push-to-talk voice input |
| `tugline.voice.transcriber` | `""` | app | profile serving `/audio/transcriptions` (its key is used) |
| `tugline.voice.url` | `""` | app | or the full transcription URL (no key sent) |
| `tugline.voice.model` / `voice.language` | `whisper-1` / `""` | | model name, language hint |
| `tugline.voice.recorder` | `auto` | | `auto` / `sox` / `ffmpeg` / `arecord` |
| `tugline.voice.maxSeconds` | `60` | | a recording stops by itself after this long |

VS Code settings override the config files. Other sections (desktop, sandbox, limits, schedules) are set in `~/.tugline/config.json`; the extension reads it too. Pending review state lives in `workspaceState`; chat titles in `~/.tugline/sessions/<project>/titles.json`; deleted chats move to `…/trash/`.

---

## 9. Browser automation

Turn it on with `"browser": { "enabled": true }` (or `tugline.browser.enabled`). It needs Playwright (an optional dependency that `npm install` installs unless optional dependencies are omitted) and a Chromium build (`npx playwright install chromium`, or the system Chrome); `TUG_CHROMIUM_PATH` or `browser.executablePath` point at a specific binary.

- **Tools.** `browser_open`, `browser_navigate`, `browser_snapshot`, `browser_act`, `browser_type`, `browser_key`, `browser_scroll`, `browser_wait`, `browser_extract`, `browser_verify`, `browser_tabs`, `browser_dialog`, `browser_download`, `browser_screenshot`, `browser_point`, `browser_task`, `browser_close`.
- **How the model sees a page.** An accessibility tree with `[ref=…]` handles, pruned and capped at `browser.snapshotTokens` (5000). Each action returns `outcome` (confirmed, suspected_noop, failed, refused, partial), a diff and an optional `expect` check.
- **Cascade.** `browser_task "<goal>"` tries preconditions (CAPTCHA, login walls), then a plain guarded fetch, then a recorded recipe, then a small-model sub-loop over the tree, then pixels.
- **Guards in code.** At most `browser.maxActionsPerTurn` (2) actions per turn, and dropdown openers, submits and navigation alone in their turn; `actionsPerMinute` (60); 3 identical actions stop; destructive clicks need an `expect`; dialogs are never auto-accepted.
- **Profiles.** `isolated` (default, fresh), `persistent:<name>` (keeps logins in `~/.tugline/browser-profiles/<name>`), `attached` (your Chrome over a debug port; see below), `extension` (tabs you share from your everyday browser through the Tugline extension; see below).
- **Network safety.** Launched browsers send every request and redirect through a local egress proxy with the SSRF guard. Localhost and intranet hosts need `web.allowHosts`. WebRTC UDP is disabled.
- **Secrets.** Store a value with `/browser secret <name>` (asked from you, never through the model), or `TUG_SECRET_<NAME>`. The model types it with `browser_type {secret: "secret://name"}`. The value is masked in snapshots, screenshots and recordings. `/browser secrets` lists names.
- **Handoff.** Card fields, pay/checkout submits, OTP/2FA fields and CAPTCHAs return `needs_human` or `blocked_captcha`. `browser.allowPayments: true` lifts the payment rule.
- **Text-only pixels.** `"perception": { "backend": "ocr" }` uses tesseract regions for canvas content; `"grounder"` uses a UI-grounding VLM (`perception.grounder.baseUrl`, `model`). Vision profiles get screenshots with set-of-marks instead.
- **Attach to your Chrome.** Start Chrome with `--remote-debugging-port=9222 --user-data-dir=/tmp/oh-chrome` (a non-default profile dir), then set `browser.cdpUrl: "http://127.0.0.1:9222"` and `browser.attachedAllowDomains: ["github.com"]`. The agent asks once per session; navigation outside the list is refused. Closing the session closes the agent's own tabs and disconnects.
  - Your Chrome doesn't go through the egress proxy, so the agent checks every request and redirect hop of the tabs it opened (cross-site iframes included) at the DevTools `Fetch` stage, before it is sent (since v1.1). A page or redirect outside `attachedAllowDomains` is refused, and so is any request to a private, loopback or metadata address (unless the host is in `web.allowHosts`). Images, scripts and other subresources from public third-party hosts (CDNs) load normally; set `browser.attachedStrictSubresources: true` to require those on the allowlist too.
  - Your other tabs are never intercepted or driven.
  - Not covered in attached mode: the very first request of a popup (checked as soon as it opens, and a refused popup is blanked), requests made by a site's service worker, redirect hops of worker requests, and DNS rebinding (Chrome resolves names itself). For untrusted sites, prefer the default `isolated` profile, which goes through the egress proxy.
- **Your real browser, through the extension (v1.1).** Since Chrome 136 the debug port needs a separate profile, which has none of your logins. The Tugline extension (`browser-extension/`, Chrome or Edge, MV3) works in your normal profile instead:
  1. `tug browser-extension pair` prints the folder to load (`chrome://extensions` → Developer mode → **Load unpacked**), the server URL and a pairing token. The token lives in `~/.tugline/browser-extension.json` (mode 0600); `--rotate` replaces it.
  2. In the extension's options page, paste the URL and token, and list the **sites the agent may use**. A page must be on this list *and* on `browser.attachedAllowDomains`; the extension and the harness each refuse on their own.
  3. Run `tug serve` and set `browser.extensionEnabled: true`. On a page you want help with, click the toolbar button (**Share this tab with Tugline**). Only tabs you share are ever visible to the agent. It cannot open, pick or share tabs itself, and a popup a shared tab opens is not shared.
  4. The agent uses `browser_open {profile: "extension"}`. It asks once per session, shows a banner, and then has the same `browser_*` tools, snapshots, `expect` checks and masking as any profile. Page content is wrapped as untrusted.
  - **While an agent is connected**, Chrome shows its "started debugging this browser" bar and the button shows a red **ON**. The extension guards every request of the shared tab, its cross-site iframes and its workers before they are sent. It refuses top-level pages outside both lists, private, loopback and metadata addresses (unless in `web.allowHosts`), and with "strict subresources" checked, third-party subresources too. It also asks the harness, which resolves DNS and applies the SSRF guard. Cookie reads, new tabs and browser-wide commands are not available through the extension.
  - **Secrets.** `secret://` values are filled into the page by the extension, travel only over the paired localhost socket, and are never returned or shown to the model.
  - **Stop.** `/browser stop` (or Emergency Stop) detaches every shared tab within a second and stops sharing. So do the options page's **Stop** button and cancelling Chrome's debugging bar. You share again when you want to.
  - Not covered: a site's service-worker requests, and DNS rebinding (Chrome resolves names itself).
- **Teach a workflow by doing it (v1.1).** `tug record-skill <name> --url <start page>` opens a browser (profile `persistent:demo` by default, so logins you make there persist; `--profile` to change). Do the task once, then press Enter in the terminal.
  - What you click, type, check and select is recorded by the element's role and name (the same semantic keys replay uses). Your page scripts and synthetic events are ignored.
  - **Password, one-time-code and card fields are masked as you type**: their values are never read. They become `secret://<skill>/<field>` refs; store each once with `/browser secret <skill>/<field>`.
  - Other typed text becomes a **parameter** (`{{username}}`). Its value is used once, in memory, for the verification run, and never written. Choices you selected become parameters with that choice as the default. A navigation after an action becomes a URL check on it, and text that appeared at the end becomes a final check, without words from what you typed.
  - You then see the draft (steps, inputs, secrets) and the result of a **strict replay with no model**, and nothing is saved until you say yes. It writes `<workspace>/.tugline/skills/<name>/SKILL.md` (`--user` for `~/.tugline/skills`), an L2a recipe in `browser.recipesDir`, and the masked, parameterised trajectory under `.tugline/runs/demo-<name>-…/`.
  - Edit the SKILL.md freely. The agent runs the skill with `browser_task {goal: "<name>", url, params: {…}}`, which replays the recipe with no model (`path: L2a`) and falls back to the tree if the page changed.
  - `tug record-skill <name> --from <runDir>` turns an existing browser or desktop recording into a skill the same way (`--yes` skips the prompt, `--no-verify` the replay).
- **Recording and replay.** Runs are recorded to `<ws>/.tugline/runs/<session>/` (`browser.record`). `tug replay <run> --check` replays strictly with no model and exits 0/1; `--heal` repairs renamed selectors; `--export flow.spec.ts` writes a Playwright test; `--recipe <name>` saves an L2a recipe to `~/.tugline/recipes/`; `--html` writes a report. VS Code: **Tugline: Open Browser Run Replay…**.
- **Stop.** `/browser stop` closes every browser session; tools refuse until `/browser resume`. Emergency Stop and `tug emergency-stop` do the same.

---

## 10. Desktop automation

Turn it on with:
```jsonc
"desktop": { "enabled": true, "autoApproveApps": ["Calculator"] }
```

**Backends** (`desktop.backend`):
- `cua` — cua-driver (`pip install cua-driver`; pinned to 0.37 by `desktop.cuaDriverVersion`). On macOS grant Accessibility to CuaDriver.app.
- `sidecar` — our Linux AT-SPI sidecar (needs `python3-gi gir1.2-atspi-2.0 at-spi2-core xdotool`, X11 recommended) or Windows UIA sidecar (PowerShell).
- `sandbox` — the Docker desktop from `tug desktop-sandbox up [--build]` (watch it at `http://127.0.0.1:6080/vnc.html`; `down` removes it).
- `auto` (default) — cua-driver when on PATH, else the OS sidecar.

**Tools.** `desktop_apps`, `desktop_windows`, `desktop_snapshot`, `desktop_act`, `desktop_set_value` (accepts `secret://`), `desktop_type`, `desktop_key`, `desktop_menu`, `desktop_scroll`, `desktop_verify`, `desktop_screenshot`, `desktop_point`, `desktop_clipboard`, `desktop_electron`. Only the main agent gets them.

**Approvals.** Every action asks unless its app is in `autoApproveApps`, in every permission mode (in yolo mode the tool asks "Allow <app> for this session"; with no user it returns `needs_human`; in auto mode the auto-mode floor sends it to you). `desktop_point` asks unless `desktop.allowPoint`. Clipboard access and Electron relaunches always ask. Plan mode denies.

**What happens on an action.** Resolve the ref, run the guard (kill switch, self-protection, destructive needs `expect`, fence, rate limit), act, re-scan, diff, check `expect`. An unchanged window gives `suspected_noop`. An empty tree is diagnosed: `permissions`, `not_activated` (the window is activated and re-scanned once), `qt_a11y_off`, `electron_opaque` (use `desktop_electron`), `canvas` (use `desktop_screenshot` regions + `desktop_point`).

**Self-protection.** The agent never acts on the harness process, its parent terminal or editor, VS Code, or apps in `desktop.denyApps`.

**Kill switch.**
- `tug emergency-stop` from any terminal, or `touch ~/.tugline/STOP`. Every Tugline process stops desktop and browser automation within a second.
- Ctrl+C twice during a run, `/desktop stop`, or VS Code Emergency Stop.
- Resume with `/desktop resume` or `tug emergency-stop --clear`.

**Recording.** Desktop runs go to `.tugline/runs/<session>-desktop/`. `tug desktop-replay <dir> --check` replays strictly with no model.

---

## 11. Editors, server, SDK, MCP and plugins

### ACP editors
`tug --acp` (or `tug acp`) speaks the Agent Client Protocol on stdio. The README has the Zed, JetBrains and Neovim configuration. File reads and writes go through the editor (unsaved buffers included); shell commands see the disk. Approvals use the editor's permission dialog. `ask_user` has no ACP equivalent, so questions get "no user available". Sessions can be reloaded; `~/.tugline/acp-sessions.json` maps ACP ids to journals.

### Server mode
```bash
tug serve                       # ws://127.0.0.1:7878, prints a token on stderr
tug serve --stdio               # JSON-RPC over stdin/stdout, no token
tug serve --with-daemon         # also runs the scheduler and serves /hooks/<id> on the same port
```
> **Single-user.** `tug serve` is a companion process for **one user on one machine**: it listens on loopback. The server token is the owner's; anyone who can read `~/.tugline/server.json` or reach the port with it acts as you. Do not expose it to other people (a shared host, a port forward for a team, a reverse proxy without its own authentication) and do not treat it as a multi-user service. For a team, run one server per user, and put model access and shared budgets behind your company's model gateway, which sees every request (a local server and its limits run on a machine the user controls).

**Per-client tokens (R16).** Give each client (an editor, a CI job, a script) its own token instead of the server token:
```bash
tug serve tokens add ci-runner    # prints a client token once (stored hashed in ~/.tugline/server-tokens.json)
tug serve tokens list
tug serve tokens revoke ci-runner
```
- A client token sees and addresses only the sessions it created or loaded, from any number of connections. Another client's session id answers "unknown session", exactly like a missing one, so the id is not even confirmed.
- `session/list` and the saved-session list show only the client's own sessions.
- The server token (the owner) can address every session and manage tokens over RPC (`tokens/issue`, `tokens/list`, `tokens/revoke`). A revocation over RPC also closes that client's open connections. A revocation with the CLI takes effect at the client's next `auth`.
- This separates the clients of one user's server. It is not multi-user authorisation (no SSO or roles).

- Binds 127.0.0.1 only. The token is random (or `TUG_SERVER_TOKEN`) and also written to `~/.tugline/server.json` (0600, removed on exit). The first message must be `auth {token}`.
- WebSocket upgrades with an `Origin` header are refused unless listed in `server.allowedOrigins`; the `Host` header must be loopback.
- An approval with no client attached, a client that leaves, or no answer within `server.interactionTimeoutMs` (5 min) becomes a recorded deny.
- `server.allowedRoots` restricts session workspaces.
- Methods: `auth` (answers with the principal: `owner` or `client:<id>`), `tokens/issue|list|revoke` (owner only), `initialize`, `session/create|list|load|delete|subscribe|unsubscribe|prompt|steer|enqueue|abort|command`, `session/permissionReply|askReply|planReply|elicitReply`, `config/get` (redacted), `config/set` (only `permissionMode`, `profile`, `outputStyle`), `checkpoints/list|restore`, `jobs/list`, `remote/run`.
- Clients: `OhClient` (`tugline/sdk`) and `sdk/python/tugline_client.py` (stdlib only; WebSocket or `spawn(["tug","serve","--stdio"])`).

`tug daemon` listens on port 7880 (`schedule.port`) and `tug channels start` on 7879, so all three can run together. `tug serve --with-daemon` serves the webhook routes on the server port instead. Every one of these listeners binds 127.0.0.1 only; see "Receiving webhooks from outside" in [§12](#schedules-and-triggers).

### Remote agents
Off by default. On the build box: `tug serve --remote` (add `--allow-local-repos` for local paths and `file://`). Reach it through an SSH tunnel or a TLS reverse proxy, since it binds loopback only. From a clone on your machine:
```bash
TUG_SERVER_TOKEN=… tug remote run --server ws://127.0.0.1:7878 "fix the failing test"
```
The server clones your `origin` and branch into `~/.tugline/remote-workspaces/` (hooks and submodules off), runs the prompt in `acceptEdits` mode (`server.remote.mode`), streams approvals to your terminal (no TTY = deny), and returns a patch. You review it; `git apply --check` runs first. `--yes` applies without asking, `--no-apply` never applies, `--patch-file f` saves it. Only https, ssh and `git@` URLs are accepted.

### SDK
```ts
import { createAgent, defineTool, defineSkill, run, connect } from 'tugline/sdk';
```
See `examples/sdk/basic.mts`. `defineTool` requires `kind` so you choose the permission class. Without an `onPermission` handler every ask is denied and recorded. The config goes through `loadConfig`, so trust and managed policy apply.

### MCP
- Configure servers in `mcpServers` or `.mcp.json` (stdio `command`/`args`/`env`, or `url`/`headers`). Calls ask unless the server is `trusted: true` or an allow rule matches.
- Tools appear as `mcp__<server>__<tool>`. Definitions are fingerprinted at connect; if they change, calls are blocked until restart. Descriptions are scanned for injection.
- `mcp_resource {server, uri?}` lists or reads resources. Prompts become `/mcp:<server>:<prompt>`.
- Elicitation forms are shown by the surface, or asked one field at a time; with no UI they are declined.
- OAuth: add `"oauth": true` (or `{clientId, clientSecret?, scope?, redirectPort?}`) to a `url` server and run `tug mcp login <server>`. Tokens go to `~/.tugline/mcp-oauth/<server>.json` (0600), bound to the server URL. `tug mcp logout <server>` removes them.
- `tug mcp search <query>` searches the public registry; `tug mcp list` shows configured servers and login state. VS Code's MCP & Skills view shows status, toggles enable and trust, searches the registry and adds servers. Its "Log in (OAuth)" button is not wired yet: run `tug mcp login <server>` in a terminal instead (tokens are stored under `~/.tugline`, which the extension also uses).

### Plugins
```bash
tug plugin install ./my-plugin --trust        # --trust is honoured for local paths only
tug plugin install https://github.com/acme/oh-tools.git --ref main
tug plugin marketplace add https://example.com/marketplace.json
tug plugin install tools@acme
tug plugin trust tools --yes                  # lets its hooks and MCP servers run
```
A plugin (`tugline-plugin.json` or Claude Code's `.claude-plugin/plugin.json`) contributes skills, agents and commands, which load once enabled, and hooks and MCP servers, which run only after `tug plugin trust`. Trust records a hash of every file, so any change voids it. Plugin hooks also need hook approval. Plugin MCP servers are named `<plugin>-<server>`, and a plugin can never mark its server `trusted`. State lives in `~/.tugline/plugins/`. `plugins.enabled: false` turns all plugins off. Managed `allowMcpServers`, `allowSkills` and deny rules apply to plugins too.

### Output styles and status line
- `outputStyle`: `default`, `concise`, `explanatory`, or `custom:<name|file>` (looked up in `.tugline/output-styles`, `.claude/output-styles` and the home equivalents; `.md` or `.txt`). `/output-style <style>` switches from the next prompt.
- `statusLine: { "command": "~/bin/oh-status.sh" }` gets JSON on stdin (`model`, `cost`, `context.percent`, `mode`, `workspace`, `session_id`) and its output (3 lines max, 2 s timeout) is shown above the CLI prompt. A command set only in project config needs `/statusline approve`.

---

## 12. Schedules, webhooks, channels, review and telemetry

### Schedules and triggers
```bash
tug schedule add --cron "0 9 * * 1-5" --prompt "Summarise yesterday's git log into NOTES.md"
tug schedule add --watch "src/**/*.py" --prompt "Run the tests and fix new failures" --mode acceptEdits
tug schedule add --github pull_request.opened --prompt "Review the PR" --max-runs 10 --budget 2
tug schedule add --webhook --prompt "Handle the alert in the payload"
tug daemon                                     # runs them; Ctrl+C to stop
tug schedule install-service                   # launchd plist (macOS) or systemd user unit (Linux)
tug schedule report --since 24h                # what ran, what was refused, what is waiting
```
Options for `add`: `--tz local` (cron is UTC by default), `--workspace`, `--profile`, `--mode`, `--name`, `--max-runs` (per day; default `schedule.defaultMaxRunsPerDay` 24), `--budget` (USD per day), `--run-budget` (USD per run), `--daily-tokens` / `--run-tokens`, `--daily-gpu-seconds` / `--run-gpu-seconds` with `--gpu-share 0..1`, `--isolation wait|worktree`, `--ignore-actor a,b`, `--debounce` (ms, for `--watch`).

**Budgets are reserved.** When an event is admitted, the run *reserves* its share of the day's window under a file lock: `--run-budget` if set, otherwise everything still unreserved. A second event that arrives while the first run is in flight therefore cannot get the same ceiling. It is refused (`governor_budget`, "reserved by runs in flight") unless `--run-budget` leaves room for it. When the run starts, the budget is checked again: if another process spent the window meanwhile, the run does not start, and its record says `status: budget`. When it ends, the reservation is replaced by what the run really spent. An exhausted window always means *refused*, never *unlimited*. For a local endpoint with no per-token price, budget in tokens (`--daily-tokens`) or GPU-seconds (`--daily-gpu-seconds`: wall time × `--gpu-share`, the fraction of the GPU the endpoint gets). The run stops before its next model call once its share is used.

**Pause, resume, cancel.** `tug schedule disable <id>` pauses a schedule. Its parked waits stay dormant: a matching event is kept on the wait (the latest one), and a time wait that comes due is not resumed. `tug schedule enable <id>` reactivates them, and the daemon's next tick delivers the kept event or resumes the due time wait, once. `tug schedule remove <id>` and `tug schedule cancel <handle>` invalidate waits: they never resume. `tug schedule waits` lists them with their state. Before a parked run resumes, it passes the same checks as a new run: the schedule must exist, be enabled and accept the event (addressed to it, not from an ignored actor), and the budget must have room. A claim on a wait is a lease until the resumed run is durable (`schedule.claimLeaseMs`, default 10 min). If the process dies in between, the daemon resumes it again after the lease expires.

**One writer per workspace.** A scheduled run holds the workspace's lease. A second schedule on the same repo waits for it (up to `workspaceLease.waitMs`, 30 min), or, with `--isolation worktree`, runs in its own git worktree, with its changes committed on an `oh/sched-…` branch. Interactive sessions (CLI, `tug serve`, VS Code) take the same lease for each run. They are never blocked by default: they run with a warning that names the other writer (`workspaceLease.interactive: "wait"` makes them wait instead). A session's background jobs keep the lease until they exit. `tug lease status [--all]` shows who holds what, and `tug lease break` removes a lease by hand. A dead holder's lease (stale heartbeat, or a process that is gone) is taken over automatically.

How a trigger is handled, in this order: per-source rate limit, dedupe on the delivery id, refusal of the harness's own events, parked waits, matching against schedules, then the daily run and budget window (each run's cost ceiling shrinks to what is left). Every step is logged to `~/.tugline/schedule/activity.jsonl` and shows in the report.

Runs are headless and use the schedule's `--mode`, default `ask`, which means every approval is denied and recorded. Your own `permissionMode: auto` never applies to a schedule. Event data is wrapped as untrusted. A scheduled run can call `wait_until` to park until an event or time; the matching event resumes the same run.

**Webhooks.** `--webhook` and `--github` print a URL (`POST http://127.0.0.1:7880/hooks/<id>`) and a secret, shown once and stored in the vault. Sign bodies with HMAC-SHA256 as `X-OH-Signature: sha256=<hex>` or GitHub's `X-Hub-Signature-256`. Without a secret the endpoint answers 503. `tug schedule secret <id>` rotates it. `GET /hooks/_liveness` returns 200 while the daemon's heartbeat is fresh, else 503. `tug serve --with-daemon` serves the same routes on the server port.

**Receiving webhooks from outside.** The webhook listener binds 127.0.0.1 only: `tug daemon` on `schedule.port` (default 7880) and `tug serve --with-daemon` on the server port (default 7878). `tug daemon` refuses a non-loopback `schedule.host`. GitHub and other external senders cannot reach it directly, so publish it through a TLS reverse proxy or a tunnel that forwards to `http://127.0.0.1:7880`, for example:

```
# Caddy (automatic TLS)
hooks.example.com {
  reverse_proxy /hooks/* 127.0.0.1:7880
}
# or a tunnel
cloudflared tunnel --url http://127.0.0.1:7880
ngrok http 7880
```

Then use `https://<public host>/hooks/<id>` as the GitHub payload URL. Forward only `/hooks/*`. The HMAC signature still authenticates every delivery, and `/hooks/_liveness` is best kept internal.

### Channels
```bash
echo "$BOT_TOKEN" | tug channels token telegram-bot
# config: "channels": { "telegram": { "enabled": true } }
tug channels pair telegram --owner             # prints "/pair <code>", valid 10 minutes, single use
tug channels start                             # Telegram long-poll; Slack/webhook on 127.0.0.1:7879
```
Send `/pair <code>` to the bot from your account. Then:
- **Owner** messages are prompts for a headless agent (`channels.ownerMode`, default `ask`, so approvals are denied and listed in the reply).
- **Paired** users' messages are wrapped as untrusted (`channels.pairedMode`, default `ask`).
- **Everyone else** can only send `/pair`. Their other text is ignored (`channels.untrusted: "ignore"`), or gets one tool-less answer with `"readonly"`. They never reach an agent or a tool.

Slack uses the Events API at `/channels/slack/events` (signing secret `slack-signing`, bot token `slack-bot`); the generic signed webhook is `/channels/webhook` (secret `channel-webhook`). Replies stream as edits of one message. `tug channels list` and `tug channels unpair <channel> <userId>` manage pairings. Tokens are redacted from replies; decisions go to `~/.tugline/channels/actions.jsonl`.

### PR review
```bash
tug review --base main                          # markdown findings
tug review --base main --format github --fail-on high   # workflow annotations; exit 1 on high findings
```
The reviewer can only use `read_file`, `list_dir`, `glob`, `grep` and `load_skill`, whatever your mode. The diff is treated as untrusted. Findings must point at a file in the diff and a valid line, or they are dropped and listed. In GitHub Actions use `.github/actions/tugline-review` with inputs `base-url`, `model`, `api-key` (required) and `base`, `fail-on`, `post-comment`, `github-token`, `tool-mode`.

### OpenTelemetry
Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), or `"telemetry": { "enabled": true, "endpoint": "http://localhost:4318/v1/traces" }`. The `@opentelemetry/*` packages are optional dependencies, loaded only when telemetry is on; if they are missing you get one notice. Spans: `run` → `turn` → `llm.call` / `tool.call`, subagents nested under their `task` span, with GenAI attributes and cost. Prompts, arguments and outputs are left out unless `telemetry.includeContent: true`. `telemetry.enabled: false` keeps it off even when the env var is set.

---

## 13. Evaluation

```bash
tug eval evals/coding-basics --arms guarded,baseline --repeats 3
tug eval evals/editing -y --text-tools --tasks py02-crlf,go05-crlf-stack
tug rescore eval-results/<run-dir>               # re-score raw runs without calling a model
```
Suites: `coding-basics` (source repair, integrity temptation, unavailable dependency, Node and multi-file Python), `editing` (31 tasks, 5 languages, reports first-try success, recovery, corrupted files and matcher tiers), `browser` (9 tasks on a local test site), `desktop` (3 tasks on a fake driver). Each run writes raw records and `report.md`. Scores keep outcome (`pass | fail | not_evaluable`), integrity, verification and cost separate, plus "$ / resolved".

**Arena.** `tug arena --models qwen3-coder:30b,gpt-oss:20b "fix the bug in calc.py" --check "pytest -q" --judge big` runs each model in a worktree, scores the check and the diff outside the agent, asks an anonymised rubric judge, and ranks them. The report goes to `.tugline/arena/<ts>.md`; winners' branches are `oh/arena-…` (`--discard` deletes them). Default mode is `acceptEdits` (commands denied); `--mode auto` lets the safety classifier approve candidates' commands in their worktree, `--mode yolo` runs them all. A model name is a profile if one exists, else a model id on the active endpoint.

**Benchmarks.** `tug bench terminal-bench --arm all` and `tug bench swe-bench --arm all` run the bundled samples; `--data` points at full sets and `tug bench swe-bench --fetch --subset 10` downloads SWE-bench Lite rows. `--arm bash-only` is the baseline with only the `bash` tool. `tug bench` with no format prints how to fetch the full sets.

*Terminal-Bench, current version.* Since 2.0, Terminal-Bench tasks use the Harbor format (`instruction.md`, `task.toml`, `environment/`, `tests/test.sh`). `--data` accepts such a directory, for example the bundled `evals/bench/terminal-bench-harbor/tasks`. These tasks run in their own images with docker isolation; `tests/` is copied to `/tests` only after the agent finishes, and the task passes when `test.sh` writes a reward ≥ 1. For the official harness, install Harbor (`uv tool install harbor`) and run `tug bench terminal-bench --harbor --dataset terminal-bench/terminal-bench@4.0.0 [--subset N] [--repeats 3]`, or `--data <Harbor tasks>`. This writes an installed-agent adapter (Tugline installed inside each task container with Node 22; `--agent-version <npm spec or tgz URL>`), runs `harbor run`, and turns Harbor's trial results into `report.md`, which includes the exact command. The container needs network to install Tugline. A model endpoint on your loopback is reached as `host.docker.internal`.

*SWE-bench Pro.* `tug bench swe-bench-pro --data pro.jsonl` (rows of `ScaleAI/SWE-bench_Pro`, or `--fetch --subset N`) runs each instance in its environment image `jefzda/sweap-images:<dockerhub_tag>`, with the image's `/app` as the workspace. For local, indicative grading, add `--scripts-dir <SWE-bench_Pro-os>/run_scripts`. After the agent, the test patch is applied, the instance's `run_script.sh` and `parser.py` run inside the container, and every FAIL_TO_PASS and PASS_TO_PASS test must pass. In every case, the run writes `swe-bench-pro-predictions.json` for the official grader, and the report gives its command. `--pro-harness <SWE-bench_Pro-os checkout>` runs the grader for you. The bundled sample (`evals/bench/swe-bench-pro`) uses `python:3.12-slim`.

*Other agents as arms.* `--arm cline,aider,openhands,codex,mini-swe-agent` (or `"external": {"preset": "cline"}` / `{"command": "…"}` arms in any `suite.json`) runs that agent's CLI in the same task workspace, against the same endpoint, and scores it with the same scorer: hidden tests, protected-path integrity and the false-success check. The tools are not installed by Tugline: install them yourself and check the preset flags against `<tool> --help`. Commands get `{{workspace}}`, `{{prompt}}`, `{{model}}`, `{{base_url}}`, `{{api_key}}`, `{{timeout_s}}` and `{{state}}`. `{{base_url}}` is a local metering proxy that forwards to your endpoint, so calls and tokens are counted the same way for every arm. The manifest records the tool's `--version`, and the API key is never recorded.

*Paired report.* Every bench run with more than one arm or repeat writes `compare.md`. `tug bench --compare <dir>[,<dir>…] [--baseline cline] [--gpu-share 0.5 | default=1,cline=0.5]` builds it over any output directories. Per arm it reports:
- resolved (the hidden check passed) and false success, with 95% Wilson intervals;
- self-verified runs, integrity violations and edit retries;
- p50/p95 time and tokens;
- **GPU-seconds per resolved task** (wall × gpuShare, so a local model's $0 is not read as free).

Per task, it gives wins, losses and ties against the baseline, with a sign test. `docs/PILOT.md` is the protocol for a decision-grade company pilot against Cline.

*Pilot runs (R18).*
- **Pilot file:** `--pilot pilot.json` (on a run or on `--compare`) declares the pilot: when the target was fixed, the model facts, the tuning hours per arm, the held-out task ids, the minimum task and repeat counts, the conditions, and the target rules. The report then adds protocol checks (✅/⚠️/❌) and a per-condition decision on held-out tasks only.
- **Arm groups:** `--arm pilot` is `default,cline,cline-pinned,mini-swe-agent`. `cline` is your installed CLI, and `cline-pinned` runs a fixed current release through `npx`. `--arm ablations` runs `oh-full`, `oh-no-planner`, `oh-no-reviewer`, `oh-no-subagents`, `oh-no-code-mode` and `oh-simple`; the report gets an ablation table with Δ against `oh-full`. Code Mode is a no-op switch until N21 lands.
- **Contention:** `--condition shared --load N` runs N synthetic clients against the same endpoint during the run, and every manifest records the condition. Reports with several conditions get a section per condition.
- **Harness prompts:** each run records its harness system prompt's hash, and the text is saved under `<out>/prompts/`.

*Any eval suite through the bench (R19).* `tug bench suite --data evals/editing [--arm …] [--repeats 3] [--tasks a,b]` runs an eval suite with the same arms, conditions and `compare.md`. `scripts/live-evals.sh` is the one command for live evidence. It runs the editing and coding suites for every model on any endpoint, then writes `REPORT.md` with Wilson intervals per model (`arm @ model`) and a report per suite:

```bash
scripts/live-evals.sh --ollama                                   # every local Ollama chat model
scripts/live-evals.sh --url http://127.0.0.1:8080/v1 --models qwen3.6-27b --ctx 32768 --repeats 3
scripts/live-evals.sh --ollama --quick                            # 1 repeat, 3 tasks per suite
```
Other flags: `--suites`, `--arm`, `--tasks`, `--gpu-share`, `--condition`, `--load` and `--out`. `TUG_BIN` overrides the CLI.

*Isolation* (`--isolation docker|host`). With no flag, `tug bench` uses **docker** when a Docker daemon is reachable and **host** otherwise.
- **docker**: every run gets its own container. A terminal-bench task runs in the image built from its own `Dockerfile` or `docker-compose.yaml` (`client` service). The image is built from a copy of the task directory without `tests/` and the solution, and the workspace is bind-mounted at `/app`. A SWE-bench instance runs in one python base image, with the repository at `/testbed`. The default image is `python:3.12-slim`, which installs pytest with pip when it is missing; change it with `--image` or `TUG_BENCH_PYTHON_IMAGE`. Every `bash` call of the agent runs through `docker exec` in that container. The file tools work on the same bind-mounted workspace and cannot read the hidden test copy. The hidden tests reach the container only after the agent has finished: terminal-bench's files are copied to `/oh-hidden`, and SWE-bench's `test_patch` is applied to the workspace. Acceptance then runs inside the container. `--network none` cuts the container's network for the agent phase (setup keeps it). The report ends with `## Isolation` / `isolated: docker`, and each run's manifest records `isolation` and `image`. If a container cannot be built or started, that run is `not_evaluable`, with the reason in the record. It is never silently run on the host. `--isolation docker` without a daemon is an error.
- **host**: tasks run on this machine, not in each task's Docker image, and an agent with a full shell can find the hidden tests on disk. Results are then indicative, not leaderboard-comparable: compare arms and models run under the same conditions, not absolute scores. The report ends with an "Isolation limitations" section that says so.
- If containers cannot reach PyPI (an offline machine, or an egress proxy on the host's loopback), run `scripts/bench-python-image.sh`. It downloads the pytest wheels on the host and builds `tugline/bench-python:3.12` with no network inside the build. Then use `tug bench swe-bench --image tugline/bench-python:3.12`. The bundled terminal-bench samples need no network: their `run-tests.sh` falls back to a small runner when the image has no pytest.

**Replay CI.** Commit recorded runs under `ci/replays/` and use `.github/workflows/tugline-replay.yml`, which runs `tug replay <run> --check` on each.

**Compare local Ollama models.**
```bash
./scripts/test-ollama.sh --quick                # doctor + 1 task per suite + 1 benchmark task
./scripts/test-ollama.sh                        # every chat model, every suite, both benchmark arms
./scripts/test-ollama.sh --models qwen3.5:9b,qwen2.5vl:7b --ctx 32768 --price 0.15,0.60
```
It creates `oh-<model>` tags with `num_ctx` (default 16384; `--no-derive` skips this, `--cleanup` removes them), skips embedding models, runs a vision check for vision models, and writes `ollama-results/<ts>/REPORT.md` with resolved tasks, $ and tokens per resolved task, tool mode, unparseable replies and tool errors. Other flags: `--suites`, `--repeats`, `--no-bench`, `--bench-subset N`, `--no-vision`, `--out`, `--url`; `TUG_BIN` overrides the CLI command.

## 14. Documentation: wiki, docs checks, Q&A, changelog

Everything here runs on your own model (a 16–32K-context Ollama model is enough) and reads only files the agent may read: never secret-looking files (`.env`, keys, credentials), nothing in `.tuglineignore` or `.gitignore`. Source sent to the model is redacted and wrapped as untrusted data. Nothing goes to the network except the model endpoint.

### Codebase wiki
```bash
tug wiki build            # first run: summarise every file, write the pages
tug wiki update           # later: only changed files are re-summarised, only affected pages rewritten
tug wiki serve            # http://127.0.0.1:8765, with a source viewer for citations
tug wiki check            # CI: exit 1 if a citation no longer resolves
tug wiki judge --judge big   # a second model rates each page's accuracy 1–5 against its cited lines
```
`tug wiki judge` is anonymised like the `tug arena` judge: it sees each page and the source lines the page cites (as untrusted data), never which model wrote it, and answers in strict JSON. It exits 1 when the mean accuracy is below `--min` (default 4) or a verdict could not be parsed; `--report wiki-judge.md` saves the table.
The wiki goes to `.tugline/wiki/`: `index.md` (overview and page list), `architecture.md` (a Mermaid module dependency graph from the import graph, plus entry points), one page per module under `modules/` (purpose, key components, how it works, and a sequence diagram when the model gives a valid one), `glossary.md` (exported symbols with their definitions) and `nav.json`.

- **Map-reduce for small context windows.** Each file (in chunks that fit the context; with Ollama the real context is detected, see [§1](#1-install-and-connect-a-model)) becomes 2–6 cited facts; a module's facts become its page; the module purposes become the overview. Architecture and glossary need no model.
- **Every claim carries a citation** `[path:start-end@sha](…#Lstart-Lend)`. A citation is accepted only if the file is readable and the lines exist; an unambiguous mistake is repaired (a unique file name, an end past the end of the file, a symbol named in the sentence); anything else is dropped, and a sentence left without a citation is removed. Pages note how many statements were removed.
- **Mermaid** blocks are validated; an invalid diagram is replaced by a note.
- **Incremental.** `.tugline/wiki/.wiki-state.json` keeps content hashes: a page is rewritten only when its sources change. `tug wiki build --force` regenerates everything. To refresh on every push, schedule `tug wiki update` ([§12](#schedules-and-triggers)).
- **Steering.** `.tugline/wiki.json` can pin pages to globs (`"pages": [{"title": "Runtime", "paths": ["src/agent/**", "src/llm/**"], "notes": "…"}]`), add notes, and include or exclude paths.
- **VS Code.** **Tugline: Open Wiki** shows the wiki in a panel; citations open the source lines beside it.
- `tug wiki serve` shows Mermaid as source unless you pass `--mermaid <script-url>` (for example a copy of mermaid.min.js on your intranet): there is no CDN by default.

### Docs checks in CI
`tug docs check` needs no model. It reports, with file and line:
- broken relative links and `#anchors` (external URLs are not fetched);
- stale code references: inline-code paths that no longer exist (a renamed or deleted source file) and `name()` references to identifiers no source file uses;
- CLI flags in `tug …` examples that `<cli> --help` / `<cli> <sub> --help` no longer lists (set `docs.check.cli`, e.g. `["node", "dist/cli.js"]`, for your own CLI);
- fenced snippets that do not parse: `json`, `jsonc`, `js`/`ts`, `python`, `bash`/`sh`. Snippets with `…` placeholders are skipped as illustrations; `<!-- docs-check: skip -->` before a block skips it.

`--format github` prints workflow annotations. The composite action `.github/actions/tugline-docs-check` runs it in CI (inputs `cli`, `files`, and `checks: 'true'` plus an endpoint to also run check files).

**Check files.** Put one rule per file in `.tugline/checks/*.md` (front matter `name`, `description`, `severity: error|warning`, `paths: [globs]`; the body is the rule in prose). `tug review --checks --base main --format github` asks the model to judge `git diff main...HEAD` against each rule and prints pass/fail per check; findings outside the diff are dropped. It exits 1 when an `error` check fails.

**Doc sync.** `tug docs sync --base main --pr` finds docs a change made stale (the checks above, plus doc lines that mention a symbol the range removed or renamed), then a doc-sync agent edits the docs in a separate git worktree (your checkout is untouched). It has no shell and no network tools, and its writes are limited to `docs.sync.writeOnly` by the permission engine (`permissions.writeOnly`, a hard deny). `--patch docs.patch` writes a patch instead; `--pr` commits to a branch and opens a draft pull request with `gh` or `glab` when installed (otherwise it prints the branch); `--dry-run` only lists candidates.

### Ask the codebase
```bash
tug ask "Where is the context window of an Ollama model detected?"
```
`tug ask`, `/ask` and the opt-in `ask_codebase` tool (`docs.ask.tool: true`) retrieve excerpts from the code, the docs and the wiki (BM25, local), give only those to the model, and keep only sentences whose citations resolve and point at an excerpt it was shown. With no evidence, or when nothing survives validation, the answer is "Not found" (exit code 3), never a guess.

### Docstrings and release notes
- `/doc src/llm/client.ts#complete`, `/doc app.py:42` or `/doc app.py --all` (and `tug doc …`, **Tugline: Generate Docs for Selection** in VS Code) adds or refreshes docstrings in the language's style: Python docstrings, JSDoc/Javadoc blocks, Go `// Name …`, Rust `///`. The model writes only the text; Tugline places it and checks that no other byte changed. It is an edit like any other: it asks in `ask` mode and lands in the VS Code review.
- `tug changelog --since v1.0.0 --version 1.1.0 --out CHANGELOG.md` groups commits into Keep-a-Changelog sections (Conventional Commit types, or wording), adds **Breaking** entries from `type!:`, `BREAKING CHANGE:` and from the diff (exported symbols that disappeared), links every bullet to its commits and pull requests, and lists every commit it left out (merges, release commits, `[skip changelog]`). `--format github` writes GitHub release-note style; `--summarize` adds a one-sentence model summary per busy section.

---

## What is off by default, and why

| Feature | Turn on with | Why it is off |
|---|---|---|
| Browser tools | `browser.enabled` / `tugline.browser.enabled` | ~17 tool schemas of context; the browser reaches the network and acts on sites |
| Attached Chrome | `browser.cdpUrl` + `browser.attachedAllowDomains` | it acts inside your real logged-in accounts |
| Payments in the browser | `browser.allowPayments` | spending money needs a human |
| Pixel clicks | `browser.allowPoint`, `desktop.allowPoint` | coordinates are unverifiable; still asks on desktop |
| Text-only perception (OCR, grounder) | `perception.backend` | extra processes or a second model endpoint |
| Language servers | `lsp.servers` / `lsp.autoDetect` | a server loads project code (plugins, build scripts) |
| Board auto-start, repository hooks in harness git | `worktree.autoStart` / `worktree.trustHooks` (user config only) | unattended runs; hooks are code the repository chose |
| Editor context with prompts | `tugline.ideContext` | sends open file names and the selection to the model |
| Desktop tools | `desktop.enabled` | controls real apps on your machine; untrusted project config can never turn it on |
| Auto-mode approver | `approver.enabled` | a model would be deciding approvals; you opt in |
| Background jobs | `agent.backgroundJobs` | long-lived processes outlive a turn |
| Auto-memory | `agent.autoMemory` | memory persists into future sessions (it still asks) |
| Remote runs | `server.remote.enabled` / `tug serve --remote` | lets a client clone and run code on the server |
| Local repos for remote runs | `server.remote.allowLocalRepos` | exposes the server's filesystem paths |
| Apply model | `edit.applyModel` | a second model rewriting files |
| Formatter after edits | `edit.format` | runs a command per edit |
| Visible terminal (VS Code) | `tugline.visibleTerminal` | needs shell integration; hidden processes are simpler |
| Tab autocomplete | `tugline.autocomplete.enabled` | needs a FIM-capable endpoint and sends code on every keystroke pause |
| Next-edit suggestions | `tugline.nes.enabled` | needs a Zeta-format model and sends your recent edits and code after each edit |
| Voice input | `tugline.voice.enabled` | records the microphone and sends audio to a transcriber |
| OCR of pasted images | `tugline.ocr` | runs tesseract |
| Telemetry | `telemetry.enabled` or `OTEL_EXPORTER_OTLP_ENDPOINT` | sends data off the machine; content stays off even then |
| Channels | `channels.<name>.enabled` | opens a path from chat apps to an agent |
| Schedules | `tug schedule add` + `tug daemon` | headless runs; default mode denies approvals |
| Validator subagent | `agent.autoValidate` / `--validate` | costs an extra model pass |
| Code search (`code_search`) | `search.embeddings.profile` (or `search.mode: "bm25"`) | needs an embedding endpoint; indexing reads the whole repository |
| Language servers for navigation | `lsp.servers.<language>` | a server loads and runs project code and plugins |
| Navigation by name matching only | `lsp.enabled: true` | four more tools push a default session past the tool-search threshold |
| `ask_codebase` tool | `docs.ask.tool` | one more tool schema in every request; `tug ask` and `/ask` work without it |

On by default but worth knowing: checkpoints (`checkpoints.enabled`), post-edit verification (`edit.verify`), model overlays, background compaction, the repo map, browser recording (`browser.record`), desktop recording, the usage ledger (`limits.ledger`) and per-model edit stats (`edit.recordStats`).

---

## Configuration reference

Config files, later wins: built-in defaults → `~/.tugline/config.json` → `<ws>/.tugline/config.json` → `<ws>/.tugline/config.local.json` → `<ws>/.mcp.json` → environment → CLI flags / VS Code settings → plugins → managed policy. JSON files may contain `//` comment lines. Untrusted project config keeps only `permissions.deny`, `permissions.protectedPaths` and `skills.disabled`.

### Top level
| Key | Default | Meaning |
|---|---|---|
| `profile` | `"default"` | active profile |
| `profiles.<name>` | `default` profile (below) | model endpoints |
| `smallProfile` | unset | cheaper model for summaries, extraction, explore |
| `permissionMode` | `"ask"` | `ask` \| `acceptEdits` \| `plan` \| `auto` \| `yolo` |
| `outputStyle` | `"default"` | `default` \| `concise` \| `explanatory` \| `custom:<name\|file>` |
| `statusLine.command` / `statusLine.timeoutMs` | unset / `2000` | CLI status line |
| `homeDir` | `~/.tugline` | sessions, ledgers, stores |
| `mcpServers.<name>` | `{}` | `command`, `args`, `env`, `cwd` or `url`, `headers`; `disabled`, `trusted` (false), `oauth` |
| `hooks.<Event>` | `{}` | list of `{matcher?, command, timeoutMs?}` |

### Profile (`profiles.<name>`)
| Key | Default |
|---|---|
| `baseUrl` | `http://localhost:11434/v1` |
| `apiKey` | `""` (`env:NAME` reads a variable) |
| `model` | `qwen3-coder:30b` |
| `contextWindow` | `32768` |
| `maxOutputTokens` | `8192` |
| `toolMode` | `"auto"` (`native`, `text`) |
| `vision` | `false` |
| `temperature` | `0.2` |
| `timeoutMs` | `600000` |
| `pricing` | unset (`{inputPerM, outputPerM}` USD) |
| `headers` / `extraBody` | unset |
| `editFormat` | unset (overrides `edit.editFormat`) |

### `permissions`
| Key | Default |
|---|---|
| `allow` / `deny` | `[]` |
| `protectedPaths` | `[".git/**", ".tugline/config*.json", ".mcp.json"]` (always kept) |
| `additionalDirectories` | `[]` |
| `ignoreMode` | `"ask"` (`deny`) |
| `gitignoreReads` | `"allow"` (`ask`) |
| `hideGitignored` | `true` |
| `writeOnly` | unset (any path). Globs: writes elsewhere are a hard deny (the doc-sync agent uses `docs.sync.writeOnly`) |

### `shell`
| Key | Default |
|---|---|
| `mode` | `"shell"` (`allowlist`) |
| `allowlist` | `pytest python python3 uv pip ruff mypy git node npm pnpm yarn tsc go cargo make ls cat echo mkdir java mvn gradle dotnet` |
| `timeoutMs` | `120000` |
| `maxOutputChars` | `30000` |
| `sandbox` | `"auto"` (`none`, `bwrap`, `seatbelt`, `docker`) |
| `requireSandbox` | unset (refuse to run unsandboxed; on for scheduled, daemon and remote runs) |
| `processLifetime` | `"session"` (commands and background jobs cannot outlive the session; `off`) |
| `dockerImage` / `dockerNetwork` | `node:22-bookworm` / `none` |
| `scrubEnv` | `TUG_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY AWS_SECRET_ACCESS_KEY GITHUB_TOKEN GH_TOKEN` (plus name and value patterns) |

### `sandbox`
| Key | Default |
|---|---|
| `allowDomains` | `[]` |
| `network` | `"auto"` (proxy if `allowDomains`, else none; also `none`, `proxy`, `host`) |
| `allowWrite` | `~/.cache ~/.npm ~/.yarn ~/.pnpm-store ~/.cargo/registry ~/go/pkg/mod ~/.m2 ~/.gradle ~/.nuget/packages` |
| `readOnlyPaths` | `.git/hooks .git/config .tugline .mcp.json .vscode .claude .envrc` |
| `upstreamProxy` | `"env"` (`none` or a URL) |
| `required` / `require` | `false` (set by managed `forceSandbox`; also `shell.requireSandbox`) |
| `runner` (alias `mode`) | unset: `shell.sandbox` applies (`auto`); `auto`, `bwrap`, `landlock`, `seatbelt`, `docker`, `podman`, `none` |
| `filesystem` | `"workspace-write"` (`read-only`) |
| `denyRead` | `[]`: stores hidden IN ADDITION to the credential stores listed in [OS sandbox](#os-sandbox) |
| `allowRead` | `[]` (user scope only: default stores commands may read) |
| `seatbelt` | `"permissive"` (`restrictive`) |
| `unixSockets` | `"deny"` (`allow`: host daemon sockets reachable; a project config cannot set it) |
| `landlock.maxAbi` | unset |
| `session` | `"host"` (`container`) |
| `trustProjectConfig` | `[]` (user scope only: workspaces whose project config may loosen these settings) |

### `container`
| Key | Default |
|---|---|
| `engine` | `"auto"` (docker, else podman; `docker`, `podman`) |
| `image` | unset (`.tugline/environment.Dockerfile`, devcontainer, else `node:22-bookworm-slim`) |
| `memory` / `cpus` / `pidsLimit` | `4g` / `2` / `1024` |
| `mounts` | `[]` (`{from, to?, mode?: "ro" \| "rw"}`, read-only by default; user scope) |
| `env` | `{}` (user scope; credential-looking names refused) |

### `web`
| Key | Default |
|---|---|
| `searchProvider` | `"duckduckgo"` (`searxng`, `brave`, `tavily`, `none`) |
| `searxngUrl` / `braveApiKey` / `tavilyApiKey` | unset |
| `fetchMaxChars` | `40000` |
| `allowHosts` | unset (hosts allowed to resolve to private addresses; also the browser's localhost allowlist) |

### `agent`
| Key | Default |
|---|---|
| `maxTurns` | `60` |
| `maxRepeatFailures` | `4` |
| `compactAt` | `0.75` |
| `maxToolOutputChars` | `30000` |
| `maxCostUsd` / `maxTokens` | unset (unlimited); `0` = exhausted |
| `promptStyle` | `"full"` (`compact`) |
| `autoValidate` | `false` |
| `requireVerification` | `true` (nudge once when the answer claims success but the harness check did not pass) |
| `verifyCommands` | `[]` (the project's check, run by the harness itself to verify the work; otherwise AGENTS.md, then detection) |
| `harnessCheck` | `"auto"` (`off`: the harness never runs a check; runs that change files end `unverified`) |
| `checkTimeoutMs` | `600000` (per harness check command) |
| `unsavedBuffers` | `"ask"` (`save`, `disk`): files with your own unsaved editor changes before a command |
| `parallelReadOnlyTools` | `true` |
| `maxParallelSubagents` | `3` |
| `toolSearch` | `"auto"` (`on`, `off`) |
| `toolSearchThreshold` | `20` |
| `deferMcpTools` | `true` |
| `coreTools` | `[]` |
| `modelOverlays` | `true` |
| `backgroundJobs` | `false` |
| `autoMemory` | `false` |
| `repoMapTokens` | `1500` (0 = off) |
| `repoMapExclude` | `["**/evals/**/tasks/**"]` |
| `repoMapMaxFiles` | `0` (no limit; was a fixed 3000) |
| `repoMapCache` | `true` (persistent per-project parse cache) |
| `backgroundCompaction` | `true` |
| `taint` | `"ask"` (`off`): after untrusted content, outbound actions need a human ([§5](#untrusted-content-and-outbound-actions-agenttaint)) |
| `taintJobs` | `"stop"` (`keep`): background jobs started before the run was tainted |
| `taintShellNetwork` | `"none"` (`registries`): network of sandboxed shell commands while tainted |

### `routing`
`planner`, `editor`, `summarizer`, `explore`, `approver`: profile names, all unset. `editor` and `approver` are not used by any feature yet (see [§7](#7-agent-features)).

### `skills`
`dirs: []`, `disabled: []`.

### `edit`
| Key | Default |
|---|---|
| `editFormat` | `"auto"` (`replace`, `apply_patch`, `whole`) |
| `wholeFileMaxLines` | `400` (0 = no limit) |
| `applyModel` | unset |
| `format` | `{}` (glob → command with `{file}`) |
| `verify` | `true` |
| `diagnosticsWaitMs` | `3000` |
| `recordStats` | `true` |

### `search` (code search)
| Key | Default |
|---|---|
| `mode` | `"auto"` (exposed when an embedder is set; `bm25` = keyword-only; `off`) |
| `embeddings.profile` | unset (a profile with an `/embeddings` endpoint) |
| `embeddings.baseUrl` / `model` / `apiKey` | unset (inline instead of a profile) |
| `embeddings.batchSize` / `timeoutMs` | `32` / `60000` |
| `embeddings.queryPrefix` / `documentPrefix` | `"search_query: "` / `"search_document: "` for nomic-embed models, else empty |
| `maxFiles` | `20000` (0 = no limit) |
| `exclude` | eval task trees and fixtures, `docs/evidence/**`, lock files |
| `k` | `8` |

### `lsp` (code navigation)
| Key | Default |
|---|---|
| `enabled` | `"auto"` (code_* tools when a configured server matches a workspace language; `true` = also with name matching only; `false` = never) |
| `servers.<name>` | `{}` (none): `true` for a preset, a command line, or `{command, extensions, initializationOptions}` |
| `diagnostics` | `true` (CLI post-edit verification uses the server) |
| `requestTimeoutMs` / `startTimeoutMs` | `15000` / `30000` |
| `maxResults` | `50` |
| `autoDetect` | `false` (enable installed presets whose language is present) |
| `allowWorkspaceBinaries` | `false` (user scope only) |

### `worktree` (task board, arena)
`maxParallel: 3`, `verifyBeforeMerge: true`, `include: true`, `boardTools: false`; user scope only: `root` (`~/.tugline/worktrees`), `symlinkDirs: []`, `trustHooks: false`, `autoStart: false`.

### `cli`
`theme` (`dark`), `vim` (`false`).

### `checkpoints`
`enabled: true`, `maxFileMB: 5`, `backend: "auto"` (`git`, `copy`), `slowSnapshotMs: 3000`.

### `approver`
`enabled: false`, `profile` (unset: routing.approver → smallProfile → main), `honorDeny: true`, `timeoutMs: 30000`, `cacheSize: 500`.

### `limits`
`maxCostUsdPerSession`, `maxCostUsdPerDay`, `maxTokensPerDay`: unset = unlimited, `0` = exhausted; any other value must be a number ≥ 0 (`null` or a string is a config error, and under a managed cap it is replaced by the cap); `ledger: true`.

### `audit`
`sink`: unset. An `http(s)://` URL (each journal record's `{session, file, line, hash, ts}` is POSTed as JSON) or an absolute file path outside the workspace (one JSON line per record), for anchoring journals in storage the agent cannot rewrite.

### `ide` (VS Code; the `tugline.*` settings override these)
| Key | Default |
|---|---|
| `autoSave` | `true` |
| `visibleTerminal` | `false` |
| `inlineEditProfile` / `planProfile` / `visionProfile` | unset |
| `ocr` | `false` |
| `notifications` | `true` |
| `notifyAfterMs` | `30000` |
| `autocomplete.enabled` | `false` |
| `autocomplete.profile` | unset |
| `autocomplete.endpoint` | `"completions"` (`llama-infill`) |
| `autocomplete.template` | `"qwen"` (`codestral`, `deepseek`, `suffix`) |
| `autocomplete.debounceMs` / `autocomplete.maxTokens` | `250` / `128` |
| `nes.enabled` / `nes.profile` | `false` / unset |
| `nes.latencyMs` / `nes.maxTokens` / `nes.debounceMs` | `400` / `512` / `150` |
| `voice.enabled` / `voice.transcriber` / `voice.url` | `false` / unset / unset |
| `voice.model` / `voice.language` / `voice.recorder` / `voice.maxSeconds` | `"whisper-1"` / unset / `"auto"` / `60` |
| `mcp.<name>` or `mcp.<name>@<workspace>` | written by the MCP manager: `{disabled?, trusted?}` (user config only) |

### `browser`
| Key | Default |
|---|---|
| `enabled` | `false` |
| `profile` | `"isolated"` (`persistent:<name>`, `attached`, `extension`) |
| `headless` | `true` |
| `executablePath` | unset |
| `snapshotEngine` | `"auto"` (`aria`, `dom`) |
| `snapshotTokens` | `5000` |
| `maxRepeatedSiblings` / `maxTextChars` | `20` / `160` |
| `maxActionsPerTurn` | `2` |
| `actionsPerMinute` | `60` |
| `maxIdenticalActions` | `3` |
| `taskMaxTurns` | `15` |
| `record` | `true` |
| `recipesDir` | `<homeDir>/recipes` |
| `downloadsDir` | `"downloads"` (in the workspace) |
| `allowPayments` | `false` |
| `requireExpectForDestructive` | `true` |
| `cdpUrl` | unset |
| `attachedAllowDomains` | `[]` |
| `attachedStrictSubresources` | `false` (attached mode: subresources must be allowlisted too) |
| `extensionEnabled` | `false` (profile `extension`: tabs shared through the Tugline extension; needs `tug serve`) |
| `allowPoint` | `false` |
| `idleCloseMs` | `600000` |
| `actionTimeoutMs` / `navigationTimeoutMs` | `8000` / `30000` |

### `perception` (browser and desktop)
`backend` unset (`ocr`, `grounder`); `ocr: {command?, lang?, omniparserUrl?}`; `grounder: {baseUrl, model, apiKey?, zoom?, timeoutMs?, coordinates?: "pixel" | "norm1000"}`.

### `desktop`
| Key | Default |
|---|---|
| `enabled` | `false` |
| `backend` | `"auto"` (`cua`, `sidecar`, `sandbox`) |
| `cuaDriverCommand` / `cuaDriverArgs` | `"cua-driver"` / `["mcp"]` |
| `cuaDriverVersion` / `cuaDriverVersionStrict` | `"0.37"` / `false` |
| `sidecar` | `{}` (`command?`, `python?`, `powershell?`) |
| `autoApproveApps` / `denyApps` | `[]` / `[]` |
| `maxActionsPerMinute` / `maxIdenticalActions` / `maxActionsPerTurn` | `60` / `3` / `2` |
| `snapshotTokens` | `4000` |
| `maxRepeatedSiblings` / `maxTextChars` | `20` / `160` |
| `settleMs` / `activationWaitMs` | `150` / `500` |
| `requireExpectForDestructive` | `true` |
| `allowPoint` | `false` |
| `record` / `mirrorDriverRecording` | `true` / `false` |
| `stopFile` / `stopPollMs` | `<homeDir>/STOP` / `100` |
| `electronApps` / `electronLaunchArgs` / `electronPaths` | `[]` / `{}` / `{}` |
| `sandbox` | `{image: "tugline/desktop-sandbox:latest", container: "oh-desktop-sandbox", vncPort: 6080}` |
| `callTimeoutMs` | `20000` |

### `server`
| Key | Default |
|---|---|
| `port` | `7878` |
| `interactionTimeoutMs` | `300000` |
| `allowedRoots` | unset (any existing dir) |
| `allowedOrigins` | `[]` |
| `remote.enabled` | `false` |
| `remote.allowLocalRepos` | `false` |
| `remote.workRoot` | `<homeDir>/remote-workspaces` |
| `remote.mode` | `"acceptEdits"` |

### `docs`
| Key | Default |
|---|---|
| `profile` | unset (`routing.explore`, else the main profile) |
| `wiki.outDir` | `".tugline/wiki"` |
| `wiki.maxPages` | `30` (module pages; small directories merge upward) |
| `check.docs` | `["README.md", "*.md", "docs/**/*.md"]` |
| `check.cli` | `["tug"]` (argv that prints your CLI's `--help`; `[]` disables the flag check) |
| `check.cliName` | `"tug"` (how the docs spell the command) |
| `check.links` / `codeRefs` / `cliFlags` / `snippets` | `true` |
| `sync.writeOnly` | `["docs/**", "README.md", "*.md"]` |
| `ask.tool` | `false` |

Wiki steering lives in `.tugline/wiki.json`: `{ "pages": [{ "title", "paths": [globs], "notes" }], "notes", "include": [globs], "exclude": [globs] }`.

### `plugins`
`enabled: true`.

### `schedule`
| Key | Default |
|---|---|
| `selfActors` | `["tugline", "tugline[bot]"]` |
| `defaultMaxRunsPerDay` | `24` |
| `ratePerMinute` | `30` |
| `host` / `port` | `127.0.0.1` / `7880` |
| `maxBodyBytes` | `1000000` |
| `heartbeatMs` / `staleMs` | `30000` / `120000` |
| `leaseMs` | `600000` |
| `claimLeaseMs` | `600000` (a parked-wait claim whose resumed run never became durable is re-claimable after this) |
| `gpuShare` | `1` (default for GPU-second budgets) |

Per schedule (stored in `~/.tugline/schedule/`, set by `tug schedule add`): `mode` (default `ask`), `maxRunsPerDay`, `dailyBudgetUsd`, `runBudgetUsd`, `dailyTokens`, `runTokens`, `dailyGpuSeconds`, `runGpuSeconds`, `gpuShare`, `isolation` (`wait` | `worktree`), `workspaceWaitMs`, `ignoreActors`, `profile`, `workspace`, `enabled`.

### `workspaceLease`
| Key | Default |
|---|---|
| `enabled` | `true` (every agent run takes the workspace lease) |
| `interactive` | `"warn"` (`"wait"`, or `"off"` to take no lease in interactive sessions) |
| `waitMs` | `1800000` |
| `staleMs` / `heartbeatMs` | `120000` / `20000` |
| `holderKind` | unset (embedders set `"serve"`, `"vscode"` … to label their sessions) |

### `channels`
| Key | Default |
|---|---|
| `telegram` | `{enabled: false, tokenSecret: "telegram-bot", apiBase: "https://api.telegram.org", pollTimeoutS: 25}` |
| `slack` | `{enabled: false, tokenSecret: "slack-bot", signingSecret: "slack-signing", apiBase: "https://slack.com/api"}` |
| `webhook` | `{enabled: false, secret: "channel-webhook"}` |
| `untrusted` | `"ignore"` (`readonly`) |
| `ownerMode` / `pairedMode` | `"ask"` / `"ask"` |
| `workspace` | unset (where `tug channels start` runs) |
| `editIntervalMs` | `1200` |
| `pairingTtlMs` | `600000` |
| `maxPairingAttempts` | `5` |
| `host` / `port` | `127.0.0.1` / `7879` |

### `telemetry`
`enabled` unset (on only when an OTLP endpoint env var is set), `endpoint` unset, `headers` unset, `serviceName: "tugline"`, `includeContent: false`.

### Managed policy (separate file, see [§5](#managed-policy-administrators))
`lockedProfile`, `deny`, `protectedPaths`, `allowMcpServers`, `allowSkills`, `disableAutoMode`, `maxCostUsdPerDay`, `forceSandbox` (`true`, `auto`, `bwrap`, `seatbelt`, `docker`).

---

## Files and environment variables

**Environment variables**

| Variable | Use |
|---|---|
| `TUG_BASE_URL`, `TUG_API_KEY`, `TUG_MODEL` | endpoint (fallbacks: `OPENAI_BASE_URL`, `OPENAI_API_KEY`) |
| `TUG_CONTEXT_WINDOW`, `TUG_MAX_OUTPUT_TOKENS`, `TUG_TOOL_MODE`, `TUG_VISION` | profile fields |
| `TUG_PROFILE`, `TUG_PERMISSION_MODE` | active profile, permission mode |
| `TUG_MANAGED_POLICY` | path to a managed policy file |
| `TUG_SERVER_TOKEN` | token for `tug serve` and its clients |
| `TUG_SECRET_<NAME>` | a vault secret (overrides the file) |
| `TUG_CHROMIUM_PATH` | browser binary |
| `TUG_SANDBOX_CA` | CA file for building the desktop sandbox behind a TLS-intercepting proxy |
| `TUG_TREE_SITTER_WASM_DIR` or `TUG_TREE_SITTER_DIR` | directory of tree-sitter grammar wasm, used by post-edit syntax checks and the repo map (optional; either name works) |
| `TUG_EVAL_TIMEOUT_SCALE` | multiply every eval task timeout (e.g. `4` on CPU-only machines or with large local models) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | turn on telemetry |

**Files under `~/.tugline/`**

| Path | Contents |
|---|---|
| `config.json` | user config (0600) |
| `trusted-workspaces.json`, `trusted-hooks.json` | workspace trust, approved hook hashes |
| `sessions/<project>/<session>.jsonl` | hash-chained journals (reopening a session verifies the chain and continues it; a broken chain is left untouched and the session continues under a new id); `titles.json`, `trash/` for VS Code chats |
| `capabilities.json` | cached endpoint probes |
| `model-stats.json` | per-model edit success |
| `checkpoints/<project>/` | shadow git store (0700) |
| `usage/<date>.jsonl` | spend ledger |
| `jobs/<id>.log` | background job output |
| `MEMORY.md`, `AGENTS.md` | user memory and instructions |
| `secrets.json` | secrets vault (0600) |
| `browser-profiles/<name>/`, `recipes/` | persistent browser profiles, replay recipes |
| `STOP` | the automation kill switch |
| `mcp-oauth/<server>.json` | MCP OAuth tokens (0600) |
| `plugins/` | installed plugins, marketplaces, `installed.json` |
| `server.json`, `acp-sessions.json`, `remote-workspaces/` | server info while serving, ACP session map, remote clones |
| `schedule/` | schedules, dedupe ledger, activity log, runs, heartbeat |
| `channels/` | `pairing.json`, `actions.jsonl` |
| `bench/` | benchmark caches and hidden test material during runs |

**Files in the workspace:** `.tugline/config.json`, `.tugline/config.local.json`, `.mcp.json`, `.tuglineignore`, `.tugline/skills/`, `.tugline/agents/`, `.tugline/commands/`, `.tugline/output-styles/`, `.tugline/MEMORY.md`, `.tugline/runs/` (recordings), `.tugline/arena/` (arena reports), `downloads/` (browser downloads).
