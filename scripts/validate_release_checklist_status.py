#!/usr/bin/env python3
"""Validate that release checklist status stays aligned with goal.txt.

This is a structural guard, not proof of release readiness. It checks that each
goal section is represented, has at least as many status entries as source
bullets, uses known status labels, and avoids a few stale evidence strings that
have regressed before.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GOAL = ROOT / "goal.txt"
STATUS = ROOT / "RELEASE_CHECKLIST_STATUS.md"

SECTION_RE = re.compile(r"^\s*(\d+)\.\s+(.+?)\s*$")
STATUS_HEADING_RE = re.compile(r"^##\s+(\d+)\.\s+(.+?)\s*$")
STATUS_ENTRY_RE = re.compile(r"^-\s+(DONE|PARTIAL|BLOCKED|OWNER|TODO):\s+")
STRUCTURAL_SUMMARY_RE = re.compile(
    r"^Structural validation: `python scripts\\validate_release_checklist_status\.py` "
    r"passes, covering (?P<sections>\d+) sections, (?P<bullets>\d+) source goal bullets, "
    r"and (?P<statuses>\d+) status entries: (?P<done>\d+) DONE, (?P<partial>\d+) "
    r"PARTIAL, (?P<blocked>\d+) BLOCKED, (?P<owner>\d+) OWNER, (?P<todo>\d+) TODO\.$",
    re.MULTILINE,
)

STALE_PATTERNS = [
    "assets/index-eIoBX-Ta.js",
    "assets/index-QE8rnMg2.js",
    "34 files / 309 tests",
    "36 files / 313 tests",
    "38 files / 318 tests",
    "38 files / 320 tests",
    "39 files / 323 tests",
    "40 files / 325 tests",
    "42 files / 330 tests",
    "43 files / 331 tests",
    "44 files / 336 tests",
    "45 files / 340 tests",
    "46 files / 342 tests",
    "47 files / 345 tests",
    "48 files / 348 tests",
    "50 files / 352 tests",
    "51 files / 354 tests",
    "52 files / 356 tests",
    "52 files / 357 tests",
    "53 files / 359 tests",
    "53 files / 360 tests",
    "54 files / 362 tests",
    "55 files / 364 tests",
    "55 files / 366 tests",
    "55 files / 367 tests",
    "55 files / 369 tests",
    "56 files / 372 tests",
    "57 files / 376 tests",
    "58 files / 379 tests",
    "58 files / 381 tests",
    "58 files / 382 tests",
    "59 files / 385 tests",
    "60 files / 388 tests",
    "61 files / 390 tests",
    "62 files / 392 tests",
    "62 files / 393 tests",
    "62 files / 394 tests",
    "63 files / 396 tests",
    "64 files / 398 tests",
    "65 files / 399 tests",
    "66 files / 402 tests",
    "66 files / 403 tests",
    "67 files / 405 tests",
    "68 files / 407 tests",
    "69 files / 408 tests",
    "70 files / 409 tests",
    "70 files / 411 tests",
    "70 files / 414 tests",
    "71 files / 416 tests",
    "71 files / 417 tests",
    "72 files / 420 tests",
    "72 files / 422 tests",
    "72 files / 424 tests",
    "72 files / 425 tests",
    "73 files / 427 tests",
    "74 files / 429 tests",
    "64 SQLite migrations and checks 65 PostgreSQL migrations",
    "129 current SQL migration files",
    "131 current SQL migration files",
    "applies 30 newer current migrations",
    "verifies 64 SQLx migration ledger rows",
    "88 DONE, 53 PARTIAL, 9 BLOCKED",
    "90 DONE, 52 PARTIAL, 8 BLOCKED",
    "91 DONE, 51 PARTIAL, 8 BLOCKED",
    "92 DONE, 51 PARTIAL, 8 BLOCKED",
    "152 status entries",
    "logs to console",
    "currently log to console",
    "strongest code gaps are user-visible group-DM",
]


@dataclass
class Section:
    number: int
    title: str
    bullets: int = 0
    statuses: list[str] = field(default_factory=list)


def parse_goal() -> dict[int, Section]:
    if not GOAL.exists():
        raise FileNotFoundError(GOAL)

    sections: dict[int, Section] = {}
    current: Section | None = None
    for raw_line in GOAL.read_text(encoding="utf-8", errors="replace").splitlines():
        match = SECTION_RE.match(raw_line)
        if match:
            number = int(match.group(1))
            current = Section(number=number, title=match.group(2))
            sections[number] = current
            continue

        stripped = raw_line.strip()
        if current and stripped.startswith("- "):
            current.bullets += 1

    return sections


def parse_status() -> dict[int, Section]:
    if not STATUS.exists():
        raise FileNotFoundError(STATUS)

    sections: dict[int, Section] = {}
    current: Section | None = None
    for raw_line in STATUS.read_text(encoding="utf-8", errors="replace").splitlines():
        heading = STATUS_HEADING_RE.match(raw_line)
        if heading:
            number = int(heading.group(1))
            current = Section(number=number, title=heading.group(2))
            sections[number] = current
            continue

        if not raw_line.startswith("- "):
            continue
        if current is None:
            continue
        entry = STATUS_ENTRY_RE.match(raw_line)
        if entry:
            current.statuses.append(entry.group(1))
        elif any(raw_line.startswith(f"- {label}:") for label in ("DONE", "PARTIAL", "BLOCKED", "OWNER", "TODO")):
            raise AssertionError(f"malformed status entry in section {current.number}: {raw_line}")

    return sections


def main() -> int:
    goal_sections = parse_goal()
    status_sections = parse_status()
    errors: list[str] = []
    status_text = STATUS.read_text(encoding="utf-8", errors="replace")

    for number, goal_section in sorted(goal_sections.items()):
        status_section = status_sections.get(number)
        if status_section is None:
            errors.append(f"missing status section {number}: {goal_section.title}")
            continue
        if status_section.title != goal_section.title:
            errors.append(
                f"section {number} title mismatch: goal={goal_section.title!r}, "
                f"status={status_section.title!r}"
            )
        if len(status_section.statuses) < goal_section.bullets:
            errors.append(
                f"section {number} has {len(status_section.statuses)} status entries "
                f"for {goal_section.bullets} goal bullets"
            )

    missing_from_goal = sorted(set(status_sections) - set(goal_sections))
    if missing_from_goal:
        errors.append(f"status contains unknown sections: {missing_from_goal}")

    for pattern in STALE_PATTERNS:
        if pattern in status_text:
            errors.append(f"stale evidence string remains in status file: {pattern}")

    counts: dict[str, int] = {}
    for section in status_sections.values():
        for status in section.statuses:
            counts[status] = counts.get(status, 0) + 1

    total_goal_bullets = sum(section.bullets for section in goal_sections.values())
    total_statuses = sum(counts.values())
    count_summary = ", ".join(f"{label}={counts.get(label, 0)}" for label in ("DONE", "PARTIAL", "BLOCKED", "OWNER", "TODO"))
    summary_match = STRUCTURAL_SUMMARY_RE.search(status_text)
    if not summary_match:
        errors.append("missing or malformed Structural validation summary line")
    else:
        expected_summary = {
            "sections": len(goal_sections),
            "bullets": total_goal_bullets,
            "statuses": total_statuses,
            "done": counts.get("DONE", 0),
            "partial": counts.get("PARTIAL", 0),
            "blocked": counts.get("BLOCKED", 0),
            "owner": counts.get("OWNER", 0),
            "todo": counts.get("TODO", 0),
        }
        for key, expected_value in expected_summary.items():
            actual_value = int(summary_match.group(key))
            if actual_value != expected_value:
                errors.append(
                    f"Structural validation summary {key}={actual_value} "
                    f"does not match computed {expected_value}"
                )

    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1

    print(
        "PASS: release checklist status structurally covers "
        f"{len(goal_sections)} sections, {total_goal_bullets} goal bullets, "
        f"and {total_statuses} status entries ({count_summary})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
