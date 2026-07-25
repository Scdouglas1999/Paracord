use crate::{bool_from_any_row, DbError, DbPool};
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct ChannelFeatureSettingsRow {
    pub channel_id: i64,
    pub disappearing_seconds: i32,
    pub anonymous_posting_enabled: bool,
    pub slowmode_exempt_role_ids: String,
    pub adaptive_slowmode_enabled: bool,
    pub adaptive_slowmode_window_seconds: i32,
    pub adaptive_slowmode_threshold: i32,
    pub adaptive_slowmode_step_seconds: i32,
    pub thread_rate_limit_per_user: i32,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ChannelFeatureSettingsRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            channel_id: row.try_get("channel_id")?,
            disappearing_seconds: row.try_get("disappearing_seconds")?,
            anonymous_posting_enabled: bool_from_any_row(row, "anonymous_posting_enabled")?,
            slowmode_exempt_role_ids: row.try_get("slowmode_exempt_role_ids")?,
            adaptive_slowmode_enabled: bool_from_any_row(row, "adaptive_slowmode_enabled")?,
            adaptive_slowmode_window_seconds: row.try_get("adaptive_slowmode_window_seconds")?,
            adaptive_slowmode_threshold: row.try_get("adaptive_slowmode_threshold")?,
            adaptive_slowmode_step_seconds: row.try_get("adaptive_slowmode_step_seconds")?,
            thread_rate_limit_per_user: row.try_get("thread_rate_limit_per_user")?,
        })
    }
}

pub fn default_for_channel(channel_id: i64) -> ChannelFeatureSettingsRow {
    ChannelFeatureSettingsRow {
        channel_id,
        disappearing_seconds: 0,
        anonymous_posting_enabled: false,
        slowmode_exempt_role_ids: "[]".to_string(),
        adaptive_slowmode_enabled: false,
        adaptive_slowmode_window_seconds: 30,
        adaptive_slowmode_threshold: 20,
        adaptive_slowmode_step_seconds: 5,
        thread_rate_limit_per_user: 0,
    }
}

pub async fn get_for_channel(
    pool: &DbPool,
    channel_id: i64,
) -> Result<Option<ChannelFeatureSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, ChannelFeatureSettingsRow>(
        "SELECT channel_id, disappearing_seconds, CASE WHEN anonymous_posting_enabled THEN 1 ELSE 0 END AS anonymous_posting_enabled, slowmode_exempt_role_ids,
                CASE WHEN adaptive_slowmode_enabled THEN 1 ELSE 0 END AS adaptive_slowmode_enabled, adaptive_slowmode_window_seconds, adaptive_slowmode_threshold,
                adaptive_slowmode_step_seconds, thread_rate_limit_per_user
         FROM channel_feature_settings
         WHERE channel_id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_or_default(
    pool: &DbPool,
    channel_id: i64,
) -> Result<ChannelFeatureSettingsRow, DbError> {
    Ok(get_for_channel(pool, channel_id)
        .await?
        .unwrap_or_else(|| default_for_channel(channel_id)))
}

#[derive(Debug, Clone, Default)]
pub struct ChannelFeaturePatch<'a> {
    pub disappearing_seconds: Option<i32>,
    pub anonymous_posting_enabled: Option<bool>,
    pub slowmode_exempt_role_ids: Option<&'a str>,
    pub adaptive_slowmode_enabled: Option<bool>,
    pub adaptive_slowmode_window_seconds: Option<i32>,
    pub adaptive_slowmode_threshold: Option<i32>,
    pub adaptive_slowmode_step_seconds: Option<i32>,
    pub thread_rate_limit_per_user: Option<i32>,
}

pub async fn upsert_for_channel(
    pool: &DbPool,
    channel_id: i64,
    patch: ChannelFeaturePatch<'_>,
) -> Result<ChannelFeatureSettingsRow, DbError> {
    let existing = get_or_default(pool, channel_id).await?;
    let next = ChannelFeatureSettingsRow {
        channel_id,
        disappearing_seconds: patch
            .disappearing_seconds
            .unwrap_or(existing.disappearing_seconds),
        anonymous_posting_enabled: patch
            .anonymous_posting_enabled
            .unwrap_or(existing.anonymous_posting_enabled),
        slowmode_exempt_role_ids: patch
            .slowmode_exempt_role_ids
            .unwrap_or(existing.slowmode_exempt_role_ids.as_str())
            .to_string(),
        adaptive_slowmode_enabled: patch
            .adaptive_slowmode_enabled
            .unwrap_or(existing.adaptive_slowmode_enabled),
        adaptive_slowmode_window_seconds: patch
            .adaptive_slowmode_window_seconds
            .unwrap_or(existing.adaptive_slowmode_window_seconds),
        adaptive_slowmode_threshold: patch
            .adaptive_slowmode_threshold
            .unwrap_or(existing.adaptive_slowmode_threshold),
        adaptive_slowmode_step_seconds: patch
            .adaptive_slowmode_step_seconds
            .unwrap_or(existing.adaptive_slowmode_step_seconds),
        thread_rate_limit_per_user: patch
            .thread_rate_limit_per_user
            .unwrap_or(existing.thread_rate_limit_per_user),
    };

    let row = sqlx::query_as::<_, ChannelFeatureSettingsRow>(
        "INSERT INTO channel_feature_settings (
            channel_id,
            disappearing_seconds,
            anonymous_posting_enabled,
            slowmode_exempt_role_ids,
            adaptive_slowmode_enabled,
            adaptive_slowmode_window_seconds,
            adaptive_slowmode_threshold,
            adaptive_slowmode_step_seconds,
            thread_rate_limit_per_user,
            updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, datetime('now'))
         ON CONFLICT(channel_id) DO UPDATE SET
            disappearing_seconds = EXCLUDED.disappearing_seconds,
            anonymous_posting_enabled = EXCLUDED.anonymous_posting_enabled,
            slowmode_exempt_role_ids = EXCLUDED.slowmode_exempt_role_ids,
            adaptive_slowmode_enabled = EXCLUDED.adaptive_slowmode_enabled,
            adaptive_slowmode_window_seconds = EXCLUDED.adaptive_slowmode_window_seconds,
            adaptive_slowmode_threshold = EXCLUDED.adaptive_slowmode_threshold,
            adaptive_slowmode_step_seconds = EXCLUDED.adaptive_slowmode_step_seconds,
            thread_rate_limit_per_user = EXCLUDED.thread_rate_limit_per_user,
            updated_at = datetime('now')
         RETURNING channel_id, disappearing_seconds, CASE WHEN anonymous_posting_enabled THEN 1 ELSE 0 END AS anonymous_posting_enabled, slowmode_exempt_role_ids,
                   CASE WHEN adaptive_slowmode_enabled THEN 1 ELSE 0 END AS adaptive_slowmode_enabled, adaptive_slowmode_window_seconds, adaptive_slowmode_threshold,
                   adaptive_slowmode_step_seconds, thread_rate_limit_per_user",
    )
    .bind(next.channel_id)
    .bind(next.disappearing_seconds)
    .bind(next.anonymous_posting_enabled)
    .bind(next.slowmode_exempt_role_ids)
    .bind(next.adaptive_slowmode_enabled)
    .bind(next.adaptive_slowmode_window_seconds)
    .bind(next.adaptive_slowmode_threshold)
    .bind(next.adaptive_slowmode_step_seconds)
    .bind(next.thread_rate_limit_per_user)
    .fetch_one(pool)
    .await?;

    Ok(row)
}

pub async fn list_channels_with_disappearing(
    pool: &DbPool,
    limit: i64,
) -> Result<Vec<(i64, i32)>, DbError> {
    let rows: Vec<(i64, i32)> = sqlx::query_as(
        "SELECT channel_id, disappearing_seconds
         FROM channel_feature_settings
         WHERE disappearing_seconds > 0
         ORDER BY channel_id ASC
         LIMIT $1",
    )
    .bind(limit.clamp(1, 10_000))
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
