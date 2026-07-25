-- Migration: Rename guilds to spaces, make members server-wide
--
-- `guilds` and `channels` are transformed IN PLACE; every other table is
-- rebuilt copy-and-swap style.
--
-- Why `channels` must never be dropped: `messages`, `read_states`, `reactions`,
-- `attachments`, `channel_overwrites` and `dm_recipients` all hold
-- `ON DELETE CASCADE` foreign keys onto `channels(id)`. `DROP TABLE` performs
-- an implicit `DELETE FROM` which fires those cascades, so the old
-- drop-and-recreate shape silently deleted every message, read state, reaction,
-- attachment, permission overwrite and DM membership on the server.
--
-- Foreign keys cannot simply be suspended for the rebuild:
--   * `paracord-db/src/lib.rs` sets `PRAGMA foreign_keys = ON` on every
--     connection, and that pragma is a documented no-op inside a transaction;
--   * sqlx wraps every migration in a transaction, and sqlx-sqlite 0.8.6
--     ignores the `-- no-transaction` opt-out entirely (its `Migrate::apply`
--     unconditionally calls `begin()`), so there is no way to get FK
--     enforcement off from inside a migration file.
-- Renaming in place sidesteps the problem: with `foreign_keys = ON`, SQLite
-- rewrites every `REFERENCES` clause that named the renamed object, so children
-- follow the parent automatically and no row is ever deleted.

-- ============================================================
-- 1. Turn `guilds` into `spaces`, in place
-- ============================================================
ALTER TABLE guilds RENAME TO spaces;

-- `visibility` / `allowed_roles` are new in the space model. Both defaults are
-- constants, which is the only form SQLite accepts for ADD COLUMN once a table
-- already holds rows.
ALTER TABLE spaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE spaces ADD COLUMN allowed_roles TEXT NOT NULL DEFAULT '[]';

-- ============================================================
-- 2. Rename channels.guild_id -> channels.space_id, in place
-- ============================================================
-- The FK on this column was retargeted from `guilds` to `spaces` by the rename
-- above; only the column name still has to change.
ALTER TABLE channels RENAME COLUMN guild_id TO space_id;
DROP INDEX IF EXISTS idx_channels_guild_id;

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
    channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
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
    channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
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
    channel_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
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

-- Must drop dependents first due to FK constraints.
-- Every table listed here is a *child* of `spaces` / `channels` / `users`;
-- dropping a child never fires a cascade. `channels` and `guilds`/`spaces` are
-- deliberately absent: they were transformed in place in steps 1-2 precisely so
-- that no parent row is ever deleted (see the header comment).
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
