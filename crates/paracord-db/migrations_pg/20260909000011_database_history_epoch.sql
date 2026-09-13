-- A history identity survives ordinary restarts and is shared by all instances.
-- Offline restore/import must explicitly rotate it after copying backup settings.
INSERT INTO server_settings (key, value)
VALUES ('database_history_epoch', gen_random_uuid()::text)
ON CONFLICT (key) DO NOTHING;
