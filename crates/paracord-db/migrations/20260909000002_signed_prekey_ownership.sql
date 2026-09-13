-- Signed-prekey IDs are chosen by each client. Two accounts may publish the
-- same ID, just as they may for disposable prekeys. Preserve all existing keys.
CREATE TABLE signed_prekeys_owned (
    id BIGINT NOT NULL,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, id),
    UNIQUE (user_id)
);
INSERT INTO signed_prekeys_owned (id, user_id, public_key, signature, created_at)
SELECT id, user_id, public_key, signature, created_at FROM signed_prekeys;
DROP TABLE signed_prekeys;
ALTER TABLE signed_prekeys_owned RENAME TO signed_prekeys;
CREATE INDEX idx_signed_prekeys_user ON signed_prekeys(user_id);
