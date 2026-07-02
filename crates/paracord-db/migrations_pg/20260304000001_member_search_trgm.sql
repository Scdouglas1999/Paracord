-- Enable pg_trgm extension for trigram-based similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on users.username for fast case-insensitive member search
CREATE INDEX IF NOT EXISTS idx_users_username_trgm
    ON users USING GIN (username gin_trgm_ops);

-- GIN trigram index on members.nick for fast case-insensitive nick search
CREATE INDEX IF NOT EXISTS idx_members_nick_trgm
    ON members USING GIN (nick gin_trgm_ops);
