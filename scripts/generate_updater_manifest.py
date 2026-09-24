#!/usr/bin/env python3
"""Write the desktop updater manifest (latest.json) for a release.

The release workflow runs this over the downloaded build artifacts; it lives in
a script rather than inline in the workflow so the exact manifest a release
publishes can be produced — and checked — locally from signed test files.

The format is the Tauri v2 updater's "static" manifest
(tauri-plugin-updater's `RemoteRelease`): `version`, `notes`, an RFC 3339
`pub_date`, and `platforms`, a map from target key to `{url, signature}` where
`signature` is the text of the `.sig` file the bundler wrote next to the
artifact.

Which key an installed app asks for: the plugin tries `{os}-{arch}-{installer}`
first, where the installer is the bundle the running binary was packaged as
(msi, nsis, deb, rpm, appimage, app), then plain `{os}-{arch}`. So every
installer the release ships gets its own key, and the plain key is the one a
build of unknown bundle type falls back to:

- windows-x86_64-msi, windows-x86_64   -> the .msi
- linux-x86_64-deb                     -> the .deb
- linux-x86_64-rpm                     -> the .rpm
- linux-x86_64-appimage, linux-x86_64  -> the AppImage (a binary of unknown
  bundle type updates by replacing its own file, so it must be handed an
  executable, never a package)
- darwin-aarch64, darwin-x86_64        -> the .app.tar.gz of that architecture

3.2 desktop apps named their key themselves (windows-x86_64,
linux-x86_64-deb, linux-x86_64-appimage) and are still served by the keys above.

A key is only written when its artifact and signature were actually built:
advertising an update the app cannot fetch is worse than not offering it. With
no signed Windows and Linux artifacts at all (no signing key configured) the
script writes nothing and says so.

Usage:
    python3 scripts/generate_updater_manifest.py --artifacts artifacts \\
        --tag v3.3.0 --repo owner/name --out artifacts/latest.json
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def find_one(root: Path, pattern: str) -> Path | None:
    """The single file under `root` matching `pattern`; several is an error."""
    if not root.is_dir():
        return None
    matches = sorted(path for path in root.rglob(pattern) if path.is_file())
    if len(matches) > 1:
        raise SystemExit(
            f"generate_updater_manifest: more than one {pattern} under {root}: "
            + ", ".join(str(match) for match in matches)
        )
    return matches[0] if matches else None


def read_signature(sig_path: Path) -> str:
    """The `.sig` text, checked to be what the Tauri signer writes."""
    signature = "".join(sig_path.read_text().split())
    try:
        decoded = base64.b64decode(signature, validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise SystemExit(f"generate_updater_manifest: {sig_path} is not a Tauri signature: {error}")
    if not decoded.startswith("untrusted comment:") or "trusted comment:" not in decoded:
        raise SystemExit(f"generate_updater_manifest: {sig_path} is not a minisign signature")
    return signature


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--artifacts", required=True, type=Path, help="the downloaded artifacts directory")
    parser.add_argument("--tag", required=True, help="the release tag, e.g. v3.3.0")
    parser.add_argument("--repo", required=True, help="owner/name on GitHub")
    parser.add_argument("--out", required=True, type=Path, help="where to write latest.json")
    parser.add_argument("--pub-date", help="RFC 3339 publication time (default: now)")
    args = parser.parse_args()

    version = args.tag[1:] if args.tag.startswith("v") else args.tag
    base_url = f"https://github.com/{args.repo}/releases/download/{args.tag}"
    artifacts: Path = args.artifacts

    # (target keys, artifact directory, artifact glob). The directory names are
    # the upload-artifact names in release.yml.
    installers = [
        (["windows-x86_64-msi", "windows-x86_64"], "client-windows-msi", "*.msi"),
        (["linux-x86_64-deb"], "client-linux-deb", "*.deb"),
        (["linux-x86_64-rpm"], "client-linux-rpm", "*.rpm"),
        (["linux-x86_64-appimage", "linux-x86_64"], "client-linux-appimage", "*.AppImage"),
        (["darwin-aarch64"], "client-macos-aarch64", "*.app.tar.gz"),
        (["darwin-x86_64"], "client-macos-x86_64", "*.app.tar.gz"),
    ]
    # Without these the release has no signed desktop build to offer at all.
    required = {"client-windows-msi", "client-linux-deb", "client-linux-appimage"}

    platforms: dict[str, dict[str, str]] = {}
    missing_required: list[str] = []
    warnings: list[str] = []
    for keys, directory, pattern in installers:
        artifact = find_one(artifacts / directory, pattern)
        signature_path = artifact.with_name(artifact.name + ".sig") if artifact else None
        if artifact is None or signature_path is None or not signature_path.is_file():
            if directory in required:
                missing_required.append(directory)
            else:
                warnings.append(
                    f"::warning::no signed {pattern} in {directory} - latest.json will not offer "
                    + ", ".join(keys)
                )
            continue
        entry = {"url": f"{base_url}/{artifact.name}", "signature": read_signature(signature_path)}
        for key in keys:
            platforms[key] = entry

    if missing_required:
        if len(missing_required) == len(required):
            print("Signing artifacts not found - skipping latest.json generation")
            return 0
        raise SystemExit(
            "generate_updater_manifest: some signed desktop builds are missing: "
            + ", ".join(missing_required)
            + " - refusing to publish a manifest that offers some platforms and silently not others"
        )
    for warning in warnings:
        print(warning)

    pub_date = args.pub_date or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = {
        "version": version,
        "notes": f"Signed desktop update {version}",
        "pub_date": pub_date,
        "platforms": platforms,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(args.out.read_text())
    return 0


if __name__ == "__main__":
    sys.exit(main())
