#!/usr/bin/env bash
# shot.sh <side dir> <out.png>: a screenshot of a side's nested KWin (spectacle
# inside that session; it never sees the real display).
set -u
dir=$1 out=$2
export DBUS_SESSION_BUS_ADDRESS=$(cat "$dir/bus.addr") WAYLAND_DISPLAY=$(cat "$dir/wayland.sock")
unset DISPLAY
mkdir -p "$dir/spectacle"
XDG_CONFIG_HOME=$dir/spectacle timeout 20 spectacle -b -n -f -o "$out" > /dev/null 2>&1
ls -la "$out"
