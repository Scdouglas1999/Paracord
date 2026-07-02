-- Additional hot-path indexes validated by release query-plan smoke tests.

CREATE INDEX IF NOT EXISTS idx_bot_reviews_bot_updated
    ON bot_reviews (bot_app_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_events_status_start
    ON scheduled_events (status, scheduled_start);

CREATE INDEX IF NOT EXISTS idx_messages_channel_author_id
    ON messages (channel_id, author_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_attachments_pending_cleanup
    ON attachments (message_id, upload_expires_at);

CREATE INDEX IF NOT EXISTS idx_bot_guild_installs_guild
    ON bot_guild_installs (guild_id, bot_app_id);

CREATE INDEX IF NOT EXISTS idx_channels_parent_thread_created
    ON channels (parent_id, channel_type, created_at DESC);
