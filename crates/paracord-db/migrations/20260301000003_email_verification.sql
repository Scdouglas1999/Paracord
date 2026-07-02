-- Add email_verified column to users (INTEGER for SQLite Any driver compat)
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Email verification tokens table
CREATE TABLE email_verification_tokens (
    token_hash      VARCHAR(64) PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_email_verification_tokens_user_id ON email_verification_tokens(user_id);
