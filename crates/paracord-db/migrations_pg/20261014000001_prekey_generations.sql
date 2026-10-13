-- The account's current prekey generation: a server snowflake minted when an
-- account first publishes a signed prekey and again whenever a device replaces
-- the whole published bundle (a new device under the same identity). A sender
-- compares it with the generation its own DM ratchet was built against, so a
-- conversation moves to the device that holds the current keys on the next
-- send instead of staying on a device that no longer receives new sessions.
CREATE TABLE IF NOT EXISTS prekey_generations (
    user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generation BIGINT NOT NULL
);
