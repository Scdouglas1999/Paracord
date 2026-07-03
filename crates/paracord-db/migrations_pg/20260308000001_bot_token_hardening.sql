-- Bot-token hardening: revocation flag + last-used tracking.
-- `revoked` lets an operator invalidate a leaked token without deleting the
-- application; `last_used_at` records the most recent successful bot-auth.
ALTER TABLE bot_applications ADD COLUMN revoked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bot_applications ADD COLUMN last_used_at TEXT;
