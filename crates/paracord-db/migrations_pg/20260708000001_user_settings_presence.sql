-- First-class presence fields on user_settings (previously buried in
-- notifications JSON as presenceStatus / customStatus).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS presence_status VARCHAR(16) NOT NULL DEFAULT 'online';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS custom_status TEXT;

-- Best-effort backfill from the legacy notifications JSON keys.
UPDATE user_settings
SET presence_status = COALESCE(
    NULLIF(notifications->>'presenceStatus', ''),
    presence_status
)
WHERE notifications->>'presenceStatus' IN ('online', 'idle', 'dnd', 'invisible');

UPDATE user_settings
SET custom_status = NULLIF(notifications->>'customStatus', '')
WHERE notifications ? 'customStatus'
  AND NULLIF(notifications->>'customStatus', '') IS NOT NULL;
