-- Add public_url and server_invite_code settings for friendly links
INSERT INTO server_settings (key, value) VALUES
    ('public_url', ''),
    ('server_invite_enabled', 'true')
ON CONFLICT DO NOTHING;
