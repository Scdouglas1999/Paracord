CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    window_seconds INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_updated_at
    ON rate_limit_counters (updated_at);

CREATE TABLE IF NOT EXISTS auth_guard_state (
    guard_key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_guard_state_last_seen
    ON auth_guard_state (last_seen);
