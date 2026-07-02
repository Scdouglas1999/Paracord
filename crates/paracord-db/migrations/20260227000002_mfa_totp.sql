-- MFA TOTP secrets and backup codes
CREATE TABLE mfa_configs (
    user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    totp_secret     VARCHAR(255) NOT NULL,
    enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mfa_backup_codes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash       VARCHAR(64) NOT NULL,
    used_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_mfa_backup_codes_user_id ON mfa_backup_codes(user_id);
