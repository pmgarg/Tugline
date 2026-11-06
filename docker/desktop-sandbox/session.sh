#!/usr/bin/env bash
# Start an accessibility-enabled X session around a command (used by the
# desktop sandbox image and the Linux sidecar CI test, SPEC F9/F10):
#   a D-Bus session bus, the AT-SPI bus, optionally a window manager and the
#   sample apps, then exec the given command (normally the sidecar on stdio).
# Run it under `xvfb-run -a dbus-run-session --` (CI) or inside the container.
#   TUG_SESSION_APPS="python3 /opt/tugline/apps/oh_calc.py"   apps to start first
#   TUG_SESSION_WM=fluxbox                                         window manager to start
set -u
export NO_AT_BRIDGE=0 GTK_A11Y=atspi QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
for l in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher /usr/lib/at-spi2/at-spi-bus-launcher; do
  if [ -x "$l" ]; then "$l" --launch-immediately >/dev/null 2>&1 & break; fi
done
sleep 0.3
if [ -n "${TUG_SESSION_WM:-}" ] && command -v "$TUG_SESSION_WM" >/dev/null; then "$TUG_SESSION_WM" >/dev/null 2>&1 & fi
if [ -n "${TUG_SESSION_APPS:-}" ]; then
  IFS=';' read -ra APPS <<< "$TUG_SESSION_APPS"
  for a in "${APPS[@]}"; do bash -c "$a" >/dev/null 2>&1 & done
fi
exec "$@"
