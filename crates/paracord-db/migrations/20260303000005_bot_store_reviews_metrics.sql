CREATE TABLE IF NOT EXISTS bot_reviews (
    id BIGINT PRIMARY KEY,
    bot_app_id BIGINT NOT NULL REFERENCES bot_applications(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL,
    title TEXT,
    body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (bot_app_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_reviews_bot
    ON bot_reviews (bot_app_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_metric_events (
    id BIGINT PRIMARY KEY,
    bot_app_id BIGINT NOT NULL REFERENCES bot_applications(id) ON DELETE CASCADE,
    guild_id BIGINT REFERENCES spaces(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bot_metric_events_bot_created
    ON bot_metric_events (bot_app_id, created_at DESC);
