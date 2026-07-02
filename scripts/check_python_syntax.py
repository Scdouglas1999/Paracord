#!/usr/bin/env python3
"""Parse release Python helpers without creating bytecode cache files."""

from __future__ import annotations

import ast
import sys
from pathlib import Path


SCRIPT_DIR = Path("scripts")


def main() -> int:
    paths = sorted(SCRIPT_DIR.glob("*.py"))
    if not paths:
        print("No Python scripts found to parse", file=sys.stderr)
        return 1

    failures: list[str] = []
    for path in paths:
        try:
            source = path.read_text(encoding="utf-8")
            ast.parse(source, filename=str(path))
        except SyntaxError as exc:
            failures.append(f"{path}:{exc.lineno}:{exc.offset}: {exc.msg}")
        except UnicodeDecodeError as exc:
            failures.append(f"{path}: unable to decode as UTF-8: {exc}")

    if failures:
        print("Python syntax check failed:", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print(f"Python syntax check parsed {len(paths)} scripts.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
