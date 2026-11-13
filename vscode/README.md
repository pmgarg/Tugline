# Tugline: a coding agent for any model, in VS Code

Tugline is a coding agent that runs on **the model you choose**. It works with a local model (Ollama, LM Studio, llama.cpp, vLLM), your company's model server, or a hosted API (OpenRouter, DeepSeek or any OpenAI-compatible endpoint). It reads and edits your code, runs commands in a sandbox, and checks its own work with your project's tests before it tells you it is done.

![The Tugline chat: each step on one line, ending with the result of your project's check](images/chat.png)

## Why Tugline
- **Your model, your data.** It works with any OpenAI-compatible endpoint. Point it at a model on your laptop or your company's server, and your code never leaves your network.
- **Safe by default.**
  - Commands run in an OS sandbox (bubblewrap on Linux, Seatbelt on macOS), and credential folders such as `~/.ssh` and `~/.aws` are hidden.
  - The agent can never change files you protect, such as tests, CI or its own config.
  - Auto mode has a safety classifier, and a set of fixed rules that the classifier cannot override.
- **It proves its work.** A run is marked *Verified* only when your project's own check (tests, build) passes after the last edit. If no check ran, it says so in plain words.
- **Review like a pull request.** Every edit lands in the editor as a change you can keep or undo, one hunk at a time. Checkpoints let you rewind files or the conversation.

![An approval card: the proposed edit, with Allow, Always allow and Deny](images/approval.png)

## Features
- **Chat panel:**
  - Several chats at once.
  - Queue or steer a running agent.
  - `@` to add files, problems, terminal output or a URL; `/` for commands and skills.
  - Paste images. Paste a long log or stack trace: it becomes one attachment, and when it is larger than the model's context, the agent gets its first and last lines and can search the rest.
  - Under each answer: how long it took, and where the time went (setup, the model's first reply, prompt tokens the server reused from its cache).
- **Modes:**
  - *Ask first*: approve every edit and command.
  - *Accept edits*: edits apply without asking; commands still ask.
  - *Plan*: read-only until you approve a plan.
  - *Auto*: a safety classifier approves routine steps.
  - *YOLO*: no prompts; deny rules, protected files and the sandbox still apply.
- **Editor:**
  - Inline edit on a selection (`Ctrl/Cmd+Alt+K`).
  - Next-edit suggestions and a "Fix with Tugline" quick fix.
  - Commit-message generation.
  - Notebook cells.
  - Code navigation through VS Code's language features.
- **Agents:**
  - Subagents.
  - Agent teams with a shared task board.
  - Sessions in separate git worktrees.
  - A Task Board where each card works in its own worktree.
  - An Arena that runs several models or agents on the same task and judges them with your project's check.
- **Tools:**
  - Files, terminal, web search and fetch.
  - A browser it can drive.
  - MCP servers.
  - Skills.
  - Language servers.
- **For teams:** a managed policy file can lock the endpoint and model, set deny rules and protected paths, cap daily spend, and require the sandbox. Every approval and refusal goes to a tamper-evident log.

## Get started
1. Open **Tugline** in the activity bar.
2. Connect your model, all inside the panel: **Settings** (the gear) → **Connections** → **Add a connection**.
   - **Ollama / LM Studio / llama.cpp:** the gallery marks the ones running on this computer. Pick one, then a model.
   - **Your company's server (vLLM, SGLang, Open WebUI, a gateway) or a hosted API (OpenRouter, OpenAI, Gemini, DeepSeek, Mistral, Groq, Together AI):** enter the base URL and API key. The model list loads from the server, with each model's context size; the context window is set to what the server reports, or pick 8K to 1M, or type any number. Custom headers for gateways are under More options.
   - **Test** checks the connection step by step: the server answers, it serves the model, the model chats, the model calls a tool. A failed step says what to fix.
   - Save several connections and switch between them from the model button under the message box. Each key is kept in VS Code's secret storage and sent only to the server it was saved for.
3. Ask for something, for example "Fix the failing tests". Tugline reads the code, proposes edits, runs the tests and reports what it verified.

![A connection in the panel: base URL, API key, the server's models and the step-by-step test](images/settings.png)

![Add a connection: local servers, your company's server or gateway, and hosted APIs](images/connections.png)

Models with native tool calling work best. For models without it, Tugline switches to a text tool protocol automatically.

![The start screen: the line to your model, and three starter tasks](images/start.png)

## The CLI
The same agent runs in your terminal and in scripts:
```bash
npm install -g tugline
tug                       # interactive
tug -p "fix the failing tests" --output-format json
```

## Privacy
Tugline sends your prompts and code only to the model endpoint **you** configure. It collects no telemetry. OpenTelemetry tracing is off unless you turn it on and point it at your own collector. When the endpoint is OpenRouter, Tugline downloads OpenRouter's public price list (no key is sent) so that spending limits work.

## Settings
- **Editor settings:** under `tugline.*`.
- **Your own rules, MCP servers and skills:** `~/.tugline/config.json`.
- **Project config:** `.tugline/config.json` can only make the rules stricter, never looser.
- **Project instructions:** read from `AGENTS.md`.

## Links
- Source, issues and documentation: [github.com/pmgarg/Tugline](https://github.com/pmgarg/Tugline)
- Licence: MIT. Third-party notices: [NOTICE](NOTICE).
