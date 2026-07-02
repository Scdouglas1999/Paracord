use crate::{datetime_to_db_text, DbError, DbPool};
use chrono::Utc;
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct GuildStoragePolicyRow {
    pub guild_id: i64,
    pub max_file_size: Option<i64>,
    pub storage_quota: Option<i64>,
    pub retention_days: Option<i32>,
    pub allowed_types: Option<String>,
    pub blocked_types: Option<String>,
    pub updated_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildStoragePolicyRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            max_file_size: row.try_get("max_file_size")?,
            storage_quota: row.try_get("storage_quota")?,
            retention_days: row.try_get("retention_days")?,
            allowed_types: row.try_get("allowed_types")?,
            blocked_types: row.try_get("blocked_types")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

pub async fn get_guild_storage_policy(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Option<GuildStoragePolicyRow>, DbError> {
    let row = sqlx::query_as::<_, GuildStoragePolicyRow>(
        "SELECT guild_id, max_file_size, storage_quota, retention_days,
                allowed_types, blocked_types, updated_at
         FROM guild_storage_policies WHERE guild_id = $1",
    )
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert_guild_storage_policy(
    pool: &DbPool,
    guild_id: i64,
    max_file_size: Option<i64>,
    storage_quota: Option<i64>,
    retention_days: Option<i32>,
    allowed_types: Option<&str>,
    blocked_types: Option<&str>,
) -> Result<GuildStoragePolicyRow, DbError> {
    let row = sqlx::query_as::<_, GuildStoragePolicyRow>(
        "INSERT INTO guild_storage_policies
            (guild_id, max_file_size, storage_quota, retention_days, allowed_types, blocked_types, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(guild_id) DO UPDATE SET
            max_file_size = excluded.max_file_size,
            storage_quota = excluded.storage_quota,
            retention_days = excluded.retention_days,
            allowed_types = excluded.allowed_types,
            blocked_types = excluded.blocked_types,
            updated_at = $7
         RETURNING guild_id, max_file_size, storage_quota, retention_days,
                   allowed_types, blocked_types, updated_at",
    )
    .bind(guild_id)
    .bind(max_file_size)
    .bind(storage_quota)
    .bind(retention_days)
    .bind(allowed_types)
    .bind(blocked_types)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn delete_guild_storage_policy(pool: &DbPool, guild_id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM guild_storage_policies WHERE guild_id = $1")
        .bind(guild_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_guilds_with_retention_policies(
    pool: &DbPool,
) -> Result<Vec<(i64, i32)>, DbError> {
    let rows: Vec<(i64, i32)> = sqlx::query_as(
        "SELECT guild_id, retention_days FROM guild_storage_policies
         WHERE retention_days IS NOT NULL AND retention_days > 0",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_guild_storage_usage(pool: &DbPool, guild_id: i64) -> Result<i64, DbError> {
    let total: Option<i64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(a.size), 0)
         FROM attachments a
         JOIN channels c ON a.upload_channel_id = c.id
         WHERE c.space_id = $1",
    )
    .bind(guild_id)
    .fetch_one(pool)
    .await?;
    Ok(total.unwrap_or(0))
}

pub async fn get_guild_attachments(
    pool: &DbPool,
    guild_id: i64,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<crate::attachments::AttachmentRow>, DbError> {
    let rows = if let Some(before_id) = before {
        sqlx::query_as::<_, crate::attachments::AttachmentRow>(
            "SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.url,
                    a.width, a.height, a.uploader_id, a.upload_channel_id,
                    a.upload_created_at, a.upload_expires_at, a.content_hash
             FROM attachments a
             JOIN channels c ON a.upload_channel_id = c.id
             WHERE c.space_id = $1 AND a.id < $2
             ORDER BY a.id DESC
             LIMIT $3",
        )
        .bind(guild_id)
        .bind(before_id)
        .bind(limit)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, crate::attachments::AttachmentRow>(
            "SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.url,
                    a.width, a.height, a.uploader_id, a.upload_channel_id,
                    a.upload_created_at, a.upload_expires_at, a.content_hash
             FROM attachments a
             JOIN channels c ON a.upload_channel_id = c.id
             WHERE c.space_id = $1
             ORDER BY a.id DESC
             LIMIT $2",
        )
        .bind(guild_id)
        .bind(limit)
        .fetch_all(pool)
        .await?
    };
    Ok(rows)
}

pub async fn get_guild_attachments_older_than(
    pool: &DbPool,
    guild_id: i64,
    older_than: &str,
    limit: i64,
) -> Result<Vec<crate::attachments::AttachmentRow>, DbError> {
    let rows = sqlx::query_as::<_, crate::attachments::AttachmentRow>(
        "SELECT a.id, a.message_id, a.filename, a.content_type, a.size, a.url,
                a.width, a.height, a.uploader_id, a.upload_channel_id,
                a.upload_created_at, a.upload_expires_at, a.content_hash
         FROM attachments a
         JOIN channels c ON a.upload_channel_id = c.id
         WHERE c.space_id = $1 AND a.upload_created_at <= $2
         ORDER BY a.upload_created_at ASC
         LIMIT $3",
    )
    .bind(guild_id)
    .bind(older_than)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
