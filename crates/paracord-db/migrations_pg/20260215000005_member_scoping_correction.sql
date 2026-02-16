-- Correct member rows over-expanded by 20260214000002_member_scoping.sql.
-- Keep only memberships supported by at least one authoritative signal:
-- - assigned role in the space
-- - space ownership
-- - existing message/read-state activity in the space

WITH potential_memberships AS (
    SELECT DISTINCT
        mr.user_id AS user_id,
        r.space_id AS guild_id
    FROM member_roles mr
    INNER JOIN roles r ON r.id = mr.role_id

    UNION

    SELECT
        s.owner_id AS user_id,
        s.id AS guild_id
    FROM spaces s

    UNION

    SELECT DISTINCT
        m.author_id AS user_id,
        c.space_id AS guild_id
    FROM messages m
    INNER JOIN channels c ON c.id = m.channel_id
    WHERE c.space_id IS NOT NULL

    UNION

    SELECT DISTINCT
        rs.user_id AS user_id,
        c.space_id AS guild_id
    FROM read_states rs
    INNER JOIN channels c ON c.id = rs.channel_id
    WHERE c.space_id IS NOT NULL
),
valid_memberships AS (
    SELECT DISTINCT user_id, guild_id
    FROM potential_memberships
    WHERE user_id IN (SELECT id FROM users)
      AND guild_id IN (SELECT id FROM spaces)
)
DELETE FROM members
WHERE NOT EXISTS (
    SELECT 1
    FROM valid_memberships vm
    WHERE vm.user_id = members.user_id
      AND vm.guild_id = members.guild_id
);

-- Ensure every valid relationship has a member row.
WITH potential_memberships AS (
    SELECT DISTINCT
        mr.user_id AS user_id,
        r.space_id AS guild_id
    FROM member_roles mr
    INNER JOIN roles r ON r.id = mr.role_id

    UNION

    SELECT
        s.owner_id AS user_id,
        s.id AS guild_id
    FROM spaces s

    UNION

    SELECT DISTINCT
        m.author_id AS user_id,
        c.space_id AS guild_id
    FROM messages m
    INNER JOIN channels c ON c.id = m.channel_id
    WHERE c.space_id IS NOT NULL

    UNION

    SELECT DISTINCT
        rs.user_id AS user_id,
        c.space_id AS guild_id
    FROM read_states rs
    INNER JOIN channels c ON c.id = rs.channel_id
    WHERE c.space_id IS NOT NULL
),
valid_memberships AS (
    SELECT DISTINCT user_id, guild_id
    FROM potential_memberships
    WHERE user_id IN (SELECT id FROM users)
      AND guild_id IN (SELECT id FROM spaces)
)
INSERT INTO members (user_id, guild_id, joined_at)
SELECT user_id, guild_id, datetime('now')
FROM valid_memberships
ON CONFLICT DO NOTHING;

-- Ensure every member has at least the default @everyone-equivalent role.
INSERT INTO member_roles (user_id, role_id)
SELECT m.user_id, m.guild_id
FROM members m
INNER JOIN roles r
    ON r.id = m.guild_id
   AND r.space_id = m.guild_id
ON CONFLICT DO NOTHING;
