-- Forum channels: tag support for forum-type channels
-- Forum posts reuse threads (channel_type=6 under a forum parent channel_type=7)

CREATE TABLE IF NOT EXISTS forum_tags (
    id INTEGER PRIMARY KEY NOT NULL,
    channel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    emoji TEXT,
    moderated INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_forum_tags_channel ON forum_tags(channel_id);

-- Add applied_tags column to channels for threads/posts to store their tag IDs as JSON
ALTER TABLE channels ADD COLUMN applied_tags TEXT DEFAULT '[]';

-- Add default_sort_order to channels for forum channels (0 = latest activity, 1 = creation date)
ALTER TABLE channels ADD COLUMN default_sort_order INTEGER DEFAULT 0;
