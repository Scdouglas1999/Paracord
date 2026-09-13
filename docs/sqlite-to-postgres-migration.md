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
| `--dry-run` | off | Apply target schema migrations and their seed rows, validate column mappings and count source rows. Does not copy source rows or rotate an existing history epoch. |

## Prerequisites

- **Stop the server** and make sure nothing else is writing to the SQLite file.
  Source tables are read across separate queries without a shared snapshot
  transaction. Row counts alone cannot detect concurrent edits that preserve
  the number of rows. Keep the PostgreSQL target offline too.
- **The target should be a fresh, empty PostgreSQL database** created for this
  migration. The migrator applies the PostgreSQL migrations to the target
  itself (see below), so you do not need to migrate it beforehand — but you
  also should not point it at a database that already holds application data.
  The command upserts source primary keys; it does not remove target-only rows
  or enforce that the target is empty.
- Upgrade the source schema with a compatible server first. The command does
  not migrate the source and rejects missing application tables or source
  columns absent from the target. Target-only columns use their target defaults
  on newly inserted rows. SQLCipher-encrypted source files require a separate
  supported export; this command does not accept the source encryption key.
- The migrating role needs privileges to create the schema on the target,
  including `CREATE EXTENSION` for `pg_trgm` (see
  [postgres-pg-trgm.md](postgres-pg-trgm.md) if your managed Postgres restricts
  extension creation).

## Safety and rollback semantics

The row copy, derived-tail repair and history rotation share one transaction.
Target schema migrations happen before that transaction:

1. It opens both databases and runs the PostgreSQL migrations against the
   target. Their schema changes and seed rows remain applied even if later
   validation or copying fails. Re-running migrations preserves the database's
   existing history epoch.
2. It plans every table up front, intersecting each SQLite column with the
   target schema. If a source column has no matching target column, the
   command aborts before copying any source rows. Target schema changes from
   the first step remain applied.
3. All row copies happen inside a **single target transaction**. After copying
   each table, the migrator compares the number of rows it inserted against the
   source `COUNT(*)`. Any mismatch rolls back the row copy.
4. After all messages have copied, the same transaction replaces stale
   `channels.last_message_id` values with each channel's surviving maximum
   message ID, or NULL for an empty channel. It leaves message revisions,
   read cursors, legacy mention counts and recorded mentions unchanged.
5. It replaces the copied `server_settings.database_history_epoch` with a new
   UUID. The history identity belongs to the imported target and must differ
   from the source, even when channel revisions are lower than before.
   Failure during tail repair or history rotation rolls back all copied rows
   and both maintenance changes together.
6. On success the transaction commits and the command prints
   `Migration complete: N tables, M rows copied and verified.`

An interruption before the copy transaction commits preserves the target's
state after schema migration. If the connection is lost around commit, inspect
the target before retrying: the transaction may already have committed.

`--dry-run` performs steps 1–2 plus a source row count for every table. It can
create schema and seed settings on a fresh target. It does not copy source data,
repair imported tails, or rotate an existing epoch. It also cannot prove that
row values satisfy every target constraint; that is checked during copying.

The imported epoch is published through authenticated gateway handshakes and HTTP
headers. Current clients invalidate the restored account's captured requests and
cached projections before accepting the replacement history; same-epoch reconnects
retain their state. Requests carrying the source epoch are rejected before mutation.
See [Database history identity](api-contracts.md#database-history-identity) for the
protocol and remaining legacy-workflow limits. Stop all old instances before
cutover, reconnect clients, and verify their recovered history before reopening
writes. Persisted legacy queues still require explicit recovery; do not infer that
their operations should be resent into the imported database.

Source reads use the typed SQLite driver in read-only mode, preserving NULLs,
Boolean values and stored bytes without coercing malformed values through SQL
casts. Unsupported source values identify their table and column and abort the
copy. Unsupported target types are rejected during planning; PostgreSQL-only
derived columns are not source inputs. Temporal values normalized for native
PostgreSQL time columns retain their fractional seconds.

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
