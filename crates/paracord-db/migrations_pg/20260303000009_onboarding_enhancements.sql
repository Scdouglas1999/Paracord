CREATE TABLE IF NOT EXISTS guild_onboarding_settings (
    guild_id BIGINT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    welcome_title TEXT,
    welcome_body TEXT,
    rules_text TEXT,
    role_prompt TEXT,
    progressive_channel_min_messages INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_onboarding_role_options (
    id BIGINT PRIMARY KEY,
    guild_id BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    label TEXT,
    description TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE (guild_id, role_id)
);

CREATE TABLE IF NOT EXISTS member_onboarding_state (
    guild_id BIGINT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_rules BOOLEAN NOT NULL DEFAULT FALSE,
    selected_role_ids TEXT NOT NULL DEFAULT '[]',
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_member_onboarding_state_guild
    ON member_onboarding_state (guild_id, completed_at);
