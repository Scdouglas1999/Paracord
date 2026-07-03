-- Enable pg_trgm extension for trigram-based similarity search.
--
-- PREREQUISITE: creating an extension requires the CREATE privilege on the
-- current database (effectively a superuser or a role granted CREATE, e.g. the
-- database owner). On locked-down / managed Postgres (some cloud providers)
-- pg_trgm may need to be enabled out-of-band by an administrator before this
-- migration runs; otherwise it fails here with a permission error. pg_trgm is a
-- hard requirement for the trigram GIN indexes below (member search).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index on users.username for fast case-insensitive member search
CREATE INDEX IF NOT EXISTS idx_users_username_trgm
    ON users USING GIN (username gin_trgm_ops);

-- GIN trigram index on members.nick for fast case-insensitive nick search
CREATE INDEX IF NOT EXISTS idx_members_nick_trgm
    ON members USING GIN (nick gin_trgm_ops);
