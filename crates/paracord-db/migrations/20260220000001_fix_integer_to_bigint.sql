-- Fix columns that incorrectly used INTEGER instead of BIGINT for Snowflake IDs.
-- SQLx's Any driver maps INTEGER → i32 which overflows on Snowflake values.
-- All entity IDs and foreign keys referencing Snowflake PKs must be BIGINT.

-- ============================================================
-- 1. channels.owner_id  (added by 20260216000001_threads.sql)
-- ============================================================
ALTER TABLE channels RENAME COLUMN owner_id TO owner_id_old;
ALTER TABLE channels ADD COLUMN owner_id BIGINT;
UPDATE channels SET owner_id = owner_id_old;
ALTER TABLE channels DROP COLUMN owner_id_old;

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
    created_at  DATETIME NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
INSERT INTO forum_tags_new SELECT id, channel_id, name, emoji, moderated, position, created_at FROM forum_tags;
DROP TABLE forum_tags;
ALTER TABLE forum_tags_new RENAME TO forum_tags;
CREATE INDEX IF NOT EXISTS idx_forum_tags_channel ON forum_tags(channel_id);

-- ============================================================
-- 3. polls  (created by 20260216000002_polls.sql)
-- ============================================================
-- Must drop dependents first (poll_votes → poll_options → polls)
DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_options;

CREATE TABLE polls_new (
    id                BIGINT PRIMARY KEY,
    message_id        BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id        BIGINT NOT NULL,
    question          TEXT NOT NULL,
    allow_multiselect INTEGER NOT NULL DEFAULT 0,
    expires_at        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO polls_new SELECT id, message_id, channel_id, question, allow_multiselect, expires_at, created_at FROM polls;
DROP TABLE polls;
ALTER TABLE polls_new RENAME TO polls;

CREATE TABLE poll_options (
    id       BIGINT PRIMARY KEY,
    poll_id  BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    emoji    TEXT,
    position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE poll_votes (
    poll_id    BIGINT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    option_id  BIGINT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, option_id, user_id)
);

-- ============================================================
-- 4. scheduled_events + event_rsvps  (20260216000005)
-- ============================================================
DROP TABLE IF EXISTS event_rsvps;

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
INSERT INTO scheduled_events_new
    SELECT id, guild_id, channel_id, creator_id, name, description,
           scheduled_start, scheduled_end, status, entity_type, location,
           image_url, created_at
    FROM scheduled_events;
DROP TABLE scheduled_events;
ALTER TABLE scheduled_events_new RENAME TO scheduled_events;

CREATE TABLE event_rsvps (
    event_id   BIGINT NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id),
    status     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_id, user_id)
);

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
INSERT INTO signed_prekeys_new SELECT id, user_id, public_key, signature, created_at FROM signed_prekeys;
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
INSERT INTO one_time_prekeys_new SELECT id, user_id, public_key, created_at FROM one_time_prekeys;
DROP TABLE one_time_prekeys;
ALTER TABLE one_time_prekeys_new RENAME TO one_time_prekeys;
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON one_time_prekeys(user_id);
