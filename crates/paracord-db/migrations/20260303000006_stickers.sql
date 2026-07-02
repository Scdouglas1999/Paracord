CREATE TABLE IF NOT EXISTS stickers (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    format_type SMALLINT NOT NULL DEFAULT 1,
    creator_id BIGINT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stickers_guild
    ON stickers (guild_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_stickers (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    sticker_id BIGINT NOT NULL REFERENCES stickers(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, sticker_id)
);
