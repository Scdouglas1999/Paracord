-- Tie-break equal-depth events and resume bounded visibility scans.
ALTER TABLE federation_room_sync_cursors ADD COLUMN last_event_id VARCHAR(255);

-- Match the history keyset order, including signed legacy depth-zero events.
CREATE INDEX idx_fed_events_room_order ON federation_events
    (room_id, (CASE WHEN depth = 0 THEN origin_ts ELSE depth END), event_id COLLATE "C");
