#!/usr/bin/env bash
# SPEC_V1_2 N36 AC5 [DEVICE]: Seatbelt (N36 additions) and the whole-session container mode on a Mac.
#
# Part A, Seatbelt per command (both profile styles, "permissive" and the ported "restrictive"):
#   1. a workspace write succeeds;  2. a write outside it fails;  3. a credential store (~/.ssh in a scratch
#   HOME) is unreadable;  4. ordinary programs still run (sh, node);  5. no network without a proxy.
# Part B, container session (Docker Desktop, else Podman machine; skipped with a note if neither runs):
#   6. `tug --container -p` completes a mock task (the file appears in the workspace);
#   7. the host home is not visible inside;  8. a direct connection fails;  9. a non-allowlisted host is
#   refused by the proxy (403);  10. no session container or network is left behind;
#   11. another service on the Mac's localhost (host.docker.internal:<port>) is NOT reachable: only the model
#   endpoint, through the relay (review finding 8);  12. the API key is in no process environment inside the
#   container (finding 7);  13. links planted in the container home do not make the next session rewrite the
#   host user config (finding 2);  14. the model relay refuses crafted paths (`/m0/v1/%2e%2e/…`, `/m0//host/…`)
#   and serves the model path (re-check RC-1).
# Save the whole transcript as AC5 evidence under docs/evidence/N36/ (SPEC §0.1).
#
# Usage (from the repo root):  bash scripts/device-checks/sandbox-container-macos.sh
# Needs: macOS, node >= 20, `npm ci` done on this Mac. Part B builds dist/ (npm run build) because the container
# runs the built CLI with the repository mounted read-only. Exit code 0 = all run checks passed.
set -u
cd "$(dirname "$0")/../.."
if [ "$(uname)" != "Darwin" ]; then echo "SKIP: macOS only"; exit 0; fi
[ -x /usr/bin/sandbox-exec ] || { echo "FAIL: /usr/bin/sandbox-exec missing"; exit 1; }
. scripts/lib/preflight.sh
oh_preflight_deps || { echo "ABORTED: no checks were run."; exit 1; }
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
ko() { echo "FAIL  $1"; fail=$((fail+1)); }

SCR=$(mktemp -d /tmp/oh-n36-mac.XXXXXX)
WS="$SCR/ws"; FAKEHOME="$HOME/.oh-n36-fakehome-$$"; OUT="$HOME/.oh-n36-outside-$$"
mkdir -p "$WS" "$FAKEHOME/.ssh"
echo "N36-MAC-CANARY" > "$FAKEHOME/.ssh/id_ed25519"
cleanup() { rm -rf "$SCR" "$FAKEHOME" "$OUT"; }
trap cleanup EXIT

profile() { # $1 = style
  node --import tsx -e "
    import('./src/core/sandbox/index.ts').then(m => process.stdout.write(m.seatbeltProfile({
      workspace: process.argv[1], writable: [], readOnly: ['.git/hooks'], network: 'none',
      tmpDirs: [require('os').tmpdir()], denyRead: [process.argv[2] + '/.ssh'], style: process.argv[3] })))" "$WS" "$FAKEHOME" "$1"
}

for STYLE in permissive restrictive; do
  P=$(profile $STYLE)
  case "$P" in *"(version 1)"*) ;; *) echo "ABORTED: the $STYLE profile was not generated"; exit 1 ;; esac
  sandbox-exec -p "$P" /usr/bin/true || { echo "ABORTED: sandbox-exec cannot start the $STYLE profile"; exit 1; }
  rm -f "$WS/inside.txt"
  sandbox-exec -p "$P" /bin/sh -c "echo in > '$WS/inside.txt'" && [ -f "$WS/inside.txt" ] && ok "[$STYLE] write inside the workspace" || ko "[$STYLE] write inside the workspace"
  sandbox-exec -p "$P" /bin/sh -c "echo out > '$OUT'" 2>/dev/null; [ -e "$OUT" ] && { ko "[$STYLE] write outside the workspace was allowed"; rm -f "$OUT"; } || ok "[$STYLE] write outside the workspace refused"
  R=$(sandbox-exec -p "$P" /bin/cat "$FAKEHOME/.ssh/id_ed25519" 2>&1)
  case "$R" in *N36-MAC-CANARY*) ko "[$STYLE] ~/.ssh readable" ;; *) ok "[$STYLE] ~/.ssh unreadable ($R)" ;; esac
  sandbox-exec -p "$P" "$(command -v node)" -e "require('fs').writeFileSync('$WS/n.txt','ok')" && [ -f "$WS/n.txt" ] && ok "[$STYLE] node runs and writes in the workspace" || ko "[$STYLE] node does not run under the profile"
  rm -f "$WS/n.txt"
  sandbox-exec -p "$P" /usr/bin/curl -sS -m 8 -o /dev/null https://example.com 2>/dev/null && ko "[$STYLE] network reachable" || ok "[$STYLE] no network"
done

# ---------------------------------------------------------------- Part B: container session
ENGINE=""
if command -v docker >/dev/null && docker version >/dev/null 2>&1; then ENGINE=docker
elif command -v podman >/dev/null && podman version >/dev/null 2>&1; then ENGINE=podman; fi
if [ -z "$ENGINE" ]; then
  echo "NOTE  Part B skipped: neither Docker Desktop nor a Podman machine is running (start one and re-run)."
else
  echo "container engine: $ENGINE"
  npm run -s build >/dev/null 2>&1 || { echo "ABORTED: npm run build failed (Part B needs dist/)"; exit 1; }
  $ENGINE image inspect node:22-bookworm-slim >/dev/null 2>&1 || $ENGINE pull node:22-bookworm-slim >/dev/null || { ko "cannot pull node:22-bookworm-slim"; }
  node --import tsx scripts/device-checks/sandbox-container-check.mts "$ENGINE" > "$SCR/b.out" 2>&1
  cat "$SCR/b.out" | grep -E '^(PASS|FAIL)'
  pass=$((pass + $(grep -c '^PASS' "$SCR/b.out"))); fail=$((fail + $(grep -c '^FAIL' "$SCR/b.out")))
  grep -q '^PASS' "$SCR/b.out" || { echo "Part B output:"; tail -40 "$SCR/b.out"; fail=$((fail+1)); }
fi
echo "passed $pass, failed $fail"
[ "$fail" = 0 ]
