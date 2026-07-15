-- Add a long-lived "last-resort" one-time prekey flag so a user can upload one
-- key that is returned (but never deleted) once the disposable OPK pool is
-- drained. Without this, any authenticated caller could exhaust a victim's
-- one-time prekeys and force new X3DH sessions down to signed-prekey-only,
-- weakening forward secrecy for the first message of each new session.
-- Stored as INTEGER (0/1) for identical query semantics across SQLite/Postgres.
ALTER TABLE one_time_prekeys ADD COLUMN last_resort INTEGER NOT NULL DEFAULT 0;
