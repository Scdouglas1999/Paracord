CREATE TABLE IF NOT EXISTS signed_prekeys (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key  TEXT NOT NULL,
    signature   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS one_time_prekeys (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, id)
);

CREATE INDEX IF NOT EXISTS idx_signed_prekeys_user ON signed_prekeys(user_id);
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON one_time_prekeys(user_id);

ALTER TABLE messages ADD COLUMN e2ee_header TEXT DEFAULT NULL;
