#!/usr/bin/env bash
# session.sh: one side of a stream audit (the sender or a viewer), run by
# side.sh under dbus-run-session with ../frame-timing/dbus-session.conf (a
# private bus that can activate nothing: no ksecretd, no portal with the real
# HOME).
#
# 1. A nested `kwin_wayland --virtual` with its own XDG_CONFIG_HOME, on the
#    NVIDIA GPU (the frame-timing gate's capability-free copy + libdevorder),
#    switched to SA_W x SA_H at SA_HZ mHz.
# 2. The sender only: the audit's fake ScreenCast portal on this bus.
# 3. The app under bwrap: no /dev/snd, the user's PipeWire and Pulse sockets
#    covered, its own HOME (<dir>/<role>.home), its PipeWire and Pulse the
#    side's private graph, the probe preloaded, the frame trace on, stderr
#    stamped with CLOCK_MONOTONIC.
#
# Environment (side.sh sets it): SA_ROLE SA_DIR SA_W SA_H SA_HZ SA_GRAPH SA_APP
# SA_PROBE SA_WORK (kwin copy + libdevorder) SA_ENV (extra app environment).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
FT=$HERE/../frame-timing
D=$SA_DIR
SOCK=sa-wl-$SA_ROLE-$$
KCFG=$D/kwin-config
rm -rf "$KCFG"; mkdir -p "$KCFG" "$D/$SA_ROLE.home"
echo "$DBUS_SESSION_BUS_ADDRESS" > "$D/bus.addr"
echo "$SOCK" > "$D/wayland.sock"

XDG_CONFIG_HOME=$KCFG LD_PRELOAD=$SA_WORK/libdevorder.so \
  "$SA_WORK/kwin_wayland" --virtual --socket "$SOCK" --width "$SA_W" --height "$SA_H" --no-lockscreen \
  > "$D/kwin.log" 2>&1 &
KW=$!
echo $KW > "$D/kwin.pid"
for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/$SOCK" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/$SOCK" ] || { echo "[session] nested KWin did not start" >&2; kill $KW; exit 1; }
export WAYLAND_DISPLAY=$SOCK
unset DISPLAY

kd() { XDG_CONFIG_HOME=$KCFG kscreen-doctor "$@" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'; }
if [ "$SA_HZ" != "60000" ]; then
  kd "output.Virtual-0.addCustomMode.$SA_W.$SA_H.$SA_HZ.full" >/dev/null; sleep 0.5
  id=$(kd -o | grep -o "[0-9]*:${SA_W}x${SA_H}@[0-9.]*" | awk -F'[:@]' -v hz="$SA_HZ" \
    '{ d = $3 * 1000 - hz; if (d < 0) d = -d; if (d < 1000) print $1 }' | tail -1)
  [ -n "$id" ] && kd "output.Virtual-0.mode.$id" >/dev/null; sleep 0.5
fi
kd -o | grep -E 'Modes' | grep -o '[0-9]*:[0-9x]*@[0-9.]*\*' > "$D/mode.txt"
wayland-info 2>/dev/null | grep -m2 -i 'main device\|target device' > "$D/wayland-info.txt"

if [ "$SA_ROLE" = sender ]; then
  PIPEWIRE_REMOTE=$SA_GRAPH python3 "$HERE/fakeportal.py" --node sa-pattern --log "$D/portal.log" &
  echo $! > "$D/portal.pid"
fi

export HOME=$D/$SA_ROLE.home XDG_DATA_HOME=$D/$SA_ROLE.home/data \
  XDG_CONFIG_HOME=$D/$SA_ROLE.home/config XDG_CACHE_HOME=$D/$SA_ROLE.home/cache
export PIPEWIRE_REMOTE=$SA_GRAPH PULSE_SERVER=unix:$XDG_RUNTIME_DIR/$SA_GRAPH.pulse \
  PULSE_SINK=glass_g23_out PULSE_SOURCE=glass_g23_mic
export __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json __GLX_VENDOR_LIBRARY_NAME=nvidia
export PARACORD_FRAME_TRACE=1 SA_PROBE_LOG=$D/probe.log SA_PROBE_CFG=$D/probe.cfg
export RUST_LOG=${SA_RUST_LOG:-info}
fifo=$D/app.fifo; rm -f "$fifo"; mkfifo "$fifo"
python3 "$FT/stamp.py" "$D/app.log" < "$fifo" &
STAMP=$!
# shellcheck disable=SC2086
bwrap --dev-bind / / --tmpfs /dev/snd \
  --bind /dev/null "$XDG_RUNTIME_DIR/pipewire-0" --bind /dev/null "$XDG_RUNTIME_DIR/pipewire-0-manager" \
  --tmpfs "$XDG_RUNTIME_DIR/pulse" \
  -- env LD_PRELOAD="$SA_PROBE" ${SA_ENV:-} "$SA_APP" > "$fifo" 2>&1 &
APP=$!
echo $APP > "$D/app.pid"
( sleep 12; python3 "$FT/gpucheck.py" $APP "$D/wayland-info.txt" > "$D/gpu.txt" 2>&1 ) &
( sleep 4
  echo 'for (const w of workspace.windowList()) { if (w.normalWindow) w.setMaximize(true, true); }' > "$D/max.js"
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$D/max.js" sa-max >/dev/null
  qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null ) &
wait $APP
wait $STAMP; rm -f "$fifo"
[ -f "$D/portal.pid" ] && kill "$(cat "$D/portal.pid")" 2>/dev/null
kill $KW 2>/dev/null; wait $KW 2>/dev/null
rm -rf "$KCFG"
