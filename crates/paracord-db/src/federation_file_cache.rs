use crate::{datetime_to_db_text, DbError, DbPool};
use chrono::Utc;
use sqlx::Row;

#[derive(Debug, Clone)]
pub struct FedFileCacheRow {
    pub id: i64,
    pub origin_server: String,
    pub origin_attachment_id: String,
    pub content_hash: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub size: i64,
    pub storage_key: String,
    pub cached_at: String,
    pub expires_at: Option<String>,
    pub last_accessed_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for FedFileCacheRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            origin_server: row.try_get("origin_server")?,
            origin_attachment_id: row.try_get("origin_attachment_id")?,
            content_hash: row.try_get("content_hash")?,
            filename: row.try_get("filename")?,
            content_type: row.try_get("content_type")?,
            size: row.try_get("size")?,
            storage_key: row.try_get("storage_key")?,
            cached_at: row.try_get("cached_at")?,
            expires_at: row.try_get("expires_at")?,
            last_accessed_at: row.try_get("last_accessed_at")?,
        })
    }
}

pub async fn get_cached_file(
    pool: &DbPool,
    origin_server: &str,
    attachment_id: &str,
) -> Result<Option<FedFileCacheRow>, DbError> {
    let row = sqlx::query_as::<_, FedFileCacheRow>(
        "SELECT id, origin_server, origin_attachment_id, content_hash, filename,
                content_type, size, storage_key, cached_at, expires_at, last_accessed_at
         FROM federation_file_cache
         WHERE origin_server = $1 AND origin_attachment_id = $2",
    )
    .bind(origin_server)
    .bind(attachment_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn insert_cached_file(
    pool: &DbPool,
    origin_server: &str,
    origin_attachment_id: &str,
    content_hash: &str,
    filename: &str,
    content_type: Option<&str>,
    size: i64,
    storage_key: &str,
    expires_at: Option<&str>,
) -> Result<FedFileCacheRow, DbError> {
    let row = sqlx::query_as::<_, FedFileCacheRow>(
        "INSERT INTO federation_file_cache
            (origin_server, origin_attachment_id, content_hash, filename,
             content_type, size, storage_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, origin_server, origin_attachment_id, content_hash, filename,
                   content_type, size, storage_key, cached_at, expires_at, last_accessed_at",
    )
    .bind(origin_server)
    .bind(origin_attachment_id)
    .bind(content_hash)
    .bind(filename)
    .bind(content_type)
    .bind(size)
    .bind(storage_key)
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

pub async fn update_cache_access_time(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("UPDATE federation_file_cache SET last_accessed_at = $2 WHERE id = $1")
        .bind(id)
        .bind(datetime_to_db_text(Utc::now()))
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_expired_cache_entries(
    pool: &DbPool,
    now: &str,
    limit: i64,
) -> Result<Vec<FedFileCacheRow>, DbError> {
    let rows = sqlx::query_as::<_, FedFileCacheRow>(
        "SELECT id, origin_server, origin_attachment_id, content_hash, filename,
                content_type, size, storage_key, cached_at, expires_at, last_accessed_at
         FROM federation_file_cache
         WHERE expires_at IS NOT NULL AND expires_at <= $1
         ORDER BY expires_at ASC
         LIMIT $2",
    )
    .bind(now)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_cache_entry(pool: &DbPool, id: i64) -> Result<(), DbError> {
    sqlx::query("DELETE FROM federation_file_cache WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_total_cache_size(pool: &DbPool) -> Result<i64, DbError> {
    let total: Option<i64> =
        sqlx::query_scalar("SELECT COALESCE(SUM(size), 0) FROM federation_file_cache")
            .fetch_one(pool)
            .await?;
    Ok(total.unwrap_or(0))
}

pub async fn get_lru_cache_entries(
    pool: &DbPool,
    limit: i64,
) -> Result<Vec<FedFileCacheRow>, DbError> {
    let rows = sqlx::query_as::<_, FedFileCacheRow>(
        "SELECT id, origin_server, origin_attachment_id, content_hash, filename,
                content_type, size, storage_key, cached_at, expires_at, last_accessed_at
         FROM federation_file_cache
         ORDER BY last_accessed_at ASC
         LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
