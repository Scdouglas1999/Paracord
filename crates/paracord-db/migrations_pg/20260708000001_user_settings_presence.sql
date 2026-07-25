-- First-class presence fields on user_settings (previously buried in
-- notifications JSON as presenceStatus / customStatus).
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS presence_status VARCHAR(16) NOT NULL DEFAULT 'online';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS custom_status TEXT;

-- Best-effort backfill from the legacy notifications JSON keys.
--
-- `notifications` is declared TEXT (not JSONB) in this schema, so the JSON
-- operators must be applied to an explicit cast. Applying `->>` / `?` directly
-- to TEXT raises "operator does not exist: text ->> unknown", which aborted the
-- whole migration run and prevented the server from starting on PostgreSQL.
-- NULLIF guards the empty string, which is not valid JSON.
UPDATE user_settings
SET presence_status = COALESCE(
    NULLIF((NULLIF(notifications, '')::jsonb)->>'presenceStatus', ''),
    presence_status
)
WHERE (NULLIF(notifications, '')::jsonb)->>'presenceStatus'
      IN ('online', 'idle', 'dnd', 'invisible');

UPDATE user_settings
SET custom_status = NULLIF((NULLIF(notifications, '')::jsonb)->>'customStatus', '')
WHERE (NULLIF(notifications, '')::jsonb) ? 'customStatus'
  AND NULLIF((NULLIF(notifications, '')::jsonb)->>'customStatus', '') IS NOT NULL;
