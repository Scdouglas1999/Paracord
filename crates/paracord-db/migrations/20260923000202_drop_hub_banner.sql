-- The server banner is now an uploaded image in `spaces.banner_hash`. The hub's
-- old data-URL banner (`hub_settings.banner_hash`) is no longer read anywhere,
-- so drop it rather than ship it inside every server list response.
UPDATE spaces
SET hub_settings = json_remove(hub_settings, '$.banner_hash')
WHERE hub_settings IS NOT NULL
  AND json_valid(hub_settings)
  AND json_type(hub_settings, '$.banner_hash') IS NOT NULL;
