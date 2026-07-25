-- Widen the VARCHAR columns that are narrower than the limit the application
-- itself accepts.
--
-- PostgreSQL enforces VARCHAR(n); SQLite silently ignores it. Every value in
-- the gap between a handler's declared limit and its column therefore passed
-- validation, stored fine on SQLite, and failed on PostgreSQL with
-- "value too long for type character varying(n)" — a 500 for input the API had
-- already accepted as valid.
--
-- Each column below is widened to the bound the route layer enforces, rather
-- than the route layer being tightened, because the larger bound is the
-- deliberate product behaviour: it is a named constant in the handler and
-- SQLite deployments have always stored values of that size.

--   MAX_DISPLAY_NAME_LEN = 64 (paracord-api/src/routes/users.rs, auth.rs)
ALTER TABLE users ALTER COLUMN display_name TYPE VARCHAR(64);

--   MAX_BIO_LEN = 512 (paracord-api/src/routes/users.rs)
ALTER TABLE users ALTER COLUMN bio TYPE VARCHAR(512);

--   MAX_GUILD_DESCRIPTION_LEN = 1_024 (paracord-api/src/routes/guilds.rs)
ALTER TABLE spaces ALTER COLUMN description TYPE VARCHAR(1024);

--   MAX_DM_E2EE_NONCE_LEN = 128 (paracord-core/src/message.rs). The plaintext
--   send path caps the nonce at 64, but the encrypted-DM path validates 128 and
--   then overwrites the capped value, so the column has to hold the wider one.
ALTER TABLE messages ALTER COLUMN nonce TYPE VARCHAR(128);

-- `avatar_hash` and `icon_hash` are not hashes despite the names: the API
-- accepts an inline `data:` image URL in both. `PATCH /users/@me` rejects an
-- avatar data URL only above 2 MB ("use POST /users/@me/avatar"), and the
-- desktop client PATCHes a base64 guild icon straight into `icon`
-- (client/src/components/guild/GuildSettings.tsx). Neither value can be
-- expressed in 64 characters, so on PostgreSQL saving a server icon or an
-- inline avatar was an unconditional 500. TEXT matches what the application
-- already stores on SQLite; the 2 MB request-body cap remains the real bound.
ALTER TABLE users ALTER COLUMN avatar_hash TYPE TEXT;
ALTER TABLE spaces ALTER COLUMN icon_hash TYPE TEXT;
