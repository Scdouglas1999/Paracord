CREATE TABLE IF NOT EXISTS webhook_messages (
    message_id   BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    webhook_id   BIGINT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL DEFAULT (to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_messages_webhook
    ON webhook_messages(webhook_id, created_at DESC);
