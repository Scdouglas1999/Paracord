#!/usr/bin/env python3
"""Verify release metadata versions agree, optionally against a tag version."""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path


VERSION_FILES = {
    "Cargo workspace": ("toml", Path("Cargo.toml"), ("workspace", "package", "version")),
    "client/package.json": ("json", Path("client/package.json"), ("version",)),
    "client/src-tauri/tauri.conf.json": (
        "json",
        Path("client/src-tauri/tauri.conf.json"),
        ("version",),
    ),
}

VERSION_TEXT_FILES = {
    "README.md": Path("README.md"),
    "RELEASE_NOTES.md": Path("RELEASE_NOTES.md"),
}


def load_version(kind: str, path: Path, keys: tuple[str, ...]) -> str:
    if kind == "toml":
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    elif kind == "json":
        data = json.loads(path.read_text(encoding="utf-8"))
    else:
        raise ValueError(f"Unsupported metadata kind: {kind}")

    value = data
    for key in keys:
        value = value[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f"{path} field {'.'.join(keys)} is not a non-empty string")
    return value


def main(argv: list[str]) -> int:
    expected = argv[1].removeprefix("v") if len(argv) > 1 else None
    if len(argv) > 2:
        print("Usage: check_release_version.py [version-or-tag]", file=sys.stderr)
        return 2

    versions = {
        name: load_version(kind, path, keys)
        for name, (kind, path, keys) in VERSION_FILES.items()
    }
    baseline = expected or next(iter(versions.values()))

    mismatches = {
        name: version for name, version in versions.items() if version != baseline
    }
    if mismatches:
        for name, version in mismatches.items():
            print(
                f"{name} version {version} does not match expected {baseline}",
                file=sys.stderr,
            )
        return 1

    marker = f"v{baseline}"
    missing_markers = [
        name
        for name, path in VERSION_TEXT_FILES.items()
        if marker not in path.read_text(encoding="utf-8")
    ]
    if missing_markers:
        for name in missing_markers:
            print(f"{name} does not mention release marker {marker}", file=sys.stderr)
        return 1

    if expected:
        print(
            f"Release tag version {expected} matches Cargo, npm, Tauri, README, and release notes."
        )
    else:
        print(f"Release metadata and docs versions match: {baseline}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
