-- SQLite: no-op. This corrects PostgreSQL column defaults that overflow int4.
--
-- SQLite's INTEGER is 64-bit, so
--     CAST(strftime('%s', 'now') AS INTEGER) * 1000
-- is exact here; only the PostgreSQL track needs the corrected cast. See
-- migrations_pg/20260726000001_federation_epoch_default_overflow.sql.
SELECT 1;
