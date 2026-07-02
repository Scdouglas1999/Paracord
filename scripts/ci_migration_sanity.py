#!/usr/bin/env python3
"""Migration sanity checks for CI.

Validates that migration filenames are strictly versioned and that all SQL
migrations can be applied in order to a fresh SQLite database.
"""

from __future__ import annotations

import re
import sqlite3
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "crates" / "paracord-db" / "migrations"
MIGRATIONS_PG_DIR = ROOT / "crates" / "paracord-db" / "migrations_pg"
MIGRATION_RE = re.compile(r"^(\d{14})_([a-z0-9_]+)\.sql$")
POSTGRES_EXTRA_MIGRATIONS = {
    "20260208000000_sqlite_compat.sql",
}


def load_migrations(directory: Path) -> list[tuple[int, Path]]:
    if not directory.exists():
        raise RuntimeError(f"Missing migrations directory: {directory}")

    migrations: list[tuple[int, Path]] = []
    seen_versions: dict[int, Path] = {}

    for file_path in sorted(directory.glob("*.sql")):
        match = MIGRATION_RE.match(file_path.name)
        if not match:
            raise RuntimeError(
                f"Invalid migration filename format: {file_path.name} "
                "(expected <14-digit-version>_<slug>.sql)"
            )

        version = int(match.group(1))
        previous = seen_versions.get(version)
        if previous is not None:
            raise RuntimeError(
                f"Duplicate migration version {version}:\n"
                f"- {previous.name}\n- {file_path.name}"
            )
        seen_versions[version] = file_path
        migrations.append((version, file_path))

    if not migrations:
        raise RuntimeError("No migrations found.")

    return migrations


def verify_sqlite_postgres_parity(
    sqlite_migrations: list[tuple[int, Path]],
    postgres_migrations: list[tuple[int, Path]],
) -> None:
    sqlite_names = {path.name for _, path in sqlite_migrations}
    postgres_names = {path.name for _, path in postgres_migrations}
    expected_postgres = sqlite_names | POSTGRES_EXTRA_MIGRATIONS

    missing = sorted(sqlite_names - postgres_names)
    unexpected = sorted(postgres_names - expected_postgres)

    if missing:
        raise RuntimeError(
            "PostgreSQL migrations missing SQLite counterparts:\n"
            + "\n".join(f"- {name}" for name in missing)
        )
    if unexpected:
        raise RuntimeError(
            "Unexpected PostgreSQL-only migrations:\n"
            + "\n".join(f"- {name}" for name in unexpected)
        )


def verify_obvious_dialect_drift(
    sqlite_migrations: list[tuple[int, Path]],
    postgres_migrations: list[tuple[int, Path]],
) -> None:
    sqlite_forbidden = [
        "BIGSERIAL",
        "JSONB",
        "ILIKE",
        "CREATE EXTENSION",
        "USING GIN",
        "GENERATED ALWAYS AS IDENTITY",
    ]
    postgres_forbidden = [
        "AUTOINCREMENT",
        "WITHOUT ROWID",
        "PRAGMA ",
    ]

    for _, path in sqlite_migrations:
        sql = path.read_text(encoding="utf-8").upper()
        for token in sqlite_forbidden:
            if token in sql:
                raise RuntimeError(
                    f"SQLite migration {path.name} contains PostgreSQL-only token: {token}"
                )

    for _, path in postgres_migrations:
        sql = path.read_text(encoding="utf-8").upper()
        for token in postgres_forbidden:
            if token in sql:
                raise RuntimeError(
                    f"PostgreSQL migration {path.name} contains SQLite-only token: {token}"
                )


def verify_strict_ordering(migrations: list[tuple[int, Path]]) -> None:
    versions = [version for version, _ in migrations]
    if versions != sorted(versions):
        raise RuntimeError("Migrations are not sorted by version.")

    for idx in range(1, len(versions)):
        if versions[idx] <= versions[idx - 1]:
            raise RuntimeError(
                f"Migration versions must be strictly increasing, found "
                f"{versions[idx - 1]} then {versions[idx]}"
            )


def apply_all_sqlite_migrations(migrations: list[tuple[int, Path]]) -> None:
    with tempfile.TemporaryDirectory(prefix="paracord-migrations-") as tmp_dir:
        db_path = Path(tmp_dir) / "migrations.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA foreign_keys = ON;")
        try:
            for _, migration_path in migrations:
                sql = migration_path.read_text(encoding="utf-8")
                try:
                    conn.executescript(sql)
                except sqlite3.DatabaseError as exc:
                    raise RuntimeError(
                        f"Failed applying migration {migration_path.name}: {exc}"
                    ) from exc
            conn.commit()
        finally:
            conn.close()


def main() -> int:
    try:
        migrations = load_migrations(MIGRATIONS_DIR)
        postgres_migrations = load_migrations(MIGRATIONS_PG_DIR)
        verify_strict_ordering(migrations)
        verify_strict_ordering(postgres_migrations)
        verify_sqlite_postgres_parity(migrations, postgres_migrations)
        verify_obvious_dialect_drift(migrations, postgres_migrations)
        apply_all_sqlite_migrations(migrations)
    except RuntimeError as exc:
        print(f"[migration-sanity] FAILED: {exc}")
        return 1

    print(
        "[migration-sanity] OK: "
        f"{len(migrations)} SQLite migrations applied; "
        f"{len(postgres_migrations)} PostgreSQL migrations checked for parity."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
