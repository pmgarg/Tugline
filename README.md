# Tugline

**An open agentic coding and automation harness for *your* LLM.** Point it at any OpenAI-compatible endpoint (a model on your laptop, your company's GPU server, or a cheap hosted open model) and you get an agent that reads and edits code, runs tests, drives a browser or desktop apps, uses MCP servers, follows skills and runs on a schedule. It ships as a **CLI** (`tug`), a **VS Code extension**, an **ACP agent** for Zed, JetBrains and Neovim, a local **server** and an **SDK**.

```
base URL  +  API key  +  model name   ──▶   Tugline   ──▶   an agent
```

How it differs:
- **Any model.** Ollama, LM Studio, llama.cpp, vLLM, SGLang, TGI, LiteLLM, company gateways, OpenRouter, DeepSeek, Nebius and others. Models without native tool calling work through a text tool protocol, and server quirks are healed in the client.
- **Deterministic safety.** Code decides every permission, not the model or a prompt: permission modes, allow/deny rules, protected paths, a workspace jail, workspace trust, an OS sandbox, checkpoints, spend limits and a managed policy for admins.
- **Model-adaptive.** Per-model edit formats (`apply_patch` for GPT-family models, anchored edits for the rest), prompt overlays, a tiered edit matcher, compaction and tool search sized for 16–32K windows.

Docs: **[User guide](docs/USER_GUIDE.md)** (every command and setting) · [Design](docs/DESIGN.md) · [Testing](docs/TESTING.md) · [Models and servers](docs/MODELS.md) · [Dependencies](docs/DEPENDENCIES.md)

---

## Quick start: CLI

```bash
npm install -g tugline                           # Node >= 20; provides `tug` and `tugline`
tug setup                                        # wizard: base URL, API key, model, capability probe
tug doctor                                       # checks the endpoint, tool calling, ripgrep, Playwright, MCP
cd your-project
tug                                              # interactive
tug -p "fix the failing test in tests/test_api.py"   # headless: prints the answer
tug --auto -p "add a --verbose flag and update the README"   # auto mode: a safety classifier approves routine commands
```

Or configure with environment variables instead of `tug setup`:
`TUG_BASE_URL`, `TUG_API_KEY`, `TUG_MODEL`, `TUG_CONTEXT_WINDOW`, `TUG_TOOL_MODE`, `TUG_PROFILE`, `TUG_PERMISSION_MODE`.

From source instead: `npm install && npm run build && npm link`.

## Quick start: VS Code

Install **Tugline** from the VS Code Marketplace (Extensions view, search "Tugline"). For Cursor, Windsurf or VSCodium, install it from Open VSX. From source: `cd vscode && npm install && npm run package`, then `code --install-extension tugline-*.vsix`.

Open the **Tugline** icon in the activity bar. With a local server running (Ollama, LM Studio or llama.cpp), setup is mouse-only: if the endpoint does not answer or the model is not installed, the chat panel shows a card with a button per detected local server and per installed chat model (tool-capable coder models first). One click sets the model and tests the connection; with Ollama the context window is read from Ollama itself. For a company or custom URL, run **Tugline: Configure LLM Endpoint**: pick a preset (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, DeepSeek or custom), enter the API key (stored in VS Code SecretStorage) and choose a model. The connection is probed and the best tool-calling mode is offered. The extension needs VS Code 1.93 or later.

## Connect to your model

**Company endpoint** (`~/.tugline/config.json`):
```jsonc
{
  "profile": "company",
  "profiles": {
    "company": { "baseUrl": "https://llm.corp.example/v1", "apiKey": "env:CORP_LLM_KEY",
                 "model": "qwen3-coder-30b", "contextWindow": 65536, "headers": { "X-Team": "platform" } }
  }
}
```

**Ollama.** Tugline reads the context Ollama really runs the model with (`/api/show`, `/api/ps`) and budgets to min(configured, Ollama's), with a notice. The default context is often 4K, which is too small for an agent, so give it at least **16K** (32K or more is better) in **Ollama → Settings → Context length**, or:
```bash
launchctl setenv OLLAMA_CONTEXT_LENGTH 32768    # macOS; then restart the Ollama app
ollama pull qwen3-coder:30b                     # 32 GB Mac; on 16 GB try qwen3.5:9b
export TUG_BASE_URL=http://localhost:11434/v1 TUG_MODEL=qwen3-coder:30b TUG_CONTEXT_WINDOW=32768
tug doctor
./scripts/test-ollama.sh --quick                # compare every local model on the eval suites
```

**llama.cpp:**
```bash
llama-server -hf unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M --jinja -c 65536 --port 8080
export TUG_BASE_URL=http://127.0.0.1:8080/v1 TUG_MODEL=qwen3-coder TUG_CONTEXT_WINDOW=65536
tug doctor
```

For hosted options and RAM-based model picks, see [docs/MODELS.md](docs/MODELS.md).

---

## Features

Everything risky is **off by default**: browser, desktop, the auto-approver, background jobs, remote runs, autocomplete, telemetry and channels. The [user guide](docs/USER_GUIDE.md#what-is-off-by-default-and-why) says why.

### Editing
- **Tiered matcher.** Edits forgive CRLF, copied line numbers, smart quotes, trailing spaces, shifted indentation, over-escaping and stray blank lines, but never guess. A failed match shows candidate regions with line numbers.
- **`multi_edit`.** Several edits to one file, applied atomically.
- **Byte preservation.** Line endings, BOM, final newline and encoding are kept; non-UTF-8 files are refused, not corrupted.
- **Raw-code edits in text mode.** Models write `<edit path>` SEARCH/REPLACE blocks with no JSON escaping.
- **Verification after every edit.** The tool result shows new syntax errors or IDE diagnostics and the edited region.
- **Per-model edit format.** GPT-family models get Codex-style `apply_patch`, others get `edit_file`/`multi_edit` (`edit.editFormat`, or `editFormat` per profile). Success rates go to `~/.tugline/model-stats.json`.
- **Optional apply model** (`edit.applyModel`) merges "… existing code …" snippets under strict output checks.
- **Notebooks.** `notebook_edit` inserts, replaces and deletes Jupyter cells and keeps the rest byte-exact.

### VS Code
- **Edits go into editor buffers.** They merge with your unsaved text, Ctrl+Z undoes them, and the agent sees IDE diagnostics after each edit.
- **Write-then-review.** In acceptEdits/auto/yolo mode, changes appear in a Changes list with per-hunk Keep/Undo CodeLens. Undo leaves your own later typing outside the agent's changes alone; typing inside a changed hunk becomes part of that hunk and is undone with it.
- **Inline edit.** Select code, press Ctrl/Cmd+Alt+K, describe the change, then Accept (Ctrl/Cmd+Shift+Enter) or Reject (Ctrl/Cmd+Shift+Backspace).
- **Mentions.** `@file`, `@folder/`, `@problems`, `@terminal`, `@git`, `@url:`, `@skill:` with autocomplete.
- **Images.** Paste or drop images. Vision models see them; text-only models get OCR (`tugline.ocr`) or a description from `tugline.visionProfile`.
- **Several chats** as tabs, and a History view to resume, rename, delete and search them.
- **Steering.** While the agent works, Enter queues a message, Steer injects it at the next tool boundary, and ✎ edits an earlier message and resubmits (optionally restoring files).
- **Model picker** per chat, reasoning effort, and a plan-mode model (`tugline.planProfile`).
- **Context meter** (amber near compaction) and cost per request, task (subagents included) and chat.
- **Visible terminal** (`tugline.visibleTerminal`): commands run in an "Tugline" terminal, still sandboxed.
- **MCP & Skills manager** (status, enable, trust, registry search) and a **Settings** view (rules, protected paths, permissions, hooks).
- **Checkpoint timeline** with restore, **Emergency Stop** (Ctrl+Alt+Shift+Esc), and a **replay viewer** for recorded browser runs.
- **Task board (Kanban)** (*Tugline: Open Task Board*): each card is an agent session in its own git worktree; merges are conflict-checked, keep your uncommitted work, and land only after the project check passes on the merged result.
- **Arena view**: several models (or Cline) on one task side by side, live; pick the winner and it is applied through the same checked merge.
- **Auto-approve…**: tick categories (read-only commands, edits, web, the MCP servers you name, yolo); they become permission configuration, so deny rules, protected paths, secret files and the sandbox still apply ("read-only commands" is a checker, not wildcard rules: `find -exec`, `git --output` or `cat .env` still ask).
- **Everyday commands**: Explain / Improve code, *Fix with Tugline* quick fix, Add Terminal Output to Chat, Generate Commit Message (SCM), notebook cell commands, compare a checkpoint, copy the conversation, starred sessions and models, export sessions, and opt-in editor context (`tugline.ideContext`).
- **Tab autocomplete** with FIM models (`tugline.autocomplete.enabled`; llama.cpp `/infill` or `/completions`).

### Parallel work and git
- **Task board** (`tug board`, `/board`, VS Code Kanban): one worktree per card, from a prompt, a GitHub issue (`--issue`) or a pull request (`--pr`); linked cards; base commit and "behind HEAD" shown; conflicts detected before merging; your uncommitted work is never overwritten; the project check (planned in your tree; a card that edits the check itself is flagged) runs on the merged result before it lands; every incoming file goes through the permission engine and the merge is journaled; cards on issues or PRs start tainted; a card can run an external agent (`--agent cline`), and has a transcript (`tug board log`) and sandboxed commands (`tug board exec`); harness git never runs repository hooks or repo-named programs.
- **Code intelligence** (`lsp`): definitions, references, hover, implementations, type definitions, call hierarchy, diagnostics with quick fixes, and multi-file rename applied through the permission engine with a checkpoint (`code_apply`, undo with `/rewind`). TS, Python, Go, Rust, Java, C/C++ presets, `lsp.autoDetect`, crash restart; servers run in the sandbox.

### CLI
- **Headless output** `--output-format text|json|stream-json` (schema: `docs/schemas/headless-output.schema.json`), `--input-format stream-json`, `--input-file`, `--session-id`, `--fork-session`, `--max-wall-time`, `--max-tool-calls`, `--allowed-tools`/`--exclude-tools`, `--append-system-prompt`, `--effort`, `--home`.
- **Sessions**: `tug sessions list|show|export|rename|delete`; `--continue`, `--resume`.
- **REPL**: themes (`--theme`, `/theme`, NO_COLOR), vim keys (`--vim`, `/vim`), multi-line input (trailing `\`), `/fork`, `/export`, `/copy`, `/diff`, `/btw`, `/commit`, `/recap`, `/permissions`, `/effort`, … and `tug completion bash|zsh|fish`.
- **Loosening flags are loud**: `--yolo` and `--no-sandbox` print a warning, are journaled, and an organisation's managed policy can forbid them.

### Safety & recovery
- **Permission engine.** Modes `ask` / `acceptEdits` / `plan` / `auto` / `yolo`, Claude-Code-style rules (`bash(npm test*)`, `edit_file(src/**)`), protected paths, a workspace jail, and dangerous commands (`git push`, `rm -rf ~`, `curl | sh`) that always ask.
- **Auto mode (v1.2).** `--auto` / `/mode auto` / the VS Code picker / `tug serve` / the SDKs: in-workspace edits and read-only commands run at once, everything else goes to a two-stage, transcript-aware safety classifier on your small local model, and a deterministic floor (secrets, exfiltration, publishing, persistence, self-modification, destructive) always asks you, whatever the classifier says. Untrusted content forces a human for outbound calls, the sandbox still applies, and denial tracking hands repeated blocks to you. **Migration:** the old classifier-less `auto` is now called `yolo` (`--yolo`, `-y`); a config that says `"auto"` gets the safer mode. See the [user guide](docs/USER_GUIDE.md#auto-mode).
- **Workspace trust.** A cloned repo's config cannot redirect your API key, start MCP servers or run hooks until you trust it (`--trust`).
- **Checkpoints.** Every turn and shell command is snapshotted in a private shadow git repo. `/checkpoints`, `/rewind [n|id] [files|chat|both]`, `/undo [n|all]`.
- **OS sandbox.** `sandbox.runner: "auto"` runs commands under bubblewrap or, without user namespaces, Landlock (Linux) and Seatbelt (macOS), on every surface (CLI, SDKs, ACP, `tug serve`, channels, schedules, subagents, remote jobs). Credential stores (`~/.ssh`, `~/.aws`, `~/.config/gh` …) are unreadable inside it. Network is limited to `sandbox.allowDomains` through a filtering proxy. Per-command `docker` and `podman` runners, and `tug --container` to run the whole session in a container with no host home, no network of its own, no API key inside (a relay adds it) and egress only through the proxy. `tug sandbox status` explains what is in force; `tug sandbox verify` probes it; `sandbox.require: true` fails closed. A repository's config can only tighten these settings.
- **Auto-mode approver** (`approver.enabled`). A small model approves routine actions; a deterministic filter always escalates destructive, credential, exfiltration, publishing, persistence and security-weakening actions to you.
- **Managed policy.** Admins lock the endpoint, deny rules, MCP servers, skills, auto and yolo modes, daily spend and sandboxing in `/etc/tugline/managed.json` (macOS: `/Library/Application Support/Tugline/managed.json`; Windows: `%ProgramData%\Tugline\managed.json`).
- **`.tuglineignore`** (gitignore syntax). Matching paths are hidden from search and ask before being read.
- **Hooks.** PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd, PreCompact, SubagentStart, SubagentStop, PermissionRequest, Notification. Project hooks run only after `/hooks approve`, and again after any change.
- **Spend limits.** `limits.maxCostUsdPerDay`, `maxTokensPerDay`, `maxCostUsdPerSession` stop a run before a call that could exceed them. `tug usage` and `/usage` show spend.
- **Secrets** are scrubbed from child processes and redacted from journals; secret files ask before being read.

### Agent core
- **Parallel and background subagents** (`task` with `run_in_background`), and **worktree-isolated** subagents (`isolation: "worktree"` + `worktree_merge`).
- **Tool search.** With many tools, only core tools are sent and the rest load on demand through `tool_search`.
- **Per-model overlays** (Qwen, gpt-oss, GLM, Kimi, DeepSeek, Llama, Mistral, Gemma) and cached endpoint capabilities.
- **Background jobs** (`agent.backgroundJobs`): `bash` with `run_in_background`, `monitor`, `job_output`, `job_kill`, `/jobs`.
- **Memory.** The `remember` tool, `/memory`, supersession of old facts, and optional auto-memory (`agent.autoMemory`).
- **Repo map** in the first prompt, and the `repo_map` tool.
- **Compaction** in the background, plus `/compact [focus]`.
- **Prompt-cache aware** (v1.1): cache hit rate in `/cost`, `/cache`, the VS Code meter and eval reports; llama.cpp `cache_prompt` + one slot per agent; `cache_break` events naming what changed the prefix; a byte-stable system prompt across prompts; idle-time compaction.
- **`/goal <condition> --check "<cmd>" --max-turns N`** keeps working until a check passes ("verified"). Without `--check` an **independent verifier** (read-only, sandboxed, network off, its input wrapped as untrusted, citations checked by code) decides, labelled "judged met (independent verifier)"; `--verify` adds it on top of a check; `tug goal "<condition>"` runs it headless. `/goal status | pause | resume | clear`.
- **Nested subagents and workflows** (v1.2 N18): subagents nest to `agent.maxDepth` (default 2), always narrower than their parent (tools, mode, roots, domains, model, budget; every clamp journaled), with taint flowing both ways. `workflow_run` / `tug workflow run <file>` fans one task out over many items (concurrency, total and per-item budgets admitted before every call, worktree isolation, retry-once, stall watchdog, structured output, reduce, resume); commands in a workflow run only after you approve the whole workflow once.
- **Agent teams** (v1.2 N34): `/team <goal>` or `tug team run <file>`: a lead plus members (default up to 4, max 8), each in its own worktree, with a shared task board (atomic claims across processes), messages delivered as untrusted data that carry taint, a team budget, leased claims, personas, advisory outcome documents, external agent CLIs as sandboxed members, board hosts (`tug team host`), A2A inbound under per-caller grants (`tug team a2a`), and live views in the CLI (`/team status`), VS Code (Agents view) and `tug serve` events.
- **Model routing** (`routing.planner`, `routing.summarizer`, `routing.explore`), with "$ / resolved" in eval reports.
- **`/context`** breakdown, and `@file` / `@folder/` mentions in the CLI.
- **Project rules** from `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.clinerules` and `GEMINI.md`; skills from `.tugline/skills`, `.claude/skills` and `.codex/skills`.

### Browser
- **Browser tools** (`browser.enabled: true`). `browser_*` tools work with text-only models: the page is an accessibility tree with refs, and every action returns a diff and is checked against an optional post-condition.
- **Cascade.** `browser_task` tries a plain fetch first, then a recorded recipe, the tree, and finally pixels.
- **Profiles.** Isolated, persistent, or attached to your own Chrome (with consent and a site allowlist).
- **Secrets.** `secret://name` refs in `browser_type`; values come from `~/.tugline/secrets.json` (0600), `TUG_SECRET_*` or the OS keychain, and never reach the model. Payments, 2FA and CAPTCHAs are handed to you.
- **Text-only pixels.** `perception.backend: "ocr"` (tesseract) or `"grounder"` (a UI-grounding VLM) lets text-only models click things drawn on a canvas.
- **Replay.** Runs are recorded under `.tugline/runs/<session>/`. `tug replay <run> --check | --heal | --export flow.spec.ts | --recipe name | --html`.
- **Kill switch.** `/browser stop`, `/browser resume`.

### Desktop
- **Desktop tools** (`desktop.enabled: true`). `desktop_*` tools drive real apps through the accessibility tree: cua-driver on macOS, Windows and Linux, with our own AT-SPI and UIA sidecars as fallbacks. Every action is re-scanned and verified, and asks first unless the app is in `desktop.autoApproveApps`.
- **Traps are diagnosed, not guessed.** An empty tree reports `permissions`, `not_activated` (fixed automatically), `qt_a11y_off`, `electron_opaque` (`desktop_electron` relaunches the app with a local CDP port, with consent) or `canvas` (OCR regions + `desktop_point`).
- **Kill switch.** `tug emergency-stop` from any terminal (or `touch ~/.tugline/STOP`), Ctrl+C twice, or `/desktop stop`. The agent never acts on its own terminal or editor.
- **Sandboxed desktop.** `tug desktop-sandbox up` starts a throwaway Linux desktop in Docker (noVNC on 127.0.0.1:6080); then set `desktop.backend: "sandbox"`.
- **Replay.** `tug desktop-replay .tugline/runs/<session>-desktop --check`.

### Platform
- **Editors via ACP.** `tug --acp` (or `tug acp`) speaks the Agent Client Protocol for Zed, JetBrains IDEs and Neovim. Approvals appear as the editor's permission prompts, and file reads and writes go through the editor's buffers. Configuration is [below](#editor-configuration-acp).
- **Server.** `tug serve` starts a JSON-RPC server (WebSocket on 127.0.0.1 with a token, or `--stdio`): sessions, streamed events, steer, abort, approvals, checkpoints, jobs.
- **SDK.** `createAgent`, `run`, `defineTool`, `defineSkill` from `tugline/sdk` (see `examples/sdk/basic.mts`), plus a stdlib-only Python client in `sdk/python/`.
- **MCP.** Tools, resources (`mcp_resource`), prompts as `/mcp:<server>:<prompt>`, elicitation forms, OAuth (`tug mcp login <server>`) and registry search (`tug mcp search <query>`).
- **Plugins.** `tug plugin install <path|git-url|name@marketplace>` adds skills, agents, commands, hooks and MCP servers; Claude Code plugins work too. Hooks and MCP servers run only after `tug plugin trust <name>`.
- **Remote agents.** `tug serve --remote` on a build box, then `tug remote run --server ws://… "<prompt>"`. The run happens in a server-side clone, and you apply the returned patch after review.
- **Output styles and status line.** `outputStyle: concise|explanatory|custom:<name>` and `/output-style`; `statusLine.command` gets the session as JSON and its output is shown above the prompt.

### Automation
- **Schedules and triggers.** `tug schedule add --cron "0 9 * * 1-5" --prompt "…"` (also `--watch <glob>`, `--webhook`, `--github pull_request.opened`), run by `tug daemon` or `tug schedule install-service`. Runs are headless: approvals are denied and recorded; with `--mode auto` the classifier may approve routine commands (anything else is denied and recorded), with `--mode yolo` commands run without approval. `tug schedule report` is the morning report.
- **Webhooks** are HMAC-verified and deduplicated; the daemon enforces rate limits and daily run and budget windows, and refuses its own events. `tug serve --with-daemon` serves them on the server port.
- **Channels.** Telegram, Slack and signed webhooks (`tug channels pair telegram`, then `/pair <code>` from your account). Unpaired senders get nothing, or one tool-less answer, and never reach tools.
- **PR review.** `tug review --base main [--format github]`, and the composite action `.github/actions/tugline-review`.
- **OpenTelemetry.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `telemetry.enabled`) for run, turn, llm.call and tool.call spans with GenAI attributes and cost. Content is excluded unless `telemetry.includeContent`.

### Documentation
- **Codebase wiki on your own model.** `tug wiki build|update|serve`: overview, architecture graph, a page per module and a glossary, written map-reduce style so 16–32K models cope. Every claim cites `path:lines@sha` and is checked against the code; invalid citations and Mermaid are dropped. `update` rewrites only pages whose sources changed. VS Code: **Open Wiki**.
- **Docs-as-code checks.** `tug docs check` (no model, no network) finds broken links and anchors, stale paths and symbols, CLI flags `--help` no longer lists, and snippets that don't parse; `.github/actions/tugline-docs-check` runs it in CI. `tug review --checks` runs `.tugline/checks/*.md` rules.
- **Doc sync.** `tug docs sync --pr` updates the docs a change made stale, in a worktree, with writes limited to doc paths by the permission engine.
- **Ask the codebase.** `tug ask`, `/ask` and the opt-in `ask_codebase` tool answer with validated `file:line` citations, or say "not found".
- **Release notes and docstrings.** `tug changelog --since <tag>` (Keep-a-Changelog or GitHub, breaking changes from the diff, every bullet linked to its commits); `/doc` adds native-style docstrings as a reviewed edit.

### Evaluation
- **`tug eval <suite>`** with raw run records and a rescorable scorer (`tug rescore`): outcome, integrity, verification and cost reported separately. Suites: `evals/coding-basics`, `evals/editing` (31 tasks in 5 languages), `evals/browser`, `evals/desktop`.
- **Model arena.** `tug arena --models a,b,c [--agents cline] "<task>" --check "<cmd>" --judge <profile>` runs the contestants in parallel worktrees with live side-by-side output (each with its own budget, sandbox and protected paths), ranks them (harness check first, planned in your tree so a contestant cannot rewrite it; judge second), and lets you pick the winner (`--pick A|auto`, or `tug arena pick <run> <label>` later): it lands through the board's checked merge. Results feed `tug bench --compare`. `--suite evals/x` uses a suite.
- **Benchmarks.** `tug bench terminal-bench|swe-bench --subset N --repeats 3 --arm all` (includes the bash-only baseline).
- **Replay CI.** `tug replay <run> --check` in CI; sample workflow `.github/workflows/tugline-replay.yml`.
- **Local model comparison.** `scripts/test-ollama.sh` runs every suite, the benchmark samples and a vision check against each Ollama model, and reports $ and tokens per resolved task.

---

## Editor configuration (ACP)

The model endpoint comes from `~/.tugline/config.json` like any other `tug` run, so the `env` entries below are optional. Approval prompts appear as the editor's permission dialogs. Pick a mode (ask, accept edits, plan, auto, yolo) in the editor's mode picker.

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "agent_servers": {
    "Tugline": {
      "command": "tug",
      "args": ["--acp"],
      "env": { "TUG_BASE_URL": "http://localhost:11434/v1", "TUG_MODEL": "qwen3-coder:30b" }
    }
  }
}
```
Open the Agent panel, click "+", and pick **Tugline**. If `tug` is not on Zed's PATH, use the absolute path, e.g. `"command": "/usr/local/bin/oh"`.

**JetBrains IDEs** (AI Assistant → Agents → "Add custom agent", or `~/.jetbrains/acp.json`):
```json
{
  "agent_servers": {
    "Tugline": { "command": "tug", "args": ["--acp"], "env": { "TUG_BASE_URL": "http://localhost:11434/v1", "TUG_MODEL": "qwen3-coder:30b" } }
  }
}
```
Then select **Tugline** in the AI Chat agent picker.

**Neovim** with CodeCompanion.nvim:
```lua
require("codecompanion").setup({
  adapters = { acp = { tugline = function()
    return require("codecompanion.adapters").extend("claude_code", {
      name = "tugline",
      commands = { default = { "tug", "--acp" } },
      env = { TUG_BASE_URL = "http://localhost:11434/v1", TUG_MODEL = "qwen3-coder:30b" },
    })
  end } },
  strategies = { chat = { adapter = "tugline" } },
})
```
With avante.nvim: `acp_providers = { tugline = { command = "tug", args = { "--acp" }, env = { TUG_BASE_URL = "…", TUG_MODEL = "…" } } }` and `provider = "tugline"`.

---

## Configuration

Files, later wins: `~/.tugline/config.json` (user) → `.tugline/config.json` (project, commit it) → `.tugline/config.local.json` (project secrets, git-ignored) → `.mcp.json` (MCP servers) → environment → CLI flags or VS Code settings. A managed policy file overrides all of them. Every key and its default is in the [user guide](docs/USER_GUIDE.md#configuration-reference).

```jsonc
{
  "profiles": { "default": { "baseUrl": "https://llm.mycompany.com/v1", "apiKey": "env:COMPANY_LLM_KEY", "model": "qwen3-coder-30b", "contextWindow": 65536 } },
  "permissions": { "protectedPaths": ["tests/**", ".github/**"], "allow": ["bash(npm test*)"] },
  "shell": { "sandbox": "auto" },
  "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest", "--headless"] } }
}
```

## Skills

Put a folder with a `SKILL.md` in `.tugline/skills/` (project) or `~/.tugline/skills/` (personal):
```markdown
---
name: api-conventions
description: Use when adding or changing REST endpoints in this service.
---
1. Every endpoint has an OpenAPI annotation …
```
The agent sees the name and description and loads the body when relevant. Ask it to *"create a skill for …"* and it uses the bundled `skill-creator` skill. A skill can change *how* the agent works but can never grant permissions.

## Development

```bash
npm test                                         # all unit, loop, security and integration tests (mock LLM, no network)
npx tsc --noEmit -p . && (cd vscode && ../node_modules/.bin/tsc -p tsconfig.json)
cd vscode && npm run build && VSCODE_VERSION=1.143.1 xvfb-run -a node test/runTest.mjs   # VS Code E2E
```
See [docs/TESTING.md](docs/TESTING.md) for live-model runs and the device checks for your Mac.

Layout: `src/core` (library: LLM client, agent loop, tools, permissions, edit engine, checkpoints, sandbox, automation, MCP, plugins, schedule, eval), `src/cli`, `src/acp`, `src/server`, `src/sdk`, `src/channels`, `vscode/` (extension), `skills/` and `agents/` (bundled), `evals/` (suites), `scripts/`, `test/`.

MIT License.
