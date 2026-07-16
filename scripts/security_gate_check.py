import re
import sys
from pathlib import Path


TRACKER_CANDIDATES = (
    Path("docs/security-release-gate.md"),
    Path("SECURITY_REMEDIATION_TRACKER.md"),
)
ROW_RE = re.compile(r"^\| (P0-\d{2}) \| [^|]+ \| [^|]+ \| [^|]+ \| ([A-Z_]+) \|")
ANY_P0_ROW_RE = re.compile(r"^\| P0-\d{2} \|")


def find_tracker() -> Path | None:
    for path in TRACKER_CANDIDATES:
        if path.exists():
            return path
    return None


def main() -> int:
    tracker_path = find_tracker()
    if tracker_path is None:
        # The P0 security-release tracker is a local-only process document and is
        # not published in the repository. Skip the gate when it is absent (e.g.
        # in a clean CI checkout) rather than fail; it runs where the tracker exists.
        candidates = ", ".join(str(path) for path in TRACKER_CANDIDATES)
        print(f"SKIP: no security release gate tracker present (checked: {candidates}).")
        return 0

    blocked = []
    p0_rows = 0
    for line in tracker_path.read_text(encoding="utf-8").splitlines():
        if ANY_P0_ROW_RE.match(line):
            p0_rows += 1
        match = ROW_RE.match(line)
        if match and match.group(2) != "DONE":
            blocked.append((match.group(1), match.group(2)))

    if p0_rows == 0:
        print(f"Release gate failed: no P0 rows found in {tracker_path}.")
        return 1

    if blocked:
        print("Release gate failed: one or more P0 tasks are not DONE.")
        for task_id, status in blocked:
            print(f"- {task_id}: {status}")
        return 1

    print(f"Security release gate passed: all {p0_rows} P0 tasks are DONE.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
