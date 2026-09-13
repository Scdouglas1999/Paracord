-- Permanent first-owner claim state for this instance.
--
-- Ownership must never be inferred from "are there any users yet" or from the
-- presence of a config file: both reopen the bootstrap window after an operator
-- deletes the owner, and both made the first anonymous registrant the owner of
-- a freshly exposed server. This singleton row is the only authority.
--
-- `status` is 'pending' only for a database that has never had a user. Any
-- existing installation is sealed as 'complete' below, so upgrading never
-- reopens setup and never invalidates the owner it already has.
CREATE TABLE instance_setup (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    status                  VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'complete')),
    instance_name           VARCHAR(100),
    claimed_by_user_id      BIGINT,
    claimed_at              TEXT,
    -- How the instance left 'pending': an operator completing the claim flow,
    -- this migration sealing a populated database, or an explicit
    -- `require_claim = false` bootstrap for automated deployments.
    completed_via           VARCHAR(16) CHECK (completed_via IN ('claim', 'migration', 'bootstrap')),
    -- SHA-256 (hex) of the one-time bootstrap claim token, never the token.
    claim_token_hash        VARCHAR(128),
    -- 'config' when the token came from `[setup] claim_token` /
    -- PARACORD_SETUP_CLAIM_TOKEN, 'generated' when the server minted it.
    claim_token_source      VARCHAR(16) CHECK (claim_token_source IN ('config', 'generated')),
    claim_token_issued_at   TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO instance_setup (id, status, completed_via, claimed_at)
SELECT
    1,
    CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'complete' ELSE 'pending' END,
    CASE WHEN EXISTS (SELECT 1 FROM users) THEN 'migration' ELSE NULL END,
    CASE WHEN EXISTS (SELECT 1 FROM users) THEN datetime('now') ELSE NULL END;
