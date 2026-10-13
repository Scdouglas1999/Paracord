#!/usr/bin/env bash
# run.sh <label> <client command...>: one frame-timing run in a nested KWin on
# the NVIDIA GPU. Never touches the real display, the real KWin config, the
# real audio devices or the real session bus.
#
#   FT_OUT      where logs go (default /tmp/paracord-frame-timing)
#   FT_WORK     tool cache: the capability-free kwin_wayland copy and
#               libdevorder.so (default ~/.cache/paracord-frame-timing)
#   FT_W FT_H   virtual output size (default 5120x1440)
#   FT_HZ       refresh in mHz (default 240000 -> a 239.90 Hz custom mode;
#               60000 keeps KWin's native 60 Hz mode)
#   FT_ENV      extra environment for the client ("A=1 B=2")
#   FT_MAXIMIZE 1 to maximize the client's window through a KWin script
#   FT_TIMEOUT  hard limit for the whole session, seconds (default 130)
#   FT_PROBE_AT seconds after start to check the GPU from /proc (default 9)
#   FT_SHOT     "<seconds>:<name>" to take a screenshot inside the session
#
# Writes $FT_OUT/<label>.{log,cpu,gpu,session.log,mode}. Exits non-zero when
# the GPU check fails, the output mode is not the requested one, or the real
# ~/.config/kwinoutputconfig.json changed.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
[ $# -ge 2 ] || { sed -n '2,20p' "$0"; exit 2; }
label=$1; shift

export FT_OUT=${FT_OUT:-/tmp/paracord-frame-timing}
export FT_WORK=${FT_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/paracord-frame-timing}
mkdir -p "$FT_OUT" "$FT_WORK"

# Tools. A copy of kwin_wayland has no file capabilities (the installed one has
# cap_sys_nice), so the dynamic loader honors LD_PRELOAD for it; libdevorder
# lists the NVIDIA DRM device first, so KWin's virtual backend renders there.
if [ ! -x "$FT_WORK/kwin_wayland" ] || [ /usr/bin/kwin_wayland -nt "$FT_WORK/kwin_wayland" ]; then
  cp /usr/bin/kwin_wayland "$FT_WORK/kwin_wayland" || exit 1
fi
if [ ! -f "$FT_WORK/libdevorder.so" ] || [ "$HERE/devorder.c" -nt "$FT_WORK/libdevorder.so" ]; then
  gcc -shared -fPIC -O2 -o "$FT_WORK/libdevorder.so" "$HERE/devorder.c" \
    $(pkg-config --cflags --libs libdrm) -ldl || exit 1
fi

real_cfg=$HOME/.config/kwinoutputconfig.json
sum() { [ -f "$1" ] && md5sum "$1" | cut -d' ' -f1 || echo absent; }
before=$(sum "$real_cfg")

FT_LABEL=$label FT_CMD="$*" timeout "${FT_TIMEOUT:-130}" \
  dbus-run-session --config-file="$HERE/dbus-session.conf" -- "$HERE/session.sh" \
  > "$FT_OUT/$label.session.log" 2>&1

status=0
after=$(sum "$real_cfg")
if [ "$before" = "$after" ]; then
  echo "[guard] ~/.config/kwinoutputconfig.json unchanged ($after)"
else
  echo "[guard] FAIL: ~/.config/kwinoutputconfig.json CHANGED $before -> $after"
  status=1
fi
cat "$FT_OUT/$label.mode" 2>/dev/null
if ! grep -q '^\[mode\] ok' "$FT_OUT/$label.mode" 2>/dev/null; then status=1; fi
if [ -f "$FT_OUT/$label.gpu" ]; then
  tail -1 "$FT_OUT/$label.gpu"
  grep -q 'verdict: PASS' "$FT_OUT/$label.gpu" || status=1
else
  echo "[gpu] FAIL: no GPU check ran (the client exited before ${FT_PROBE_AT:-9} s?)"
  status=1
fi
exit $status
