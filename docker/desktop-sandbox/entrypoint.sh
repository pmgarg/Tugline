#!/usr/bin/env bash
# Container entrypoint: the display, the session D-Bus (address saved for
# `docker exec` sidecars), the AT-SPI bus, a window manager, the sample app and
# noVNC. The sidecar is started per connection with `oh-desktop-sidecar`.
set -u
Xvfb :1 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
eval "$(dbus-launch --sh-syntax)"
echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'" > /tmp/oh-session.env
for l in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher; do
  if [ -x "$l" ]; then "$l" --launch-immediately >/tmp/atspi.log 2>&1 & break; fi
done
sleep 0.3
fluxbox >/tmp/fluxbox.log 2>&1 &
python3 /opt/tugline/apps/oh_calc.py >/tmp/oh_calc.log 2>&1 &
if [ "${TUG_SANDBOX_VNC:-1}" = "1" ]; then
  x11vnc -display :1 -forever -shared -nopw -localhost -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  websockify --web /usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
fi
echo "tugline desktop sandbox ready"
exec sleep infinity
