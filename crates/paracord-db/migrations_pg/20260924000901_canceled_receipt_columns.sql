-- American spelling for the receipt tables' flag. RENAME COLUMN keeps the data
-- and works on both engines (SQLite 3.25+).
ALTER TABLE message_delivery_receipts RENAME COLUMN cancelled TO canceled;
ALTER TABLE message_edit_receipts RENAME COLUMN cancelled TO canceled;
