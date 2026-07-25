-- Per-space and per-channel notification settings.
--
-- Until now the only notification control was a single global blob on
-- user_settings, so a member of a busy space had no way to quiet one noisy
-- channel without leaving. Every comparable product treats per-scope muting as
-- table stakes.
--
-- Two tables rather than one polymorphic (scope_type, scope_id) table so that
-- both scopes carry a real foreign key: deleting a space or a channel then
-- removes its settings by cascade instead of leaving orphan rows keyed to an id
-- that no longer resolves.
--
-- `level` is the notification level, resolved channel -> space -> default:
--   0 = all messages, 1 = only mentions, 2 = nothing.
-- `muted_until` is TEXT on both engines (house convention: the sqlx `Any`
-- driver cannot decode a native PostgreSQL timestamp, and one such column fails
-- the entire row). NULL means "muted indefinitely" when muted is set.

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

-- The gateway loads every setting for one user on connect, so both tables are
-- read by user_id. The primary keys lead with user_id and already serve that.
CREATE INDEX IF NOT EXISTS idx_space_notification_settings_space
    ON space_notification_settings(space_id);
CREATE INDEX IF NOT EXISTS idx_channel_notification_settings_channel
    ON channel_notification_settings(channel_id);
