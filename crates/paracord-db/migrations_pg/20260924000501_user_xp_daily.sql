-- XP earned per member per UTC day. `user_xp` keeps only the running total,
-- so a window like "this week" needs the gains broken out by day. `day` is a
-- 'YYYY-MM-DD' TEXT key, the same style as
-- user_activity_streaks.last_active_date. Nothing is backfilled: the window
-- fills from the first award after this table exists.

CREATE TABLE IF NOT EXISTS user_xp_daily (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id    BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    xp          BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, guild_id, day)
);

CREATE INDEX IF NOT EXISTS idx_user_xp_daily_guild_day
    ON user_xp_daily(guild_id, day);
