#!/usr/bin/env bash
# Build what the fresh-machine gate installs on its "computers": the release
# desktop app with the real paracord-host sidecar beside it, plus tauri-driver.
#
#   scripts/fresh-machine/build.sh <out-dir> [<source-dir>]
#
# <source-dir> defaults to this checkout. Building from a snapshot
# (`git archive HEAD | tar -x -C <dir>`, with client/node_modules linked in)
# keeps a concurrent agent's working tree out of the binaries and keeps this
# build out of theirs (client/dist, client/src-tauri/binaries).
#
# Honors CARGO_TARGET_DIR. Never disables the vpx feature.
set -euo pipefail
out=${1:?usage: build.sh <out-dir> [<source-dir>]}
src=${2:-$(cd "$(dirname "$0")/../.." && pwd)}
target=${CARGO_TARGET_DIR:-$src/target}
mkdir -p "$out"

free_gb=$(df -BG --output=avail "$target" 2>/dev/null | tail -1 | tr -dc 0-9 || echo 999)
if (( free_gb < 40 )); then
  echo "build.sh: only ${free_gb} GB free under $target; stopping (needs 40)." >&2
  exit 1
fi

cd "$src/client"
npm run build
npm run host:stage -- --release
npx tauri build --no-bundle

cp "$target/release/paracord-desktop" "$out/paracord-desktop"
# Tauri copies the staged sidecar next to the app, which is where the app
# looks for it (current_exe().parent()/paracord-host).
cp "$target/release/paracord-host" "$out/paracord-host"

if ! [[ -x "$out/tauri-driver" ]]; then
  tmp=$(mktemp -d)
  CARGO_TARGET_DIR="$tmp/target" cargo install tauri-driver --locked --root "$tmp/root"
  cp "$tmp/root/bin/tauri-driver" "$out/tauri-driver"
  rm -rf "$tmp"
fi

"$out/paracord-host" --version
ls -la "$out"
