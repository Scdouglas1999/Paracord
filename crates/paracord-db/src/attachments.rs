use std::time::{SystemTime, UNIX_EPOCH};

use crate::{DbError, DbPool};

/// Custom epoch matching paracord_util::snowflake: 2024-01-01T00:00:00Z
const PARACORD_EPOCH: u64 = 1_704_067_200_000;

/// Generate a cutoff snowflake ID for the given age in hours.
fn cutoff_snowflake_id(hours_ago: u64) -> i64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time went backwards")
        .as_millis() as u64;
    let cutoff_ms = now_ms.saturating_sub(hours_ago * 3_600_000);
    let ts = cutoff_ms.saturating_sub(PARACORD_EPOCH);
    (ts << 22) as i64
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AttachmentRow {
    pub id: i64,
    pub message_id: Option<i64>,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: i32,
    pub url: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[allow(clippy::too_many_arguments)]
pub async fn create_attachment(
    pool: &DbPool,
    id: i64,
    message_id: Option<i64>,
    filename: &str,
    content_type: Option<&str>,
    size: i32,
    url: &str,
    width: Option<i32>,
    height: Option<i32>,
) -> Result<AttachmentRow, DbError> {
    let row = sqlx::query_as::<_, AttachmentRow>(
        "INSERT INTO attachments (id, message_id, filename, content_type, size, url, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         RETURNING id, message_id, filename, content_type, size, url, width, height"
    )
    .bind(id)
    .bind(message_id)
    .bind(filename)
    .bind(content_type)
    .bind(size)
    .bind(url)
    .bind(width)
    .bind(height)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn get_attachment(pool: &DbPool, id: i64) -> Result<Option<AttachmentRow>, DbError> {
    let row = sqlx::query_as::<_, AttachmentRow>(
        "SELECT id, message_id, filename, content_type, size, url, width, height
         FROM attachments WHERE id = ?1"
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn delete_attachment(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM attachments WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_message_attachments(pool: &DbPool, message_id: i64) -> Result<Vec<AttachmentRow>, DbError> {
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT id, message_id, filename, content_type, size, url, width, height
         FROM attachments WHERE message_id = ?1"
    )
    .bind(message_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Get unlinked attachments older than the given threshold.
///
/// Uses snowflake ID to determine age: generates a cutoff ID for the threshold
/// time and selects attachments with `message_id IS NULL AND id < cutoff_id`.
pub async fn get_orphaned_attachments(
    pool: &DbPool,
    older_than_hours: i64,
) -> Result<Vec<AttachmentRow>, DbError> {
    let cutoff_id = cutoff_snowflake_id(older_than_hours as u64);
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "SELECT id, message_id, filename, content_type, size, url, width, height
         FROM attachments
         WHERE message_id IS NULL AND id < ?1",
    )
    .bind(cutoff_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Delete all orphaned attachments older than threshold, return count deleted.
pub async fn delete_orphaned_attachments(
    pool: &DbPool,
    older_than_hours: i64,
) -> Result<u64, DbError> {
    let cutoff_id = cutoff_snowflake_id(older_than_hours as u64);
    let result = sqlx::query(
        "DELETE FROM attachments
         WHERE message_id IS NULL AND id < ?1",
    )
    .bind(cutoff_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

pub async fn attach_to_message(pool: &DbPool, id: i64, message_id: i64) -> Result<bool, DbError> {
    let result = sqlx::query(
        "UPDATE attachments
         SET message_id = ?2
         WHERE id = ?1 AND message_id IS NULL",
    )
    .bind(id)
    .bind(message_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
