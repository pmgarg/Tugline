# Tugline 1.2.0-beta.5 (VS Code extension 1.2.5 pre-release)

**Fixes from the first full run of CI on GitHub's runners.** Beta.4 passed every test on our own machines. GitHub's Ubuntu runners have a different setup, which is the same setup as most Linux desktops. There they found four real bugs, and three of them broke everyday use. Use this release instead of beta.4.

## Fixes

**The OS sandbox on Linux (bubblewrap)**
- **Every sandboxed command failed when `$XDG_RUNTIME_DIR` is `/run/user/<uid>`**, which is the normal setup on a Linux desktop. The sandbox hides `/run` behind an empty read-only folder, then tried to mount the runtime folder inside it again, and bubblewrap refused ("Can't mkdir parents for /run/user/1000"). The runtime folder now stays hidden, with its sockets.
- **Commands with network access failed on systems using systemd-resolved.** `/etc/resolv.conf` points into `/run`, and it was mounted after `/run` had been made read-only. It is now mounted first.

**The session log.** Several processes can write to one session's log. Under heavy load, a writer waited only 1 second for the lock and then wrote without it, which broke the log's hash chain. A writer now waits up to 10 seconds. A stuck lock is removed only if it is the same one the writer judged stale, never a newer one. Under CPU load this failed 1 run in 4 before the fix and passed 4 in 4 after.

**VS Code: the visible terminal**
- On some machines, a command sent to the Tugline terminal never reported back, so every command waited for the full 120-second timeout. VS Code does not always report the start of a command with the same object it returned when the command was sent. Tugline now also matches the start by terminal and reads the output from the shell's own stream.
- If the shell still does not start the command within 15 seconds, Tugline cancels it and says so in the result. The command did not run. Commands then run in the background for the rest of the session, never twice.

**The desktop sandbox.** `tug desktop-sandbox up` now waits until the desktop reports it is ready. Before, the window sidecar could connect before the session bus existed, and it then never saw a window.

## Tests and CI
- The full suite passes on Ubuntu with Node 20, 22 and 24. The VS Code end-to-end suite and the real-browser and desktop group pass too.
- A test that leaves a process running can no longer hang the whole run: each test file exits when its tests are done, and a test with no time limit of its own fails by name after 10 minutes.
- The CLI installs and runs from the npm package on Ubuntu, macOS and Windows.

## Before general release
- **macOS:** about 50 of the 1,800 unit tests still fail on GitHub's macOS runners. They cover the language-server tools, some sandbox conformance scenarios and a background-server test. The macOS device checks (`scripts/device-checks`) are still to do.
- **Windows:** the CLI installs and runs, but the test suite assumes bash and Unix tools, so it is not yet a supported platform.
- **A hands-on pass of the VS Code UI by a person.**
