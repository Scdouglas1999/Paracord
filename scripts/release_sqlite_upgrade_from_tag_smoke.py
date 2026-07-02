#!/usr/bin/env python3
"""SQLite upgrade smoke test from the latest release tag schema.

This is not a substitute for testing a real production database snapshot. It
builds a temporary SQLite database from the migration files in a git tag, writes
the SQLx migration ledger with tag checksums, verifies already-applied migration
checksums still match the current tree, then applies current-tree migrations
that are newer than the tag.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CURRENT_MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations"
DEFAULT_TAG = "v0.9.0"
MIGRATION_RE = re.compile(r"^(\d{14})_([a-z0-9_]+)\.sql$")


def git_text(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=True,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return result.stdout


def parse_migration_name(path: Path | str) -> tuple[int, str]:
    name = Path(path).name
    match = MIGRATION_RE.match(name)
    if not match:
        raise RuntimeError(f"invalid migration filename: {name}")
    return int(match.group(1)), match.group(2)


def canonical_sql(sql: str) -> str:
    return sql.replace("\r\n", "\n").replace("\r", "\n")


def sha384_bytes(sql: str) -> bytes:
    # Official release artifacts should be built from normalized git blobs. Avoid
    # treating a developer checkout's CRLF conversion as migration content drift.
    return hashlib.sha384(canonical_sql(sql).encode("utf-8")).digest()


def list_tag_migrations(tag: str) -> list[str]:
    output = git_text("ls-tree", "-r", "--name-only", tag, "crates/paracord-db/migrations")
    migrations = [line.strip() for line in output.splitlines() if line.strip().endswith(".sql")]
    if not migrations:
        raise RuntimeError(f"no SQLite migrations found in tag {tag}")
    migrations.sort(key=lambda path: parse_migration_name(path)[0])
    return migrations


def list_current_migrations() -> list[Path]:
    migrations = sorted(
        CURRENT_MIGRATIONS_DIR.glob("*.sql"),
        key=lambda path: parse_migration_name(path)[0],
    )
    if not migrations:
        raise RuntimeError(f"no current SQLite migrations found under {CURRENT_MIGRATIONS_DIR}")
    return migrations


def ensure_sqlx_ledger(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            success BOOLEAN NOT NULL,
            checksum BLOB NOT NULL,
            execution_time BIGINT NOT NULL
        );
        """
    )


def record_migration(
    conn: sqlite3.Connection,
    version: int,
    description: str,
    checksum: bytes,
) -> None:
    conn.execute(
        """
        INSERT INTO _sqlx_migrations
            (version, description, success, checksum, execution_time)
        VALUES (?, ?, TRUE, ?, 0)
        """,
        (version, description, checksum),
    )


def apply_migration(
    conn: sqlite3.Connection,
    version: int,
    description: str,
    sql: str,
) -> None:
    conn.executescript(canonical_sql(sql))
    record_migration(conn, version, description, sha384_bytes(sql))


def assert_column(conn: sqlite3.Connection, table: str, column: str) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    columns = {row[1] for row in rows}
    if column not in columns:
        raise AssertionError(f"missing expected column {table}.{column}")


def assert_table(conn: sqlite3.Connection, table: str) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table,),
    ).fetchone()
    if row is None:
        raise AssertionError(f"missing expected table {table}")


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TAG

    try:
        tag_migrations = list_tag_migrations(tag)
        current_migrations = list_current_migrations()
        current_by_name = {path.name: path for path in current_migrations}

        with tempfile.TemporaryDirectory(prefix="paracord-upgrade-") as tmp_dir:
            db_path = Path(tmp_dir) / "upgrade.db"
            conn = sqlite3.connect(str(db_path))
            conn.execute("PRAGMA foreign_keys = ON;")
            try:
                ensure_sqlx_ledger(conn)
                tag_versions: set[int] = set()

                for tag_path in tag_migrations:
                    version, description = parse_migration_name(tag_path)
                    tag_sql = git_text("show", f"{tag}:{tag_path}")
                    current_path = current_by_name.get(Path(tag_path).name)
                    if current_path is None:
                        raise RuntimeError(
                            f"tag migration missing from current tree: {Path(tag_path).name}"
                        )
                    current_sql = current_path.read_text(encoding="utf-8")
                    if sha384_bytes(tag_sql) != sha384_bytes(current_sql):
                        raise RuntimeError(
                            "current migration checksum differs from tag for "
                            f"{Path(tag_path).name}; SQLx would reject an upgrade"
                        )
                    apply_migration(conn, version, description, tag_sql)
                    tag_versions.add(version)

                applied_new = 0
                for migration_path in current_migrations:
                    version, description = parse_migration_name(migration_path)
                    if version in tag_versions:
                        continue
                    sql = migration_path.read_text(encoding="utf-8")
                    apply_migration(conn, version, description, sql)
                    applied_new += 1

                conn.commit()

                expected_count = len(current_migrations)
                ledger_count = conn.execute(
                    "SELECT COUNT(*) FROM _sqlx_migrations WHERE success = TRUE"
                ).fetchone()[0]
                if ledger_count != expected_count:
                    raise AssertionError(
                        f"expected {expected_count} ledger rows, found {ledger_count}"
                    )

                assert_column(conn, "messages", "embeds")
                assert_column(conn, "scheduled_events", "recurrence_rule")
                assert_column(conn, "stickers", "asset_key")
                assert_column(conn, "webhooks", "github_secret")
                for table in [
                    "password_reset_tokens",
                    "mfa_configs",
                    "mfa_backup_codes",
                    "guild_templates",
                    "stage_instances",
                    "guild_level_roles",
                    "user_activity_streaks",
                    "user_achievements",
                    "scheduled_messages",
                    "anonymous_messages",
                    "moderation_action_templates",
                    "bot_reviews",
                    "bot_metric_events",
                    "stickers",
                    "group_e2ee_sender_keys",
                    "guild_onboarding_settings",
                    "guild_onboarding_role_options",
                    "member_onboarding_state",
                ]:
                    assert_table(conn, table)
            finally:
                conn.close()
    except (AssertionError, RuntimeError, sqlite3.DatabaseError, subprocess.CalledProcessError) as exc:
        print(f"[sqlite-upgrade-from-tag] FAILED: {exc}", file=sys.stderr)
        return 1

    print(
        "[sqlite-upgrade-from-tag] OK: "
        f"{len(tag_migrations)} migrations from {tag}; "
        f"{applied_new} current migrations applied; "
        f"{len(current_migrations)} total ledger rows."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
