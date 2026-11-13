# Changelog

## 1.6.0: connections, set up in the panel
- **Connections.** Save each place your model runs once: Ollama on this computer, your company's server, OpenRouter and so on. Switch between them from the model button under the message box. The endpoint you already use becomes the first connection, with its key.
  - **Add a connection** opens a gallery: Ollama, LM Studio and llama.cpp (marked when they are running on this computer), a company server, Open WebUI, an API gateway, OpenRouter, OpenAI, Google Gemini, DeepSeek, Mistral, Groq, Together AI, or any URL.
  - One form holds everything: the base URL, the API key, the model (searched from the server's list, with each model's context size and whether it calls tools), the context window (Auto uses the size the server reports, or pick 8K to 1M, or type any number), the longest reply, tool calling, images, custom headers and a name.
  - **Test** checks a connection step by step on a line: the server answers, it serves the model, the model chats, the model calls a tool. A failed step says what to fix: a refused key, a chat website's address instead of its API, a certificate this computer does not trust.
  - Each connection's key and custom header values are kept in VS Code's secret storage, separately. A key is sent only to the server it was saved for: change a connection's address to another server and its key is dropped unless you type a new one.
- **Nothing opens the command palette.** **Add a Connection**, **Change the API Key** and **New skill** open in the panel; the old step-by-step palette wizard is gone. The model in the status bar opens the connections.
- **A new look.** Tugline's own colours: indigo for actions, amber for a connection that answers. The welcome screen shows the line from your editor to your model, and whether it answered its last test. Settings are three tabs (Connections, Behaviour, Safety), and the permission modes are a list to choose from.
- **Fix:** switching to another server (a local server on the setup card, or another connection) could send the previous server's API key to the new one in a model-list request made while the switch was under way. The old key is now removed before the address changes.

## 1.4.0: first stable release
- **Faster replies.**
  - The system prompt and the tool list are now byte-identical in every chat. A model server that caches prompts (vLLM, llama.cpp, Ollama, SGLang) reuses them instead of reading about 5,000 tokens again for each new chat. The date and git status, which change, now ride on the message instead.
  - A chat's agent is prepared, and the repository map built, as soon as the chat opens, so the first message no longer waits for them. Tugline's own time before the first request went from about 1.9 s to 0.2 s.
  - A message never waits more than 3 seconds for the repository map; on a very large repository the map comes with the next message.
  - Under each answer, a line shows where the time went: setup, the model's first reply, and prompt tokens the server reused from its cache.
- **Everything in the panel.**
  - A new Settings page in the panel sets the provider, base URL, API key, model (loaded from the server), context window, output limit and tool calling, with a connection test. Nothing opens the command palette anymore.
  - Mode, model and reasoning effort are menus in the panel.
  - Questions from slash commands appear in the chat, like the agent's own questions.
- **A new look.** Rounded cards and pill chips, in-panel menus, code blocks with a copy button, switches, and a cleaner empty chat. It uses your theme's colours in light, dark and high-contrast themes.
- **Large pastes.** A long log or stack trace pasted into the message box becomes one attachment, and shows collapsed in the chat. A message larger than the model's context is no longer rejected: the agent gets its first and last lines, and the full text is saved in `.tugline/pastes/` (never committed) for it to search.
- **Fixes.**
  - `tug audit export --since` dropped events in time zones away from UTC around midnight.
  - The agent was told the UTC date, which is a day off around midnight away from UTC; it now gets your local date.

## 1.2.7 (pre-release): the connection test no longer reports an untested fallback as failing
- When a model has native tool calls, the connection test showed "text tool calls ✗". The text protocol is only a fallback for models without native tool calls, and it was not tested in that case. It now shows "text tool calls not needed".

## 1.2.6 (pre-release): a chat website's address is explained, not "not valid JSON"
- When the base URL is the address of a chat website, not its API, the server answers with a web page. Tugline used to show "Unexpected token '<', "<!doctype" is not valid JSON" under "Can't reach". It now says that the address is a web page, not an API, and names the sign-in page if it was redirected to one.
- It also tries the usual API addresses on the same server (`/v1`, `/api`, `/api/v1`). If one answers, the setup card and **Configure LLM Endpoint** offer it as a button.

## 1.2.5 (pre-release, with CLI 1.2.0-beta.5): fixes from CI on GitHub's runners
- **The visible terminal:** on some machines VS Code did not report that a command had started, so every command waited for the 120-second timeout. Tugline now recognises the start reliably. If a command still does not start within 15 seconds, Tugline cancels it, says that it did not run, and runs commands in the background from then on.
- **The Linux sandbox:** every sandboxed command failed when `$XDG_RUNTIME_DIR` is `/run/user/<uid>`, the normal Linux desktop setup. Commands with network access failed on systems using systemd-resolved. Both are fixed.
- **The session log:** under heavy load a writer could skip the lock and break the log's hash chain. It now waits for the lock.

## 1.2.4 (pre-release, with CLI 1.2.0-beta.4): first public release as Tugline
Tugline was developed privately as "OpenHarness". This is the first public pre-release.

- **Chat panel:**
  - The agent's steps sit on one connected timeline, and each run ends with a plain *Verified*, *Check failed* or *Not verified* line.
  - The mode, model and effort pickers sit inside the message box.
  - The empty chat offers three starter tasks.
  - A pinned task list shows progress, and a "files changed" bar offers Keep and Undo.
- **Safety:** an OS sandbox for commands (bubblewrap, Seatbelt, containers), protected files, and an auto mode with a safety classifier and fixed rules it cannot override. A hash-chained log records every approval and refusal.
- **Agents:** subagents, agent teams, worktree sessions, a Task Board and an Arena.
- **Your git settings:** branch tracking (for example from "Publish Branch") is kept while a chat is open. Changes that could make git run programs are undone.
- **Shortcuts:** inline edit is `Ctrl/Cmd+Alt+K` and Add Selection to Chat is `Ctrl/Cmd+Alt+L`. Neither overrides a VS Code default.
