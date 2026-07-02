CREATE TABLE IF NOT EXISTS group_e2ee_sender_keys (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    ciphertext TEXT NOT NULL,
    header TEXT,
    acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_group_e2ee_sender_keys_recipient
    ON group_e2ee_sender_keys (channel_id, recipient_id, acknowledged, epoch);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_e2ee_sender_keys_unique
    ON group_e2ee_sender_keys (channel_id, sender_id, recipient_id, epoch);

