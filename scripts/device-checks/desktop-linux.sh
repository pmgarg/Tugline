#!/usr/bin/env bash
# SPEC F1 AC2 / F9 [DEVICE]: desktop automation on a real Linux desktop (X11 recommended).
#
#   1. cua-driver (if installed: pip install cua-driver) → gnome-calculator 7×8=56
#   2. the AT-SPI sidecar (python3-gi gir1.2-atspi-2.0 at-spi2-core xdotool) → gnome-calculator 7×8=56
#   3. the CI fixture: the sidecar against the bundled GTK test app under Xvfb
#
# Usage (from the repo root): bash scripts/device-checks/desktop-linux.sh
set -u
cd "$(dirname "$0")/../.."
[ "$(uname)" = "Linux" ] || { echo "SKIP: Linux only"; exit 0; }
pass=0; fail=0
ok() { echo "PASS  $1"; pass=$((pass+1)); }
ko() { echo "FAIL  $1"; fail=$((fail+1)); }
[ -n "${WAYLAND_DISPLAY:-}" ] && echo "note: Wayland session: semantic AT-SPI actions work; keys/pointer need X11/XWayland (or use tug desktop-sandbox)"
if command -v cua-driver >/dev/null; then
  node --import tsx scripts/device-checks/desktop-check.mts --backend cua --app gnome-calculator && ok "cua-driver: gnome-calculator 7×8=56" || ko "cua-driver: gnome-calculator"
else echo "SKIP  1. cua-driver not installed"; fi
if command -v gnome-calculator >/dev/null && [ -n "${DISPLAY:-}" ]; then
  node --import tsx scripts/device-checks/desktop-check.mts --backend sidecar --app gnome-calculator && ok "sidecar: gnome-calculator 7×8=56" || ko "sidecar: gnome-calculator"
else echo "SKIP  2. no gnome-calculator or no DISPLAY"; fi
node --import tsx --test --test-name-pattern "F9 AC1" test/desktop-driver.test.ts >/dev/null 2>&1 && ok "sidecar: GTK test app under Xvfb" || ko "sidecar: GTK test app under Xvfb (needs xvfb-run, dbus-run-session)"
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
