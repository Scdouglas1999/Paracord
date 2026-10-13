#!/usr/bin/env bash
# build-app.sh [out]: the desktop app as the gate runs it: release, vpx on, no
# embedded UI (no custom-protocol), devUrl http://localhost:$FT_PORT, so the
# window opens the gate's test page. Not a shippable build.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
port=${FT_PORT:-1437}
out=${1:-${FT_OUT:-/tmp/paracord-frame-timing}/paracord-desktop-frame-timing}
mkdir -p "$(dirname "$out")"
cd "$ROOT"
TAURI_CONFIG="{\"build\":{\"devUrl\":\"http://localhost:$port\"}}" \
  cargo build --release -p paracord-desktop --no-default-features --features vpx
cp "${CARGO_TARGET_DIR:-$ROOT/target}/release/paracord-desktop" "$out"
echo "$out"
