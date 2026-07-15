CREATE TABLE IF NOT EXISTS saved_messages (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_saved_messages_user_saved_at
    ON saved_messages (user_id, saved_at DESC);
