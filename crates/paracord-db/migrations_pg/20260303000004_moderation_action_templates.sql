CREATE TABLE IF NOT EXISTS moderation_action_templates (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    action_type SMALLINT NOT NULL,
    duration_minutes INTEGER,
    reason_template TEXT,
    dm_template TEXT,
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_moderation_action_templates_guild
    ON moderation_action_templates (guild_id, created_at DESC);
