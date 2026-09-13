-- A bounded, per-channel message mutation feed. No deleted plaintext is archived.
-- Complete encrypted envelopes are retained only within the newest 2048 mutations;
-- clients below the explicit floor must enter recovery, never acknowledge the gap.
ALTER TABLE channels ADD COLUMN message_recovery_floor BIGINT NOT NULL DEFAULT 0 CHECK (message_recovery_floor >= 0);
ALTER TABLE channels ADD COLUMN message_recovery_start BIGINT NOT NULL DEFAULT 0 CHECK (message_recovery_start >= 0);
ALTER TABLE messages ADD COLUMN recovery_revision BIGINT NOT NULL DEFAULT 0 CHECK (recovery_revision >= 0);
CREATE TABLE message_recovery (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision > 0),
    message_id BIGINT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'update', 'delete')),
    encrypted_message TEXT,
    PRIMARY KEY (channel_id, revision)
);
CREATE INDEX idx_message_recovery_target ON message_recovery(channel_id, message_id, revision);
-- Old databases have no mutation/envelope archive. Record that boundary rather
-- than inventing history for rows which have already been edited or deleted.
UPDATE channels SET message_recovery_start = message_revision + 1,
    message_recovery_floor = message_revision + 1, message_revision = message_revision + 1
WHERE message_revision > 0 OR EXISTS (SELECT 1 FROM messages WHERE messages.channel_id = channels.id);
