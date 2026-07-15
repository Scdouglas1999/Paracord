-- First-class presence fields on user_settings (previously buried in
-- notifications JSON as presenceStatus / customStatus).
ALTER TABLE user_settings ADD COLUMN presence_status VARCHAR(16) NOT NULL DEFAULT 'online';
ALTER TABLE user_settings ADD COLUMN custom_status TEXT;

-- Best-effort backfill from the legacy notifications JSON keys.
UPDATE user_settings
SET presence_status = COALESCE(
    json_extract(notifications, '$.presenceStatus'),
    presence_status
)
WHERE json_extract(notifications, '$.presenceStatus') IN ('online', 'idle', 'dnd', 'invisible');

UPDATE user_settings
SET custom_status = json_extract(notifications, '$.customStatus')
WHERE json_extract(notifications, '$.customStatus') IS NOT NULL
  AND typeof(json_extract(notifications, '$.customStatus')) = 'text'
  AND length(json_extract(notifications, '$.customStatus')) > 0;
