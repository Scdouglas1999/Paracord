-- A history identity survives ordinary restarts and is shared by all instances.
-- Offline restore/import must explicitly rotate it after copying backup settings.
INSERT INTO server_settings (key, value)
VALUES (
    'database_history_epoch',
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
    substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) ||
    '-' || lower(hex(randomblob(6)))
)
ON CONFLICT (key) DO NOTHING;
