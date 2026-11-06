#!/usr/bin/env bash
# SPEC F1 AC3 [DEVICE]: Calculator 7×8=56 through Tugline on your Mac.
#
#   1. driver check (no model): cua-driver → launch Calculator → snapshot → 7 × 8 = → verify 56
#   2. tug check (needs a model): `tug -p` with desktop enabled and Calculator auto-approved;
#      a text-only model reads the accessibility tree and presses the buttons by ref.
#   3. kill switch: `tug emergency-stop` writes ~/.tugline/STOP (then clears it).
#
# Usage (from the repo root):
#   pip install cua-driver            # once; grant Accessibility to CuaDriver.app when asked
#   TUG_BASE_URL=http://127.0.0.1:11434/v1 TUG_MODEL=qwen3:8b bash scripts/device-checks/desktop-macos.sh
# Step 2 is skipped without TUG_BASE_URL. Exit code 0 = all run steps passed.
set -u
cd "$(dirname "$0")/../.."
if [ "$(uname)" != "Darwin" ]; then echo "SKIP: macOS only (Linux: scripts/device-checks/desktop-linux.sh)"; exit 0; fi
command -v cua-driver >/dev/null || { echo "FAIL: cua-driver not on PATH (pip install cua-driver)"; exit 1; }
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
ko() { echo "FAIL  $1"; fail=$((fail+1)); }

echo "== 1. driver check (cua-driver $(cua-driver --version 2>/dev/null | head -1))"
if node --import tsx scripts/device-checks/desktop-check.mts --backend cua --app Calculator; then ok "driver: Calculator 7×8=56"; else ko "driver: Calculator 7×8=56 (see the cause_hint above: permissions → grant Accessibility to CuaDriver.app)"; fi
osascript -e 'tell application "Calculator" to quit' >/dev/null 2>&1

if [ -n "${TUG_BASE_URL:-}" ]; then
  echo "== 2. tug check (model ${TUG_MODEL:-default} @ $TUG_BASE_URL)"
  WS=$(mktemp -d /tmp/oh-desktop-ws.XXXXXX)
  mkdir -p "$WS/.tugline"
  cat > "$WS/.tugline/config.local.json" <<JSON
{ "desktop": { "enabled": true, "backend": "cua", "autoApproveApps": ["Calculator"] } }
JSON
  OUT=$(cd "$WS" && TUG_PERMISSION_MODE=yolo node --import tsx "$OLDPWD/src/cli/main.ts" --trust -y -p "Use the Calculator app on this Mac (desktop_apps launch, desktop_snapshot, desktop_act by ref) to compute 7 × 8 by pressing its buttons. Do not compute it yourself. Reply with only the number the Calculator displays." 2>&1)
  echo "$OUT" | tail -5
  echo "$OUT" | grep -q '56' && ok "oh: model pressed 7 × 8 = and read 56" || ko "oh: model run did not report 56"
  ls -d "$WS"/.tugline/runs/*-desktop >/dev/null 2>&1 && ok "trajectory recorded ($(ls -d "$WS"/.tugline/runs/*-desktop))" || ko "no desktop trajectory recorded"
  osascript -e 'tell application "Calculator" to quit' >/dev/null 2>&1
else
  echo "SKIP  2. tug check (set TUG_BASE_URL and TUG_MODEL)"
fi

echo "== 3. kill switch"
node --import tsx src/cli/main.ts emergency-stop >/dev/null && [ -f "$HOME/.tugline/STOP" ] && ok "tug emergency-stop wrote ~/.tugline/STOP" || ko "STOP file not written"
node --import tsx src/cli/main.ts emergency-stop --clear >/dev/null && [ ! -f "$HOME/.tugline/STOP" ] && ok "STOP cleared" || ko "STOP not cleared"

echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
