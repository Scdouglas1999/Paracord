//! AutoMod rule storage and hit history.
//!
//! `automod_rules` shipped in the initial schema but was never wired to
//! anything; this module is its data layer. Rule *semantics* (what a trigger
//! matches, which actions run) live in `paracord-core::automod` — this file
//! only persists and retrieves.

use crate::{bool_from_any_row, datetime_from_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct AutomodRuleRow {
    pub id: i64,
    pub guild_id: i64,
    pub name: String,
    pub creator_id: Option<i64>,
    pub event_type: i16,
    pub trigger_type: i16,
    /// Trigger configuration as JSON; shape depends on `trigger_type`.
    pub trigger_metadata: String,
    /// Action list as a JSON array.
    pub actions: String,
    pub enabled: bool,
    pub exempt_role_ids: String,
    pub exempt_channel_ids: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

const RULE_COLUMNS: &str = "id, space_id AS guild_id, name, creator_id, event_type, trigger_type, \
     trigger_metadata, actions, CAST(enabled AS INTEGER) AS enabled, exempt_role_ids, \
     exempt_channel_ids, created_at, updated_at";

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AutomodRuleRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            name: row.try_get("name")?,
            creator_id: row.try_get("creator_id")?,
            event_type: row.try_get("event_type")?,
            trigger_type: row.try_get("trigger_type")?,
            trigger_metadata: row.try_get("trigger_metadata")?,
            actions: row.try_get("actions")?,
            enabled: bool_from_any_row(row, "enabled")?,
            exempt_role_ids: row.try_get("exempt_role_ids")?,
            exempt_channel_ids: row.try_get("exempt_channel_ids")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn create_rule(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    name: &str,
    creator_id: i64,
    event_type: i16,
    trigger_type: i16,
    trigger_metadata: &str,
    actions: &str,
    enabled: bool,
    exempt_role_ids: &str,
    exempt_channel_ids: &str,
) -> Result<AutomodRuleRow, DbError> {
    let row = sqlx::query_as::<_, AutomodRuleRow>(&format!(
        "INSERT INTO automod_rules (
            id, space_id, name, creator_id, event_type, trigger_type,
            trigger_metadata, actions, enabled, exempt_role_ids, exempt_channel_ids, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
         RETURNING {RULE_COLUMNS}"
    ))
    .bind(id)
    .bind(guild_id)
    .bind(name)
    .bind(creator_id)
    .bind(event_type)
    .bind(trigger_type)
    .bind(trigger_metadata)
    .bind(actions)
    .bind(i64::from(enabled))
    .bind(exempt_role_ids)
    .bind(exempt_channel_ids)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn list_rules(pool: &DbPool, guild_id: i64) -> Result<Vec<AutomodRuleRow>, DbError> {
    let rows = sqlx::query_as::<_, AutomodRuleRow>(&format!(
        "SELECT {RULE_COLUMNS} FROM automod_rules WHERE space_id = $1 ORDER BY created_at ASC"
    ))
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Enabled rules only — the hot path used on every message send.
pub async fn list_enabled_rules(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<AutomodRuleRow>, DbError> {
    let rows = sqlx::query_as::<_, AutomodRuleRow>(&format!(
        "SELECT {RULE_COLUMNS} FROM automod_rules
         WHERE space_id = $1 AND enabled = TRUE
         ORDER BY created_at ASC"
    ))
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_rule(pool: &DbPool, id: i64) -> Result<Option<AutomodRuleRow>, DbError> {
    let row = sqlx::query_as::<_, AutomodRuleRow>(&format!(
        "SELECT {RULE_COLUMNS} FROM automod_rules WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn update_rule(
    pool: &DbPool,
    id: i64,
    name: &str,
    trigger_metadata: &str,
    actions: &str,
    enabled: bool,
    exempt_role_ids: &str,
    exempt_channel_ids: &str,
) -> Result<Option<AutomodRuleRow>, DbError> {
    let row = sqlx::query_as::<_, AutomodRuleRow>(&format!(
        "UPDATE automod_rules
            SET name = $2, trigger_metadata = $3, actions = $4, enabled = $5,
                exempt_role_ids = $6, exempt_channel_ids = $7, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
         RETURNING {RULE_COLUMNS}"
    ))
    .bind(id)
    .bind(name)
    .bind(trigger_metadata)
    .bind(actions)
    .bind(i64::from(enabled))
    .bind(exempt_role_ids)
    .bind(exempt_channel_ids)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_rule(pool: &DbPool, id: i64) -> Result<bool, DbError> {
    let result = sqlx::query("DELETE FROM automod_rules WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn count_rules(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    let row = sqlx::query("SELECT COUNT(*) AS count FROM automod_rules WHERE space_id = $1")
        .bind(guild_id)
        .fetch_one(pool)
        .await?;
    Ok(row.try_get("count")?)
}

// ---------------------------------------------------------------------------
// Hit history
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AutomodHitRow {
    pub id: i64,
    pub guild_id: i64,
    pub rule_id: i64,
    pub rule_name: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub trigger_type: i16,
    pub actions_taken: String,
    pub matched_excerpt: Option<String>,
    pub content_excerpt: Option<String>,
    pub created_at: DateTime<Utc>,
}

const HIT_COLUMNS: &str =
    "id, space_id AS guild_id, rule_id, rule_name, user_id, channel_id, trigger_type, \
     actions_taken, matched_excerpt, content_excerpt, created_at";

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for AutomodHitRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            guild_id: row.try_get("guild_id")?,
            rule_id: row.try_get("rule_id")?,
            rule_name: row.try_get("rule_name")?,
            user_id: row.try_get("user_id")?,
            channel_id: row.try_get("channel_id")?,
            trigger_type: row.try_get("trigger_type")?,
            actions_taken: row.try_get("actions_taken")?,
            matched_excerpt: row.try_get("matched_excerpt")?,
            content_excerpt: row.try_get("content_excerpt")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn record_hit(
    pool: &DbPool,
    id: i64,
    guild_id: i64,
    rule_id: i64,
    rule_name: &str,
    user_id: i64,
    channel_id: i64,
    trigger_type: i16,
    actions_taken: &str,
    matched_excerpt: Option<&str>,
    content_excerpt: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO automod_hits (
            id, space_id, rule_id, rule_name, user_id, channel_id,
            trigger_type, actions_taken, matched_excerpt, content_excerpt
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(guild_id)
    .bind(rule_id)
    .bind(rule_name)
    .bind(user_id)
    .bind(channel_id)
    .bind(trigger_type)
    .bind(actions_taken)
    .bind(matched_excerpt)
    .bind(content_excerpt)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_hits(
    pool: &DbPool,
    guild_id: i64,
    limit: i64,
) -> Result<Vec<AutomodHitRow>, DbError> {
    let rows = sqlx::query_as::<_, AutomodHitRow>(&format!(
        "SELECT {HIT_COLUMNS} FROM automod_hits
          WHERE space_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT $2"
    ))
    .bind(guild_id)
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// How many times this user tripped any rule in the guild since `since`.
/// Used by escalating actions (e.g. timeout after N strikes).
pub async fn count_recent_hits_for_user(
    pool: &DbPool,
    guild_id: i64,
    user_id: i64,
    since: DateTime<Utc>,
) -> Result<i64, DbError> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS count FROM automod_hits
          WHERE space_id = $1 AND user_id = $2 AND created_at >= $3",
    )
    .bind(guild_id)
    .bind(user_id)
    .bind(since.format("%Y-%m-%d %H:%M:%S").to_string())
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("count")?)
}
