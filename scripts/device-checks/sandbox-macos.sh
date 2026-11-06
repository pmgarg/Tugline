#!/usr/bin/env bash
# SPEC C2 AC3 [DEVICE]: verify the Seatbelt sandbox on a Mac.
#
# Generates the Tugline SBPL profile for a scratch workspace, then checks
# with sandbox-exec that:
#   1. writing inside the workspace succeeds;
#   2. writing outside it (your home directory) fails;
#   3. writing .git/hooks inside the workspace fails (persistence path);
#   4. with no allowDomains, outbound network fails;
#   5. through the allowlist proxy, an allowlisted domain works and another is refused.
#
# Usage (from the repo root):  bash scripts/device-checks/sandbox-macos.sh
# Needs: macOS, node >= 20, npm deps installed, curl. Exit code 0 = all passed.
set -u
cd "$(dirname "$0")/../.."
if [ "$(uname)" != "Darwin" ]; then echo "SKIP: macOS only"; exit 0; fi
[ -x /usr/bin/sandbox-exec ] || { echo "FAIL: /usr/bin/sandbox-exec missing"; exit 1; }
. scripts/lib/preflight.sh
oh_preflight_deps || { echo "ABORTED: no checks were run (nothing recorded)."; exit 1; }

WS=$(mktemp -d /tmp/oh-sbx-ws.XXXXXX)
OUT="$HOME/.oh-sbx-outside-$$"
mkdir -p "$WS/.git/hooks"
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
ko() { echo "FAIL  $1"; fail=$((fail+1)); }

profile() { # $1 = network mode, $2 = proxy port
  node --import tsx -e "
    import('./src/core/sandbox/index.ts').then(m => process.stdout.write(m.seatbeltProfile({
      workspace: process.argv[1], writable: [], readOnly: ['.git/hooks', '.tugline'],
      network: process.argv[2], proxyPort: Number(process.argv[3]) || undefined, tmpDirs: [require('os').tmpdir()] })))" "$WS" "$1" "${2:-0}"
}

P=$(profile none)
echo "$P" > "$WS/../oh-sbx-profile.sb"
echo "profile written to $WS/../oh-sbx-profile.sb"
# A refusal only means something if the sandbox itself starts: an empty or broken profile makes every
# sandboxed command fail, which would look like "refused" and pass the negative checks.
case "$P" in *"(version 1)"*) ;; *) echo "ABORTED: the profile was not generated (see the error above); no checks counted."; exit 1 ;; esac
sandbox-exec -p "$P" /usr/bin/true || { echo "ABORTED: sandbox-exec cannot start with this profile; no checks counted."; exit 1; }

sandbox-exec -p "$P" /bin/sh -c "echo in > '$WS/inside.txt'" && [ -f "$WS/inside.txt" ] && ok "write inside the workspace" || ko "write inside the workspace"
sandbox-exec -p "$P" /bin/sh -c "echo out > '$OUT'" 2>/dev/null; [ -e "$OUT" ] && { ko "write outside the workspace was allowed"; rm -f "$OUT"; } || ok "write outside the workspace refused"
sandbox-exec -p "$P" /bin/sh -c "echo x > '$WS/.git/hooks/pre-commit'" 2>/dev/null; [ -e "$WS/.git/hooks/pre-commit" ] && ko ".git/hooks writable" || ok ".git/hooks read-only"
sandbox-exec -p "$P" /usr/bin/curl -sS -m 8 -o /dev/null https://example.com 2>/dev/null && ko "network reachable without allowDomains" || ok "no network without allowDomains"

# allowlist proxy: start it in node, run curl in the sandbox through it
cat > "$WS/../oh-sbx-proxy.mts" <<'JS'
import { DomainProxy } from './REPO/src/core/sandbox/proxy.ts';
const p = new DomainProxy({ allowDomains: ['example.com'] });
const port = p.listenTcpSync();
console.log(port);
setInterval(() => {}, 1000);
JS
sed -i '' "s#./REPO#$(pwd)#" "$WS/../oh-sbx-proxy.mts"
node --import tsx "$WS/../oh-sbx-proxy.mts" > "$WS/../port.txt" &
PROXY_PID=$!
disown $PROXY_PID 2>/dev/null || true   # no "Terminated" line when it is stopped at the end
sleep 2
PORT=$(head -1 "$WS/../port.txt")
case "$PORT" in ''|*[!0-9]*) echo "ABORTED: the allowlist proxy did not start (port '$PORT')"; kill $PROXY_PID 2>/dev/null; exit 1 ;; esac
PP=$(profile proxy "$PORT")
case "$PP" in *"(version 1)"*) ;; *) echo "ABORTED: the proxy profile was not generated"; kill $PROXY_PID 2>/dev/null; exit 1 ;; esac
HTTPS_PROXY="http://127.0.0.1:$PORT" sandbox-exec -p "$PP" /usr/bin/curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com | grep -q 200 && ok "allowlisted domain via proxy" || ko "allowlisted domain via proxy"
HTTPS_PROXY="http://127.0.0.1:$PORT" sandbox-exec -p "$PP" /usr/bin/curl -sS -m 15 -o /dev/null https://www.wikipedia.org 2>/dev/null && ko "non-allowlisted domain reachable" || ok "non-allowlisted domain refused"
sandbox-exec -p "$PP" /usr/bin/curl -sS -m 8 --noproxy '*' -o /dev/null https://example.com 2>/dev/null && ko "direct connection bypassed the proxy" || ok "direct connection (no proxy) refused"
kill $PROXY_PID 2>/dev/null
rm -rf "$WS" "$WS/../oh-sbx-proxy.mts" "$WS/../port.txt"
echo "passed $pass, failed $fail"
if [ "$fail" = 0 ]; then
  # N30 AC3: record the pass so shell.sandbox "auto" starts using Seatbelt on this Mac
  MARK="${TUG_HOME_DIR:-$HOME/.tugline}/device-checks/sandbox-macos.pass"
  mkdir -p "$(dirname "$MARK")"
  printf '{"check":"sandbox-macos","passed":%s,"at":"%s","macos":"%s"}\n' "$pass" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(sw_vers -productVersion 2>/dev/null)" > "$MARK"
  echo "recorded $MARK"
fi
[ "$fail" = 0 ]
