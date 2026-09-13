-- Successful deletion is observable after the message itself is gone. The
-- receipt belongs to the authorized actor and cannot be reused for a new target.
CREATE TABLE message_delete_receipts (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delete_nonce TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    PRIMARY KEY (channel_id, actor_id, delete_nonce)
);
