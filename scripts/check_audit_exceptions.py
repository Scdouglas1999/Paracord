#!/usr/bin/env python3
"""Enforce review dates on cargo-audit advisory exceptions.

Every advisory id ignored in `.cargo/audit.toml` must carry a documented
`Review by: YYYY-MM-DD` date in the preceding comment block. This check fails
once that date is reached so time-boxed security exceptions cannot silently
outlive their review window.
"""

from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
AUDIT_TOML = ROOT / ".cargo" / "audit.toml"

ADVISORY_RE = re.compile(r"RUSTSEC-\d{4}-\d{4}")
REVIEW_BY_RE = re.compile(r"Review by:\s*(\d{4}-\d{2}-\d{2})")


def parse_ignored_advisories(text: str) -> list[str]:
    """Return advisory ids listed in the `ignore = [...]` array."""
    match = re.search(r"ignore\s*=\s*\[(.*?)\]", text, re.DOTALL)
    if match is None:
        return []
    return ADVISORY_RE.findall(match.group(1))


def parse_review_dates(text: str) -> dict[str, str]:
    """Map each advisory id mentioned in comments to its `Review by:` date.

    Comment lines are scanned in order: a line naming one or more advisory ids
    sets the active advisories, and a subsequent `Review by:` line assigns that
    date to whichever advisories were most recently named.
    """
    review_dates: dict[str, str] = {}
    active_ids: list[str] = []

    for line in text.splitlines():
        stripped = line.lstrip()
        if not stripped.startswith("#"):
            continue

        found_ids = ADVISORY_RE.findall(stripped)
        if found_ids:
            active_ids = found_ids

        date_match = REVIEW_BY_RE.search(stripped)
        if date_match and active_ids:
            for advisory_id in active_ids:
                review_dates[advisory_id] = date_match.group(1)

    return review_dates


def main() -> int:
    if not AUDIT_TOML.exists():
        print(f"[audit-exceptions] FAILED: missing {AUDIT_TOML}")
        return 1

    text = AUDIT_TOML.read_text(encoding="utf-8")
    ignored = parse_ignored_advisories(text)

    if not ignored:
        print("[audit-exceptions] OK: no ignored advisories to review.")
        return 0

    review_dates = parse_review_dates(text)
    today = date.today()
    failures: list[str] = []

    for advisory_id in ignored:
        raw_date = review_dates.get(advisory_id)
        if raw_date is None:
            failures.append(
                f"{advisory_id}: ignored in .cargo/audit.toml but has no parseable "
                "'Review by: YYYY-MM-DD' date in its comment block. Add one so the "
                "exception is time-boxed."
            )
            continue

        try:
            review_date = date.fromisoformat(raw_date)
        except ValueError:
            failures.append(
                f"{advisory_id}: 'Review by: {raw_date}' is not a valid ISO date "
                "(expected YYYY-MM-DD)."
            )
            continue

        if today >= review_date:
            failures.append(
                f"{advisory_id}: review date {review_date.isoformat()} has passed "
                f"(today is {today.isoformat()}). Re-verify the advisory in "
                ".cargo/audit.toml, then bump the 'Review by:' date or remove the "
                "ignore if it no longer applies."
            )

    if failures:
        print("[audit-exceptions] FAILED:")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print(
        f"[audit-exceptions] OK: {len(ignored)} ignored advisory exception(s) "
        "within their review window."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
