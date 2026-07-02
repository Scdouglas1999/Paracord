-- Performance indexes for member search and case-insensitive email lookup.

CREATE INDEX IF NOT EXISTS idx_users_email_nocase
    ON users (email COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_users_username_nocase
    ON users (username COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_members_guild_nick_nocase
    ON members (guild_id, nick COLLATE NOCASE);
