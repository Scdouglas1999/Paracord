#!/usr/bin/env bash
# env.sh up <run dir> | env.sh down <run dir>
#
# The stream-audit environment, all of it private to <run dir>:
#   - a throwaway instance (scripts/live-env.mjs, :$SA_SERVER_PORT, default 18760,
#     auto port forwarding off, loopback bind);
#   - audit-serve.mjs on :1477 serving $SA_DIST (a `vite build` of client/)
#     with the in-page agent;
#   - two private PipeWire graphs (sa-pwA for the sender, sa-pwB for the
#     viewer), null nodes only;
#   - the synthetic screen (pattern.py, $SA_SRC_W x $SA_SRC_H at 60 fps, with
#     tone bursts) in graph A;
#   - the sender (1600x900 at 60 Hz) and the viewer ($SA_VIEW_W x $SA_VIEW_H,
#     default 5120x1412, at 239.9 Hz) as desktop test builds in nested KWin
#     sessions on the NVIDIA GPU (side.sh), the probe preloaded;
#   - the accounts, the room, the room chat (seed.mjs, seed-chat.mjs), both apps
#     signed in through their own pages (drive/setup.mjs);
#   - the viewer's output recorder (audiorec.py).
# Then: node drive/campaign.mjs --out <run dir> [--plan ...] and analyze.py.
#
# Needs $SA_APP: a paracord-desktop built by build.sh (devUrl :1477), and
# $SA_SERVER_BIN: a release paracord-server.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cmd=$1 OUT=$(realpath -m "$2")
PORT=${SA_SERVER_PORT:-18760}
case $cmd in
up)
  mkdir -p "$OUT"
  [ -x "${SA_APP:-}" ] && [ -x "${SA_SERVER_BIN:-}" ] && [ -d "${SA_DIST:-}" ] || { echo "set SA_APP, SA_SERVER_BIN and SA_DIST"; exit 2; }
  gcc -shared -fPIC -O2 -o "$OUT/libsaprobe.so" "$HERE/probe.c" -ldl -lpthread $(pkg-config --cflags libpipewire-0.3 libavcodec) || exit 1
  PARACORD_LIVE_ENV_BIN=$SA_SERVER_BIN PARACORD_AUTO_PORT_FORWARD=false \
    PARACORD_CORS_ALLOWED_ORIGINS=http://localhost:1477,http://127.0.0.1:1477 \
    RUST_LOG=${SA_SERVER_RUST_LOG:-warn,paracord_api=info,paracord_relay=info} \
    nohup node "$ROOT/scripts/live-env.mjs" --port "$PORT" --data "$OUT/live-env" > "$OUT/live-env.out" 2>&1 &
  echo $! > "$OUT/live-env.pid"
  nohup node "$HERE/drive/audit-serve.mjs" "$SA_DIST" 1477 "$OUT/cmds" > "$OUT/serve.log" 2>&1 &
  echo $! > "$OUT/serve.pid"
  for _ in $(seq 1 60); do grep -q "live-env ready" "$OUT/live-env.out" && break; sleep 0.5; done
  "$HERE/graph/graph.sh" start sa-pwA "$OUT/graphA" || exit 1
  "$HERE/graph/graph.sh" start sa-pwB "$OUT/graphB" || exit 1
  PIPEWIRE_REMOTE=sa-pwA PULSE_SERVER=unix:$XDG_RUNTIME_DIR/sa-pwA.pulse \
    nohup python3 "$HERE/pattern.py" --w "${SA_SRC_W:-5120}" --h "${SA_SRC_H:-1440}" --fps 60 --log "$OUT/src.log" --audio \
    > "$OUT/pattern.out" 2>&1 &
  echo $! > "$OUT/pattern.pid"
  node "$HERE/drive/seed.mjs" "http://127.0.0.1:$PORT" "$OUT/scene.json" > /dev/null || exit 1
  node "$HERE/drive/seed-chat.mjs" "$OUT/scene.json" 160 || exit 1
  export SA_PROBE=$OUT/libsaprobe.so SA_TRUST_ORIGINS="http://127.0.0.1:$PORT http://localhost:1477"
  "$HERE/side.sh" start sender "$OUT/sender" 1600 900 60000 sa-pwA "$SA_APP" || exit 1
  "$HERE/side.sh" start viewer "$OUT/viewer" "${SA_VIEW_W:-5120}" "${SA_VIEW_H:-1412}" 240000 sa-pwB "$SA_APP" || exit 1
  for _ in $(seq 1 60); do curl -s http://127.0.0.1:1477/__drive/status | grep -q '"viewer"' && \
    curl -s http://127.0.0.1:1477/__drive/status | grep -q '"sender"' && break; sleep 1; done
  node "$HERE/drive/setup.mjs" --out "$OUT" || exit 1
  PIPEWIRE_REMOTE=sa-pwB nohup python3 "$HERE/audiorec.py" glass_g23_out "$OUT/viewer/audio.log" > /dev/null 2>&1 &
  echo $! > "$OUT/viewer/audiorec.pid"
  echo "stream-audit environment up in $OUT"
  ;;
down)
  "$HERE/side.sh" stop "$OUT/viewer"
  "$HERE/side.sh" stop "$OUT/sender"
  for f in viewer/audiorec sender/audiorec pattern serve live-env; do
    [ -s "$OUT/$f.pid" ] && kill "$(cat "$OUT/$f.pid")" 2>/dev/null
  done
  sleep 1
  # live-env.mjs forwards SIGTERM to the server, but a server it left behind is stopped by its data path.
  for p in $(pgrep -f -- "-c $OUT/live-env/paracord.toml"); do kill "$p" 2>/dev/null; done
  "$HERE/graph/graph.sh" stop sa-pwA "$OUT/graphA"
  "$HERE/graph/graph.sh" stop sa-pwB "$OUT/graphB"
  sleep 1
  ps -eo pid,args | grep -F "$OUT" | grep -v -e grep -e "env.sh down" && echo "env.sh: something above still runs from $OUT"
  echo "stream-audit environment down (data stays in $OUT until you delete it)"
  ;;
esac
