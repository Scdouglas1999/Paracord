#!/usr/bin/env bash
# session.sh: the inside of one run (run.sh starts it under dbus-run-session,
# so the client sees a private session bus: no keyring, no notifications, no
# single-instance clash with a Paracord the owner is running).
#
# 1. A nested `kwin_wayland --virtual` with its own XDG_CONFIG_HOME (a nested
#    KWin otherwise writes its virtual output into the real
#    ~/.config/kwinoutputconfig.json), on the NVIDIA GPU (libdevorder.so).
# 2. The output switched to FT_HZ and checked.
# 3. The client under bwrap: no /dev/snd, the real PipeWire and Pulse sockets
#    covered, a private HOME; its stdout/stderr stamped with CLOCK_MONOTONIC.
# 4. The GPU check from /proc, CPU sampling of the client's process tree.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$FT_OUT; label=$FT_LABEL; WORK=$FT_WORK
W=${FT_W:-5120}; H=${FT_H:-1440}; HZ=${FT_HZ:-240000}
SOCK=ft-wl-$$
KCFG=$OUT/$label.kwin-config
rm -rf "$KCFG" "$OUT/$label.home"; mkdir -p "$KCFG" "$OUT/$label.home"

XDG_CONFIG_HOME=$KCFG LD_PRELOAD=$WORK/libdevorder.so \
  "$WORK/kwin_wayland" --virtual --socket "$SOCK" --width "$W" --height "$H" --no-lockscreen \
  > "$OUT/$label.kwin.log" 2>&1 &
KW=$!
for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/$SOCK" ] && break; sleep 0.2; done
[ -S "$XDG_RUNTIME_DIR/$SOCK" ] || { echo "[session] nested KWin did not start" >&2; kill $KW; exit 1; }
export WAYLAND_DISPLAY=$SOCK
unset DISPLAY

kd() { XDG_CONFIG_HOME=$KCFG kscreen-doctor "$@" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'; }
if [ "$HZ" != "60000" ]; then
  kd "output.Virtual-0.addCustomMode.$W.$H.$HZ.full" >/dev/null; sleep 0.5
  id=$(kd -o | grep -o "[0-9]*:${W}x${H}@[0-9.]*" | awk -F'[:@]' -v hz="$HZ" \
    '{ d = $3 * 1000 - hz; if (d < 0) d = -d; if (d < 1000) print $1 }' | tail -1)
  [ -n "$id" ] && kd "output.Virtual-0.mode.$id" >/dev/null; sleep 0.5
fi
modes=$(kd -o | grep -E 'Modes')
current=$(echo "$modes" | grep -o '[0-9]*:[0-9x]*@[0-9.]*\*' | head -1)
cur_hz=$(echo "$current" | sed 's/.*@\([0-9.]*\)\*/\1/')
if [ -n "$cur_hz" ] && awk -v c="$cur_hz" -v hz="$HZ" 'BEGIN { d = c * 1000 - hz; if (d < 0) d = -d; exit !(d < 1000) }'; then
  echo "[mode] ok: ${current%\*} (asked ${W}x${H} at $HZ mHz)" > "$OUT/$label.mode"
else
  echo "[mode] FAIL: current mode '${current}' is not ${W}x${H} at $HZ mHz; modes: $modes" > "$OUT/$label.mode"
fi
wayland-info 2>/dev/null | grep -m2 -i 'main device\|target device' > "$OUT/$label.wayland-info"

export HOME=$OUT/$label.home XDG_DATA_HOME=$OUT/$label.home/data \
  XDG_CONFIG_HOME=$OUT/$label.home/config XDG_CACHE_HOME=$OUT/$label.home/cache
export PULSE_SINK=glass_g23_out PULSE_SOURCE=glass_g23_mic.monitor \
  PIPEWIRE_REMOTE=ft-no-pipewire PULSE_SERVER=unix:/nonexistent/ft-no-pulse
# The stamper reads a FIFO so it is not a descendant of the client (whose
# process tree is what the CPU numbers cover).
fifo=$OUT/$label.fifo; rm -f "$fifo"; mkfifo "$fifo"
python3 "$HERE/stamp.py" "$OUT/$label.log" < "$fifo" &
STAMP=$!
# shellcheck disable=SC2086
bwrap --dev-bind / / --tmpfs /dev/snd \
  --bind /dev/null "$XDG_RUNTIME_DIR/pipewire-0" --bind /dev/null "$XDG_RUNTIME_DIR/pipewire-0-manager" \
  --tmpfs "$XDG_RUNTIME_DIR/pulse" \
  -- env ${FT_ENV:-} $FT_CMD > "$fifo" 2>&1 &
APP=$!
python3 "$HERE/cpusample.py" $APP "$OUT/$label.cpu" &
( sleep "${FT_PROBE_AT:-9}"; python3 "$HERE/gpucheck.py" $APP "$OUT/$label.wayland-info" > "$OUT/$label.gpu" 2>&1 ) &
if [ "${FT_MAXIMIZE:-}" = 1 ]; then
  ( sleep 5
    echo 'for (const w of workspace.windowList()) { if (w.normalWindow) w.setMaximize(true, true); }' > "$OUT/$label.max.js"
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$OUT/$label.max.js" ft-max >/dev/null
    qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null ) &
fi
if [ -n "${FT_SHOT:-}" ]; then
  ( sleep "${FT_SHOT%%:*}"; mkdir -p "$OUT/$label.spectacle"
    XDG_CONFIG_HOME=$OUT/$label.spectacle timeout 20 spectacle -b -n -f -o "$OUT/${FT_SHOT#*:}.png" >/dev/null 2>&1 ) &
fi
wait $APP
wait $STAMP; rm -f "$fifo"
sleep 0.5
kill $KW 2>/dev/null; wait $KW 2>/dev/null
rm -rf "$KCFG"
