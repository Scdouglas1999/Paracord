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
-- ON CONFLICT target intact. Existing ids are globally unique today, so the
-- copy below cannot collide.
CREATE TABLE one_time_prekeys_new (
    id          BIGINT NOT NULL,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_resort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, id)
);

INSERT INTO one_time_prekeys_new (id, user_id, public_key, created_at, last_resort)
SELECT id, user_id, public_key, created_at, last_resort
FROM one_time_prekeys;

DROP TABLE one_time_prekeys;
ALTER TABLE one_time_prekeys_new RENAME TO one_time_prekeys;
CREATE INDEX IF NOT EXISTS idx_one_time_prekeys_user ON one_time_prekeys(user_id);
