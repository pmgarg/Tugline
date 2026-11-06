# Changelog

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
