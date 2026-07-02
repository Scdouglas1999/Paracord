CREATE TABLE IF NOT EXISTS channel_feature_settings (
    channel_id BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    disappearing_seconds INTEGER NOT NULL DEFAULT 0,
    anonymous_posting_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    slowmode_exempt_role_ids TEXT NOT NULL DEFAULT '[]',
    adaptive_slowmode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    adaptive_slowmode_window_seconds INTEGER NOT NULL DEFAULT 30,
    adaptive_slowmode_threshold INTEGER NOT NULL DEFAULT 20,
    adaptive_slowmode_step_seconds INTEGER NOT NULL DEFAULT 5,
    thread_rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

