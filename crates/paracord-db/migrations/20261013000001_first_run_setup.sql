-- First-run setup (docs/setup-spec.md §3.4, §8.2, §9.3).
--
-- One password: the credential's version and KDF inputs, the server-held
-- wrapped identity, and the link-preview setting. Constant defaults only
-- (SQLite cannot ADD COLUMN with a non-constant default on a populated table).
--
-- users.credential_version: 0 key-only (no usable password), 1 legacy password
-- (Argon2id of the password itself), 2 one password (Argon2id of the derived
-- auth key). It only ever increases; every write is conditional on the old
-- value (paracord-db/src/credentials.rs).
--
-- Key-only accounts are stored with an empty or sentinel password_hash
-- ('' for public-key sign-ups and system users, '!federated!', '!deleted!'),
-- never NULL (the column is NOT NULL), so every hash that is not an Argon2 PHC
-- string marks a key-only account.
ALTER TABLE users ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 1
    CHECK (credential_version IN (0, 1, 2));
ALTER TABLE users ADD COLUMN credential_salt TEXT NULL;
ALTER TABLE users ADD COLUMN credential_kdf TEXT NULL;
ALTER TABLE users ADD COLUMN credential_epoch INTEGER NOT NULL DEFAULT 0;
UPDATE users SET credential_version = 0
    WHERE password_hash IS NULL OR password_hash NOT LIKE '$argon2%';

-- The identity private key wrapped under the password-derived wrap key, so a
-- new device signs in with username + password and gets its identity back.
-- created_at/updated_at are TEXT 'YYYY-MM-DD HH:MM:SS' UTC (Any-pool rule).
CREATE TABLE IF NOT EXISTS account_key_backups (
    user_id            BIGINT  PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    public_key         TEXT    NOT NULL,
    wrapped_key        TEXT    NOT NULL,
    wrap_alg           TEXT    NOT NULL,
    credential_epoch   INTEGER NOT NULL,
    recovery_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL
);

-- Whether links this person posts are unfurled, and whether they see previews.
ALTER TABLE user_settings ADD COLUMN link_previews BOOLEAN NOT NULL DEFAULT TRUE;
