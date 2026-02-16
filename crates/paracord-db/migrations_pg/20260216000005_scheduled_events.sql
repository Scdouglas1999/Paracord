-- Scheduled events for guilds (Phase 4.2)
CREATE TABLE IF NOT EXISTS scheduled_events (
    id INTEGER PRIMARY KEY,
    guild_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    creator_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    scheduled_start TEXT NOT NULL,
    scheduled_end TEXT,
    status INTEGER NOT NULL DEFAULT 1, -- 1=scheduled, 2=active, 3=completed, 4=cancelled
    entity_type INTEGER NOT NULL DEFAULT 1, -- 1=voice, 2=external
    location TEXT,
    image_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_rsvps (
    event_id INTEGER NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status INTEGER NOT NULL DEFAULT 1, -- 1=interested
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_id, user_id)
);

-- Discovery: add discoverable + tags to spaces
ALTER TABLE spaces ADD COLUMN discoverable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE spaces ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
