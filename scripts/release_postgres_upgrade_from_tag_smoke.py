#!/usr/bin/env python3
"""PostgreSQL upgrade smoke test from the latest release tag schema.

This is destructive to the database named by PARACORD_TEST_POSTGRES_URL and is
intended only for disposable CI/staging databases. It is not a substitute for
testing a real production database snapshot.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import psycopg2
except ImportError as exc:  # pragma: no cover - depends on runner image
    raise SystemExit(
        "psycopg2 is required. Install psycopg2-binary or run in the release CI image."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
CURRENT_MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations_pg"
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
    return hashlib.sha384(canonical_sql(sql).encode("utf-8")).digest()


def list_tag_migrations(tag: str) -> list[str]:
    output = git_text("ls-tree", "-r", "--name-only", tag, "crates/paracord-db/migrations_pg")
    migrations = [line.strip() for line in output.splitlines() if line.strip().endswith(".sql")]
    if not migrations:
        raise RuntimeError(f"no PostgreSQL migrations found in tag {tag}")
    migrations.sort(key=lambda path: parse_migration_name(path)[0])
    return migrations


def list_current_migrations() -> list[Path]:
    migrations = sorted(
        CURRENT_MIGRATIONS_DIR.glob("*.sql"),
        key=lambda path: parse_migration_name(path)[0],
    )
    if not migrations:
        raise RuntimeError(f"no current PostgreSQL migrations found under {CURRENT_MIGRATIONS_DIR}")
    return migrations


def execute_sql(cur, sql: str) -> None:
    cur.execute(canonical_sql(sql))


def reset_schema(cur) -> None:
    cur.execute("DROP SCHEMA public CASCADE")
    cur.execute("CREATE SCHEMA public")


def ensure_sqlx_ledger(cur) -> None:
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS _sqlx_migrations (
            version BIGINT PRIMARY KEY,
            description TEXT NOT NULL,
            installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
            success BOOLEAN NOT NULL,
            checksum BYTEA NOT NULL,
            execution_time BIGINT NOT NULL
        )
        """
    )


def record_migration(cur, version: int, description: str, checksum: bytes) -> None:
    cur.execute(
        """
        INSERT INTO _sqlx_migrations
            (version, description, success, checksum, execution_time)
        VALUES (%s, %s, TRUE, %s, 0)
        """,
        (version, description, psycopg2.Binary(checksum)),
    )


def apply_migration(cur, version: int, description: str, sql: str) -> None:
    execute_sql(cur, sql)
    record_migration(cur, version, description, sha384_bytes(sql))


def assert_column(cur, table: str, column: str) -> None:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
        """,
        (table, column),
    )
    if cur.fetchone() is None:
        raise AssertionError(f"missing expected column {table}.{column}")


def assert_table(cur, table: str) -> None:
    cur.execute(
        """
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = %s
        """,
        (table,),
    )
    if cur.fetchone() is None:
        raise AssertionError(f"missing expected table {table}")


def assert_index(cur, index_name: str) -> None:
    cur.execute("SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = %s", (index_name,))
    if cur.fetchone() is None:
        raise AssertionError(f"missing expected index {index_name}")


def main() -> int:
    tag = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_TAG
    database_url = os.environ.get("PARACORD_TEST_POSTGRES_URL", "").strip()
    if not database_url:
        print("[postgres-upgrade-from-tag] SKIP: PARACORD_TEST_POSTGRES_URL is not set")
        return 0
    if not (database_url.startswith("postgres://") or database_url.startswith("postgresql://")):
        print("[postgres-upgrade-from-tag] FAILED: PARACORD_TEST_POSTGRES_URL must be PostgreSQL", file=sys.stderr)
        return 1

    try:
        tag_migrations = list_tag_migrations(tag)
        current_migrations = list_current_migrations()
        current_by_name = {path.name: path for path in current_migrations}

        with psycopg2.connect(database_url) as conn:
            with conn.cursor() as cur:
                reset_schema(cur)
                ensure_sqlx_ledger(cur)
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
                            "current PostgreSQL migration checksum differs from tag for "
                            f"{Path(tag_path).name}; SQLx would reject an upgrade"
                        )
                    apply_migration(cur, version, description, tag_sql)
                    tag_versions.add(version)

                applied_new = 0
                for migration_path in current_migrations:
                    version, description = parse_migration_name(migration_path)
                    if version in tag_versions:
                        continue
                    sql = migration_path.read_text(encoding="utf-8")
                    apply_migration(cur, version, description, sql)
                    applied_new += 1

                cur.execute("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = TRUE")
                ledger_count = cur.fetchone()[0]
                expected_count = len(current_migrations)
                if ledger_count != expected_count:
                    raise AssertionError(
                        f"expected {expected_count} ledger rows, found {ledger_count}"
                    )

                assert_column(cur, "messages", "embeds")
                assert_column(cur, "scheduled_events", "recurrence_rule")
                assert_column(cur, "stickers", "asset_key")
                assert_column(cur, "webhooks", "github_secret")
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
                    assert_table(cur, table)
                for index in [
                    "idx_bot_reviews_bot_updated",
                    "idx_scheduled_events_status_start",
                    "idx_messages_channel_author_id",
                    "idx_attachments_pending_cleanup",
                    "idx_bot_guild_installs_guild",
                    "idx_channels_parent_thread_created",
                ]:
                    assert_index(cur, index)
    except (AssertionError, RuntimeError, psycopg2.Error, subprocess.CalledProcessError) as exc:
        print(f"[postgres-upgrade-from-tag] FAILED: {exc}", file=sys.stderr)
        return 1

    print(
        "[postgres-upgrade-from-tag] OK: "
        f"{len(tag_migrations)} migrations from {tag}; "
        f"{applied_new} current migrations applied; "
        f"{len(current_migrations)} total ledger rows."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
