-- AutoMod: bring the dormant `automod_rules` table up to a usable feature shape.
--
-- The table shipped in the initial schema but was never wired to anything. Rules
-- need per-rule exemptions (staff roles and channels that should never be
-- filtered) and an updated_at stamp so the settings UI can show freshness.
--
-- Note: `20260211000001_guilds_to_spaces` rebuilt this table with `space_id`,
-- so the scoping column here is `space_id`, not `guild_id`.

ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS exempt_role_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS exempt_channel_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE automod_rules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_automod_rules_space_enabled
    ON automod_rules (space_id, enabled);

-- Every automated action is recorded so moderators can audit what the filter did
-- and why, independent of the human-facing audit log.
CREATE TABLE IF NOT EXISTS automod_hits (
    id              BIGINT PRIMARY KEY,
    space_id        BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    rule_id         BIGINT NOT NULL,
    rule_name       VARCHAR(100) NOT NULL,
    user_id         BIGINT NOT NULL,
    channel_id      BIGINT NOT NULL,
    trigger_type    SMALLINT NOT NULL,
    actions_taken   TEXT NOT NULL DEFAULT '[]',
    matched_excerpt TEXT,
    content_excerpt TEXT,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_automod_hits_space_created
    ON automod_hits (space_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_automod_hits_user_created
    ON automod_hits (space_id, user_id, created_at DESC);
