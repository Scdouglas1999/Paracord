-- Successful edits retain their identity independently of message lifetime.
-- A retry must not overwrite a newer edit or create another history entry.
CREATE TABLE message_edit_receipts (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    edit_nonce TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    request_hash TEXT NOT NULL,
    PRIMARY KEY (channel_id, actor_id, edit_nonce)
);
