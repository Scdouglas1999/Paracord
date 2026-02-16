-- Server-wide settings (key-value store for admin dashboard)
CREATE TABLE IF NOT EXISTS server_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Seed defaults
INSERT INTO server_settings (key, value) VALUES
    ('registration_enabled', 'true'),
    ('server_name', 'Paracord Server'),
    ('server_description', ''),
    ('max_guilds_per_user', '100'),
    ('max_members_per_guild', '1000')
ON CONFLICT DO NOTHING;
