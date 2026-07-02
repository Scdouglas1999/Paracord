-- Channel follows: allows announcement channels to crosspost to other channels.
CREATE TABLE IF NOT EXISTS channel_follows (
    id BIGSERIAL PRIMARY KEY,
    source_channel_id BIGINT NOT NULL,
    target_channel_id BIGINT NOT NULL,
    target_guild_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_channel_id, target_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows(source_channel_id);
