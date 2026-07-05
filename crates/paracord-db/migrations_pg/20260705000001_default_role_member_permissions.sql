-- Bring existing default Member (@everyone-equivalent) roles up to the new
-- Discord-parity baseline in Permissions::default(). Guilds created before
-- this change persisted the old restrictive bitmask at creation time, so
-- plain members hit 403s on invite creation and file upload.
--
-- Bits being OR'd in (from paracord-models/src/permissions.rs):
--   CREATE_INSTANT_INVITE: 1 << 0  =       1
--   EMBED_LINKS:           1 << 14 =  16,384
--   ATTACH_FILES:          1 << 15 =  32,768
--   USE_EXTERNAL_EMOJIS:   1 << 18 = 262,144
--   Total: 1 + 16384 + 32768 + 262144 = 311,297
--
-- MENTION_EVERYONE (1 << 17) is deliberately NOT granted: with
-- auto_join_public_spaces a default mass-ping would be cheap abuse; owners
-- can grant it explicitly.
--
-- Scoped strictly to the default role for each space (id = space_id); no
-- other roles are modified.
UPDATE roles
SET permissions = permissions | 311297
WHERE id = space_id
  AND (permissions | 311297) != permissions;
