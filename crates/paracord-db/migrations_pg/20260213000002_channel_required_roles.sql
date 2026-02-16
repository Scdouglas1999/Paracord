-- Migration: Add channel role requirements and normalize default role naming

ALTER TABLE channels
    ADD COLUMN required_role_ids TEXT NOT NULL DEFAULT '[]';

UPDATE channels
SET required_role_ids = '[]'
WHERE required_role_ids IS NULL OR trim(required_role_ids) = '';

-- Canonical default role per space is always named "Member"
UPDATE roles
SET name = 'Member'
WHERE id = space_id;
