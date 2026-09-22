-- The server banner is now an uploaded image in `spaces.banner_hash`. The hub's
-- old data-URL banner (`hub_settings.banner_hash`) is no longer read anywhere,
-- so drop it rather than ship it inside every server list response.
-- `hub_settings` is TEXT written by serde_json, so it is always valid JSON.
UPDATE spaces
SET hub_settings = (hub_settings::jsonb - 'banner_hash')::text
WHERE hub_settings IS NOT NULL
  AND jsonb_typeof(hub_settings::jsonb) = 'object'
  AND hub_settings::jsonb ? 'banner_hash';
