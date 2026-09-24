-- Feeds add-on: outside sources (RSS/Atom, YouTube, GitHub, Twitch, Jellyfin)
-- posting into a server's channels.
--
-- Booleans are bound as Rust bool and read back with CAST(col AS INTEGER).
-- Every timestamp is TEXT on both engines, written by the application, because
-- the sqlx Any driver cannot decode a native timestamp.

-- Whether the add-on is on for a server. No row means off.
CREATE TABLE IF NOT EXISTS guild_feed_settings (
    guild_id   BIGINT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TEXT
);

-- One row per thing the instance fetches. Every server subscribed to the same
-- address shares it, so an address is fetched once per interval however many
-- servers follow it.
CREATE TABLE IF NOT EXISTS feed_sources (
    id              BIGINT PRIMARY KEY,
    kind            TEXT NOT NULL,
    source_key      TEXT NOT NULL UNIQUE,
    url             TEXT NOT NULL,
    title           TEXT,
    site_url        TEXT,
    icon_url        TEXT,
    etag            TEXT,
    last_modified   TEXT,
    last_checked_at TEXT,
    last_success_at TEXT,
    last_error      TEXT,
    error_count     BIGINT NOT NULL DEFAULT 0,
    next_check_at   TEXT,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_sources_next_check
    ON feed_sources(next_check_at);

-- A server's subscription to a source, posting into one channel.
CREATE TABLE IF NOT EXISTS guild_feeds (
    id                 BIGINT PRIMARY KEY,
    guild_id           BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id         BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    source_id          BIGINT NOT NULL REFERENCES feed_sources(id),
    creator_id         BIGINT,
    kind               TEXT NOT NULL,
    name               TEXT NOT NULL,
    options            TEXT NOT NULL DEFAULT '{}',
    secret             TEXT,
    show_on_front_page BOOLEAN NOT NULL DEFAULT TRUE,
    paused             BOOLEAN NOT NULL DEFAULT FALSE,
    -- Why the last post into the channel failed; NULL once one succeeds.
    last_error         TEXT,
    last_posted_at     TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_guild_feeds_guild ON guild_feeds(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_feeds_source ON guild_feeds(source_id);

-- Items a subscription has already seen, posted or not. Deduplication and
-- "Post the latest now" both read from here.
CREATE TABLE IF NOT EXISTS guild_feed_items (
    feed_id      BIGINT NOT NULL REFERENCES guild_feeds(id) ON DELETE CASCADE,
    item_key     TEXT NOT NULL,
    title        TEXT,
    published_at TEXT,
    item         TEXT NOT NULL,
    posted       BOOLEAN NOT NULL DEFAULT FALSE,
    seen_at      TEXT NOT NULL,
    PRIMARY KEY (feed_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_guild_feed_items_seen
    ON guild_feed_items(feed_id, seen_at);

-- Messages a feed posted. The name and icon are kept with the message so a
-- post keeps its author after its feed is renamed or removed.
CREATE TABLE IF NOT EXISTS feed_messages (
    message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    feed_id    BIGINT NOT NULL,
    guild_id   BIGINT NOT NULL,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    icon_url   TEXT,
    -- The "and N more from <source>" line: a feed post, never front-page news.
    overflow   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_messages_feed ON feed_messages(feed_id);
