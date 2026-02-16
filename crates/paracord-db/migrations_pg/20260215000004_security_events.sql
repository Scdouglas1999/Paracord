-- Security audit events for auth/admin/trust-sensitive mutations.

CREATE TABLE IF NOT EXISTS security_events (
    id              BIGINT PRIMARY KEY,
    actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_user_id  BIGINT,
    session_id      TEXT,
    device_id       TEXT,
    user_agent      TEXT,
    ip_address      TEXT,
    details         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_events_created
    ON security_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_action_created
    ON security_events (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_security_events_actor_created
    ON security_events (actor_user_id, created_at DESC);
