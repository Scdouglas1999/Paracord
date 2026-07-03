-- Rebuild messages_fts as a standalone (self-contained) FTS5 index.
--
-- The original migration (20260301000006_forum_fts.sql) declared
--   content='messages', content_rowid='id'
-- making messages_fts an *external-content* table. That linkage assumes
-- messages.id is a true INTEGER rowid alias, but messages.id is a
-- BIGINT PRIMARY KEY, i.e. a separately indexed column that is NOT the table's
-- implicit rowid. Running the FTS5 'rebuild' command against such a mismatched
-- external-content table re-reads the source rows via the (wrong) rowid mapping
-- and would silently corrupt / desync the index.
--
-- Recreate the table as a standalone FTS5 index that owns its own copy of the
-- indexed data (no content=/content_rowid= linkage), keyed explicitly by the
-- message id stored as the FTS rowid. A future 'rebuild' is then a no-op that
-- cannot corrupt the index because there is no external content to re-read.

DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;
DROP TABLE IF EXISTS messages_fts;

CREATE VIRTUAL TABLE messages_fts USING fts5(
    content,
    channel_id UNINDEXED
);

-- Repopulate from existing messages, keyed by message id (stored as rowid).
INSERT INTO messages_fts(rowid, content, channel_id)
    SELECT id, content, channel_id FROM messages;

-- Keep the index in sync. A standalone FTS5 table owns its data, so deletes are
-- ordinary DELETEs keyed by rowid (the special 'delete' command is only needed
-- for external-content / contentless tables).
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, channel_id) VALUES (new.id, new.content, new.channel_id);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE rowid = old.id;
    INSERT INTO messages_fts(rowid, content, channel_id) VALUES (new.id, new.content, new.channel_id);
END;
