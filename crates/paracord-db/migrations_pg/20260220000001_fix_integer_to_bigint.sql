-- Fix columns that incorrectly used INTEGER instead of BIGINT for Snowflake IDs.
-- PostgreSQL INTEGER is int4 and overflows on Snowflake values.
-- All Snowflake IDs and foreign keys referencing Snowflake IDs must be BIGINT.

BEGIN;

-- ============================================================
-- 1. channels.owner_id  (added by 20260216000001_threads.sql)
-- ============================================================
ALTER TABLE channels
    ALTER COLUMN owner_id TYPE BIGINT USING owner_id::BIGINT;

-- ============================================================
-- 2. forum_tags  (created by 20260216000004_forum_channels.sql)
-- ============================================================
CREATE TABLE forum_tags_new (
    id          BIGINT PRIMARY KEY NOT NULL,
    channel_id  BIGINT NOT NULL,
    name        TEXT NOT NULL,
    emoji       TEXT,
    moderated   INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

INSERT INTO forum_tags_new (id, channel_id, name, emoji, moderated, position, created_at)
SELECT id, channel_id, name, emoji, moderated, position, created_at
FROM forum_tags;

DROP TABLE forum_tags;
ALTER TABLE forum_tags_new RENAME TO forum_tags;
CREATE INDEX IF NOT EXISTS idx_forum_tags_channel ON forum_tags(channel_id);

-- ============================================================
-- 3. polls + poll_options + poll_votes  (20260216000002)
-- ============================================================
CREATE TABLE polls_new (
    id                BIGINT PRIMARY KEY,
    message_id        BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id        BIGINT NOT NULL,
    question          TEXT NOT NULL,
    allow_multiselect INTEGER NOT NULL DEFAULT 0,
    expires_at        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO polls_new (id, message_id, channel_id, question, allow_multiselect, expires_at, created_at)
SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at
FROM polls;

CREATE TABLE poll_options_new (
    id       BIGINT PRIMARY KEY,
    poll_id  BIGINT NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    emoji    TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

INSERT INTO poll_options_new (id, poll_id, text, emoji, position)
SELECT id, poll_id, text, emoji, position
FROM poll_options;

CREATE TABLE poll_votes_new (
    poll_id    BIGINT NOT NULL REFERENCES polls_new(id) ON DELETE CASCADE,
    option_id  BIGINT NOT NULL REFERENCES poll_options_new(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, option_id, user_id)
);

INSERT INTO poll_votes_new (poll_id, option_id, user_id, created_at)
SELECT poll_id, option_id, user_id, created_at
FROM poll_votes;

DROP TABLE poll_votes;
DROP TABLE poll_options;
DROP TABLE polls;

ALTER TABLE polls_new RENAME TO polls;
ALTER TABLE poll_options_new RENAME TO poll_options;
ALTER TABLE poll_votes_new RENAME TO poll_votes;

-- ============================================================
-- 4. scheduled_events + event_rsvps  (20260216000005)
-- ============================================================
CREATE TABLE scheduled_events_new (
    id              BIGINT PRIMARY KEY,
    guild_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id      BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    creator_id      BIGINT NOT NULL REFERENCES users(id),
    name            TEXT NOT NULL,
    description     TEXT,
    scheduled_start TEXT NOT NULL,
    scheduled_end   TEXT,
    status          INTEGER NOT NULL DEFAULT 1,
    entity_type     INTEGER NOT NULL DEFAULT 1,
    location        TEXT,
    image_url       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO scheduled_events_new (
    id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end,
    status, entity_type, location, image_url, created_at
)
SELECT
    id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end,
    status, entity_type, location, image_url, created_at
FROM scheduled_events;

CREATE TABLE event_rsvps_new (
    event_id   BIGINT NOT NULL REFERENCES scheduled_events_new(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    status     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_id, user_id)
);

INSERT INTO event_rsvps_new (event_id, user_id, status, created_at)
SELECT event_id, user_id, status, created_at
FROM event_rsvps;

DROP TABLE event_rsvps;
DROP TABLE scheduled_events;

ALTER TABLE scheduled_events_new RENAME TO scheduled_events;
ALTER TABLE event_rsvps_new RENAME TO event_rsvps;

-- ============================================================
-- 5. signed_prekeys + one_time_prekeys  (20260217000002)
-- ============================================================
CREATE TABLE signed_prekeys_new (
    id         BIGINT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    signature  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id)
);

INSERT INTO signed_prekeys_new (id, user_id, public_key, signature, created_at)
SELECT id, user_id, public_key, signature, created_at
FROM signed_prekeys;

DROP TABLE signed_prekeys;
ALTER TABLE signed_prekeys_new RENAME TO signed_prekeys;
CREATE INDEX IF NOT EXISTS idx_signed_prekeys_user ON signed_prekeys(user_id);

CREATE TABLE one_time_prekeys_new (
    id         BIGINT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, id)
);

INSERT INTO one_time_prekeys_new (id, user_id, public_key, created_at)
SELECT id, user_id, public_key, created_at
FROM one_time_prekeys;

DROP TABLE one_time_prekeys;
ALTER TABLE one_time_prekeys_new RENAME TO one_time_prekeys;
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON one_time_prekeys(user_id);

COMMIT;
