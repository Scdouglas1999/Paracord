-- FTS5 virtual table for message full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    channel_id UNINDEXED,
    content='messages',
    content_rowid='id'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content, channel_id) VALUES (new.id, new.content, new.channel_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, channel_id) VALUES ('delete', old.id, old.content, old.channel_id);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content, channel_id) VALUES ('delete', old.id, old.content, old.channel_id);
    INSERT INTO messages_fts(rowid, content, channel_id) VALUES (new.id, new.content, new.channel_id);
END;
