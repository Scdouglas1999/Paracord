-- Password reset tokens for self-service password recovery
CREATE TABLE password_reset_tokens (
    token_hash      VARCHAR(64) PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at      TEXT NOT NULL,
    used_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_password_reset_tokens_user_id ON password_reset_tokens(user_id);
