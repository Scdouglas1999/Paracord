-- Receipts keep a retried publication from restoring a consumed one-time key
-- or replacing a newer signed prekey with the bundle from an earlier request.
CREATE TABLE prekey_publication_receipts (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY (user_id, request_id)
);
