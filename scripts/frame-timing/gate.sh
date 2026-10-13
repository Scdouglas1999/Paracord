#!/usr/bin/env bash
# gate.sh [--require-display-link] [--runs N] <paracord-desktop test binary>
#
# The frame-timing gate: N runs (default 2) of the test page in the desktop app
# in a nested KWin on the NVIDIA GPU, then analyze.py's verdict. The binary must
# be a build whose devUrl is http://localhost:$FT_PORT (build-app.sh makes one).
#
#   FT_PORT  the page server's port (default 1437)
#   FT_HZ    the virtual output's refresh in mHz (default 240000)
#   FT_ENV   extra client environment, e.g. FT_ENV=WEBKIT_DISABLE_COMPOSITING_MODE=1
#   FT_OUT   output directory (default /tmp/paracord-frame-timing)
#   FT_NAME  run-name prefix (default gate)
#
# --require-display-link also gates raf-anim, scroll and scroll-glass (see the
# README: only once the system WebKitGTK's display link follows the display).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
flags=(); runs=2
while [ $# -gt 1 ]; do
  case $1 in
    --require-display-link) flags+=(--require-display-link); shift ;;
    --runs) runs=$2; shift 2 ;;
    *) break ;;
  esac
done
[ $# -eq 1 ] && [ -x "$1" ] || { sed -n '2,15p' "$0"; exit 2; }
app=$(realpath "$1")
export FT_OUT=${FT_OUT:-/tmp/paracord-frame-timing}
export FT_HZ=${FT_HZ:-240000}
port=${FT_PORT:-1437}
mkdir -p "$FT_OUT"

if ss -ltn "sport = :$port" | grep -q LISTEN; then
  echo "port $port is taken; set FT_PORT and build the app for it (build-app.sh)"; exit 2
fi
hz=$(awk -v m="$FT_HZ" 'BEGIN { printf "%.2f", m / 1000 }')
python3 "$HERE/serve.py" "$port" "hz=$hz&wait=7000&stay=1" &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 0.5

stamp=${FT_NAME:-gate}-$(date +%Y%m%d-%H%M%S)
logs=(); status=0
nvidia="__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json __GLX_VENDOR_LIBRARY_NAME=nvidia"
for i in $(seq 1 "$runs"); do
  label=$stamp-r$i
  echo "== run $i/$runs: $label"
  FT_MAXIMIZE=1 FT_ENV="$nvidia PARACORD_FRAME_TRACE=1 ${FT_ENV:-}" \
    "$HERE/run.sh" "$label" timeout 85 "$app" || status=1
  logs+=("$FT_OUT/$label.log")
done
python3 "$HERE/analyze.py" "${flags[@]}" --json "$FT_OUT/$stamp.json" "${logs[@]}" || status=1
echo "results: $FT_OUT/$stamp.json"
[ $status = 0 ] && echo "FRAME-TIMING GATE: PASS" || echo "FRAME-TIMING GATE: FAIL"
exit $status
