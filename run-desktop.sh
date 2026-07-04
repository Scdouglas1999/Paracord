#!/usr/bin/env bash
# Launch the Paracord desktop app with WebKitGTK/GDK workarounds for KDE/KWin
# Wayland sessions, where the default Wayland + DMA-BUF/GBM render path crashes
# ("Gdk-Message: Error 71 (Protocol error)") or shows a blank blue window.
#
# Confirmed working combo on this machine (KWin Wayland):
#   - GDK_BACKEND=x11                  -> route GTK via XWayland (no Error 71)
#   - WEBKIT_DISABLE_COMPOSITING_MODE  -> paint DOM instead of blank base layer
#   - WEBKIT_DISABLE_DMABUF_RENDERER   -> avoid "Failed to create GBM buffer"
# Hardware GL is left enabled (no LIBGL_ALWAYS_SOFTWARE) so native video/voice
# stay performant.
set -euo pipefail
cd "$(dirname "$0")"
export GDK_BACKEND=x11
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
exec ./target/release/paracord-desktop "$@"
