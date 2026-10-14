#!/usr/bin/env bash
# Mixed-version lab (stream-fix V7): lab.sh up <run> <server old|new> <sender old|new> <viewer old|new> | down <run>
# Built on scripts/stream-audit (env.sh), with one audit-serve per client build:
# :1493 the new dist (new desktop's devUrl), :1492 the old dist (old desktop's devUrl).
set -u
M=$(cd "$(dirname "$0")" && pwd)
H=$(cd "$M/.." && pwd)
R=$(cd "$H/../.." && pwd)
# SA_NEW: a build.sh output dir with SA_UI_PORT=1493 (paracord-desktop-audit,
# paracord-server, dist). SA_OLD: the older build: paracord-desktop-old (devUrl
# :1492), paracord-server-old, dist-old.
NEW=${SA_NEW:-} OLD=${SA_OLD:-}
PORT=18830 GA=v7-pwA GB=v7-pwB
cmd=$1 OUT=$(realpath -m "$2")
app() { [ "$1" = old ] && echo "$OLD/paracord-desktop-old" || echo "$NEW/paracord-desktop-audit"; }
uiport() { [ "$1" = old ] && echo 1492 || echo 1493; }
case $cmd in
up)
  srv=$3 snd=$4 vwr=$5
  [ -d "$NEW" ] && [ -d "$OLD" ] || { echo "set SA_NEW and SA_OLD"; exit 2; }
  mkdir -p "$OUT"
  # Ten seconds of speech, looped for ten minutes: what micfeed.sh plays into a microphone.
  espeak-ng -s 150 -a 200 -w "$OUT/speech1.wav" "The quick brown fox jumps over the lazy dog. Paracord voice check, one two three four five. We are testing the first seconds of a call, to hear whether every word arrives. Six seven eight nine ten." || exit 1
  ffmpeg -loglevel error -y -i "$OUT/speech1.wav" -t 10 -ar 48000 -ac 2 "$OUT/speech.wav" || exit 1
  for _ in $(seq 1 60); do echo "file '$OUT/speech.wav'"; done > "$OUT/speech.txt"
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$OUT/speech.txt" -c copy "$OUT/speech-long.wav" || exit 1
  echo "server=$srv sender=$snd viewer=$vwr" > "$OUT/versions.txt"
  echo "{\"sender\": $(uiport $snd), \"viewer\": $(uiport $vwr)}" > "$OUT/ports.json"
  SBIN=$NEW/paracord-server; [ "$srv" = old ] && SBIN=$OLD/paracord-server-old
  gcc -shared -fPIC -O2 -o "$OUT/libsaprobe.so" "$H/probe.c" -ldl -lpthread $(pkg-config --cflags libpipewire-0.3 libavcodec) || exit 1
  PARACORD_LIVE_ENV_BIN=$SBIN PARACORD_AUTO_PORT_FORWARD=false \
    PARACORD_CORS_ALLOWED_ORIGINS=http://localhost:1492,http://127.0.0.1:1492,http://localhost:1493,http://127.0.0.1:1493 \
    RUST_LOG=${SA_SERVER_RUST_LOG:-warn,paracord_api=info,paracord_relay=info} \
    nohup node "$R/scripts/live-env.mjs" --port "$PORT" --data "$OUT/live-env" > "$OUT/live-env.out" 2>&1 &
  echo $! > "$OUT/live-env.pid"
  nohup node "$H/drive/audit-serve.mjs" "$NEW/dist" 1493 "$OUT/cmds-new" > "$OUT/serve-new.log" 2>&1 &
  echo $! > "$OUT/serve-new.pid"
  nohup node "$H/drive/audit-serve.mjs" "$OLD/dist-old" 1492 "$OUT/cmds-old" > "$OUT/serve-old.log" 2>&1 &
  echo $! > "$OUT/serve-old.pid"
  for _ in $(seq 1 60); do grep -q "live-env ready" "$OUT/live-env.out" && break; sleep 0.5; done
  grep -q "live-env ready" "$OUT/live-env.out" || { echo "server did not come up"; tail "$OUT/live-env.out"; exit 1; }
  "$H/graph/graph.sh" start $GA "$OUT/graphA" || exit 1
  "$H/graph/graph.sh" start $GB "$OUT/graphB" || exit 1
  PIPEWIRE_REMOTE=$GA PULSE_SERVER=unix:$XDG_RUNTIME_DIR/$GA.pulse \
    nohup python3 "$H/pattern.py" --w "${SA_SRC_W:-5120}" --h "${SA_SRC_H:-1440}" --fps 60 --log "$OUT/src.log" --prerender 48 \
    > "$OUT/pattern.out" 2>&1 &
  echo $! > "$OUT/pattern.pid"
  if [ "$srv" = old ]; then node "$M/seed-legacy.mjs" "http://127.0.0.1:$PORT" "$OUT/scene.json" > /dev/null || exit 1
  else node "$H/drive/seed.mjs" "http://127.0.0.1:$PORT" "$OUT/scene.json" > /dev/null || exit 1; fi
  [ "$srv" = old ] || node "$H/drive/seed-chat.mjs" "$OUT/scene.json" 40 || exit 1
  export SA_PROBE=$OUT/libsaprobe.so SA_TRUST_ORIGINS="http://127.0.0.1:$PORT http://localhost:1492 http://localhost:1493"
  "$H/side.sh" start sender "$OUT/sender" 1600 900 60000 $GA "$(app $snd)" || exit 1
  "$H/side.sh" start viewer "$OUT/viewer" "${SA_VIEW_W:-5120}" "${SA_VIEW_H:-1412}" 60000 $GB "$(app $vwr)" || exit 1
  for _ in $(seq 1 60); do
    curl -s http://127.0.0.1:$(uiport $snd)/__drive/status | grep -q '"sender"' && \
    curl -s http://127.0.0.1:$(uiport $vwr)/__drive/status | grep -q '"viewer"' && break; sleep 1; done
  PIPEWIRE_REMOTE=$GB nohup python3 "$H/audiorec.py" glass_g23_out "$OUT/viewer/audio.log" > /dev/null 2>&1 &
  echo $! > "$OUT/viewer/audiorec.pid"
  PIPEWIRE_REMOTE=$GA nohup python3 "$H/audiorec.py" glass_g23_out "$OUT/sender/audio.log" > /dev/null 2>&1 &
  echo $! > "$OUT/sender/audiorec.pid"
  RUN=$OUT node "$M/setup.mjs" || exit 1
  PIPEWIRE_REMOTE=$GB nohup python3 "$M/lvlrec.py" glass_g23_out "$OUT/viewer/lvl.log" > /dev/null 2>&1 &
  echo $! > "$OUT/viewer/lvlrec.pid"
  PIPEWIRE_REMOTE=$GA nohup python3 "$M/lvlrec.py" glass_g23_out "$OUT/sender/lvl.log" > /dev/null 2>&1 &
  echo $! > "$OUT/sender/lvlrec.pid"
  RUN=$OUT nohup node "$M/stats.mjs" > "$OUT/stats.out" 2>&1 &
  echo $! > "$OUT/stats.pid"
  echo "lab up in $OUT ($(cat "$OUT/versions.txt"))"
  ;;
down)
  "$H/side.sh" stop "$OUT/viewer"
  "$H/side.sh" stop "$OUT/sender"
  for f in stats viewer/lvlrec sender/lvlrec viewer/audiorec sender/audiorec pattern serve-new serve-old live-env; do
    [ -s "$OUT/$f.pid" ] && kill "$(cat "$OUT/$f.pid")" 2>/dev/null
  done
  sleep 1
  for p in $(pgrep -f -- "-c $OUT/live-env/paracord.toml"); do kill "$p" 2>/dev/null; done
  for p in $(pgrep -f "paracord-server(-old)? -c $OUT/live-env"); do kill "$p" 2>/dev/null; done; sleep 0.5
  "$H/graph/graph.sh" stop $GA "$OUT/graphA"
  "$H/graph/graph.sh" stop $GB "$OUT/graphB"
  sleep 1
  ps -eo pid,args | grep -F "$OUT" | grep -v -e grep -e "lab.sh down" && echo "lab.sh: something above still runs from $OUT"
  echo "lab down"
  ;;
esac
