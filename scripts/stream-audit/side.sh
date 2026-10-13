#!/usr/bin/env bash
# side.sh start <role> <dir> <W> <H> <mHz> <graph> <app>   |   side.sh stop <dir>
#
# Start one side of a stream audit (session.sh under a private, activation-free
# D-Bus) in the background, with its CPU sampler; or stop it and everything it
# started. The real ~/.config/kwinoutputconfig.json is checked unchanged on stop.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
FT=$HERE/../frame-timing
tree() { local p; for p in $(pgrep -P "$1"); do tree "$p"; done; echo "$1"; }
cmd=$1
case $cmd in
start)
  role=$2 dir=$3
  mkdir -p "$dir"
  rm -f "$dir"/{app,session,kwin,portal,cpuprobe}.pid
  # The audit's instance (and the page origin a devUrl build also asks about)
  # are approved ahead, as if the person had confirmed the app's "Trust new
  # Paracord instance?" dialog, which a nested session cannot click.
  # SA_TRUST_ORIGINS is a space-separated list of origins.
  if [ -n "${SA_TRUST_ORIGINS:-}" ]; then
    sec=$dir/$role.home/data/com.paracord.desktop/security
    mkdir -p "$sec"; chmod 700 "$sec"
    python3 -c 'import json,sys; print(json.dumps(sorted(sys.argv[1:]), indent=2))' $SA_TRUST_ORIGINS > "$sec/approved_origins.json"
    chmod 600 "$sec/approved_origins.json"
  fi
  export SA_WORK=${SA_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/paracord-frame-timing}
  mkdir -p "$SA_WORK"
  if [ ! -x "$SA_WORK/kwin_wayland" ] || [ /usr/bin/kwin_wayland -nt "$SA_WORK/kwin_wayland" ]; then
    cp /usr/bin/kwin_wayland "$SA_WORK/kwin_wayland" || exit 1
  fi
  if [ ! -f "$SA_WORK/libdevorder.so" ] || [ "$FT/devorder.c" -nt "$SA_WORK/libdevorder.so" ]; then
    gcc -shared -fPIC -O2 -o "$SA_WORK/libdevorder.so" "$FT/devorder.c" $(pkg-config --cflags --libs libdrm) -ldl || exit 1
  fi
  sum=$(md5sum "$HOME/.config/kwinoutputconfig.json" 2>/dev/null | cut -d' ' -f1)
  echo "$sum" > "$dir/kwinoutputconfig.md5"
  SA_ROLE=$role SA_DIR=$dir SA_W=$4 SA_H=$5 SA_HZ=$6 SA_GRAPH=$7 SA_APP=$8 \
    SA_PROBE=${SA_PROBE:?} SA_ENV=${SA_ENV:-} \
    nohup dbus-run-session --config-file="$FT/dbus-session.conf" -- "$HERE/session.sh" > "$dir/session.log" 2>&1 &
  echo $! > "$dir/session.pid"
  for _ in $(seq 1 100); do [ -s "$dir/app.pid" ] && break; sleep 0.1; done
  [ -s "$dir/app.pid" ] || { echo "side.sh: $role app did not start (see $dir/session.log)" >&2; exit 1; }
  nohup python3 "$HERE/cpuprobe.py" "$(cat "$dir/app.pid")" "$dir/cpu.log" > /dev/null 2>&1 &
  echo $! > "$dir/cpuprobe.pid"
  echo "$role started: app pid $(cat "$dir/app.pid")"
  ;;
stop)
  dir=$2
  if [ -s "$dir/app.pid" ]; then
    app=$(cat "$dir/app.pid")
    # shellcheck disable=SC2046
    kill $(tree "$app") 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$app" 2>/dev/null || break; sleep 0.2; done
  fi
  for f in cpuprobe session; do
    # shellcheck disable=SC2046
    [ -s "$dir/$f.pid" ] && kill $(tree "$(cat "$dir/$f.pid")") 2>/dev/null
  done
  [ -s "$dir/kwin.pid" ] && kill "$(cat "$dir/kwin.pid")" 2>/dev/null
  [ -s "$dir/portal.pid" ] && kill "$(cat "$dir/portal.pid")" 2>/dev/null
  sleep 0.5
  after=$(md5sum "$HOME/.config/kwinoutputconfig.json" 2>/dev/null | cut -d' ' -f1)
  if [ "$after" = "$(cat "$dir/kwinoutputconfig.md5" 2>/dev/null)" ]; then
    echo "[guard] ~/.config/kwinoutputconfig.json unchanged ($after)"
  else
    echo "[guard] FAIL: ~/.config/kwinoutputconfig.json CHANGED"
  fi
  ;;
esac
