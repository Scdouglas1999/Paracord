-- Bind pending attachments to uploader + channel and add pending-upload metadata.
--
-- `attachments` is rebuilt copy-and-swap rather than extended with ALTER TABLE
-- ADD COLUMN. SQLite rejects a non-constant DEFAULT on ADD COLUMN as soon as the
-- table holds any row ("Cannot add a column with non-constant default"), so the
-- ADD COLUMN form succeeded on fresh installs and hard-failed the upgrade of
-- every server that had ever stored an attachment -- the server would not start.
-- A constant default is not an option either: `attachments.rs` deliberately
-- omits `upload_created_at` from its INSERT and relies on the column default, so
-- the default has to stay `datetime('now')`.
--
-- The rebuild is safe here because `attachments` is a leaf table: no other table
-- declares a foreign key onto `attachments(id)`, so the implicit DELETE FROM
-- that `DROP TABLE` performs cannot cascade anywhere.

CREATE TABLE attachments_new (
    id                BIGINT PRIMARY KEY NOT NULL,
    message_id        BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    filename          VARCHAR(255) NOT NULL,
    content_type      VARCHAR(127),
    size              INTEGER NOT NULL,
    url               TEXT NOT NULL,
    width             INTEGER,
    height            INTEGER,
    uploader_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    upload_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    upload_created_at TEXT NOT NULL DEFAULT (datetime('now')),
    upload_expires_at TEXT
);

INSERT INTO attachments_new (id, message_id, filename, content_type, size, url, width, height)
SELECT id, message_id, filename, content_type, size, url, width, height
FROM attachments;

DROP TABLE attachments;
ALTER TABLE attachments_new RENAME TO attachments;

-- Recreate the index the dropped table carried.
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id);

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
