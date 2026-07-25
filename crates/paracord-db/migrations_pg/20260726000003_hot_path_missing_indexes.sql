-- Indexes for lookups that were confirmed to be full table scans.
--
-- Verified with EXPLAIN QUERY PLAN against the materialised schema: each
-- statement below replaces a `SCAN <table>` (or a `USE TEMP B-TREE FOR ORDER BY`)
-- on a path that runs per request.

-- Voice state is looked up per channel (who is in this room) and per space
-- (voice presence fan-out). Both scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_voice_states_channel ON voice_states (channel_id);
CREATE INDEX IF NOT EXISTS idx_voice_states_space ON voice_states (space_id);

-- Message pages hydrate polls with `WHERE message_id IN (...)` and then
-- `WHERE poll_id IN (...)`. Unindexed, that was two full scans on *every*
-- message page, whether or not the channel has ever had a poll.
CREATE INDEX IF NOT EXISTS idx_polls_message ON polls (message_id);
CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options (poll_id, position);

-- Incoming friend requests are found by target, not by owner.
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships (target_id);

-- Webhook dispatch and the channel/space settings screens.
CREATE INDEX IF NOT EXISTS idx_webhooks_channel ON webhooks (channel_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_space ON webhooks (space_id);

-- Invite lists for a channel, and the emoji picker for a space.
CREATE INDEX IF NOT EXISTS idx_invites_channel ON invites (channel_id);
CREATE INDEX IF NOT EXISTS idx_emojis_space ON emojis (space_id);

-- The retention sweeper deletes by age across the largest table in the schema.
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

-- Member listings keyset-paginate on `guild_id = ? AND user_id > ?` ordered by
-- user_id; the guild-only index forced a temp B-tree sort of the whole guild.
CREATE INDEX IF NOT EXISTS idx_members_guild_user ON members (guild_id, user_id);

-- Audit log pages order by `id DESC`, but the only index sorted by created_at,
-- so every page built a temp B-tree over the space's entire audit history.
CREATE INDEX IF NOT EXISTS idx_audit_log_space_id ON audit_log_entries (space_id, id DESC);
