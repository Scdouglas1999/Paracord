-- Older deletion paths left activity pointing at messages that no longer exist.
-- Restore the actual surviving tail; never change any user's read cursor.
UPDATE channels
SET last_message_id = (SELECT MAX(id) FROM messages WHERE channel_id = channels.id);
