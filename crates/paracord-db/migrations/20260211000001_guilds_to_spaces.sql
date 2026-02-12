-- Migration: Rename guilds to spaces, make members server-wide
-- SQLite does not support ALTER TABLE RENAME COLUMN, so we recreate tables.

-- ============================================================
-- 1. Create the new `spaces` table (replacing `guilds`)
-- ============================================================
CREATE TABLE spaces (
    id              BIGINT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    description     VARCHAR(1000),
    icon_hash       VARCHAR(64),
    banner_hash     VARCHAR(64),
    owner_id        BIGINT NOT NULL REFERENCES users(id),
    features        INTEGER NOT NULL DEFAULT 0,
    system_channel_id  BIGINT,
    vanity_url_code    VARCHAR(32) UNIQUE,
    visibility      TEXT NOT NULL DEFAULT 'public',
    allowed_roles   TEXT NOT NULL DEFAULT '[]',
    max_members     INTEGER NOT NULL DEFAULT 500000,
    preferred_locale VARCHAR(10) DEFAULT 'en-US',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Copy existing guild data into spaces
INSERT INTO spaces (id, name, description, icon_hash, banner_hash, owner_id, features,
    system_channel_id, vanity_url_code, visibility, allowed_roles, max_members,
    preferred_locale, created_at, updated_at)
SELECT id, name, description, icon_hash, banner_hash, owner_id, features,
    system_channel_id, vanity_url_code, 'public', '[]', max_members,
    preferred_locale, created_at, updated_at
FROM guilds;

-- ============================================================
-- 2. Recreate `channels` with space_id instead of guild_id
-- ============================================================
CREATE TABLE channels_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT REFERENCES spaces(id) ON DELETE CASCADE,
    name            VARCHAR(100),
    topic           VARCHAR(1024),
    channel_type    SMALLINT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    parent_id       BIGINT REFERENCES channels_new(id),
    nsfw            BOOLEAN NOT NULL DEFAULT FALSE,
    rate_limit_per_user INTEGER NOT NULL DEFAULT 0,
    bitrate         INTEGER DEFAULT 64000,
    user_limit      INTEGER DEFAULT 0,
    last_message_id BIGINT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO channels_new (id, space_id, name, topic, channel_type, position, parent_id,
    nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, created_at, updated_at)
SELECT id, guild_id, name, topic, channel_type, position, parent_id,
    nsfw, rate_limit_per_user, bitrate, user_limit, last_message_id, created_at, updated_at
FROM channels;

-- ============================================================
-- 3. Recreate `members` as server-wide (no guild_id FK)
-- ============================================================
CREATE TABLE members_new (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nick            VARCHAR(32),
    avatar_hash     VARCHAR(64),
    joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
    deaf            BOOLEAN NOT NULL DEFAULT FALSE,
    mute            BOOLEAN NOT NULL DEFAULT FALSE,
    communication_disabled_until TEXT,
    PRIMARY KEY (user_id)
);

-- Migrate existing member data (take the earliest joined_at per user)
INSERT OR IGNORE INTO members_new (user_id, nick, avatar_hash, joined_at, deaf, mute, communication_disabled_until)
SELECT user_id, nick, avatar_hash, MIN(joined_at), deaf, mute, communication_disabled_until
FROM members
GROUP BY user_id;

-- ============================================================
-- 4. Recreate `roles` with space_id + server_wide flag
-- ============================================================
CREATE TABLE roles_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    color           INTEGER NOT NULL DEFAULT 0,
    hoist           BOOLEAN NOT NULL DEFAULT FALSE,
    position        INTEGER NOT NULL DEFAULT 0,
    permissions     BIGINT NOT NULL DEFAULT 0,
    managed         BOOLEAN NOT NULL DEFAULT FALSE,
    mentionable     BOOLEAN NOT NULL DEFAULT FALSE,
    server_wide     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO roles_new (id, space_id, name, color, hoist, position, permissions, managed, mentionable, server_wide, created_at)
SELECT id, guild_id, name, color, hoist, position, permissions, managed, mentionable,
    CASE WHEN id = guild_id THEN TRUE ELSE FALSE END,
    created_at
FROM roles;

-- ============================================================
-- 5. Recreate `member_roles` (user_id + role_id only, no guild_id)
-- ============================================================
CREATE TABLE member_roles_new (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id         BIGINT NOT NULL REFERENCES roles_new(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

INSERT OR IGNORE INTO member_roles_new (user_id, role_id)
SELECT user_id, role_id FROM member_roles;

-- ============================================================
-- 6. Recreate `invites` (server-wide, no guild_id required)
-- ============================================================
CREATE TABLE invites_new (
    code            VARCHAR(16) PRIMARY KEY,
    channel_id      BIGINT NOT NULL REFERENCES channels_new(id) ON DELETE CASCADE,
    inviter_id      BIGINT REFERENCES users(id),
    max_uses        INTEGER DEFAULT 0,
    uses            INTEGER NOT NULL DEFAULT 0,
    max_age         INTEGER DEFAULT 86400,
    temporary       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO invites_new (code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at)
SELECT code, channel_id, inviter_id, max_uses, uses, max_age, temporary, created_at
FROM invites;

-- ============================================================
-- 7. Recreate `bans` as server-wide (no guild_id)
-- ============================================================
CREATE TABLE bans_new (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          VARCHAR(512),
    banned_by       BIGINT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id)
);

INSERT OR IGNORE INTO bans_new (user_id, reason, banned_by, created_at)
SELECT user_id, reason, banned_by, created_at FROM bans;

-- ============================================================
-- 8. Recreate `audit_log_entries` with space_id
-- ============================================================
CREATE TABLE audit_log_entries_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT REFERENCES spaces(id) ON DELETE CASCADE,
    user_id         BIGINT NOT NULL REFERENCES users(id),
    action_type     SMALLINT NOT NULL,
    target_id       BIGINT,
    reason          VARCHAR(512),
    changes         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_log_entries_new (id, space_id, user_id, action_type, target_id, reason, changes, created_at)
SELECT id, guild_id, user_id, action_type, target_id, reason, changes, created_at
FROM audit_log_entries;

-- ============================================================
-- 9. Recreate `emojis` with space_id
-- ============================================================
CREATE TABLE emojis_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name            VARCHAR(32) NOT NULL,
    creator_id      BIGINT REFERENCES users(id),
    animated        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO emojis_new (id, space_id, name, creator_id, animated, created_at)
SELECT id, guild_id, name, creator_id, animated, created_at FROM emojis;

-- ============================================================
-- 10. Recreate `webhooks` with space_id
-- ============================================================
CREATE TABLE webhooks_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id      BIGINT NOT NULL REFERENCES channels_new(id) ON DELETE CASCADE,
    creator_id      BIGINT REFERENCES users(id),
    name            VARCHAR(80) NOT NULL,
    token           VARCHAR(128) NOT NULL UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO webhooks_new (id, space_id, channel_id, creator_id, name, token, created_at)
SELECT id, guild_id, channel_id, creator_id, name, token, created_at FROM webhooks;

-- ============================================================
-- 11. Recreate `automod_rules` with space_id
-- ============================================================
CREATE TABLE automod_rules_new (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    creator_id      BIGINT REFERENCES users(id),
    event_type      SMALLINT NOT NULL,
    trigger_type    SMALLINT NOT NULL,
    trigger_metadata TEXT NOT NULL DEFAULT '{}',
    actions         TEXT NOT NULL DEFAULT '[]',
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO automod_rules_new (id, space_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, enabled, created_at)
SELECT id, guild_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, enabled, created_at
FROM automod_rules;

-- ============================================================
-- 12. Recreate `voice_states` with space_id
-- ============================================================
CREATE TABLE voice_states_new (
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    space_id        BIGINT REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id      BIGINT NOT NULL REFERENCES channels_new(id) ON DELETE CASCADE,
    session_id      VARCHAR(64) NOT NULL,
    self_mute       BOOLEAN NOT NULL DEFAULT FALSE,
    self_deaf       BOOLEAN NOT NULL DEFAULT FALSE,
    self_stream     BOOLEAN NOT NULL DEFAULT FALSE,
    self_video      BOOLEAN NOT NULL DEFAULT FALSE,
    suppress        BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id)
);

INSERT INTO voice_states_new (user_id, space_id, channel_id, session_id, self_mute, self_deaf, self_stream, self_video, suppress)
SELECT user_id, guild_id, channel_id, session_id, self_mute, self_deaf, self_stream, self_video, suppress
FROM voice_states;

-- ============================================================
-- 13. Drop old tables and rename new ones
-- ============================================================

-- Must drop dependents first due to FK constraints
DROP TABLE IF EXISTS member_roles;
DROP TABLE IF EXISTS voice_states;
DROP TABLE IF EXISTS automod_rules;
DROP TABLE IF EXISTS webhooks;
DROP TABLE IF EXISTS emojis;
DROP TABLE IF EXISTS audit_log_entries;
DROP TABLE IF EXISTS bans;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS members;
DROP TABLE IF EXISTS channels;
DROP TABLE IF EXISTS guilds;

ALTER TABLE channels_new RENAME TO channels;
ALTER TABLE members_new RENAME TO members;
ALTER TABLE roles_new RENAME TO roles;
ALTER TABLE member_roles_new RENAME TO member_roles;
ALTER TABLE invites_new RENAME TO invites;
ALTER TABLE bans_new RENAME TO bans;
ALTER TABLE audit_log_entries_new RENAME TO audit_log_entries;
ALTER TABLE emojis_new RENAME TO emojis;
ALTER TABLE webhooks_new RENAME TO webhooks;
ALTER TABLE automod_rules_new RENAME TO automod_rules;
ALTER TABLE voice_states_new RENAME TO voice_states;

-- ============================================================
-- 14. Recreate indexes
-- ============================================================
CREATE INDEX idx_channels_space_id ON channels(space_id);
CREATE INDEX idx_members_user ON members(user_id);
CREATE INDEX idx_roles_space ON roles(space_id);
CREATE INDEX idx_audit_log_space ON audit_log_entries(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_overwrites_channel_id ON channel_overwrites(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipients_user_id ON dm_recipients(user_id);
CREATE INDEX IF NOT EXISTS idx_fed_events_room ON federation_events(room_id, depth);

-- ============================================================
-- 15. Update server_settings defaults
-- ============================================================
UPDATE server_settings SET key = 'max_spaces_per_user' WHERE key = 'max_guilds_per_user';
UPDATE server_settings SET key = 'max_members_per_server' WHERE key = 'max_members_per_guild';
