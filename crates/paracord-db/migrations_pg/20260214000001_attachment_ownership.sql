-- Bind pending attachments to uploader + channel and add pending-upload metadata.

ALTER TABLE attachments
    ADD COLUMN uploader_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE attachments
    ADD COLUMN upload_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL;

ALTER TABLE attachments
    ADD COLUMN upload_created_at TEXT NOT NULL DEFAULT (datetime('now'));

ALTER TABLE attachments
    ADD COLUMN upload_expires_at TEXT;

-- Backfill linked attachments so authorization checks remain valid.
UPDATE attachments
SET uploader_id = (
        SELECT author_id
        FROM messages
        WHERE messages.id = attachments.message_id
    ),
    upload_channel_id = (
        SELECT channel_id
        FROM messages
        WHERE messages.id = attachments.message_id
    )
WHERE message_id IS NOT NULL;

-- Existing pending attachments expire shortly after migration.
UPDATE attachments
SET upload_expires_at = datetime(upload_created_at, '+15 minutes')
WHERE message_id IS NULL
  AND upload_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attachments_pending_owner
    ON attachments (uploader_id, upload_channel_id, message_id);

CREATE INDEX IF NOT EXISTS idx_attachments_pending_expiry
    ON attachments (upload_expires_at);
