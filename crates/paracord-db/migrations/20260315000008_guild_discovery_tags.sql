-- Separate guild discovery tags from role-gating allowed_role_ids.
-- Previously the `allowed_roles` column was overloaded to hold both the
-- discovery tags of public guilds and the allowed role IDs of role-gated
-- guilds. That conflation made auto-join and role-gating logic ambiguous.
-- Give discovery tags a dedicated column and migrate existing data based on
-- each guild's visibility so nothing is lost.
ALTER TABLE spaces ADD COLUMN discovery_tags TEXT NOT NULL DEFAULT '[]';

-- Non-role-gated guilds stored discovery tags in `allowed_roles`; move them to
-- the dedicated column, then clear the role-id column for those guilds so it
-- unambiguously holds allowed role IDs (empty for anything not role-gated).
UPDATE spaces SET discovery_tags = allowed_roles WHERE visibility <> 'roles' AND allowed_roles <> '[]';
UPDATE spaces SET allowed_roles = '[]' WHERE visibility <> 'roles';
