-- Index: server hue and when each voice member joined.
--
-- spaces.hue: the server's color as a hue, 0-359, chosen in Server settings ›
-- Overview. NULL means unset; clients then derive a hue from the server id.
-- The CHECK keeps the stored value inside the color wheel on both engines.
--
-- voice_states.joined_at: when the member entered their current channel, so
-- clients can show "live 12 min" on a room (the room's start is the earliest
-- joined_at among its current members). TEXT holding `YYYY-MM-DD HH:MM:SS`
-- UTC on both engines (sqlx Any cannot decode a native timestamp). Set on every
-- join and listen join; a move to another channel resets it.
--
-- (The same statements as the SQLite file; `datetime()` is the compatibility shim
-- from 20260208000000_sqlite_compat on PostgreSQL.)
--
-- SQLite cannot ADD COLUMN with a non-constant default on a populated table, so
-- joined_at is added empty and existing rows are backfilled to now. Voice
-- states are short-lived (they are cleared on every server start), so the
-- migration time is the closest honest bound for a call already in progress.

ALTER TABLE spaces
ADD COLUMN hue INTEGER NULL CHECK (hue IS NULL OR (hue >= 0 AND hue <= 359));

ALTER TABLE voice_states
ADD COLUMN joined_at TEXT NULL;

UPDATE voice_states
SET joined_at = datetime('now')
WHERE joined_at IS NULL;
