CREATE TABLE IF NOT EXISTS federation_moderation_subscriptions (
    id                  BIGINT PRIMARY KEY,
    source_server       VARCHAR(255),
    source_url          TEXT NOT NULL UNIQUE,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    last_fetch_at_ms    BIGINT,
    last_error          TEXT,
    created_at_ms       BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    updated_at_ms       BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_fed_mod_subscriptions_enabled
    ON federation_moderation_subscriptions(enabled, updated_at_ms);
