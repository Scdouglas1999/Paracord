-- Adopt epoch-millis (INTEGER) storage for scheduled_messages.send_at and
-- user_xp.last_xp_at, matching the i64 timestamp convention and removing the
-- need for per-engine datetime casts. SQLite cannot change a column's type in
-- place, so the affected tables are rebuilt. Existing TEXT timestamps are
-- converted to epoch milliseconds via strftime('%s', ...).

CREATE TABLE scheduled_messages_new (
    id BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT,
    e2ee_payload TEXT,
    nonce TEXT,
    send_at INTEGER NOT NULL,
    delivered_message_id BIGINT REFERENCES messages(id),
    status SMALLINT NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scheduled_messages_new
    (id, channel_id, author_id, content, e2ee_payload, nonce, send_at,
     delivered_message_id, status, error, created_at, updated_at)
SELECT id, channel_id, author_id, content, e2ee_payload, nonce,
       CAST(strftime('%s', send_at) AS INTEGER) * 1000,
       delivered_message_id, status, error, created_at, updated_at
FROM scheduled_messages;

DROP TABLE scheduled_messages;
ALTER TABLE scheduled_messages_new RENAME TO scheduled_messages;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
    ON scheduled_messages (status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_channel
    ON scheduled_messages (channel_id, send_at);

CREATE TABLE user_xp_new (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id    BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    xp          BIGINT NOT NULL DEFAULT 0,
    level       INTEGER NOT NULL DEFAULT 0,
    last_xp_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    PRIMARY KEY (user_id, guild_id)
);

INSERT INTO user_xp_new (user_id, guild_id, xp, level, last_xp_at)
SELECT user_id, guild_id, xp, level,
       CAST(strftime('%s', last_xp_at) AS INTEGER) * 1000
FROM user_xp;

DROP TABLE user_xp;
ALTER TABLE user_xp_new RENAME TO user_xp;
