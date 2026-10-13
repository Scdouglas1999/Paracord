#!/usr/bin/env bash
# build.sh <out dir>: what the stream audit runs: a desktop test build (release,
# vpx on, no embedded UI, devUrl http://localhost:1477), a release
# paracord-server, and a production client build for audit-serve.mjs.
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$(realpath -m "$1")
mkdir -p "$OUT"
cd "$ROOT"
TAURI_CONFIG='{"build":{"devUrl":"http://localhost:1477"}}' \
  cargo build --release -p paracord-desktop --no-default-features --features vpx
cp "${CARGO_TARGET_DIR:-$ROOT/target}/release/paracord-desktop" "$OUT/paracord-desktop-audit"
cargo build --release --bin paracord-server
cp "${CARGO_TARGET_DIR:-$ROOT/target}/release/paracord-server" "$OUT/paracord-server"
(cd client && npx vite build --outDir "$OUT/dist" --emptyOutDir)
echo "SA_APP=$OUT/paracord-desktop-audit SA_SERVER_BIN=$OUT/paracord-server SA_DIST=$OUT/dist"
