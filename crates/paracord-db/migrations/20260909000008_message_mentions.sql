-- Mention recipients are captured at delivery, so later role changes cannot
-- rewrite who a message notified. Existing aggregate counts remain legacy data.
CREATE TABLE message_mentions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_unread ON message_mentions(user_id, channel_id, message_id);
