# Tugline desktop sandbox (SPEC F10; research CU §4 isolation tier T1):
# a throwaway Linux desktop for desktop automation, so the agent acts on a
# virtual X display instead of the user's real one.
#
#   Xvfb :1 + fluxbox      the display and a window manager
#   x11vnc + noVNC         watch (or take over) at http://127.0.0.1:6080/vnc.html
#   AT-SPI2 + python3-gi   accessibility trees for the sidecar
#   xdotool, ImageMagick   keys, pointer and screenshots
#   sample apps            oh_calc (GTK3), gnome-calculator if available
#
# Build:  docker build -t tugline/desktop-sandbox -f docker/desktop-sandbox/Dockerfile .
# Use:    tug desktop-sandbox up   (then desktop.backend = "sandbox")
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    NO_AT_BRIDGE=0 \
    GTK_A11Y=atspi \
    QT_ACCESSIBILITY=1 \
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 \
    LANG=C.UTF-8

# Behind a TLS-intercepting proxy: pass its CA as a build secret and the proxy
# as a build arg; apt then switches to https mirrors and trusts that CA:
#   docker build --network host --build-arg https_proxy=$HTTPS_PROXY \
#     --secret id=oh_ca,src=/path/to/ca.crt -f docker/desktop-sandbox/Dockerfile .
RUN --mount=type=secret,id=oh_ca,required=false \
    if [ -f /run/secrets/oh_ca ]; then \
      mkdir -p /usr/local/share/ca-certificates && cp /run/secrets/oh_ca /usr/local/share/ca-certificates/oh-build-ca.crt && chmod 644 /usr/local/share/ca-certificates/oh-build-ca.crt && \
      echo 'Acquire::https::CaInfo "/usr/local/share/ca-certificates/oh-build-ca.crt";' > /etc/apt/apt.conf.d/99oh-build-ca && \
      sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify \
      dbus dbus-x11 at-spi2-core \
      python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 \
      xdotool wmctrl imagemagick xclip \
      fonts-dejavu-core ca-certificates \
  && (apt-get install -y --no-install-recommends gnome-calculator || true) \
  && rm -rf /var/lib/apt/lists/* /etc/apt/apt.conf.d/99oh-build-ca /usr/local/share/ca-certificates/oh-build-ca.crt

RUN useradd -m -s /bin/bash agent
COPY src/core/automation/desktop/sidecars/linux_atspi.py /opt/tugline/linux_atspi.py
COPY docker/desktop-sandbox/apps/ /opt/tugline/apps/
COPY docker/desktop-sandbox/session.sh /opt/tugline/session.sh
COPY docker/desktop-sandbox/entrypoint.sh /opt/tugline/entrypoint.sh
COPY docker/desktop-sandbox/oh-desktop-sidecar /usr/local/bin/oh-desktop-sidecar
RUN chmod +x /opt/tugline/*.sh /opt/tugline/apps/*.py /usr/local/bin/oh-desktop-sidecar

USER agent
WORKDIR /home/agent
EXPOSE 6080
ENTRYPOINT ["/opt/tugline/entrypoint.sh"]
