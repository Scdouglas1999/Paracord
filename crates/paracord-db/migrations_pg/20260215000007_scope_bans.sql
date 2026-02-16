-- Restore guild/space scoping for bans.
-- The previous schema flattened bans to server-wide (user_id only).
-- To preserve existing behavior during migration, expand each existing ban
-- across all currently known spaces.

CREATE TABLE bans_scoped (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id     BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    reason       VARCHAR(512),
    banned_by    BIGINT REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, guild_id)
);

INSERT INTO bans_scoped (user_id, guild_id, reason, banned_by, created_at)
SELECT
    b.user_id,
    s.id AS guild_id,
    b.reason,
    b.banned_by,
    b.created_at
FROM bans b
CROSS JOIN spaces s
ON CONFLICT DO NOTHING;

DROP TABLE bans;
ALTER TABLE bans_scoped RENAME TO bans;

CREATE INDEX IF NOT EXISTS idx_bans_guild ON bans(guild_id);
