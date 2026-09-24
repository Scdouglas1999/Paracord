#!/usr/bin/env bash
# Take the Wayland client libraries out of a freshly built Paracord AppImage so
# the AppImage uses the host's copies.
#
# Usage (from client/, after `npx tauri build --bundles appimage`):
#   scripts/finalize-appimage.sh ../target/release/bundle/appimage/Paracord_<version>_amd64.AppImage
#
# Why: linuxdeploy bundles libwayland-{client,cursor,egl,server} from the build
# machine, and the AppImage's LD_LIBRARY_PATH puts them ahead of the host's.
# The GPU driver is never bundled (linuxdeploy excludes libEGL/libGL/libgbm/
# libdrm), so the host's Mesa gets loaded against the bundled libwayland. A
# Mesa built against a newer libwayland than the build machine's (Mesa 26 on
# libwayland 1.24+, against Ubuntu 24.04's 1.22) needs symbols the bundled copy
# lacks, `wl_fixes_interface` among them, so libEGL_mesa fails to load, EGL has
# no driver, and WebKitWebProcess aborts with "Could not create default EGL
# display: EGL_BAD_PARAMETER" before the window appears. libwayland keeps its
# ABI backward compatible, so the host's copy (always present where Mesa is)
# serves the bundled GTK and WebKit as well.
#
# The script repacks the AppImage with the same linuxdeploy AppImage plugin the
# Tauri bundler used, and re-signs it when an updater signature (.sig) sits next
# to it; that needs TAURI_SIGNING_PRIVATE_KEY (and _PASSWORD) as for
# `tauri build`. Every failure stops the script with a non-zero exit.
set -euo pipefail

die() {
  echo "finalize-appimage: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 <path/to/Paracord.AppImage>"
appimage="$(realpath -e "$1")" || die "no such file: $1"
case "$appimage" in
  *.AppImage) ;;
  *) die "not an .AppImage: $appimage" ;;
esac

sig="$appimage.sig"
if [ -e "$sig" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  die "$sig would no longer match once the AppImage is repacked; set TAURI_SIGNING_PRIVATE_KEY (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD) so it can be re-signed"
fi

client_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plugin="${XDG_CACHE_HOME:-$HOME/.cache}/tauri/linuxdeploy-plugin-appimage.AppImage"
[ -x "$plugin" ] || die "missing $plugin (the Tauri bundler downloads it during 'tauri build --bundles appimage'; run that first)"

work="$(mktemp -d "$(dirname "$appimage")/.finalize-appimage.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# The type-2 runtime extracts without FUSE, so this also works in CI containers.
(cd "$work" && "$appimage" --appimage-extract >/dev/null) || die "could not extract $appimage"
appdir="$work/squashfs-root"
[ -x "$appdir/AppRun" ] || die "extracted AppImage has no AppRun: $appimage"

wayland_libs() {
  find "$1" \( -type f -o -type l \) -name 'libwayland-*.so*' -print
}

mapfile -t bundled < <(wayland_libs "$appdir")
if [ "${#bundled[@]}" -eq 0 ]; then
  echo "finalize-appimage: no Wayland client libraries bundled in $(basename "$appimage"); nothing to do"
  exit 0
fi

for lib in "${bundled[@]}"; do
  echo "finalize-appimage: removing ${lib#"$appdir"/}"
  rm -f "$lib"
done
mapfile -t left < <(wayland_libs "$appdir")
[ "${#left[@]}" -eq 0 ] || die "Wayland libraries still present after removal: ${left[*]}"

out="$work/out.AppImage"
(
  cd "$work"
  ARCH="${ARCH:-$(uname -m)}" LDAI_OUTPUT="$out" APPIMAGE_EXTRACT_AND_RUN=1 \
    "$plugin" --appdir "$appdir"
) || die "repacking with $plugin failed"
[ -s "$out" ] || die "repacking produced no AppImage"
chmod 755 "$out"

# Check the packed result, not just the directory it was packed from.
check="$work/check"
mkdir "$check"
(cd "$check" && "$out" --appimage-extract 'usr/lib/libwayland-*' >/dev/null) || die "could not read back the repacked AppImage"
mapfile -t repacked < <(wayland_libs "$check")
[ "${#repacked[@]}" -eq 0 ] || die "repacked AppImage still bundles: ${repacked[*]}"

mv -f "$out" "$appimage"
echo "finalize-appimage: repacked $(basename "$appimage") without its Wayland client libraries"

if [ -e "$sig" ]; then
  rm -f "$sig"
  (cd "$client_dir" && npx --no-install tauri signer sign "$appimage") || die "re-signing $appimage failed"
  [ -s "$sig" ] || die "re-signing did not write $sig"
  echo "finalize-appimage: re-signed $(basename "$appimage")"
fi
