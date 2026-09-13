-- The message payload nonce is a DM cipher IV and may change on edit. Delivery
-- identity must stay immutable and survive deletion, so a lost create response
-- can never cause an edited/deleted message to be recreated by a replay.
ALTER TABLE messages ADD COLUMN delivery_nonce TEXT;
UPDATE messages SET delivery_nonce = nonce WHERE nonce IS NOT NULL AND nonce <> '';

CREATE TABLE message_delivery_receipts (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nonce TEXT NOT NULL,
    message_id BIGINT NOT NULL,
    PRIMARY KEY (channel_id, author_id, nonce)
);
INSERT INTO message_delivery_receipts (channel_id, author_id, nonce, message_id)
SELECT channel_id, author_id, delivery_nonce, id FROM messages WHERE delivery_nonce IS NOT NULL;

DROP INDEX idx_messages_nonce_dedup_unique;
