-- Per-space and per-channel notification settings (PostgreSQL).
--
-- Mirrors migrations/20260728000001_notification_settings.sql. See that file
-- for the design rationale; the schema is identical apart from PostgreSQL
-- spellings.
--
-- `muted_until` is TEXT here deliberately, not TIMESTAMPTZ: the sqlx `Any`
-- driver cannot decode a native PostgreSQL temporal type, and because AnyRow
-- converts every column, one such column fails the whole row.

CREATE TABLE IF NOT EXISTS space_notification_settings (
    user_id           BIGINT  NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    space_id          BIGINT  NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    level             SMALLINT NOT NULL DEFAULT 0,
    muted             BOOLEAN  NOT NULL DEFAULT FALSE,
    muted_until       TEXT,
    suppress_everyone BOOLEAN  NOT NULL DEFAULT FALSE,
    updated_at        TEXT     NOT NULL DEFAULT '1970-01-01 00:00:00',
    PRIMARY KEY (user_id, space_id)
);

CREATE TABLE IF NOT EXISTS channel_notification_settings (
    user_id           BIGINT  NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id        BIGINT  NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    level             SMALLINT NOT NULL DEFAULT 0,
    muted             BOOLEAN  NOT NULL DEFAULT FALSE,
    muted_until       TEXT,
    suppress_everyone BOOLEAN  NOT NULL DEFAULT FALSE,
    updated_at        TEXT     NOT NULL DEFAULT '1970-01-01 00:00:00',
    PRIMARY KEY (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_space_notification_settings_space
    ON space_notification_settings(space_id);
CREATE INDEX IF NOT EXISTS idx_channel_notification_settings_channel
    ON channel_notification_settings(channel_id);
