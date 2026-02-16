-- Placeholder migration for webhook token hashing.
-- The hash backfill is executed in Rust during startup migration hooks so we
-- can use SHA-256 portably even when SQLite build options vary.
SELECT 1;
