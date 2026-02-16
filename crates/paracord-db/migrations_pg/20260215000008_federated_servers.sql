-- Federation: known/linked servers and local keypair storage

CREATE TABLE IF NOT EXISTS federated_servers (
    id                      BIGINT PRIMARY KEY,
    server_name             VARCHAR(255) NOT NULL UNIQUE,
    domain                  VARCHAR(255) NOT NULL,
    federation_endpoint     TEXT NOT NULL,
    public_key_hex          TEXT,
    key_id                  VARCHAR(255),
    trusted                 BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen_at            TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_federated_servers_domain ON federated_servers(domain);

CREATE TABLE IF NOT EXISTS server_keypair (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    key_id                  VARCHAR(255) NOT NULL,
    signing_key_hex         TEXT NOT NULL,
    public_key_hex          TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
