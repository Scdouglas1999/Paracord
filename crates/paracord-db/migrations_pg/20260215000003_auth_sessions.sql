-- Session-backed auth with refresh-token rotation and revocation support.

CREATE TABLE IF NOT EXISTS auth_sessions (
    id                  TEXT PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash  TEXT NOT NULL UNIQUE,
    current_jti         TEXT NOT NULL,
    pub_key             TEXT,
    device_id           TEXT,
    user_agent          TEXT,
    ip_address          TEXT,
    issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at          TEXT NOT NULL,
    revoked_at          TEXT,
    revoked_reason      TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
    ON auth_sessions (user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
    ON auth_sessions (expires_at);
