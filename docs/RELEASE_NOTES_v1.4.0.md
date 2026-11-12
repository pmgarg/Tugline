# Tugline 1.4.0: first stable release (CLI and VS Code extension)

Tugline is now a stable release on npm (`npm install -g tugline`) and in the VS Code Marketplace and Open VSX. It is the same agent as the 1.2.0 betas, with the fixes below. Pilot users reported that replies were slower than in Cline on the same company model, that settings opened the command palette, and that the panel looked dated. All three are addressed.

## Faster replies
- **Prompt caching works across chats.** The system prompt and the tool definitions are now byte-identical in every chat, on every day. Before, the date and git status sat in the middle of the system prompt. Whenever either had changed, a new chat made the model server read about 5,000 tokens again (the rest of the system prompt and every tool definition), even on servers that cache prompts. They now ride on the first message, and on later messages only when they change.
- **The first message does not wait for setup.** The VS Code panel prepares a chat's agent and builds the repository map as soon as the chat opens. Tugline's own time before the first request went from about 1.9 s to 0.2 s. A message never waits more than 3 seconds for the map (`agent.repoMapWaitMs`); on a very large repository the map comes with the next message.
- **You can see where the time goes.** Under each answer (and at the end of each CLI turn): setup time, the time to the model's first reply (mostly the server reading the prompt), and the prompt tokens the server reused from its cache.

## Settings in the panel
- A new **Settings** page in the chat panel sets the provider, base URL, API key, model (loaded from the server, with a filter), context window, output limit and tool calling, with **Save and test**. The key goes to VS Code's secret storage. **Tugline: Configure LLM Endpoint** opens this page; the step-by-step palette flow is still there as "Configure LLM Endpoint (step by step)".
- Mode, model and reasoning effort are menus inside the panel.
- Questions from slash commands appear in the chat, like the agent's own questions.

## A new look
Rounded cards and pill chips, in-panel menus, code blocks with a copy button, switches, collapsible long messages and a cleaner empty chat. Every colour comes from your VS Code theme (light, dark and high contrast). The chat view's title bar no longer repeats the panel's own buttons.

## Large pastes
- A long log or stack trace pasted into the message box becomes one attachment chip (click it to edit the text) and shows collapsed in the chat.
- A message larger than the model's context used to be rejected by the server ("maximum context length exceeded"). Now the agent gets its first and last lines. The full text is saved in `.tugline/pastes/` (which git ignores), and the agent can search it with grep or read line ranges.

## Fixes
- `tug audit export --since` dropped events around midnight in time zones away from UTC.
- The agent was told the UTC date, which is a day off around midnight away from UTC; it now gets your local date.
- The browser-extension test runs with the other real-browser tests, and the test runner stops a test file that blocks its own event loop after 15 minutes, naming it.

## Platforms
Linux is fully covered by CI: the CLI on Node 20, 22 and 24, the extension in a real VS Code, and real browsers. On macOS, CI installs and runs the CLI and runs the unit tests. The OS sandbox (Seatbelt) is used once `scripts/device-checks/sandbox-macos.sh` has passed on your Mac. On Windows, CI installs and runs the CLI; there is no built-in OS sandbox. See "Supported platforms" in the README.
