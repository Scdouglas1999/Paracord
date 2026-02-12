-- Add public_key column for Ed25519 challenge-response auth
ALTER TABLE users ADD COLUMN public_key VARCHAR(64);
CREATE UNIQUE INDEX idx_users_public_key ON users(public_key) WHERE public_key IS NOT NULL;

-- Make email and password_hash nullable for pubkey-only accounts
-- SQLite doesn't support ALTER COLUMN, so we need to handle this at the application level
-- (existing accounts keep email/password, new pubkey accounts set them to placeholder values)
