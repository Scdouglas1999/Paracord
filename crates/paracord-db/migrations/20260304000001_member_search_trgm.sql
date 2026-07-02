-- SQLite: no-op. Trigram indexing is PostgreSQL-only.
-- The existing COLLATE NOCASE LIKE pattern on username/nick is sufficient for SQLite.
SELECT 1;
