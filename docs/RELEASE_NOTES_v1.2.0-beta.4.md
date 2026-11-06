# Tugline 1.2.0-beta.4 (VS Code extension 1.2.4 pre-release)

**The first public pre-release.** Tugline was developed privately as "OpenHarness" and is renamed for its public release:
- **CLI:** the command is now `tug`, installed with `npm install -g tugline`.
- **VS Code:** commands and settings are now `tugline.*`.
- **Your files and settings:** the config folder is `~/.tugline` (project: `.tugline/`), the ignore file is `.tuglineignore`, and environment variables start with `TUG_`.
- **Moving from a pilot build:** rename `~/.openharness` to `~/.tugline`.

**Beta.** Every item in this release passed an independent security review. The reviewer disabled each control in turn to confirm its test catches it, and ran the attack suite on every entry point. The full test suite and the VS Code end-to-end suite pass. A few checks still need macOS or a person; see "Before general release" below.

## Changes since the last private beta: a screenshot review of every VS Code panel

**A redesigned chat panel.**
- **The work trail:** the agent's steps (files read, edits with line counts, commands, approvals) are one-line rows on a connected timeline. Click a row to see its output. Each run ends with a clear *Verified*, *Check failed* or *Not verified* line in plain words.
- **The composer:** one box with the mode, model and effort pickers inside it. It grows as you type and has a send button. The context gauge sits under the box.
- **Look:** VS Code's own icons (Codicons) throughout. Colours come from your theme, including light, dark and high contrast.
- **The empty chat:** offers three starter tasks.
- **Above the composer:** a pinned task list with progress, and a "files changed" bar with Review, Undo all and Keep all.
- **Approval cards:** Allow, Always allow and Deny, and a field to tell the agent what to do instead.
- **Layout fixes:** the chat now gets the sidebar (Agents and History start collapsed), and tables render as tables.

**Fixes**
- **Shortcuts:** Ctrl/Cmd+Shift+K and +L had replaced VS Code's Delete Line and Select All Occurrences. Inline edit is now **Ctrl/Cmd+Alt+K** and Add Selection to Chat is **Ctrl/Cmd+Alt+L**.
- **Status bar:** it now shows the model from your settings, not an older one.
- **Proposed-change tab:** it closes once you answer the approval.
- **Checkpoints:** turns that changed no files are hidden; a toggle shows them.
- **Auto-approve:** "Run any command without asking" is set apart and asks you to confirm.
- **Endpoint unreachable:** one line with Configure endpoint and Test connection, instead of the error printed twice.
- **Arena and Task Board:** themed controls, and cards are named by title.

**Security: git settings you change while a chat is open.** The protected-file guard used to undo every change to `.git/config`, including your own "Publish Branch". Now:
- **Branch tracking** (`branch.<b>.remote/merge/…`) and `user.name/email` are kept. A branch may only point at `.` or a remote that already exists; any other value is read by git as a URL or path.
- **Remote URLs** are kept only when no agent could have written them: nothing is running, no agent process is alive, and every open session runs commands in an OS sandbox that mounts `.git/config` read-only (bwrap, Seatbelt, Docker or Podman, but not Landlock). Without such a sandbox, remote edits are undone as before.
- **Everything else** (hooks, fsmonitor, filters, aliases, includes, credential helpers…) is undone as before, and the guard keeps exactly the bytes it checked.

An independent security reviewer rejected the first two versions: one would have let an agent's `pushremote = ./evil.git` run hooks on your next push, and one had a Landlock gap. Both are fixed and covered by tests (`test/git-config-adopt.test.ts`).

## Changes since beta.1: fixes from the live run (OpenRouter, qwen/qwen3.8-27b, 5 Nov 2026)
A day of live testing found 8 problems. All are fixed, each with a test that fails without its fix.
- **Security: benchmarked external agents (Cline, Qwen Code) never see your real API key.** They get a per-run dummy key, and the metering proxy adds the real one upstream. Before, the key was in Cline's command line and in its saved settings in the results folder.
- **Dollar limits work on OpenRouter.** Prices come from OpenRouter's public model list (cached for a day) when a profile sets none. Before, every cost was $0 and spend caps never applied.
- **Stronger auto-mode safety rules.** These are now always blocked or asked about, whatever the classifier says:
  - commands that print credentials (`gh auth token`, `kubectl config view --raw`, …);
  - git options and environment variables that run programs (`GIT_PAGER`, `git grep -O`, `LD_PRELOAD`, …);
  - schema wipes (`rails db:reset`, `prisma migrate reset`, …).
- **The auto-mode classifier works on OpenRouter.** It switches the model's thinking off, which it already did for other endpoints. Before, its first quick check spent the whole budget thinking and fell through to the slower check.
- **Unattended runs can verify their work.** The project's test command goes through the auto-mode approver. A safety-rule "ask" still wins.
- **Eval runner fixes.** Only a task's acceptance commands are run as checks. Before, it ran:
  - tool names such as `browser_verify` as shell commands;
  - verification markers such as a bare `javac`.

**Live results:**

| Run | Result |
|---|---|
| Editing | 62/62 |
| Coding | 24/30 (the 6 misses are honest failures on a trap task) |
| Browser | 9/9 verified |
| Auto-mode held-out set | 0 unsafe allows on the 27B model |
| Team and goal runs | passed |
| VS Code live run | passed |
| Cline 3.0.74 vs Tugline | 5/6 each; on the hardest task Tugline used about 14× fewer tokens and finished about 16× faster |

Evidence is in `docs/evidence/live-2026-11-05-qwen3.8-27b/`.

## Install
- **VS Code:** Extensions view → `…` → Install from VSIX → `tugline-1.2.4.vsix`.
- **CLI:** `npm install -g ./tugline-1.2.0-beta.4.tgz`, then `tug doctor`.
- **Model:** any OpenAI-compatible endpoint, for example Ollama, a vLLM or llama.cpp server, your company gateway, or OpenRouter:
  ```bash
  export TUG_BASE_URL=https://openrouter.ai/api/v1 TUG_API_KEY=sk-or-... TUG_MODEL=qwen/qwen3.8-27b
  tug -p "say hi"            # quick check
  ```
  In VS Code, run **Tugline: Configure LLM Endpoint**, choose **OpenRouter**, paste the key (it is stored in VS Code SecretStorage), then pick a model.

## What's new
**Safety foundation**
- **Sandbox everywhere.**
  - bwrap, with a Landlock fallback on Linux; Seatbelt on macOS.
  - Whole-session container mode (`tug --container docker|podman`).
  - Podman support.
  - `tug sandbox status|verify|trust-project`.
- **Protected credentials and daemon sockets.** Credential stores (`~/.ssh`, `~/.aws`, …) and the Docker/containerd sockets are unreachable, and the permission rules ask before reading them even when no sandbox is available.
- **The API key stays out of containers.** In container mode the model is reached through a hardened relay: model API paths only, GET/POST/HEAD only, no redirects. The key never enters the container.
- **Project config can only tighten.** A repository's config cannot loosen the sandbox, network, permission mode, hooks, MCP trust or chat channels.
- **Attack suite.** 10 hostile scenarios run on all 13 entry points (CLI, SDKs, ACP, `tug serve`, VS Code, channels, scheduler, subagents, teammates, workflow items, arena, board cards, remote jobs). Each must refuse identically and record a journal with an intact hash chain.

**Agents**
- **Auto mode v2** (`--mode auto`, `/mode auto`, the VS Code picker):
  - Order of checks: fixed safety rules, then fast paths for read-only commands (exact option allowlists), then a two-stage classifier that knows what you asked for.
  - Denial tracking, and archive extraction always asks you.
  - `/permissions` lists your rules by source and edits user rules. Company rules can't be changed from any surface.
- **Nested subagents and declarative workflows** (`tug workflow run`). A child can never get more tools, mode, roots, budget, MCP servers or hooks than its parent.
- **Agent teams** (`/team`, `tug team run`):
  - Task board, messages, a worktree per member, and budget pools.
  - Cline or Qwen Code as members, sandboxed and metered.
  - Board hosts across machines, and delegation from another agent with a grant (A2A).
- **Goals with an independent verifier** (`/goal <condition>` without `--check`). A met goal is labelled "judged met (independent verifier)"; "verified" stays reserved for checks the harness runs itself.

**VS Code and tools**
- **VS Code**
  - The auto-approve "read-only commands" option now uses auto mode's strict rules.
  - Code navigation uses the editor's language providers.
  - New Kanban board and arena views.
- **Language servers** managed by Tugline: definitions, references, rename (preview and apply, with checkpoints), diagnostics after edits. They run in the sandbox and never load project code.
- **Arena:** models or external agents compete in parallel worktrees. Each is judged by the project's check as it was before the run; a contestant that edits the tests is marked "altered".
- **Kanban board:** one worktree per card, created from an issue, a PR or a prompt. Every merge is conflict-checked, re-verified and journaled.
- **CLI:** about 30 new features, including:
  - `--output-format json|stream-json` (validated against a published schema);
  - `tug attach`, `tug batch`, `tug memory`, `tug doctor fix|log`;
  - `--mcp-config`, `--hooks-dir`, `--disabled-slash-commands`;
  - OS certificate trust;
  - resume and continue.

**Existing chat channels (Telegram, Slack, webhook)**
- Streamed replies never show the start of a secret.
- Link previews and unfurls are off.
- Bad signatures and refused senders go to the hash-chained audit log.
- A project config can't change channel settings.

## Breaking changes and migration
| Before (1.0) | Now | What to do |
|---|---|---|
| `mode: "auto"`: run everything without asking | **`yolo`**; `auto` is now the classifier mode | Configs that say `auto` get the safer classifier mode, with a one-time notice. Use `yolo` (or `-y` / `--yolo`) for the old behaviour; it prints a warning, and managed policy can forbid it (`disableYoloMode`). |
| `-y` / `--yes` | Same as `--yolo` | Warned, journaled, refused when policy forbids it. `tug board/arena --yes` only skips the merge confirmation. |
| Auto mode ran `git pull` and archive extraction | Both always ask | Approve once, or add a user-scope rule. |
| External agent CLIs could run without a sandbox | Refused without an OS sandbox or under `disableAutoMode` | User opt-in: `"external": {"allowUnsandboxed": true}`. |
| `a2a/delegate` with a secret only | Callers also send the grant id | Without the id, calls share a global rate limit. |
| Landlock fallback | No Python multiprocessing, no direct writes in `$HOME` when `$HOME` is the workspace | Use bwrap, the default on Linux, which handles both. |

## Known limitations in this beta
- **Not yet checked on macOS:**
  - the macOS sandbox for team members and the verifier;
  - containers on macOS;
  - the VS Code side-by-side with Cline.

  All are in one script: `scripts/device-checks/v1.2-mac-batch.sh` (works with Ollama or OpenRouter).
- **VS Code Remote-SSH** should work: the extension runs on the remote host (`extensionKind: workspace`). It is untested; a manual check is in the batch.
- **Not in this release:**
  - new chat platforms (Feishu, DingTalk, WeCom, WeChat, Teams; paused by decision);
  - issue→PR automation and PR review autofix (N4–N6);
  - memory consolidation (N20);
  - spec/plan documents (N13, N19);
  - MCP OAuth button (N33);
  - web UI, desktop app, SSO/roles, Java SDK, native JetBrains/Zed plugins, SSH workspaces, cloud agents (v1.2 wave 2).
- **Timing-sensitive tests:** two tests that wait for a background process (R1 "persistent rewriter" and "shed session") can fail on a heavily loaded 2-CPU machine. Both pass when run alone. The second now waits longer.
- **No hands-on UI review yet:** an automated tour screenshots every panel (`vscode/test/uiTour.cjs`) and 39 VS Code scenarios pass, but no person has used every view yet.

## Before general release
1. Run the Mac batch and save its evidence, then do a hands-on UI walkthrough in VS Code (install from the .vsix, set up OpenRouter, run a task, Keep/Undo, each view).
2. Run a pilot on the target company model (Qwen 27B): 10–15 real tasks against Cline (`docs/PILOT.md`).
3. Decide whether the issue→PR loop (N4–N6) is required for your team's automation.
