-- Bot applications table.
-- Each application owns a bot user account and has a secret token for API access.
CREATE TABLE IF NOT EXISTS bot_applications (
    id              BIGINT PRIMARY KEY,
    name            VARCHAR(80) NOT NULL,
    description     VARCHAR(400),
    owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_user_id     BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(128) NOT NULL,
    redirect_uri    TEXT,
    permissions     BIGINT NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bot_applications_owner ON bot_applications(owner_id);
CREATE INDEX IF NOT EXISTS idx_bot_applications_bot_user ON bot_applications(bot_user_id);

-- Track which guilds a bot has been added to.
CREATE TABLE IF NOT EXISTS bot_guild_installs (
    bot_app_id      BIGINT NOT NULL REFERENCES bot_applications(id) ON DELETE CASCADE,
    guild_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    added_by        BIGINT REFERENCES users(id),
    permissions     BIGINT NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bot_app_id, guild_id)
);
