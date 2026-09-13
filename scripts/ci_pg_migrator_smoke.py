#!/usr/bin/env python3
"""End-to-end smoke test for the SQLite -> PostgreSQL migrator.

Seeds a freshly migrated temp SQLite database, runs
`paracord-server migrate-to-postgres` against a live PostgreSQL service, and
asserts row counts, repaired tails, unchanged read state and a new history epoch.

Source data is preserved except for derived channel tails and the target's
database history identity. PostgreSQL failure triggers prove that these repairs
and every copied row roll back together. Schema migrations and their seed rows
remain applied when copying fails or the command runs in dry-run mode.

Requirements:
  * PARACORD_TEST_POSTGRES_URL pointing at a disposable PostgreSQL server.
    (When unset the test skips, so a plain local checkout without PG passes.)
  * Python's sqlite3 module with FTS5 support for the source fixture.
  * psycopg2 (psycopg2-binary) for target verification.
  * Optional PARACORD_MIGRATOR_BINARY to test an already-built server binary.

This is destructive to a dedicated throwaway database
(`<name>_migrator_smoke`) on the target server; it never touches the database
named directly by PARACORD_TEST_POSTGRES_URL.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
SQLITE_MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations"
MIGRATE_EXPORT_RS = ROOT / "crates" / "paracord-db" / "src" / "migrate_export.rs"
SMOKE_DB_SUFFIX = "_migrator_smoke"
HISTORY_EPOCH_KEY = "database_history_epoch"
RECOVERY_ENVELOPE = json.dumps({
    "id": "499", "channel_id": "300", "author": {"id": "100"}, "content": "",
    "nonce": "imported-creation", "timestamp": "2026-09-12T12:00:00Z", "edited_timestamp": None,
    "flags": 1, "e2ee": {"version": 2, "nonce": "import-iv", "ciphertext": "import-ciphertext", "header": "import-header"},
}, separators=(",", ":"))


def log(msg: str) -> None:
    print(f"[pg-migrator-smoke] {msg}", flush=True)


def skip(msg: str) -> None:
    log(f"SKIP: {msg}")
    sys.exit(0)


def fail(msg: str) -> None:
    log(f"FAIL: {msg}")
    sys.exit(1)


def parse_migration_table_order() -> list[str]:
    """Extract MIGRATION_TABLE_ORDER (the authoritative list of copied tables)
    from the migrator source so this gate stays in lock-step with it."""
    text = MIGRATE_EXPORT_RS.read_text(encoding="utf-8")
    match = re.search(
        r"MIGRATION_TABLE_ORDER:\s*&\[&str\]\s*=\s*&\[(.*?)\];",
        text,
        re.DOTALL,
    )
    if not match:
        fail(f"could not find MIGRATION_TABLE_ORDER in {MIGRATE_EXPORT_RS}")
    tables = re.findall(r'"([a-z0-9_]+)"', match.group(1))
    if not tables:
        fail("MIGRATION_TABLE_ORDER parsed as empty")
    return tables


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        **kwargs,
    )


def sqlite_exec(db_path: Path, sql: str) -> None:
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            conn.executescript(sql)
    except sqlite3.Error as error:
        fail(f"sqlite3 exec failed: {error}")


def sqlite_scalar(db_path: Path, sql: str) -> str:
    try:
        with closing(sqlite3.connect(db_path)) as conn:
            rows = conn.execute(sql).fetchall()
        return "\n".join("|".join("" if value is None else str(value) for value in row) for row in rows)
    except sqlite3.Error as error:
        fail(f"sqlite3 query failed: {error}")


def apply_sqlite_migrations(db_path: Path) -> None:
    files = sorted(SQLITE_MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        fail(f"no SQLite migrations found under {SQLITE_MIGRATIONS_DIR}")
    log(f"applying {len(files)} SQLite migrations to fixture")
    for path in files:
        sqlite_exec(db_path, path.read_text(encoding="utf-8"))


def build_server_binary() -> Path:
    """Build paracord-server without the embedded UI (no client/dist needed for
    the migrate-to-postgres subcommand)."""
    supplied = os.environ.get("PARACORD_MIGRATOR_BINARY")
    if supplied:
        binary = Path(supplied).resolve()
        if not binary.is_file():
            fail(f"supplied server binary not found at {binary}")
        return binary
    log("building paracord-server (--no-default-features)")
    result = run(
        ["cargo", "build", "--bin", "paracord-server", "--no-default-features"]
    )
    if result.returncode != 0:
        fail(f"cargo build failed:\n{result.stdout}")
    binary = ROOT / "target" / "debug" / "paracord-server"
    if not binary.exists():
        fail(f"server binary not found at {binary}")
    return binary


def swap_database(url: str, new_db: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, f"/{new_db}", parts.query, parts.fragment))


def maintenance_db_name(url: str) -> str:
    return urlsplit(url).path.lstrip("/") or "postgres"


def seed_application_fixture(source_db: Path, marker: str) -> None:
    sqlite_exec(source_db, f"""
        PRAGMA foreign_keys = ON;
        INSERT INTO server_settings(key, value)
            VALUES('ci_migrator_smoke_marker', '{marker}');
        -- Model the runtime migration hook on this otherwise empty source.
        INSERT INTO server_settings(key, value) VALUES('webhook_token_backfill_v1', 'true')
            ON CONFLICT(key) DO NOTHING;
        INSERT INTO users(id, username, discriminator, email, password_hash)
            VALUES(100, 'import-owner', 1, 'import@example.test', 'fixture-hash');
        INSERT INTO spaces(id, name, owner_id) VALUES(200, 'Imported space', 100);
        INSERT INTO channels(id, space_id, name, channel_type, last_message_id, message_revision)
            VALUES(300, 200, 'surviving', 0, 499, 7),
                  (301, 200, 'empty', 0, 500, 8),
                  (302, 200, 'correct', 0, 450, 9);
        INSERT INTO messages(id, channel_id, author_id, content)
            VALUES(400, 300, 100, 'First survivor'),
                  (401, 300, 100, 'Latest survivor'),
                  (450, 302, 100, 'Correct tail');
        INSERT INTO read_states(user_id, channel_id, last_message_id, mention_count)
            VALUES(100, 300, 399, 3), (100, 301, 500, 2), (100, 302, 449, 0);
        INSERT INTO message_mentions(message_id, channel_id, user_id) VALUES(401, 300, 100);
        INSERT INTO message_delete_receipts(channel_id, actor_id, delete_nonce, message_id)
            VALUES(300, 100, 'imported-delete', 499);
        UPDATE channels SET message_recovery_floor = message_revision, message_recovery_start = message_revision;
        UPDATE channels SET message_recovery_floor = 5, message_recovery_start = 5 WHERE id = 300;
        INSERT INTO message_recovery(channel_id, revision, message_id, kind, encrypted_message)
            VALUES(300, 6, 499, 'create', '{RECOVERY_ENVELOPE}'), (300, 7, 499, 'delete', NULL);

    """)


def target_rows(conn, tables: list[str]) -> dict[str, list[tuple]]:
    """Full application-row snapshot, independent of the migrator's count check."""
    with conn.cursor() as cur:
        result = {}
        for table in tables:
            cur.execute(f'SELECT to_jsonb(t)::text FROM "{table}" t ORDER BY to_jsonb(t)::text')
            result[table] = cur.fetchall()
        return result


def assert_target_unchanged(conn, tables: list[str], expected: dict, label: str) -> None:
    actual = target_rows(conn, tables)
    changed = [table for table in tables if actual[table] != expected[table]]
    if changed:
        fail(f"{label} changed target rows: {', '.join(changed)}")


def main() -> None:
    target_url = os.environ.get("PARACORD_TEST_POSTGRES_URL")
    if not target_url:
        skip("PARACORD_TEST_POSTGRES_URL not set")

    try:
        import psycopg2
    except ImportError:
        fail("psycopg2 is required (pip install psycopg2-binary)")

    tables = parse_migration_table_order()
    log(f"{len(tables)} tables to verify")

    smoke_db = maintenance_db_name(target_url) + SMOKE_DB_SUFFIX
    smoke_url = swap_database(target_url, smoke_db)

    # (Re)create a throwaway target database on the maintenance connection.
    admin = psycopg2.connect(target_url)
    admin.autocommit = True
    try:
        with admin.cursor() as cur:
            cur.execute(f'DROP DATABASE IF EXISTS "{smoke_db}" WITH (FORCE)')
            cur.execute(f'CREATE DATABASE "{smoke_db}"')
    finally:
        admin.close()
    log(f"created throwaway target database {smoke_db}")

    binary = build_server_binary()
    workdir = Path(tempfile.mkdtemp(prefix="pg-migrator-smoke-"))
    marker = uuid.uuid4().hex
    try:
        source_db = workdir / "source.db"
        apply_sqlite_migrations(source_db)
        seed_application_fixture(source_db, marker)
        source_epoch = sqlite_scalar(source_db, f"SELECT value FROM server_settings WHERE key = '{HISTORY_EPOCH_KEY}'")
        if uuid.UUID(source_epoch).version != 4:
            fail("SQLite migration did not seed a UUID v4 history epoch")

        source_counts = {
            table: int(sqlite_scalar(source_db, f"SELECT COUNT(*) FROM {table};"))
            for table in tables
        }
        total_rows = sum(source_counts.values())
        log(f"source fixture: {total_rows} rows across {len(tables)} tables")

        command = [str(binary), "migrate-to-postgres", "--source", f"sqlite://{source_db}", "--target", smoke_url, "--batch-size", "1"]

        def migrate(*flags: str, expected_error: str | None = None) -> None:
            result = run([*command, *flags])
            if expected_error is not None:
                if result.returncode == 0 or expected_error not in result.stdout:
                    fail(f"expected {expected_error!r}:\n{result.stdout}")
            elif result.returncode != 0:
                fail(f"migrate-to-postgres exited {result.returncode}:\n{result.stdout}")

        migrate("--dry-run")
        conn = psycopg2.connect(smoke_url)
        conn.autocommit = True
        try:
            baseline = target_rows(conn, tables)
            with conn.cursor() as cur:
                cur.execute("SELECT value FROM server_settings WHERE key = %s", (HISTORY_EPOCH_KEY,))
                seeded_epoch = cur.fetchone()[0]
                if uuid.UUID(seeded_epoch).version != 4 or seeded_epoch == source_epoch:
                    fail("PostgreSQL migration did not create its own history epoch")
                cur.execute("SELECT COUNT(*) FROM users")
                if cur.fetchone()[0] != 0:
                    fail("dry run copied source users")
            migrate("--dry-run")
            assert_target_unchanged(conn, tables, baseline, "repeated dry run")

            sqlite_exec(source_db, "ALTER TABLE users ADD COLUMN ci_unmapped TEXT;")
            migrate(expected_error="ci_unmapped")
            assert_target_unchanged(conn, tables, baseline, "column prevalidation failure")
            sqlite_exec(source_db, "ALTER TABLE users DROP COLUMN ci_unmapped;")

            # Typed SQLite reads must reject a malformed Boolean value rather
            # than CAST it to zero and silently copy a different account state.
            sqlite_exec(source_db, "UPDATE users SET mfa_enabled='ci_invalid_boolean' WHERE id=100;")
            migrate(expected_error="unsupported source value in 'users.mfa_enabled'")
            assert_target_unchanged(conn, tables, baseline, "invalid Boolean source value")
            sqlite_exec(source_db, "UPDATE users SET mfa_enabled=0 WHERE id=100;")

            with conn.cursor() as cur:
                cur.execute("""
                    CREATE FUNCTION ci_fail_tail_repair() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN RAISE EXCEPTION 'ci injected tail repair failure'; END; $$;
                    CREATE TRIGGER ci_fail_tail_repair BEFORE UPDATE OF last_message_id ON channels
                        FOR EACH ROW EXECUTE FUNCTION ci_fail_tail_repair();
                """)
            migrate(expected_error="ci injected tail repair failure")
            assert_target_unchanged(conn, tables, baseline, "tail repair failure")
            with conn.cursor() as cur:
                cur.execute("DROP TRIGGER ci_fail_tail_repair ON channels; DROP FUNCTION ci_fail_tail_repair();")
                # Copying the source epoch is allowed. Only the final rotation
                # sees OLD.value equal to that epoch and replaces it again.
                cur.execute(f"""
                    CREATE FUNCTION ci_fail_history_rotation() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        IF NEW.key = '{HISTORY_EPOCH_KEY}' AND OLD.value = '{source_epoch}'
                            AND NEW.value <> OLD.value THEN
                            RAISE EXCEPTION 'ci injected history rotation failure';
                        END IF;
                        RETURN NEW;
                    END; $$;
                    CREATE TRIGGER ci_fail_history_rotation BEFORE UPDATE OF value ON server_settings
                        FOR EACH ROW EXECUTE FUNCTION ci_fail_history_rotation();
                """)
            migrate(expected_error="ci injected history rotation failure")
            assert_target_unchanged(conn, tables, baseline, "history rotation failure")
            with conn.cursor() as cur:
                cur.execute("DROP TRIGGER ci_fail_history_rotation ON server_settings; DROP FUNCTION ci_fail_history_rotation();")

            migrate()
            mismatches: list[str] = []
            with conn.cursor() as cur:
                for table, src in source_counts.items():
                    cur.execute(f'SELECT COUNT(*) FROM "{table}"')
                    dst = int(cur.fetchone()[0])
                    if dst != src:
                        mismatches.append(f"{table}: source={src} target={dst}")
                cur.execute(
                    "SELECT value FROM server_settings WHERE key = %s",
                    ("ci_migrator_smoke_marker",),
                )
                row = cur.fetchone()
                if row is None or row[0] != marker:
                    mismatches.append("marker row missing from target server_settings")
                cur.execute("SELECT id, last_message_id, message_revision FROM channels ORDER BY id")
                if cur.fetchall() != [(300, 401, 7), (301, None, 8), (302, 450, 9)]:
                    mismatches.append("channel tails were not repaired with source revisions preserved")
                cur.execute("SELECT user_id, channel_id, last_message_id, mention_count FROM read_states ORDER BY channel_id")
                if cur.fetchall() != [(100, 300, 399, 3), (100, 301, 500, 2), (100, 302, 449, 0)]:
                    mismatches.append("read cursors or legacy mention counts changed")
                cur.execute("SELECT message_id, channel_id, user_id FROM message_mentions")
                if cur.fetchall() != [(401, 300, 100)]:
                    mismatches.append("recorded mention changed")
                cur.execute("SELECT channel_id, actor_id, delete_nonce, message_id FROM message_delete_receipts")
                if cur.fetchall() != [(300, 100, 'imported-delete', 499)]:
                    mismatches.append("deletion receipt for an absent target changed")
                cur.execute("SELECT id, message_recovery_floor, message_recovery_start FROM channels ORDER BY id")
                if cur.fetchall() != [(300, 5, 5), (301, 8, 8), (302, 9, 9)]:
                    mismatches.append("message recovery floors or migration boundaries changed")
                cur.execute("SELECT channel_id, revision, message_id, kind, encrypted_message FROM message_recovery ORDER BY channel_id, revision")
                if cur.fetchall() != [(300, 6, 499, 'create', RECOVERY_ENVELOPE), (300, 7, 499, 'delete', None)]:
                    mismatches.append("immutable encrypted envelope or deletion archive changed")
                cur.execute("SELECT value FROM server_settings WHERE key = %s", (HISTORY_EPOCH_KEY,))
                imported_epoch = cur.fetchone()[0]
                if uuid.UUID(imported_epoch).version != 4 or imported_epoch in (source_epoch, seeded_epoch):
                    mismatches.append("import did not commit a new target history epoch")
            imported = target_rows(conn, tables)
            migrate("--dry-run")
            assert_target_unchanged(conn, tables, imported, "post-import dry run")
        finally:
            conn.close()

        if mismatches:
            for m in mismatches:
                log(f"MISMATCH {m}")
            fail(f"{len(mismatches)} import invariant(s) failed")

        if sqlite_scalar(source_db, f"SELECT value FROM server_settings WHERE key = '{HISTORY_EPOCH_KEY}'") != source_epoch:
            fail("source history epoch changed")
        if sqlite_scalar(source_db, "SELECT last_message_id FROM channels WHERE id = 300") != "499":
            fail("source tail was changed by import")
        log(f"OK: {len(tables)} tables ({total_rows} rows), repaired tails, unchanged cursors, fresh epoch and transactional failure rollback")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
        admin = psycopg2.connect(target_url)
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                cur.execute(f'DROP DATABASE IF EXISTS "{smoke_db}" WITH (FORCE)')
        finally:
            admin.close()


if __name__ == "__main__":
    main()
