-- Guild templates: save and apply guild structure snapshots.
CREATE TABLE IF NOT EXISTS guild_templates (
    id BIGINT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    creator_id BIGINT NOT NULL,
    source_guild_id BIGINT,
    template_data TEXT NOT NULL,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_guild_templates_creator ON guild_templates(creator_id);
