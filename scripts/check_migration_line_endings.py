#!/usr/bin/env python3
"""Verify release-critical text files are protected from line-ending drift."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


MIGRATION_DIRS = [
    Path("crates/paracord-db/migrations"),
    Path("crates/paracord-db/migrations_pg"),
]
SHELL_SCRIPT_DIR = Path("scripts")
WORKFLOW_DIR = Path(".github/workflows")
RELEASE_DOC_PATHS = [
    Path("README.md"),
    Path("RELEASE_NOTES.md"),
]

EXPECTED_ATTRS = {"eol": "lf", "text": "set"}


def migration_paths() -> list[str]:
    paths: list[str] = []
    for directory in MIGRATION_DIRS:
        paths.extend(str(path.as_posix()) for path in sorted(directory.glob("*.sql")))
    return paths


def shell_script_paths() -> list[str]:
    return [str(path.as_posix()) for path in sorted(SHELL_SCRIPT_DIR.glob("*.sh"))]


def python_script_paths() -> list[str]:
    return [str(path.as_posix()) for path in sorted(SHELL_SCRIPT_DIR.glob("*.py"))]


def workflow_paths() -> list[str]:
    paths = sorted(WORKFLOW_DIR.glob("*.yml")) + sorted(WORKFLOW_DIR.glob("*.yaml"))
    return [str(path.as_posix()) for path in paths]


def main() -> int:
    paths = (
        migration_paths()
        + shell_script_paths()
        + python_script_paths()
        + workflow_paths()
        + [str(path.as_posix()) for path in RELEASE_DOC_PATHS]
    )
    if not paths:
        print("No release-critical line-ending files found to verify", file=sys.stderr)
        return 1

    command = [
        "git",
        "check-attr",
        "eol",
        "text",
        "--",
        *paths,
    ]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(result.stderr.strip() or "git check-attr failed", file=sys.stderr)
        return result.returncode

    observed: dict[str, dict[str, str]] = {path: {} for path in paths}
    for raw_line in result.stdout.splitlines():
        try:
            path, attr, value = raw_line.split(": ", 2)
        except ValueError:
            print(f"Unexpected git check-attr output: {raw_line}", file=sys.stderr)
            return 1
        observed.setdefault(path, {})[attr] = value

    failures: list[str] = []
    for path in paths:
        for attr, expected_value in EXPECTED_ATTRS.items():
            actual = observed.get(path, {}).get(attr)
            if actual != expected_value:
                failures.append(
                    f"{path}: expected {attr}={expected_value}, got {actual or '<missing>'}"
                )
        raw = Path(path).read_bytes()
        if b"\r" in raw:
            failures.append(f"{path}: contains CR bytes in the working tree")

    if failures:
        print("Release line-ending check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(
        f"Release line-ending attributes verified for {len(paths)} files: text eol=lf with no CR bytes."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
