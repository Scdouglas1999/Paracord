-- Performance indexes for member search and case-insensitive email lookup.

CREATE INDEX IF NOT EXISTS idx_users_email_lower
    ON users (lower(email));

CREATE INDEX IF NOT EXISTS idx_users_username_lower_prefix
    ON users (lower(username) text_pattern_ops);

CREATE INDEX IF NOT EXISTS idx_members_guild_lower_nick_prefix
    ON members (guild_id, lower(COALESCE(nick, '')) text_pattern_ops);
