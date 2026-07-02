CREATE TABLE IF NOT EXISTS scheduled_messages (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    e2ee_payload TEXT,
    nonce TEXT,
    send_at TEXT NOT NULL,
    delivered_message_id BIGINT REFERENCES messages(id),
    status SMALLINT NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
    ON scheduled_messages (status, send_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_channel
    ON scheduled_messages (channel_id, send_at);

