#!/usr/bin/env python3
"""Validate SQLite query plans for release hot-path indexes."""

from __future__ import annotations

import re
import sqlite3
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations"
MIGRATION_RE = re.compile(r"^(\d{14})_([a-z0-9_]+)\.sql$")


def load_migrations() -> list[Path]:
    migrations: list[tuple[int, Path]] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        match = MIGRATION_RE.match(path.name)
        if not match:
            raise RuntimeError(f"invalid migration filename: {path.name}")
        migrations.append((int(match.group(1)), path))
    if not migrations:
        raise RuntimeError(f"no migrations found under {MIGRATIONS_DIR}")
    return [path for _, path in sorted(migrations)]


def apply_migrations(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON;")
    for migration in load_migrations():
        try:
            conn.executescript(migration.read_text(encoding="utf-8"))
        except sqlite3.DatabaseError as exc:
            raise RuntimeError(f"failed applying {migration.name}: {exc}") from exc
    conn.commit()


def assert_uses_index(
    conn: sqlite3.Connection,
    *,
    label: str,
    sql: str,
    params: tuple[object, ...],
    index_name: str,
) -> None:
    rows = conn.execute(f"EXPLAIN QUERY PLAN {sql}", params).fetchall()
    plan = " | ".join(str(row) for row in rows)
    if index_name.lower() not in plan.lower():
        raise AssertionError(f"{label}: expected {index_name} in query plan, got: {plan}")


def run_smoke() -> None:
    with tempfile.TemporaryDirectory(prefix="paracord-query-plan-") as temp_dir:
        db_path = Path(temp_dir) / "query-plan.db"
        conn = sqlite3.connect(str(db_path))
        try:
            apply_migrations(conn)
            checks = [
                {
                    "label": "message pagination latest",
                    "sql": "SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?",
                    "params": (2001, 100),
                    "index_name": "idx_messages_channel_created",
                },
                {
                    "label": "message pagination before cursor",
                    "sql": "SELECT id FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
                    "params": (2001, 3001, 100),
                    "index_name": "idx_messages_channel_created",
                },
                {
                    "label": "attachment hydration",
                    "sql": "SELECT id FROM attachments WHERE message_id = ?",
                    "params": (3001,),
                    "index_name": "idx_attachments_message_id",
                },
                {
                    "label": "scheduled message worker",
                    "sql": "SELECT id FROM scheduled_messages WHERE status = ? AND send_at <= ? ORDER BY send_at ASC LIMIT ?",
                    "params": ("pending", "2026-05-16T00:00:00Z", 100),
                    "index_name": "idx_scheduled_messages_due",
                },
                {
                    "label": "scheduled event worker by status",
                    "sql": "SELECT id FROM scheduled_events WHERE status IN (?, ?) ORDER BY scheduled_start ASC LIMIT ?",
                    "params": (1, 2, 100),
                    "index_name": "idx_scheduled_events_status_start",
                },
                {
                    "label": "case-insensitive email login",
                    "sql": "SELECT id FROM users WHERE email = ? COLLATE NOCASE LIMIT 1",
                    "params": ("USER@EXAMPLE.COM",),
                    "index_name": "idx_users_email_nocase",
                },
                {
                    "label": "case-insensitive username login",
                    "sql": "SELECT id FROM users WHERE username = ? COLLATE NOCASE LIMIT 1",
                    "params": ("ReleaseUser",),
                    "index_name": "idx_users_username_nocase",
                },
                {
                    "label": "bot reviews",
                    "sql": "SELECT bot_app_id FROM bot_reviews WHERE bot_app_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
                    "params": (4001, 20),
                    "index_name": "idx_bot_reviews_bot_updated",
                },
                {
                    "label": "bot metric events",
                    "sql": "SELECT bot_app_id FROM bot_metric_events WHERE bot_app_id = ? ORDER BY created_at DESC LIMIT ?",
                    "params": (4001, 30),
                    "index_name": "idx_bot_metric_events_bot_created",
                },
                {
                    "label": "group e2ee sender keys",
                    "sql": "SELECT id FROM group_e2ee_sender_keys WHERE channel_id = ? AND recipient_id = ? AND acknowledged = ? ORDER BY epoch",
                    "params": (2001, 42, 0),
                    "index_name": "idx_group_e2ee_sender_keys_recipient",
                },
                {
                    "label": "message slowmode lookup",
                    "sql": "SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1",
                    "params": (2001, 42),
                    "index_name": "idx_messages_channel_author_id",
                },
                {
                    "label": "pending attachment cleanup",
                    "sql": "SELECT id FROM attachments WHERE message_id IS NULL AND upload_expires_at IS NOT NULL AND upload_expires_at <= ? ORDER BY upload_expires_at ASC LIMIT ?",
                    "params": ("2026-05-16T00:00:00Z", 100),
                    "index_name": "idx_attachments_pending_cleanup",
                },
                {
                    "label": "bot guild installs by guild",
                    "sql": "SELECT bot_app_id FROM bot_guild_installs WHERE guild_id = ? ORDER BY created_at LIMIT ?",
                    "params": (1001, 100),
                    "index_name": "idx_bot_guild_installs_guild",
                },
                {
                    "label": "forum active thread listing",
                    "sql": "SELECT id FROM channels WHERE parent_id = ? AND channel_type = ? ORDER BY created_at DESC LIMIT ?",
                    "params": (2001, 6, 100),
                    "index_name": "idx_channels_parent_thread_created",
                },
            ]
            for check in checks:
                assert_uses_index(conn, **check)
        finally:
            conn.close()

    print(f"PASS: SQLite query-plan smoke validated {len(checks)} hot-path indexes")


def main() -> int:
    try:
        run_smoke()
    except (AssertionError, RuntimeError, sqlite3.DatabaseError) as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
