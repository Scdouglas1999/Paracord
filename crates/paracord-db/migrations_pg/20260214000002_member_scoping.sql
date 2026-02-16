-- Restore per-space member scoping (user_id + guild_id).
-- Existing server-wide member rows are expanded to all current spaces to
-- preserve effective access while removing cross-space update side effects.

CREATE TABLE members_scoped (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    nick            VARCHAR(32),
    avatar_hash     VARCHAR(64),
    joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deaf            BOOLEAN NOT NULL DEFAULT FALSE,
    mute            BOOLEAN NOT NULL DEFAULT FALSE,
    communication_disabled_until TEXT,
    PRIMARY KEY (user_id, guild_id)
);

INSERT INTO members_scoped (
    user_id,
    guild_id,
    nick,
    avatar_hash,
    joined_at,
    deaf,
    mute,
    communication_disabled_until
)
SELECT
    m.user_id,
    s.id AS guild_id,
    m.nick,
    m.avatar_hash,
    m.joined_at,
    m.deaf,
    m.mute,
    m.communication_disabled_until
FROM members m
CROSS JOIN spaces s;

DROP TABLE members;
ALTER TABLE members_scoped RENAME TO members;

CREATE INDEX IF NOT EXISTS idx_members_guild ON members(guild_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
