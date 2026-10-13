#!/usr/bin/env bash
# graph.sh start|stop <name> <dir>: a private PipeWire graph (socket <name> in
# $XDG_RUNTIME_DIR), its pulse server ($XDG_RUNTIME_DIR/<name>.pulse, a short
# path because unix socket paths are limited to 108 bytes) and a policy-only
# WirePlumber, each in a bubblewrap view with no /dev/snd and the user's
# PipeWire and Pulse sockets covered. Pids go to <dir>/*.pid.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
cmd=$1 name=$2 dir=$3
pulse=$XDG_RUNTIME_DIR/$name.pulse
BW="bwrap --dev-bind / / --tmpfs /dev/snd --bind /dev/null $XDG_RUNTIME_DIR/pipewire-0 --bind /dev/null $XDG_RUNTIME_DIR/pipewire-0-manager --tmpfs $XDG_RUNTIME_DIR/pulse --"
tree() { local p; for p in $(pgrep -P "$1"); do tree "$p"; done; echo "$1"; }
case $cmd in
start)
  mkdir -p "$dir/config/wireplumber/wireplumber.conf.d" "$dir/state" "$dir/data"
  sed "s#@NAME@#$name#g" "$HERE/pipewire.conf.in" > "$dir/pipewire.conf"
  sed "s#@NAME@#$name#g; s#@PULSE@#$pulse#g" "$HERE/pipewire-pulse.conf.in" > "$dir/pipewire-pulse.conf"
  cp "$HERE/wireplumber.conf.in" "$dir/config/wireplumber/wireplumber.conf.d/stream-audit.conf"
  export XDG_CONFIG_HOME=$dir/config XDG_STATE_HOME=$dir/state XDG_DATA_HOME=$dir/data
  [ -S "$XDG_RUNTIME_DIR/$name" ] && { echo "graph.sh: $XDG_RUNTIME_DIR/$name already exists" >&2; exit 1; }
  nohup $BW pipewire -c "$dir/pipewire.conf" > "$dir/pipewire.log" 2>&1 &
  echo $! > "$dir/pipewire.pid"
  for _ in $(seq 1 50); do [ -S "$XDG_RUNTIME_DIR/$name" ] && break; sleep 0.1; done
  [ -S "$XDG_RUNTIME_DIR/$name" ] || { echo "graph.sh: pipewire $name did not start" >&2; exit 1; }
  PIPEWIRE_REMOTE=$name nohup $BW pipewire -c "$dir/pipewire-pulse.conf" > "$dir/pulse.log" 2>&1 &
  echo $! > "$dir/pulse.pid"
  PIPEWIRE_REMOTE=$name nohup dbus-run-session --config-file="$HERE/../../frame-timing/dbus-session.conf" -- \
    $BW wireplumber -p stream-audit > "$dir/wireplumber.log" 2>&1 &
  echo $! > "$dir/wireplumber.pid"
  for _ in $(seq 1 50); do [ -S "$pulse" ] && break; sleep 0.1; done
  sleep 1
  PULSE_SERVER=unix:$pulse pactl set-default-sink glass_g23_out
  PULSE_SERVER=unix:$pulse pactl info | grep -E "Server String|Default Sink"
  ;;
stop)
  for f in wireplumber pulse pipewire; do
    [ -f "$dir/$f.pid" ] || continue
    # shellcheck disable=SC2046
    kill $(tree "$(cat "$dir/$f.pid")") 2>/dev/null
  done
  sleep 0.5
  pkill -f "pipewire -c $dir/" 2>/dev/null
  rm -f "$XDG_RUNTIME_DIR/$name" "$XDG_RUNTIME_DIR/$name.lock" "$XDG_RUNTIME_DIR/$name-manager" \
    "$XDG_RUNTIME_DIR/$name-manager.lock" "$pulse"
  ;;
esac
