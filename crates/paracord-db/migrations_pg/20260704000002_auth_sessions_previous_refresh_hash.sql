ALTER TABLE auth_sessions ADD COLUMN previous_refresh_token_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_previous_refresh_hash
    ON auth_sessions (previous_refresh_token_hash)
    WHERE previous_refresh_token_hash IS NOT NULL;
