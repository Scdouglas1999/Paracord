#!/usr/bin/env python3
"""End-to-end smoke test for the SQLite -> PostgreSQL migrator.

Seeds a freshly migrated temp SQLite database, runs
`paracord-server migrate-to-postgres` against a live PostgreSQL service, and
asserts that every copied table's row count in the target matches the source.

The migrator's contract is a *faithful 1:1 copy*: after it runs, each table in
`MIGRATION_TABLE_ORDER` must hold exactly the source's rows. This gate verifies
that contract independently of the migrator's own internal count check.

Requirements:
  * PARACORD_TEST_POSTGRES_URL pointing at a disposable PostgreSQL server.
    (When unset the test skips, so a plain local checkout without PG passes.)
  * The `sqlite3` CLI on PATH (used to migrate + seed the source fixture).
  * psycopg2 (psycopg2-binary) for target verification.

This is destructive to a dedicated throwaway database
(`<name>_migrator_smoke`) on the target server; it never touches the database
named directly by PARACORD_TEST_POSTGRES_URL.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
SQLITE_MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations"
MIGRATE_EXPORT_RS = ROOT / "crates" / "paracord-db" / "src" / "migrate_export.rs"
SMOKE_DB_SUFFIX = "_migrator_smoke"


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
    result = subprocess.run(
        ["sqlite3", str(db_path)],
        input=sql,
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        fail(f"sqlite3 exec failed:\n{result.stdout}")


def sqlite_scalar(db_path: Path, sql: str) -> str:
    result = subprocess.run(
        ["sqlite3", str(db_path), sql],
        text=True,
        encoding="utf-8",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if result.returncode != 0:
        fail(f"sqlite3 query failed:\n{result.stdout}")
    return result.stdout.strip()


def apply_sqlite_migrations(db_path: Path) -> None:
    files = sorted(SQLITE_MIGRATIONS_DIR.glob("*.sql"))
    if not files:
        fail(f"no SQLite migrations found under {SQLITE_MIGRATIONS_DIR}")
    log(f"applying {len(files)} SQLite migrations to fixture")
    for path in files:
        sql = path.read_text(encoding="utf-8")
        result = subprocess.run(
            ["sqlite3", str(db_path)],
            input=sql,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        if result.returncode != 0:
            fail(f"migration {path.name} failed:\n{result.stdout}")


def build_server_binary() -> Path:
    """Build paracord-server without the embedded UI (no client/dist needed for
    the migrate-to-postgres subcommand)."""
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


def main() -> None:
    target_url = os.environ.get("PARACORD_TEST_POSTGRES_URL")
    if not target_url:
        skip("PARACORD_TEST_POSTGRES_URL not set")

    if shutil.which("sqlite3") is None:
        fail("sqlite3 CLI not found on PATH")

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
        # Explicit fixture row on top of the migration-seeded defaults.
        sqlite_exec(
            source_db,
            f"INSERT INTO server_settings(key, value) "
            f"VALUES('ci_migrator_smoke_marker', '{marker}');",
        )

        source_counts = {
            table: int(sqlite_scalar(source_db, f"SELECT COUNT(*) FROM {table};"))
            for table in tables
        }
        total_rows = sum(source_counts.values())
        log(f"source fixture: {total_rows} rows across {len(tables)} tables")

        result = run(
            [
                str(binary),
                "migrate-to-postgres",
                "--source",
                f"sqlite://{source_db}",
                "--target",
                smoke_url,
            ]
        )
        log(result.stdout.strip())
        if result.returncode != 0:
            fail(f"migrate-to-postgres exited {result.returncode}")

        # Independently verify the faithful 1:1 copy against the live target.
        conn = psycopg2.connect(smoke_url)
        try:
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
        finally:
            conn.close()

        if mismatches:
            for m in mismatches:
                log(f"MISMATCH {m}")
            fail(f"{len(mismatches)} table(s) did not copy faithfully")

        log(f"OK: {len(tables)} tables copied 1:1 ({total_rows} rows)")
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
