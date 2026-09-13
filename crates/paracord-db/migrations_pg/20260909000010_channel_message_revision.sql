-- Version channel activity independently of message IDs, which can move backwards
-- when messages are deleted. Existing channel snapshots start at revision zero.
ALTER TABLE channels ADD COLUMN message_revision BIGINT NOT NULL DEFAULT 0 CHECK (message_revision >= 0);
