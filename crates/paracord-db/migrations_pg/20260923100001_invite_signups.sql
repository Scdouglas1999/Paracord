-- Accounts created with an invite while the instance was invite-only.
--
-- Registration checks the invite but does not spend it: joining the invite's
-- server afterwards is what counts a use, so the newcomer can still answer that
-- server's join questions. This table is what stops one limited invite from
-- minting unlimited accounts in the meantime: a registration is refused once an
-- invite has created as many accounts as it allows uses.
--
-- No foreign keys: the invite may be deleted and the account may be removed
-- later, and neither should give an invite its slot back.
CREATE TABLE IF NOT EXISTS invite_signups (
    user_id BIGINT PRIMARY KEY,
    invite_code TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_signups_invite_code ON invite_signups (invite_code);
