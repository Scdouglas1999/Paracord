-- Per-server sports add-on. No row means the feature is off and the board
-- defaults to NFL and MLB. Booleans are read back with CAST(col AS INTEGER);
-- updated_at is TEXT on both engines (sqlx Any cannot decode a native timestamp).

CREATE TABLE IF NOT EXISTS guild_sports_settings (
    guild_id            BIGINT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    leagues             TEXT,
    favorite_teams      TEXT,
    show_on_server_page BOOLEAN NOT NULL DEFAULT TRUE,
    default_view        TEXT NOT NULL DEFAULT 'all',
    layout              TEXT NOT NULL DEFAULT 'cards',
    updated_at          TEXT
);
