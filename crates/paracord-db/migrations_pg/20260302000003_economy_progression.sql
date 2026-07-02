CREATE TABLE IF NOT EXISTS guild_level_roles (
    guild_id    BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    level       INTEGER NOT NULL,
    role_id     BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')),
    PRIMARY KEY (guild_id, level, role_id)
);

CREATE INDEX IF NOT EXISTS idx_guild_level_roles_guild_level
    ON guild_level_roles(guild_id, level);

CREATE TABLE IF NOT EXISTS user_activity_streaks (
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id              BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    streak_days           INTEGER NOT NULL DEFAULT 0,
    longest_streak_days   INTEGER NOT NULL DEFAULT 0,
    last_active_date      TEXT NOT NULL,
    updated_at            TEXT NOT NULL DEFAULT (to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')),
    PRIMARY KEY (user_id, guild_id)
);

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id         BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    achievement_key  VARCHAR(64) NOT NULL,
    awarded_at       TEXT NOT NULL DEFAULT (to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI:SS')),
    PRIMARY KEY (user_id, guild_id, achievement_key)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_guild
    ON user_achievements(guild_id, awarded_at DESC);
