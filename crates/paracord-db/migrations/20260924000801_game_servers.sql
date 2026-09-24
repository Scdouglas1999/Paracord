-- Game servers add-on: whether a community's Minecraft or Valve-game server is
-- up and who is on it.
--
-- Booleans are bound as Rust bool and read back with CAST(col AS INTEGER).
-- Every timestamp is TEXT on both engines, written by the application, because
-- the sqlx Any driver cannot decode a native timestamp.

-- Whether the add-on is on for a server. No row means off.
CREATE TABLE IF NOT EXISTS guild_game_server_settings (
    guild_id   BIGINT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TEXT
);

-- One row per address and protocol the instance probes. Every server listing
-- the same address shares it, so an address is probed once a minute however
-- many servers list it.
CREATE TABLE IF NOT EXISTS game_server_targets (
    id               BIGINT PRIMARY KEY,
    kind             TEXT NOT NULL,
    target_key       TEXT NOT NULL UNIQUE,
    host             TEXT NOT NULL,
    port             BIGINT NOT NULL,
    -- Up as far as members are told: set by an answer, cleared after three
    -- failed probes in a row (or the first, for a server never seen up).
    online           BOOLEAN NOT NULL DEFAULT FALSE,
    players_online   BIGINT,
    players_max      BIGINT,
    -- JSON list of names; NULL when the protocol does not say who is on.
    player_names     TEXT,
    server_name      TEXT,
    map              TEXT,
    version          TEXT,
    motd             TEXT,
    latency_ms       BIGINT,
    fail_count       BIGINT NOT NULL DEFAULT 0,
    last_checked_at  TEXT,
    last_seen_online TEXT,
    last_error       TEXT,
    next_check_at    TEXT,
    created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_game_server_targets_next_check
    ON game_server_targets(next_check_at);

-- A game server listed on a Paracord server.
CREATE TABLE IF NOT EXISTS guild_game_servers (
    id                  BIGINT PRIMARY KEY,
    guild_id            BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    target_id           BIGINT NOT NULL REFERENCES game_server_targets(id),
    kind                TEXT NOT NULL,
    name                TEXT NOT NULL,
    address             TEXT NOT NULL,
    -- Where "went down" and "back up" are posted; NULL posts nothing.
    announce_channel_id BIGINT,
    -- 'up' or 'down' as this listing last saw it; NULL before its first check.
    last_state          TEXT,
    -- Why the last announcement could not be posted; NULL once one is.
    announce_error      TEXT,
    creator_id          BIGINT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_game_servers_guild ON guild_game_servers(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_game_servers_target ON guild_game_servers(target_id);
