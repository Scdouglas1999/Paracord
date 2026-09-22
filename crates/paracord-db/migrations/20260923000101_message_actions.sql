-- Reminders a person sets on a message, and the attribution a forward carries.
-- Timestamps are TEXT so the Any driver can decode them on both engines.
-- created_at has no default: every insert sets it. SQLite would reject a
-- non-constant default on a later ADD COLUMN, and this table is created whole.

CREATE TABLE IF NOT EXISTS message_reminders (
    id BIGINT PRIMARY KEY NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    remind_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    fired_at TEXT,
    UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reminders_user_created
    ON message_reminders (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_message_reminders_due
    ON message_reminders (remind_at);

ALTER TABLE messages ADD COLUMN forwarded_from TEXT;
