-- Seal an uncertain edit before a replacement can be sent. Existing receipts
-- remain successful; cancellation never changes message content or history.
ALTER TABLE message_edit_receipts ADD COLUMN cancelled BOOLEAN NOT NULL DEFAULT FALSE;
