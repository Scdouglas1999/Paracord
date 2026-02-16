-- Thread support: add thread metadata columns to channels table
ALTER TABLE channels ADD COLUMN thread_metadata TEXT;
ALTER TABLE channels ADD COLUMN owner_id INTEGER;
ALTER TABLE channels ADD COLUMN message_count INTEGER DEFAULT 0;
