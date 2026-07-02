-- Channel follows: allows announcement channels to crosspost to other channels.
CREATE TABLE IF NOT EXISTS channel_follows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_channel_id BIGINT NOT NULL,
    target_channel_id BIGINT NOT NULL,
    target_guild_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_channel_id, target_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows(source_channel_id);
