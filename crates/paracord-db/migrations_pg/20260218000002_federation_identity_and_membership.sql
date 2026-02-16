-- Federation identity mapping and message/member linkage.

CREATE TABLE IF NOT EXISTS federation_remote_users (
    remote_user_id           TEXT PRIMARY KEY,
    origin_server            VARCHAR(255) NOT NULL,
    local_user_id            BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fed_remote_users_origin
    ON federation_remote_users(origin_server);

CREATE TABLE IF NOT EXISTS federation_message_map (
    event_id                 VARCHAR(255) PRIMARY KEY,
    origin_server            VARCHAR(255) NOT NULL,
    remote_message_id        VARCHAR(255),
    local_message_id         BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id               BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (origin_server, remote_message_id)
);

CREATE INDEX IF NOT EXISTS idx_fed_msg_map_remote
    ON federation_message_map(origin_server, remote_message_id);

CREATE TABLE IF NOT EXISTS federation_room_memberships (
    room_id                  VARCHAR(255) NOT NULL,
    remote_user_id           TEXT NOT NULL,
    local_user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id                 BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    joined_at                TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (room_id, remote_user_id)
);

CREATE INDEX IF NOT EXISTS idx_fed_room_memberships_guild
    ON federation_room_memberships(guild_id);
