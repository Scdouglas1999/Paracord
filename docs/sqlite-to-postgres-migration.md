# SQLite → PostgreSQL Migration

Paracord runs on either SQLite (single-file, zero-ops) or PostgreSQL (for
larger / multi-instance deployments). When a server outgrows SQLite, the
`migrate-to-postgres` subcommand copies an existing SQLite database into a
PostgreSQL database in one pass.

## Invocation

```bash
paracord-server migrate-to-postgres \
    --source sqlite://./data/paracord.db \
    --target postgres://user:pass@db-host:5432/paracord
```

The command does **not** start the chat server; it runs the migration and
exits, printing a per-table report of the rows it copied.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--source <URL>` | *(required)* | Source SQLite URL (`sqlite://…`). Must be a SQLite URL or the command refuses to run. |
| `--target <URL>` | *(required)* | Target PostgreSQL URL (`postgres://…`). Must be a PostgreSQL URL. |
| `--batch-size <N>` | `1000` | Rows read per page while streaming each table. Lower it to cap memory on very wide tables; raise it to reduce round-trips. |
| `--dry-run` | off | Migrate the target schema and validate every column mapping and row count **without writing any data**. Use this first to confirm the schemas line up. |

## Prerequisites

- **Stop the server** and make sure nothing else is writing to the SQLite file.
  The migrator reads a point-in-time snapshot; concurrent writes are not
  captured and can corrupt the row-count verification.
- **The target should be a fresh, empty PostgreSQL database** created for this
  migration. The migrator applies the PostgreSQL migrations to the target
  itself (see below), so you do not need to migrate it beforehand — but you
  also should not point it at a database that already holds application data.
- The migrating role needs privileges to create the schema on the target,
  including `CREATE EXTENSION` for `pg_trgm` (see
  [postgres-pg-trgm.md](postgres-pg-trgm.md) if your managed Postgres restricts
  extension creation).

## Safety and rollback semantics

The migrator is designed to be **all-or-nothing**:

1. It opens both databases and runs the PostgreSQL migrations against the
   target (idempotent — safe to run against an already-migrated schema).
2. It plans every table up front, intersecting each SQLite column with the
   target schema. If a source column has no matching target column, the
   migration **aborts before writing anything** rather than silently dropping
   data — this catches schema drift.
3. All row copies happen inside a **single target transaction**. After copying
   each table, the migrator compares the number of rows it inserted against the
   source `COUNT(*)`. Any mismatch **rolls the entire transaction back**, so on
   failure the target is left exactly as it was.
4. On success the transaction commits and the command prints
   `Migration complete: N tables, M rows copied and verified.`

Because the whole copy is one transaction, an interruption (crash, `Ctrl-C`,
lost connection) leaves the target untouched — just re-run the command.

`--dry-run` performs steps 1–2 plus a source row count for every table, but
writes nothing. It is the recommended first step before a real migration.

## Table-order guarantee

Tables are copied in a fixed, foreign-key-safe order
(`MIGRATION_TABLE_ORDER` in `crates/paracord-db/src/migrate_export.rs`): a table
only appears after every table it has a foreign key into, so PostgreSQL's
immediate foreign-key checks are always satisfied at insert time. A unit test
(`migration_table_order_matches_schema`) fails CI whenever a new table is added
to the migrations but not to this list, keeping the order authoritative.

Within each table, rows are streamed in **ascending primary-key order**. Because
Paracord primary keys are Snowflake IDs (monotonic with creation time), a
self-referential foreign key (e.g. `channels.parent_id`, `messages.reference_id`)
always points at a row with a smaller id that has therefore already been
inserted.

### Tables that are intentionally not copied

The following live in SQLite but are never copied, because they are bookkeeping
or derived state that PostgreSQL rebuilds on its own:

- `_sqlx_migrations` — migration bookkeeping (the target maintains its own).
- `sqlite_sequence` — a SQLite internal.
- `messages_fts` / `messages_fts_*` — SQLite FTS5 shadow tables. PostgreSQL
  maintains full-text search through a `tsvector` trigger instead, so this
  search state is regenerated automatically as rows are inserted.

## After migrating

Point the server at the PostgreSQL database (set `database.url` /
`database.engine` in `config/paracord.toml`) and start it. Keep the original
SQLite file as a backup until you have verified the PostgreSQL deployment.
