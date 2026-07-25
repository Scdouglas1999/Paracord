-- SQLite: no-op. This converts PostgreSQL's native TIMESTAMP / TIMESTAMPTZ
-- columns to TEXT so both engines store the same `YYYY-MM-DD HH24:MI:SS` UTC
-- representation that sqlx's `Any` driver can actually decode.
--
-- SQLite already stores these columns as TEXT (its `DATETIME` / `TIMESTAMP`
-- declarations carry TEXT affinity), so there is nothing to change here. See
-- migrations_pg/20260726000002_pg_text_timestamps.sql.
SELECT 1;
