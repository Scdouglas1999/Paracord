# A "computer" for the fresh-machine gate: systemd as PID 1, one person (sam,
# uid 1000, lingering off) with a real systemd user session, the Secret
# Service (gnome-keyring), Xvfb, PipeWire with null devices, WebKitGTK and
# its WebDriver. The Paracord desktop build is copied in by the harness.
FROM archlinux:latest
RUN pacman -Syu --noconfirm --needed \
      webkit2gtk-4.1 webkitgtk-6.0 gtk3 libayatana-appindicator libvpx opus ffmpeg \
      xorg-server-xvfb xdotool xorg-xwininfo xclip imagemagick ttf-dejavu noto-fonts mesa \
      gnome-keyring libsecret dbus \
      pipewire pipewire-pulse wireplumber libpulse \
      sqlcipher sqlite python python-cryptography jq curl iproute2 procps-ng which xdg-utils desktop-file-utils \
 && pacman -Scc --noconfirm \
 && useradd -m -u 1000 -s /bin/bash sam \
 && rm -f /etc/machine-id && touch /etc/machine-id
# tauri-driver listens on loopback only; socat exposes it to the harness.
RUN pacman -S --noconfirm --needed socat && pacman -Scc --noconfirm
COPY units/xvfb.service /etc/systemd/system/xvfb.service
COPY units/pc-session.service /etc/systemd/system/pc-session.service
COPY units/pc-keyring.service /etc/systemd/user/pc-keyring.service
COPY units/pc-audio.service /etc/systemd/user/pc-audio.service
COPY pc.sh /usr/local/bin/pc
RUN chmod 0755 /usr/local/bin/pc \
 && systemctl enable xvfb.service \
 && systemctl --global enable pc-keyring.service pc-audio.service \
 && systemctl mask systemd-firstboot.service systemd-networkd-wait-online.service getty@tty1.service console-getty.service systemd-resolved.service \
 && mkdir -p /etc/systemd/logind.conf.d && printf '[Login]\nUserStopDelaySec=0\nKillUserProcesses=yes\n' > /etc/systemd/logind.conf.d/90-fresh-machine.conf \
 && mkdir -p /etc/wireplumber/wireplumber.conf.d \
 && printf 'wireplumber.profiles = {\n  main = {\n    monitor.alsa = disabled\n    monitor.bluez = disabled\n    monitor.libcamera = disabled\n    monitor.v4l2 = disabled\n  }\n}\n' > /etc/wireplumber/wireplumber.conf.d/90-fresh-machine.conf
STOPSIGNAL SIGRTMIN+3
ENV container=docker
ENTRYPOINT ["/bin/bash", "-c", "mount -o remount,rw /sys/fs/cgroup && exec /usr/lib/systemd/systemd"]
