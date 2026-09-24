-- Soundboard: short sounds anyone in a voice channel can play for everyone
-- in it (feature program round 2, "together"). Assets live in the storage
-- backend keyed by `asset_key`, same convention as stickers.

CREATE TABLE IF NOT EXISTS soundboard_sounds (
    id          BIGINT PRIMARY KEY,
    guild_id    BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Unicode emoji or a <:name:id> custom-emoji token; NULL/empty means the
    -- tile draws the generic speaker mark.
    emoji       TEXT,
    -- 0..100 percent, applied client-side on top of the listener's own
    -- soundboard volume.
    volume      INTEGER NOT NULL DEFAULT 100,
    duration_ms INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    size        INTEGER NOT NULL,
    asset_key   TEXT NOT NULL,
    creator_id  BIGINT REFERENCES users(id),
    -- TEXT timestamp on both engines (the PG `datetime()` compat shim from
    -- 20260208000000_sqlite_compat.sql supplies the default).
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_soundboard_sounds_guild
    ON soundboard_sounds (guild_id, created_at DESC);

-- Grant USE_SOUNDBOARD (1 << 42 = 4,398,046,511,104) to every existing default
-- "Member" role (id = space_id). `Permissions::default()` covers guilds created
-- after this migration, but the baseline bitmask was persisted at creation
-- time, so pre-existing spaces need it OR'd in here — same pattern as
-- 20260705000001_default_role_member_permissions.sql.
UPDATE roles
SET permissions = permissions | 4398046511104
WHERE id = space_id
  AND (permissions | 4398046511104) != permissions;
