#!/usr/bin/env bash
# setsize.sh <side dir> <W> <H> [mHz]: switch a side's nested KWin output to
# W x H at mHz (default 240000), keep the app maximized, and print the mode.
# Only the nested session's own config directory is touched.
set -u
dir=$1 W=$2 H=$3 HZ=${4:-240000}
export DBUS_SESSION_BUS_ADDRESS=$(cat "$dir/bus.addr") WAYLAND_DISPLAY=$(cat "$dir/wayland.sock")
unset DISPLAY
kd() { XDG_CONFIG_HOME=$dir/kwin-config kscreen-doctor "$@" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g'; }
kd "output.Virtual-0.addCustomMode.$W.$H.$HZ.full" > /dev/null; sleep 0.5
id=$(kd -o | grep -o "[0-9]*:${W}x${H}@[0-9.]*" | awk -F'[:@]' -v hz="$HZ" \
  '{ d = $3 * 1000 - hz; if (d < 0) d = -d; if (d < 1000) print $1 }' | tail -1)
[ -n "$id" ] && kd "output.Virtual-0.mode.$id" > /dev/null; sleep 1
echo 'for (const w of workspace.windowList()) { if (w.normalWindow) { w.setMaximize(false, false); w.setMaximize(true, true); } }' > "$dir/max.js"
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript sa-max > /dev/null 2>&1
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "$dir/max.js" sa-max > /dev/null
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start > /dev/null
sleep 1
kd -o | grep -E 'Modes' | grep -o '[0-9]*:[0-9x]*@[0-9.]*\*' | tee "$dir/mode.txt"
