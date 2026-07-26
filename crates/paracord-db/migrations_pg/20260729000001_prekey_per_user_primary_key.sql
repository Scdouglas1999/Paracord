-- Make a one-time prekey's identity per-user instead of global.
--
-- `one_time_prekeys.id` is the X3DH key id the *client* chooses, and the client
-- derives it from `Date.now()`, so ids are predictable and shared across users.
-- The table nevertheless carried a GLOBAL `PRIMARY KEY (id)` while
-- `upload_one_time_prekeys` arbitrated `ON CONFLICT (user_id, id) DO NOTHING`.
-- An id already claimed by *another* user therefore violated the primary key --
-- a conflict the ON CONFLICT target does not cover -- which aborted the INSERT
-- and surfaced as a 500. Anyone could squat a range of ids and deny a victim
-- (or every new account) the ability to publish prekeys at all, which breaks
-- E2EE DM setup.
--
-- The key id only ever has to be unique *within a user's* pool: every read,
-- consume and delete path is already scoped by `user_id`. Promoting
-- `(user_id, id)` to the primary key makes a foreign id harmless and keeps the
-- ON CONFLICT target intact.
--
-- Constraint names are spelled out for both possible spellings because
-- `20260220000001_fix_integer_to_bigint` rebuilt this table as
-- `one_time_prekeys_new` and renamed it -- PostgreSQL renames the table but not
-- its constraints, so a database that ran that migration carries the `_new`
-- names. `IF EXISTS` makes the pair that does not apply a no-op.
ALTER TABLE one_time_prekeys DROP CONSTRAINT IF EXISTS one_time_prekeys_pkey;
ALTER TABLE one_time_prekeys DROP CONSTRAINT IF EXISTS one_time_prekeys_new_pkey;
ALTER TABLE one_time_prekeys DROP CONSTRAINT IF EXISTS one_time_prekeys_user_id_id_key;
ALTER TABLE one_time_prekeys DROP CONSTRAINT IF EXISTS one_time_prekeys_new_user_id_id_key;

ALTER TABLE one_time_prekeys ADD PRIMARY KEY (user_id, id);

CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON one_time_prekeys(user_id);
