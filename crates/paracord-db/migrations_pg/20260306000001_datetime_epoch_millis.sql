-- Adopt epoch-millis (BIGINT) storage for scheduled_messages.send_at and
-- user_xp.last_xp_at, matching the i64 timestamp convention and removing the
-- need for per-engine datetime casts. Existing TIMESTAMPTZ values are converted
-- to epoch milliseconds via EXTRACT(EPOCH FROM ...) * 1000.

ALTER TABLE scheduled_messages
    ALTER COLUMN send_at TYPE BIGINT
    USING (EXTRACT(EPOCH FROM send_at) * 1000)::BIGINT;

ALTER TABLE user_xp
    ALTER COLUMN last_xp_at DROP DEFAULT;

ALTER TABLE user_xp
    ALTER COLUMN last_xp_at TYPE BIGINT
    USING (EXTRACT(EPOCH FROM last_xp_at) * 1000)::BIGINT;

ALTER TABLE user_xp
    ALTER COLUMN last_xp_at SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;
