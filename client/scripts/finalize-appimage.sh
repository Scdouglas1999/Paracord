#!/usr/bin/env bash
# Finish a freshly built Paracord AppImage: take the Wayland client libraries
# out so it uses the host's copies, and make its own desktop entry and icon the
# app's (com.paracord.desktop).
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
# The identity: the window's app id is com.paracord.desktop (app_identity.rs),
# and a taskbar finds the icon through the desktop entry of that name. The
# Tauri bundler always names the AppImage's root entry after the product
# (Paracord.desktop, here rendered from linux/bundler-alias.desktop and hidden),
# so this script puts com.paracord.desktop.desktop (installed into the AppDir by
# tauri.conf.json bundle.linux.appimage.files) at the root instead, with its
# icon as the root icon and .DirIcon: what AppImage integrators copy.
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
for lib in "${bundled[@]}"; do
  echo "finalize-appimage: removing ${lib#"$appdir"/}"
  rm -f "$lib"
done
mapfile -t left < <(wayland_libs "$appdir")
[ "${#left[@]}" -eq 0 ] || die "Wayland libraries still present after removal: ${left[*]}"

app_id=com.paracord.desktop
entry="usr/share/applications/$app_id.desktop"
icon="usr/share/icons/hicolor/512x512/apps/$app_id.png"
[ -f "$appdir/$entry" ] || die "the AppImage has no $entry (tauri.conf.json bundle.linux.appimage.files)"
[ -f "$appdir/$icon" ] || die "the AppImage has no $icon (tauri.conf.json bundle.linux.appimage.files)"
grep -qx "Icon=$app_id" "$appdir/$entry" || die "$entry does not name Icon=$app_id"
grep -qx "StartupWMClass=$app_id" "$appdir/$entry" || die "$entry does not name StartupWMClass=$app_id"
# The root entry and icon the bundler made (Paracord.desktop, Paracord.png and
# whatever linuxdeploy copied beside them) give way to the app's own.
find "$appdir" -maxdepth 1 \( -name '*.desktop' -o -name '*.png' -o -name '*.svg' -o -name '.DirIcon' \) -exec rm -f {} +
ln -s "$entry" "$appdir/$app_id.desktop"
cp "$appdir/$icon" "$appdir/$app_id.png"
ln -s "$app_id.png" "$appdir/.DirIcon"
echo "finalize-appimage: root entry and icon are now $app_id"

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
(cd "$check" && "$out" --appimage-extract >/dev/null) || die "could not read back the repacked AppImage"
mapfile -t repacked < <(wayland_libs "$check")
[ "${#repacked[@]}" -eq 0 ] || die "repacked AppImage still bundles: ${repacked[*]}"
mapfile -t roots < <(find "$check/squashfs-root" -maxdepth 1 -name '*.desktop' -printf '%f\n')
[ "${roots[*]}" = "$app_id.desktop" ] || die "repacked AppImage's root entry is '${roots[*]}', not $app_id.desktop"
[ -s "$check/squashfs-root/.DirIcon" ] || die "repacked AppImage has no .DirIcon"

mv -f "$out" "$appimage"
echo "finalize-appimage: repacked $(basename "$appimage"): host Wayland libraries, $app_id entry and icon"

if [ -e "$sig" ]; then
  rm -f "$sig"
  (cd "$client_dir" && npx --no-install tauri signer sign "$appimage") || die "re-signing $appimage failed"
  [ -s "$sig" ] || die "re-signing did not write $sig"
  echo "finalize-appimage: re-signed $(basename "$appimage")"
fi
