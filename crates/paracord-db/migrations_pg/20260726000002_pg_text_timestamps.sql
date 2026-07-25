-- Store timestamps as TEXT on PostgreSQL, matching the SQLite schema.
--
-- The server talks to both engines through sqlx's `Any` driver, whose type map
-- covers only Bool / Int2 / Int4 / Int8 / Float4 / Float8 / Bytea / Text /
-- Varchar / citext. A native `TIMESTAMP` or `TIMESTAMPTZ` column decodes to
-- `AnyDriverError`, and `AnyRow::map_from` converts *every* column of a row up
-- front -- so a single temporal column makes the whole row undecodable and the
-- table unreadable. It broke the write side too: the query layer formats
-- timestamps with `datetime_to_db_text` and binds them as TEXT, which
-- PostgreSQL rejects against a `timestamptz` column, and comparisons such as
-- `expires_at > $2` fail outright with `operator does not exist`. Password
-- reset, email verification, MFA, the bot modal flow, onboarding, scheduled
-- messages and the sticker/review/anonymous-message tables were all dead on
-- PostgreSQL because of this.
--
-- Every column below becomes TEXT holding `YYYY-MM-DD HH24:MI:SS` in UTC --
-- the format `paracord_db::datetime_to_db_text` writes, `datetime_from_db_text`
-- parses, and SQLite's `datetime('now')` produces. The format is fixed-width
-- and zero-padded, so lexicographic TEXT ordering and range comparisons stay
-- identical to the temporal ordering these columns had, and the existing
-- indexes keep working.
--
-- Defaults are re-pointed at the `datetime()` compatibility shim from
-- `20260208000000_sqlite_compat`, which returns exactly that format, so the two
-- engines agree on the value a default produces.
--
-- Not covered here: `channel_follows`, `guild_templates`, `saved_messages`,
-- `stage_instances` and `voice_states` keep native temporal columns. Their
-- queries already wrap every read in `CAST(col AS TEXT)` and write through
-- `CURRENT_TIMESTAMP`, so they are correct as they stand.

-- anonymous_channel_aliases
ALTER TABLE anonymous_channel_aliases ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE anonymous_channel_aliases ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE anonymous_channel_aliases ALTER COLUMN created_at SET DEFAULT datetime('now');

-- anonymous_messages
ALTER TABLE anonymous_messages ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE anonymous_messages ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE anonymous_messages ALTER COLUMN created_at SET DEFAULT datetime('now');

-- application_commands
ALTER TABLE application_commands ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE application_commands ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE application_commands ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE application_commands ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE application_commands ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE application_commands ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- bot_metric_events
ALTER TABLE bot_metric_events ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE bot_metric_events ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE bot_metric_events ALTER COLUMN created_at SET DEFAULT datetime('now');

-- bot_reviews
ALTER TABLE bot_reviews ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE bot_reviews ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE bot_reviews ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE bot_reviews ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE bot_reviews ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE bot_reviews ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- channel_feature_settings
ALTER TABLE channel_feature_settings ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE channel_feature_settings ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE channel_feature_settings ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- email_verification_tokens
ALTER TABLE email_verification_tokens ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE email_verification_tokens ALTER COLUMN expires_at TYPE TEXT
    USING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE email_verification_tokens ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE email_verification_tokens ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE email_verification_tokens ALTER COLUMN created_at SET DEFAULT datetime('now');

-- group_e2ee_sender_keys
ALTER TABLE group_e2ee_sender_keys ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE group_e2ee_sender_keys ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE group_e2ee_sender_keys ALTER COLUMN created_at SET DEFAULT datetime('now');

-- guild_onboarding_settings
ALTER TABLE guild_onboarding_settings ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE guild_onboarding_settings ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE guild_onboarding_settings ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- interaction_tokens
ALTER TABLE interaction_tokens ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE interaction_tokens ALTER COLUMN expires_at TYPE TEXT
    USING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE interaction_tokens ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE interaction_tokens ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE interaction_tokens ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE interaction_tokens ALTER COLUMN modal_issued_at DROP DEFAULT;
ALTER TABLE interaction_tokens ALTER COLUMN modal_issued_at TYPE TEXT
    USING to_char(modal_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE interaction_tokens ALTER COLUMN modal_consumed_at DROP DEFAULT;
ALTER TABLE interaction_tokens ALTER COLUMN modal_consumed_at TYPE TEXT
    USING to_char(modal_consumed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');

-- member_onboarding_state
ALTER TABLE member_onboarding_state ALTER COLUMN completed_at DROP DEFAULT;
ALTER TABLE member_onboarding_state ALTER COLUMN completed_at TYPE TEXT
    USING to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE member_onboarding_state ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE member_onboarding_state ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE member_onboarding_state ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE member_onboarding_state ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE member_onboarding_state ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE member_onboarding_state ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- message_edits
ALTER TABLE message_edits ALTER COLUMN edited_at DROP DEFAULT;
ALTER TABLE message_edits ALTER COLUMN edited_at TYPE TEXT
    USING to_char(edited_at, 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE message_edits ALTER COLUMN edited_at SET DEFAULT datetime('now');

-- mfa_backup_codes
ALTER TABLE mfa_backup_codes ALTER COLUMN used_at DROP DEFAULT;
ALTER TABLE mfa_backup_codes ALTER COLUMN used_at TYPE TEXT
    USING to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE mfa_backup_codes ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE mfa_backup_codes ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE mfa_backup_codes ALTER COLUMN created_at SET DEFAULT datetime('now');

-- mfa_configs
ALTER TABLE mfa_configs ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE mfa_configs ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE mfa_configs ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE mfa_configs ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE mfa_configs ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE mfa_configs ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- moderation_action_templates
ALTER TABLE moderation_action_templates ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE moderation_action_templates ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE moderation_action_templates ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE moderation_action_templates ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE moderation_action_templates ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE moderation_action_templates ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- password_reset_tokens
ALTER TABLE password_reset_tokens ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE password_reset_tokens ALTER COLUMN expires_at TYPE TEXT
    USING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE password_reset_tokens ALTER COLUMN used_at DROP DEFAULT;
ALTER TABLE password_reset_tokens ALTER COLUMN used_at TYPE TEXT
    USING to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE password_reset_tokens ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE password_reset_tokens ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE password_reset_tokens ALTER COLUMN created_at SET DEFAULT datetime('now');

-- scheduled_events
ALTER TABLE scheduled_events ALTER COLUMN reminder_sent_at DROP DEFAULT;
ALTER TABLE scheduled_events ALTER COLUMN reminder_sent_at TYPE TEXT
    USING to_char(reminder_sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');

-- scheduled_messages
ALTER TABLE scheduled_messages ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE scheduled_messages ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE scheduled_messages ALTER COLUMN created_at SET DEFAULT datetime('now');
ALTER TABLE scheduled_messages ALTER COLUMN updated_at DROP DEFAULT;
ALTER TABLE scheduled_messages ALTER COLUMN updated_at TYPE TEXT
    USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE scheduled_messages ALTER COLUMN updated_at SET DEFAULT datetime('now');

-- stickers
ALTER TABLE stickers ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE stickers ALTER COLUMN created_at TYPE TEXT
    USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');
ALTER TABLE stickers ALTER COLUMN created_at SET DEFAULT datetime('now');
