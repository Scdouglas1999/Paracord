ALTER TABLE scheduled_events ADD COLUMN recurrence_rule TEXT;
ALTER TABLE scheduled_events ADD COLUMN reminder_minutes INTEGER;
ALTER TABLE scheduled_events ADD COLUMN event_channel_id BIGINT REFERENCES channels(id);
ALTER TABLE scheduled_events ADD COLUMN event_channel_created BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE scheduled_events ADD COLUMN reminder_sent_at TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduled_events_start
    ON scheduled_events (scheduled_start);

