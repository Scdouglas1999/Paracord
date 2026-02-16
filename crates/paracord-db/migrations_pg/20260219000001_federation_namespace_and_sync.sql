-- Federation namespace isolation mappings and room sync cursors.

CREATE TABLE IF NOT EXISTS federation_space_map (
    origin_server            VARCHAR(255) NOT NULL,
    remote_space_id          VARCHAR(255) NOT NULL,
    local_guild_id           BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (origin_server, remote_space_id)
);

CREATE INDEX IF NOT EXISTS idx_fed_space_map_local
    ON federation_space_map(local_guild_id);

CREATE TABLE IF NOT EXISTS federation_channel_map (
    origin_server            VARCHAR(255) NOT NULL,
    remote_channel_id        VARCHAR(255) NOT NULL,
    local_channel_id         BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    local_guild_id           BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (origin_server, remote_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_fed_channel_map_local
    ON federation_channel_map(local_channel_id);

CREATE INDEX IF NOT EXISTS idx_fed_channel_map_guild
    ON federation_channel_map(local_guild_id);

CREATE TABLE IF NOT EXISTS federation_room_sync_cursors (
    server_name              VARCHAR(255) NOT NULL,
    room_id                  VARCHAR(255) NOT NULL,
    last_depth               BIGINT NOT NULL DEFAULT 0,
    updated_at_ms            BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    PRIMARY KEY (server_name, room_id)
);

