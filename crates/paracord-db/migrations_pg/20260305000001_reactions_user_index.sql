-- Index reactions by user_id so per-user cleanup and ON DELETE CASCADE from
-- users do not seq-scan the reactions table (PK is (message_id, user_id, emoji_name)).

CREATE INDEX IF NOT EXISTS idx_reactions_user
    ON reactions (user_id);
